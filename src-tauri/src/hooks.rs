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
    PreCompact,
    PostCompact,
    StopFailure,
    Elicitation,
    ElicitationResult,
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
    pub transcript_path: Option<String>,
    pub agent_started_at: Option<u64>,
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
            transcript_path: v["transcript_path"].as_str().map(str::to_owned),
            agent_started_at: None,
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
        let was_waiting = s.hook_waiting.pending();
        if matches!(
            self.kind,
            HookKind::PostToolUse | HookKind::PostToolUseFailure
        ) {
            if let Some(id) = &self.tool_use_id {
                s.running_tools.remove(id);
                s.hook_waiting.permission_tools.remove(id);
                if s.hook_waiting.permission_tools.is_empty()
                    && !s.hook_waiting.uncorrelated_permission
                {
                    s.hook_waiting.permission_visible = false;
                }
            }
        }
        // Late tool returns still update their observation, but cannot rewind runtime.
        if self.timestamp < s.runtime.updated_at {
            if was_waiting
                && !s.hook_waiting.pending()
                && s.attention.state == AttentionState::WaitingUser
            {
                let tool = s.running_tools.values().next_back().cloned();
                let activity = if tool.is_some() {
                    Activity::ToolRunning
                } else {
                    Activity::Thinking
                };
                let timestamp = s.runtime.updated_at;
                settle(s, activity, tool, timestamp);
            }
            return false;
        }
        if self.kind == HookKind::PreToolUse {
            if let (Some(id), Some(tool)) = (&self.tool_use_id, &self.tool) {
                s.running_tools.insert(id.clone(), tool.clone());
            }
        }
        if let Some(model) = &self.model {
            s.model = Some(Model {
                name: model.clone(),
                provider: None,
            });
        }
        match self.kind {
            HookKind::SessionStart => {
                s.running_tools.clear();
                s.hook_waiting = Default::default();
                s.activity(Activity::Idle, None, self.timestamp);
            }
            HookKind::UserPromptSubmit => {
                s.running_tools.clear();
                s.hook_waiting = Default::default();
                s.activity(Activity::Thinking, None, self.timestamp);
                s.runtime.started_at = self.timestamp;
            }
            HookKind::PreToolUse => {
                settle(s, Activity::ToolRunning, self.tool.clone(), self.timestamp);
            }
            HookKind::PostToolUse => {
                if let Some(tool) = s.running_tools.values().next_back().cloned() {
                    settle(s, Activity::ToolRunning, Some(tool), self.timestamp);
                } else {
                    settle(s, Activity::Thinking, None, self.timestamp);
                }
            }
            HookKind::PostToolUseFailure => {
                if s.hook_waiting.pending() {
                    settle(s, Activity::Thinking, None, self.timestamp);
                } else {
                    s.attention(
                        AttentionState::Error,
                        "Tool failed; return to the terminal",
                        self.timestamp,
                    );
                }
            }
            HookKind::PermissionRequest => {
                if let Some(id) = &self.tool_use_id {
                    s.hook_waiting.permission_tools.insert(id.clone());
                } else {
                    // The official event has no call ID. Preserve every matching candidate;
                    // never let an unrelated parallel return resolve the permission wait.
                    let candidates: Vec<_> = s
                        .running_tools
                        .iter()
                        .filter(|(_, tool)| Some(*tool) == self.tool.as_ref())
                        .map(|(id, _)| id.clone())
                        .collect();
                    if candidates.is_empty() {
                        s.hook_waiting.uncorrelated_permission = true;
                    }
                    s.hook_waiting.permission_tools.extend(candidates);
                }
                // This hook also runs before auto-denial; only permission_prompt proves a UI wait.
            }
            HookKind::Notification => match self.notification_type.as_deref() {
                Some("permission_prompt") => {
                    if s.hook_waiting.permission_tools.is_empty() {
                        s.hook_waiting.uncorrelated_permission = true;
                    }
                    s.hook_waiting.permission_visible = true;
                    settle(s, Activity::Thinking, None, self.timestamp);
                }
                Some("idle_prompt") => {
                    s.hook_waiting.prompt = true;
                    settle(s, Activity::Thinking, None, self.timestamp);
                }
                _ => {}
            },
            HookKind::Stop => {
                s.running_tools.clear();
                s.hook_waiting = Default::default();
                s.attention(AttentionState::Done, "Task completed", self.timestamp);
            }
            HookKind::SessionEnd => return true,
            HookKind::PreCompact | HookKind::PostCompact => s.context = None,
            HookKind::StopFailure => {
                s.running_tools.clear();
                s.hook_waiting = Default::default();
                s.attention(
                    AttentionState::Error,
                    "Agent request failed",
                    self.timestamp,
                );
            }
            HookKind::Elicitation => {
                s.hook_waiting.elicitations += 1;
                settle(s, Activity::Thinking, None, self.timestamp);
            }
            HookKind::ElicitationResult => {
                if s.hook_waiting.elicitations > 0 {
                    s.hook_waiting.elicitations -= 1;
                }
                let tool = s.running_tools.values().next_back().cloned();
                let activity = if tool.is_some() {
                    Activity::ToolRunning
                } else {
                    Activity::Thinking
                };
                settle(s, activity, tool, self.timestamp);
            }
        }
        false
    }
}

fn settle(session: &mut Session, activity: Activity, tool: Option<String>, timestamp: i64) {
    if session.hook_waiting.pending() {
        let message = if session.hook_waiting.elicitations > 0 || session.hook_waiting.prompt {
            "Your input is needed"
        } else {
            "Permission required"
        };
        session.attention(AttentionState::WaitingUser, message, timestamp);
    } else {
        session.activity(activity, tool, timestamp);
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
        assert_eq!(s.attention.state, AttentionState::None);
        event.kind = HookKind::Notification;
        event.notification_type = Some("permission_prompt".into());
        event.apply(&mut s);
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

#[cfg(test)]
mod reliability_tests {
    use super::*;
    fn event(kind: &str, id: &str, timestamp: i64) -> HookEvent {
        let input = serde_json::json!({"hook_event_name":kind,"session_id":"parallel","cwd":"C:/fixture","tool_name":"Read","tool_use_id":id});
        let mut event = HookEvent::from_input(&serde_json::to_vec(&input).unwrap(), 1).unwrap();
        event.timestamp = timestamp;
        event
    }
    #[test]
    fn parallel_return_does_not_end_another_running_tool() {
        let mut session = Session::new("claude", "parallel", "C:/fixture", 0);
        event("PreToolUse", "a", 10).apply(&mut session);
        event("PreToolUse", "b", 11).apply(&mut session);
        event("PostToolUse", "a", 12).apply(&mut session);
        assert_eq!(session.runtime.state, Activity::ToolRunning);
        assert_eq!(session.running_tools.len(), 1);
        event("PostToolUse", "b", 13).apply(&mut session);
        assert_eq!(session.runtime.state, Activity::Thinking);
        assert!(session.running_tools.is_empty());
    }
    #[test]
    fn late_return_is_removed_from_inflight_without_rewinding_runtime() {
        let mut session = Session::new("claude", "parallel", "C:/fixture", 0);
        event("PreToolUse", "a", 10).apply(&mut session);
        event("PreToolUse", "b", 21).apply(&mut session);
        event("PostToolUse", "a", 20).apply(&mut session);
        assert_eq!(session.runtime.updated_at, 21);
        event("PostToolUse", "b", 22).apply(&mut session);
        assert_eq!(session.runtime.state, Activity::Thinking);
        assert!(session.running_tools.is_empty());
        assert!(!serde_json::to_string(&session)
            .unwrap()
            .contains("runningTools"));
    }
    #[test]
    fn compaction_is_telemetry_only_and_elicitation_result_releases_attention() {
        let mut session = Session::new("claude", "parallel", "C:/fixture", 0);
        event("Elicitation", "a", 10).apply(&mut session);
        assert_eq!(session.attention.state, AttentionState::WaitingUser);
        event("PostCompact", "a", 11).apply(&mut session);
        assert_eq!(session.attention.state, AttentionState::WaitingUser);
        event("ElicitationResult", "a", 12).apply(&mut session);
        assert_eq!(session.attention.state, AttentionState::None);
        event("StopFailure", "a", 13).apply(&mut session);
        assert_eq!(session.attention.state, AttentionState::Error);
    }
    #[test]
    fn unrelated_parallel_returns_cannot_release_permission_or_input_waits() {
        let mut session = Session::new("claude", "parallel", "C:/fixture", 0);
        event("PreToolUse", "a", 10).apply(&mut session);
        event("PreToolUse", "b", 11).apply(&mut session);
        event("PermissionRequest", "b", 12).apply(&mut session);
        let mut prompt = event("Notification", "b", 12);
        prompt.notification_type = Some("permission_prompt".into());
        prompt.apply(&mut session);
        event("PostToolUse", "a", 13).apply(&mut session);
        assert_eq!(session.attention.state, AttentionState::WaitingUser);
        event("Elicitation", "input", 14).apply(&mut session);
        event("PostToolUse", "b", 15).apply(&mut session);
        assert_eq!(session.attention.state, AttentionState::WaitingUser);
        event("ElicitationResult", "input", 16).apply(&mut session);
        assert_eq!(session.attention.state, AttentionState::None);
    }
    #[test]
    fn elicitation_result_restores_running_tool_and_keeps_other_input_requests() {
        let mut session = Session::new("claude", "parallel", "C:/fixture", 0);
        event("PreToolUse", "a", 10).apply(&mut session);
        event("Elicitation", "one", 11).apply(&mut session);
        event("Elicitation", "two", 12).apply(&mut session);
        event("ElicitationResult", "one", 13).apply(&mut session);
        assert_eq!(session.attention.state, AttentionState::WaitingUser);
        event("ElicitationResult", "two", 14).apply(&mut session);
        assert_eq!(session.attention.state, AttentionState::None);
        assert_eq!(session.runtime.state, Activity::ToolRunning);
    }
    #[test]
    fn official_permission_without_id_keeps_ambiguous_same_name_calls_pending() {
        let mut session = Session::new("claude", "parallel", "C:/fixture", 0);
        event("PreToolUse", "a", 10).apply(&mut session);
        event("PreToolUse", "b", 11).apply(&mut session);
        let mut permission = event("PermissionRequest", "unused", 12);
        permission.tool_use_id = None;
        permission.apply(&mut session);
        assert_eq!(session.attention.state, AttentionState::None);
        permission.kind = HookKind::Notification;
        permission.notification_type = Some("permission_prompt".into());
        permission.apply(&mut session);
        event("PostToolUse", "a", 13).apply(&mut session);
        assert_eq!(session.attention.state, AttentionState::WaitingUser);
        event("PostToolUse", "b", 14).apply(&mut session);
        assert_eq!(session.attention.state, AttentionState::None);
        assert!(!serde_json::to_string(&session)
            .unwrap()
            .contains("hookWaiting"));
    }
    #[test]
    fn a_later_permission_candidate_needs_its_own_visible_notification() {
        let mut session = Session::new("claude", "parallel", "C:/fixture", 0);
        event("PreToolUse", "a", 10).apply(&mut session);
        event("PermissionRequest", "a", 11).apply(&mut session);
        let mut prompt = event("Notification", "a", 12);
        prompt.notification_type = Some("permission_prompt".into());
        prompt.apply(&mut session);
        event("PostToolUse", "a", 13).apply(&mut session);
        event("PreToolUse", "b", 14).apply(&mut session);
        event("PermissionRequest", "b", 15).apply(&mut session);
        event("PreToolUse", "c", 16).apply(&mut session);
        assert_eq!(session.attention.state, AttentionState::None);
    }
    #[test]
    fn late_return_releases_resolved_attention_without_rewinding_runtime() {
        for kind in ["PostToolUse", "PostToolUseFailure"] {
            for other_running in [false, true] {
                let mut session = Session::new("claude", "parallel", "C:/fixture", 0);
                event("PreToolUse", "a", 10).apply(&mut session);
                event("PreToolUse", "b", 11).apply(&mut session);
                if other_running {
                    event("PreToolUse", "c", 11).apply(&mut session);
                }
                event("PermissionRequest", "a", 12).apply(&mut session);
                let mut prompt = event("Notification", "a", 13);
                prompt.notification_type = Some("permission_prompt".into());
                prompt.apply(&mut session);
                event("PostToolUse", "b", 15).apply(&mut session);
                assert_eq!(session.attention.state, AttentionState::WaitingUser);
                let started_at = session.runtime.started_at;
                event(kind, "a", 14).apply(&mut session);
                assert!(!session.hook_waiting.pending());
                assert_eq!(session.attention.state, AttentionState::None);
                assert_eq!(session.runtime.updated_at, 15);
                assert_eq!(session.runtime.started_at, started_at);
                assert_eq!(
                    session.runtime.state,
                    if other_running {
                        Activity::ToolRunning
                    } else {
                        Activity::Thinking
                    }
                );
            }
        }
    }
    #[test]
    fn late_return_preserves_pending_input_and_newer_done_or_error() {
        for newer in ["Elicitation", "Stop", "StopFailure"] {
            let mut session = Session::new("claude", "parallel", "C:/fixture", 0);
            event("PreToolUse", "a", 10).apply(&mut session);
            event("PermissionRequest", "a", 11).apply(&mut session);
            let mut prompt = event("Notification", "a", 12);
            prompt.notification_type = Some("permission_prompt".into());
            prompt.apply(&mut session);
            event(newer, "input", 15).apply(&mut session);
            let attention = session.attention.clone();
            let runtime = session.runtime.clone();
            event("PostToolUse", "a", 14).apply(&mut session);
            assert_eq!(session.attention, attention);
            assert_eq!(session.runtime, runtime);
        }
    }
}
