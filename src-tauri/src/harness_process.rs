//! A supervised, packaged runtime. No PATH lookup, executable preference, or CLI fallback.
use serde::Serialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, watch, Mutex},
};

const MAX_FRAME: usize = 16 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HarnessProcessEvent {
    Stdout { line: String },
    Stderr { line: String },
    Exit { code: Option<i32> },
}

struct Process {
    writes: mpsc::Sender<String>,
    stop: watch::Sender<bool>,
    done: watch::Receiver<bool>,
}
#[derive(Clone, Default)]
pub struct HarnessProcesses {
    processes: Arc<Mutex<HashMap<String, Process>>>,
}

fn runtime_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    #[cfg(debug_assertions)]
    {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("flowm-harness-{}{suffix}", env!("FLOWM_TARGET")));
        if development.is_file() {
            return Ok(development);
        }
    }
    let installed = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join(format!("flowm-harness{suffix}"));
    if installed.is_file() {
        return Ok(installed);
    }
    Err("FlowM's bundled harness is missing. Build the runtime with npm run harness:build, or reinstall the complete FlowM package.".into())
}

#[tauri::command]
pub async fn start_flowm_harness(
    app: AppHandle,
    on_event: Channel<HarnessProcessEvent>,
    processes: State<'_, HarnessProcesses>,
) -> Result<String, String> {
    let binary = runtime_binary(&app)?;
    let home = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("harness");
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let mut command = Command::new(binary);
    command
        .arg("--home")
        .arg(&home)
        .current_dir(&home)
        .env("FLOWM_HARNESS_HOME", &home)
        .env("CODEX_HOME", home.join("helpers"))
        .env_remove("CODEX_INTERNAL_ORIGINATOR_OVERRIDE")
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY")
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|e| format!("FlowM harness could not start: {e}"))?;
    let tree = ProcessTree::attach(&child)
        .map_err(|e| format!("Runtime process supervision could not be installed: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("Harness has no stdin")?;
    let stdout = child.stdout.take().ok_or("Harness has no stdout")?;
    let stderr = child.stderr.take().ok_or("Harness has no stderr")?;
    let id = format!(
        "flowm-harness-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    );
    let (write_tx, mut write_rx) = mpsc::channel::<String>(16);
    let (stop_tx, mut stop_rx) = watch::channel(false);
    let (done_tx, done_rx) = watch::channel(false);
    let (event_tx, mut event_rx) = mpsc::channel(64);
    let mut writer_stop = stop_rx.clone();
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = writer_stop.changed() => break,
                line = write_rx.recv() => {
                    let Some(line) = line else { break };
                    let written = tokio::time::timeout(Duration::from_secs(15), async {
                        stdin.write_all(line.as_bytes()).await?;
                        stdin.write_all(b"\n").await?;
                        stdin.flush().await
                    }).await;
                    if !matches!(written, Ok(Ok(()))) { break; }
                }
            }
        }
        let _ = stdin.shutdown().await;
    });
    let stdout_events = event_tx.clone();
    let stdout_stop = stop_tx.clone();
    let stdout_reader = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_line(&mut reader).await {
                Ok(Some(line)) => {
                    if stdout_events
                        .send(HarnessProcessEvent::Stdout { line })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(None) => break,
                Err(_) => {
                    let _ = stdout_stop.send(true);
                    break;
                }
            }
        }
    });
    let stderr_events = event_tx.clone();
    let stderr_reader = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        while let Ok(Some(line)) = read_line(&mut reader).await {
            if stderr_events
                .send(HarnessProcessEvent::Stderr { line })
                .await
                .is_err()
            {
                break;
            }
        }
    });
    let forward_stop = stop_tx.clone();
    let forward = tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            if on_event.send(event).is_err() {
                let _ = forward_stop.send(true);
                break;
            }
        }
    });
    let state = processes.inner().clone();
    state.processes.lock().await.insert(
        id.clone(),
        Process {
            writes: write_tx,
            stop: stop_tx.clone(),
            done: done_rx,
        },
    );
    let cleanup = id.clone();
    tokio::spawn(async move {
        let status = tokio::select! {
            result = child.wait() => result.ok(),
            _ = stop_rx.changed() => {
                // EOF asks the kernel to flush and stop its threads. Force the entire tree only
                // after a bounded graceful shutdown, or when a pipe/client has failed.
                let _ = stop_tx.send(true);
                let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
                match tokio::time::timeout(Duration::from_secs(8), child.wait()).await {
                    Ok(status) => status.ok(),
                    Err(_) => { tree.terminate(); let _ = child.kill().await; child.wait().await.ok() }
                }
            }
        };
        tree.terminate();
        let _ = stop_tx.send(true);
        for task in [stdout_reader, stderr_reader] {
            let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
        }
        let _ = event_tx
            .send(HarnessProcessEvent::Exit {
                code: status.and_then(|status| status.code()),
            })
            .await;
        drop(event_tx);
        let _ = tokio::time::timeout(Duration::from_secs(2), forward).await;
        state.processes.lock().await.remove(&cleanup);
        let _ = done_tx.send(true);
    });
    Ok(id)
}

#[tauri::command]
pub async fn write_flowm_harness(
    process_id: String,
    line: String,
    processes: State<'_, HarnessProcesses>,
) -> Result<(), String> {
    if line.len() > MAX_FRAME || line.contains('\n') {
        return Err("Invalid harness frame".into());
    }
    let sender = processes
        .processes
        .lock()
        .await
        .get(&process_id)
        .map(|process| process.writes.clone())
        .ok_or("Harness process is closed")?;
    tokio::time::timeout(Duration::from_secs(15), sender.send(line))
        .await
        .map_err(|_| "Harness input queue is full")?
        .map_err(|_| "Harness input is closed".into())
}

#[tauri::command]
pub async fn stop_flowm_harness(
    process_id: String,
    processes: State<'_, HarnessProcesses>,
) -> Result<(), String> {
    let stopped = {
        let state = processes.processes.lock().await;
        state.get(&process_id).map(|process| {
            let _ = process.stop.send(true);
            process.done.clone()
        })
    };
    if let Some(mut done) = stopped {
        if !*done.borrow() {
            tokio::time::timeout(Duration::from_secs(16), done.changed())
                .await
                .map_err(|_| "Harness process tree did not stop in time")?
                .map_err(|_| "Harness supervisor exited without acknowledgement")?;
        }
    }
    Ok(())
}

async fn read_line(reader: &mut (impl AsyncBufRead + Unpin)) -> std::io::Result<Option<String>> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(String::from_utf8_lossy(&line).into_owned()))
            };
        }
        let end = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|end| end + 1);
        let length = end.unwrap_or(buffer.len());
        if line.len() + length > MAX_FRAME {
            return Err(std::io::Error::other(
                "Harness output frame exceeded the limit",
            ));
        }
        line.extend_from_slice(&buffer[..length]);
        reader.consume(length);
        if end.is_some() {
            return Ok(Some(
                String::from_utf8_lossy(&line)
                    .trim_end_matches(['\r', '\n'])
                    .to_owned(),
            ));
        }
    }
}

#[cfg(windows)]
struct ProcessTree(std::os::windows::io::OwnedHandle);
#[cfg(windows)]
impl ProcessTree {
    fn attach(child: &Child) -> std::io::Result<Self> {
        use std::os::windows::io::FromRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let job = Self(std::os::windows::io::OwnedHandle::from_raw_handle(handle));
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(
                    handle,
                    child
                        .raw_handle()
                        .ok_or_else(|| std::io::Error::other("Harness has no process handle"))?,
                ) == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(job)
        }
    }
    fn terminate(&self) {
        use std::os::windows::io::AsRawHandle;
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0.as_raw_handle(), 1);
        }
    }
}

#[cfg(unix)]
struct ProcessTree(u32);
#[cfg(unix)]
impl ProcessTree {
    fn attach(child: &Child) -> std::io::Result<Self> {
        Ok(Self(child.id().ok_or_else(|| {
            std::io::Error::other("Harness has no PID")
        })?))
    }
    fn terminate(&self) {
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}
#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn output_framing_handles_utf8_and_eof() {
        let mut reader = BufReader::new("测试\nlast".as_bytes());
        assert_eq!(
            read_line(&mut reader).await.unwrap().as_deref(),
            Some("测试")
        );
        assert_eq!(
            read_line(&mut reader).await.unwrap().as_deref(),
            Some("last")
        );
        assert!(read_line(&mut reader).await.unwrap().is_none());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn closing_runtime_job_ends_descendant_processes() {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };
        let shell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let script = format!("Start-Sleep -Milliseconds 250; $flowmTestChild = Start-Process -FilePath '{}' -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -WindowStyle Hidden -PassThru; $flowmTestChild.Id; Start-Sleep -Seconds 60", shell.display());
        let mut child = Command::new(&shell)
            .args(["-NoProfile", "-Command", &script])
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let job = ProcessTree::attach(&child).unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let descendant: u32 = tokio::time::timeout(Duration::from_secs(10), read_line(&mut output))
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, descendant) };
        assert!(!handle.is_null());
        drop(job);
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap();
        let result = unsafe { WaitForSingleObject(handle, 5000) };
        unsafe {
            CloseHandle(handle);
        }
        assert_eq!(
            result, WAIT_OBJECT_0,
            "Descendant outlived the runtime's job"
        );
    }
}
