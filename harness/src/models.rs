//! One connection-owned catalog supplies both UI choices and kernel model metadata.
use crate::{
    auth::AuthService,
    state::{AuthKind, Profile, ProviderKind, Store},
};
use anyhow::{Context, Result, bail};
use codex_api::{ModelsClient, Provider, ReqwestTransport};
use codex_http_client::{ClientRouteClass, HttpClientFactory, OutboundProxyPolicy};
use codex_login::default_client::{ClientRedirectPolicy, create_client_for_route_async};
use codex_protocol::openai_models::{ApplyPatchToolType, ConfigShellToolType, ModelInfo, ToolMode};
use http::HeaderMap;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::{sync::Arc, time::Duration};

// Compatibility level of the pinned model schema, not FlowM's product version. The public
// endpoint gates catalog entries on this parameter, just like upstream ModelsClient.
use crate::provider::MODEL_CATALOG_CLIENT_VERSION;

pub struct ModelDirectory {
    store: Arc<Store>,
    auth: Arc<AuthService>,
}

impl ModelDirectory {
    pub fn new(store: Arc<Store>, auth: Arc<AuthService>) -> Arc<Self> {
        Arc::new(Self { store, auth })
    }

    pub async fn catalog(&self, profile: &Profile) -> Result<ModelCatalog> {
        let codex_core_api::CodexAuth::Headers(auth) = self.auth.headers(profile, false).await?
        else {
            bail!("Unexpected authentication type");
        };
        let body = fetch_catalog_response(profile, auth.headers().clone()).await?;
        let catalog = ModelCatalog::from_response(profile, body)?;
        if self.store.profile(&profile.id).await?.credential_version != profile.credential_version {
            bail!("Credentials changed while loading the model catalog");
        }
        Ok(catalog)
    }

    pub async fn list(&self, id: &str) -> Result<ModelCatalog> {
        self.catalog(&self.store.profile(id).await?).await
    }
}

// AuthService resolves/refreshes FlowM-owned credentials before discovery. The snapshot is
// used only inside this native request and never serialized or written to a catalog cache.
struct DiscoveryAuth(HeaderMap);
impl codex_api::AuthProvider for DiscoveryAuth {
    fn add_auth_headers(&self, headers: &mut HeaderMap) {
        headers.extend(self.0.clone());
    }
}

pub async fn fetch_catalog_response(profile: &Profile, auth: HeaderMap) -> Result<Value> {
    let provider = codex_model_provider_info::ModelProviderInfo {
        name: "FlowM".into(),
        base_url: Some(profile.base_url.clone()),
        request_max_retries: Some(0),
        ..Default::default()
    }
    .to_api_provider(None)?;
    // SIWC uses the public API with FlowM credentials. Reuse Codex's request builder and
    // ModelsClient, not its backend routing, bundled seed, or persistent cache fallback.
    let request_url = if profile.kind == ProviderKind::Openai {
        ModelsClient::<ReqwestTransport>::request_url(&provider, MODEL_CATALOG_CLIENT_VERSION)
    } else {
        Provider::url_for_path(&provider, "models")
    };
    let mut headers = crate::provider::request_headers();
    headers.insert(
        http::header::CACHE_CONTROL,
        http::HeaderValue::from_static("no-cache, no-store"),
    );
    headers.insert(
        http::header::PRAGMA,
        http::HeaderValue::from_static("no-cache"),
    );
    let (bytes, _) = tokio::time::timeout(Duration::from_secs(45), async {
        let client = create_client_for_route_async(
            HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault),
            request_url.clone(),
            ClientRouteClass::Api,
            ClientRedirectPolicy::Reject,
        )
        .await?
        .without_request_logging();
        ModelsClient::new(
            ReqwestTransport::from_http_client(client),
            provider,
            Arc::new(DiscoveryAuth(auth)),
        )
        .list_models_raw(request_url, headers, Some(1024 * 1024))
        .await
        .map_err(|error| match error {
            codex_api::ApiError::Transport(codex_api::TransportError::Http { status, .. }) => {
                anyhow::anyhow!("Model discovery returned HTTP {}", status.as_u16())
            }
            // Provider errors may echo credentials; never project raw bodies/headers into IPC.
            _ => anyhow::anyhow!("Model discovery failed; check the connection and retry"),
        })
    })
    .await
    .context("Model discovery timed out")??;
    serde_json::from_slice(&bytes).context("Invalid connection model catalog")
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    pub profile_id: String,
    pub credential_version: u64,
    pub source: &'static str,
    pub models: Vec<ModelChoice>,
    pub default_model: Option<String>,
    #[serde(skip)]
    metadata: HashMap<String, Value>,
}

impl ModelCatalog {
    pub fn from_response(profile: &Profile, body: Value) -> Result<Self> {
        let chatgpt = profile.auth_kind == AuthKind::Chatgpt;
        let entries = body[if chatgpt { "models" } else { "data" }]
            .as_array()
            .context("Invalid connection model catalog")?;
        let mut seen = HashSet::new();
        let mut models = Vec::new();
        let mut metadata = HashMap::new();
        for entry in entries {
            if chatgpt && entry["visibility"].as_str() != Some("list") {
                continue;
            }
            let Some(id) = entry[if chatgpt { "slug" } else { "id" }]
                .as_str()
                .filter(|id| !id.trim().is_empty() && id.trim() == *id)
            else {
                continue;
            };
            if !seen.insert(id.to_owned()) {
                continue;
            }
            models.push(ModelChoice {
                id: id.into(),
                label: entry["display_name"]
                    .as_str()
                    .filter(|label| !label.trim().is_empty())
                    .unwrap_or(id)
                    .into(),
            });
            metadata.insert(id.into(), entry.clone());
        }
        if models.is_empty() {
            bail!("This connection returned no available models");
        }
        let default_model = models
            .iter()
            .find(|model| model.id == profile.model)
            .or_else(|| {
                models
                    .iter()
                    .find(|model| Some(model.id.as_str()) == body["default_model"].as_str())
            })
            .or_else(|| models.first())
            .map(|model| model.id.clone());
        Ok(Self {
            profile_id: profile.id.clone(),
            credential_version: profile.credential_version,
            source: if profile.kind == ProviderKind::Gateway {
                "gateway"
            } else if chatgpt {
                "openai-account"
            } else {
                "openai-api"
            },
            models,
            default_model,
            metadata,
        })
    }

    pub fn model_info(&self, profile: &Profile, id: &str) -> Result<ModelInfo> {
        if self.profile_id != profile.id || self.credential_version != profile.credential_version {
            bail!("Model catalog belongs to different credentials");
        }
        if !self.models.iter().any(|model| model.id == id) {
            bail!("This model is absent from the connection's current catalog");
        }
        let mut baseline = codex_models_manager::model_info::model_info_from_slug(id);
        // Missing metadata never borrows another model's reasoning or context-window claims.
        baseline.context_window = None;
        baseline.max_context_window = None;
        baseline.auto_compact_token_limit = None;
        baseline.supports_reasoning_summary_parameter = false;
        baseline.model_messages = None;
        let mut value = serde_json::to_value(baseline)?;
        if let Some(raw) = self.metadata.get(id).and_then(Value::as_object) {
            value.as_object_mut().unwrap().extend(raw.clone());
        }
        value["slug"] = Value::String(id.into());
        value["display_name"] = Value::String(
            self.models
                .iter()
                .find(|model| model.id == id)
                .map(|model| model.label.clone())
                .unwrap_or_else(|| id.into()),
        );
        let mut model: ModelInfo =
            serde_json::from_value(value).context("Invalid model runtime metadata")?;
        // Model-owned tool_mode takes precedence over feature flags in upstream core. FlowM
        // ships direct tools, not the optional code-mode host or upstream plugin environment.
        model.tool_mode = Some(ToolMode::Direct);
        model.shell_type = ConfigShellToolType::UnifiedExec;
        model.apply_patch_tool_type = Some(ApplyPatchToolType::Freeform);
        model.experimental_supported_tools.clear();
        model.model_messages = None;
        model.include_skills_usage_instructions = false;
        model.include_plugin_usage_instructions = false;
        model.include_apps_usage_instructions = false;
        model.supports_search_tool = false;
        model.supports_experimental_context = false;
        model.use_responses_lite = false;
        model.node_repl_disabled = true;
        model.multi_agent_version = None;
        model.multi_agent_reasoning_effort = None;
        Ok(model)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ProviderKind;
    fn profile(kind: ProviderKind) -> Profile {
        Profile {
            id: "profile".into(),
            name: "test".into(),
            kind,
            base_url: "https://api.openai.com/v1".into(),
            model: "old-cli-default".into(),
            auth_kind: AuthKind::Chatgpt,
            credential_version: 3,
            account: None,
            subject: None,
            client_id: None,
        }
    }

    #[tokio::test]
    async fn model_discovery_always_fetches_live_data_with_the_schema_version() -> Result<()> {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let directory = tempfile::tempdir()?;
        let store = Arc::new(Store::open(directory.path().to_path_buf()).await?);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let count = Arc::new(AtomicUsize::new(0));
        let hits = count.clone();
        let app = axum::Router::new().route(
            "/v1/models",
            axum::routing::get(
                move |headers: http::HeaderMap,
                      axum::extract::Query(query): axum::extract::Query<
                    std::collections::HashMap<String, String>,
                >| {
                    let hits = hits.clone();
                    async move {
                        assert_eq!(
                            query.get("client_version").map(String::as_str),
                            Some(crate::provider::MODEL_CATALOG_CLIENT_VERSION)
                        );
                        assert_eq!(headers[http::header::CACHE_CONTROL], "no-cache, no-store");
                        assert_eq!(headers["originator"], crate::provider::ORIGINATOR);
                        let index = hits.fetch_add(1, Ordering::SeqCst);
                        axum::Json(
                            serde_json::json!({"data":[{"id":format!("live-model-{index}")}] }),
                        )
                    }
                },
            ),
        );
        let profile = Profile {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Live directory fixture".into(),
            kind: crate::state::ProviderKind::Openai,
            base_url: format!("http://127.0.0.1:{}/v1", listener.local_addr()?.port()),
            model: String::new(),
            auth_kind: AuthKind::None,
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
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (events, _) = tokio::sync::mpsc::channel(16);
        let auth = AuthService::new(store.clone(), events)?;
        let directory = ModelDirectory::new(store, auth);
        assert_eq!(
            directory.catalog(&profile).await?.models[0].id,
            "live-model-0"
        );
        assert_eq!(
            directory.catalog(&profile).await?.models[0].id,
            "live-model-1"
        );
        assert_eq!(count.load(Ordering::SeqCst), 2);
        server.abort();
        Ok(())
    }

    #[test]
    fn account_catalog_preserves_server_order_names_and_excludes_hidden_models() -> Result<()> {
        let profile = profile(ProviderKind::Openai);
        let catalog = ModelCatalog::from_response(
            &profile,
            serde_json::json!({"models":[
                {"slug":"live-b","display_name":"Live B","visibility":"list","tool_mode":"code_mode_only"},
                {"slug":"hidden","visibility":"hide"}, {"slug":"live-a","display_name":"Live A","visibility":"list"}
            ]}),
        )?;
        assert_eq!(
            catalog
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["live-b", "live-a"]
        );
        assert_eq!(catalog.default_model.as_deref(), Some("live-b"));
        assert_eq!(catalog.source, "openai-account");
        let runtime = catalog.model_info(&profile, "live-b")?;
        assert_eq!(runtime.tool_mode, Some(ToolMode::Direct));
        assert!(runtime.experimental_supported_tools.is_empty());
        assert!(runtime.context_window.is_none());
        assert!(catalog.model_info(&profile, "an-explicit-model").is_err());
        assert!(catalog.model_info(&profile, "hidden").is_err());
        Ok(())
    }
    #[test]
    fn gateway_uses_only_discovered_routes_and_never_inherits_an_openai_catalog() -> Result<()> {
        let mut profile = profile(ProviderKind::Gateway);
        profile.auth_kind = AuthKind::Bearer;
        profile.model = "obsolete-configured-route".into();
        let catalog = ModelCatalog::from_response(
            &profile,
            serde_json::json!({"data":[{"id":"claude-route"}]}),
        )?;
        assert_eq!(catalog.models.len(), 1);
        assert_eq!(catalog.source, "gateway");
        assert_eq!(catalog.default_model.as_deref(), Some("claude-route"));
        assert!(
            catalog
                .model_info(&profile, "obsolete-configured-route")
                .is_err()
        );
        assert!(
            catalog
                .model_info(&profile, "another-explicit-route")
                .is_err()
        );
        let runtime = catalog.model_info(&profile, "claude-route")?;
        assert_eq!(runtime.slug, "claude-route");
        assert_eq!(runtime.tool_mode, Some(ToolMode::Direct));
        assert!(runtime.context_window.is_none());
        Ok(())
    }

    #[test]
    fn missing_model_does_not_gain_access_from_an_old_preference() -> Result<()> {
        let mut profile = profile(ProviderKind::Openai);
        profile.model = "gpt-6.1-sol".into();
        let catalog = ModelCatalog::from_response(
            &profile,
            serde_json::json!({"default_model":"gpt-6.1-sol","models":[
                {"slug":"returned-model","visibility":"list"}
            ]}),
        )?;
        assert_eq!(catalog.default_model.as_deref(), Some("returned-model"));
        assert!(catalog.model_info(&profile, "gpt-6.1-sol").is_err());
        assert!(ModelCatalog::from_response(&profile, serde_json::json!({"models":[]})).is_err());
        Ok(())
    }
}
