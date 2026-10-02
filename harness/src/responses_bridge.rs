//! SIWC's public Responses route accepts a narrower request than Codex's internal route.
//! This in-process bridge preserves streaming; it never returns credentials to the renderer.
use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode, header},
    response::Response,
    routing::post,
};
use serde_json::{Value, json};
use uuid::Uuid;

pub struct ResponsesBridge {
    pub base_url: String,
    task: tokio::task::JoinHandle<()>,
}
#[derive(Clone)]
struct BridgeState {
    client: reqwest::Client,
}

impl ResponsesBridge {
    pub async fn start() -> Result<Self> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let base_url = format!(
            "http://127.0.0.1:{}/{}/v1",
            listener.local_addr()?.port(),
            Uuid::new_v4()
        );
        let path = url::Url::parse(&base_url)?.path().to_owned() + "/responses";
        let state = BridgeState {
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
        Ok(Self { base_url, task })
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
    normalize_siwc_request(&mut body).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            "Request uses an unsupported ChatGPT plan capability",
        )
    })?;
    let authorization = headers.get(header::AUTHORIZATION).cloned().ok_or((
        StatusCode::UNAUTHORIZED,
        "Missing FlowM-managed authentication",
    ))?;
    let upstream = state
        .client
        .post("https://api.openai.com/v1/responses")
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
