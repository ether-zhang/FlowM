//! SIWC's public Responses route accepts a narrower request than Codex's internal route.
//! This in-process bridge preserves streaming; it never returns credentials to the renderer.
use crate::{auth::AuthService, state::Profile};
use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode, header},
    response::Response,
    routing::post,
};
use codex_core_api::{AuthHeaders, CodexAuth};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

pub struct ResponsesBridge {
    pub base_url: String,
    request_auth: CodexAuth,
    task: tokio::task::JoinHandle<()>,
}
#[derive(Clone)]
struct BridgeState {
    client: reqwest::Client,
    auth: Arc<AuthService>,
    profile: Profile,
    authorization: http::HeaderValue,
    upstream: String,
}

impl ResponsesBridge {
    pub async fn start(auth: Arc<AuthService>, profile: Profile) -> Result<Self> {
        Self::bind(
            auth,
            profile,
            format!("{}/responses", crate::provider::OPENAI_RESOURCE),
        )
        .await
    }

    async fn bind(auth: Arc<AuthService>, profile: Profile, upstream: String) -> Result<Self> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let base_url = format!(
            "http://127.0.0.1:{}/{}/v1",
            listener.local_addr()?.port(),
            Uuid::new_v4()
        );
        let path = url::Url::parse(&base_url)?.path().to_owned() + "/responses";
        let mut authorization = http::HeaderValue::from_str(&format!("Bearer {}", Uuid::new_v4()))?;
        authorization.set_sensitive(true);
        let mut kernel_headers = HeaderMap::new();
        kernel_headers.insert(header::AUTHORIZATION, authorization.clone());
        let request_auth = CodexAuth::Headers(AuthHeaders::new(kernel_headers));
        let state = BridgeState {
            auth,
            profile,
            authorization,
            upstream,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(std::time::Duration::from_secs(30))
                .build()?,
        };
        let app = Router::new()
            .route(&path, post(forward))
            .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
            .with_state(state);
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self {
            base_url,
            request_auth,
            task,
        })
    }

    pub fn request_auth(&self) -> CodexAuth {
        self.request_auth.clone()
    }
}
impl Drop for ResponsesBridge {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn forward(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> Result<Response, (StatusCode, &'static str)> {
    if headers.get(header::AUTHORIZATION) != Some(&state.authorization) {
        return Err((
            StatusCode::UNAUTHORIZED,
            "Invalid FlowM bridge authentication",
        ));
    }
    normalize_siwc_request(&mut body).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            "Request uses an unsupported ChatGPT plan capability",
        )
    })?;
    // Resolve the current OAuth credential at the native forwarding boundary, after checking
    // the bridge's profile/version. Only this real credential is sent to OpenAI.
    let auth = state
        .auth
        .headers(&state.profile, false)
        .await
        .map_err(|_| {
            (
                StatusCode::UNAUTHORIZED,
                "FlowM account credentials are no longer available",
            )
        })?;
    let CodexAuth::Headers(auth) = auth else {
        return Err((
            StatusCode::UNAUTHORIZED,
            "Invalid FlowM account authentication",
        ));
    };
    let authorization = auth.headers().get(header::AUTHORIZATION).cloned().ok_or((
        StatusCode::UNAUTHORIZED,
        "Missing FlowM-managed authentication",
    ))?;
    let upstream = state
        .client
        .post(&state.upstream)
        .headers(crate::provider::request_headers())
        .header(header::AUTHORIZATION, authorization)
        .json(&body)
        .send()
        .await
        .map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                "OpenAI Responses endpoint could not be reached",
            )
        })?;
    let mut response = Response::builder().status(upstream.status());
    if let Some(content_type) = upstream.headers().get(header::CONTENT_TYPE) {
        response = response.header(header::CONTENT_TYPE, content_type);
    }
    response
        .body(Body::from_stream(upstream.bytes_stream()))
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Responses stream could not start"))
}

fn normalize_siwc_request(body: &mut Value) -> Result<()> {
    let object = body
        .as_object_mut()
        .context("Responses body must be an object")?;
    for field in [
        "metadata",
        "previous_response_id",
        "max_output_tokens",
        "max_tool_calls",
        "temperature",
        "top_p",
        "user",
        "background",
    ] {
        object.remove(field);
    }
    object.insert("store".into(), json!(false));
    object.insert("stream".into(), json!(true));
    let tools = object.remove("tools").unwrap_or_else(|| json!([]));
    let mut direct = Vec::new();
    let mut grouped = Vec::new();
    for tool in tools.as_array().context("Invalid Responses tool list")? {
        match tool["type"].as_str() {
            Some("function" | "custom") => grouped.push(tool.clone()),
            Some("namespace") => direct.push(tool.clone()),
            _ => bail!("Hosted tools are unavailable through ChatGPT plan usage"),
        }
    }
    if !grouped.is_empty() {
        direct.push(json!({"type":"namespace","name":"functions","description":"FlowM project tools","tools":grouped}));
    }
    object.insert("tools".into(), json!(direct));
    if let Some(input) = object.get_mut("input").and_then(Value::as_array_mut) {
        for item in input {
            if matches!(
                item["type"].as_str(),
                Some("function_call" | "custom_tool_call")
            ) && item.get("namespace").is_none()
            {
                item["namespace"] = json!("functions");
            }
        }
    }
    if let Some(choice) = object.get_mut("tool_choice").and_then(Value::as_object_mut) {
        if matches!(
            choice.get("type").and_then(Value::as_str),
            Some("function" | "custom")
        ) {
            choice.entry("namespace").or_insert(json!("functions"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        auth::AuthBridge,
        state::{AuthKind, ProviderKind, Store},
    };
    use codex_core_api::{AuthManager, ExternalAuth};
    use keyring::credential::{Credential, CredentialApi, CredentialBuilderApi};

    // Unit tests keep credentials in process memory; host-keyring integration remains in
    // scripts/test-harness.mjs. Separate Entry handles must see the same encryption key.
    #[derive(Default)]
    struct TestKeyring(
        std::sync::Mutex<std::collections::HashMap<String, Arc<keyring::mock::MockCredential>>>,
    );
    struct TestEntry(Arc<keyring::mock::MockCredential>);
    impl CredentialApi for TestEntry {
        fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
            self.0.set_secret(secret)
        }
        fn get_secret(&self) -> keyring::Result<Vec<u8>> {
            self.0.get_secret()
        }
        fn delete_credential(&self) -> keyring::Result<()> {
            self.0.delete_credential()
        }
        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }
    impl CredentialBuilderApi for TestKeyring {
        fn build(
            &self,
            _target: Option<&str>,
            service: &str,
            user: &str,
        ) -> keyring::Result<Box<Credential>> {
            let entry = self
                .0
                .lock()
                .unwrap()
                .entry(format!("{service}:{user}"))
                .or_default()
                .clone();
            Ok(Box::new(TestEntry(entry)))
        }
        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }

    async fn auth_fixture() -> Result<(tempfile::TempDir, Arc<Store>, Arc<AuthService>, Profile)> {
        static KEYRING: std::sync::Once = std::sync::Once::new();
        KEYRING.call_once(|| {
            keyring::set_default_credential_builder(Box::new(TestKeyring::default()))
        });
        let directory = tempfile::tempdir()?;
        let store = Arc::new(Store::open(directory.path().to_path_buf()).await?);
        let profile = Profile {
            id: Uuid::new_v4().to_string(),
            name: "Offline ChatGPT fixture".into(),
            kind: ProviderKind::Openai,
            base_url: "https://api.openai.com/v1".into(),
            model: "gpt-5.5".into(),
            auth_kind: AuthKind::Chatgpt,
            credential_version: 1,
            account: None,
            subject: None,
            client_id: None,
        };
        store
            .data
            .lock()
            .await
            .profiles
            .insert(profile.id.clone(), profile.clone());
        let (events, _) = tokio::sync::mpsc::channel(16);
        let auth = AuthService::new(store.clone(), events)?;
        // Synthetic credentials have no expiry, so this fixture never calls an OAuth server.
        auth.set_bearer(&profile.id, "offline-token-before".into())
            .await?;
        Ok((directory, store, auth, profile))
    }

    #[tokio::test]
    async fn oauth_rotation_does_not_change_the_kernel_auth_owner() -> Result<()> {
        let (_directory, store, auth, profile) = auth_fixture().await?;
        let original = auth.headers(&profile, false).await?;
        let unbridged = AuthManager::from_auth_for_testing_with_home(original, store.home.clone());
        unbridged
            .set_external_auth(Arc::new(AuthBridge::new(
                auth.clone(),
                profile.clone(),
                None,
            )))
            .await?;
        let old_changes = unbridged.auth_change_state_receiver();
        let old_owner = old_changes.borrow().owner_generation;
        auth.set_bearer(&profile.id, "offline-token-refreshed".into())
            .await?;
        assert!(unbridged.auth().await.is_some());
        assert_ne!(
            old_changes.borrow().owner_generation,
            old_owner,
            "rotating raw headers reproduces the account-switch guard"
        );

        let bridge = ResponsesBridge::start(auth.clone(), profile.clone()).await?;
        let request_auth = bridge.request_auth();
        let external = Arc::new(AuthBridge::new(
            auth.clone(),
            profile.clone(),
            Some(request_auth.clone()),
        ));
        let manager =
            AuthManager::from_auth_for_testing_with_home(request_auth.clone(), store.home.clone());
        manager.set_external_auth(external.clone()).await?;
        let changes = manager.auth_change_state_receiver();
        let before = *changes.borrow();
        auth.set_bearer(&profile.id, "offline-token-rotated-again".into())
            .await?;
        for _ in 0..3 {
            assert_eq!(manager.auth().await, Some(request_auth.clone()));
            assert_eq!(
                *changes.borrow(),
                before,
                "request preparation must retain the same auth owner after OAuth rotation"
            );
        }
        store
            .data
            .lock()
            .await
            .profiles
            .get_mut(&profile.id)
            .unwrap()
            .credential_version += 1;
        assert!(
            external.resolve().await.is_err(),
            "a real profile/account change must still reject the old session"
        );
        auth.logout(&profile.id).await?;
        Ok(())
    }

    #[tokio::test]
    async fn bridge_forwards_current_oauth_but_rejects_invalid_or_logged_out_sessions() -> Result<()>
    {
        let (_directory, _store, auth, profile) = auth_fixture().await?;
        let seen = Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let upstream = format!(
            "http://127.0.0.1:{}/v1/responses",
            listener.local_addr()?.port()
        );
        let app = Router::new()
            .route(
                "/v1/responses",
                post(
                    |State(seen): State<Arc<tokio::sync::Mutex<Vec<String>>>>,
                     headers: HeaderMap,
                     Json(body): Json<Value>| async move {
                        seen.lock()
                            .await
                            .push(headers[header::AUTHORIZATION].to_str().unwrap().to_owned());
                        assert_eq!(body["store"], false);
                        assert_eq!(headers["originator"], crate::provider::ORIGINATOR);
                        assert_eq!(body["stream"], true);
                        (
                            [(header::CONTENT_TYPE, "text/event-stream")],
                            "data: fixture-result\n\n",
                        )
                    },
                ),
            )
            .with_state(seen.clone());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let bridge = ResponsesBridge::bind(auth.clone(), profile.clone(), upstream).await?;
        let CodexAuth::Headers(local) = bridge.request_auth() else {
            unreachable!()
        };
        let endpoint = format!("{}/responses", bridge.base_url);
        let client = reqwest::Client::new();
        assert_eq!(
            client
                .post(&endpoint)
                .json(&json!({"tools":[]}))
                .send()
                .await?
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert!(seen.lock().await.is_empty());
        for token in ["offline-token-before", "offline-token-after"] {
            auth.set_bearer(&profile.id, token.into()).await?;
            let response = client
                .post(&endpoint)
                .headers(local.headers().clone())
                .json(&json!({"tools":[]}))
                .send()
                .await?;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()[header::CONTENT_TYPE],
                "text/event-stream"
            );
            assert!(response.text().await?.contains("fixture-result"));
            assert_eq!(
                seen.lock().await.last().map(String::as_str),
                Some(format!("Bearer {token}").as_str())
            );
        }
        assert_eq!(seen.lock().await.len(), 2);
        auth.logout(&profile.id).await?;
        assert_eq!(
            client
                .post(&endpoint)
                .headers(local.headers().clone())
                .json(&json!({"tools":[]}))
                .send()
                .await?
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            seen.lock().await.len(),
            2,
            "logout must stop requests before the upstream"
        );
        task.abort();
        Ok(())
    }

    #[test]
    fn siwc_uses_namespaces_explicit_history_and_streaming() {
        let mut body = json!({"metadata":{"internal":"value"},"previous_response_id":"old","store":true,"stream":false,"tools":[{"type":"function","name":"exec_command","parameters":{}}],"input":[{"type":"function_call","name":"exec_command","arguments":"{}","call_id":"c"}],"text":{"format":{"type":"json_schema","schema":{"type":"object"}}}});
        normalize_siwc_request(&mut body).unwrap();
        assert!(body.get("metadata").is_none());
        assert!(body.get("previous_response_id").is_none());
        assert_eq!(body["tools"][0]["type"], "namespace");
        assert_eq!(body["input"][0]["namespace"], "functions");
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
        assert!(body["text"]["format"]["schema"].is_object());
        assert!(normalize_siwc_request(&mut json!({"tools":[{"type":"tool_search"}]})).is_err());
    }
}
