//! Stage capabilities and one absolute execution deadline, independent of call counts.
use crate::state::Role;
use anyhow::{Result, bail};
use codex_extension_api::{
    ModelRequestContributor, ModelRequestInput, ModelRequestKind, ModelResponseError,
    ModelResponseInterceptor, ModelResponseStream, ResponseEvent,
};
use codex_protocol::models::ResponseItem;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::Instant;

pub const DEFAULT_TIMEOUT_SECS: u64 = 600;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimePolicy {
    pub phase: String,
    pub tools: String,
    pub timeout_secs: u64,
}
impl RuntimePolicy {
    pub fn default_for(role: &Role, disabled: bool) -> Self {
        let project = *role == Role::Project;
        Self {
            phase: if disabled {
                "build"
            } else if project {
                "project"
            } else {
                "inspect"
            }
            .into(),
            tools: if disabled {
                "none"
            } else if project {
                "workspace"
            } else {
                "inspect"
            }
            .into(),
            timeout_secs: DEFAULT_TIMEOUT_SECS,
        }
    }
    pub fn validate(&self, role: &Role, disabled: bool) -> Result<()> {
        let allowed = if *role == Role::Canvas {
            matches!(
                self.phase.as_str(),
                "inspect" | "build" | "review" | "finalize"
            ) && ((self.phase == "inspect" && self.tools == "inspect" && !disabled)
                || (self.phase != "inspect" && self.tools == "none" && disabled))
        } else {
            self.phase == "project" && self.tools == "workspace" && !disabled
        };
        if !allowed {
            bail!("Runtime phase and tool policy do not match the private execution segment");
        }
        if self.timeout_secs == 0
            || Instant::now()
                .checked_add(Duration::from_secs(self.timeout_secs))
                .is_none()
        {
            bail!("Runtime timeout must be a positive, representable duration");
        }
        Ok(())
    }
    pub fn timeout_message(&self) -> String {
        format!(
            "FlowM {} stage timed out after {} seconds. Execution was stopped; no tool was replayed.",
            self.phase, self.timeout_secs
        )
    }
}

#[derive(Debug)]
struct Execution {
    policy: RuntimePolicy,
    deadline: Instant,
}
impl Execution {
    fn authorize_tool(&self) -> Result<(), String> {
        if Instant::now() >= self.deadline {
            return Err(self.policy.timeout_message());
        }
        if self.policy.tools == "none" {
            return Err(format!(
                "FlowM {} stage stopped: project tools are disabled while producing canvas output. No tool was replayed.",
                self.policy.phase
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct ExecutionControl {
    active: Mutex<HashMap<String, Arc<Execution>>>,
}
pub struct ExecutionScope {
    control: Arc<ExecutionControl>,
    thread: String,
}
impl Drop for ExecutionScope {
    fn drop(&mut self) {
        self.control.active.lock().unwrap().remove(&self.thread);
    }
}
impl ExecutionControl {
    pub fn begin(
        self: &Arc<Self>,
        thread: String,
        policy: RuntimePolicy,
        deadline: Instant,
    ) -> ExecutionScope {
        self.active
            .lock()
            .unwrap()
            .insert(thread.clone(), Arc::new(Execution { policy, deadline }));
        ExecutionScope {
            control: self.clone(),
            thread,
        }
    }
}
impl ModelRequestContributor for ExecutionControl {
    fn request(&self, input: ModelRequestInput<'_>) -> Option<Box<dyn ModelResponseInterceptor>> {
        if input.kind != ModelRequestKind::Generation {
            return None;
        }
        let execution = self.active.lock().unwrap().get(input.thread_id).cloned();
        Some(Box::new(GuardStream { execution }))
    }
}
struct GuardStream {
    execution: Option<Arc<Execution>>,
}
impl ModelResponseInterceptor for GuardStream {
    fn intercept(self: Box<Self>, stream: ModelResponseStream) -> ModelResponseStream {
        let Some(execution) = self.execution else {
            return Box::pin(futures::stream::once(async {
                Err(ModelResponseError::Stream(
                    "FlowM rejected an unmanaged model execution".into(),
                ))
            }));
        };
        Box::pin(futures::stream::unfold(Some(stream), move |current| {
            let execution = execution.clone();
            async move {
                let mut stream = current?;
                match tokio::time::timeout_at(execution.deadline, stream.next()).await {
                    Err(_) => Some((
                        Err(ModelResponseError::Stream(
                            execution.policy.timeout_message(),
                        )),
                        None,
                    )),
                    Ok(None) => None,
                    Ok(Some(event)) => {
                        let tool = match &event {
                            Ok(
                                ResponseEvent::OutputItemAdded(item)
                                | ResponseEvent::OutputItemDone(item),
                            ) => matches!(
                                item,
                                ResponseItem::FunctionCall { .. }
                                    | ResponseItem::CustomToolCall { .. }
                            ),
                            _ => false,
                        };
                        if tool {
                            if let Err(error) = execution.authorize_tool() {
                                return Some((Err(ModelResponseError::Stream(error)), None));
                            }
                        }
                        Some((event, Some(stream)))
                    }
                }
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inspection_defaults_to_ten_minutes_and_has_no_call_count_limit() {
        let policy = RuntimePolicy::default_for(&Role::Canvas, false);
        assert_eq!(policy.timeout_secs, 600);
        let execution = Execution {
            policy,
            deadline: Instant::now() + Duration::from_secs(600),
        };
        for _ in 0..1000 {
            execution.authorize_tool().unwrap();
        }
    }
    #[test]
    fn deadline_and_disabled_tools_are_independent() {
        let expired = Execution {
            policy: RuntimePolicy::default_for(&Role::Canvas, false),
            deadline: Instant::now(),
        };
        assert!(expired.authorize_tool().unwrap_err().contains("timed out"));
        let output = Execution {
            policy: RuntimePolicy::default_for(&Role::Canvas, true),
            deadline: Instant::now() + Duration::from_secs(600),
        };
        assert!(
            output
                .authorize_tool()
                .unwrap_err()
                .contains("project tools are disabled")
        );
    }
    #[test]
    fn phase_cannot_relax_role_or_thread_capabilities() {
        assert!(
            RuntimePolicy::default_for(&Role::Canvas, true)
                .validate(&Role::Canvas, true)
                .is_ok()
        );
        assert!(
            RuntimePolicy::default_for(&Role::Project, false)
                .validate(&Role::Canvas, false)
                .is_err()
        );
        let mut policy = RuntimePolicy::default_for(&Role::Canvas, false);
        policy.timeout_secs = 0;
        assert!(policy.validate(&Role::Canvas, false).is_err());
    }

    #[tokio::test]
    async fn streamed_activity_does_not_reset_the_absolute_deadline() {
        let execution = Arc::new(Execution {
            policy: RuntimePolicy::default_for(&Role::Canvas, false),
            deadline: Instant::now() + Duration::from_millis(25),
        });
        let source = futures::stream::unfold((), |_| async {
            tokio::time::sleep(Duration::from_millis(2)).await;
            Some((Ok(ResponseEvent::Created { response_id: None }), ()))
        });
        let mut stream = Box::new(GuardStream {
            execution: Some(execution),
        })
        .intercept(Box::pin(source));
        let mut events = 0;
        while let Some(event) = stream.next().await {
            if let Err(error) = event {
                assert!(error.to_string().contains("timed out"));
                break;
            }
            events += 1;
        }
        assert!(events > 0);
        assert!(stream.next().await.is_none());
    }
}
