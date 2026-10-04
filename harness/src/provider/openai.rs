use super::{ProviderDefinition, definition};
use crate::{
    auth::AuthService,
    responses_bridge::ResponsesBridge,
    state::{AuthKind, Profile},
};
use anyhow::{Context, Result};
use codex_core_api::CodexAuth;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::Mutex;

pub(super) struct OpenaiProvider {
    auth: Arc<AuthService>,
    bridges: Mutex<HashMap<String, ResponsesBridge>>,
}

impl OpenaiProvider {
    pub fn new(auth: Arc<AuthService>) -> Self {
        Self {
            auth,
            bridges: Mutex::new(HashMap::new()),
        }
    }

    pub async fn resolve(&self, profile: &Profile) -> Result<ProviderDefinition> {
        let base_url = if profile.auth_kind == AuthKind::Chatgpt {
            let key = key(profile);
            let mut bridges = self.bridges.lock().await;
            if !bridges.contains_key(&key) {
                bridges.insert(
                    key.clone(),
                    ResponsesBridge::start(self.auth.clone(), profile.clone()).await?,
                );
            }
            bridges[&key].base_url.clone()
        } else {
            profile.base_url.clone()
        };
        Ok(definition("flowm-openai", "FlowM OpenAI", base_url))
    }

    pub async fn request_auth(&self, profile: &Profile) -> Result<Option<CodexAuth>> {
        if profile.auth_kind != AuthKind::Chatgpt {
            return Ok(None);
        }
        Ok(Some(
            self.bridges
                .lock()
                .await
                .get(&key(profile))
                .context("ChatGPT request bridge is missing")?
                .request_auth(),
        ))
    }

    pub async fn close_profile(&self, id: &str) {
        self.bridges
            .lock()
            .await
            .retain(|key, _| !key.starts_with(&format!("{id}:")));
    }
}

fn key(profile: &Profile) -> String {
    format!("{}:{}", profile.id, profile.credential_version)
}
