//! Short-lived metadata discovery. No thread/start, user prompt, guide, or canvas session.
use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout, Command};

type Output = Lines<BufReader<ChildStdout>>;

async fn send(stdin: &mut ChildStdin, message: Value) -> Result<(), String> {
    let mut line = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
    line.push(b'\n');
    stdin.write_all(&line).await.map_err(|error| error.to_string())?;
    stdin.flush().await.map_err(|error| error.to_string())
}

async fn next_message(output: &mut Output) -> Result<Value, String> {
    while let Some(line) = output.next_line().await.map_err(|error| error.to_string())? {
        if let Ok(message) = serde_json::from_str(&line) {
            return Ok(message);
        }
    }
    Err("The agent exited before returning its model catalog".to_string())
}

async fn rpc_response(output: &mut Output, id: u64) -> Result<Value, String> {
    loop {
        let message = next_message(output).await?;
        if message.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = message.get("error").filter(|error| !error.is_null()) {
            return Err(error.get("message").and_then(Value::as_str).unwrap_or("Agent model query failed").to_string());
        }
        return message.get("result").cloned().ok_or_else(|| "Agent response has no result".to_string());
    }
}

async fn codex_models(stdin: &mut ChildStdin, output: &mut Output) -> Result<Value, String> {
    send(stdin, json!({
        "id": 1, "method": "initialize",
        "params": { "clientInfo": { "name": "flowm-model-catalog", "version": env!("CARGO_PKG_VERSION") }, "capabilities": { "experimentalApi": true } }
    })).await?;
    rpc_response(output, 1).await?;
    send(stdin, json!({ "method": "initialized" })).await?;
    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen = HashSet::new();
    for id in 2..=65 {
        let mut params = json!({ "limit": 100, "includeHidden": false });
        if let Some(value) = &cursor { params["cursor"] = json!(value); }
        send(stdin, json!({ "id": id, "method": "model/list", "params": params })).await?;
        let page = rpc_response(output, id).await?;
        let entries = page.get("data").and_then(Value::as_array).ok_or("Codex returned an invalid model catalog")?;
        models.extend(entries.iter().cloned());
        cursor = page.get("nextCursor").and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_string);
        match &cursor {
            None => return Ok(json!({ "data": models, "nextCursor": null })),
            Some(value) if !seen.insert(value.clone()) => return Err("Codex model catalog repeated a page cursor".to_string()),
            _ => {}
        }
    }
    Err("Codex model catalog exceeded the pagination limit".to_string())
}

async fn claude_models(stdin: &mut ChildStdin, output: &mut Output) -> Result<Value, String> {
    send(stdin, json!({
        "type": "control_request", "request_id": "flowm-models",
        "request": { "subtype": "initialize", "hooks": null }
    })).await?;
    loop {
        let message = next_message(output).await?;
        if message.get("type").and_then(Value::as_str) != Some("control_response") { continue; }
        let response = &message["response"];
        if response.get("request_id").and_then(Value::as_str) != Some("flowm-models") { continue; }
        if response.get("subtype").and_then(Value::as_str) == Some("error") {
            return Err(response.get("error").and_then(Value::as_str).unwrap_or("Claude initialization failed").to_string());
        }
        let models = response["response"].get("models").and_then(Value::as_array)
            .ok_or("This Claude executable does not expose a model catalog through its control protocol")?;
        return Ok(json!({ "models": models }));
    }
}

#[tauri::command]
pub async fn list_agent_models(
    app: AppHandle,
    provider: String,
    bin: Option<String>,
    cwd: Option<String>,
) -> Result<Value, String> {
    let executable = bin.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| {
        if provider == "claude" { super::resolve_claude_bin(&app) } else { super::resolve_codex_bin(&app) }
    });
    // Discovery can run at app startup, before a project is selected. Only metadata is read.
    let directory = match cwd.filter(|value| !value.trim().is_empty()) {
        Some(path) => PathBuf::from(path),
        None => app.path().home_dir().map_err(|error| error.to_string())?,
    };
    let mut command = Command::new(executable.trim());
    match provider.as_str() {
        "codex" => { command.arg("app-server"); }
        "claude" => {
            command.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "manual"])
                .env_remove("CLAUDECODE").env("CLAUDE_CODE_ENTRYPOINT", "sdk-ts");
        }
        _ => return Err("Unknown model provider".to_string()),
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.current_dir(directory).kill_on_drop(true)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|error| format!("Cannot start {provider} for model discovery: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("Agent has no stdin")?;
    let mut output = BufReader::new(child.stdout.take().ok_or("Agent has no stdout")?).lines();
    let stderr = child.stderr.take().ok_or("Agent has no stderr")?;
    let mut diagnostics = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut text = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if text.len() < 2_000 { text.extend(line.chars().take(500)); text.push('\n'); }
        }
        text
    });
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        if provider == "codex" { codex_models(&mut stdin, &mut output).await }
        else { claude_models(&mut stdin, &mut output).await }
    }).await.unwrap_or_else(|_| Err(format!("{provider} model discovery timed out")));
    drop(stdin);
    let _ = child.kill().await;
    let _ = child.wait().await;
    // These processes belong only to this query and are never reused for conversations.
    match result {
        Ok(models) => { diagnostics.abort(); Ok(models) }
        Err(error) => {
            let detail = tokio::time::timeout(Duration::from_secs(1), &mut diagnostics).await.ok().and_then(Result::ok).unwrap_or_default();
            diagnostics.abort();
            if detail.trim().is_empty() { Err(error) } else { Err(format!("{error}\n{}", detail.trim())) }
        }
    }
}
