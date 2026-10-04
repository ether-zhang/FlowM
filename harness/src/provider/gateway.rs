//! Standard Responses gateways use their own endpoint, credential and advertised model metadata.
mod output;
use super::{ProviderDefinition, definition};
use crate::state::Profile;
use codex_protocol::openai_models::{
    InputModality, ModelInfo, ReasoningEffort, ReasoningEffortPreset,
};
pub use output::CanvasOutput;
use serde_json::Value;

pub(super) fn resolve(profile: &Profile) -> ProviderDefinition {
    // Keep the existing provider ID so private rollouts remain resumable.
    definition("flowm", "FlowM gateway", profile.base_url.clone())
}

pub fn normalize_model_metadata(raw: &Value, model: &mut ModelInfo) {
    if raw["display_name"]
        .as_str()
        .is_none_or(|name| name.trim().is_empty())
    {
        if let Some(name) = raw["name"].as_str().filter(|name| !name.trim().is_empty()) {
            model.display_name = name.into();
        }
    }
    if raw.get("context_window").is_none() {
        let window = positive(&raw["context_length"]);
        let provider_window = positive(&raw["top_provider"]["context_length"]);
        model.context_window = match (window, provider_window) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        if raw.get("max_context_window").is_none() {
            model.max_context_window = model.context_window;
        }
    }
    if raw.get("input_modalities").is_none() {
        if let Some(modalities) = raw["architecture"]["input_modalities"].as_array() {
            model.input_modalities = modalities
                .iter()
                .filter_map(|value| serde_json::from_value::<InputModality>(value.clone()).ok())
                .collect();
        }
    }
    if raw.get("supported_reasoning_levels").is_none() {
        if let Some(efforts) = raw["reasoning"]["supported_efforts"].as_array() {
            model.supported_reasoning_levels = efforts
                .iter()
                .filter_map(|value| {
                    serde_json::from_value::<ReasoningEffort>(value.clone())
                        .ok()
                        .map(|effort| ReasoningEffortPreset {
                            effort,
                            description: format!(
                                "Gateway reasoning effort: {}",
                                value.as_str().unwrap_or_default()
                            ),
                        })
                })
                .collect();
        }
    }
    if raw.get("default_reasoning_level").is_none() {
        model.default_reasoning_level =
            serde_json::from_value(raw["reasoning"]["default_effort"].clone()).ok();
    }
    if raw.get("support_verbosity").is_none() {
        model.support_verbosity = raw["supported_parameters"]
            .as_array()
            .is_some_and(|parameters| parameters.iter().any(|parameter| parameter == "verbosity"));
    }
}

fn positive(value: &Value) -> Option<i64> {
    value.as_i64().filter(|value| *value > 0)
}

pub fn error_message(message: &str) -> String {
    let parsed = serde_json::from_str::<Value>(message).ok().or_else(|| {
        let start = message.find('{')?;
        let end = message.rfind('}')?;
        serde_json::from_str(&message[start..=end]).ok()
    });
    let Some(body) = parsed else {
        return message.into();
    };
    let Some(detail) = error_detail(&body, 0) else {
        return message.into();
    };
    if let Some(code) = body["error"]["code"]
        .as_u64()
        .or_else(|| body["code"].as_u64())
    {
        format!("Gateway HTTP {code}: {detail}")
    } else {
        detail
    }
}

fn error_detail(body: &Value, depth: usize) -> Option<String> {
    if depth > 6 {
        return None;
    }
    if let Some(error) = body.get("error") {
        if let Some(detail) = error_detail(error, depth + 1) {
            return Some(detail);
        }
    }
    if let Some(raw) = body["metadata"]["raw"].as_str() {
        if let Ok(raw) = serde_json::from_str::<Value>(raw) {
            if let Some(detail) = error_detail(&raw, depth + 1) {
                return Some(detail);
            }
        }
    }
    body["message"].as_str().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AuthKind, ProviderKind};
    #[test]
    fn gateway_endpoint_uses_its_own_responses_route_without_openai_credentials() {
        let profile = Profile {
            id: "gateway".into(),
            name: "OpenRouter".into(),
            kind: ProviderKind::Gateway,
            auth_kind: AuthKind::Bearer,
            base_url: "https://openrouter.ai/api/v1".into(),
            model: String::new(),
            credential_version: 1,
            account: None,
            subject: None,
            client_id: None,
        };
        let route = resolve(&profile);
        assert_eq!(
            route.info.base_url.as_deref(),
            Some("https://openrouter.ai/api/v1")
        );
        assert_eq!(
            route.info.wire_api,
            codex_model_provider_info::WireApi::Responses
        );
        assert!(route.info.env_key.is_none());
        assert!(route.info.experimental_bearer_token.is_none());
        assert_eq!(route.info.request_max_retries, Some(0));
    }
    #[test]
    fn wrapped_provider_errors_keep_the_reason_without_account_metadata() {
        let raw = serde_json::json!({"error":{"type":"invalid_request_error","message":"Enum process does not match declared type"}}).to_string();
        let message = serde_json::json!({"error":{"message":"Provider returned error","code":400,
            "metadata":{"raw":raw,"provider_name":"Google","user_id":"private-account"}}})
        .to_string();
        assert_eq!(
            error_message(&message),
            "Gateway HTTP 400: Enum process does not match declared type"
        );
        assert_eq!(error_message("Request interrupted"), "Request interrupted");
    }
}
