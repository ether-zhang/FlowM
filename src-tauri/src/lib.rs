//! FlowM desktop backend: supervises the packaged harness and owns native workspace I/O.

mod harness_process;

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

/// FlowM's own store dir: `~/.flowm` (created on demand). Holds the workspace index and each
/// project's canvases + conversations — FlowM state, kept OUT of the user's code folders (the
/// code folder only gets transient artifacts under its gitignored `.flowm` folder).
fn flowm_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let dir = home.join(".flowm");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn flowm_path(app: &AppHandle, rel: &str) -> Result<PathBuf, String> {
    let relative = Path::new(rel);
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Invalid FlowM store path".into());
    }
    Ok(flowm_dir(app)?.join(relative))
}

fn write_store_file(path: &Path, content: &str) -> Result<(), String> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_TEMPORARY: AtomicU64 = AtomicU64::new(1);
    let parent = path.parent().ok_or("Store path has no parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let temporary = parent.join(format!(
        ".flowm-{}-{nonce}-{}.tmp",
        std::process::id(),
        NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| error.to_string())
}

#[cfg(test)]
mod store_tests {
    use super::*;

    #[test]
    fn store_writes_replace_existing_files_and_clean_failed_temporary_files() {
        let directory = std::env::temp_dir().join(format!(
            "flowm-store-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        let file = directory.join("canvas.json");
        write_store_file(&file, "first").unwrap();
        write_store_file(&file, "second").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "second");
        let blocked = directory.join("blocked");
        fs::create_dir(&blocked).unwrap();
        assert!(write_store_file(&blocked, "replacement").is_err());
        assert!(blocked.is_dir());
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 2);
        fs::remove_file(&file).unwrap();
        fs::remove_dir(&blocked).unwrap();
        fs::remove_dir(&directory).unwrap();
    }
}

/// Read a file under `~/.flowm` (e.g. `workspace.json`, `<proj>/project.json`). Missing file →
/// `None` (a fresh workspace), not an error, so the caller can treat first-run as empty.
#[tauri::command]
fn flowm_read(app: AppHandle, rel: String) -> Result<Option<String>, String> {
    let path = flowm_path(&app, &rel)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Write a file under `~/.flowm`, creating parent dirs (so `<proj>/conv-<id>.json` just works).
#[tauri::command]
fn flowm_write(app: AppHandle, rel: String, content: String) -> Result<(), String> {
    let path = flowm_path(&app, &rel)?;
    write_store_file(&path, &content)
}

/// Delete a file under `~/.flowm` (a deleted session's bubbles / a deleted canvas's scene), so
/// deleting the meta entry doesn't strand its data file. Idempotent: a missing file is fine.
#[tauri::command]
fn flowm_delete(app: AppHandle, rel: String) -> Result<(), String> {
    let path = flowm_path(&app, &rel)?;
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitFile {
    path: String,
    status: String,
    index_status: String,
    worktree_status: String,
    is_untracked: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStatus {
    repo_root: String,
    branch: String,
    head: String,
    files: Vec<GitFile>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommit {
    hash: String,
    short_hash: String,
    subject: String,
    author: String,
    refs: Vec<String>,
}

const MAX_GIT_TEXT_BYTES: usize = 1_000_000;

fn git_output(cwd: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("spawn git failed: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git exited with {}", out.status.code().unwrap_or(-1))
        } else {
            stderr
        })
    }
}

fn git_string(cwd: &str, args: &[&str]) -> Result<String, String> {
    String::from_utf8(git_output(cwd, args)?).map_err(|e| e.to_string())
}

fn limited_git_text(bytes: Vec<u8>) -> String {
    if bytes.len() <= MAX_GIT_TEXT_BYTES {
        return String::from_utf8_lossy(&bytes).into_owned();
    }
    let mut s = String::from_utf8_lossy(&bytes[..MAX_GIT_TEXT_BYTES]).into_owned();
    s.push_str("\n\n[FlowM: diff truncated at 1 MB]");
    s
}

fn repo_root(cwd: &str) -> Result<String, String> {
    Ok(git_string(cwd, &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string())
}

fn safe_repo_rel_path(path: &str) -> Result<&str, String> {
    let p = Path::new(path);
    if p.is_absolute() {
        return Err("absolute git paths are not allowed".to_string());
    }
    for component in p.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err("git path escapes the repository".to_string()),
        }
    }
    Ok(path)
}

fn parse_git_status(bytes: &[u8]) -> Vec<GitFile> {
    let mut out = Vec::new();
    let mut chunks = bytes.split(|b| *b == 0).filter(|c| !c.is_empty());
    while let Some(raw) = chunks.next() {
        if raw.len() < 4 {
            continue;
        }
        let x = raw[0] as char;
        let y = raw[1] as char;
        let path = String::from_utf8_lossy(&raw[3..]).into_owned();
        if x == 'R' || x == 'C' {
            let _ = chunks.next();
        }
        out.push(GitFile {
            path,
            status: format!("{x}{y}"),
            index_status: x.to_string(),
            worktree_status: y.to_string(),
            is_untracked: x == '?' && y == '?',
        });
    }
    out
}

fn parse_git_commits(text: &str) -> Vec<GitCommit> {
    text.split('\x1e')
        .filter_map(|record| {
            let record = record.trim_matches('\n');
            if record.is_empty() {
                return None;
            }
            let mut fields = record.split('\x1f');
            let hash = fields.next()?.to_string();
            let short_hash = fields.next()?.to_string();
            let subject = fields.next().unwrap_or_default().to_string();
            let author = fields.next().unwrap_or_default().to_string();
            let refs = fields
                .next()
                .unwrap_or_default()
                .split(", ")
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned)
                .collect();
            Some(GitCommit {
                hash,
                short_hash,
                subject,
                author,
                refs,
            })
        })
        .collect()
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
fn git_status(cwd: String) -> Result<GitStatus, String> {
    let root = repo_root(&cwd)?;
    let branch = git_string(&root, &["branch", "--show-current"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let head = git_string(&root, &["rev-parse", "--short", "HEAD"])
        .unwrap_or_else(|_| "no HEAD".to_string())
        .trim()
        .to_string();
    let status = git_output(&root, &["status", "--porcelain=v1", "-z", "-uall"])?;
    Ok(GitStatus {
        repo_root: root,
        branch: if branch.is_empty() {
            "(detached)".to_string()
        } else {
            branch
        },
        head,
        files: parse_git_status(&status),
    })
}

#[tauri::command]
fn git_graph(cwd: String) -> Result<Vec<GitCommit>, String> {
    let root = repo_root(&cwd)?;
    let log = git_string(
        &root,
        &[
            "log",
            "--all",
            "--decorate=short",
            "--max-count=80",
            "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%D%x1e",
        ],
    )?;
    Ok(parse_git_commits(&log))
}

fn git_diff_part(root: &str, cached: bool, path: &str) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(root)
        .arg("diff")
        .arg("--no-ext-diff")
        .arg("--find-renames");
    if cached {
        cmd.arg("--cached");
    }
    let out = cmd
        .arg("--")
        .arg(path)
        .output()
        .map_err(|e| format!("spawn git failed: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn git_path_is_tracked(root: &str, path: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .arg("ls-files")
        .arg("--error-unmatch")
        .arg("--")
        .arg(path)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn untracked_file_diff(root: &str, path: &str) -> Result<String, String> {
    let full = Path::new(root).join(path);
    let meta = fs::metadata(&full).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Ok(String::new());
    }
    let bytes = fs::read(&full).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_GIT_TEXT_BYTES {
        return Ok(format!(
            "diff --git a/{0} b/{0}\nnew file mode 100644\n--- /dev/null\n+++ b/{0}\n\n[FlowM: new file is larger than 1 MB]",
            path
        ));
    }
    let text = String::from_utf8(bytes).map_err(|_| "binary file diff is not shown".to_string())?;
    let mut out = format!(
        "diff --git a/{0} b/{0}\nnew file mode 100644\n--- /dev/null\n+++ b/{0}\n@@ -0,0 +1,{1} @@\n",
        path,
        text.lines().count()
    );
    for line in text.lines() {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    Ok(out)
}

#[tauri::command]
fn git_diff(cwd: String, path: String) -> Result<String, String> {
    let root = repo_root(&cwd)?;
    let path_ref = safe_repo_rel_path(&path)?;
    let mut bytes = git_diff_part(&root, true, path_ref)?;
    let unstaged = git_diff_part(&root, false, path_ref)?;
    if !bytes.is_empty() && !unstaged.is_empty() {
        bytes.push(b'\n');
    }
    bytes.extend(unstaged);
    if bytes.is_empty() && !git_path_is_tracked(&root, path_ref) {
        return untracked_file_diff(&root, path_ref);
    }
    Ok(limited_git_text(bytes))
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |f| {
        let _ = tx.send(f);
    });
    rx.await.ok().flatten().map(|p| p.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(harness_process::HarnessProcesses::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            harness_process::start_flowm_harness,
            harness_process::write_flowm_harness,
            harness_process::stop_flowm_harness,
            flowm_read,
            flowm_write,
            flowm_delete,
            list_dir,
            git_status,
            git_graph,
            git_diff,
            pick_folder,
            read_file,
            write_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
