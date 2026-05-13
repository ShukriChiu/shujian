use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Result, bail};
use tokio::sync::Semaphore;
use tracing::{info, warn};

use crate::types::agent::{AgentDefinition, AgentId, AgentRuntime, AgentRuntimeStatus};
use crate::types::event::AppEvent;
use crate::types::state::AppStateStore;
use crate::types::task::{TaskState, TaskType};

pub struct AgentSpawner {
    store: AppStateStore,
    max_concurrent: usize,
    semaphore: Arc<Semaphore>,
    agent_registry: HashMap<String, AgentDefinition>,
}

impl AgentSpawner {
    pub fn new(store: AppStateStore, max_concurrent: usize) -> Self {
        Self {
            store,
            max_concurrent,
            semaphore: Arc::new(Semaphore::new(max_concurrent)),
            agent_registry: HashMap::new(),
        }
    }

    pub fn register_agent_type(&mut self, def: AgentDefinition) {
        self.agent_registry.insert(def.agent_type.clone(), def);
    }

    pub fn register_all(&mut self, defs: Vec<AgentDefinition>) {
        for def in defs {
            self.register_agent_type(def);
        }
    }

    pub fn available_types(&self) -> Vec<&AgentDefinition> {
        self.agent_registry.values().collect()
    }

    pub async fn spawn(
        &self,
        agent_type: &str,
        task_description: &str,
        _parent_task_id: Option<&str>,
    ) -> Result<SpawnResult> {
        let def = self
            .agent_registry
            .get(agent_type)
            .ok_or_else(|| anyhow::anyhow!("unknown agent type: {}", agent_type))?
            .clone();

        if let Some(budget) = def.max_budget_usd {
            let state = self.store.read().await;
            if state.cost_total_usd > budget * 10.0 {
                bail!(
                    "global cost ${:.2} exceeds safety limit for spawning new agents",
                    state.cost_total_usd
                );
            }
        }

        let _permit = self
            .semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| anyhow::anyhow!("spawner semaphore closed"))?;

        let agent_id = AgentId::new();
        let task = TaskState::new(TaskType::Agent, task_description);
        let task_id = task.id.clone();

        let _runtime = AgentRuntime {
            id: agent_id,
            definition: def.clone(),
            status: AgentRuntimeStatus::Idle,
            current_task_id: Some(task_id.clone()),
            tasks_completed: 0,
            tasks_failed: 0,
            total_cost_usd: 0.0,
            metadata: std::collections::HashMap::new(),
        };

        let aid = agent_id;
        let tid = task_id.clone();
        let at = agent_type.to_string();
        let desc = task_description.to_string();

        let display = def.display_name.clone();

        self.store
            .update_and_emit(
                move |state| {
                    state.agent_registry.insert(
                        aid,
                        AgentRuntime {
                            id: aid,
                            definition: def,
                            status: AgentRuntimeStatus::Running,
                            current_task_id: Some(tid.clone()),
                            tasks_completed: 0,
                            tasks_failed: 0,
                            total_cost_usd: 0.0,
                            metadata: std::collections::HashMap::new(),
                        },
                    );
                    let mut t = TaskState::new(TaskType::Agent, &desc);
                    t.id = tid;
                    t.agent_id = Some(aid);
                    t.agent_type = Some(at);
                    t.mark_running();
                    state.register_task(t);
                },
                AppEvent::AgentSpawned {
                    agent_id: aid,
                    agent_type: agent_type.to_string(),
                    task_id: task_id.clone(),
                    display_name: display,
                },
            )
            .await;

        info!(
            agent_id = %agent_id,
            agent_type = agent_type,
            task_id = %task_id,
            "agent spawned"
        );

        Ok(SpawnResult {
            agent_id,
            task_id,
            agent_type: agent_type.into(),
            _permit,
        })
    }

    pub async fn complete_agent(
        &self,
        agent_id: AgentId,
        task_id: &str,
        result: Option<String>,
        cost_usd: f64,
    ) {
        let tid = task_id.to_string();
        let res = result.clone();
        self.store
            .update_and_emit(
                move |state| {
                    state.complete_task(&tid, res);
                    if let Some(agent) = state.agent_registry.get_mut(&agent_id) {
                        agent.status = AgentRuntimeStatus::Completed;
                        agent.current_task_id = None;
                        agent.tasks_completed += 1;
                        agent.total_cost_usd += cost_usd;
                    }
                    state.cost_total_usd += cost_usd;
                },
                AppEvent::AgentCompleted {
                    agent_id,
                    task_id: task_id.into(),
                    result: result.unwrap_or_default(),
                },
            )
            .await;

        info!(agent_id = %agent_id, task_id = task_id, cost = cost_usd, "agent completed");
    }

    pub async fn fail_agent(&self, agent_id: AgentId, task_id: &str, error: &str) {
        let tid = task_id.to_string();
        let err = error.to_string();
        self.store
            .update_and_emit(
                move |state| {
                    state.fail_task(&tid, err);
                    if let Some(agent) = state.agent_registry.get_mut(&agent_id) {
                        agent.status = AgentRuntimeStatus::Failed;
                        agent.current_task_id = None;
                        agent.tasks_failed += 1;
                    }
                },
                AppEvent::AgentFailed {
                    agent_id,
                    task_id: task_id.into(),
                    error: error.into(),
                },
            )
            .await;

        warn!(agent_id = %agent_id, task_id = task_id, error = error, "agent failed");
    }

    pub async fn kill_agent(&self, agent_id: AgentId) {
        self.store
            .update_and_emit(
                move |state| {
                    if let Some(agent) = state.agent_registry.get_mut(&agent_id) {
                        if let Some(tid) = agent.current_task_id.take()
                            && let Some(task) = state.tasks.get_mut(&tid)
                            && !task.status.is_terminal()
                        {
                            task.mark_killed();
                        }
                        agent.status = AgentRuntimeStatus::Failed;
                        agent.tasks_failed += 1;
                    }
                },
                AppEvent::AgentFailed {
                    agent_id,
                    task_id: String::new(),
                    error: "killed by user".into(),
                },
            )
            .await;

        info!(agent_id = %agent_id, "agent killed");
    }

    pub fn active_count(&self) -> usize {
        self.max_concurrent - self.semaphore.available_permits()
    }
}

pub struct SpawnResult {
    pub agent_id: AgentId,
    pub task_id: String,
    pub agent_type: String,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
