//! Shared provider identity and public routing for discovery, registration and inference.
mod gateway;
mod openai;

use crate::{
    auth::AuthService,
    state::{Profile, ProviderKind},
};
use anyhow::Result;
use codex_core_api::CodexAuth;
use codex_model_provider_info::{ModelProviderInfo, WireApi};
use std::sync::Arc;

pub use gateway::CanvasOutput as GatewayCanvasOutput;
pub use gateway::error_message as gateway_error_message;
pub use gateway::normalize_model_metadata as normalize_gateway_metadata;

pub const ORIGINATOR: &str = "FlowM";
pub const OPENAI_RESOURCE: &str = "https://api.openai.com/v1";
pub const MODEL_CATALOG_CLIENT_VERSION: &str = "0.155.0";

pub struct ProviderDefinition {
    pub id: &'static str,
    pub info: ModelProviderInfo,
}

/// FlowM owns provider routing. All routes use the same embedded agent kernel.
pub struct Providers {
    openai: openai::OpenaiProvider,
}

impl Providers {
    pub fn new(auth: Arc<AuthService>) -> Self {
        Self {
            openai: openai::OpenaiProvider::new(auth),
        }
    }

    pub async fn resolve(&self, profile: &Profile) -> Result<ProviderDefinition> {
        match profile.kind {
            ProviderKind::Openai => self.openai.resolve(profile).await,
            ProviderKind::Gateway => Ok(gateway::resolve(profile)),
        }
    }

    pub async fn request_auth(&self, profile: &Profile) -> Result<Option<CodexAuth>> {
        self.openai.request_auth(profile).await
    }

    pub async fn close_profile(&self, id: &str) {
        self.openai.close_profile(id).await;
    }
}

fn definition(id: &'static str, name: &str, base_url: String) -> ProviderDefinition {
    ProviderDefinition {
        id,
        info: ModelProviderInfo {
            name: name.into(),
            base_url: Some(base_url),
            wire_api: WireApi::Responses,
            http_headers: Some(
                request_headers()
                    .iter()
                    .map(|(name, value)| {
                        (
                            name.to_string(),
                            value
                                .to_str()
                                .expect("Fixed FlowM header")
                                .to_owned()
                                .into(),
                        )
                    })
                    .collect(),
            ),
            // The kernel resolves headers through FlowM's ExternalAuth, including gateway tokens.
            requires_openai_auth: true,
            request_max_retries: Some(0),
            stream_max_retries: Some(0),
            stream_idle_timeout_ms: Some(180_000),
            ..Default::default()
        },
    }
}

pub fn request_headers() -> http::HeaderMap {
    let mut headers = http::HeaderMap::new();
    headers.insert("originator", http::HeaderValue::from_static(ORIGINATOR));
    headers.insert(
        http::header::USER_AGENT,
        http::HeaderValue::from_str(&format!(
            "{}/{} (Codex schema {})",
            ORIGINATOR,
            env!("CARGO_PKG_VERSION"),
            MODEL_CATALOG_CLIENT_VERSION,
        ))
        .expect("FlowM's fixed application identity is a valid header"),
    );
    headers
}
