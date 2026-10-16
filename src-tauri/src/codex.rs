use crate::model::{Activity, AttentionState, Context, Model, Session, Tokens, ToolStatus};
use serde_json::Value;

#[derive(Debug, PartialEq)]
pub enum Update {
    Unchanged,
    Changed,
    Ended,
}

pub fn apply(
    session: &mut Option<Session>,
    line: &[u8],
    show_detail: bool,
) -> Result<Update, String> {
    let record: Value =
        serde_json::from_slice(line).map_err(|e| format!("invalid rollout JSON: {e}"))?;
    let kind = required_string(&record, "type")?;
    let payload = &record["payload"];
    let timestamp = chrono::DateTime::parse_from_rfc3339(required_string(&record, "timestamp")?)
        .map_err(|e| format!("invalid rollout timestamp: {e}"))?
        .timestamp_millis();
    let before = session.clone();
    if kind == "session_meta" {
        let id = required_string(payload, "id")?;
        let cwd = required_string(payload, "cwd")?;
        if session
            .as_ref()
            .is_none_or(|s| s.id != format!("windows:codex:{id}"))
        {
            let mut new = Session::new("codex", id, cwd, timestamp);
            new.agent.version = string(payload, "cli_version");
            new.project.branch = string(&payload["git"], "branch");
            *session = Some(new);
        }
    } else if let Some(s) = session.as_mut() {
        if timestamp < s.runtime.updated_at {
            return Ok(Update::Unchanged);
        }
        observe_tool(s, kind, payload, timestamp);
        match kind {
            "turn_context" => {
                s.model = Some(Model {
                    name: required_string(payload, "model")?.into(),
                    provider: None,
                });
            }
            "compacted" => {
                s.context = None;
            }
            "event_msg" => match required_string(payload, "type")? {
                "task_started" | "turn_started" | "user_message" => {
                    s.activity(Activity::Thinking, None, timestamp);
                    s.runtime.started_at = timestamp;
                }
                "task_complete" | "turn_complete" => {
                    if payload.get("error").is_some_and(|v| !v.is_null()) {
                        s.attention(
                            AttentionState::Error,
                            "Turn failed; return to the terminal",
                            timestamp,
                        );
                    } else {
                        s.attention(AttentionState::Done, "Turn ended", timestamp);
                    }
                }
                "error" => s.attention(AttentionState::Error, "Agent reported an error", timestamp),
                "exec_approval_request"
                | "apply_patch_approval_request"
                | "request_permissions" => s.attention(
                    AttentionState::WaitingUser,
                    "Permission required",
                    timestamp,
                ),
                "request_user_input" | "elicitation_request" => s.attention(
                    AttentionState::WaitingUser,
                    "Your input is needed",
                    timestamp,
                ),
                "agent_reasoning" | "agent_reasoning_raw_content" | "reasoning_content_delta" => {
                    s.activity(Activity::Thinking, None, timestamp)
                }
                "agent_message" | "agent_message_content_delta" => {
                    s.activity(Activity::Responding, None, timestamp)
                }
                "exec_command_begin" => {
                    s.activity(Activity::ToolRunning, Some("Bash".into()), timestamp);
                    if show_detail {
                        s.runtime.detail = payload["command"].as_array().map(|parts| {
                            parts
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(" ")
                        });
                    }
                }
                "mcp_tool_call_begin" => {
                    s.activity(Activity::ToolRunning, Some("MCP".into()), timestamp)
                }
                "web_search_begin" => {
                    s.activity(Activity::ToolRunning, Some("Search".into()), timestamp)
                }
                "patch_apply_begin" => {
                    s.activity(Activity::ToolRunning, Some("Edit".into()), timestamp)
                }
                "exec_command_end" => {
                    if payload["exit_code"].as_i64().is_some_and(|n| n != 0) {
                        s.attention(AttentionState::Error, "Shell command failed", timestamp);
                    } else {
                        s.activity(Activity::Thinking, None, timestamp);
                    }
                }
                "mcp_tool_call_end" | "web_search_end" | "patch_apply_end" => {
                    s.activity(Activity::Thinking, None, timestamp)
                }
                "token_count" => {
                    let info = &payload["info"];
                    if info.is_object() {
                        let total = &info["total_token_usage"];
                        s.tokens = Some(Tokens {
                            input: total["input_tokens"].as_u64(),
                            output: total["output_tokens"].as_u64(),
                            reasoning: total["reasoning_output_tokens"].as_u64(),
                            cached: total["cached_input_tokens"].as_u64(),
                        });
                        // Codex reports last request usage separately from accumulated usage.
                        // This is an estimate of the last context, not a live context measurement.
                        s.context = info["last_token_usage"]["total_tokens"]
                            .as_u64()
                            .map(|used| Context {
                                used,
                                limit: info["model_context_window"].as_u64(),
                                estimated: true,
                            });
                    } else {
                        s.tokens = None;
                        s.context = None;
                    }
                }
                "context_compacted" => {
                    s.context = None;
                }
                "turn_aborted" => s.activity(Activity::Idle, None, timestamp),
                "shutdown_complete" => return Ok(Update::Ended),
                "thread_settings_applied" => {
                    let settings = &payload["thread_settings"];
                    s.model = Some(Model {
                        name: required_string(settings, "model")?.into(),
                        provider: string(settings, "model_provider_id"),
                    });
                }
                "item_completed" => completed_item(s, &payload["item"], timestamp),
                _ => {}
            },
            "response_item" => match payload["type"].as_str() {
                Some("function_call" | "custom_tool_call") => {
                    s.activity(Activity::ToolRunning, string(payload, "name"), timestamp);
                }
                Some("function_call_output" | "custom_tool_call_output") => {
                    s.activity(Activity::Thinking, None, timestamp)
                }
                Some("context_compaction" | "compaction") => {
                    s.context = None;
                }
                Some("reasoning") => s.activity(Activity::Thinking, None, timestamp),
                Some("message") if payload["role"] == "assistant" => {
                    s.activity(Activity::Responding, None, timestamp)
                }
                _ => {}
            },
            _ => {}
        }
    }
    Ok(if *session != before {
        Update::Changed
    } else {
        Update::Unchanged
    })
}

fn observe_tool(session: &mut Session, kind: &str, payload: &Value, timestamp: i64) {
    let event = payload["type"].as_str().unwrap_or("");
    let (value, name, status) = match (kind, event) {
        ("response_item", "function_call" | "custom_tool_call") => {
            (payload, string(payload, "name"), ToolStatus::Observed)
        }
        ("response_item", "function_call_output" | "custom_tool_call_output") => {
            (payload, None, ToolStatus::Returned)
        }
        ("event_msg", "exec_command_begin") => (payload, Some("Bash".into()), ToolStatus::Observed),
        ("event_msg", "mcp_tool_call_begin") => (payload, Some("MCP".into()), ToolStatus::Observed),
        ("event_msg", "web_search_begin") => (payload, Some("Search".into()), ToolStatus::Observed),
        ("event_msg", "patch_apply_begin") => (payload, Some("Edit".into()), ToolStatus::Observed),
        ("event_msg", "exec_command_end") => (
            payload,
            Some("Bash".into()),
            if payload["exit_code"].as_i64().is_some_and(|code| code != 0) {
                ToolStatus::Failed
            } else {
                ToolStatus::Returned
            },
        ),
        ("event_msg", "mcp_tool_call_end" | "web_search_end" | "patch_apply_end") => {
            (payload, None, ToolStatus::Returned)
        }
        ("event_msg", "item_completed") => {
            let item = &payload["item"];
            let name = match item["type"].as_str() {
                Some("CommandExecution") => "Bash",
                Some("McpToolCall" | "DynamicToolCall") => "MCP",
                Some("FileChange") => "Edit",
                Some("WebSearch") => "Search",
                _ => return,
            };
            let status = match item["status"].as_str() {
                Some("failed" | "declined") => ToolStatus::Failed,
                Some("completed") => ToolStatus::Returned,
                _ => ToolStatus::Observed,
            };
            (item, Some(name.into()), status)
        }
        _ => return,
    };
    let id = string(value, "call_id").or_else(|| string(value, "id"));
    let name = name
        .or_else(|| {
            id.as_ref().and_then(|id| {
                session
                    .recent_tools
                    .iter()
                    .find(|tool| &tool.id == id)
                    .map(|tool| tool.name.clone())
            })
        })
        .unwrap_or_else(|| "Tool".into());
    // Without a call ID, begin/end cannot be correlated; retain separate observations.
    let id = id.unwrap_or_else(|| format!("{event}:{timestamp}:{name}"));
    session.observe_tool(id, name, status, timestamp);
}

fn completed_item(session: &mut Session, item: &Value, timestamp: i64) {
    match item["type"].as_str() {
        Some("UserMessage" | "Reasoning") => session.activity(Activity::Thinking, None, timestamp),
        Some("AgentMessage" | "Plan") => session.activity(Activity::Responding, None, timestamp),
        Some("CommandExecution") if item["status"] == "failed" || item["status"] == "declined" => {
            session.attention(
                AttentionState::Error,
                "Command failed or was declined",
                timestamp,
            )
        }
        Some(
            "CommandExecution" | "McpToolCall" | "DynamicToolCall" | "FileChange" | "WebSearch",
        ) => session.activity(Activity::Thinking, None, timestamp),
        Some("ContextCompaction") => {
            session.context = None;
        }
        _ => {}
    }
}

fn string(v: &Value, key: &str) -> Option<String> {
    v[key].as_str().map(str::to_owned)
}
fn required_string<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("rollout missing {key}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn record(kind: &str, payload: Value) -> Vec<u8> {
        serde_json::to_vec(
            &json!({"timestamp":"2026-10-14T08:00:00Z", "type":kind, "payload":payload}),
        )
        .unwrap()
    }
    #[test]
    fn duplicate_end_is_unchanged_and_old_end_cannot_finish_a_new_turn() {
        for end in ["task_complete", "turn_complete"] {
            let mut s = session();
            let ended = record("event_msg", json!({"type":end}));
            assert_eq!(apply(&mut s, &ended, false).unwrap(), Update::Changed);
            assert_eq!(apply(&mut s, &ended, false).unwrap(), Update::Unchanged);
            let active = serde_json::to_vec(&json!({
                "timestamp":"2026-10-14T08:01:00Z", "type":"event_msg",
                "payload":{"type":"turn_started"}
            }))
            .unwrap();
            apply(&mut s, &active, false).unwrap();
            let before = s.clone();
            assert_eq!(apply(&mut s, &ended, false).unwrap(), Update::Unchanged);
            assert_eq!(s, before);
            assert_eq!(s.unwrap().attention.state, AttentionState::None);
        }
    }
    fn session() -> Option<Session> {
        let mut s = None;
        apply(
            &mut s,
            &record(
                "session_meta",
                json!({"id":"test", "cwd":"C:\\repos\\demo", "cli_version":"0.162.1"}),
            ),
            false,
        )
        .unwrap();
        s
    }
    #[test]
    fn tool_call_is_not_approval_and_body_is_not_retained() {
        let mut s = session();
        apply(
            &mut s,
            &record(
                "response_item",
                json!({"type":"function_call", "name":"exec_command", "arguments":"SECRET"}),
            ),
            false,
        )
        .unwrap();
        assert_eq!(s.as_ref().unwrap().runtime.state, Activity::ToolRunning);
        assert_eq!(s.as_ref().unwrap().attention.state, AttentionState::None);
        assert!(!serde_json::to_string(&s).unwrap().contains("SECRET"));
    }
    #[test]
    fn approval_done_error_and_end() {
        let mut s = session();
        apply(
            &mut s,
            &record("event_msg", json!({"type":"exec_approval_request"})),
            false,
        )
        .unwrap();
        assert_eq!(
            s.as_ref().unwrap().attention.state,
            AttentionState::WaitingUser
        );
        apply(
            &mut s,
            &record(
                "event_msg",
                json!({"type":"task_complete","last_agent_message":"SECRET"}),
            ),
            false,
        )
        .unwrap();
        assert_eq!(s.as_ref().unwrap().attention.state, AttentionState::Done);
        assert_eq!(
            s.as_ref().unwrap().attention.message.as_deref(),
            Some("Turn ended")
        );
        assert!(!serde_json::to_string(&s).unwrap().contains("SECRET"));
        apply(
            &mut s,
            &record(
                "event_msg",
                json!({"type":"task_complete","error":{"message":"PRIVATE ERROR"}}),
            ),
            false,
        )
        .unwrap();
        assert_eq!(s.as_ref().unwrap().attention.state, AttentionState::Error);
        assert_eq!(
            apply(
                &mut s,
                &record("event_msg", json!({"type":"shutdown_complete"})),
                false
            )
            .unwrap(),
            Update::Ended
        );
    }
    #[test]
    fn cumulative_usage_is_not_context_and_duplicate_is_idempotent() {
        let mut s = session();
        let line = record(
            "event_msg",
            json!({"type":"token_count", "info":{
                "total_token_usage":{"input_tokens":500000,"output_tokens":30000},
                "last_token_usage":{"total_tokens":42000}, "model_context_window":200000
            }}),
        );
        apply(&mut s, &line, false).unwrap();
        assert_eq!(
            s.as_ref().unwrap().tokens.as_ref().unwrap().input,
            Some(500000)
        );
        assert_eq!(s.as_ref().unwrap().context.as_ref().unwrap().used, 42000);
        assert!(s.as_ref().unwrap().context.as_ref().unwrap().estimated);
        assert_eq!(apply(&mut s, &line, false).unwrap(), Update::Unchanged);
    }
    #[test]
    fn unknown_usage_and_compaction_clear_context() {
        let mut s = session();
        apply(
            &mut s,
            &record("event_msg", json!({"type":"token_count","info":null})),
            false,
        )
        .unwrap();
        assert!(s.as_ref().unwrap().tokens.is_none());
        assert!(s.as_ref().unwrap().context.is_none());
        apply(
            &mut s,
            &record(
                "event_msg",
                json!({"type":"token_count","info":{"last_token_usage":{"total_tokens":42}}}),
            ),
            false,
        )
        .unwrap();
        apply(
            &mut s,
            &record("event_msg", json!({"type":"context_compacted"})),
            false,
        )
        .unwrap();
        assert!(s.as_ref().unwrap().context.is_none());
    }
    #[test]
    fn both_turn_event_names_supported_and_resume_keeps_usage() {
        let mut s = session();
        apply(
            &mut s,
            &record("event_msg", json!({"type":"turn_started"})),
            false,
        )
        .unwrap();
        assert_eq!(s.as_ref().unwrap().runtime.state, Activity::Thinking);
        apply(
            &mut s,
            &record("event_msg", json!({"type":"turn_complete"})),
            false,
        )
        .unwrap();
        assert_eq!(s.as_ref().unwrap().attention.state, AttentionState::Done);
        assert_eq!(
            apply(
                &mut s,
                &record("session_meta", json!({"id":"test","cwd":"C:\\repos\\demo"})),
                false
            )
            .unwrap(),
            Update::Unchanged
        );
    }
    #[test]
    fn malformed_records_report_error_without_content() {
        let mut s = session();
        let error = apply(&mut s, b"PRIVATE INVALID JSON", false).unwrap_err();
        assert!(!error.contains("PRIVATE"));
    }
}

#[cfg(test)]
mod current_format_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn current_completed_item_and_compaction_are_supported() {
        let mut session = Some(Session::new("codex", "current", "C:/demo", 0));
        session.as_mut().unwrap().context = Some(Context {
            used: 42,
            limit: None,
            estimated: true,
        });
        let record = json!({"timestamp":"2026-10-14T08:01:00Z","type":"event_msg", "payload":{
            "type":"item_completed","item":{"type":"CommandExecution", "status":"failed","aggregated_output":"PRIVATE"}
        }});
        apply(&mut session, &serde_json::to_vec(&record).unwrap(), false).unwrap();
        assert_eq!(
            session.as_ref().unwrap().attention.state,
            AttentionState::Error
        );
        assert!(!serde_json::to_string(&session).unwrap().contains("PRIVATE"));
        let compacted = json!({"timestamp":"2026-10-14T08:01:01Z","type":"compacted","payload":{"replacement_history":"PRIVATE"}});
        apply(
            &mut session,
            &serde_json::to_vec(&compacted).unwrap(),
            false,
        )
        .unwrap();
        assert!(session.as_ref().unwrap().context.is_none());
    }
    #[test]
    fn unknown_new_usage_does_not_leave_stale_statistics() {
        let mut session = Some(Session::new("codex", "current", "C:/demo", 0));
        session.as_mut().unwrap().context = Some(Context {
            used: 42,
            limit: None,
            estimated: true,
        });
        let record = json!({"timestamp":"2026-10-14T08:01:00Z","type":"event_msg","payload":{"type":"token_count","info":null}});
        apply(&mut session, &serde_json::to_vec(&record).unwrap(), false).unwrap();
        assert!(session.as_ref().unwrap().context.is_none());
        assert!(session.as_ref().unwrap().tokens.is_none());
    }
}

#[cfg(test)]
mod observation_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_short_tool_survives_a_batch_without_faking_running_or_retaining_content() {
        let mut session = Some(Session::new("codex", "batch", "C:/fixture", 0));
        for payload in [
            json!({"type":"function_call","call_id":"call1","name":"Read","arguments":"PRIVATE"}),
            json!({"type":"function_call_output","call_id":"call1","output":"SECRET"}),
            json!({"type":"reasoning","summary":"SECRET"}),
        ] {
            let record = json!({"type":"response_item","timestamp":"2026-10-14T00:00:00Z","payload":payload});
            apply(&mut session, &serde_json::to_vec(&record).unwrap(), false).unwrap();
        }
        let session = session.unwrap();
        assert_eq!(session.runtime.state, Activity::Thinking);
        assert_eq!(session.recent_tools.len(), 1);
        assert_eq!(session.recent_tools[0].name, "Read");
        assert_eq!(session.recent_tools[0].status, ToolStatus::Returned);
        let serialized = serde_json::to_string(&session).unwrap();
        assert!(!serialized.contains("PRIVATE"));
        assert!(!serialized.contains("SECRET"));
    }

    #[test]
    fn observations_are_bounded_deduplicated_and_require_an_explicit_return() {
        let mut session = Session::new("codex", "test", "C:/fixture", 0);
        session.observe_tool("first".into(), "Read".into(), ToolStatus::Observed, 1);
        session.activity(Activity::Thinking, None, 2);
        assert_eq!(session.recent_tools[0].status, ToolStatus::Observed);
        session.observe_tool("first".into(), "Read".into(), ToolStatus::Returned, 3);
        session.observe_tool("first".into(), "Read".into(), ToolStatus::Observed, 4);
        assert_eq!(session.recent_tools.len(), 1);
        assert_eq!(session.recent_tools[0].status, ToolStatus::Returned);
        for id in 0..20 {
            session.observe_tool(id.to_string(), "Read".into(), ToolStatus::Observed, id);
        }
        assert_eq!(session.recent_tools.len(), crate::model::RECENT_TOOL_LIMIT);
    }
}
