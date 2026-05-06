use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use uuid::Uuid;

use super::agent::AgentId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    Shell,
    Agent,
    Remote,
    Workflow,
    Dream,
    Monitor,
    Scheduled,
}

impl TaskType {
    pub fn prefix(&self) -> char {
        match self {
            Self::Shell => 'b',
            Self::Agent => 'a',
            Self::Remote => 'r',
            Self::Workflow => 'w',
            Self::Dream => 'd',
            Self::Monitor => 'm',
            Self::Scheduled => 's',
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Killed,
    Paused,
}

impl TaskStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Killed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_creation_tokens: u64,
}

impl Default for TokenUsage {
    fn default() -> Self {
        Self {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
        }
    }
}

impl TokenUsage {
    pub fn accumulate(&mut self, other: &TokenUsage) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_creation_tokens += other.cache_creation_tokens;
    }

    pub fn total_tokens(&self) -> u64 {
        self.input_tokens + self.output_tokens
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskState {
    pub id: String,
    pub task_type: TaskType,
    pub status: TaskStatus,
    pub description: String,

    pub agent_id: Option<AgentId>,
    pub agent_type: Option<String>,
    pub parent_id: Option<String>,

    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,

    pub output_file: PathBuf,
    pub output_offset: u64,

    pub token_usage: TokenUsage,
    pub cost_usd: f64,

    pub notified: bool,
    pub error: Option<String>,
    pub result_summary: Option<String>,

    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
}

const TASK_ID_ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

pub fn generate_task_id(task_type: TaskType) -> String {
    let prefix = task_type.prefix();
    let uuid_bytes = Uuid::new_v4().into_bytes();
    let mut id = String::with_capacity(9);
    id.push(prefix);
    for i in 0..8 {
        let idx = (uuid_bytes[i] as usize) % TASK_ID_ALPHABET.len();
        id.push(TASK_ID_ALPHABET[idx] as char);
    }
    id
}

impl TaskState {
    pub fn new(task_type: TaskType, description: impl Into<String>) -> Self {
        let id = generate_task_id(task_type);
        let output_file = PathBuf::from(format!(".agent-tasks/{}.output", &id));
        Self {
            id,
            task_type,
            status: TaskStatus::Pending,
            description: description.into(),
            agent_id: None,
            agent_type: None,
            parent_id: None,
            started_at: Utc::now(),
            ended_at: None,
            output_file,
            output_offset: 0,
            token_usage: TokenUsage::default(),
            cost_usd: 0.0,
            notified: false,
            error: None,
            result_summary: None,
            metadata: HashMap::new(),
        }
    }

    pub fn with_agent(mut self, agent_id: AgentId, agent_type: impl Into<String>) -> Self {
        self.agent_id = Some(agent_id);
        self.agent_type = Some(agent_type.into());
        self
    }

    pub fn with_parent(mut self, parent_id: impl Into<String>) -> Self {
        self.parent_id = Some(parent_id.into());
        self
    }

    pub fn mark_running(&mut self) {
        self.status = TaskStatus::Running;
    }

    pub fn mark_completed(&mut self, summary: Option<String>) {
        self.status = TaskStatus::Completed;
        self.ended_at = Some(Utc::now());
        self.result_summary = summary;
    }

    pub fn mark_failed(&mut self, error: impl Into<String>) {
        self.status = TaskStatus::Failed;
        self.ended_at = Some(Utc::now());
        self.error = Some(error.into());
    }

    pub fn mark_killed(&mut self) {
        self.status = TaskStatus::Killed;
        self.ended_at = Some(Utc::now());
    }

    pub fn elapsed_ms(&self) -> i64 {
        let end = self.ended_at.unwrap_or_else(Utc::now);
        (end - self.started_at).num_milliseconds()
    }
}
