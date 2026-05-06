use axum::{
    extract::State,
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore};
use tracing::info;

use crate::config::{AgentConfig, AppConfig, TriggerConfig};
use crate::llm::{self, LlmClient, Message};
use crate::runtime::context::build_system_prompt;
use crate::runtime::engine::AgentEngine;
use crate::tools::{ToolContext, ToolRegistry};
use crate::workspace::WorkspaceManager;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<AppConfig>,
    pub tool_ctx: Arc<ToolContext>,
    pub status: Arc<Mutex<DaemonStatus>>,
    pub semaphore: Arc<Semaphore>,
    pub start_time: std::time::Instant,
}

#[derive(Debug, Clone, Serialize)]
pub struct DaemonStatus {
    pub active_tasks: Vec<TaskInfo>,
    pub tasks_completed: u64,
    pub tasks_failed: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskInfo {
    pub id: String,
    pub agent: String,
    pub message: String,
    pub started_at: String,
}

impl Default for DaemonStatus {
    fn default() -> Self {
        Self {
            active_tasks: vec![],
            tasks_completed: 0,
            tasks_failed: 0,
        }
    }
}

#[derive(Deserialize)]
pub struct TaskRequest {
    pub message: String,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
}

#[derive(Serialize)]
pub struct TaskSubmitResponse {
    pub task_id: String,
    pub agent: String,
    pub status: String,
}

#[derive(Serialize)]
pub struct TaskResponse {
    pub success: bool,
    pub result: String,
}

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub agents: Vec<String>,
    pub version: String,
}

#[derive(Serialize)]
pub struct StatusResponse {
    pub uptime_secs: u64,
    pub active_tasks: Vec<TaskInfo>,
    pub tasks_completed: u64,
    pub tasks_failed: u64,
    pub max_concurrent: usize,
}

pub fn create_router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/status", get(status))
        .route("/api/agents", get(list_agents))
        .route("/api/triggers", get(list_triggers))
        .route("/api/task", post(submit_task))
        .route("/api/task/sync", post(run_task_sync))
        .with_state(state)
}

#[derive(Serialize)]
pub struct AgentDto {
    pub name: String,
    pub workspace: String,
    pub description: Option<String>,
    pub model_category: Option<String>,
    pub tools: Option<Vec<String>>,
    pub effective_model: String,
    pub effective_provider: String,
}

impl AgentDto {
    fn from(cfg: &AgentConfig, app: &AppConfig) -> Self {
        let resolved = app.resolve_llm(cfg);
        Self {
            name: cfg.name.clone(),
            workspace: cfg.workspace.clone(),
            description: cfg.description.clone(),
            model_category: cfg.model_category.clone(),
            tools: cfg.tools.clone(),
            effective_model: resolved.model,
            effective_provider: resolved.provider,
        }
    }
}

#[derive(Serialize)]
pub struct TriggerDto {
    pub name: String,
    pub trigger_type: String,
    pub expr: Option<String>,
    pub minutes: Option<u64>,
    pub reason: String,
    pub agent: Option<String>,
}

impl From<&TriggerConfig> for TriggerDto {
    fn from(t: &TriggerConfig) -> Self {
        Self {
            name: t.name.clone(),
            trigger_type: t.trigger_type.clone(),
            expr: t.expr.clone(),
            minutes: t.minutes,
            reason: t.reason.clone(),
            agent: t.agent.clone(),
        }
    }
}

async fn list_agents(State(state): State<AppState>) -> Json<Vec<AgentDto>> {
    let dtos = state
        .config
        .agents
        .iter()
        .map(|a| AgentDto::from(a, &state.config))
        .collect();
    Json(dtos)
}

async fn list_triggers(State(state): State<AppState>) -> Json<Vec<TriggerDto>> {
    let dtos = state.config.triggers.iter().map(TriggerDto::from).collect();
    Json(dtos)
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    let agents: Vec<String> = state.config.agents.iter().map(|a| a.name.clone()).collect();
    Json(HealthResponse {
        status: "ok".into(),
        agents,
        version: env!("CARGO_PKG_VERSION").into(),
    })
}

async fn status(State(state): State<AppState>) -> Json<StatusResponse> {
    let s = state.status.lock().await;
    Json(StatusResponse {
        uptime_secs: state.start_time.elapsed().as_secs(),
        active_tasks: s.active_tasks.clone(),
        tasks_completed: s.tasks_completed,
        tasks_failed: s.tasks_failed,
        max_concurrent: state.config.server.max_concurrent_tasks,
    })
}

async fn submit_task(
    State(state): State<AppState>,
    Json(req): Json<TaskRequest>,
) -> Result<Json<TaskSubmitResponse>, (StatusCode, String)> {
    let agent_name = req.agent.clone().unwrap_or_else(|| {
        state.config.default_agent().map(|a| a.name.clone()).unwrap_or_default()
    });

    let agent_config = state.config.get_agent(&agent_name).cloned().ok_or_else(|| {
        (StatusCode::NOT_FOUND, format!("未知 Agent: {}", agent_name))
    })?;

    let task_id = uuid::Uuid::new_v4().to_string()[..8].to_string();

    let task_info = TaskInfo {
        id: task_id.clone(),
        agent: agent_name.clone(),
        message: req.message.clone(),
        started_at: chrono::Local::now().format("%H:%M:%S").to_string(),
    };

    {
        let mut s = state.status.lock().await;
        s.active_tasks.push(task_info);
    }

    let state_clone = state.clone();
    let task_id_clone = task_id.clone();
    let message = req.message.clone();
    let context = req.context.clone();

    tokio::spawn(async move {
        let _permit = state_clone.semaphore.acquire().await;

        let result = execute_agent_task(
            &state_clone.config,
            &agent_config,
            &state_clone.tool_ctx,
            &message,
            context.as_deref(),
        )
        .await;

        let mut s = state_clone.status.lock().await;
        s.active_tasks.retain(|t| t.id != task_id_clone);
        match &result {
            Ok(_) => {
                s.tasks_completed += 1;
                info!("任务完成: [{}] {}", task_id_clone, agent_config.name);
            }
            Err(e) => {
                s.tasks_failed += 1;
                info!("任务失败: [{}] {} — {}", task_id_clone, agent_config.name, e);
            }
        }
    });

    Ok(Json(TaskSubmitResponse {
        task_id,
        agent: agent_name,
        status: "accepted".into(),
    }))
}

async fn run_task_sync(
    State(state): State<AppState>,
    Json(req): Json<TaskRequest>,
) -> Result<Json<TaskResponse>, (StatusCode, String)> {
    let agent_name = req.agent.clone().unwrap_or_else(|| {
        state.config.default_agent().map(|a| a.name.clone()).unwrap_or_default()
    });

    let agent_config = state.config.get_agent(&agent_name).cloned().ok_or_else(|| {
        (StatusCode::NOT_FOUND, format!("未知 Agent: {}", agent_name))
    })?;

    let _permit = state.semaphore.acquire().await.map_err(|e| {
        (StatusCode::SERVICE_UNAVAILABLE, format!("并发限制: {}", e))
    })?;

    match execute_agent_task(
        &state.config,
        &agent_config,
        &state.tool_ctx,
        &req.message,
        req.context.as_deref(),
    )
    .await
    {
        Ok(text) => Ok(Json(TaskResponse {
            success: true,
            result: text,
        })),
        Err(e) => Ok(Json(TaskResponse {
            success: false,
            result: format!("任务执行失败: {}", e),
        })),
    }
}

async fn execute_agent_task(
    config: &AppConfig,
    agent_config: &crate::config::AgentConfig,
    tool_ctx: &ToolContext,
    message: &str,
    context: Option<&str>,
) -> anyhow::Result<String> {
    let resolved = config.resolve_llm(agent_config);
    let api_key = config.resolve_api_key(&resolved.api_key_env, &resolved.provider)?;
    let llm_config = resolved.to_llm_config();
    let llm: Box<dyn LlmClient> = llm::client::create_llm_client(&llm_config, &api_key);

    let workspace = Arc::new(WorkspaceManager::new(
        std::path::PathBuf::from(&agent_config.workspace),
    ));
    workspace.ensure_structure()?;

    let mut tools = ToolRegistry::new();
    if let Some(tool_list) = &agent_config.tools {
        tools.register_selected(tool_list);
    } else {
        tools.register_defaults();
    }

    let triggers: Vec<&crate::config::TriggerConfig> =
        config.triggers_for_agent(&agent_config.name);
    let tool_defs = tools.definitions();
    let system = build_system_prompt(
        &agent_config.name,
        &workspace,
        &triggers,
        &tool_defs,
        None,
        &agent_config.discipline,
    );

    let mut user_content = message.to_string();
    if let Some(ctx) = context {
        user_content = format!("{}\n\n补充上下文：{}", user_content, ctx);
    }

    let mut messages = vec![
        Message::System { content: system },
        Message::User { content: user_content },
    ];

    let engine = AgentEngine::new(resolved.max_rounds)
        .with_discipline(agent_config.discipline.clone())
        .with_workspace(workspace);

    engine.run(llm.as_ref(), &mut messages, &tools, tool_ctx, false).await
}
