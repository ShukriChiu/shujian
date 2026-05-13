use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};

use super::agent::{AgentDefinition, AgentId, AgentRuntime};
use super::event::AppEvent;
use super::message::InboxMessage;
use super::permission::PermissionContext;
use super::task::{TaskState, TokenUsage};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification {
    pub id: String,
    pub level: super::event::NotificationLevel,
    pub title: String,
    pub body: String,
    pub timestamp: DateTime<Utc>,
    pub read: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingPermission {
    pub request_id: String,
    pub agent_id: AgentId,
    pub task_id: String,
    pub tool_name: String,
    pub input_summary: String,
    pub requested_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryState {
    pub last_dream_at: Option<DateTime<Utc>>,
    pub dream_in_progress: bool,
    pub sessions_since_dream: u32,
    pub total_entries: u64,
}

impl Default for MemoryState {
    fn default() -> Self {
        Self {
            last_dream_at: None,
            dream_in_progress: false,
            sessions_since_dream: 0,
            total_entries: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoordinatorState {
    pub coordinator_task_id: String,
    pub worker_task_ids: Vec<String>,
    pub scratchpad_dir: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AppState {
    pub tasks: HashMap<String, TaskState>,
    pub agent_registry: HashMap<AgentId, AgentRuntime>,
    pub agent_name_map: HashMap<String, AgentId>,

    pub agent_definitions: Vec<AgentDefinition>,
    pub global_permission: PermissionContext,

    pub inbox: HashMap<AgentId, Vec<InboxMessage>>,
    pub notifications: VecDeque<Notification>,

    pub pending_permissions: Vec<PendingPermission>,

    pub token_usage_total: TokenUsage,
    pub cost_total_usd: f64,
    pub started_at: DateTime<Utc>,
    pub active_task_count: u32,
    pub completed_count: u64,
    pub failed_count: u64,

    pub coordinator_states: HashMap<String, CoordinatorState>,

    pub memory_state: MemoryState,

    pub connected_clients: u32,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            tasks: HashMap::new(),
            agent_registry: HashMap::new(),
            agent_name_map: HashMap::new(),
            agent_definitions: Vec::new(),
            global_permission: PermissionContext::default(),
            inbox: HashMap::new(),
            notifications: VecDeque::new(),
            pending_permissions: Vec::new(),
            token_usage_total: TokenUsage::default(),
            cost_total_usd: 0.0,
            started_at: Utc::now(),
            active_task_count: 0,
            completed_count: 0,
            failed_count: 0,
            coordinator_states: HashMap::new(),
            memory_state: MemoryState::default(),
            connected_clients: 0,
        }
    }
}

impl AppState {
    pub fn register_task(&mut self, task: TaskState) {
        self.active_task_count += 1;
        self.tasks.insert(task.id.clone(), task);
    }

    pub fn complete_task(&mut self, task_id: &str, summary: Option<String>) {
        if let Some(task) = self.tasks.get_mut(task_id) {
            task.mark_completed(summary);
            self.active_task_count = self.active_task_count.saturating_sub(1);
            self.completed_count += 1;
            self.cost_total_usd += task.cost_usd;
            self.token_usage_total.accumulate(&task.token_usage);
        }
    }

    pub fn fail_task(&mut self, task_id: &str, error: String) {
        if let Some(task) = self.tasks.get_mut(task_id) {
            task.mark_failed(error);
            self.active_task_count = self.active_task_count.saturating_sub(1);
            self.failed_count += 1;
        }
    }

    pub fn register_agent(&mut self, agent: AgentRuntime) {
        let name = agent.definition.agent_type.clone();
        let id = agent.id;
        self.agent_name_map.insert(name, id);
        self.agent_registry.insert(id, agent);
    }

    pub fn find_agent_by_name(&self, name: &str) -> Option<&AgentRuntime> {
        self.agent_name_map
            .get(name)
            .and_then(|id| self.agent_registry.get(id))
    }

    pub fn add_inbox_message(&mut self, msg: InboxMessage) {
        self.inbox.entry(msg.to).or_default().push(msg);
    }

    pub fn add_pending_permission(&mut self, perm: PendingPermission) {
        self.pending_permissions.push(perm);
    }

    pub fn resolve_permission(&mut self, request_id: &str) -> Option<PendingPermission> {
        if let Some(idx) = self
            .pending_permissions
            .iter()
            .position(|p| p.request_id == request_id)
        {
            Some(self.pending_permissions.remove(idx))
        } else {
            None
        }
    }

    pub fn active_tasks(&self) -> Vec<&TaskState> {
        self.tasks
            .values()
            .filter(|t| !t.status.is_terminal())
            .collect()
    }

    pub fn tasks_for_agent(&self, agent_id: AgentId) -> Vec<&TaskState> {
        self.tasks
            .values()
            .filter(|t| t.agent_id == Some(agent_id))
            .collect()
    }

    pub fn worker_tasks_for_coordinator(&self, coordinator_task_id: &str) -> Vec<&TaskState> {
        self.tasks
            .values()
            .filter(|t| t.parent_id.as_deref() == Some(coordinator_task_id))
            .collect()
    }
}

use std::sync::Arc;
use tokio::sync::{RwLock, broadcast};

pub struct AppStateStore {
    state: Arc<RwLock<AppState>>,
    event_tx: broadcast::Sender<AppEvent>,
}

impl AppStateStore {
    pub fn new() -> Self {
        let (event_tx, _) = broadcast::channel(1024);
        Self {
            state: Arc::new(RwLock::new(AppState::default())),
            event_tx,
        }
    }

    pub fn state(&self) -> Arc<RwLock<AppState>> {
        self.state.clone()
    }

    pub fn event_sender(&self) -> broadcast::Sender<AppEvent> {
        self.event_tx.clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.event_tx.subscribe()
    }

    pub async fn read(&self) -> tokio::sync::RwLockReadGuard<'_, AppState> {
        self.state.read().await
    }

    pub async fn write(&self) -> tokio::sync::RwLockWriteGuard<'_, AppState> {
        self.state.write().await
    }

    pub async fn update_and_emit<F>(&self, updater: F, event: AppEvent)
    where
        F: FnOnce(&mut AppState),
    {
        {
            let mut state = self.state.write().await;
            updater(&mut state);
        }
        let _ = self.event_tx.send(event);
    }

    pub fn emit(&self, event: AppEvent) {
        let _ = self.event_tx.send(event);
    }
}

impl Clone for AppStateStore {
    fn clone(&self) -> Self {
        Self {
            state: self.state.clone(),
            event_tx: self.event_tx.clone(),
        }
    }
}
