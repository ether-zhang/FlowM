use crate::{
    auth::AuthService,
    kernel::{OpenThread, Registry, StartTurn},
    models::ModelDirectory,
    state::{
        AuthKind, PROTOCOL_VERSION, Profile, Receipt, Store, UPSTREAM_REVISION, now, payload_hash,
    },
};
use anyhow::{Context, Result, bail};
use codex_core_api::Arg0DispatchPaths;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex, Semaphore, mpsc},
};

const MAX_FRAME: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
struct Request {
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

struct Service {
    store: Arc<Store>,
    auth: Arc<AuthService>,
    models: Arc<ModelDirectory>,
    registry: Registry,
    settings: Mutex<()>,
}

impl Service {
    async fn dispatch(&self, method: &str, params: Value) -> Result<Value> {
        match method {
            "initialize" => {
                if params["protocolVersion"].as_str() != Some(PROTOCOL_VERSION) {
                    bail!("Incompatible FlowM harness protocol");
                }
                Ok(
                    json!({"protocolVersion":PROTOCOL_VERSION,"harnessVersion":env!("CARGO_PKG_VERSION"),"upstreamRevision":UPSTREAM_REVISION,"roles":["canvas","project"]}),
                )
            }
            "profiles/list" => {
                let profiles: Vec<Profile> = self
                    .store
                    .data
                    .lock()
                    .await
                    .profiles
                    .values()
                    .cloned()
                    .collect();
                let mut result = Vec::new();
                for profile in profiles {
                    let signed_in = profile.auth_kind == AuthKind::None
                        || self.auth.has_credential(&profile.id).await;
                    let mut value = serde_json::to_value(profile)?;
                    value["signedIn"] = json!(signed_in);
                    result.push(value);
                }
                Ok(json!(result))
            }
            "profiles/save" => {
                let _guard = self.settings.lock().await;
                let mut profile: Profile = serde_json::from_value(params["profile"].clone())
                    .context("Invalid provider profile")?;
                profile.validate()?;
                let previous = self.store.profile(&profile.id).await.ok();
                if let Some(previous) = previous {
                    self.registry.close_profile(&profile.id).await?;
                    if previous.kind != profile.kind
                        || previous.base_url != profile.base_url
                        || previous.auth_kind != profile.auth_kind
                    {
                        self.auth.logout(&profile.id).await?;
                        profile.account = None;
                        profile.subject = None;
                        profile.client_id = None;
                    } else {
                        profile.account = previous.account;
                        profile.subject = previous.subject;
                        profile.client_id = previous.client_id;
                    }
                    profile.credential_version = previous.credential_version + 1;
                } else {
                    profile.credential_version = 1;
                    profile.account = None;
                    profile.subject = None;
                    profile.client_id = None;
                }
                if let Some(token) = params["token"].as_str().filter(|token| !token.is_empty()) {
                    if profile.auth_kind != AuthKind::Bearer {
                        bail!("This profile does not use a bearer token");
                    }
                    self.auth.set_bearer(&profile.id, token.to_owned()).await?;
                }
                self.store
                    .data
                    .lock()
                    .await
                    .profiles
                    .insert(profile.id.clone(), profile.clone());
                self.store.save().await?;
                Ok(serde_json::to_value(profile)?)
            }
            "auth/start" => {
                self.auth
                    .start_login(required_string(&params, "profileId")?)
                    .await
            }
            "auth/cancel" => {
                self.auth
                    .cancel_login(&required_string(&params, "attemptId")?)
                    .await;
                Ok(json!({}))
            }
            "auth/logout" => {
                let _guard = self.settings.lock().await;
                let id = required_string(&params, "profileId")?;
                self.registry.close_profile(&id).await?;
                self.auth.logout(&id).await?;
                Ok(json!({}))
            }
            "models/list" => Ok(serde_json::to_value(
                self.models
                    .list(&required_string(&params, "profileId")?)
                    .await?,
            )?),
            "thread/open" => {
                self.registry
                    .open(serde_json::from_value::<OpenThread>(params)?)
                    .await
            }
            "thread/close" => {
                self.registry
                    .close(&required_string(&params, "threadId")?)
                    .await?;
                Ok(json!({}))
            }
            "turn/start" => self.start_turn(params).await,
            "turn/status" => {
                let id = required_string(&params, "requestId")?;
                Ok(self
                    .store
                    .receipt(&id)
                    .await?
                    .map(serde_json::to_value)
                    .transpose()?
                    .unwrap_or_else(|| json!({"status":"not-received"})))
            }
            "turn/cancel" => {
                self.registry
                    .cancel(&required_string(&params, "threadId")?)
                    .await?;
                Ok(json!({}))
            }
            "interaction/answer" => {
                self.registry
                    .answer(
                        &required_string(&params, "threadId")?,
                        &required_string(&params, "requestId")?,
                        serde_json::from_value::<HashMap<String, Vec<String>>>(
                            params["answers"].clone(),
                        )?,
                    )
                    .await?;
                Ok(json!({}))
            }
            _ => bail!("Unknown FlowM harness method: {method}"),
        }
    }

    async fn start_turn(&self, params: Value) -> Result<Value> {
        let request: StartTurn = serde_json::from_value(params.clone())?;
        if request.prompt.is_empty() || request.prompt.len() > 1024 * 1024 {
            bail!("Prompt is empty or exceeds the bounded input limit");
        }
        let live = self.registry.live(&request.thread_id).await?;
        let _guard = live
            .run
            .try_lock()
            .context("This thread already has an active request")?;
        let hash = payload_hash(&params);
        if let Some(receipt) = self.store.receipt(&request.request_id).await? {
            if receipt.thread_id != request.thread_id || receipt.payload_hash != hash {
                bail!("Request ID was already used for different input");
            }
            if receipt.status == "completed" {
                return Ok(serde_json::to_value(receipt)?);
            }
            bail!(
                "Existing request is {}; it was not replayed. {}",
                receipt.status,
                receipt
                    .error
                    .as_deref()
                    .unwrap_or("Check its request status before continuing")
            );
        }
        if let Some(id) = self
            .store
            .data
            .lock()
            .await
            .bindings
            .get(&request.thread_id)
            .and_then(|binding| binding.blocked_request_id.clone())
        {
            bail!(
                "Request {id} in this thread was interrupted. Inspect its effects and create a new FlowM conversation to continue; no task was replayed"
            );
        }
        live.cancelled
            .store(false, std::sync::atomic::Ordering::Release);
        let mut receipt = Receipt {
            request_id: request.request_id.clone(),
            thread_id: request.thread_id.clone(),
            payload_hash: hash,
            status: "accepted".into(),
            native_turn_id: None,
            text: None,
            error: None,
            updated_at: now(),
        };
        self.store.write_receipt(&receipt).await?;
        let result = self.registry.run(&live, &request).await;
        if let Some(current) = self.store.receipt(&request.request_id).await? {
            receipt.native_turn_id = current.native_turn_id;
        }
        receipt.updated_at = now();
        match result {
            Ok((native_turn, text)) => {
                receipt.native_turn_id = Some(native_turn);
                receipt.text = Some(text);
                receipt.status = "completed".into();
            }
            Err(error) => {
                receipt.status = if receipt.native_turn_id.is_some() {
                    "interrupted"
                } else {
                    "failed"
                }
                .into();
                receipt.error = Some(error.to_string());
            }
        }
        self.store.write_receipt(&receipt).await?;
        if let Some(error) = &receipt.error {
            if receipt.native_turn_id.is_some()
                || live.cancelled.load(std::sync::atomic::Ordering::Acquire)
            {
                if let Some(binding) = self
                    .store
                    .data
                    .lock()
                    .await
                    .bindings
                    .get_mut(&request.thread_id)
                {
                    binding.blocked_request_id = Some(request.request_id.clone());
                }
                self.store.save().await?;
            }
            bail!("{error}");
        }
        Ok(serde_json::to_value(receipt)?)
    }
}

pub async fn serve(home: PathBuf, paths: Arg0DispatchPaths) -> Result<()> {
    let store = Arc::new(Store::open(home).await?);
    store.recover_receipts().await?;
    let (output, mut frames) = mpsc::channel::<Value>(64);
    let auth = AuthService::new(store.clone(), output.clone())?;
    let models = ModelDirectory::new(store.clone(), auth.clone());
    let service = Arc::new(Service {
        registry: Registry::new(
            store.clone(),
            auth.clone(),
            models.clone(),
            paths,
            output.clone(),
        ),
        store,
        auth,
        models,
        settings: Mutex::new(()),
    });
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(mut frame) = frames.recv().await {
            frame["jsonrpc"] = json!("2.0");
            let mut bytes = serde_json::to_vec(&frame)?;
            bytes.push(b'\n');
            stdout.write_all(&bytes).await?;
            stdout.flush().await?;
        }
        Ok::<_, anyhow::Error>(())
    });
    let mut input = BufReader::new(tokio::io::stdin());
    let limit = Arc::new(Semaphore::new(32));
    let mut requests = tokio::task::JoinSet::new();
    loop {
        let frame = match read_frame(&mut input).await? {
            Some(frame) => frame,
            None => break,
        };
        let request = match serde_json::from_slice::<Request>(&frame) {
            Ok(request) => request,
            Err(_) => {
                output.send(json!({"id":null,"error":{"code":-32700,"message":"Invalid or oversized harness request"}})).await?;
                continue;
            }
        };
        let permit = match limit.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                output.send(json!({"id":request.id,"error":{"code":-32001,"message":"Too many concurrent harness requests"}})).await?;
                continue;
            }
        };
        let service = service.clone();
        let output = output.clone();
        requests.spawn(async move {
            let _permit = permit;
            let result = service.dispatch(&request.method, request.params).await;
            let response = match result {
                Ok(result) => json!({"id":request.id,"result":result}),
                Err(error) => {
                    json!({"id":request.id,"error":{"code":-32000,"message":error.to_string()}})
                }
            };
            let _ = output.send(response).await;
        });
        while requests.try_join_next().is_some() {}
    }
    service.registry.shutdown().await;
    requests.abort_all();
    while requests.join_next().await.is_some() {}
    drop(service);
    drop(output);
    writer.await??;
    Ok(())
}

fn required_string(params: &Value, key: &str) -> Result<String> {
    params[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .with_context(|| format!("Missing {key}"))
}

async fn read_frame(input: &mut (impl AsyncBufRead + Unpin)) -> Result<Option<Vec<u8>>> {
    let mut frame = Vec::new();
    loop {
        let buffer = input.fill_buf().await?;
        if buffer.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                bail!("Incomplete harness frame")
            };
        }
        let end = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|end| end + 1);
        let length = end.unwrap_or(buffer.len());
        if frame.len() + length > MAX_FRAME {
            bail!("Harness frame exceeded the 16 MiB limit");
        }
        frame.extend_from_slice(&buffer[..length]);
        input.consume(length);
        if end.is_some() {
            return Ok(Some(frame));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn framing_requires_newline_and_keeps_requests_separate() {
        let mut reader = BufReader::new(&b"{\"id\":1}\n{\"id\":2}\n"[..]);
        assert_eq!(
            read_frame(&mut reader).await.unwrap().unwrap(),
            b"{\"id\":1}\n"
        );
        assert_eq!(
            read_frame(&mut reader).await.unwrap().unwrap(),
            b"{\"id\":2}\n"
        );
        assert!(read_frame(&mut reader).await.unwrap().is_none());
        assert!(
            read_frame(&mut BufReader::new(&b"partial"[..]))
                .await
                .is_err()
        );
    }
}
