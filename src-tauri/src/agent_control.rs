use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentControlEvent {
    Stdout { line: String },
    Stderr { line: String },
    Exit { code: Option<i32> },
}

enum ProcessCommand {
    Write(String),
    Stop,
}

#[derive(Clone, Default)]
pub struct AgentControlProcesses {
    processes: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<ProcessCommand>>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerStart {
    process_id: String,
    sandbox_mode: String,
}

fn process_id(prefix: &str) -> Result<String, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    Ok(format!("{prefix}-{nanos}"))
}

async fn spawn_control_process(
    mut command: Command,
    prefix: &str,
    processes: AgentControlProcesses,
    on_event: Channel<AgentControlEvent>,
) -> Result<String, String> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start agent control process: {e}"))?;

    let mut stdin = child.stdin.take().ok_or("agent process has no stdin")?;
    let stdout = child.stdout.take().ok_or("agent process has no stdout")?;
    let stderr = child.stderr.take().ok_or("agent process has no stderr")?;
    let id = process_id(prefix)?;
    let (command_tx, mut command_rx) = mpsc::unbounded_channel();
    processes
        .processes
        .lock()
        .await
        .insert(id.clone(), command_tx);

    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let stdout_tx = event_tx.clone();
    let stderr_tx = event_tx.clone();

    tokio::spawn(async move {
        while let Some(command) = command_rx.recv().await {
            match command {
                ProcessCommand::Write(mut line) => {
                    if !line.ends_with('\n') {
                        line.push('\n');
                    }
                    if stdin.write_all(line.as_bytes()).await.is_err()
                        || stdin.flush().await.is_err()
                    {
                        break;
                    }
                }
                ProcessCommand::Stop => break,
            }
        }
        let _ = stdin.shutdown().await;
    });

    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if stdout_tx.send(AgentControlEvent::Stdout { line }).is_err() {
                break;
            }
        }
    });
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if stderr_tx.send(AgentControlEvent::Stderr { line }).is_err() {
                break;
            }
        }
    });
    let forward_task = tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            let _ = on_event.send(event);
        }
    });

    let cleanup_id = id.clone();
    tokio::spawn(async move {
        let status = child.wait().await.ok();
        let _ = stdout_task.await;
        let _ = stderr_task.await;
        let _ = event_tx.send(AgentControlEvent::Exit {
            code: status.and_then(|s| s.code()),
        });
        drop(event_tx);
        let _ = forward_task.await;
        processes.processes.lock().await.remove(&cleanup_id);
    });

    Ok(id)
}

#[tauri::command]
pub async fn start_codex_app_server(
    bin: Option<String>,
    cwd: String,
    read_only: Option<bool>,
    on_event: Channel<AgentControlEvent>,
    processes: State<'_, AgentControlProcesses>,
) -> Result<CodexAppServerStart, String> {
    let mut command = Command::new(bin.unwrap_or_else(|| "codex".to_string()));
    command.arg("app-server").arg("--stdio").current_dir(cwd);
    let process_id =
        spawn_control_process(command, "codex", processes.inner().clone(), on_event).await?;
    Ok(CodexAppServerStart {
        process_id,
        sandbox_mode: super::codex_sandbox_mode(read_only).to_string(),
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_claude_control(
    bin: Option<String>,
    cwd: String,
    json_schema: Option<String>,
    resume: Option<String>,
    disallowed_tools: Option<Vec<String>>,
    append_system_prompt: Option<String>,
    on_event: Channel<AgentControlEvent>,
    processes: State<'_, AgentControlProcesses>,
) -> Result<String, String> {
    let mut command = Command::new(bin.unwrap_or_else(|| "claude".to_string()));
    command
        .arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--permission-mode")
        .arg("manual")
        .arg("--input-format")
        .arg("stream-json")
        .env_remove("CLAUDECODE")
        .env("CLAUDE_CODE_ENTRYPOINT", "sdk-ts")
        .current_dir(cwd);
    if let Some(schema) = json_schema.filter(|s| !s.trim().is_empty()) {
        command.arg("--json-schema").arg(schema);
    }
    if let Some(session) = resume.filter(|s| !s.trim().is_empty()) {
        command.arg("--resume").arg(session);
    }
    if let Some(prompt) = append_system_prompt.filter(|s| !s.trim().is_empty()) {
        command.arg("--append-system-prompt").arg(prompt);
    }
    if let Some(tools) = disallowed_tools.filter(|tools| !tools.is_empty()) {
        command.arg("--disallowedTools").arg(tools.join(","));
    }
    spawn_control_process(command, "claude", processes.inner().clone(), on_event).await
}

#[tauri::command]
pub async fn write_agent_control(
    process_id: String,
    line: String,
    processes: State<'_, AgentControlProcesses>,
) -> Result<(), String> {
    let sender = processes
        .processes
        .lock()
        .await
        .get(&process_id)
        .cloned()
        .ok_or_else(|| format!("agent control process not found: {process_id}"))?;
    sender
        .send(ProcessCommand::Write(line))
        .map_err(|_| "agent control process is closed".to_string())
}

#[tauri::command]
pub async fn stop_agent_control(
    process_id: String,
    processes: State<'_, AgentControlProcesses>,
) -> Result<(), String> {
    if let Some(sender) = processes.processes.lock().await.remove(&process_id) {
        let _ = sender.send(ProcessCommand::Stop);
    }
    Ok(())
}
