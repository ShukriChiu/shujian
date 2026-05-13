use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AgentId(pub Uuid);

impl AgentId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl fmt::Display for AgentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl Default for AgentId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSource {
    BuiltIn,
    Custom,
    Plugin { plugin_name: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffortLevel {
    Min,
    Low,
    Medium,
    High,
    Max,
}

impl Default for EffortLevel {
    fn default() -> Self {
        Self::Medium
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScope {
    User,
    Project,
    Local,
    None,
}

impl Default for MemoryScope {
    fn default() -> Self {
        Self::Project
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IsolationMode {
    None,
    Worktree,
    Container,
}

impl Default for IsolationMode {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoleLevel {
    Operator,
    Analyst,
    Manager,
    Director,
}

impl Default for RoleLevel {
    fn default() -> Self {
        Self::Operator
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentColor {
    Red,
    Orange,
    Amber,
    Yellow,
    Lime,
    Green,
    Emerald,
    Teal,
    Cyan,
    Sky,
    Blue,
    Indigo,
    Violet,
    Purple,
    Fuchsia,
    Pink,
    Rose,
}

impl AgentColor {
    pub fn hex(&self) -> &'static str {
        match self {
            Self::Red => "#EF4444",
            Self::Orange => "#F97316",
            Self::Amber => "#F59E0B",
            Self::Yellow => "#EAB308",
            Self::Lime => "#84CC16",
            Self::Green => "#22C55E",
            Self::Emerald => "#10B981",
            Self::Teal => "#14B8A6",
            Self::Cyan => "#06B6D4",
            Self::Sky => "#0EA5E9",
            Self::Blue => "#3B82F6",
            Self::Indigo => "#6366F1",
            Self::Violet => "#8B5CF6",
            Self::Purple => "#A855F7",
            Self::Fuchsia => "#D946EF",
            Self::Pink => "#EC4899",
            Self::Rose => "#F43F5E",
        }
    }

    pub fn all() -> &'static [AgentColor] {
        &[
            Self::Blue,
            Self::Green,
            Self::Purple,
            Self::Orange,
            Self::Teal,
            Self::Pink,
            Self::Indigo,
            Self::Emerald,
            Self::Amber,
            Self::Cyan,
            Self::Red,
            Self::Violet,
            Self::Lime,
            Self::Rose,
            Self::Fuchsia,
            Self::Sky,
            Self::Yellow,
        ]
    }
}

use super::permission::PermissionMode;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDefinition {
    pub agent_type: String,
    pub display_name: String,
    pub description: String,
    pub source: AgentSource,

    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub model_category: Option<String>,
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    #[serde(default)]
    pub disallowed_tools: Option<Vec<String>>,
    #[serde(default)]
    pub skills: Option<Vec<String>>,

    #[serde(default)]
    pub permission_mode: PermissionMode,
    #[serde(default)]
    pub max_turns: Option<u32>,
    #[serde(default)]
    pub max_budget_usd: Option<f64>,
    #[serde(default)]
    pub effort: EffortLevel,

    #[serde(default)]
    pub memory_scope: MemoryScope,
    #[serde(default)]
    pub background: bool,
    #[serde(default)]
    pub isolation: IsolationMode,
    #[serde(default)]
    pub color: Option<AgentColor>,

    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub department: Option<String>,
    #[serde(default)]
    pub role_level: RoleLevel,

    #[serde(default)]
    pub workspace_path: Option<PathBuf>,

    #[serde(default)]
    pub hooks: Option<HooksConfig>,

    #[serde(skip)]
    pub system_prompt_fn: Option<fn() -> String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HooksConfig {
    #[serde(default)]
    pub pre_tool: Vec<HookEntry>,
    #[serde(default)]
    pub post_tool: Vec<HookEntry>,
    #[serde(default)]
    pub session_start: Vec<HookEntry>,
    #[serde(default)]
    pub session_end: Vec<HookEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookEntry {
    pub command: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub tool_filter: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRuntime {
    pub id: AgentId,
    pub definition: AgentDefinition,
    pub current_task_id: Option<String>,
    pub status: AgentRuntimeStatus,
    pub tasks_completed: u64,
    pub tasks_failed: u64,
    pub total_cost_usd: f64,
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimeStatus {
    Idle,
    Running,
    Paused,
    Completed,
    Failed,
    Error,
}

impl AgentRuntime {
    pub fn new(definition: AgentDefinition) -> Self {
        Self {
            id: AgentId::new(),
            definition,
            current_task_id: None,
            status: AgentRuntimeStatus::Idle,
            tasks_completed: 0,
            tasks_failed: 0,
            total_cost_usd: 0.0,
            metadata: HashMap::new(),
        }
    }
}
