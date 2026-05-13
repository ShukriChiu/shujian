use axum::{
    Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{
        Json,
        sse::{Event, Sse},
    },
    routing::{get, post},
};
use chrono::Utc;
use futures_util::stream::Stream;
use serde::{Deserialize, Serialize};
use std::{convert::Infallible, pin::Pin};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;

use crate::types::agent::{AgentId, AgentRuntime};
use crate::types::event::{AppEvent, NotificationLevel, TimestampedEvent};
use crate::types::state::AppStateStore;
use crate::types::task::{TaskState, TaskStatus, TokenUsage};

#[derive(Clone)]
pub struct DashboardState {
    pub store: AppStateStore,
}

pub fn dashboard_router() -> Router<DashboardState> {
    Router::new()
        .route("/api/v2/status", get(system_status))
        .route("/api/v2/agents", get(list_agents))
        .route("/api/v2/agents/{agent_id}", get(get_agent))
        .route("/api/v2/tasks", get(list_tasks))
        .route("/api/v2/tasks/{task_id}", get(get_task))
        .route("/api/v2/tasks/{task_id}/kill", post(kill_task))
        .route("/api/v2/tasks/{task_id}/output", get(task_output))
        .route("/api/v2/permissions/pending", get(pending_permissions))
        .route(
            "/api/v2/permissions/{request_id}/approve",
            post(approve_permission),
        )
        .route(
            "/api/v2/permissions/{request_id}/deny",
            post(deny_permission),
        )
        .route("/api/v2/notifications", get(list_notifications))
        .route(
            "/api/v2/notifications/{id}/read",
            post(mark_notification_read),
        )
        .route("/api/v2/metrics", get(metrics))
        .route("/api/v2/events", get(sse_events))
}

#[derive(Serialize)]
struct SystemStatus {
    version: String,
    uptime_secs: i64,
    active_tasks: u32,
    completed_tasks: u64,
    failed_tasks: u64,
    total_cost_usd: f64,
    total_tokens: u64,
    connected_clients: u32,
    agent_count: usize,
    memory_state: MemoryStatusDto,
}

#[derive(Serialize)]
struct MemoryStatusDto {
    dream_in_progress: bool,
    sessions_since_dream: u32,
    last_dream_at: Option<String>,
    total_entries: u64,
}

async fn system_status(State(state): State<DashboardState>) -> Json<SystemStatus> {
    let s = state.store.read().await;
    let uptime = (Utc::now() - s.started_at).num_seconds();
    Json(SystemStatus {
        version: env!("CARGO_PKG_VERSION").into(),
        uptime_secs: uptime,
        active_tasks: s.active_task_count,
        completed_tasks: s.completed_count,
        failed_tasks: s.failed_count,
        total_cost_usd: s.cost_total_usd,
        total_tokens: s.token_usage_total.total_tokens(),
        connected_clients: s.connected_clients,
        agent_count: s.agent_registry.len(),
        memory_state: MemoryStatusDto {
            dream_in_progress: s.memory_state.dream_in_progress,
            sessions_since_dream: s.memory_state.sessions_since_dream,
            last_dream_at: s.memory_state.last_dream_at.map(|d| d.to_rfc3339()),
            total_entries: s.memory_state.total_entries,
        },
    })
}

#[derive(Serialize)]
struct AgentDto {
    id: String,
    agent_type: String,
    display_name: String,
    description: String,
    status: String,
    current_task_id: Option<String>,
    tasks_completed: u64,
    tasks_failed: u64,
    total_cost_usd: f64,
    color: Option<String>,
    domain: Option<String>,
    department: Option<String>,
    role_level: String,
}

fn agent_to_dto(agent: &AgentRuntime) -> AgentDto {
    AgentDto {
        id: agent.id.to_string(),
        agent_type: agent.definition.agent_type.clone(),
        display_name: agent.definition.display_name.clone(),
        description: agent.definition.description.clone(),
        status: format!("{:?}", agent.status),
        current_task_id: agent.current_task_id.clone(),
        tasks_completed: agent.tasks_completed,
        tasks_failed: agent.tasks_failed,
        total_cost_usd: agent.total_cost_usd,
        color: agent.definition.color.map(|c| c.hex().to_string()),
        domain: agent.definition.domain.clone(),
        department: agent.definition.department.clone(),
        role_level: format!("{:?}", agent.definition.role_level),
    }
}

async fn list_agents(State(state): State<DashboardState>) -> Json<Vec<AgentDto>> {
    let s = state.store.read().await;
    let agents: Vec<AgentDto> = s.agent_registry.values().map(agent_to_dto).collect();
    Json(agents)
}

async fn get_agent(
    State(state): State<DashboardState>,
    Path(agent_id): Path<String>,
) -> Result<Json<AgentDto>, (StatusCode, String)> {
    let s = state.store.read().await;
    let uuid = agent_id
        .parse::<uuid::Uuid>()
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid agent id".into()))?;

    let agent = s
        .agent_registry
        .get(&AgentId(uuid))
        .ok_or((StatusCode::NOT_FOUND, "agent not found".into()))?;

    Ok(Json(agent_to_dto(agent)))
}

#[derive(Deserialize)]
struct TaskListQuery {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    agent_type: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Serialize)]
struct TaskDto {
    id: String,
    task_type: String,
    status: String,
    description: String,
    agent_id: Option<String>,
    agent_type: Option<String>,
    parent_id: Option<String>,
    started_at: String,
    ended_at: Option<String>,
    elapsed_ms: i64,
    cost_usd: f64,
    token_usage: TokenUsageDto,
    error: Option<String>,
    result_summary: Option<String>,
}

#[derive(Serialize)]
struct TokenUsageDto {
    input_tokens: u64,
    output_tokens: u64,
    total: u64,
}

fn task_to_dto(task: &TaskState) -> TaskDto {
    TaskDto {
        id: task.id.clone(),
        task_type: format!("{:?}", task.task_type),
        status: format!("{:?}", task.status),
        description: task.description.clone(),
        agent_id: task.agent_id.map(|id| id.to_string()),
        agent_type: task.agent_type.clone(),
        parent_id: task.parent_id.clone(),
        started_at: task.started_at.to_rfc3339(),
        ended_at: task.ended_at.map(|d| d.to_rfc3339()),
        elapsed_ms: task.elapsed_ms(),
        cost_usd: task.cost_usd,
        token_usage: TokenUsageDto {
            input_tokens: task.token_usage.input_tokens,
            output_tokens: task.token_usage.output_tokens,
            total: task.token_usage.total_tokens(),
        },
        error: task.error.clone(),
        result_summary: task.result_summary.clone(),
    }
}

async fn list_tasks(
    State(state): State<DashboardState>,
    Query(q): Query<TaskListQuery>,
) -> Json<Vec<TaskDto>> {
    let s = state.store.read().await;
    let limit = q.limit.unwrap_or(100);

    let mut tasks: Vec<TaskDto> = s
        .tasks
        .values()
        .filter(|t| {
            if let Some(ref status) = q.status {
                let ts = format!("{:?}", t.status).to_lowercase();
                if ts != status.to_lowercase() {
                    return false;
                }
            }
            if let Some(ref at) = q.agent_type {
                if t.agent_type.as_deref() != Some(at.as_str()) {
                    return false;
                }
            }
            true
        })
        .map(task_to_dto)
        .collect();

    tasks.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    tasks.truncate(limit);
    Json(tasks)
}

async fn get_task(
    State(state): State<DashboardState>,
    Path(task_id): Path<String>,
) -> Result<Json<TaskDto>, (StatusCode, String)> {
    let s = state.store.read().await;
    let task = s
        .tasks
        .get(&task_id)
        .ok_or((StatusCode::NOT_FOUND, "task not found".into()))?;
    Ok(Json(task_to_dto(task)))
}

async fn kill_task(
    State(state): State<DashboardState>,
    Path(task_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let tid = task_id.clone();
    state
        .store
        .update_and_emit(
            move |s| {
                if let Some(task) = s.tasks.get_mut(&tid) {
                    if !task.status.is_terminal() {
                        task.mark_killed();
                        s.active_task_count = s.active_task_count.saturating_sub(1);
                    }
                }
            },
            AppEvent::TaskFailed {
                task_id: task_id.clone(),
                error: "killed by user".into(),
            },
        )
        .await;

    Ok(Json(serde_json::json!({"killed": task_id})))
}

async fn task_output(
    State(state): State<DashboardState>,
    Path(task_id): Path<String>,
) -> Result<String, (StatusCode, String)> {
    let s = state.store.read().await;
    let task = s
        .tasks
        .get(&task_id)
        .ok_or((StatusCode::NOT_FOUND, "task not found".into()))?;

    let path = &task.output_file;
    if path.exists() {
        tokio::fs::read_to_string(path)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
    } else {
        Ok(String::new())
    }
}

#[derive(Serialize)]
struct PendingPermissionDto {
    request_id: String,
    agent_id: String,
    task_id: String,
    tool_name: String,
    input_summary: String,
    requested_at: String,
}

async fn pending_permissions(
    State(state): State<DashboardState>,
) -> Json<Vec<PendingPermissionDto>> {
    let s = state.store.read().await;
    let perms: Vec<PendingPermissionDto> = s
        .pending_permissions
        .iter()
        .map(|p| PendingPermissionDto {
            request_id: p.request_id.clone(),
            agent_id: p.agent_id.to_string(),
            task_id: p.task_id.clone(),
            tool_name: p.tool_name.clone(),
            input_summary: p.input_summary.clone(),
            requested_at: p.requested_at.to_rfc3339(),
        })
        .collect();
    Json(perms)
}

async fn approve_permission(
    State(state): State<DashboardState>,
    Path(request_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let rid = request_id.clone();
    state
        .store
        .update_and_emit(
            move |s| {
                s.resolve_permission(&rid);
            },
            AppEvent::PermissionResponse {
                request_id: request_id.clone(),
                approved: true,
            },
        )
        .await;

    Ok(Json(serde_json::json!({"approved": request_id})))
}

async fn deny_permission(
    State(state): State<DashboardState>,
    Path(request_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let rid = request_id.clone();
    state
        .store
        .update_and_emit(
            move |s| {
                s.resolve_permission(&rid);
            },
            AppEvent::PermissionResponse {
                request_id: request_id.clone(),
                approved: false,
            },
        )
        .await;

    Ok(Json(serde_json::json!({"denied": request_id})))
}

#[derive(Serialize)]
struct NotificationDto {
    id: String,
    level: String,
    title: String,
    body: String,
    timestamp: String,
    read: bool,
}

async fn list_notifications(State(state): State<DashboardState>) -> Json<Vec<NotificationDto>> {
    let s = state.store.read().await;
    let notes: Vec<NotificationDto> = s
        .notifications
        .iter()
        .map(|n| NotificationDto {
            id: n.id.clone(),
            level: format!("{:?}", n.level),
            title: n.title.clone(),
            body: n.body.clone(),
            timestamp: n.timestamp.to_rfc3339(),
            read: n.read,
        })
        .collect();
    Json(notes)
}

async fn mark_notification_read(
    State(state): State<DashboardState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let mut s = state.store.write().await;
    if let Some(n) = s.notifications.iter_mut().find(|n| n.id == id) {
        n.read = true;
        Ok(Json(serde_json::json!({"read": id})))
    } else {
        Err((StatusCode::NOT_FOUND, "notification not found".into()))
    }
}

#[derive(Serialize)]
struct MetricsDto {
    uptime_secs: i64,
    total_tokens: TokenUsageDto,
    total_cost_usd: f64,
    active_tasks: u32,
    completed_tasks: u64,
    failed_tasks: u64,
    agents_count: usize,
    coordinator_count: usize,
    pending_permissions: usize,
    unread_notifications: usize,
}

async fn metrics(State(state): State<DashboardState>) -> Json<MetricsDto> {
    let s = state.store.read().await;
    let uptime = (Utc::now() - s.started_at).num_seconds();
    let unread = s.notifications.iter().filter(|n| !n.read).count();

    Json(MetricsDto {
        uptime_secs: uptime,
        total_tokens: TokenUsageDto {
            input_tokens: s.token_usage_total.input_tokens,
            output_tokens: s.token_usage_total.output_tokens,
            total: s.token_usage_total.total_tokens(),
        },
        total_cost_usd: s.cost_total_usd,
        active_tasks: s.active_task_count,
        completed_tasks: s.completed_count,
        failed_tasks: s.failed_count,
        agents_count: s.agent_registry.len(),
        coordinator_count: s.coordinator_states.len(),
        pending_permissions: s.pending_permissions.len(),
        unread_notifications: unread,
    })
}

async fn sse_events(
    State(state): State<DashboardState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    {
        let mut s = state.store.write().await;
        s.connected_clients += 1;
    }

    let rx = state.store.subscribe();
    let store_clone = state.store.clone();

    let stream = BroadcastStream::new(rx).map(move |result| match result {
        Ok(event) => {
            let te = TimestampedEvent::new(event);
            let data = serde_json::to_string(&te).unwrap_or_default();
            Ok(Event::default().data(data))
        }
        Err(_) => Ok(Event::default().comment("missed event")),
    });

    let stream = stream.chain(futures_util::stream::once(async move {
        let mut s = store_clone.write().await;
        s.connected_clients = s.connected_clients.saturating_sub(1);
        Ok(Event::default().comment("disconnected"))
    }));

    Sse::new(stream)
}
