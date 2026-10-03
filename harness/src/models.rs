//! One connection-owned catalog supplies both UI choices and kernel model metadata.
use crate::{
    auth::AuthService,
    state::{AuthKind, Profile, ProviderKind, Store},
};
use anyhow::{Context, Result, bail};
use codex_api::{ModelsClient, Provider, ReqwestTransport};
use codex_http_client::{ClientRouteClass, HttpClientFactory, OutboundProxyPolicy};
use codex_login::default_client::{ClientRedirectPolicy, create_client_for_route_async};
use codex_models_manager::manager::{ModelsManager, StaticModelsManager};
use codex_protocol::openai_models::{
    ApplyPatchToolType, ConfigShellToolType, ModelInfo, ModelsResponse, ToolMode,
};
use http::HeaderMap;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
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
    pub origin: ModelOrigin,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelOrigin {
    Remote,
    Kernel,
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
    manager: Arc<StaticModelsManager>,
}

impl ModelCatalog {
    pub fn from_response(profile: &Profile, body: Value) -> Result<Self> {
        let chatgpt = profile.auth_kind == AuthKind::Chatgpt;
        let entries = body[if chatgpt { "models" } else { "data" }]
            .as_array()
            .context("Invalid connection model catalog")?;
        // The SIWC metadata endpoint may omit callable models. The pinned kernel's official
        // catalog supplies supported candidates, not an assertion of account entitlement.
        // Third-party gateways and API-key directories retain only their own discovered IDs.
        let mut runtime_models = if profile.kind == ProviderKind::Openai && chatgpt {
            codex_models_manager::bundled_models_response()?.models
        } else {
            Vec::new()
        };
        let mut remote_ids = HashSet::new();
        for entry in entries {
            if chatgpt && !matches!(entry["visibility"].as_str(), Some("list" | "hide" | "none")) {
                continue;
            }
            let Some(id) = entry[if chatgpt { "slug" } else { "id" }]
                .as_str()
                .filter(|id| !id.trim().is_empty() && id.trim() == *id)
            else {
                continue;
            };
            if !remote_ids.insert(id.to_owned()) {
                continue;
            }
            let existing = runtime_models.iter().position(|model| model.slug == id);
            let model = decode_model_info(
                id,
                entry,
                existing.map(|index| runtime_models[index].clone()),
            )?;
            if let Some(index) = existing {
                runtime_models[index] = model;
            } else {
                runtime_models.push(model);
            }
        }
        for model in &mut runtime_models {
            constrain_runtime_model(model);
        }
        // Codex owns picker order, visibility, defaults and capability definitions. The same
        // in-process manager provides metadata for native execution; no disk cache is involved.
        let manager = Arc::new(StaticModelsManager::new(
            None,
            ModelsResponse {
                models: runtime_models,
            },
        ));
        let presets = manager.try_list_models()?;
        let models = presets
            .iter()
            .filter(|model| model.show_in_picker)
            .map(|model| ModelChoice {
                id: model.model.clone(),
                label: model.display_name.clone(),
                origin: if remote_ids.contains(&model.model) {
                    ModelOrigin::Remote
                } else {
                    ModelOrigin::Kernel
                },
            })
            .collect::<Vec<_>>();
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
            .or_else(|| {
                models.iter().find(|model| {
                    presets
                        .iter()
                        .any(|preset| preset.model == model.id && preset.is_default)
                })
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
            manager,
        })
    }

    pub fn model_info(&self, profile: &Profile, id: &str) -> Result<ModelInfo> {
        if self.profile_id != profile.id || self.credential_version != profile.credential_version {
            bail!("Model catalog belongs to different credentials");
        }
        if !self.models.iter().any(|model| model.id == id) {
            bail!("This model is absent from the harness candidate catalog");
        }
        self.manager
            .try_get_remote_models()?
            .into_iter()
            .find(|model| model.slug == id)
            .context("Harness model metadata is missing")
    }

    pub fn runtime_catalog(&self) -> Result<ModelsResponse> {
        Ok(ModelsResponse {
            models: self.manager.try_get_remote_models()?,
        })
    }
}

fn decode_model_info(id: &str, raw: &Value, official: Option<ModelInfo>) -> Result<ModelInfo> {
    let mut baseline = official.unwrap_or_else(|| {
        let mut baseline = codex_models_manager::model_info::model_info_from_slug(id);
        // Undescribed gateway routes never borrow another model's capability claims.
        baseline.context_window = None;
        baseline.max_context_window = None;
        baseline.auto_compact_token_limit = None;
        baseline.supports_reasoning_summary_parameter = false;
        baseline.model_messages = None;
        baseline
    });
    // A standard /v1/models entry advertises an ID without Codex-native visibility metadata.
    // Mark that returned route as a picker candidate; explicit visibility still takes precedence.
    if raw.get("visibility").is_none() {
        baseline.visibility = codex_protocol::openai_models::ModelVisibility::List;
    }
    if let Some(label) = raw["display_name"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
    {
        baseline.display_name = label.into();
    }
    let mut value = serde_json::to_value(&baseline)?;
    if let Some(raw) = raw.as_object() {
        value.as_object_mut().unwrap().extend(raw.clone());
    }
    value["slug"] = Value::String(id.into());
    value["display_name"] = Value::String(baseline.display_name);
    serde_json::from_value(value).context("Invalid model runtime metadata")
}

fn constrain_runtime_model(model: &mut ModelInfo) {
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
    fn account_catalog_uses_kernel_candidates_and_remote_metadata() -> Result<()> {
        let profile = profile(ProviderKind::Openai);
        let catalog = ModelCatalog::from_response(
            &profile,
            serde_json::json!({"default_model":"live-b","models":[
                {"slug":"live-b","display_name":"Live B","visibility":"list","tool_mode":"code_mode_only"},
                {"slug":"hidden","visibility":"hide"}, {"slug":"live-a","display_name":"Live A","visibility":"list"}
            ]}),
        )?;
        assert_eq!(
            catalog
                .models
                .iter()
                .filter(|model| model.origin == ModelOrigin::Remote)
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
    fn missing_official_model_remains_a_kernel_candidate() -> Result<()> {
        let mut profile = profile(ProviderKind::Openai);
        profile.model = "gpt-6.1-sol".into();
        let catalog = ModelCatalog::from_response(
            &profile,
            serde_json::json!({"default_model":"gpt-6.1-sol","models":[
                {"slug":"returned-model","visibility":"list"}
            ]}),
        )?;
        assert_eq!(catalog.default_model.as_deref(), Some("gpt-6.1-sol"));
        let candidate = catalog
            .models
            .iter()
            .find(|model| model.id == "gpt-6.1-sol")
            .unwrap();
        assert_eq!(candidate.origin, ModelOrigin::Kernel);
        let info = catalog.model_info(&profile, "gpt-6.1-sol")?;
        assert_eq!(info.slug, "gpt-6.1-sol");
        assert_eq!(info.tool_mode, Some(ToolMode::Direct));
        assert!(info.context_window.is_some());
        assert!(catalog.model_info(&profile, "invented-model").is_err());
        Ok(())
    }

    #[test]
    fn live_metadata_overrides_the_same_official_model_and_hidden_models_stay_hidden() -> Result<()>
    {
        let profile = profile(ProviderKind::Openai);
        let catalog = ModelCatalog::from_response(
            &profile,
            serde_json::json!({"models":[
                {"slug":"gpt-6.1-sol","display_name":"Live Sol","visibility":"list","context_window":64000},
                {"slug":"gpt-6-astra","visibility":"hide"}, {"slug":"gpt-6-sol","visibility":"none"}
            ]}),
        )?;
        let candidate = catalog
            .models
            .iter()
            .find(|model| model.id == "gpt-6.1-sol")
            .unwrap();
        assert_eq!(candidate.origin, ModelOrigin::Remote);
        assert_eq!(candidate.label, "Live Sol");
        assert_eq!(
            catalog.model_info(&profile, "gpt-6.1-sol")?.context_window,
            Some(64000)
        );
        assert!(catalog.model_info(&profile, "gpt-6-astra").is_err());
        assert!(catalog.model_info(&profile, "gpt-6-sol").is_err());
        assert_eq!(
            catalog
                .models
                .iter()
                .filter(|model| model.id == "gpt-6.1-sol")
                .count(),
            1
        );
        Ok(())
    }

    #[test]
    fn empty_remote_siwc_directory_keeps_official_candidates_without_gateway_fallback() -> Result<()>
    {
        let profile = profile(ProviderKind::Openai);
        let catalog = ModelCatalog::from_response(&profile, serde_json::json!({"models":[]}))?;
        assert!(catalog.models.iter().any(|model| model.id == "gpt-6.1-sol"));
        assert!(
            catalog
                .models
                .iter()
                .all(|model| model.origin == ModelOrigin::Kernel)
        );
        let mut gateway = profile;
        gateway.kind = ProviderKind::Gateway;
        gateway.auth_kind = AuthKind::Bearer;
        assert!(ModelCatalog::from_response(&gateway, serde_json::json!({"data":[]})).is_err());
        Ok(())
    }
}
