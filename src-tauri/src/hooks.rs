use crate::model::{Activity, AttentionState, Model, Session, ToolStatus};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

pub const MAX_HOOK_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum HookKind {
    SessionStart,
    UserPromptSubmit,
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
    PermissionRequest,
    Notification,
    Stop,
    SessionEnd,
}

/// Explicit metadata whitelist: no prompt, message, tool input, response, or secrets.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookEvent {
    pub kind: HookKind,
    pub session_id: String,
    pub cwd: String,
    pub timestamp: i64,
    pub agent_pid: u32,
    pub tool: Option<String>,
    pub model: Option<String>,
    pub notification_type: Option<String>,
    pub tool_use_id: Option<String>,
}

impl HookEvent {
    pub fn from_input(input: &[u8], agent_pid: u32) -> Result<Self, String> {
        if input.len() as u64 > MAX_HOOK_BYTES {
            return Err("hook input exceeds size limit".into());
        }
        let v: Value =
            serde_json::from_slice(input).map_err(|e| format!("invalid hook JSON: {e}"))?;
        let kind: HookKind = serde_json::from_value(v["hook_event_name"].clone())
            .map_err(|_| "unsupported hook event".to_string())?;
        let required = |key: &str| -> Result<String, String> {
            v[key]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| format!("hook missing {key}"))
        };
        Ok(Self {
            kind,
            session_id: required("session_id")?,
            cwd: required("cwd")?,
            timestamp: chrono::Utc::now().timestamp_millis(),
            agent_pid,
            tool: v["tool_name"].as_str().map(str::to_owned),
            model: v["model"].as_str().map(str::to_owned),
            notification_type: v["notification_type"].as_str().map(str::to_owned),
            tool_use_id: v["tool_use_id"].as_str().map(str::to_owned),
        })
    }

    pub fn apply(&self, s: &mut Session) -> bool {
        if let Some(tool) = &self.tool {
            let status = match self.kind {
                HookKind::PreToolUse => Some(ToolStatus::Observed),
                HookKind::PostToolUse => Some(ToolStatus::Returned),
                HookKind::PostToolUseFailure => Some(ToolStatus::Failed),
                _ => None,
            };
            if let Some(status) = status {
                let id = self
                    .tool_use_id
                    .clone()
                    .unwrap_or_else(|| format!("{:?}:{}:{tool}", self.kind, self.timestamp));
                s.observe_tool(id, tool.clone(), status, self.timestamp);
            }
        }
        // Late tool returns still update their observation, but cannot rewind runtime.
        if self.timestamp < s.runtime.updated_at {
            return false;
        }
        if let Some(model) = &self.model {
            s.model = Some(Model {
                name: model.clone(),
                provider: None,
            });
        }
        match self.kind {
            HookKind::SessionStart => s.activity(Activity::Idle, None, self.timestamp),
            HookKind::UserPromptSubmit => {
                s.activity(Activity::Thinking, None, self.timestamp);
                s.runtime.started_at = self.timestamp;
            }
            HookKind::PreToolUse => {
                s.activity(Activity::ToolRunning, self.tool.clone(), self.timestamp)
            }
            HookKind::PostToolUse => s.activity(Activity::Thinking, None, self.timestamp),
            HookKind::PostToolUseFailure => s.attention(
                AttentionState::Error,
                "Tool failed; return to the terminal",
                self.timestamp,
            ),
            HookKind::PermissionRequest => s.attention(
                AttentionState::WaitingUser,
                "Permission required",
                self.timestamp,
            ),
            HookKind::Notification => match self.notification_type.as_deref() {
                Some("permission_prompt") => s.attention(
                    AttentionState::WaitingUser,
                    "Permission required",
                    self.timestamp,
                ),
                Some("idle_prompt") => s.attention(
                    AttentionState::WaitingUser,
                    "Your input is needed",
                    self.timestamp,
                ),
                _ => {}
            },
            HookKind::Stop => s.attention(AttentionState::Done, "Task completed", self.timestamp),
            HookKind::SessionEnd => return true,
        }
        false
    }
}

pub fn event_dir() -> Result<PathBuf, String> {
    match std::env::var_os("HUD_EVENT_DIR") {
        Some(path) => Ok(PathBuf::from(path)),
        None => std::env::var_os("LOCALAPPDATA")
            .map(|base| PathBuf::from(base).join("CodingAgentHUD").join("events"))
            .ok_or_else(|| "LOCALAPPDATA is unavailable; set HUD_EVENT_DIR explicitly".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn whitelist_drops_all_content_and_secrets() {
        let event = HookEvent::from_input(br#"{"hook_event_name":"PreToolUse","session_id":"test","cwd":"C:/demo","tool_name":"Bash","prompt":"SECRET","tool_input":{"command":"PRIVATE"},"api_key":"KEY"}"#, 123).unwrap();
        let serialized = serde_json::to_string(&event).unwrap();
        for secret in [
            "SECRET",
            "PRIVATE",
            "KEY",
            "prompt",
            "tool_input",
            "api_key",
        ] {
            assert!(!serialized.contains(secret));
        }
        let mut s = Session::new("claude", "test", "C:/demo", event.timestamp);
        event.apply(&mut s);
        assert_eq!(s.runtime.state, Activity::ToolRunning);
        assert_eq!(s.attention.state, AttentionState::None);
    }
    #[test]
    fn explicit_permission_and_end() {
        let mut event = HookEvent::from_input(
            br#"{"hook_event_name":"PermissionRequest","session_id":"test","cwd":"C:/demo"}"#,
            123,
        )
        .unwrap();
        let mut s = Session::new("claude", "test", "C:/demo", event.timestamp);
        assert!(!event.apply(&mut s));
        assert_eq!(s.attention.state, AttentionState::WaitingUser);
        event.kind = HookKind::SessionEnd;
        assert!(event.apply(&mut s));
    }
    #[test]
    fn validates_required_fields_and_event_name() {
        assert!(HookEvent::from_input(br#"{"hook_event_name":"SomethingElse"}"#, 1).is_err());
        assert!(
            HookEvent::from_input(br#"{"hook_event_name":"Stop","cwd":"C:/demo"}"#, 1).is_err()
        );
    }
}

#[cfg(test)]
mod observation_tests {
    use super::*;
    #[test]
    fn late_parallel_return_is_recorded_without_rewinding_current_activity() {
        let mut session = Session::new("claude", "parallel", "C:/fixture", 0);
        let mut event = HookEvent::from_input(br#"{"hook_event_name":"PreToolUse","session_id":"parallel","cwd":"C:/fixture","tool_name":"Read","tool_use_id":"a"}"#, 1).unwrap();
        event.timestamp = 10;
        event.apply(&mut session);
        event.tool_use_id = Some("b".into());
        event.timestamp = 21;
        event.apply(&mut session);
        event.tool_use_id = Some("a".into());
        event.kind = HookKind::PostToolUse;
        event.timestamp = 20;
        event.apply(&mut session);
        assert_eq!(session.runtime.updated_at, 21);
        assert_eq!(session.runtime.state, Activity::ToolRunning);
        assert_eq!(
            session
                .recent_tools
                .iter()
                .find(|tool| tool.id == "a")
                .unwrap()
                .status,
            ToolStatus::Returned
        );
    }
}
