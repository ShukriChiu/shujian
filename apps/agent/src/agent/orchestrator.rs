use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::{RwLock, Semaphore};
use tracing::{info, warn};
use uuid::Uuid;

use crate::streaming::events::{StreamEvent, StreamEventType};
use crate::streaming::sse::SseBroadcaster;
use crate::types::agent::AgentId;

/// The Orchestrator: Claude Code's fan-out/fan-in multi-agent coordinator.
///
/// Key design from Claude Code:
/// - Fan-out: spawn N subagents in parallel for independent tasks
/// - Fan-in: each returns only its summary, parent aggregates
/// - Three execution modes: Parallel / Sequential / Background
/// - Dependency tracking between tasks
/// - Independent failure domains (one failure doesn't cascade)
/// - Subagents cannot spawn further subagents (no nesting)
pub struct Orchestrator {
    config: OrchestratorConfig,
    semaphore: Arc<Semaphore>,
    sessions: RwLock<HashMap<String, OrchestratorSession>>,
    broadcaster: Arc<SseBroadcaster>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestratorConfig {
    pub max_concurrent_agents: usize,
    pub default_timeout_secs: u64,
    pub max_fan_out: usize,
    pub allow_nesting: bool,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            max_concurrent_agents: 8,
            default_timeout_secs: 900,
            max_fan_out: 10,
            allow_nesting: false,
        }
    }
}

/// An orchestration session managing a set of coordinated subtasks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestratorSession {
    pub id: String,
    pub parent_session_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub status: SessionStatus,
    pub tasks: Vec<SubTask>,
    pub execution_plan: ExecutionPlan,
    pub results: HashMap<String, SubTaskResult>,
    pub total_cost_usd: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Planning,
    Running,
    Completed,
    PartialFailure,
    Failed,
    Cancelled,
}

/// A single subtask within an orchestration session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubTask {
    pub id: String,
    pub description: String,
    pub agent_type: String,
    pub prompt: String,
    pub execution_mode: ExecutionMode,
    pub status: SubTaskStatus,
    /// Task IDs this subtask depends on (must complete before this starts).
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// Which wave this task belongs to (for parallel scheduling).
    pub wave: u32,
    /// The agent assigned to this task (set after spawn).
    pub agent_id: Option<AgentId>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub timeout_secs: u64,
    /// Whether this task runs in an isolated worktree.
    pub isolated: bool,
    /// Model override for this specific task.
    pub model: Option<String>,
    /// Restrict tool access for this task.
    pub allowed_tools: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    /// Run in parallel with other tasks in the same wave.
    Parallel,
    /// Run after all previous tasks complete.
    Sequential,
    /// Run in background, don't block the session.
    Background,
}

impl Default for ExecutionMode {
    fn default() -> Self {
        Self::Parallel
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubTaskStatus {
    Pending,
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
}

impl SubTaskStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            SubTaskStatus::Completed
                | SubTaskStatus::Failed
                | SubTaskStatus::Cancelled
                | SubTaskStatus::TimedOut
        )
    }
}

/// The result of a completed subtask.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubTaskResult {
    pub task_id: String,
    pub success: bool,
    pub summary: String,
    pub cost_usd: f64,
    pub duration_ms: u64,
    pub error: Option<String>,
}

/// Execution plan derived from task dependencies.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionPlan {
    /// Tasks grouped by execution wave.
    /// Wave 0 runs first, wave 1 runs after wave 0 completes, etc.
    pub waves: Vec<Vec<String>>,
    /// Total estimated waves.
    pub total_waves: u32,
}

/// Builder for constructing orchestration sessions.
pub struct OrchestratorBuilder {
    description: String,
    parent_session: Option<String>,
    tasks: Vec<SubTaskBuilder>,
}

struct SubTaskBuilder {
    description: String,
    agent_type: String,
    prompt: String,
    mode: ExecutionMode,
    depends_on: Vec<String>,
    isolated: bool,
    model: Option<String>,
    timeout_secs: Option<u64>,
    allowed_tools: Option<Vec<String>>,
}

impl OrchestratorBuilder {
    pub fn new(description: &str) -> Self {
        Self {
            description: description.to_string(),
            parent_session: None,
            tasks: Vec::new(),
        }
    }

    pub fn parent_session(mut self, session_id: &str) -> Self {
        self.parent_session = Some(session_id.to_string());
        self
    }

    /// Add a parallel subtask.
    pub fn parallel(
        mut self,
        id: &str,
        agent_type: &str,
        description: &str,
        prompt: &str,
    ) -> Self {
        self.tasks.push(SubTaskBuilder {
            description: description.to_string(),
            agent_type: agent_type.to_string(),
            prompt: prompt.to_string(),
            mode: ExecutionMode::Parallel,
            depends_on: vec![],
            isolated: false,
            model: None,
            timeout_secs: None,
            allowed_tools: None,
        });
        // Store the ID for reference
        if let Some(last) = self.tasks.last_mut() {
            last.description = format!("{}:{}", id, description);
        }
        self
    }

    /// Add a sequential subtask that depends on previous tasks.
    pub fn sequential(
        mut self,
        id: &str,
        agent_type: &str,
        description: &str,
        prompt: &str,
        depends_on: Vec<&str>,
    ) -> Self {
        self.tasks.push(SubTaskBuilder {
            description: format!("{}:{}", id, description),
            agent_type: agent_type.to_string(),
            prompt: prompt.to_string(),
            mode: ExecutionMode::Sequential,
            depends_on: depends_on.into_iter().map(String::from).collect(),
            isolated: false,
            model: None,
            timeout_secs: None,
            allowed_tools: None,
        });
        self
    }

    /// Add a background subtask.
    pub fn background(
        mut self,
        id: &str,
        agent_type: &str,
        description: &str,
        prompt: &str,
    ) -> Self {
        self.tasks.push(SubTaskBuilder {
            description: format!("{}:{}", id, description),
            agent_type: agent_type.to_string(),
            prompt: prompt.to_string(),
            mode: ExecutionMode::Background,
            depends_on: vec![],
            isolated: false,
            model: None,
            timeout_secs: None,
            allowed_tools: None,
        });
        self
    }

    /// Set isolation for the last added task.
    pub fn with_isolation(mut self) -> Self {
        if let Some(last) = self.tasks.last_mut() {
            last.isolated = true;
        }
        self
    }

    /// Set model override for the last added task.
    pub fn with_model(mut self, model: &str) -> Self {
        if let Some(last) = self.tasks.last_mut() {
            last.model = Some(model.to_string());
        }
        self
    }

    /// Set tool restrictions for the last added task.
    pub fn with_tools(mut self, tools: Vec<&str>) -> Self {
        if let Some(last) = self.tasks.last_mut() {
            last.allowed_tools = Some(tools.into_iter().map(String::from).collect());
        }
        self
    }

    pub fn build(self, default_timeout: u64) -> OrchestratorSession {
        let session_id = Uuid::new_v4().to_string();

        let tasks: Vec<SubTask> = self
            .tasks
            .into_iter()
            .enumerate()
            .map(|(i, tb)| {
                let (task_id, desc) = if let Some((id, desc)) = tb.description.split_once(':') {
                    (id.to_string(), desc.to_string())
                } else {
                    (format!("task-{}", i), tb.description)
                };

                SubTask {
                    id: task_id,
                    description: desc,
                    agent_type: tb.agent_type,
                    prompt: tb.prompt,
                    execution_mode: tb.mode,
                    status: SubTaskStatus::Pending,
                    depends_on: tb.depends_on,
                    wave: 0,
                    agent_id: None,
                    created_at: Utc::now(),
                    started_at: None,
                    completed_at: None,
                    timeout_secs: tb.timeout_secs.unwrap_or(default_timeout),
                    isolated: tb.isolated,
                    model: tb.model,
                    allowed_tools: tb.allowed_tools,
                }
            })
            .collect();

        let plan = compute_execution_plan(&tasks);

        // Assign waves to tasks
        let mut tasks = tasks;
        for (wave_idx, wave_task_ids) in plan.waves.iter().enumerate() {
            for task_id in wave_task_ids {
                if let Some(task) = tasks.iter_mut().find(|t| &t.id == task_id) {
                    task.wave = wave_idx as u32;
                }
            }
        }

        OrchestratorSession {
            id: session_id,
            parent_session_id: self.parent_session,
            created_at: Utc::now(),
            status: SessionStatus::Planning,
            tasks,
            execution_plan: plan,
            results: HashMap::new(),
            total_cost_usd: 0.0,
        }
    }
}

/// Compute execution waves from task dependencies using topological sort.
fn compute_execution_plan(tasks: &[SubTask]) -> ExecutionPlan {
    let mut waves: Vec<Vec<String>> = Vec::new();
    let mut assigned: HashMap<String, u32> = HashMap::new();

    // Background tasks go to wave u32::MAX (run independently)
    let bg_tasks: Vec<String> = tasks
        .iter()
        .filter(|t| t.execution_mode == ExecutionMode::Background)
        .map(|t| t.id.clone())
        .collect();

    // For parallel/sequential tasks, compute waves based on dependencies
    let mut remaining: Vec<&SubTask> = tasks
        .iter()
        .filter(|t| t.execution_mode != ExecutionMode::Background)
        .collect();

    let mut wave_idx = 0u32;
    while !remaining.is_empty() {
        let ready: Vec<String> = remaining
            .iter()
            .filter(|t| {
                t.depends_on
                    .iter()
                    .all(|dep| assigned.contains_key(dep))
            })
            .map(|t| t.id.clone())
            .collect();

        if ready.is_empty() {
            // Circular dependency — force remaining into current wave
            warn!("Circular dependency detected, forcing remaining tasks into wave {}", wave_idx);
            let forced: Vec<String> = remaining.iter().map(|t| t.id.clone()).collect();
            for id in &forced {
                assigned.insert(id.clone(), wave_idx);
            }
            waves.push(forced);
            break;
        }

        for id in &ready {
            assigned.insert(id.clone(), wave_idx);
        }
        waves.push(ready.clone());

        remaining.retain(|t| !ready.contains(&t.id));
        wave_idx += 1;
    }

    // Background tasks as a separate "wave"
    if !bg_tasks.is_empty() {
        waves.push(bg_tasks);
    }

    ExecutionPlan {
        total_waves: waves.len() as u32,
        waves,
    }
}

impl Orchestrator {
    pub fn new(config: OrchestratorConfig, broadcaster: Arc<SseBroadcaster>) -> Self {
        let semaphore = Arc::new(Semaphore::new(config.max_concurrent_agents));
        Self {
            config,
            semaphore,
            sessions: RwLock::new(HashMap::new()),
            broadcaster,
        }
    }

    /// Submit an orchestration session and begin execution.
    ///
    /// Returns the session ID. Use `get_session()` to poll status.
    pub async fn submit(&self, mut session: OrchestratorSession) -> Result<String, OrchestratorError> {
        if session.tasks.len() > self.config.max_fan_out {
            return Err(OrchestratorError::TooManyTasks {
                max: self.config.max_fan_out,
                got: session.tasks.len(),
            });
        }

        session.status = SessionStatus::Running;
        let session_id = session.id.clone();

        self.sessions
            .write()
            .await
            .insert(session_id.clone(), session);

        self.broadcast_event(&session_id, "orchestrator_session_started", serde_json::json!({
            "session_id": session_id,
        })).await;

        info!(session_id = %session_id, "orchestrator session submitted");
        Ok(session_id)
    }

    /// Execute the next wave of tasks for a session.
    ///
    /// Called by the agent runtime loop. Returns the tasks that should be spawned.
    pub async fn next_wave(&self, session_id: &str) -> Result<Vec<SubTask>, OrchestratorError> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| OrchestratorError::SessionNotFound {
                id: session_id.to_string(),
            })?;

        // Find the current wave (lowest wave number with pending tasks)
        let current_wave = session
            .tasks
            .iter()
            .filter(|t| t.status == SubTaskStatus::Pending)
            .map(|t| t.wave)
            .min();

        let Some(wave) = current_wave else {
            return Ok(vec![]);
        };

        // Check if all dependencies for this wave are met
        let ready_tasks: Vec<SubTask> = session
            .tasks
            .iter()
            .filter(|t| t.wave == wave && t.status == SubTaskStatus::Pending)
            .filter(|t| {
                t.depends_on.iter().all(|dep_id| {
                    session
                        .results
                        .get(dep_id)
                        .is_some_and(|r| r.success)
                })
            })
            .cloned()
            .collect();

        // Mark them as queued
        for task in &ready_tasks {
            if let Some(t) = session.tasks.iter_mut().find(|t| t.id == task.id) {
                t.status = SubTaskStatus::Queued;
            }
        }

        self.broadcast_event(session_id, "orchestrator_wave_started", serde_json::json!({
            "session_id": session_id,
            "wave": wave,
            "task_count": ready_tasks.len(),
            "task_ids": ready_tasks.iter().map(|t| &t.id).collect::<Vec<_>>(),
        })).await;

        info!(
            session_id = %session_id,
            wave = wave,
            tasks = ready_tasks.len(),
            "orchestrator wave ready"
        );

        Ok(ready_tasks)
    }

    /// Mark a subtask as started (agent has been spawned).
    pub async fn mark_started(
        &self,
        session_id: &str,
        task_id: &str,
        agent_id: AgentId,
    ) -> Result<(), OrchestratorError> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| OrchestratorError::SessionNotFound {
                id: session_id.to_string(),
            })?;

        if let Some(task) = session.tasks.iter_mut().find(|t| t.id == task_id) {
            task.status = SubTaskStatus::Running;
            task.started_at = Some(Utc::now());
            task.agent_id = Some(agent_id);
        }

        Ok(())
    }

    /// Record a subtask result.
    pub async fn record_result(
        &self,
        session_id: &str,
        result: SubTaskResult,
    ) -> Result<SessionStatus, OrchestratorError> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| OrchestratorError::SessionNotFound {
                id: session_id.to_string(),
            })?;

        let task_id = result.task_id.clone();

        // Update task status
        if let Some(task) = session.tasks.iter_mut().find(|t| t.id == task_id) {
            task.status = if result.success {
                SubTaskStatus::Completed
            } else {
                SubTaskStatus::Failed
            };
            task.completed_at = Some(Utc::now());
        }

        session.total_cost_usd += result.cost_usd;
        session.results.insert(task_id.clone(), result);

        // Check if session is complete
        let all_terminal = session
            .tasks
            .iter()
            .all(|t| t.status.is_terminal());

        if all_terminal {
            let any_failed = session
                .tasks
                .iter()
                .any(|t| matches!(t.status, SubTaskStatus::Failed | SubTaskStatus::TimedOut));

            session.status = if any_failed {
                SessionStatus::PartialFailure
            } else {
                SessionStatus::Completed
            };

            info!(
                session_id = %session_id,
                status = ?session.status,
                total_cost = session.total_cost_usd,
                "orchestrator session finished"
            );
        }

        // Check if failed dependency blocks downstream tasks
        let failed_id = task_id.clone();
        let blocked_tasks: Vec<String> = session
            .tasks
            .iter()
            .filter(|t| t.depends_on.contains(&failed_id) && t.status == SubTaskStatus::Pending)
            .map(|t| t.id.clone())
            .collect();

        if !blocked_tasks.is_empty() {
            let result_failed = session.results.get(&failed_id).is_some_and(|r| !r.success);
            if result_failed {
                for blocked_id in &blocked_tasks {
                    if let Some(t) = session.tasks.iter_mut().find(|t| &t.id == blocked_id) {
                        t.status = SubTaskStatus::Cancelled;
                        t.completed_at = Some(Utc::now());
                        warn!(
                            session_id = %session_id,
                            task_id = %blocked_id,
                            blocked_by = %failed_id,
                            "task cancelled due to failed dependency"
                        );
                    }
                }
            }
        }

        let status = session.status;

        self.broadcast_event(session_id, "orchestrator_task_completed", serde_json::json!({
            "session_id": session_id,
            "task_id": task_id,
            "session_status": status,
        })).await;

        Ok(status)
    }

    /// Get a session by ID.
    pub async fn get_session(&self, session_id: &str) -> Option<OrchestratorSession> {
        self.sessions.read().await.get(session_id).cloned()
    }

    /// List all sessions.
    pub async fn list_sessions(&self) -> Vec<OrchestratorSession> {
        let sessions = self.sessions.read().await;
        let mut list: Vec<_> = sessions.values().cloned().collect();
        list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        list
    }

    /// Cancel a session and all its pending tasks.
    pub async fn cancel_session(&self, session_id: &str) -> Result<(), OrchestratorError> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| OrchestratorError::SessionNotFound {
                id: session_id.to_string(),
            })?;

        session.status = SessionStatus::Cancelled;
        for task in &mut session.tasks {
            if !task.status.is_terminal() {
                task.status = SubTaskStatus::Cancelled;
                task.completed_at = Some(Utc::now());
            }
        }

        info!(session_id = %session_id, "orchestrator session cancelled");
        Ok(())
    }

    /// Get aggregated results from a completed session.
    pub async fn aggregate_results(
        &self,
        session_id: &str,
    ) -> Result<AggregatedResults, OrchestratorError> {
        let sessions = self.sessions.read().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| OrchestratorError::SessionNotFound {
                id: session_id.to_string(),
            })?;

        let total_tasks = session.tasks.len();
        let completed = session
            .tasks
            .iter()
            .filter(|t| t.status == SubTaskStatus::Completed)
            .count();
        let failed = session
            .tasks
            .iter()
            .filter(|t| matches!(t.status, SubTaskStatus::Failed | SubTaskStatus::TimedOut))
            .count();
        let cancelled = session
            .tasks
            .iter()
            .filter(|t| t.status == SubTaskStatus::Cancelled)
            .count();

        let summaries: Vec<TaskSummary> = session
            .tasks
            .iter()
            .map(|task| {
                let result = session.results.get(&task.id);
                TaskSummary {
                    task_id: task.id.clone(),
                    description: task.description.clone(),
                    agent_type: task.agent_type.clone(),
                    status: task.status,
                    summary: result.map(|r| r.summary.clone()),
                    error: result.and_then(|r| r.error.clone()),
                    cost_usd: result.map(|r| r.cost_usd).unwrap_or(0.0),
                    duration_ms: result.map(|r| r.duration_ms),
                }
            })
            .collect();

        Ok(AggregatedResults {
            session_id: session_id.to_string(),
            status: session.status,
            total_tasks,
            completed,
            failed,
            cancelled,
            total_cost_usd: session.total_cost_usd,
            task_summaries: summaries,
        })
    }

    /// Get orchestrator statistics.
    pub async fn stats(&self) -> OrchestratorStats {
        let sessions = self.sessions.read().await;
        let total = sessions.len();
        let running = sessions
            .values()
            .filter(|s| s.status == SessionStatus::Running)
            .count();
        let completed = sessions
            .values()
            .filter(|s| s.status == SessionStatus::Completed)
            .count();
        let failed = sessions
            .values()
            .filter(|s| matches!(s.status, SessionStatus::Failed | SessionStatus::PartialFailure))
            .count();

        let active_agents = self.config.max_concurrent_agents - self.semaphore.available_permits();

        OrchestratorStats {
            total_sessions: total,
            running_sessions: running,
            completed_sessions: completed,
            failed_sessions: failed,
            active_agents,
            max_concurrent: self.config.max_concurrent_agents,
            config: self.config.clone(),
        }
    }

    async fn broadcast_event(&self, session_id: &str, event_name: &str, data: serde_json::Value) {
        let event = StreamEvent::new(
            StreamEventType::Custom(event_name.to_string()),
            data,
        );
        self.broadcaster.broadcast(event);
    }
}

/// Aggregated results from a completed orchestration session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregatedResults {
    pub session_id: String,
    pub status: SessionStatus,
    pub total_tasks: usize,
    pub completed: usize,
    pub failed: usize,
    pub cancelled: usize,
    pub total_cost_usd: f64,
    pub task_summaries: Vec<TaskSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSummary {
    pub task_id: String,
    pub description: String,
    pub agent_type: String,
    pub status: SubTaskStatus,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub cost_usd: f64,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestratorStats {
    pub total_sessions: usize,
    pub running_sessions: usize,
    pub completed_sessions: usize,
    pub failed_sessions: usize,
    pub active_agents: usize,
    pub max_concurrent: usize,
    pub config: OrchestratorConfig,
}

#[derive(Debug, thiserror::Error)]
pub enum OrchestratorError {
    #[error("Too many tasks: max {max}, got {got}")]
    TooManyTasks { max: usize, got: usize },

    #[error("Session not found: {id}")]
    SessionNotFound { id: String },

    #[error("Task not found: {task_id} in session {session_id}")]
    TaskNotFound { session_id: String, task_id: String },

    #[error("Circular dependency detected")]
    CircularDependency,
}

impl OrchestratorError {
    pub fn status_code(&self) -> u16 {
        match self {
            Self::TooManyTasks { .. } => 400,
            Self::SessionNotFound { .. } => 404,
            Self::TaskNotFound { .. } => 404,
            Self::CircularDependency => 400,
        }
    }
}

/// Agent Inbox: file-based inter-agent communication.
///
/// Each agent has an inbox (Vec of messages). Agents poll their inbox
/// for new work/results from peers. Messages are JSON objects.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxMessage {
    pub id: String,
    pub from_agent: String,
    pub to_agent: String,
    pub message_type: InboxMessageType,
    pub payload: serde_json::Value,
    pub timestamp: DateTime<Utc>,
    pub read: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboxMessageType {
    TaskAssignment,
    TaskResult,
    Coordination,
    Broadcast,
    StatusUpdate,
}

/// In-memory inbox store for inter-agent communication.
pub struct InboxStore {
    inboxes: RwLock<HashMap<String, Vec<InboxMessage>>>,
}

impl InboxStore {
    pub fn new() -> Self {
        Self {
            inboxes: RwLock::new(HashMap::new()),
        }
    }

    /// Send a message to an agent's inbox.
    pub async fn send(&self, message: InboxMessage) {
        let mut inboxes = self.inboxes.write().await;
        inboxes
            .entry(message.to_agent.clone())
            .or_default()
            .push(message);
    }

    /// Broadcast a message to all agents.
    pub async fn broadcast(&self, from: &str, payload: serde_json::Value) {
        let inboxes = self.inboxes.read().await;
        let agents: Vec<String> = inboxes.keys().cloned().collect();
        drop(inboxes);

        for agent_id in agents {
            if agent_id != from {
                self.send(InboxMessage {
                    id: Uuid::new_v4().to_string(),
                    from_agent: from.to_string(),
                    to_agent: agent_id,
                    message_type: InboxMessageType::Broadcast,
                    payload: payload.clone(),
                    timestamp: Utc::now(),
                    read: false,
                })
                .await;
            }
        }
    }

    /// Read unread messages for an agent.
    pub async fn read_unread(&self, agent_id: &str) -> Vec<InboxMessage> {
        let mut inboxes = self.inboxes.write().await;
        let inbox = inboxes.entry(agent_id.to_string()).or_default();
        let unread: Vec<InboxMessage> = inbox
            .iter()
            .filter(|m| !m.read)
            .cloned()
            .collect();

        for msg in inbox.iter_mut() {
            msg.read = true;
        }

        unread
    }

    /// Get inbox size for an agent.
    pub async fn inbox_size(&self, agent_id: &str) -> usize {
        let inboxes = self.inboxes.read().await;
        inboxes.get(agent_id).map(|i| i.len()).unwrap_or(0)
    }

    /// Create an inbox for an agent.
    pub async fn register_agent(&self, agent_id: &str) {
        let mut inboxes = self.inboxes.write().await;
        inboxes.entry(agent_id.to_string()).or_default();
    }

    /// Remove an agent's inbox.
    pub async fn unregister_agent(&self, agent_id: &str) {
        let mut inboxes = self.inboxes.write().await;
        inboxes.remove(agent_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_broadcaster() -> Arc<SseBroadcaster> {
        Arc::new(SseBroadcaster::new(64))
    }

    #[test]
    fn test_execution_plan_parallel() {
        let tasks = vec![
            SubTask {
                id: "a".into(), description: "task A".into(), agent_type: "worker".into(),
                prompt: "do A".into(), execution_mode: ExecutionMode::Parallel,
                status: SubTaskStatus::Pending, depends_on: vec![], wave: 0,
                agent_id: None, created_at: Utc::now(), started_at: None,
                completed_at: None, timeout_secs: 60, isolated: false,
                model: None, allowed_tools: None,
            },
            SubTask {
                id: "b".into(), description: "task B".into(), agent_type: "worker".into(),
                prompt: "do B".into(), execution_mode: ExecutionMode::Parallel,
                status: SubTaskStatus::Pending, depends_on: vec![], wave: 0,
                agent_id: None, created_at: Utc::now(), started_at: None,
                completed_at: None, timeout_secs: 60, isolated: false,
                model: None, allowed_tools: None,
            },
        ];

        let plan = compute_execution_plan(&tasks);
        assert_eq!(plan.waves.len(), 1);
        assert_eq!(plan.waves[0].len(), 2);
    }

    #[test]
    fn test_execution_plan_sequential_deps() {
        let tasks = vec![
            SubTask {
                id: "setup".into(), description: "setup".into(), agent_type: "worker".into(),
                prompt: "setup".into(), execution_mode: ExecutionMode::Sequential,
                status: SubTaskStatus::Pending, depends_on: vec![], wave: 0,
                agent_id: None, created_at: Utc::now(), started_at: None,
                completed_at: None, timeout_secs: 60, isolated: false,
                model: None, allowed_tools: None,
            },
            SubTask {
                id: "build".into(), description: "build".into(), agent_type: "worker".into(),
                prompt: "build".into(), execution_mode: ExecutionMode::Sequential,
                status: SubTaskStatus::Pending, depends_on: vec!["setup".into()], wave: 0,
                agent_id: None, created_at: Utc::now(), started_at: None,
                completed_at: None, timeout_secs: 60, isolated: false,
                model: None, allowed_tools: None,
            },
            SubTask {
                id: "test".into(), description: "test".into(), agent_type: "worker".into(),
                prompt: "test".into(), execution_mode: ExecutionMode::Sequential,
                status: SubTaskStatus::Pending, depends_on: vec!["build".into()], wave: 0,
                agent_id: None, created_at: Utc::now(), started_at: None,
                completed_at: None, timeout_secs: 60, isolated: false,
                model: None, allowed_tools: None,
            },
        ];

        let plan = compute_execution_plan(&tasks);
        assert_eq!(plan.waves.len(), 3);
        assert_eq!(plan.waves[0], vec!["setup"]);
        assert_eq!(plan.waves[1], vec!["build"]);
        assert_eq!(plan.waves[2], vec!["test"]);
    }

    #[test]
    fn test_execution_plan_diamond_deps() {
        // Diamond: A → B, A → C, B+C → D
        let tasks = vec![
            SubTask {
                id: "a".into(), description: "A".into(), agent_type: "w".into(),
                prompt: "a".into(), execution_mode: ExecutionMode::Parallel,
                status: SubTaskStatus::Pending, depends_on: vec![], wave: 0,
                agent_id: None, created_at: Utc::now(), started_at: None,
                completed_at: None, timeout_secs: 60, isolated: false,
                model: None, allowed_tools: None,
            },
            SubTask {
                id: "b".into(), description: "B".into(), agent_type: "w".into(),
                prompt: "b".into(), execution_mode: ExecutionMode::Parallel,
                status: SubTaskStatus::Pending, depends_on: vec!["a".into()], wave: 0,
                agent_id: None, created_at: Utc::now(), started_at: None,
                completed_at: None, timeout_secs: 60, isolated: false,
                model: None, allowed_tools: None,
            },
            SubTask {
                id: "c".into(), description: "C".into(), agent_type: "w".into(),
                prompt: "c".into(), execution_mode: ExecutionMode::Parallel,
                status: SubTaskStatus::Pending, depends_on: vec!["a".into()], wave: 0,
                agent_id: None, created_at: Utc::now(), started_at: None,
                completed_at: None, timeout_secs: 60, isolated: false,
                model: None, allowed_tools: None,
            },
            SubTask {
                id: "d".into(), description: "D".into(), agent_type: "w".into(),
                prompt: "d".into(), execution_mode: ExecutionMode::Sequential,
                status: SubTaskStatus::Pending, depends_on: vec!["b".into(), "c".into()], wave: 0,
                agent_id: None, created_at: Utc::now(), started_at: None,
                completed_at: None, timeout_secs: 60, isolated: false,
                model: None, allowed_tools: None,
            },
        ];

        let plan = compute_execution_plan(&tasks);
        assert_eq!(plan.waves.len(), 3);
        assert_eq!(plan.waves[0], vec!["a"]);
        assert!(plan.waves[1].contains(&"b".to_string()));
        assert!(plan.waves[1].contains(&"c".to_string()));
        assert_eq!(plan.waves[2], vec!["d"]);
    }

    #[test]
    fn test_builder_fluent_api() {
        let session = OrchestratorBuilder::new("refactor project")
            .parallel("lint", "explorer", "Check linting", "Run lint checks")
            .parallel("security", "explorer", "Security scan", "Run security analysis")
            .parallel("tests", "worker", "Run tests", "Execute test suite")
            .with_isolation()
            .sequential("merge", "worker", "Merge results", "Aggregate all findings", vec!["lint", "security", "tests"])
            .build(900);

        assert_eq!(session.tasks.len(), 4);
        assert_eq!(session.execution_plan.waves.len(), 2);
        assert_eq!(session.execution_plan.waves[0].len(), 3);
        assert_eq!(session.execution_plan.waves[1].len(), 1);
        assert!(session.tasks[2].isolated); // "tests" has isolation
    }

    #[tokio::test]
    async fn test_orchestrator_submit_and_wave() {
        let orch = Orchestrator::new(OrchestratorConfig::default(), test_broadcaster());

        let session = OrchestratorBuilder::new("test")
            .parallel("a", "worker", "Task A", "Do A")
            .parallel("b", "worker", "Task B", "Do B")
            .build(60);

        let session_id = orch.submit(session).await.unwrap();
        let wave = orch.next_wave(&session_id).await.unwrap();
        assert_eq!(wave.len(), 2);
    }

    #[tokio::test]
    async fn test_orchestrator_result_recording() {
        let orch = Orchestrator::new(OrchestratorConfig::default(), test_broadcaster());

        let session = OrchestratorBuilder::new("test")
            .parallel("a", "worker", "Task A", "Do A")
            .build(60);

        let session_id = orch.submit(session).await.unwrap();
        let wave = orch.next_wave(&session_id).await.unwrap();

        let agent_id = AgentId::new();
        orch.mark_started(&session_id, "a", agent_id).await.unwrap();

        let status = orch
            .record_result(
                &session_id,
                SubTaskResult {
                    task_id: "a".into(),
                    success: true,
                    summary: "Task A completed successfully".into(),
                    cost_usd: 0.05,
                    duration_ms: 1500,
                    error: None,
                },
            )
            .await
            .unwrap();

        assert_eq!(status, SessionStatus::Completed);

        let results = orch.aggregate_results(&session_id).await.unwrap();
        assert_eq!(results.completed, 1);
        assert_eq!(results.total_cost_usd, 0.05);
    }

    #[tokio::test]
    async fn test_dependency_failure_cascades() {
        let orch = Orchestrator::new(OrchestratorConfig::default(), test_broadcaster());

        let session = OrchestratorBuilder::new("test")
            .parallel("setup", "worker", "Setup", "Do setup")
            .sequential("build", "worker", "Build", "Build project", vec!["setup"])
            .build(60);

        let session_id = orch.submit(session).await.unwrap();

        // Execute wave 0 (setup)
        let wave0 = orch.next_wave(&session_id).await.unwrap();
        assert_eq!(wave0.len(), 1);

        // Setup fails
        orch.record_result(
            &session_id,
            SubTaskResult {
                task_id: "setup".into(),
                success: false,
                summary: "Setup failed".into(),
                cost_usd: 0.01,
                duration_ms: 500,
                error: Some("connection error".into()),
            },
        )
        .await
        .unwrap();

        // Build should be cancelled due to failed dependency
        let session = orch.get_session(&session_id).await.unwrap();
        let build_task = session.tasks.iter().find(|t| t.id == "build").unwrap();
        assert_eq!(build_task.status, SubTaskStatus::Cancelled);
    }

    #[tokio::test]
    async fn test_inbox_communication() {
        let store = InboxStore::new();

        store.register_agent("agent-1").await;
        store.register_agent("agent-2").await;

        // Send message
        store
            .send(InboxMessage {
                id: "msg-1".into(),
                from_agent: "agent-1".into(),
                to_agent: "agent-2".into(),
                message_type: InboxMessageType::TaskResult,
                payload: serde_json::json!({"result": "done"}),
                timestamp: Utc::now(),
                read: false,
            })
            .await;

        // Read unread
        let unread = store.read_unread("agent-2").await;
        assert_eq!(unread.len(), 1);
        assert_eq!(unread[0].from_agent, "agent-1");

        // Second read should be empty
        let unread2 = store.read_unread("agent-2").await;
        assert_eq!(unread2.len(), 0);
    }

    #[tokio::test]
    async fn test_inbox_broadcast() {
        let store = InboxStore::new();

        store.register_agent("leader").await;
        store.register_agent("worker-1").await;
        store.register_agent("worker-2").await;

        store
            .broadcast("leader", serde_json::json!({"action": "start"}))
            .await;

        let w1 = store.read_unread("worker-1").await;
        let w2 = store.read_unread("worker-2").await;
        let leader = store.read_unread("leader").await;

        assert_eq!(w1.len(), 1);
        assert_eq!(w2.len(), 1);
        assert_eq!(leader.len(), 0); // Sender doesn't receive own broadcast
    }

    #[tokio::test]
    async fn test_cancel_session() {
        let orch = Orchestrator::new(OrchestratorConfig::default(), test_broadcaster());

        let session = OrchestratorBuilder::new("test")
            .parallel("a", "worker", "Task A", "Do A")
            .parallel("b", "worker", "Task B", "Do B")
            .build(60);

        let session_id = orch.submit(session).await.unwrap();
        orch.cancel_session(&session_id).await.unwrap();

        let session = orch.get_session(&session_id).await.unwrap();
        assert_eq!(session.status, SessionStatus::Cancelled);
        assert!(session.tasks.iter().all(|t| t.status == SubTaskStatus::Cancelled));
    }
}
