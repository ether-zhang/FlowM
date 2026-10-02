use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
use uuid::Uuid;

pub const PROTOCOL_VERSION: &str = "flowm.harness/4";
pub const UPSTREAM_REVISION: &str = "67727e7cf114cf3e1b71db368d74b24e32f6cb12";

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    Openai,
    Gateway,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    None,
    Bearer,
    Chatgpt,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub model: String,
    pub auth_kind: AuthKind,
    #[serde(default)]
    pub credential_version: u64,
    pub account: Option<String>,
    pub subject: Option<String>,
    pub client_id: Option<String>,
}

impl Profile {
    pub fn validate(&mut self) -> Result<()> {
        Uuid::parse_str(&self.id).context("Invalid provider profile ID")?;
        let url = url::Url::parse(self.base_url.trim())?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            bail!("The provider URL must not contain credentials, query parameters, or a fragment");
        }
        let local = matches!(
            url.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
        );
        if url.scheme() != "https" && !(local && url.scheme() == "http") {
            bail!("Use HTTPS, or HTTP for a loopback gateway");
        }
        if self.kind == ProviderKind::Openai
            && self.base_url.trim_end_matches('/') != crate::provider::OPENAI_RESOURCE
        {
            bail!("OpenAI profiles must use https://api.openai.com/v1");
        }
        if self.kind == ProviderKind::Gateway && self.auth_kind == AuthKind::Chatgpt {
            bail!("ChatGPT credentials cannot be attached to a gateway");
        }
        if self.kind == ProviderKind::Openai && self.auth_kind == AuthKind::None {
            bail!("OpenAI requires an API key or ChatGPT sign-in");
        }
        self.base_url = self.base_url.trim().trim_end_matches('/').to_owned();
        self.model = self.model.trim().to_owned();
        self.name = self.name.trim().to_owned();
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    Canvas,
    Project,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub id: String,
    pub project_root: PathBuf,
    pub flow_session_id: String,
    pub profile_id: String,
    pub credential_version: u64,
    pub role: Role,
    pub model: String,
    pub system: String,
    pub rollout_path: Option<PathBuf>,
    #[serde(default)]
    pub imported_from: Option<String>,
    #[serde(default)]
    pub blocked_request_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub host_id: String,
    pub profiles: BTreeMap<String, Profile>,
    pub bindings: BTreeMap<String, Binding>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub request_id: String,
    pub thread_id: String,
    pub payload_hash: String,
    pub status: String,
    pub native_turn_id: Option<String>,
    pub text: Option<String>,
    pub error: Option<String>,
    pub updated_at: u64,
}

pub struct Store {
    pub home: PathBuf,
    pub data: Mutex<State>,
    _lock: std::fs::File,
}

impl Store {
    pub async fn open(home: PathBuf) -> Result<Self> {
        if !home.is_absolute() {
            bail!("Harness home must be an absolute FlowM-owned directory");
        }
        tokio::fs::create_dir_all(home.join("receipts")).await?;
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(home.join("harness.lock"))?;
        lock.try_lock()
            .context("This FlowM harness home is already in use")?;
        let file = home.join("state.json");
        let data = if file.exists() {
            serde_json::from_slice(&tokio::fs::read(file).await?)
                .context("Invalid harness state; existing data was preserved")?
        } else {
            State {
                host_id: format!("urn:uuid:{}", Uuid::new_v4()),
                profiles: BTreeMap::new(),
                bindings: BTreeMap::new(),
            }
        };
        let store = Self {
            home,
            data: Mutex::new(data),
            _lock: lock,
        };
        store.save().await?;
        Ok(store)
    }

    pub async fn save(&self) -> Result<()> {
        let data = self.data.lock().await;
        atomic_json(&self.home.join("state.json"), &*data).await
    }

    pub async fn profile(&self, id: &str) -> Result<Profile> {
        self.data
            .lock()
            .await
            .profiles
            .get(id)
            .cloned()
            .context("Provider profile no longer exists")
    }

    fn receipt_path(&self, id: &str) -> Result<PathBuf> {
        let id = Uuid::parse_str(id).context("Request ID must be a UUID")?;
        Ok(self.home.join("receipts").join(format!("{id}.json")))
    }

    pub async fn receipt(&self, id: &str) -> Result<Option<Receipt>> {
        let path = self.receipt_path(id)?;
        match tokio::fs::read(path).await {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub async fn write_receipt(&self, receipt: &Receipt) -> Result<()> {
        atomic_json(&self.receipt_path(&receipt.request_id)?, receipt).await
    }

    pub async fn recover_receipts(&self) -> Result<()> {
        let mut files = tokio::fs::read_dir(self.home.join("receipts")).await?;
        while let Some(file) = files.next_entry().await? {
            if file.path().extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let mut receipt: Receipt =
                serde_json::from_slice(&tokio::fs::read(file.path()).await?)?;
            if matches!(receipt.status.as_str(), "accepted" | "running") {
                receipt.status = "uncertain".into();
                receipt.error = Some("The runtime stopped during this request. Inspect its effects before starting another request; it was not replayed.".into());
                self.write_receipt(&receipt).await?;
                if let Some(binding) = self.data.lock().await.bindings.get_mut(&receipt.thread_id) {
                    binding.blocked_request_id = Some(receipt.request_id);
                }
            }
        }
        self.save().await?;
        Ok(())
    }
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub async fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || -> Result<()> {
        use std::io::Write;
        let parent = path.parent().context("State file has no parent")?;
        std::fs::create_dir_all(parent)?;
        let temporary = parent.join(format!(".{}.tmp", Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        if let Err(error) = std::fs::rename(&temporary, &path) {
            let _ = std::fs::remove_file(temporary);
            return Err(error.into());
        }
        Ok(())
    })
    .await??;
    Ok(())
}

pub fn payload_hash(value: &Value) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).unwrap_or_default())
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn interrupted_receipt_is_uncertain_and_cannot_disappear() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().to_owned()).await.unwrap();
        let id = Uuid::new_v4().to_string();
        store
            .write_receipt(&Receipt {
                request_id: id.clone(),
                thread_id: "t".into(),
                payload_hash: "hash".into(),
                status: "running".into(),
                native_turn_id: None,
                text: None,
                error: None,
                updated_at: now(),
            })
            .await
            .unwrap();
        store.recover_receipts().await.unwrap();
        assert_eq!(
            store.receipt(&id).await.unwrap().unwrap().status,
            "uncertain"
        );
        assert!(store.receipt("../state").await.is_err());
    }
    #[test]
    fn oauth_cannot_leak_to_a_gateway_or_redirect_target() {
        let mut p = Profile {
            id: Uuid::new_v4().to_string(),
            name: "test".into(),
            kind: ProviderKind::Gateway,
            base_url: "https://gateway.test/v1".into(),
            model: "claude".into(),
            auth_kind: AuthKind::Chatgpt,
            credential_version: 0,
            account: None,
            subject: None,
            client_id: None,
        };
        assert!(p.validate().is_err());
        p.auth_kind = AuthKind::Bearer;
        p.base_url = "https://user:password@gateway.test/v1".into();
        assert!(p.validate().is_err());
        p.base_url = "http://127.0.0.1:3000/v1".into();
        assert!(p.validate().is_ok());
    }

    #[test]
    fn connections_save_without_a_hardcoded_model() {
        let mut p = Profile {
            id: Uuid::new_v4().to_string(),
            name: "OpenAI".into(),
            kind: ProviderKind::Openai,
            base_url: "https://api.openai.com/v1".into(),
            model: String::new(),
            auth_kind: AuthKind::Chatgpt,
            credential_version: 0,
            account: None,
            subject: None,
            client_id: None,
        };
        assert!(p.validate().is_ok());
        p.kind = ProviderKind::Gateway;
        p.auth_kind = AuthKind::Bearer;
        assert!(p.validate().is_ok());
    }
}
