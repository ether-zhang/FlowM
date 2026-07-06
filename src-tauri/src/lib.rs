//! FlowM desktop backend.
//!
//! Keeps the API key out of the renderer: the key is stored in a file under
//! the app config dir, and the LLM HTTP call is made here in Rust (so the key
//! never enters JS, and native HTTP has no browser CORS restriction).

use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;

const DEFAULT_API_BASE_URL: &str = "https://api.poe.com/v1";

/// Path of the file holding the API key (created on demand).
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

fn chat_completions_url(base_url: Option<String>) -> String {
    let trimmed = base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_API_BASE_URL)
        .trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

/// Authenticated thin proxy: forward an OpenAI-format chat-completions body to
/// the configured API endpoint with the stored key, return JSON response verbatim.
#[tauri::command]
async fn poe_chat(
    app: AppHandle,
    body: serde_json::Value,
    base_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let key = read_key(&app)?;
    let url = chat_completions_url(base_url);
    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("API {}: {}", status, text));
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

/// One line of streamed output (or the exit) from a spawned `codex` process.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum CodexEvent {
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
    append_system_prompt: Option<String>,
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
    if let Some(system_prompt) = append_system_prompt
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        cmd.arg("--append-system-prompt").arg(system_prompt);
    }
    // Canvas session continuity: resume a prior session so history lives in Claude Code's session
    // and this turn's prompt is just the delta.
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

fn resolve_codex_bin(app: &AppHandle) -> String {
    let exe = if cfg!(windows) { "codex.exe" } else { "codex" };
    let home = app.path().home_dir().ok();

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(h) = &home {
        if cfg!(windows) {
            // Preferred native desktop-app install location.
            candidates.push(
                h.join("AppData")
                    .join("Local")
                    .join("Programs")
                    .join("OpenAI")
                    .join("Codex")
                    .join("bin")
                    .join(exe),
            );
            candidates.push(h.join("AppData").join("Roaming").join("npm").join(exe));
            if let Ok(entries) = fs::read_dir(h.join(".vscode").join("extensions")) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.starts_with("openai.chatgpt-") {
                        candidates.push(
                            entry
                                .path()
                                .join("bin")
                                .join("windows-x86_64")
                                .join(exe),
                        );
                    }
                }
            }
        } else {
            candidates.push(h.join(".local").join("bin").join(exe));
            candidates.push(h.join(".npm-global").join("bin").join(exe));
        }
    }
    if !cfg!(windows) {
        candidates.push(PathBuf::from("/opt/homebrew/bin").join(exe));
        candidates.push(PathBuf::from("/usr/local/bin").join(exe));
    }

    candidates
        .iter()
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| exe.to_string())
}

#[tauri::command]
fn default_codex_bin(app: AppHandle) -> String {
    resolve_codex_bin(&app)
}

fn codex_sandbox_mode(read_only: Option<bool>) -> &'static str {
    if cfg!(windows) {
        // Codex Agent mode on native Windows currently depends on a sandbox helper that may be
        // absent from the desktop/extension bundles. Use the CLI's explicit no-sandbox mode so
        // local project reads do not fail before the model can inspect files.
        return "danger-full-access";
    }
    if read_only.unwrap_or(false) {
        "read-only"
    } else {
        "workspace-write"
    }
}

fn is_codex_windows_sandbox_helper_failure(line: &str) -> bool {
    line.contains("orchestrator_helper_launch_failed")
        && line.contains("codex-windows-sandbox-setup.exe")
}

fn ensure_project_flowm_dir(cwd: &str) -> Result<PathBuf, String> {
    let dir = PathBuf::from(cwd).join(".flowm");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        fs::write(&ignore, "*\n").map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

fn unique_flowm_file(cwd: &str, stem: &str, ext: &str) -> Result<PathBuf, String> {
    let dir = ensure_project_flowm_dir(cwd)?;
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    Ok(dir.join(format!("{stem}-{n}.{ext}")))
}

/// Spawn the user's local `codex` CLI in non-interactive JSON mode and stream events back to the
/// renderer. When `output_schema` is provided, Codex receives it through --output-schema and the
/// command returns the final message file content after exit.
#[tauri::command]
async fn codex_run(
    bin: Option<String>,
    prompt: String,
    cwd: String,
    output_schema: Option<String>,
    resume: Option<String>,
    image: Option<String>,
    read_only: Option<bool>,
    on_event: Channel<CodexEvent>,
) -> Result<Option<String>, String> {
    let bin = bin.unwrap_or_else(|| "codex".to_string());
    let last_path = unique_flowm_file(&cwd, "codex-last", "txt")?;
    let schema_path = if let Some(schema) = &output_schema {
        let path = unique_flowm_file(&cwd, "codex-schema", "json")?;
        fs::write(&path, schema).map_err(|e| e.to_string())?;
        Some(path)
    } else {
        None
    };

    let mut cmd = TokioCommand::new(&bin);
    cmd.arg("--sandbox")
        .arg(codex_sandbox_mode(read_only))
        .arg("--ask-for-approval")
        .arg("never")
        .arg("--cd")
        .arg(&cwd)
        .arg("exec");

    if resume.is_some() {
        cmd.arg("resume");
    }
    cmd.arg("--json")
        .arg("--output-last-message")
        .arg(&last_path);
    if let Some(path) = &schema_path {
        cmd.arg("--output-schema").arg(path);
    }
    if let Some(img) = &image {
        cmd.arg("--image").arg(img);
    }
    if let Some(session) = &resume {
        cmd.arg(session);
    }
    cmd.arg("-");

    let mut child = cmd
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!("spawn `{bin}` failed: {e} — is Codex CLI installed and on PATH? Set the full path to codex.exe in FlowM settings")
        })?;

    if let Some(mut stdin) = child.stdin.take() {
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(prompt.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });
    }

    let stdout = child.stdout.take().ok_or("no stdout pipe")?;
    let stderr = child.stderr.take().ok_or("no stderr pipe")?;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<CodexEvent>();
    let tx_err = tx.clone();
    let h_out = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx.send(CodexEvent::Stdout { line }).is_err() {
                break;
            }
        }
    });
    let h_err = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx_err.send(CodexEvent::Stderr { line }).is_err() {
                break;
            }
        }
    });

    let mut fatal_sandbox_error: Option<String> = None;
    while let Some(ev) = rx.recv().await {
        if let CodexEvent::Stderr { line } = &ev {
            if is_codex_windows_sandbox_helper_failure(line) {
                fatal_sandbox_error = Some(
                    "Codex Windows sandbox helper is missing. FlowM stopped this run; use the native Codex app path or rerun after updating Codex/WSL."
                        .to_string(),
                );
            }
        }
        let _ = on_event.send(ev);
        if fatal_sandbox_error.is_some() {
            break;
        }
    }
    if fatal_sandbox_error.is_some() {
        let _ = child.start_kill();
    }
    let _ = h_out.await;
    let _ = h_err.await;
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = on_event.send(CodexEvent::Exit { code: status.code() });

    let _ = schema_path.as_ref().map(fs::remove_file);
    if let Some(msg) = fatal_sandbox_error {
        let _ = fs::remove_file(&last_path);
        return Err(msg);
    }
    let last = match fs::read_to_string(&last_path) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let _ = fs::remove_file(&last_path);
    if !status.success() {
        return Err(format!("Codex exited with {}", status.code().unwrap_or(-1)));
    }
    Ok(last)
}

#[tauri::command]
fn write_codex_canvas_guide(cwd: String, content: String) -> Result<String, String> {
    write_project_flowm_text(&cwd, "codex-canvas.md", &content)
}

#[tauri::command]
fn write_claude_canvas_guide(cwd: String, content: String) -> Result<String, String> {
    write_project_flowm_text(&cwd, "claude-canvas.md", &content)
}

fn write_project_flowm_text(cwd: &str, filename: &str, content: &str) -> Result<String, String> {
    let dir = ensure_project_flowm_dir(cwd)?;
    fs::write(dir.join(filename), content).map_err(|e| e.to_string())?;
    Ok(format!(".flowm/{filename}"))
}

/// FlowM's own store dir: `~/.flowm` (created on demand). Holds the workspace index and each
/// project's canvases + conversations — FlowM state, kept OUT of the user's code folders (the
/// code folder only gets transient artifacts under its gitignored `.flowm` folder).
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

/// Delete a file under `~/.flowm` (a deleted session's bubbles / a deleted canvas's scene), so
/// deleting the meta entry doesn't strand its data file. Idempotent: a missing file is fine.
#[tauri::command]
fn flowm_delete(app: AppHandle, rel: String) -> Result<(), String> {
    let path = flowm_dir(&app)?.join(&rel);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
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

/// Read a file's UTF-8 text for the floating editor. Guarded at 2 MB — big/binary files aren't
/// meant for the pop-up editor (they'd be non-text anyway), so refuse rather than hang the UI.
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 2_000_000 {
        return Err("文件过大（>2MB），暂不在悬浮编辑器中打开".to_string());
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Write edited text back to a file (the floating editor's Save). Overwrites in place.
#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
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
    let dir = ensure_project_flowm_dir(&cwd)?;
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
            codex_run,
            default_codex_bin,
            write_codex_canvas_guide,
            write_claude_canvas_guide,
            write_design,
            flowm_read,
            flowm_write,
            flowm_delete,
            list_dir,
            pick_folder,
            read_file,
            write_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
