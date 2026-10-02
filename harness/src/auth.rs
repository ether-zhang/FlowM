//! FlowM owns OAuth and credentials. No token-bearing payload is returned over IPC.
use crate::state::{AuthKind, Profile, Store, now, payload_hash};
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use codex_core_api::{
    AuthHeaders, CodexAuth, ExternalAuth, ExternalAuthFuture, ExternalAuthRefreshContext,
};
use http::{HeaderMap, HeaderValue, header::AUTHORIZATION};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{Mutex, mpsc, oneshot},
};
use uuid::Uuid;
use zeroize::Zeroizing;

const ISSUER: &str = "https://auth.openai.com";
const AUTHORIZE: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

#[derive(Clone, Serialize, Deserialize)]
struct Credential {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    client_id: Option<String>,
    subject: Option<String>,
    scopes: Vec<String>,
    expires_at: Option<u64>,
    earliest_refresh_at: Option<u64>,
}

#[derive(Serialize, Deserialize)]
struct SealedCredential {
    version: u32,
    nonce: String,
    ciphertext: String,
}

#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    token_type: String,
    expires_in: u64,
    scope: Option<String>,
    earliest_refresh_at: Option<u64>,
}

#[derive(Clone, Deserialize)]
struct Identity {
    sub: String,
    nonce: Option<String>,
    email: Option<String>,
}

struct Attempt {
    state: String,
    nonce: String,
    verifier: String,
    redirect: String,
    client_id: String,
    subject: Option<String>,
}

pub struct AuthService {
    store: Arc<Store>,
    client: reqwest::Client,
    /// Serialize refresh/rotation and logout across all threads, including account switching.
    credentials: Mutex<()>,
    attempts: Mutex<HashMap<String, oneshot::Sender<()>>>,
    events: mpsc::Sender<Value>,
}

impl AuthService {
    pub fn new(store: Arc<Store>, events: mpsc::Sender<Value>) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            store,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(45))
                .build()?,
            credentials: Mutex::new(()),
            attempts: Mutex::new(HashMap::new()),
            events,
        }))
    }

    fn entry(&self, id: &str) -> Result<keyring::Entry> {
        Uuid::parse_str(id)?;
        // A different FlowM home has a different namespace, including test installations.
        let namespace = payload_hash(&json!(self.store.home));
        keyring::Entry::new(&format!("com.flowm.harness.{}", &namespace[..24]), id)
            .context("OS credential storage is unavailable")
    }

    fn credential_path(&self, id: &str) -> Result<std::path::PathBuf> {
        let id = Uuid::parse_str(id)?;
        Ok(self
            .store
            .home
            .join("credentials")
            .join(format!("{id}.sealed")))
    }

    fn key(&self, id: &str, create: bool) -> Result<Zeroizing<Vec<u8>>> {
        let entry = self.entry(id)?;
        match entry.get_password() {
            Ok(secret) => {
                let bytes = URL_SAFE_NO_PAD
                    .decode(Zeroizing::new(secret).as_bytes())
                    .context("Invalid credential encryption key")?;
                if bytes.len() != 32 {
                    bail!("Invalid credential encryption key");
                }
                Ok(Zeroizing::new(bytes))
            }
            Err(keyring::Error::NoEntry) if create => {
                let mut bytes = Zeroizing::new(vec![0u8; 32]);
                rand::rngs::OsRng.fill_bytes(&mut bytes);
                entry.set_password(&Zeroizing::new(URL_SAFE_NO_PAD.encode(&*bytes))).map_err(|_| anyhow::anyhow!("OS credential storage could not be written; no plaintext fallback was used"))?;
                Ok(bytes)
            }
            Err(_) => bail!("OS credential storage could not be read; unlock it and retry"),
        }
    }

    fn load(&self, id: &str) -> Result<Option<Credential>> {
        let path = self.credential_path(id)?;
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => bail!("FlowM's encrypted credential record could not be read"),
        };
        let sealed: SealedCredential =
            serde_json::from_slice(&bytes).context("Invalid encrypted credential record")?;
        let key = self.key(id, false)?;
        let secret = unseal(&sealed, &key, id)?;
        Ok(Some(
            serde_json::from_slice(&secret).context("Invalid decrypted credential record")?,
        ))
    }

    async fn save(&self, id: &str, credential: &Credential) -> Result<()> {
        let key = self.key(id, true)?;
        let secret = Zeroizing::new(serde_json::to_vec(credential)?);
        let sealed = seal(&secret, &key, id)?;
        crate::state::atomic_json(&self.credential_path(id)?, &sealed).await
    }

    pub async fn has_credential(&self, id: &str) -> bool {
        let _guard = self.credentials.lock().await;
        self.load(id).ok().flatten().is_some()
    }

    pub async fn set_bearer(&self, id: &str, token: String) -> Result<()> {
        let token = Zeroizing::new(token);
        if token.trim().is_empty() {
            bail!("The bearer token is empty");
        }
        HeaderValue::from_str(&format!("Bearer {}", token.trim()))
            .context("The token contains invalid characters")?;
        let _guard = self.credentials.lock().await;
        self.save(
            id,
            &Credential {
                access_token: token.trim().to_owned(),
                refresh_token: None,
                id_token: None,
                client_id: None,
                subject: None,
                scopes: vec![],
                expires_at: None,
                earliest_refresh_at: None,
            },
        )
        .await
    }

    pub async fn logout(&self, id: &str) -> Result<()> {
        let _guard = self.credentials.lock().await;
        match tokio::fs::remove_file(self.credential_path(id)?).await {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => bail!("FlowM's encrypted credential record could not be removed"),
        }
        match self.entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => (),
            Err(_) => bail!("OS credential storage could not be cleared"),
        }
        let mut data = self.store.data.lock().await;
        if let Some(profile) = data.profiles.get_mut(id) {
            profile.credential_version += 1;
            profile.account = None;
            profile.subject = None;
            profile.client_id = None;
        }
        drop(data);
        self.store.save().await
    }

    pub async fn headers(&self, profile: &Profile, force_refresh: bool) -> Result<CodexAuth> {
        let _guard = self.credentials.lock().await;
        let current = self.store.profile(&profile.id).await?;
        if current.credential_version != profile.credential_version {
            bail!("Credentials changed; reopen this model session");
        }
        if force_refresh && current.auth_kind != AuthKind::Chatgpt {
            bail!(
                "This provider cannot renew rejected credentials; update its token in FlowM settings"
            );
        }
        let mut headers = HeaderMap::new();
        if current.auth_kind != AuthKind::None {
            let mut credential = self
                .load(&profile.id)?
                .context("Sign in or set a provider token first")?;
            let expired = credential
                .expires_at
                .is_some_and(|expires| expires <= now() + 30);
            if current.auth_kind == AuthKind::Chatgpt && (expired || force_refresh) {
                if credential
                    .earliest_refresh_at
                    .is_some_and(|earliest| earliest > now())
                {
                    bail!("This account cannot refresh yet; retry after the current token expires");
                }
                credential = self.refresh(&current, credential).await?;
                self.save(&current.id, &credential).await?;
            } else if force_refresh {
                bail!("Provider rejected the token; update it in FlowM settings");
            }
            let mut value = HeaderValue::from_str(&format!("Bearer {}", credential.access_token))
                .context("Invalid provider credential")?;
            value.set_sensitive(true);
            headers.insert(AUTHORIZATION, value);
        }
        Ok(CodexAuth::Headers(AuthHeaders::new(headers)))
    }

    async fn exchange(&self, params: &[(&str, &str)]) -> Result<Tokens> {
        let response = self
            .client
            .post(TOKEN)
            .form(params)
            .send()
            .await
            .context("OpenAI token endpoint could not be reached")?;
        if !response.status().is_success() {
            bail!(
                "OpenAI authentication returned HTTP {}; restart sign-in if renewal was rejected",
                response.status().as_u16()
            );
        }
        let tokens: Tokens = response
            .json()
            .await
            .context("Invalid OpenAI token response")?;
        if !tokens.token_type.eq_ignore_ascii_case("bearer") || tokens.access_token.is_empty() {
            bail!("Invalid OpenAI bearer credential");
        }
        Ok(tokens)
    }

    async fn identity(
        &self,
        token: &str,
        client_id: &str,
        nonce: Option<&str>,
    ) -> Result<Identity> {
        let discovery: Value = self
            .client
            .get(format!("{ISSUER}/.well-known/openid-configuration"))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        if discovery["issuer"].as_str() != Some(ISSUER) {
            bail!("Unexpected OpenAI issuer");
        }
        let jwks_uri = discovery["jwks_uri"]
            .as_str()
            .context("OpenAI discovery is missing JWKS")?;
        let jwks_url = url::Url::parse(jwks_uri)?;
        if jwks_url.scheme() != "https" || jwks_url.host_str() != Some("auth.openai.com") {
            bail!("Unexpected OpenAI signing-key endpoint");
        }
        let keys: JwkSet = self
            .client
            .get(jwks_url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let header = decode_header(token).context("Invalid OpenAI ID token")?;
        if header.alg != Algorithm::RS256 {
            bail!("Unsupported OpenAI signing algorithm");
        }
        let key = keys
            .find(
                header
                    .kid
                    .as_deref()
                    .context("ID token has no signing key ID")?,
            )
            .context("Unknown OpenAI signing key")?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[ISSUER]);
        validation.set_audience(&[client_id]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub", "iat"]);
        validation.leeway = 5;
        let identity = decode::<Identity>(token, &DecodingKey::from_jwk(key)?, &validation)
            .context("OpenAI ID token verification failed")?
            .claims;
        if identity.sub.is_empty()
            || nonce.is_some_and(|expected| identity.nonce.as_deref() != Some(expected))
        {
            bail!("OpenAI identity or nonce did not match");
        }
        Ok(identity)
    }

    async fn refresh(&self, profile: &Profile, old: Credential) -> Result<Credential> {
        let client_id = old
            .client_id
            .as_deref()
            .context("Missing OAuth registration; sign in again")?;
        let tokens = self
            .exchange(&[
                ("grant_type", "refresh_token"),
                ("client_id", client_id),
                (
                    "refresh_token",
                    old.refresh_token
                        .as_deref()
                        .context("Missing refresh token; sign in again")?,
                ),
                ("resource", RESOURCE),
            ])
            .await?;
        if let Some(token) = tokens.id_token.as_deref() {
            let identity = self.identity(token, client_id, None).await?;
            if Some(&identity.sub) != profile.subject.as_ref() {
                bail!("Token renewal changed the selected account");
            }
        }
        let scopes = tokens
            .scope
            .as_deref()
            .map(scope_list)
            .unwrap_or(old.scopes);
        require_plan_scopes(&scopes)?;
        Ok(Credential {
            access_token: tokens.access_token,
            refresh_token: Some(
                tokens
                    .refresh_token
                    .context("OpenAI did not return a rotating refresh token")?,
            ),
            id_token: tokens.id_token.or(old.id_token),
            client_id: Some(client_id.to_owned()),
            subject: old.subject,
            scopes,
            expires_at: Some(now() + tokens.expires_in),
            earliest_refresh_at: tokens.earliest_refresh_at,
        })
    }

    pub async fn start_login(self: &Arc<Self>, id: String) -> Result<Value> {
        let profile = self.store.profile(&id).await?;
        if profile.auth_kind != AuthKind::Chatgpt || profile.base_url != RESOURCE {
            bail!("Browser login is available only for a ChatGPT profile");
        }
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let attempt = Attempt {
            state: random_value(),
            nonce: random_value(),
            verifier: random_value(),
            redirect: format!("http://127.0.0.1:{port}/auth/callback"),
            client_id: profile
                .client_id
                .clone()
                .unwrap_or_else(|| "dynamic_agent_client".into()),
            subject: profile.subject.clone(),
        };
        let host_id = self.store.data.lock().await.host_id.clone();
        let mut url = url::Url::parse(AUTHORIZE)?;
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("client_id", &attempt.client_id)
                .append_pair("ext_agent_host_id", &host_id)
                .append_pair("response_type", "code")
                .append_pair("redirect_uri", &attempt.redirect)
                .append_pair("scope", SCOPES)
                .append_pair("resource", RESOURCE)
                .append_pair("state", &attempt.state)
                .append_pair("nonce", &attempt.nonce)
                .append_pair("code_challenge_method", "S256")
                .append_pair("code_challenge", &pkce_challenge(&attempt.verifier));
            if attempt.client_id == "dynamic_agent_client" {
                query.append_pair("agent_name_hint", "FlowM");
            } else if let Some(email) = &profile.account {
                query.append_pair("login_hint", email);
            }
            // No id_token_hint is placed in an IPC response or browser launch diagnostic.
        }
        let attempt_id = Uuid::new_v4().to_string();
        let (cancel_tx, cancel_rx) = oneshot::channel();
        self.attempts
            .lock()
            .await
            .insert(attempt_id.clone(), cancel_tx);
        if webbrowser::open(url.as_str()).is_err() {
            self.attempts.lock().await.remove(&attempt_id);
            bail!("The system browser could not be opened");
        }
        let service = self.clone();
        let event_attempt = attempt_id.clone();
        tokio::spawn(async move {
            let result = tokio::select! {
                result = tokio::time::timeout(Duration::from_secs(600), service.finish_login(&id, profile.credential_version, listener, attempt)) => result.unwrap_or_else(|_| Err(anyhow::anyhow!("Browser login timed out"))),
                _ = cancel_rx => Err(anyhow::anyhow!("Browser login cancelled")),
            };
            service.attempts.lock().await.remove(&event_attempt);
            let _ = service.events.send(json!({"method":"auth/changed", "params":{"attemptId":event_attempt,"profileId":id,"success":result.is_ok(),"error":result.err().map(|e| e.to_string())}})).await;
        });
        Ok(json!({"attemptId":attempt_id}))
    }

    async fn finish_login(
        &self,
        id: &str,
        credential_version: u64,
        listener: TcpListener,
        attempt: Attempt,
    ) -> Result<()> {
        let callback = loop {
            let (mut stream, _) = listener.accept().await?;
            let mut bytes = Vec::new();
            tokio::time::timeout(Duration::from_secs(5), async {
                let mut chunk = [0u8; 1024];
                while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                    let count = stream.read(&mut chunk).await?;
                    if count == 0 || bytes.len() + count > 8192 {
                        return Err(std::io::Error::other(
                            "Incomplete or oversized login callback",
                        ));
                    }
                    bytes.extend_from_slice(&chunk[..count]);
                }
                Ok::<_, std::io::Error>(())
            })
            .await??;
            let request = String::from_utf8_lossy(&bytes);
            let target = request
                .lines()
                .next()
                .and_then(|line| line.strip_prefix("GET "))
                .and_then(|line| line.split(' ').next());
            let url = target
                .and_then(|target| url::Url::parse(&format!("http://127.0.0.1{target}")).ok());
            let valid = url
                .as_ref()
                .is_some_and(|url| url.path() == "/auth/callback");
            if !valid {
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
                continue;
            }
            let params: BTreeMap<String, String> =
                url.unwrap().query_pairs().into_owned().collect();
            let checked = validate_callback(&attempt, &params);
            let body = if checked.is_ok() {
                "FlowM received the sign-in response. You can return to FlowM to see the result."
            } else {
                "FlowM could not verify this sign-in response. Start sign-in again in FlowM."
            };
            let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
            break checked?;
        };
        let (code, issued_id) = callback;
        let tokens = self
            .exchange(&[
                ("grant_type", "authorization_code"),
                ("client_id", &issued_id),
                ("code", &code),
                ("code_verifier", &attempt.verifier),
                ("redirect_uri", &attempt.redirect),
                ("resource", RESOURCE),
            ])
            .await?;
        let identity = self
            .identity(
                tokens
                    .id_token
                    .as_deref()
                    .context("OpenAI did not return an ID token")?,
                &issued_id,
                Some(&attempt.nonce),
            )
            .await?;
        if attempt
            .subject
            .as_ref()
            .is_some_and(|subject| subject != &identity.sub)
        {
            bail!("The selected ChatGPT account changed during sign-in");
        }
        let scopes = scope_list(
            tokens
                .scope
                .as_deref()
                .context("OpenAI did not report granted scopes")?,
        );
        require_plan_scopes(&scopes)?;
        let credential = Credential {
            access_token: tokens.access_token,
            refresh_token: Some(
                tokens
                    .refresh_token
                    .context("OpenAI did not grant offline access")?,
            ),
            id_token: tokens.id_token,
            client_id: Some(issued_id.clone()),
            subject: Some(identity.sub.clone()),
            scopes,
            expires_at: Some(now() + tokens.expires_in),
            earliest_refresh_at: tokens.earliest_refresh_at,
        };
        let _guard = self.credentials.lock().await;
        let current = self.store.profile(id).await?;
        if current.credential_version != credential_version {
            bail!("Profile changed during sign-in; the response was discarded");
        }
        self.save(id, &credential).await?;
        let mut data = self.store.data.lock().await;
        let profile = data.profiles.get_mut(id).context("Profile was removed")?;
        profile.account = identity.email;
        profile.subject = Some(identity.sub);
        profile.client_id = Some(issued_id);
        // The successful registration binds credentials to the existing, previously unsigned profile.
        drop(data);
        self.store.save().await
    }

    pub async fn cancel_login(&self, id: &str) {
        if let Some(cancel) = self.attempts.lock().await.remove(id) {
            let _ = cancel.send(());
        }
    }

    pub async fn models(&self, id: &str) -> Result<Value> {
        let profile = self.store.profile(id).await?;
        if profile.kind == crate::state::ProviderKind::Gateway {
            // Gateway aliases are explicit. An OpenAI bundled catalog is never presented as its entitlement list.
            return Ok(json!([{ "id": profile.model, "label": profile.model, "isDefault": true }]));
        }
        let auth = self.headers(&profile, false).await?;
        let CodexAuth::Headers(auth) = auth else {
            bail!("Unexpected authentication type");
        };
        let response = self
            .client
            .get(format!("{}/models", profile.base_url))
            .headers(auth.headers().clone())
            .send()
            .await?;
        if !response.status().is_success() {
            bail!(
                "Model discovery returned HTTP {}",
                response.status().as_u16()
            );
        }
        let body: Value = response.json().await?;
        let mut models = Vec::new();
        if profile.auth_kind == AuthKind::Chatgpt {
            for model in body["models"]
                .as_array()
                .context("Invalid ChatGPT model catalog")?
            {
                if model["visibility"].as_str() != Some("list") {
                    continue;
                }
                if let Some(slug) = model["slug"].as_str() {
                    models.push(json!({"id":slug,"label":model["display_name"].as_str().unwrap_or(slug),"isDefault":slug == profile.model}));
                }
            }
        } else {
            for model in body["data"]
                .as_array()
                .context("Invalid OpenAI model catalog")?
            {
                if let Some(id) = model["id"].as_str() {
                    models.push(json!({"id":id,"label":id,"isDefault":id == profile.model}));
                }
            }
        }
        Ok(json!(models))
    }
}

pub struct AuthBridge {
    auth: Arc<AuthService>,
    profile: Profile,
    observed: std::sync::Mutex<Option<String>>,
}
impl AuthBridge {
    pub fn new(auth: Arc<AuthService>, profile: Profile) -> Self {
        Self {
            auth,
            profile,
            observed: std::sync::Mutex::new(None),
        }
    }
    async fn resolve_auth(&self, refresh: bool) -> std::io::Result<CodexAuth> {
        let mut auth = self
            .auth
            .headers(&self.profile, false)
            .await
            .map_err(std::io::Error::other)?;
        let current = auth_fingerprint(&auth);
        let previous = self
            .observed
            .lock()
            .map_err(|_| std::io::Error::other("Authentication state lock failed"))?
            .clone();
        // Another model/role group may already have rotated the same account's token. Reuse that
        // validated credential instead of refreshing a second time from an old 401 response.
        if refresh && previous.as_ref() == Some(&current) {
            auth = self
                .auth
                .headers(&self.profile, true)
                .await
                .map_err(std::io::Error::other)?;
        }
        *self
            .observed
            .lock()
            .map_err(|_| std::io::Error::other("Authentication state lock failed"))? =
            Some(auth_fingerprint(&auth));
        Ok(auth)
    }
}
fn auth_fingerprint(auth: &CodexAuth) -> String {
    use sha2::{Digest, Sha256};
    let bytes = match auth {
        CodexAuth::Headers(headers) => headers
            .headers()
            .get(AUTHORIZATION)
            .map(HeaderValue::as_bytes)
            .unwrap_or_default(),
        _ => &[],
    };
    format!("{:x}", Sha256::digest(bytes))
}
impl ExternalAuth for AuthBridge {
    fn resolve(&self) -> ExternalAuthFuture<'_, CodexAuth> {
        Box::pin(self.resolve_auth(false))
    }
    fn refresh(&self, _context: ExternalAuthRefreshContext) -> ExternalAuthFuture<'_, CodexAuth> {
        Box::pin(self.resolve_auth(true))
    }
}

fn random_value() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn seal(secret: &[u8], key: &[u8], id: &str) -> Result<SealedCredential> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| anyhow::anyhow!("Invalid credential encryption key"))?;
    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: secret,
                aad: id.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("Credential encryption failed"))?;
    Ok(SealedCredential {
        version: 1,
        nonce: URL_SAFE_NO_PAD.encode(nonce),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
    })
}
fn unseal(sealed: &SealedCredential, key: &[u8], id: &str) -> Result<Zeroizing<Vec<u8>>> {
    if sealed.version != 1 {
        bail!("Unsupported encrypted credential record");
    }
    let nonce = URL_SAFE_NO_PAD.decode(&sealed.nonce)?;
    if nonce.len() != 12 {
        bail!("Invalid encrypted credential nonce");
    }
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| anyhow::anyhow!("Invalid credential encryption key"))?;
    let ciphertext = URL_SAFE_NO_PAD.decode(&sealed.ciphertext)?;
    let secret = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: id.as_bytes(),
            },
        )
        .map_err(|_| {
            anyhow::anyhow!("Encrypted credentials could not be verified; sign in again")
        })?;
    Ok(Zeroizing::new(secret))
}
fn pkce_challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
fn scope_list(scope: &str) -> Vec<String> {
    scope.split_whitespace().map(str::to_owned).collect()
}
fn require_plan_scopes(scopes: &[String]) -> Result<()> {
    if !["chatgpt.tokens.use.direct", "resource.invoke"]
        .iter()
        .all(|scope| scopes.iter().any(|value| value == scope))
    {
        bail!("ChatGPT plan usage was not granted; authorize plan usage and sign in again");
    }
    Ok(())
}
fn validate_callback(
    attempt: &Attempt,
    params: &BTreeMap<String, String>,
) -> Result<(String, String)> {
    if params.get("state") != Some(&attempt.state) {
        bail!("Browser login state did not match");
    }
    if params.contains_key("error") {
        bail!("Browser authorization was declined");
    }
    let client_id = if attempt.client_id == "dynamic_agent_client" {
        params
            .get("client_id")
            .filter(|id| !id.is_empty() && *id != "dynamic_agent_client")
            .context("Registration did not return an issued client ID")?
            .clone()
    } else {
        if params
            .get("client_id")
            .is_some_and(|id| id != &attempt.client_id)
        {
            bail!("OAuth registration changed during sign-in");
        }
        attempt.client_id.clone()
    };
    Ok((
        params
            .get("code")
            .filter(|code| !code.is_empty())
            .context("Sign-in callback has no authorization code")?
            .clone(),
        client_id,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pkce_uses_rfc7636_s256_vector() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }
    #[test]
    fn credentials_larger_than_windows_keyring_limits_remain_encrypted_and_profile_bound() {
        let secret = vec![b'x'; 20_000];
        let key = [42u8; 32];
        let mut sealed = seal(&secret, &key, "profile-a").unwrap();
        assert_eq!(&*unseal(&sealed, &key, "profile-a").unwrap(), &secret);
        assert!(unseal(&sealed, &key, "profile-b").is_err());
        assert!(
            !serde_json::to_string(&sealed)
                .unwrap()
                .contains(&"x".repeat(100))
        );
        let mut altered = URL_SAFE_NO_PAD.decode(&sealed.ciphertext).unwrap();
        altered[0] ^= 1;
        sealed.ciphertext = URL_SAFE_NO_PAD.encode(altered);
        assert!(unseal(&sealed, &key, "profile-a").is_err());
    }
    #[test]
    fn callback_requires_state_and_issued_registration() {
        let attempt = Attempt {
            state: "s".into(),
            nonce: "n".into(),
            verifier: "v".into(),
            redirect: "r".into(),
            client_id: "dynamic_agent_client".into(),
            subject: None,
        };
        let mut params = BTreeMap::from([
            ("code".into(), "c".into()),
            ("state".into(), "wrong".into()),
            ("client_id".into(), "oaiapp_test".into()),
        ]);
        assert!(validate_callback(&attempt, &params).is_err());
        params.insert("state".into(), "s".into());
        assert_eq!(
            validate_callback(&attempt, &params).unwrap().1,
            "oaiapp_test"
        );
        params.remove("client_id");
        assert!(validate_callback(&attempt, &params).is_err());
        assert!(require_plan_scopes(&scope_list("openid email")).is_err());
    }
}
