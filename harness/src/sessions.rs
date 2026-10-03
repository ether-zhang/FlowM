//! Durable, provider-neutral conversations. Kernel rollouts are execution segments, not identities.
use crate::state::{Role, atomic_json, now, payload_hash};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::{Mutex, mpsc};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub name: String,
    pub project_root: PathBuf,
    pub created_at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub sequence: u64,
    pub id: String,
    pub turn_id: Option<String>,
    pub kind: String,
    pub data: Value,
    pub timestamp: u64,
}

#[derive(Clone)]
struct Conversation {
    meta: SessionMeta,
    events: Vec<SessionEvent>,
    deleted: bool,
    importing: bool,
}

impl Conversation {
    fn active(&self) -> Option<&SessionEvent> {
        self.events
            .iter()
            .rev()
            .find(|event| matches!(event.kind.as_str(), "turn_begin" | "turn_end"))
            .filter(|event| event.kind == "turn_begin")
    }
    fn revision(&self) -> u64 {
        self.events
            .iter()
            .rev()
            .find(|event| matches!(event.kind.as_str(), "model_result" | "legacy_context"))
            .map_or(0, |event| event.sequence)
    }
}

pub struct Sessions {
    directory: PathBuf,
    conversations: Mutex<BTreeMap<String, Conversation>>,
    output: mpsc::Sender<Value>,
}

impl Sessions {
    pub async fn open(home: &Path, output: mpsc::Sender<Value>) -> Result<Arc<Self>> {
        let directory = home.join("sessions");
        tokio::fs::create_dir_all(&directory).await?;
        let mut conversations = BTreeMap::new();
        let mut files = tokio::fs::read_dir(&directory).await?;
        while let Some(file) = files.next_entry().await? {
            if file.path().extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let path = file.path();
            let bytes = tokio::fs::read(&path).await?;
            // Only an incomplete final append may be discarded. Corrupt committed rows fail closed.
            let committed = bytes
                .iter()
                .rposition(|byte| *byte == b'\n')
                .map_or(0, |i| i + 1);
            if committed == 0 {
                // A first identity append never acknowledged to a caller may itself be torn.
                // Preserve its fragment separately without blocking other valid conversations.
                tokio::fs::rename(
                    &path,
                    path.with_extension(format!("{}.uncommitted", Uuid::new_v4())),
                )
                .await?;
                continue;
            }
            let mut events = Vec::new();
            for line in bytes[..committed]
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
            {
                let event: SessionEvent = serde_json::from_slice(line).context(
                    "Invalid committed conversation journal; existing data was preserved",
                )?;
                if event.sequence != events.len() as u64 + 1 {
                    bail!("Conversation journal has a sequence gap");
                }
                events.push(event);
            }
            let first = events
                .first()
                .context("Conversation journal has no committed identity")?;
            let mut meta: SessionMeta = serde_json::from_value(first.data["meta"].clone())?;
            let key = session_key(&meta.project_root, &meta.id);
            if path.file_stem().and_then(|s| s.to_str()) != Some(key.as_str()) {
                bail!("Conversation journal identity does not match its path");
            }
            let deleted = events.iter().any(|event| event.kind == "deleted");
            for event in &events {
                if event.kind == "renamed" {
                    meta.name = event.data["name"]
                        .as_str()
                        .context("Invalid conversation name")?
                        .into();
                }
            }
            if committed != bytes.len() {
                let file = std::fs::OpenOptions::new().write(true).open(&path)?;
                file.set_len(committed as u64)?;
                file.sync_all()?;
            }
            let importing = first.data["importing"] == true
                && !events.iter().any(|event| event.kind == "import_complete");
            conversations.insert(
                key,
                Conversation {
                    meta,
                    events,
                    deleted,
                    importing,
                },
            );
        }
        let sessions = Arc::new(Self {
            directory,
            conversations: Mutex::new(conversations),
            output,
        });
        let interrupted: Vec<_> = sessions
            .conversations
            .lock()
            .await
            .values()
            .filter(|session| !session.deleted && !session.importing)
            .filter_map(|session| {
                session
                    .active()
                    .map(|active| (session.meta.clone(), active.turn_id.clone().unwrap()))
            })
            .collect();
        for (meta, turn) in interrupted {
            sessions
                .finish(
                    &meta.project_root,
                    &meta.id,
                    &turn,
                    "interrupted",
                    Some("The runtime stopped during this request. No action was replayed.".into()),
                )
                .await?;
        }
        Ok(sessions)
    }

    pub async fn create(
        &self,
        root: &Path,
        id: Option<String>,
        name: String,
    ) -> Result<SessionMeta> {
        self.create_record(root, id, name, false).await
    }

    async fn create_record(
        &self,
        root: &Path,
        id: Option<String>,
        name: String,
        importing: bool,
    ) -> Result<SessionMeta> {
        let root = canonical_root(root).await?;
        let id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
        if id.is_empty() || id.len() > 128 || name.trim().is_empty() || name.len() > 1024 {
            bail!("Invalid conversation identity or name");
        }
        let key = session_key(&root, &id);
        let mut conversations = self.conversations.lock().await;
        if let Some(session) = conversations.get(&key) {
            if session.deleted {
                bail!("Conversation was deleted");
            }
            return Ok(session.meta.clone());
        }
        let meta = SessionMeta {
            id,
            name: name.trim().into(),
            project_root: root,
            created_at: now(),
        };
        let event = SessionEvent {
            sequence: 1,
            id: "created".into(),
            turn_id: None,
            kind: "created".into(),
            data: json!({"meta":meta,"importing":importing}),
            timestamp: now(),
        };
        append_file(self.path(&key), &event).await?;
        conversations.insert(
            key,
            Conversation {
                meta: meta.clone(),
                events: vec![event],
                deleted: false,
                importing,
            },
        );
        Ok(meta)
    }

    pub async fn list(&self, root: &Path) -> Result<Vec<SessionMeta>> {
        let root = canonical_root(root).await?;
        let mut result: Vec<_> = self
            .conversations
            .lock()
            .await
            .values()
            .filter(|session| {
                session.meta.project_root == root && !session.deleted && !session.importing
            })
            .map(|session| session.meta.clone())
            .collect();
        result.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
        Ok(result)
    }

    pub async fn read(&self, root: &Path, id: &str, after: u64) -> Result<Value> {
        let root = canonical_root(root).await?;
        let conversations = self.conversations.lock().await;
        let session = get(&conversations, &root, id)?;
        let mut bytes = 0;
        let events: Vec<_> = session
            .events
            .iter()
            .filter(|event| event.sequence > after)
            .take_while(|event| {
                let size = serde_json::to_vec(event).map_or(usize::MAX, |bytes| bytes.len());
                if bytes > 0 && bytes + size > 6 * 1024 * 1024 {
                    return false;
                }
                bytes += size;
                true
            })
            .take(256)
            .cloned()
            .collect();
        let next = events.last().map_or(after, |event| event.sequence);
        Ok(
            json!({"meta":session.meta,"events":events,"nextSequence":next,"lastSequence":session.events.len(),"hasMore":next < session.events.len() as u64,"activeTurnId":session.active().and_then(|event|event.turn_id.as_ref())}),
        )
    }

    pub async fn rename(&self, root: &Path, id: &str, name: &str) -> Result<()> {
        if name.trim().is_empty() || name.len() > 1024 {
            bail!("Invalid conversation name");
        }
        self.append(
            root,
            id,
            Uuid::new_v4().to_string(),
            None,
            "renamed",
            json!({"name":name.trim()}),
            false,
        )
        .await?;
        Ok(())
    }

    pub async fn begin(
        &self,
        root: &Path,
        id: &str,
        turn: String,
        role: Role,
        text: String,
        reply_to: Option<String>,
    ) -> Result<Value> {
        Uuid::parse_str(&turn).context("User request ID must be a UUID")?;
        if text.trim().is_empty() || text.len() > 1024 * 1024 {
            bail!("Invalid user request");
        }
        if let Some(reply_to) = &reply_to {
            let root = canonical_root(root).await?;
            let conversations = self.conversations.lock().await;
            let session = get(&conversations, &root, id)?;
            let question = session
                .events
                .iter()
                .find(|event| {
                    &event.id == reply_to
                        && event.kind == "view"
                        && event.data["event"]["kind"] == "question"
                })
                .context("Design question does not belong to this conversation")?;
            if question.data["event"]["question"]["requestId"].is_string() {
                bail!("A native interaction requires an in-flight answer");
            }
            let parent = session
                .events
                .iter()
                .find(|event| event.kind == "turn_begin" && event.turn_id == question.turn_id)
                .context("Question has no owning request")?;
            if parent.data["role"] != serde_json::to_value(&role)? {
                bail!("Question belongs to another role");
            }
        }
        let event = self
            .append(
                root,
                id,
                format!("begin:{turn}"),
                Some(turn.clone()),
                "turn_begin",
                json!({"role":role,"text":text,"replyTo":reply_to}),
                true,
            )
            .await?;
        Ok(json!({"turnId":turn,"sequence":event.sequence}))
    }

    pub async fn assert_active(
        &self,
        root: &Path,
        id: &str,
        turn: &str,
        role: &Role,
    ) -> Result<()> {
        let conversations = self.conversations.lock().await;
        let active = get(&conversations, root, id)?
            .active()
            .context("Conversation has no active user request")?;
        if active.turn_id.as_deref() != Some(turn)
            || active.data["role"] != serde_json::to_value(role)?
        {
            bail!("Request belongs to another conversation or role");
        }
        Ok(())
    }

    pub async fn finish(
        &self,
        root: &Path,
        id: &str,
        turn: &str,
        status: &str,
        error: Option<String>,
    ) -> Result<()> {
        if !matches!(status, "completed" | "failed" | "interrupted") {
            bail!("Invalid request outcome");
        }
        let root = canonical_root(root).await?;
        {
            let conversations = self.conversations.lock().await;
            let session = get(&conversations, &root, id)?;
            if session
                .events
                .iter()
                .any(|event| event.id == format!("end:{turn}"))
            {
                return Ok(());
            }
        }
        self.append(
            &root,
            id,
            format!("end:{turn}"),
            Some(turn.into()),
            "turn_end",
            json!({"status":status,"error":error}),
            true,
        )
        .await?;
        Ok(())
    }

    pub async fn view(
        &self,
        root: &Path,
        id: &str,
        turn: &str,
        event_id: String,
        event: Value,
    ) -> Result<SessionEvent> {
        if !matches!(
            event["kind"].as_str(),
            Some("text" | "activity" | "question" | "debug" | "context")
        ) {
            bail!("Invalid conversation event");
        }
        self.append(
            root,
            id,
            event_id,
            Some(turn.into()),
            "view",
            json!({"event":event}),
            true,
        )
        .await
    }

    pub async fn append(
        &self,
        root: &Path,
        id: &str,
        event_id: String,
        turn: Option<String>,
        kind: &str,
        data: Value,
        require_active: bool,
    ) -> Result<SessionEvent> {
        let root = canonical_root(root).await?;
        let key = session_key(&root, id);
        let mut conversations = self.conversations.lock().await;
        let session = get_mut(&mut conversations, &root, id)?;
        if let Some(previous) = session.events.iter().find(|event| event.id == event_id) {
            if previous.kind != kind || previous.turn_id != turn || previous.data != data {
                bail!("Conversation event ID was reused for different input");
            }
            return Ok(previous.clone());
        }
        if require_active {
            if session.importing {
                bail!("Conversation import has not committed");
            }
            if kind == "turn_begin" {
                if session.active().is_some() {
                    bail!("Conversation already has an active request");
                }
            } else if session.active().and_then(|event| event.turn_id.as_ref()) != turn.as_ref() {
                bail!("Conversation request is no longer active");
            }
        }
        let event = SessionEvent {
            sequence: session.events.len() as u64 + 1,
            id: event_id,
            turn_id: turn,
            kind: kind.into(),
            data,
            timestamp: now(),
        };
        if serde_json::to_vec(&event)?.len() > 8 * 1024 * 1024 {
            bail!("Conversation event exceeds its bounded storage limit");
        }
        append_file(self.path(&key), &event).await?;
        if kind == "renamed" {
            session.meta.name = event.data["name"].as_str().unwrap().into();
        }
        if kind == "import_complete" {
            session.importing = false;
        }
        session.events.push(event.clone());
        drop(conversations);
        self.output.send(json!({"method":"session/event","params":{"projectRoot":root,"sessionId":id,"event":event}})).await.context("Conversation event persisted but its connection closed")?;
        Ok(event)
    }

    pub async fn context_revision(&self, root: &Path, id: &str) -> Result<u64> {
        Ok(get(&*self.conversations.lock().await, root, id)?.revision())
    }

    pub async fn completed_receipts(
        &self,
    ) -> Result<Vec<(PathBuf, String, crate::state::Receipt)>> {
        let conversations = self.conversations.lock().await;
        let mut result = Vec::new();
        for session in conversations.values().filter(|session| !session.deleted) {
            for event in &session.events {
                if event.kind == "model_result" && event.data["receipt"]["status"] == "completed" {
                    if let Ok(receipt) = serde_json::from_value(event.data["receipt"].clone()) {
                        result.push((
                            session.meta.project_root.clone(),
                            session.meta.id.clone(),
                            receipt,
                        ));
                    }
                }
            }
        }
        Ok(result)
    }

    pub async fn active_turn(&self, root: &Path, id: &str) -> Result<Option<String>> {
        let conversations = self.conversations.lock().await;
        Ok(get(&conversations, root, id)?
            .active()
            .and_then(|event| event.turn_id.clone()))
    }

    pub async fn save_images(
        &self,
        root: &Path,
        id: &str,
        images: &[String],
    ) -> Result<Vec<String>> {
        let key = session_key(root, id);
        let mut refs = Vec::new();
        for image in images {
            if !image.starts_with("data:image/") || image.len() > 10 * 1024 * 1024 {
                bail!("Invalid conversation image");
            }
            let hash = payload_hash(&json!(image));
            let path = self
                .directory
                .join("images")
                .join(&key)
                .join(format!("{hash}.json"));
            if !path.exists() {
                atomic_json(&path, image).await?;
            }
            refs.push(hash);
        }
        Ok(refs)
    }

    pub async fn history(&self, root: &Path, id: &str) -> Result<codex_history::InitialHistory> {
        use codex_history::{ResponseItemEnvelope, RolloutItem};
        use codex_protocol::models::{ContentItem, ImageReference, ResponseItem};
        let conversations = self.conversations.lock().await;
        let session = get(&conversations, root, id)?;
        let mut items = Vec::new();
        let mut message = |role: &str, text: String, images: Vec<String>| {
            let mut content = vec![if role == "assistant" {
                ContentItem::OutputText { text }
            } else {
                ContentItem::InputText { text }
            }];
            content.extend(images.into_iter().map(|image_url| ContentItem::InputImage {
                image: ImageReference::Inline { image_url },
                detail: None,
            }));
            items.push(RolloutItem::ResponseItem(ResponseItemEnvelope {
                item: ResponseItem::Message {
                    id: None,
                    role: role.into(),
                    content,
                    phase: None,
                    internal_chat_message_metadata_passthrough: None,
                },
                metadata: None,
            }));
        };
        for event in &session.events {
            if event.kind == "view" && event.data["event"]["kind"] == "context" {
                message(
                    "user",
                    format!(
                        "Historical host operation results (context only, do not replay): {}",
                        event.data["event"]["value"]
                    ),
                    vec![],
                );
            } else if event.kind == "turn_begin" {
                if let Some(end) = session
                    .events
                    .iter()
                    .find(|end| end.kind == "turn_end" && end.turn_id == event.turn_id)
                {
                    if end.data["status"] != "completed" {
                        message(
                            "user",
                            format!(
                                "Historical user request ended {}. Inspect current state; do not replay previous actions.\n{}",
                                end.data["status"],
                                event.data["text"].as_str().unwrap_or_default()
                            ),
                            vec![],
                        );
                    }
                }
            } else if event.kind == "legacy_context" {
                let role = if event.data["role"] == "assistant" {
                    "assistant"
                } else {
                    "user"
                };
                message(
                    role,
                    format!(
                        "Historical FlowM context; completed actions must not be replayed:\n{}",
                        event.data["content"].as_str().unwrap_or_default()
                    ),
                    vec![],
                );
            } else if event.kind == "model_result" && event.data["receipt"]["status"] == "completed"
            {
                let request = &event.data["receipt"]["requestId"];
                if let Some(input) = session.events.iter().find(|input| {
                    input.kind == "model_input" && input.data["requestId"] == *request
                }) {
                    let mut images = Vec::new();
                    for reference in input.data["images"].as_array().into_iter().flatten() {
                        let hash = reference.as_str().context("Invalid image reference")?;
                        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                            bail!("Invalid image reference");
                        }
                        let path = self
                            .directory
                            .join("images")
                            .join(session_key(root, id))
                            .join(format!("{hash}.json"));
                        images.push(serde_json::from_slice::<String>(
                            &tokio::fs::read(path).await?,
                        )?);
                    }
                    message(
                        "user",
                        format!(
                            "Historical FlowM request/context; actions in this history must not be replayed:\n{}",
                            input.data["prompt"].as_str().unwrap_or_default()
                        ),
                        images,
                    );
                }
                for tool in session.events.iter().filter(|entry| {
                    entry.kind == "model_event"
                        && entry.data["requestId"] == *request
                        && entry.data["event"]["kind"] == "activity"
                        && matches!(
                            entry.data["event"]["activity"]["type"].as_str(),
                            Some("tool" | "tool_status")
                        )
                }) {
                    message(
                        "user",
                        format!(
                            "Historical tool activity/result (context only): {}",
                            tool.data["event"]["activity"]
                        ),
                        vec![],
                    );
                }
                message(
                    "assistant",
                    event.data["receipt"]["text"]
                        .as_str()
                        .unwrap_or_default()
                        .into(),
                    vec![],
                );
            }
        }
        Ok(if items.is_empty() {
            codex_history::InitialHistory::New
        } else {
            codex_history::InitialHistory::Forked(items)
        })
    }

    pub async fn import(
        &self,
        root: &Path,
        id: Option<String>,
        name: String,
        display: Vec<Value>,
        context: Vec<Value>,
        metadata: Value,
    ) -> Result<SessionMeta> {
        if let Some(id) = &id {
            let root = canonical_root(root).await?;
            if let Some(previous) = self.conversations.lock().await.get(&session_key(&root, id)) {
                if previous.deleted
                    || previous
                        .events
                        .iter()
                        .any(|event| event.id == "legacy-metadata")
                {
                    return Ok(previous.meta.clone());
                }
            }
        }
        let meta = self.create(root, id, name).await?;
        for (index, item) in display.iter().enumerate() {
            self.append(
                &meta.project_root,
                &meta.id,
                format!("legacy-display:{index}"),
                None,
                "legacy_message",
                item.clone(),
                false,
            )
            .await?;
        }
        let context = if context.is_empty() {
            display
                .iter()
                .filter(|item| {
                    matches!(item["role"].as_str(), Some("user" | "assistant"))
                        && item.get("question").is_none()
                })
                .map(|item| json!({"role":item["role"],"content":item["text"]}))
                .collect()
        } else {
            context
        };
        for (index, item) in context.into_iter().enumerate() {
            let content = if item.get("toolCalls").is_some() {
                format!(
                    "{}\nHistorical operation proposals: {}",
                    item["content"].as_str().unwrap_or_default(),
                    item["toolCalls"]
                )
            } else {
                item["content"].as_str().unwrap_or_default().into()
            };
            self.append(
                &meta.project_root,
                &meta.id,
                format!("legacy-context:{index}"),
                None,
                "legacy_context",
                json!({"role":item["role"],"content":content}),
                false,
            )
            .await?;
        }
        self.append(
            &meta.project_root,
            &meta.id,
            "legacy-metadata".into(),
            None,
            "legacy_metadata",
            metadata,
            false,
        )
        .await?;
        Ok(meta)
    }

    #[cfg(test)]
    pub async fn export(&self, root: &Path, id: &str) -> Result<Value> {
        let root = canonical_root(root).await?;
        let conversations = self.conversations.lock().await;
        let session = get(&conversations, &root, id)?;
        if session.active().is_some() {
            bail!("Wait for the current request before exporting");
        }
        let mut events = session.events.clone();
        for event in &mut events {
            if event.kind == "model_input" {
                let mut images = Vec::new();
                for reference in event.data["images"].as_array().into_iter().flatten() {
                    let hash = reference.as_str().context("Invalid image reference")?;
                    let path = self
                        .directory
                        .join("images")
                        .join(session_key(&root, id))
                        .join(format!("{hash}.json"));
                    images.push(serde_json::from_slice::<String>(
                        &tokio::fs::read(path).await?,
                    )?);
                }
                event.data["images"] = json!(images);
            }
        }
        Ok(json!({"version":1,"meta":session.meta,"events":events}))
    }

    pub async fn export_page(
        &self,
        root: &Path,
        id: &str,
        after: u64,
        expected: Option<u64>,
    ) -> Result<Value> {
        let root = canonical_root(root).await?;
        let revision = {
            let conversations = self.conversations.lock().await;
            let session = get(&conversations, &root, id)?;
            if session.active().is_some() || session.importing {
                bail!("Wait for the current request before exporting");
            }
            let revision = session.events.len() as u64;
            if expected.is_some_and(|value| value != revision) {
                bail!("Conversation changed while exporting; retry the export");
            }
            revision
        };
        let mut page = self.read(&root, id, after).await?;
        if page["lastSequence"].as_u64() != Some(revision) {
            bail!("Conversation changed while exporting; retry the export");
        }
        page["revision"] = json!(revision);
        Ok(page)
    }

    pub async fn image(&self, root: &Path, id: &str, hash: &str) -> Result<String> {
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            bail!("Invalid image reference");
        }
        let root = canonical_root(root).await?;
        let conversations = self.conversations.lock().await;
        let session = get(&conversations, &root, id)?;
        if !session.events.iter().any(|event| {
            event.kind == "model_input"
                && event.data["images"]
                    .as_array()
                    .is_some_and(|images| images.contains(&json!(hash)))
        }) {
            bail!("Image does not belong to the conversation");
        }
        let path = self
            .directory
            .join("images")
            .join(session_key(&root, id))
            .join(format!("{hash}.json"));
        Ok(serde_json::from_slice(&tokio::fs::read(path).await?)?)
    }

    pub async fn begin_import(&self, root: &Path, name: String) -> Result<SessionMeta> {
        self.create_record(root, None, name, true).await
    }

    pub async fn import_events(
        &self,
        root: &Path,
        id: &str,
        events: Vec<SessionEvent>,
    ) -> Result<()> {
        let root = canonical_root(root).await?;
        if !get(&*self.conversations.lock().await, &root, id)?.importing {
            bail!("Conversation is not an import transaction");
        }
        for event in events {
            if matches!(
                event.kind.as_str(),
                "created" | "renamed" | "deleted" | "import_complete"
            ) {
                continue;
            }
            if !matches!(
                event.kind.as_str(),
                "legacy_message"
                    | "legacy_context"
                    | "legacy_metadata"
                    | "turn_begin"
                    | "turn_end"
                    | "model_input"
                    | "model_event"
                    | "model_result"
                    | "view"
                    | "answer"
            ) || !event.data.is_object()
                || event.id.is_empty()
                || event.id.len() > 256
            {
                bail!("Invalid exported conversation event");
            }
            let mut data = event.data;
            if event.kind == "model_input" {
                let images: Vec<String> = serde_json::from_value(data["images"].clone())?;
                data["images"] = json!(self.save_images(&root, id, &images).await?);
            }
            self.append(&root, id, event.id, event.turn_id, &event.kind, data, false)
                .await?;
        }
        Ok(())
    }

    pub async fn commit_import(&self, root: &Path, id: &str) -> Result<()> {
        let root = canonical_root(root).await?;
        {
            let conversations = self.conversations.lock().await;
            let session = get(&conversations, &root, id)?;
            if session.active().is_some() {
                bail!("An unfinished exported request cannot be imported");
            }
        }
        self.append(
            &root,
            id,
            "import_complete".into(),
            None,
            "import_complete",
            json!({}),
            false,
        )
        .await?;
        Ok(())
    }

    pub async fn import_export(
        &self,
        root: &Path,
        name: String,
        document: Value,
    ) -> Result<SessionMeta> {
        if document["version"] != 1 {
            bail!("Unsupported conversation export version");
        }
        let events: Vec<SessionEvent> = serde_json::from_value(document["events"].clone())?;
        if events.iter().any(|event| {
            event.kind == "turn_begin"
                && !events
                    .iter()
                    .any(|end| end.kind == "turn_end" && end.turn_id == event.turn_id)
        }) {
            bail!("An active exported request cannot be imported");
        }
        let meta = self.begin_import(root, name).await?;
        self.import_events(&meta.project_root, &meta.id, events)
            .await?;
        self.commit_import(&meta.project_root, &meta.id).await?;
        Ok(meta)
    }

    pub async fn delete(&self, root: &Path, id: &str) -> Result<()> {
        let root = canonical_root(root).await?;
        let key = session_key(&root, id);
        let mut conversations = self.conversations.lock().await;
        let session = conversations
            .get_mut(&key)
            .context("Conversation was not found")?;
        if session.deleted {
            return Ok(());
        }
        if session.active().is_some() {
            bail!("Conversation still has an active request");
        }
        // Retain only an identity tombstone so a legacy source cannot resurrect deleted data.
        let event = SessionEvent {
            sequence: 1,
            id: "deleted".into(),
            turn_id: None,
            kind: "deleted".into(),
            data: json!({"meta":session.meta}),
            timestamp: now(),
        };
        replace_file(self.path(&key), &event).await?;
        let images = self.directory.join("images").join(&key);
        if images.exists() {
            let mut files = tokio::fs::read_dir(&images).await?;
            while let Some(file) = files.next_entry().await? {
                tokio::fs::remove_file(file.path()).await?;
            }
            tokio::fs::remove_dir(images).await?;
        }
        session.events = vec![event];
        session.deleted = true;
        Ok(())
    }

    fn path(&self, key: &str) -> PathBuf {
        self.directory.join(format!("{key}.jsonl"))
    }
}

pub async fn canonical_root(root: &Path) -> Result<PathBuf> {
    let root = tokio::fs::canonicalize(root)
        .await
        .context("Conversation project could not be opened")?;
    if !root.is_dir() {
        bail!("Conversation project is not a directory");
    }
    Ok(root)
}
fn session_key(root: &Path, id: &str) -> String {
    payload_hash(&json!([root, id]))
}
fn get<'a>(
    sessions: &'a BTreeMap<String, Conversation>,
    root: &Path,
    id: &str,
) -> Result<&'a Conversation> {
    sessions
        .get(&session_key(root, id))
        .filter(|session| !session.deleted)
        .context("Conversation was not found")
}
fn get_mut<'a>(
    sessions: &'a mut BTreeMap<String, Conversation>,
    root: &Path,
    id: &str,
) -> Result<&'a mut Conversation> {
    sessions
        .get_mut(&session_key(root, id))
        .filter(|session| !session.deleted)
        .context("Conversation was not found")
}
async fn append_file(path: PathBuf, event: &SessionEvent) -> Result<()> {
    let mut bytes = serde_json::to_vec(event)?;
    bytes.push(b'\n');
    tokio::task::spawn_blocking(move || -> Result<()> {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        let previous_length = file.metadata()?.len();
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            file.set_len(previous_length)?;
            file.sync_all()?;
            return Err(error.into());
        }
        Ok(())
    })
    .await??;
    Ok(())
}
async fn replace_file(path: PathBuf, event: &SessionEvent) -> Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    append_file(temporary.clone(), event).await?;
    tokio::fs::rename(temporary, path).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn fixture() -> (
        tempfile::TempDir,
        Arc<Sessions>,
        mpsc::Receiver<Value>,
        SessionMeta,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        tokio::fs::create_dir(&project).await.unwrap();
        let (output, receiver) = mpsc::channel(128);
        let sessions = Sessions::open(directory.path(), output).await.unwrap();
        let meta = sessions
            .create(
                &project,
                Some("old-flowm-id".into()),
                "Existing conversation".into(),
            )
            .await
            .unwrap();
        (directory, sessions, receiver, meta)
    }

    #[tokio::test]
    async fn requests_are_durable_idempotent_and_scoped_to_the_project() {
        let (directory, sessions, _receiver, meta) = fixture().await;
        let turn = Uuid::new_v4().to_string();
        sessions
            .begin(
                &meta.project_root,
                &meta.id,
                turn.clone(),
                Role::Canvas,
                "Draw it".into(),
                None,
            )
            .await
            .unwrap();
        sessions
            .begin(
                &meta.project_root,
                &meta.id,
                turn.clone(),
                Role::Canvas,
                "Draw it".into(),
                None,
            )
            .await
            .unwrap();
        assert!(
            sessions
                .begin(
                    &meta.project_root,
                    &meta.id,
                    Uuid::new_v4().to_string(),
                    Role::Project,
                    "Other".into(),
                    None
                )
                .await
                .is_err()
        );
        assert!(
            sessions
                .assert_active(&meta.project_root, &meta.id, &turn, &Role::Project)
                .await
                .is_err()
        );
        sessions
            .finish(&meta.project_root, &meta.id, &turn, "completed", None)
            .await
            .unwrap();
        let page = sessions
            .read(&meta.project_root, &meta.id, 0)
            .await
            .unwrap();
        assert_eq!(
            page["events"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|event| event["kind"] == "turn_begin")
                .count(),
            1
        );
        let other = directory.path().join("other");
        tokio::fs::create_dir(&other).await.unwrap();
        assert!(sessions.read(&other, &meta.id, 0).await.is_err());
        let second = sessions
            .create(&other, Some(meta.id.clone()), "Other project".into())
            .await
            .unwrap();
        assert_ne!(meta.project_root, second.project_root);
    }

    #[tokio::test]
    async fn restart_preserves_messages_and_interrupts_the_host_workflow_without_replay() {
        let (directory, sessions, _receiver, meta) = fixture().await;
        let turn = Uuid::new_v4().to_string();
        sessions
            .begin(
                &meta.project_root,
                &meta.id,
                turn.clone(),
                Role::Project,
                "Edit once".into(),
                None,
            )
            .await
            .unwrap();
        sessions
            .view(
                &meta.project_root,
                &meta.id,
                &turn,
                "visible".into(),
                json!({"kind":"text","text":"Partial answer"}),
            )
            .await
            .unwrap();
        let path = sessions.path(&session_key(&meta.project_root, &meta.id));
        {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap();
            file.write_all(b"{\"sequence\":4").unwrap();
        }
        drop(sessions);
        let (output, _receiver2) = mpsc::channel(128);
        let restored = Sessions::open(directory.path(), output).await.unwrap();
        let page = restored
            .read(&meta.project_root, &meta.id, 0)
            .await
            .unwrap();
        assert_eq!(page["activeTurnId"], Value::Null);
        assert_eq!(
            page["events"].as_array().unwrap().last().unwrap()["data"]["status"],
            "interrupted"
        );
        assert!(
            serde_json::to_string(&page)
                .unwrap()
                .contains("Partial answer")
        );
        assert_eq!(
            restored.list(&meta.project_root).await.unwrap()[0].id,
            meta.id
        );
        let history = restored
            .history(&meta.project_root, &meta.id)
            .await
            .unwrap();
        assert!(format!("{history:?}").contains("Edit once"));
        assert!(
            !page["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|event| event["kind"] == "model_input")
        );
    }

    #[tokio::test]
    async fn committed_corruption_is_preserved_and_rejected() {
        let (directory, sessions, _receiver, meta) = fixture().await;
        let path = sessions.path(&session_key(&meta.project_root, &meta.id));
        use std::io::Write;
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"invalid committed row\n")
            .unwrap();
        let original = tokio::fs::read(&path).await.unwrap();
        let (output, _receiver2) = mpsc::channel(128);
        assert!(Sessions::open(directory.path(), output).await.is_err());
        assert_eq!(tokio::fs::read(path).await.unwrap(), original);
    }

    #[tokio::test]
    async fn an_unacknowledged_torn_identity_does_not_hide_other_conversations() {
        let (directory, sessions, _receiver, meta) = fixture().await;
        tokio::fs::write(
            sessions.directory.join("unfinished.jsonl"),
            b"{\"sequence\":1",
        )
        .await
        .unwrap();
        let (output, _receiver2) = mpsc::channel(128);
        let restored = Sessions::open(directory.path(), output).await.unwrap();
        assert_eq!(
            restored.list(&meta.project_root).await.unwrap()[0].id,
            meta.id
        );
    }

    #[tokio::test]
    async fn portable_history_keeps_completed_results_and_images_but_no_native_approval_state() {
        let (_directory, sessions, _receiver, meta) = fixture().await;
        let images = sessions
            .save_images(
                &meta.project_root,
                &meta.id,
                &["data:image/png;base64,cGljdHVyZQ==".into()],
            )
            .await
            .unwrap();
        sessions
            .append(
                &meta.project_root,
                &meta.id,
                "input".into(),
                None,
                "model_input",
                json!({"requestId":"r","prompt":"Remember request A","images":images}),
                false,
            )
            .await
            .unwrap();
        sessions
            .append(
                &meta.project_root,
                &meta.id,
                "result".into(),
                None,
                "model_result",
                json!({"receipt":{"requestId":"r","status":"completed","text":"Answer A"}}),
                false,
            )
            .await
            .unwrap();
        sessions.append(&meta.project_root, &meta.id, "pending".into(), None, "model_event", json!({"requestId":"other","event":{"kind":"question","question":{"requestId":"dead-approval","items":[]}}}), false).await.unwrap();
        let history = sessions
            .history(&meta.project_root, &meta.id)
            .await
            .unwrap();
        let formatted = format!("{history:?}");
        assert!(formatted.contains("Remember request A") && formatted.contains("Answer A"));
        assert!(!formatted.contains("dead-approval"));
        let document = sessions.export(&meta.project_root, &meta.id).await.unwrap();
        assert_eq!(
            document["events"][1]["data"]["images"][0],
            "data:image/png;base64,cGljdHVyZQ=="
        );
        let imported = sessions
            .import_export(&meta.project_root, "Imported".into(), document)
            .await
            .unwrap();
        assert_ne!(meta.id, imported.id);
        assert!(
            format!(
                "{:?}",
                sessions
                    .history(&imported.project_root, &imported.id)
                    .await
                    .unwrap()
            )
            .contains("Answer A")
        );
    }

    #[tokio::test]
    async fn deletion_removes_content_and_cannot_be_undone_by_a_legacy_migration() {
        let (_directory, sessions, _receiver, meta) = fixture().await;
        sessions
            .import(
                &meta.project_root,
                Some(meta.id.clone()),
                meta.name.clone(),
                vec![json!({"id":"old","role":"user","text":"Legacy private text"})],
                vec![],
                json!({"codexSessionId":"old-cli"}),
            )
            .await
            .unwrap();
        let revision = sessions
            .context_revision(&meta.project_root, &meta.id)
            .await
            .unwrap();
        assert!(revision > 0);
        sessions.delete(&meta.project_root, &meta.id).await.unwrap();
        sessions.delete(&meta.project_root, &meta.id).await.unwrap();
        sessions
            .import(
                &meta.project_root,
                Some(meta.id.clone()),
                meta.name.clone(),
                vec![json!({"role":"user","text":"Resurrect"})],
                vec![],
                json!({}),
            )
            .await
            .unwrap();
        assert!(sessions.list(&meta.project_root).await.unwrap().is_empty());
        let tombstone =
            tokio::fs::read_to_string(sessions.path(&session_key(&meta.project_root, &meta.id)))
                .await
                .unwrap();
        assert!(
            !tombstone.contains("Legacy private text")
                && !tombstone.contains("old-cli")
                && !tombstone.contains("Resurrect")
        );
    }

    #[tokio::test]
    async fn invalid_whole_document_import_does_not_publish_a_partial_conversation() {
        let (_directory, sessions, _receiver, meta) = fixture().await;
        let document = json!({"version":1,"events":[
            {"sequence":1,"id":"valid","turnId":null,"kind":"legacy_context",
             "data":{"role":"user","content":"Partial import"},"timestamp":1},
            {"sequence":2,"id":"invalid","turnId":null,"kind":"unknown",
             "data":{},"timestamp":2}
        ]});
        assert!(
            sessions
                .import_export(&meta.project_root, "Invalid".into(), document)
                .await
                .is_err()
        );
        let visible = sessions.list(&meta.project_root).await.unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].id, meta.id);
    }

    #[tokio::test]
    async fn paged_imports_are_unpublished_until_commit_and_export_rejects_changed_revisions() {
        let (_directory, sessions, _receiver, meta) = fixture().await;
        let imported = sessions
            .begin_import(&meta.project_root, "Import".into())
            .await
            .unwrap();
        assert!(
            !sessions
                .list(&meta.project_root)
                .await
                .unwrap()
                .iter()
                .any(|session| session.id == imported.id)
        );
        assert!(
            sessions
                .begin(
                    &meta.project_root,
                    &imported.id,
                    Uuid::new_v4().to_string(),
                    Role::Canvas,
                    "Must not execute".into(),
                    None
                )
                .await
                .is_err()
        );
        sessions
            .commit_import(&meta.project_root, &imported.id)
            .await
            .unwrap();
        assert!(
            sessions
                .list(&meta.project_root)
                .await
                .unwrap()
                .iter()
                .any(|session| session.id == imported.id)
        );
        let page = sessions
            .export_page(&meta.project_root, &imported.id, 0, None)
            .await
            .unwrap();
        sessions
            .rename(&meta.project_root, &imported.id, "Changed")
            .await
            .unwrap();
        assert!(
            sessions
                .export_page(
                    &meta.project_root,
                    &imported.id,
                    0,
                    page["revision"].as_u64()
                )
                .await
                .is_err()
        );
    }
}
