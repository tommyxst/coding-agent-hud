use crate::model::{Context, Model, Session, Tokens};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Default, Clone, Deserialize)]
struct Usage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
}

impl Usage {
    fn merge(&mut self, next: Self) {
        fn merge_value(current: &mut Option<u64>, next: Option<u64>) {
            if let Some(next) = next {
                *current = Some(match *current {
                    Some(previous) => previous.max(next),
                    None => next,
                });
            }
        }
        merge_value(&mut self.input_tokens, next.input_tokens);
        merge_value(&mut self.output_tokens, next.output_tokens);
        merge_value(
            &mut self.cache_creation_input_tokens,
            next.cache_creation_input_tokens,
        );
        merge_value(
            &mut self.cache_read_input_tokens,
            next.cache_read_input_tokens,
        );
    }

    fn context(&self) -> Result<Option<u64>, String> {
        match (
            self.input_tokens,
            self.cache_creation_input_tokens,
            self.cache_read_input_tokens,
        ) {
            (Some(input), Some(created), Some(cached)) => input
                .checked_add(created)
                .and_then(|sum| sum.checked_add(cached))
                .map(Some)
                .ok_or_else(|| "Claude context counter overflow".into()),
            _ => Ok(None),
        }
    }
}

#[derive(Deserialize)]
struct Message {
    id: String,
    model: String,
    usage: Option<Usage>,
}

// Deserialize only metadata. Prompt, content blocks and tool output are never retained.
#[derive(Deserialize)]
#[serde(tag = "type")]
enum Record {
    #[serde(rename = "assistant")]
    Assistant {
        #[serde(rename = "sessionId")]
        session_id: String,
        timestamp: String,
        message: Message,
    },
    #[serde(rename = "system")]
    System {
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
        subtype: Option<String>,
        timestamp: Option<String>,
    },
    #[serde(other)]
    Other,
}

#[derive(Default)]
pub struct Telemetry {
    requests: BTreeMap<String, Usage>,
    latest: Option<(i64, String, String)>,
    context_after: Option<i64>,
}

impl Telemetry {
    pub fn invalidate_context(&mut self, timestamp: i64) {
        self.context_after = Some(match self.context_after {
            Some(previous) => previous.max(timestamp),
            None => timestamp,
        });
    }

    pub fn consume(&mut self, session_id: &str, line: &[u8]) -> Result<(), String> {
        // Do not put serde's invalid-value text in diagnostics: it can contain user content.
        let record: Record = serde_json::from_slice(line)
            .map_err(|_| "invalid Claude telemetry record; no content logged".to_owned())?;
        match record {
            Record::Assistant {
                session_id: record_id,
                timestamp,
                message,
            } => {
                if record_id != session_id {
                    return Err("Claude transcript session does not match its Hook binding".into());
                }
                let Some(usage) = message.usage else {
                    return Ok(());
                };
                if message.id.is_empty() || message.model.is_empty() {
                    return Err("Claude telemetry is missing request identity".into());
                }
                let timestamp = timestamp_ms(&timestamp)?;
                self.requests
                    .entry(message.id.clone())
                    .or_default()
                    .merge(usage);
                if self
                    .latest
                    .as_ref()
                    .is_none_or(|(previous, _, _)| timestamp >= *previous)
                {
                    self.latest = Some((timestamp, message.id, message.model));
                }
            }
            Record::System {
                session_id: record_id,
                subtype,
                timestamp,
            } => {
                if subtype.as_deref() == Some("compact_boundary") {
                    if record_id.as_deref() != Some(session_id) {
                        return Err(
                            "Claude compaction session does not match its Hook binding".into()
                        );
                    }
                    let timestamp = timestamp.ok_or("Claude compaction is missing timestamp")?;
                    self.invalidate_context(timestamp_ms(&timestamp)?);
                }
            }
            Record::Other => {}
        }
        Ok(())
    }

    fn total(&self, field: impl Fn(&Usage) -> Option<u64>) -> Result<Option<u64>, String> {
        if self.requests.is_empty() {
            return Ok(None);
        }
        let mut total = 0_u64;
        for usage in self.requests.values() {
            let Some(value) = field(usage) else {
                return Ok(None);
            };
            total = total
                .checked_add(value)
                .ok_or("Claude token counter overflow")?;
        }
        Ok(Some(total))
    }

    pub fn apply(
        &self,
        session: &mut Session,
        model_updated_at: Option<i64>,
    ) -> Result<(), String> {
        let input = self.total(|usage| usage.input_tokens)?;
        let output = self.total(|usage| usage.output_tokens)?;
        let cached = self.total(|usage| usage.cache_read_input_tokens)?;
        // All counters are observed transcript totals, not an assumed complete billing history.
        session.tokens = if input.is_some() || output.is_some() || cached.is_some() {
            Some(Tokens {
                input,
                output,
                reasoning: None,
                cached,
            })
        } else {
            None
        };
        session.context = None;
        if let Some((timestamp, id, model)) = &self.latest {
            if model_updated_at.is_none_or(|updated| *timestamp >= updated) {
                session.model = Some(Model {
                    name: model.clone(),
                    provider: None,
                });
            }
            if self
                .context_after
                .is_none_or(|compacted| *timestamp > compacted)
            {
                let usage = self
                    .requests
                    .get(id)
                    .ok_or("Claude latest telemetry request missing")?;
                session.context = usage.context()?.map(|used| Context {
                    used,
                    limit: None,
                    estimated: true,
                });
            }
        }
        Ok(())
    }
}

fn timestamp_ms(value: &str) -> Result<i64, String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|time| time.timestamp_millis())
        .map_err(|_| "invalid Claude telemetry timestamp".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Activity, AttentionState};
    use serde_json::json;

    fn assistant(id: &str, seconds: u8, usage: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "type":"assistant", "sessionId":"fixture", "timestamp":format!("2026-10-15T01:00:{seconds:02}Z"),
            "message":{"id":id,"model":"fixture-model","content":[{"text":"PRIVATE BODY"}],"usage":usage}
        })).unwrap()
    }
    fn usage(input: u64, output: u64) -> serde_json::Value {
        json!({"input_tokens":input,"output_tokens":output,"cache_creation_input_tokens":20,"cache_read_input_tokens":30})
    }
    fn session() -> Session {
        Session::new("claude", "fixture", "C:/fixture", 0)
    }

    #[test]
    fn duplicate_stream_records_are_one_request_and_context_is_not_accumulated() {
        let mut telemetry = Telemetry::default();
        telemetry
            .consume("fixture", &assistant("one", 1, usage(100, 5)))
            .unwrap();
        telemetry
            .consume("fixture", &assistant("one", 2, usage(100, 9)))
            .unwrap();
        telemetry
            .consume("fixture", &assistant("one", 2, usage(100, 9)))
            .unwrap();
        telemetry
            .consume("fixture", &assistant("two", 3, usage(200, 11)))
            .unwrap();
        let mut session = session();
        telemetry.apply(&mut session, None).unwrap();
        let tokens = session.tokens.unwrap();
        assert_eq!(tokens.input, Some(300));
        assert_eq!(tokens.output, Some(20));
        assert_eq!(tokens.cached, Some(60));
        let context = session.context.unwrap();
        assert_eq!(context.used, 250);
        assert_eq!(context.limit, None);
        assert!(context.estimated);
    }
    #[test]
    fn telemetry_never_changes_runtime_attention_or_tools_and_drops_content() {
        let mut session = session();
        session.attention(AttentionState::WaitingUser, "fixture", 123);
        let before = session.clone();
        let mut telemetry = Telemetry::default();
        telemetry
            .consume("fixture", &assistant("one", 1, usage(100, 5)))
            .unwrap();
        telemetry.apply(&mut session, None).unwrap();
        assert_eq!(session.runtime, before.runtime);
        assert_eq!(session.attention, before.attention);
        assert_eq!(session.recent_tools, before.recent_tools);
        assert_eq!(session.runtime.state, Activity::Idle);
        assert!(!serde_json::to_string(&session)
            .unwrap()
            .contains("PRIVATE BODY"));
    }
    #[test]
    fn compaction_clears_context_until_new_request_and_keeps_observed_totals() {
        let mut telemetry = Telemetry::default();
        telemetry
            .consume("fixture", &assistant("one", 1, usage(100, 5)))
            .unwrap();
        telemetry.consume("fixture", br#"{"type":"system","sessionId":"fixture","subtype":"compact_boundary","timestamp":"2026-10-15T01:00:02Z"}"#).unwrap();
        let mut session = session();
        telemetry.apply(&mut session, None).unwrap();
        assert!(session.context.is_none());
        assert_eq!(session.tokens.as_ref().unwrap().input, Some(100));
        telemetry
            .consume("fixture", &assistant("two", 3, usage(10, 2)))
            .unwrap();
        telemetry.apply(&mut session, None).unwrap();
        assert_eq!(session.context.unwrap().used, 60);
    }
    #[test]
    fn missing_cache_data_stays_unknown_and_old_model_does_not_replace_hook_model() {
        let mut telemetry = Telemetry::default();
        telemetry
            .consume(
                "fixture",
                &assistant("one", 1, json!({"input_tokens":100,"output_tokens":5})),
            )
            .unwrap();
        let mut session = session();
        session.model = Some(Model {
            name: "new-model".into(),
            provider: None,
        });
        telemetry.apply(&mut session, Some(i64::MAX)).unwrap();
        assert!(session.context.is_none());
        assert_eq!(session.model.unwrap().name, "new-model");
        assert_eq!(session.tokens.unwrap().cached, None);
    }
    #[test]
    fn unrelated_sessions_invalid_counters_and_body_are_never_accepted_or_logged() {
        let mut telemetry = Telemetry::default();
        assert!(telemetry
            .consume("other", &assistant("one", 1, usage(100, 5)))
            .is_err());
        let error = telemetry
            .consume(
                "fixture",
                &assistant("one", 1, json!({"input_tokens":"PRIVATE VALUE"})),
            )
            .unwrap_err();
        assert!(!error.contains("PRIVATE"));
        assert!(telemetry.requests.is_empty());
        telemetry
            .consume(
                "fixture",
                br#"{"type":"user","message":{"content":"PRIVATE PROMPT"}}"#,
            )
            .unwrap();
        let mut session = session();
        telemetry.apply(&mut session, None).unwrap();
        assert!(session.tokens.is_none());
    }
    #[test]
    fn late_previous_request_does_not_rewind_context_and_counter_overflow_is_reported() {
        let mut telemetry = Telemetry::default();
        telemetry
            .consume("fixture", &assistant("new", 3, usage(200, 11)))
            .unwrap();
        telemetry
            .consume("fixture", &assistant("old", 1, usage(100, 5)))
            .unwrap();
        let mut session = session();
        telemetry.apply(&mut session, None).unwrap();
        assert_eq!(session.context.as_ref().unwrap().used, 250);
        telemetry
            .consume("fixture", &assistant("overflow", 4, usage(u64::MAX, 1)))
            .unwrap();
        assert!(telemetry.apply(&mut session, None).is_err());
    }
}
