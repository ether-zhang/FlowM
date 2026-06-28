//! Local HTTP MCP server so the spawned `claude` can draw on / edit the FlowM canvas.
//!
//! Claude Code connects to this over `--mcp-config` (`type:"http"`). We answer the MCP
//! handshake (`initialize`) here, and BRIDGE the two methods that need the live canvas —
//! `tools/list` and `tools/call` — to the renderer: emit a Tauri event carrying a request
//! id, then block the HTTP handler on a channel until the renderer applies the op against
//! its `CanvasPort` and calls back `mcp_respond`. So the canvas tools' definitions AND
//! execution live in the renderer (single source of truth: protocol's canvasTools); Rust is
//! only the transport + correlation. Plain JSON-RPC over POST — no SSE/session (validated
//! against the CLI: it probes GET once, tolerates a 405, then POSTs each request).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct McpState {
    /// Bound port once the server is started (idempotent start).
    port: Mutex<Option<u16>>,
    /// In-flight bridged requests: id → where to deliver the renderer's reply.
    pending: Mutex<HashMap<u64, Sender<Value>>>,
    next: AtomicU64,
}

/// Payload emitted to the renderer for a bridged MCP request (tools/list or tools/call).
#[derive(Clone, serde::Serialize)]
struct McpRequest {
    rid: u64,
    method: String,
    params: Value,
}

/// Start the HTTP MCP server if not already running; return its URL either way.
fn ensure_started(app: &AppHandle) -> Result<String, String> {
    let state = app.state::<McpState>();
    if let Some(p) = *state.port.lock().unwrap() {
        return Ok(format!("http://127.0.0.1:{p}/mcp"));
    }
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or("no bound port")?;
    *state.port.lock().unwrap() = Some(port);

    let handle = app.clone();
    std::thread::spawn(move || serve(server, handle));
    Ok(format!("http://127.0.0.1:{port}/mcp"))
}

/// Synchronous request loop (own thread). Claude POSTs serially — it waits for each reply —
/// so handling one request fully (including the bridge round-trip) before the next is correct.
fn serve(server: tiny_http::Server, app: AppHandle) {
    for mut req in server.incoming_requests() {
        // Claude opens a GET once to probe for an SSE stream; we don't offer one. 405 is fine.
        if *req.method() != tiny_http::Method::Post {
            let _ = req.respond(tiny_http::Response::empty(405));
            continue;
        }
        let mut body = String::new();
        let _ = req.as_reader().read_to_string(&mut body);
        let msg: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

        // Notifications carry no id and expect no JSON-RPC reply.
        if method == "notifications/initialized" || method == "initialized" {
            let _ = req.respond(tiny_http::Response::empty(202));
            continue;
        }

        let response = match method {
            "initialize" => {
                let pv = params
                    .get("protocolVersion")
                    .cloned()
                    .unwrap_or_else(|| json!("2025-06-18"));
                json!({ "jsonrpc": "2.0", "id": id, "result": {
                    "protocolVersion": pv,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "flowm", "version": "0.1" },
                } })
            }
            "tools/list" | "tools/call" => {
                json!({ "jsonrpc": "2.0", "id": id, "result": bridge(&app, method, params) })
            }
            _ => json!({ "jsonrpc": "2.0", "id": id, "error": {
                "code": -32601, "message": format!("method not found: {method}"),
            } }),
        };
        let _ = req.respond(json_response(&response));
    }
}

/// Hand a request to the renderer and block until it replies (or times out). The returned
/// Value is the JSON-RPC `result` (the renderer builds the MCP result shape: {tools} / {content}).
fn bridge(app: &AppHandle, method: &str, params: Value) -> Value {
    let state = app.state::<McpState>();
    let rid = state.next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = channel::<Value>();
    state.pending.lock().unwrap().insert(rid, tx);

    if app
        .emit(
            "flowm://mcp-request",
            McpRequest { rid, method: method.to_string(), params },
        )
        .is_err()
    {
        state.pending.lock().unwrap().remove(&rid);
        return error_content("FlowM renderer unreachable");
    }
    match rx.recv_timeout(Duration::from_secs(120)) {
        Ok(v) => v,
        Err(_) => {
            state.pending.lock().unwrap().remove(&rid);
            error_content("FlowM canvas did not respond")
        }
    }
}

fn error_content(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

fn json_response(v: &Value) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let data = serde_json::to_vec(v).unwrap_or_default();
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    tiny_http::Response::from_data(data).with_header(header)
}

/// Renderer-facing: ensure the server is up and return its URL (the engine puts it in --mcp-config).
#[tauri::command]
pub fn mcp_start(app: AppHandle) -> Result<String, String> {
    ensure_started(&app)
}

/// Renderer-facing: deliver the renderer's reply for a bridged request, unblocking the HTTP handler.
#[tauri::command]
pub fn mcp_respond(app: AppHandle, rid: u64, result: Value) {
    let state = app.state::<McpState>();
    // Drop the lock guard (a temporary) before the if-let body, so it can't outlive `state`.
    let tx = state.pending.lock().unwrap().remove(&rid);
    if let Some(tx) = tx {
        let _ = tx.send(result);
    }
}
