//! FlowM desktop backend.
//!
//! Keeps the Poe API key out of the renderer: the key is stored in a file under
//! the app config dir, and the LLM HTTP call is made here in Rust (so the key
//! never enters JS, and native HTTP has no browser CORS restriction).

use std::fs;
use std::path::PathBuf;
use std::process::Stdio;

use base64::Engine as _;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;

const POE_URL: &str = "https://api.poe.com/v1/chat/completions";

/// Path of the file holding the Poe API key (created on demand).
fn key_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("poe_key.txt"))
}

fn read_key(app: &AppHandle) -> Result<String, String> {
    let key = fs::read_to_string(key_path(app)?)
        .map_err(|_| "no api key".to_string())?
        .trim()
        .to_string();
    if key.is_empty() {
        return Err("no api key".to_string());
    }
    Ok(key)
}

#[tauri::command]
fn set_api_key(app: AppHandle, key: String) -> Result<(), String> {
    fs::write(key_path(&app)?, key.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
fn has_api_key(app: AppHandle) -> bool {
    read_key(&app).is_ok()
}

#[tauri::command]
fn clear_api_key(app: AppHandle) -> Result<(), String> {
    let path = key_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Authenticated thin proxy: forward an OpenAI-format chat-completions body to
/// Poe with the stored key, return Poe's JSON response verbatim.
#[tauri::command]
async fn poe_chat(app: AppHandle, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let key = read_key(&app)?;
    let client = reqwest::Client::new();
    let res = client
        .post(POE_URL)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Poe {}: {}", status, text));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// One line of streamed output (or the exit) from a spawned `claude` process.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ClaudeEvent {
    Stdout { line: String },
    Stderr { line: String },
    Exit { code: Option<i32> },
}

/// Spawn the user's local `claude` CLI in headless stream-json mode and stream
/// every stdout/stderr line back to the renderer over `on_event`. Auth is whatever
/// `claude auth login` set (subscription or console) — FlowM passes NO key and reads
/// no credentials; it just runs the user's own Claude Code. `bin` overrides the
/// executable (Windows npm installs may be `claude.cmd`; pass a full path then).
#[tauri::command]
async fn claude_run(
    bin: Option<String>,
    prompt: String,
    cwd: String,
    json_schema: Option<String>,
    resume: Option<String>,
    disallowed_tools: Option<Vec<String>>,
    on_event: Channel<ClaudeEvent>,
) -> Result<(), String> {
    let bin = bin.unwrap_or_else(|| "claude".to_string());
    let mut cmd = TokioCommand::new(&bin);
    // The prompt goes via STDIN, NOT a CLI arg: a canvas turn's serialized conversation grows
    // with every applied op and quickly overflows Windows' command-line length limit
    // (os error 206, "文件名或扩展名太长"). stdin has no such limit.
    cmd.arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--permission-mode")
        .arg("bypassPermissions");
    // Force a validated structured result (the canvas operations). arg() escapes the JSON,
    // so the embedded quotes survive (unlike a shell).
    if let Some(schema) = &json_schema {
        cmd.arg("--json-schema").arg(schema);
    }
    // Canvas session continuity: resume a prior session so the project guide (CLAUDE.local.md)
    // + history live in Claude Code's session (cached) and this turn's prompt is just the delta.
    if let Some(session) = &resume {
        cmd.arg("--resume").arg(session);
    }
    // Forbid specific tools (--disallowedTools is variadic). The canvas engine forbids `Task`
    // so Claude reads code directly rather than spawning a subagent.
    if let Some(tools) = &disallowed_tools {
        if !tools.is_empty() {
            cmd.arg("--disallowedTools");
            for t in tools {
                cmd.arg(t);
            }
        }
    }
    let mut child = cmd
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!("spawn `{bin}` failed: {e} — is Claude Code installed and on PATH? On Windows pass the full path to claude.exe")
        })?;

    // Write the prompt to stdin and close it (EOF, so claude starts processing). In a task so a
    // large prompt can't deadlock against the pipe buffer while we drain stdout below.
    if let Some(mut stdin) = child.stdin.take() {
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(prompt.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });
    }

    let stdout = child.stdout.take().ok_or("no stdout pipe")?;
    let stderr = child.stderr.take().ok_or("no stderr pipe")?;

    // Drain both pipes concurrently into one mpsc, forward to the channel; avoids a
    // pipe-buffer deadlock and doesn't assume Channel: Clone.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ClaudeEvent>();
    let tx_err = tx.clone();
    let h_out = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx.send(ClaudeEvent::Stdout { line }).is_err() {
                break;
            }
        }
    });
    let h_err = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx_err.send(ClaudeEvent::Stderr { line }).is_err() {
                break;
            }
        }
    });

    while let Some(ev) = rx.recv().await {
        let _ = on_event.send(ev);
    }
    let _ = h_out.await;
    let _ = h_err.await;
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = on_event.send(ClaudeEvent::Exit { code: status.code() });
    Ok(())
}

/// The conventional `claude` path to prefill the editable binary-path field with. A GUI app
/// launched from Finder/Dock inherits only a minimal PATH (not the shell's), so a stored absolute
/// path is what makes spawning `claude` work there. Returns the first common install location that
/// exists, else the canonical native-installer path (`~/.local/bin/claude[.exe]`) for the OS.
fn resolve_claude_bin(app: &AppHandle) -> String {
    let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
    let home = app.path().home_dir().ok();

    // Canonical native-installer location (claude.ai/install) — also the fallback prefill.
    let canonical = home.as_ref().map(|h| h.join(".local").join("bin").join(exe));

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(c) = &canonical {
        candidates.push(c.clone());
    }
    if !cfg!(windows) {
        // Homebrew (Apple Silicon / Intel) and npm-global default prefixes on macOS & Linux.
        candidates.push(PathBuf::from("/opt/homebrew/bin").join(exe));
        candidates.push(PathBuf::from("/usr/local/bin").join(exe));
        if let Some(h) = &home {
            candidates.push(h.join(".npm-global").join("bin").join(exe));
        }
    }

    candidates
        .iter()
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
        .or_else(|| canonical.map(|c| c.to_string_lossy().into_owned()))
        .unwrap_or_else(|| exe.to_string())
}

/// Expose the prefill path to the renderer (the binary-path field's default; the user can edit it).
#[tauri::command]
fn default_claude_bin(app: AppHandle) -> String {
    resolve_claude_bin(&app)
}

/// Write FlowM's drawing guide to `<cwd>/CLAUDE.local.md` — the project "switch" Claude Code
/// auto-loads on every invocation (and prompt-caches across --resume). FlowM owns this file;
/// CLAUDE.local.md is conventionally gitignored, so it doesn't pollute the user's tracked repo.
#[tauri::command]
fn write_guide(cwd: String, content: String) -> Result<(), String> {
    let path = PathBuf::from(&cwd).join("CLAUDE.local.md");
    fs::write(path, content).map_err(|e| e.to_string())
}

/// FlowM's own store dir: `~/.flowm` (created on demand). Holds the workspace index and each
/// project's canvases + conversations — FlowM state, kept OUT of the user's code folders (the
/// code folder only gets the gitignored CLAUDE.local.md the canvas engine writes).
fn flowm_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let dir = home.join(".flowm");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Read a file under `~/.flowm` (e.g. `workspace.json`, `<proj>/project.json`). Missing file →
/// `None` (a fresh workspace), not an error, so the caller can treat first-run as empty.
#[tauri::command]
fn flowm_read(app: AppHandle, rel: String) -> Result<Option<String>, String> {
    let path = flowm_dir(&app)?.join(&rel);
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Write a file under `~/.flowm`, creating parent dirs (so `<proj>/conv-<id>.json` just works).
#[tauri::command]
fn flowm_write(app: AppHandle, rel: String, content: String) -> Result<(), String> {
    let path = flowm_dir(&app)?.join(&rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// One entry in a directory listing for the right-hand file panel.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/// List a directory's immediate children (dirs first, then case-insensitive by name) for the file
/// panel. Lazy per-dir: the panel calls this again to expand a subfolder, so no deep recursion.
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut out: Vec<DirEntry> = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Native folder picker for "选择文件夹" (choosing a project's code folder). The dialog plugin runs
/// it on the OS main thread; we bridge its callback to a oneshot so the command can be `async`.
/// Returns the chosen absolute path, or `None` if the user cancelled.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |f| {
        let _ = tx.send(f);
    });
    rx.await.ok().flatten().map(|p| p.to_string())
}

/// Write the canvas PNG (a `data:image/png;base64,…` URL) to `<cwd>/.flowm/design.png`
/// so the spawned `claude` can Read it as the visual design. Returns the relative path.
#[tauri::command]
fn write_design(cwd: String, data_url: String) -> Result<String, String> {
    let b64 = data_url.rsplit(',').next().unwrap_or(&data_url).trim();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| e.to_string())?;
    let dir = PathBuf::from(&cwd).join(".flowm");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("design.png"), bytes).map_err(|e| e.to_string())?;
    Ok(".flowm/design.png".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            set_api_key,
            has_api_key,
            clear_api_key,
            poe_chat,
            claude_run,
            default_claude_bin,
            write_guide,
            write_design,
            flowm_read,
            flowm_write,
            list_dir,
            pick_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
