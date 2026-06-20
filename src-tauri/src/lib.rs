//! FlowM desktop backend.
//!
//! Keeps the Poe API key out of the renderer: the key is stored in a file under
//! the app config dir, and the LLM HTTP call is made here in Rust (so the key
//! never enters JS, and native HTTP has no browser CORS restriction).

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            set_api_key,
            has_api_key,
            clear_api_key,
            poe_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
