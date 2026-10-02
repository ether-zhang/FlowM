//! The fixed Codex API is confined to this module; FlowM's canvas semantics stay in the caller.
use crate::{
    auth::{AuthBridge, AuthService},
    state::{Binding, Profile, Role, Store, payload_hash},
};
use anyhow::{Context, Result, bail};
use codex_config::LoaderOverrides;
use codex_core::config::{ConfigBuilder, ConfigOverrides};
use codex_core_api::*;
use codex_extension_api::{LoadInstructionsFuture, ToolPolicy};
use codex_protocol::{
    ToolName,
    models::ImageReference,
    protocol::ReviewDecision,
    request_permissions::{
        PermissionGrantScope, RequestPermissionProfile, RequestPermissionsResponse,
    },
    request_user_input::{RequestUserInputAnswer, RequestUserInputResponse},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, RwLock, mpsc};
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenThread {
    #[serde(default)]
    pub import_id: Option<String>,
    pub thread_id: Option<String>,
    pub project_root: PathBuf,
    pub flow_session_id: String,
    pub profile_id: String,
    pub role: Role,
    pub model: String,
    pub system: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartTurn {
    pub thread_id: String,
    pub request_id: String,
    pub prompt: String,
    pub images: Vec<String>,
    pub output_schema: Option<Value>,
}

enum Interaction {
    Exec {
        id: String,
        turn_id: String,
        can_approve: bool,
    },
    Patch {
        id: String,
    },
    Input {
        id: String,
        questions: Vec<String>,
    },
}

pub struct LiveThread {
    pub binding: Binding,
    pub thread: Arc<CodexThread>,
    native_id: ThreadId,
    manager: Arc<ThreadManager>,
    pub run: Mutex<()>,
    interactions: Mutex<HashMap<String, Interaction>>,
    pub cancelled: AtomicBool,
}

pub struct Registry {
    store: Arc<Store>,
    auth: Arc<AuthService>,
    paths: Arg0DispatchPaths,
    groups: Mutex<HashMap<String, Arc<ThreadManager>>>,
    pub threads: RwLock<HashMap<String, Arc<LiveThread>>>,
    creation: Mutex<()>,
    bridges: Mutex<HashMap<String, crate::responses_bridge::ResponsesBridge>>,
    events: mpsc::Sender<Value>,
}

struct NoUserInstructions;
impl UserInstructionsProvider for NoUserInstructions {
    fn load_user_instructions(&self) -> LoadInstructionsFuture<'_> {
        Box::pin(async { LoadedUserInstructions::default() })
    }
}

impl Registry {
    pub fn new(
        store: Arc<Store>,
        auth: Arc<AuthService>,
        paths: Arg0DispatchPaths,
        events: mpsc::Sender<Value>,
    ) -> Self {
        Self {
            store,
            auth,
            paths,
            groups: Mutex::new(HashMap::new()),
            threads: RwLock::new(HashMap::new()),
            creation: Mutex::new(()),
            bridges: Mutex::new(HashMap::new()),
            events,
        }
    }

    pub async fn open(&self, mut request: OpenThread) -> Result<Value> {
        let _guard = self.creation.lock().await;
        request.project_root = tokio::fs::canonicalize(&request.project_root)
            .await
            .context("Project directory could not be opened")?;
        if !request.project_root.is_dir() {
            bail!("Project root is not a directory");
        }
        if request.flow_session_id.is_empty() || request.model.is_empty() {
            bail!("Session and model must be specified");
        }
        let profile = self.store.profile(&request.profile_id).await?;
        self.auth.headers(&profile, false).await?;
        let mut binding = if let Some(id) = &request.thread_id {
            self.store
                .data
                .lock()
                .await
                .bindings
                .get(id)
                .cloned()
                .context("Harness session was not found; its visible FlowM history was preserved")?
        } else {
            Binding {
                id: Uuid::new_v4().to_string(),
                project_root: request.project_root.clone(),
                flow_session_id: request.flow_session_id.clone(),
                profile_id: request.profile_id.clone(),
                credential_version: profile.credential_version,
                role: request.role.clone(),
                model: request.model.clone(),
                system: request.system.clone(),
                rollout_path: None,
                imported_from: None,
                blocked_request_id: None,
            }
        };
        validate_binding(&binding, &request, &profile)?;
        if self.threads.read().await.contains_key(&binding.id) {
            return Ok(binding_result(&binding));
        }
        if profile.auth_kind == crate::state::AuthKind::Chatgpt {
            let models = self.auth.models(&profile.id).await?;
            if !models.as_array().is_some_and(|models| {
                models
                    .iter()
                    .any(|model| model["id"].as_str() == Some(&binding.model))
            }) {
                bail!("This model is not listed for the selected ChatGPT account");
            }
        }
        let config = self.config(&binding, &profile).await?;
        let key = format!(
            "{}:{}:{}:{:?}:{}",
            profile.id,
            profile.credential_version,
            payload_hash(&json!(binding.project_root)),
            binding.role,
            binding.model
        );
        let manager = {
            let mut groups = self.groups.lock().await;
            if let Some(manager) = groups.get(&key) {
                manager.clone()
            } else {
                let manager = self.manager(&config, profile).await?;
                groups.insert(key, manager.clone());
                manager
            }
        };
        let mut options = StartThreadOptions::new(config);
        options
            .thread_extension_init
            .insert(tool_policy(&binding.role));
        options.user_instructions = Some(LoadedUserInstructions::default());
        if let Some(path) = &binding.rollout_path {
            let path = tokio::fs::canonicalize(path)
                .await
                .context("Private session history is missing")?;
            let home = tokio::fs::canonicalize(&self.store.home).await?;
            if !path.starts_with(&home) {
                bail!("Session history is outside FlowM's private runtime directory");
            }
            options.initial_history = codex_rollout::RolloutRecorder::get_rollout_history(&path)
                .await
                .context("Private thread history could not be recovered")?;
        } else if let Some(import_id) = &request.import_id {
            if import_id.len() != 64
                || !import_id
                    .chars()
                    .all(|character| character.is_ascii_hexdigit())
            {
                bail!("Invalid history import ID");
            }
            let bytes = tokio::fs::read(
                self.store
                    .home
                    .join("imports")
                    .join(format!("{import_id}.json")),
            )
            .await
            .context("Imported history snapshot is missing")?;
            options.initial_history = serde_json::from_slice(&bytes)?;
            binding.imported_from = Some(import_id.clone());
        }
        let NewThread {
            thread,
            thread_id: native_id,
            ..
        } = manager
            .start_thread(options)
            .await
            .context("Harness thread could not start")?;
        thread.ensure_rollout_materialized().await;
        binding.rollout_path = thread.rollout_path();
        if binding.rollout_path.is_none() {
            let _ = thread.shutdown_and_wait().await;
            bail!("Kernel did not create durable session history");
        }
        self.store
            .data
            .lock()
            .await
            .bindings
            .insert(binding.id.clone(), binding.clone());
        self.store.save().await?;
        self.threads.write().await.insert(
            binding.id.clone(),
            Arc::new(LiveThread {
                binding: binding.clone(),
                thread,
                native_id,
                manager,
                run: Mutex::new(()),
                interactions: Mutex::new(HashMap::new()),
                cancelled: AtomicBool::new(false),
            }),
        );
        Ok(binding_result(&binding))
    }

    async fn config(&self, binding: &Binding, profile: &Profile) -> Result<Config> {
        let home = self
            .store
            .home
            .join("runtime")
            .join(&profile.id)
            .join(profile.credential_version.to_string())
            .join(match binding.role {
                Role::Canvas => "canvas",
                Role::Project => "project",
            });
        tokio::fs::create_dir_all(&home).await?;
        let provider_id = if profile.kind == crate::state::ProviderKind::Openai {
            "flowm-openai"
        } else {
            "flowm"
        };
        let base_url = if profile.auth_kind == crate::state::AuthKind::Chatgpt {
            let key = format!("{}:{}", profile.id, profile.credential_version);
            let mut bridges = self.bridges.lock().await;
            if !bridges.contains_key(&key) {
                bridges.insert(
                    key.clone(),
                    crate::responses_bridge::ResponsesBridge::start(
                        self.auth.clone(),
                        profile.clone(),
                    )
                    .await?,
                );
            }
            bridges[&key].base_url.clone()
        } else {
            profile.base_url.clone()
        };
        let mut overrides = vec![
            (
                format!("model_providers.{provider_id}"),
                toml::Value::try_from(codex_model_provider_info::ModelProviderInfo {
                    name: if profile.kind == crate::state::ProviderKind::Openai {
                        "FlowM OpenAI"
                    } else {
                        "FlowM gateway"
                    }
                    .into(),
                    base_url: Some(base_url),
                    requires_openai_auth: true,
                    request_max_retries: Some(0),
                    stream_max_retries: Some(0),
                    stream_idle_timeout_ms: Some(180_000),
                    ..Default::default()
                })?,
            ),
            ("web_search".into(), toml::Value::String("disabled".into())),
            (
                "windows.sandbox".into(),
                toml::Value::String("unelevated".into()),
            ),
            (
                "check_for_update_on_startup".into(),
                toml::Value::Boolean(false),
            ),
            ("analytics.enabled".into(), toml::Value::Boolean(false)),
            (
                "history.persistence".into(),
                toml::Value::String("none".into()),
            ),
        ];
        // Disable these before Config construction, so dependent startup paths also see them.
        for key in [
            "apps",
            "plugins",
            "codex_hooks",
            "plugin_hooks",
            "code_mode",
            "code_mode_host",
            "code_mode_prewarm",
            "collab",
            "multi_agent_v2",
            "memory_tool",
            "external_agent_memory_import",
            "realtime_conversation",
            "shell_snapshot",
            "background_paginated_rollout_migration",
            "local_thread_store_compression",
            "unbounded_connection_retries",
            "tool_suggest",
            "recommended_plugins",
            "skill_search",
            "skill_mcp_dependency_install",
            "skill_env_var_dependency_prompt",
            "standalone_web_search",
            "request_permissions_tool",
        ] {
            overrides.push((format!("features.{key}"), toml::Value::Boolean(false)));
        }
        overrides.push((
            "features.skip_host_skill_discovery".into(),
            toml::Value::Boolean(true),
        ));
        overrides.push(("features.unified_exec".into(), toml::Value::Boolean(true)));
        overrides.push((
            "features.default_mode_request_user_input".into(),
            toml::Value::Boolean(true),
        ));
        overrides.push(("features.prefer_mxc".into(), toml::Value::Boolean(false)));
        let config_overrides = ConfigOverrides {
            model: Some(binding.model.clone()),
            cwd: Some(binding.project_root.clone()),
            model_provider: Some(provider_id.into()),
            approval_policy: Some(if binding.role == Role::Canvas {
                AskForApproval::Never
            } else {
                AskForApproval::OnRequest
            }),
            approvals_reviewer: Some(ApprovalsReviewer::User),
            permission_profile: Some(if binding.role == Role::Canvas {
                PermissionProfile::read_only()
            } else {
                PermissionProfile::workspace_write()
            }),
            base_instructions: (!binding.system.is_empty()).then(|| binding.system.clone()),
            ephemeral: Some(false),
            codex_self_exe: self.paths.codex_self_exe.clone(),
            codex_linux_sandbox_exe: self.paths.codex_linux_sandbox_exe.clone(),
            main_execve_wrapper_exe: self.paths.main_execve_wrapper_exe.clone(),
            workspace_roots: Some(vec![AbsolutePathBuf::from_absolute_path(
                binding.project_root.clone(),
            )?]),
            ..Default::default()
        };
        let mut config = ConfigBuilder::default()
            .codex_home(home)
            .cli_overrides(overrides)
            .harness_overrides(config_overrides)
            .loader_overrides(LoaderOverrides {
                ignore_user_config: true,
                ignore_project_config: true,
                ignore_user_and_project_exec_policy_rules: true,
                ..Default::default()
            })
            .build()
            .await?;
        // Nothing from global user homes, credentials, hooks, MCP, plugins, or memory is inherited.
        config.mcp_servers.set(HashMap::new())?;
        config.include_skill_instructions = false;
        config.cloud_skill_enabled = false;
        config.orchestrator_mcp_enabled = false;
        config.check_for_update_on_startup = false;
        config.analytics_enabled = Some(false);
        config.feedback_enabled = false;
        config.permissions.allow_login_shell = false;
        if !config.features.enabled(Feature::SkipHostSkillDiscovery) || config.prefer_mxc {
            bail!("Managed feature policy is incompatible with FlowM's isolated runtime");
        }
        for feature in [
            Feature::Apps,
            Feature::Plugins,
            Feature::CodexHooks,
            Feature::PluginHooks,
            Feature::CodeMode,
            Feature::CodeModeHost,
            Feature::Collab,
            Feature::MultiAgentV2,
            Feature::MemoryTool,
            Feature::ExternalAgentMemoryImport,
            Feature::RealtimeConversation,
            Feature::SkillMcpDependencyInstall,
            Feature::SkillSearch,
        ] {
            if config.features.enabled(feature) {
                bail!(
                    "Managed policy enabled a feature outside the FlowM runtime profile: {feature:?}"
                );
            }
        }
        config.suppress_unstable_features_warning = true;
        // This is request/tool metadata, not an entitlement catalog. The UI's model discovery is
        // owned by AuthService, and never refreshes through Codex's backend or user configuration.
        let mut catalog: codex_protocol::openai_models::ModelsResponse = serde_json::from_str(
            include_str!("../../third_party/codex/codex-rs/models-manager/models.json"),
        )?;
        if profile.kind == crate::state::ProviderKind::Gateway
            && !catalog
                .models
                .iter()
                .any(|model| model.slug == binding.model)
        {
            let mut model = catalog
                .models
                .first()
                .cloned()
                .context("Missing kernel model metadata")?;
            model.slug = binding.model.clone();
            model.display_name = binding.model.clone();
            model.default_reasoning_level = None;
            model.supported_reasoning_levels.clear();
            model.supports_reasoning_summary_parameter = false;
            model.support_verbosity = false;
            model.context_window = None;
            model.max_context_window = None;
            model.auto_compact_token_limit = None;
            model.experimental_supported_tools.clear();
            model.model_messages = None;
            catalog.models = vec![model];
        }
        config.model_catalog = Some(catalog);
        let permission = config.permissions.permission_profile();
        let read_only = permission
            .intersect_with_read_only()
            .context("FlowM requires a managed filesystem sandbox")?;
        if binding.role == Role::Canvas && &read_only != permission {
            bail!(
                "Managed policy changed the canvas permission ceiling; a writable canvas thread was refused"
            );
        }
        #[cfg(windows)]
        if config.permissions.windows_sandbox_mode
            != Some(codex_config::types::WindowsSandboxModeToml::Unelevated)
        {
            bail!(
                "This FlowM build requires the unelevated Windows sandbox; other backends were not silently substituted"
            );
        }
        Ok(config)
    }

    async fn manager(&self, config: &Config, profile: Profile) -> Result<Arc<ThreadManager>> {
        let state_db = init_state_db(config).await;
        let auth_manager = AuthManager::shared_from_config(config, false).await?;
        let request_auth = if profile.auth_kind == crate::state::AuthKind::Chatgpt {
            let key = format!("{}:{}", profile.id, profile.credential_version);
            Some(
                self.bridges
                    .lock()
                    .await
                    .get(&key)
                    .context("ChatGPT request bridge is missing")?
                    .request_auth(),
            )
        } else {
            None
        };
        auth_manager
            .set_external_auth(Arc::new(AuthBridge::new(
                self.auth.clone(),
                profile,
                request_auth,
            )))
            .await?;
        let runtime_paths = ExecServerRuntimeOptions::from_optional_paths(
            config.codex_self_exe.clone(),
            config.codex_linux_sandbox_exe.clone(),
        )?;
        let store = thread_store_from_config(config, state_db.clone());
        let environment = Arc::new(
            EnvironmentManager::from_codex_home(
                config.codex_home.clone(),
                Some(runtime_paths),
                config.http_client_factory(),
            )
            .await?,
        );
        Ok(Arc::new(ThreadManager::new(
            config,
            auth_manager.clone(),
            build_models_manager(config, auth_manager),
            CodexAppsToolsCache::default(),
            SessionSource::Exec,
            environment,
            Arc::new(ExtensionRegistryBuilder::<Config>::new().build()),
            Arc::new(NoUserInstructions),
            None,
            passthrough_image_store(),
            store,
            local_agent_graph_store_from_state_db(state_db.as_ref()),
            resolve_installation_id(&config.codex_home).await?,
            None,
            None,
        )))
    }

    pub async fn live(&self, id: &str) -> Result<Arc<LiveThread>> {
        self.threads
            .read()
            .await
            .get(id)
            .cloned()
            .context("Thread is not open; reopen its FlowM binding first")
    }

    pub async fn run(&self, live: &LiveThread, request: &StartTurn) -> Result<(String, String)> {
        if live.cancelled.load(Ordering::Acquire) {
            bail!("Request cancelled before model submission");
        }
        let mut content = vec![UserInput::Text {
            text: request.prompt.clone(),
            text_elements: vec![],
        }];
        for image in &request.images {
            if !image.starts_with("data:image/") || image.len() > 10 * 1024 * 1024 {
                bail!("Only bounded, inline image inputs are supported");
            }
            content.push(UserInput::Image {
                image: ImageReference::Inline {
                    image_url: image.clone(),
                },
                detail: None,
            });
        }
        let submitted = live
            .thread
            .start_turn_if_idle(
                TurnInputRequest::new(TurnInput::UserInput {
                    content,
                    client_id: Some(request.request_id.clone()),
                })
                .on_start(TurnStartOptions {
                    final_output_json_schema: request.output_schema.clone(),
                    ..Default::default()
                }),
            )
            .await?;
        let native_turn = match submitted {
            StartIfIdleSubmission::Started { turn_id } => turn_id,
            StartIfIdleSubmission::NotSubmitted { reason } => {
                bail!("Kernel refused the request: {reason:?}")
            }
        };
        if live.cancelled.load(Ordering::Acquire) {
            let _ = live.thread.submit(Op::Interrupt).await;
        }
        let mut receipt = self
            .store
            .receipt(&request.request_id)
            .await?
            .context("Missing durable request receipt")?;
        receipt.status = "running".into();
        receipt.native_turn_id = Some(native_turn.clone());
        self.store.write_receipt(&receipt).await?;
        let result = self.collect(live, request, &native_turn).await;
        live.interactions.lock().await.clear();
        // Flush the durable history before acknowledging a successful result.
        live.thread.flush_rollout().await?;
        result.map(|text| (native_turn, text))
    }

    async fn collect(
        &self,
        live: &LiveThread,
        request: &StartTurn,
        native_turn: &str,
    ) -> Result<String> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1800);
        let mut error: Option<String> = None;
        let mut output_chars = 0usize;
        loop {
            if live.cancelled.load(Ordering::Acquire) {
                bail!("Request cancelled; no automatic replay was performed");
            }
            if tokio::time::Instant::now() >= deadline {
                let _ = live.thread.submit(Op::Interrupt).await;
                bail!("Request exceeded the 30 minute limit");
            }
            let waiting = !live.interactions.lock().await.is_empty();
            let timeout = if waiting {
                Duration::from_secs(600)
            } else {
                Duration::from_secs(240)
            };
            let event = match tokio::time::timeout(timeout, live.thread.next_event()).await {
                Ok(event) => event?,
                Err(_) => {
                    let _ = live.thread.submit(Op::Interrupt).await;
                    bail!(
                        "Request became idle or its interaction expired; no automatic replay was performed"
                    );
                }
            };
            match event.msg {
                EventMsg::TurnComplete(done) if done.turn_id == native_turn => {
                    if let Some(failure) = done.error { bail!("{}", failure.message); }
                    if let Some(error) = error { bail!("{error}"); }
                    return done.last_agent_message.context("Model completed without a final answer");
                }
                EventMsg::TurnAborted(_) => bail!("Request was interrupted"),
                EventMsg::Error(failure) => { error = Some(failure.message.clone()); self.activity(request, json!({"type":"warning","id":event.id,"text":failure.message})).await?; }
                EventMsg::Warning(warning) => self.activity(request, json!({"type":"warning","id":event.id,"text":warning.message})).await?,
                EventMsg::ReasoningContentDelta(delta) => self.activity(request, json!({"type":"thinking_delta","id":delta.item_id,"delta":delta.delta})).await?,
                EventMsg::AgentMessageContentDelta(delta) => {
                    output_chars += delta.delta.len();
                    if output_chars > 4 * 1024 * 1024 { let _ = live.thread.submit(Op::Interrupt).await; bail!("Model output exceeded the bounded output limit"); }
                    // Canvas JSON is not streamed into the visible assistant bubble.
                    if live.binding.role == Role::Project { self.emit(request, json!({"kind":"text","text":delta.delta})).await?; }
                }
                EventMsg::ExecCommandBegin(exec) => self.activity(request, json!({"type":"tool","id":exec.call_id,"name":"Command","toolKind":"command","status":"running","detail":exec.command.join(" ")})).await?,
                EventMsg::ExecCommandEnd(exec) => self.activity(request, json!({"type":"tool_status","id":exec.call_id,"status":if exec.exit_code == 0 {"completed"} else {"failed"},"output":bounded_text(&exec.aggregated_output)})).await?,
                EventMsg::PatchApplyBegin(patch) => self.activity(request, json!({"type":"tool","id":patch.call_id,"name":"Apply patch","status":"running","detail":patch.changes.keys().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")})).await?,
                EventMsg::PatchApplyEnd(patch) => self.activity(request, json!({"type":"tool_status","id":patch.call_id,"status":if patch.success {"completed"} else {"failed"},"output":bounded_text(&format!("{}{}", patch.stdout, patch.stderr))})).await?,
                EventMsg::ExecApprovalRequest(approval) => {
                    let id = approval.effective_approval_id();
                    if live.binding.role == Role::Canvas { live.thread.submit(Op::ExecApproval { id, turn_id: Some(approval.turn_id), decision: ReviewDecision::denied("Canvas threads cannot escalate repository permissions") }).await?; continue; }
                    let can_approve = approval.effective_available_decisions().iter().any(|choice| matches!(choice, ReviewDecision::Approved));
                    let prompt = format!("{}\nWorking directory: {}\n{}", approval.command.join(" "), approval.cwd, approval.reason.unwrap_or_default());
                    self.approval(live, request, Interaction::Exec { id, turn_id: approval.turn_id, can_approve }, prompt, can_approve).await?;
                }
                EventMsg::ApplyPatchApprovalRequest(approval) => {
                    if live.binding.role == Role::Canvas { live.thread.submit(Op::PatchApproval { id: approval.call_id, decision: ReviewDecision::denied("Canvas threads cannot write repository files") }).await?; continue; }
                    let prompt = format!("Approve file changes outside the current write permission?\n{}\n{}", approval.changes.keys().map(|path| path.display().to_string()).collect::<Vec<_>>().join("\n"), approval.reason.unwrap_or_default());
                    self.approval(live, request, Interaction::Patch { id: approval.call_id }, prompt, true).await?;
                }
                EventMsg::RequestUserInput(input) => {
                    let interaction_id = Uuid::new_v4().to_string();
                    live.interactions.lock().await.insert(interaction_id.clone(), Interaction::Input { id: input.turn_id, questions: input.questions.iter().map(|q| q.id.clone()).collect() });
                    let items: Vec<Value> = input.questions.iter().map(|q| json!({"id":q.id,"prompt":q.question,"header":q.header,"allowOther":q.is_other,"secret":q.is_secret,"options":q.options})).collect();
                    self.emit(request, json!({"kind":"question","question":{"requestId":interaction_id,"items":items}})).await?;
                }
                EventMsg::RequestPermissions(permissions) => {
                    // Extra permission grants are deliberately not exposed in the first version.
                    live.thread.submit(Op::RequestPermissionsResponse { id: permissions.call_id, response: RequestPermissionsResponse { permissions: RequestPermissionProfile::default(), scope: PermissionGrantScope::Turn, strict_auto_review: false } }).await?;
                }
                EventMsg::DynamicToolCallRequest(call) => bail!("Unsupported dynamic tool call: {}", call.tool),
                EventMsg::ShutdownComplete => bail!("Harness thread stopped during the request"),
                _ => (),
            }
        }
    }

    async fn approval(
        &self,
        live: &LiveThread,
        request: &StartTurn,
        interaction: Interaction,
        prompt: String,
        can_approve: bool,
    ) -> Result<()> {
        let id = Uuid::new_v4().to_string();
        live.interactions
            .lock()
            .await
            .insert(id.clone(), interaction);
        let mut options = vec![json!({"label":"Deny","description":"Do not execute this action"})];
        if can_approve {
            options.push(json!({"label":"Approve","description":"Allow this action once"}));
        }
        self.emit(request, json!({"kind":"question","question":{"requestId":id,"items":[{"id":"decision","header":"Approval","prompt":prompt,"options":options,"allowOther":false}]}})).await
    }

    pub async fn answer(
        &self,
        thread_id: &str,
        interaction_id: &str,
        answers: HashMap<String, Vec<String>>,
    ) -> Result<()> {
        let live = self.live(thread_id).await?;
        let mut interactions = live.interactions.lock().await;
        let interaction = interactions
            .get(interaction_id)
            .context("Interaction expired or belongs to another request")?;
        let decision = answers
            .get("decision")
            .and_then(|choices| choices.first())
            .map(String::as_str);
        let op = match interaction {
            Interaction::Exec {
                id,
                turn_id,
                can_approve,
            } => {
                if !matches!(decision, Some("Approve" | "Deny")) {
                    bail!("Choose Approve or Deny");
                }
                if decision == Some("Approve")
                    && (!can_approve || live.binding.role != Role::Project)
                {
                    bail!("This action cannot be approved");
                }
                Op::ExecApproval {
                    id: id.clone(),
                    turn_id: Some(turn_id.clone()),
                    decision: if decision == Some("Approve") {
                        ReviewDecision::Approved
                    } else {
                        ReviewDecision::denied("Denied in FlowM")
                    },
                }
            }
            Interaction::Patch { id } => {
                if !matches!(decision, Some("Approve" | "Deny")) {
                    bail!("Choose Approve or Deny");
                }
                Op::PatchApproval {
                    id: id.clone(),
                    decision: if decision == Some("Approve") {
                        ReviewDecision::Approved
                    } else {
                        ReviewDecision::denied("Denied in FlowM")
                    },
                }
            }
            Interaction::Input { id, questions } => {
                if answers.keys().any(|key| !questions.contains(key)) {
                    bail!("Answer does not belong to the pending question");
                }
                Op::UserInputAnswer {
                    id: id.clone(),
                    response: RequestUserInputResponse {
                        answers: answers
                            .into_iter()
                            .map(|(id, answers)| (id, RequestUserInputAnswer { answers }))
                            .collect(),
                    },
                }
            }
        };
        live.thread.submit(op).await?;
        interactions.remove(interaction_id);
        Ok(())
    }

    pub async fn cancel(&self, thread_id: &str) -> Result<()> {
        let live = self.live(thread_id).await?;
        live.cancelled.store(true, Ordering::Release);
        live.interactions.lock().await.clear();
        live.thread.submit(Op::Interrupt).await?;
        // Wait for the active collector to leave before acknowledging cancellation.
        let _guard = tokio::time::timeout(Duration::from_secs(15), live.run.lock())
            .await
            .context("Kernel cancellation did not finish in time")?;
        Ok(())
    }

    pub async fn close(&self, thread_id: &str) -> Result<()> {
        let live = self.threads.write().await.remove(thread_id);
        if let Some(live) = live {
            live.cancelled.store(true, Ordering::Release);
            live.thread.submit(Op::Interrupt).await?;
            tokio::time::timeout(Duration::from_secs(15), live.thread.shutdown_and_wait())
                .await
                .context("Thread shutdown timed out")??;
            let _ = live.manager.remove_thread(&live.native_id).await;
        }
        Ok(())
    }

    pub async fn close_profile(&self, profile: &str) -> Result<()> {
        let ids: Vec<String> = self
            .threads
            .read()
            .await
            .iter()
            .filter(|(_, thread)| thread.binding.profile_id == profile)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.close(&id).await?;
        }
        self.groups
            .lock()
            .await
            .retain(|key, _| !key.starts_with(&format!("{profile}:")));
        self.bridges
            .lock()
            .await
            .retain(|key, _| !key.starts_with(&format!("{profile}:")));
        Ok(())
    }

    pub async fn shutdown(&self) {
        for manager in self.groups.lock().await.values() {
            manager
                .shutdown_all_threads_bounded(Duration::from_secs(5))
                .await;
        }
    }

    pub async fn emit(&self, request: &StartTurn, event: Value) -> Result<()> {
        self.events.send(json!({"method":"turn/event","params":{"threadId":request.thread_id,"requestId":request.request_id,"event":event}})).await.context("FlowM connection closed")
    }
    async fn activity(&self, request: &StartTurn, activity: Value) -> Result<()> {
        self.emit(request, json!({"kind":"activity","activity":activity}))
            .await
    }
}

fn binding_result(binding: &Binding) -> Value {
    json!({"threadId":binding.id,"role":binding.role,"model":binding.model,"credentialVersion":binding.credential_version})
}
fn validate_binding(binding: &Binding, request: &OpenThread, profile: &Profile) -> Result<()> {
    if binding.project_root != request.project_root
        || binding.flow_session_id != request.flow_session_id
        || binding.profile_id != request.profile_id
        || binding.credential_version != profile.credential_version
        || binding.role != request.role
        || binding.model != request.model
        || binding.system != request.system
    {
        bail!(
            "Session binding changed (project, FlowM session, provider, account, role, model, or instructions); create a separate harness thread"
        );
    }
    Ok(())
}
fn tool_policy(role: &Role) -> ToolPolicy {
    let mut names = vec![
        "exec_command",
        "write_stdin",
        "view_image",
        "update_plan",
        "request_user_input",
    ];
    if *role == Role::Project {
        names.push("apply_patch");
    }
    ToolPolicy {
        allowed_tools: Some(names.into_iter().map(ToolName::plain).collect()),
        require_managed_sandbox: true,
        require_unified_exec: true,
        expose_additional_permissions: *role == Role::Project,
    }
}
fn bounded_text(text: &str) -> &str {
    &text[..text.floor_char_boundary(16 * 1024)]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn openai_profiles_build_without_overriding_builtin_providers() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let project = directory.path().join("project");
        tokio::fs::create_dir_all(&project).await?;
        let store = Arc::new(Store::open(directory.path().join("private")).await?);
        let (events, _receiver) = mpsc::channel(16);
        let auth = AuthService::new(store.clone(), events.clone())?;
        let registry = Registry::new(store, auth, Arg0DispatchPaths::default(), events);
        for auth_kind in [
            crate::state::AuthKind::Bearer,
            crate::state::AuthKind::Chatgpt,
        ] {
            let profile = Profile {
                id: Uuid::new_v4().to_string(),
                name: "OpenAI config regression".into(),
                kind: crate::state::ProviderKind::Openai,
                base_url: "https://api.openai.com/v1".into(),
                model: "gpt-5.5".into(),
                auth_kind: auth_kind.clone(),
                credential_version: 1,
                account: None,
                subject: None,
                client_id: None,
            };
            let binding = Binding {
                id: Uuid::new_v4().to_string(),
                project_root: project.clone(),
                flow_session_id: "config-test".into(),
                profile_id: profile.id.clone(),
                credential_version: 1,
                role: Role::Canvas,
                model: profile.model.clone(),
                system: "Caller-owned canvas contract".into(),
                rollout_path: None,
                imported_from: None,
                blocked_request_id: None,
            };
            let config = registry.config(&binding, &profile).await?;
            assert_eq!(config.model_provider_id, "flowm-openai");
            assert_eq!(config.model_provider.name, "FlowM OpenAI");
            assert!(config.model_provider.requires_openai_auth);
            assert!(config.model_providers.contains_key("openai"));
            assert_eq!(config.model_providers["openai"].name, "OpenAI");
            if auth_kind == crate::state::AuthKind::Bearer {
                assert_eq!(
                    config.model_provider.base_url.as_deref(),
                    Some("https://api.openai.com/v1")
                );
            } else {
                assert!(
                    config
                        .model_provider
                        .base_url
                        .as_deref()
                        .is_some_and(|url| url.starts_with("http://127.0.0.1:"))
                );
            }
        }
        Ok(())
    }
    #[test]
    fn canvas_policy_cannot_patch_or_request_escalation() {
        let canvas = tool_policy(&Role::Canvas);
        assert!(canvas.allows(&ToolName::plain("exec_command")));
        assert!(!canvas.allows(&ToolName::plain("apply_patch")));
        assert!(!canvas.allows(&ToolName::plain("request_permissions")));
        assert!(!canvas.expose_additional_permissions);
        assert!(canvas.require_managed_sandbox);
        assert!(tool_policy(&Role::Project).allows(&ToolName::plain("apply_patch")));
    }
}
