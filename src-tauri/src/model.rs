use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Activity {
    Starting,
    Idle,
    Thinking,
    ToolRunning,
    Responding,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AttentionState {
    None,
    WaitingUser,
    Done,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub environment: Environment,
    pub agent: Agent,
    pub project: Project,
    pub runtime: Runtime,
    pub attention: Attention,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<Model>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<Context>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<Tokens>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<Workspace>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Environment {
    pub r#type: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Agent {
    pub r#type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub cwd: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    pub state: Activity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub started_at: i64,
    pub updated_at: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Attention {
    pub state: AttentionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Model {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Context {
    pub used: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    pub estimated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Tokens {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub agent_pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_type: Option<String>,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CollectorStatus {
    pub agent: String,
    pub state: String,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct Snapshot {
    pub sessions: Vec<Session>,
    pub collectors: Vec<CollectorStatus>,
}

impl Session {
    pub fn new(agent: &str, native_id: &str, cwd: &str, timestamp: i64) -> Self {
        let name = cwd
            .trim_end_matches(['/', '\\'])
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(cwd)
            .to_owned();
        Self {
            id: format!("windows:{agent}:{native_id}"),
            environment: Environment {
                r#type: "windows".into(),
            },
            agent: Agent {
                r#type: agent.into(),
                name: if agent == "claude" {
                    "Claude Code"
                } else {
                    "Codex"
                }
                .into(),
                version: None,
            },
            project: Project {
                cwd: cwd.into(),
                name,
                root: None,
                branch: None,
            },
            runtime: Runtime {
                state: Activity::Starting,
                tool: None,
                detail: None,
                started_at: timestamp,
                updated_at: timestamp,
            },
            attention: Attention {
                state: AttentionState::None,
                message: None,
            },
            model: None,
            context: None,
            tokens: None,
            workspace: None,
        }
    }

    pub fn activity(&mut self, state: Activity, tool: Option<String>, timestamp: i64) {
        self.runtime.state = state;
        self.runtime.tool = tool;
        self.runtime.detail = None;
        self.runtime.updated_at = timestamp;
        self.attention = Attention {
            state: AttentionState::None,
            message: None,
        };
    }

    pub fn attention(&mut self, state: AttentionState, message: &str, timestamp: i64) {
        self.runtime.state = Activity::Idle;
        self.runtime.tool = None;
        self.runtime.detail = None;
        self.runtime.updated_at = timestamp;
        self.attention = Attention {
            state,
            message: Some(message.into()),
        };
    }
}
