use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::agent::AgentId;
use super::task::{TaskState, TaskStatus, TokenUsage};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", content = "data")]
#[serde(rename_all = "snake_case")]
pub enum AppEvent {
    TaskCreated(TaskState),

    TaskUpdated {
        task_id: String,
        status: TaskStatus,
        #[serde(default)]
        output_delta: Option<String>,
    },

    TaskCompleted {
        task_id: String,
        result_summary: Option<String>,
        cost_usd: f64,
    },

    TaskFailed {
        task_id: String,
        error: String,
    },

    AgentSpawned {
        agent_id: AgentId,
        agent_type: String,
        task_id: String,
        display_name: String,
    },

    AgentMessage {
        from: AgentId,
        to: AgentId,
        content: String,
    },

    PermissionRequest {
        request_id: String,
        agent_id: AgentId,
        task_id: String,
        tool_name: String,
        input_summary: String,
    },

    PermissionResponse {
        request_id: String,
        approved: bool,
    },

    MemoryUpdated {
        agent_type: String,
        file_path: String,
    },

    TokenUsageReport {
        agent_id: AgentId,
        task_id: String,
        usage: TokenUsage,
        cost_usd: f64,
    },

    Notification {
        level: NotificationLevel,
        title: String,
        body: String,
    },

    DreamStarted {
        task_id: String,
    },

    DreamCompleted {
        task_id: String,
        files_updated: Vec<String>,
    },

    CoordinatorWorkerSpawned {
        coordinator_task_id: String,
        worker_task_id: String,
        worker_description: String,
    },

    CoordinatorWorkerCompleted {
        coordinator_task_id: String,
        worker_task_id: String,
        success: bool,
    },

    AgentCompleted {
        agent_id: AgentId,
        task_id: String,
        result: String,
    },

    AgentFailed {
        agent_id: AgentId,
        task_id: String,
        error: String,
    },

    HookFired {
        event_name: String,
        matcher: Option<String>,
        blocked: bool,
    },

    AuditEntry {
        event_type: String,
        detail: String,
    },

    WorktreeCreated {
        branch: String,
        path: String,
    },

    WorktreeRemoved {
        branch: String,
    },

    McpServerConnected {
        server_name: String,
        tool_count: usize,
    },

    McpServerDisconnected {
        server_name: String,
    },

    McpToolCalled {
        server_name: String,
        tool_name: String,
        success: bool,
    },

    SkillLoaded {
        skill_name: String,
        source: String,
    },

    SkillInvoked {
        skill_name: String,
        is_fork: bool,
    },

    ContextCompacted {
        trigger: String,
        original_tokens: usize,
        summary_tokens: usize,
        tokens_freed: usize,
        messages_removed: usize,
    },

    ToolResultOffloaded {
        tool_name: String,
        original_chars: usize,
        storage_path: String,
    },

    HitlQuestionAsked {
        interaction_id: String,
        interaction_type: String,
        session_id: String,
        question_count: usize,
    },

    HitlQuestionAnswered {
        interaction_id: String,
        interaction_type: String,
    },

    HitlQuestionTimedOut {
        interaction_id: String,
        interaction_type: String,
    },

    HitlQuestionCancelled {
        interaction_id: String,
    },

    OrchestratorSessionStarted {
        session_id: String,
        task_count: usize,
        total_waves: u32,
    },

    OrchestratorWaveStarted {
        session_id: String,
        wave: u32,
        task_ids: Vec<String>,
    },

    OrchestratorTaskCompleted {
        session_id: String,
        task_id: String,
        success: bool,
        cost_usd: f64,
    },

    OrchestratorSessionCompleted {
        session_id: String,
        total_tasks: usize,
        completed: usize,
        failed: usize,
        total_cost_usd: f64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationLevel {
    Info,
    Warning,
    Error,
    Success,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimestampedEvent {
    #[serde(flatten)]
    pub event: AppEvent,
    pub timestamp: DateTime<Utc>,
}

impl TimestampedEvent {
    pub fn new(event: AppEvent) -> Self {
        Self {
            event,
            timestamp: Utc::now(),
        }
    }
}
