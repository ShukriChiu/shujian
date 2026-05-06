use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
    routing::{delete, get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::info;

use crate::audit::logger::AuditLogger;
use crate::audit::profile::ProfileStore;
use crate::compaction::engine::CompactionEngine;
use crate::cost::budget::BudgetEnforcer;
use crate::cost::report::CostReporter;
use crate::agent::orchestrator::{Orchestrator, SubTaskResult};
use crate::hitl::manager::HitlManager;
use crate::hitl::types::InteractionResponse;
use crate::hooks::registry::HookRegistry;
use crate::mcp::manager::McpManager;
use crate::mcp::types::{McpServerConfig, ToolCallRequest};
use crate::permissions::engine::PermissionEngine;
use crate::skills::resolver::SkillResolver;
use crate::skills::types::LoadedSkill;
use crate::streaming::sse::SseBroadcaster;
use crate::types::state::AppStateStore;

use super::dashboard::{dashboard_router, DashboardState};

#[derive(Clone)]
pub struct UnifiedState {
    pub store: AppStateStore,
    pub mcp: Arc<McpManager>,
    pub skills: Arc<SkillResolver>,
    pub hooks: Arc<HookRegistry>,
    pub audit: Arc<AuditLogger>,
    pub profiles: Arc<ProfileStore>,
    pub compaction: Arc<CompactionEngine>,
    pub permissions: Arc<PermissionEngine>,
    pub broadcaster: Arc<SseBroadcaster>,
    pub budget: Arc<BudgetEnforcer>,
    pub cost_reporter: Arc<CostReporter>,
    pub hitl: Arc<HitlManager>,
    pub orchestrator: Arc<Orchestrator>,
}

pub fn unified_router(state: UnifiedState) -> Router {
    let dashboard_state = DashboardState {
        store: state.store.clone(),
    };

    let dashboard = dashboard_router().with_state(dashboard_state);

    let extensions = Router::new()
        .route("/api/v2/mcp/servers", get(list_mcp_servers))
        .route("/api/v2/mcp/servers", post(add_mcp_server))
        .route(
            "/api/v2/mcp/servers/{name}/connect",
            post(connect_mcp_server),
        )
        .route(
            "/api/v2/mcp/servers/{name}/disconnect",
            post(disconnect_mcp_server),
        )
        .route("/api/v2/mcp/servers/{name}", delete(remove_mcp_server))
        .route("/api/v2/mcp/tools", get(list_mcp_tools))
        .route("/api/v2/mcp/tools/call", post(call_mcp_tool))
        .route("/api/v2/mcp/resources", get(list_mcp_resources))
        .route("/api/v2/skills", get(list_skills))
        .route("/api/v2/skills/{name}", get(get_skill))
        .route("/api/v2/skills/{name}/invoke", post(invoke_skill))
        .route("/api/v2/hooks/status", get(hooks_status))
        .route("/api/v2/audit/query", get(query_audit))
        .route("/api/v2/profiles", get(list_profiles))
        .route("/api/v2/profiles/{agent_type}", get(get_profile))
        .route(
            "/api/v2/profiles/recommend",
            post(recommend_agent),
        )
        .route("/api/v2/context/stats", get(context_stats))
        .route("/api/v2/context/history", get(compaction_history))
        .route("/api/v2/permissions/stats", get(permission_stats))
        .route("/api/v2/permissions/mode", post(set_permission_mode))
        .route("/api/v2/stream", get(sse_stream))
        .route("/api/v2/cost/budget", get(budget_stats))
        .route("/api/v2/cost/report", get(cost_report))
        // HITL: Human-in-the-Loop interactions
        .route("/api/v2/hitl/pending", get(hitl_list_pending))
        .route("/api/v2/hitl/pending/{id}", get(hitl_get_pending))
        .route("/api/v2/hitl/respond", post(hitl_respond))
        .route("/api/v2/hitl/cancel/{id}", post(hitl_cancel))
        .route("/api/v2/hitl/stats", get(hitl_stats))
        .route("/api/v2/hitl/history", get(hitl_history))
        // Orchestrator: multi-agent coordination
        .route("/api/v2/orchestrator/sessions", get(orch_list_sessions))
        .route("/api/v2/orchestrator/sessions/{id}", get(orch_get_session))
        .route("/api/v2/orchestrator/sessions/{id}/results", get(orch_results))
        .route("/api/v2/orchestrator/sessions/{id}/cancel", post(orch_cancel))
        .route("/api/v2/orchestrator/sessions/{id}/record", post(orch_record_result))
        .route("/api/v2/orchestrator/stats", get(orch_stats))
        .with_state(state);

    dashboard.merge(extensions)
}

#[derive(Serialize)]
struct McpServerDto {
    name: String,
    status: String,
    tool_count: usize,
    resource_count: usize,
    error: Option<String>,
}

async fn list_mcp_servers(
    State(state): State<UnifiedState>,
) -> Json<Vec<McpServerDto>> {
    let servers = state.mcp.server_states().await;
    let dtos: Vec<McpServerDto> = servers
        .iter()
        .map(|s| McpServerDto {
            name: s.config.name.clone(),
            status: format!("{:?}", s.status),
            tool_count: s.tools.len(),
            resource_count: s.resources.len(),
            error: s.error.clone(),
        })
        .collect();
    Json(dtos)
}

async fn add_mcp_server(
    State(state): State<UnifiedState>,
    Json(config): Json<McpServerConfig>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    state
        .mcp
        .add_server(config.clone())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(serde_json::json!({"added": config.name})))
}

async fn connect_mcp_server(
    State(state): State<UnifiedState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    state
        .mcp
        .connect_server(&name)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(serde_json::json!({"connected": name})))
}

async fn disconnect_mcp_server(
    State(state): State<UnifiedState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    state
        .mcp
        .disconnect_server(&name)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(serde_json::json!({"disconnected": name})))
}

async fn remove_mcp_server(
    State(state): State<UnifiedState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    state
        .mcp
        .remove_server(&name)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(serde_json::json!({"removed": name})))
}

#[derive(Serialize)]
struct McpToolDto {
    name: String,
    description: String,
    server_name: String,
    input_schema: serde_json::Value,
}

async fn list_mcp_tools(
    State(state): State<UnifiedState>,
) -> Json<Vec<McpToolDto>> {
    let tools = state.mcp.all_tools().await;
    let dtos: Vec<McpToolDto> = tools
        .iter()
        .map(|t| McpToolDto {
            name: t.name.clone(),
            description: t.description.clone(),
            server_name: t.server_name.clone(),
            input_schema: t.input_schema.clone(),
        })
        .collect();
    Json(dtos)
}

async fn call_mcp_tool(
    State(state): State<UnifiedState>,
    Json(request): Json<ToolCallRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let response = state
        .mcp
        .call_tool(request)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(serde_json::to_value(response).unwrap_or_default()))
}

#[derive(Serialize)]
struct McpResourceDto {
    uri: String,
    name: String,
    description: Option<String>,
    mime_type: Option<String>,
    server_name: String,
}

async fn list_mcp_resources(
    State(state): State<UnifiedState>,
) -> Json<Vec<McpResourceDto>> {
    let resources = state.mcp.all_resources().await;
    let dtos: Vec<McpResourceDto> = resources
        .iter()
        .map(|r| McpResourceDto {
            uri: r.uri.clone(),
            name: r.name.clone(),
            description: r.description.clone(),
            mime_type: r.mime_type.clone(),
            server_name: r.server_name.clone(),
        })
        .collect();
    Json(dtos)
}

#[derive(Serialize)]
struct SkillDto {
    name: String,
    description: String,
    slash_command: String,
    source: String,
    is_fork: bool,
    model_invocable: bool,
    user_invocable: bool,
    allowed_tools: Vec<String>,
    model: Option<String>,
    effort: Option<String>,
}

fn skill_to_dto(s: &LoadedSkill) -> SkillDto {
    SkillDto {
        name: s.name.clone(),
        description: s.description().to_string(),
        slash_command: s.slash_command(),
        source: format!("{:?}", s.source),
        is_fork: s.is_fork(),
        model_invocable: s.is_model_invocable(),
        user_invocable: s.is_user_invocable(),
        allowed_tools: s.allowed_tools(),
        model: s.frontmatter.model.clone(),
        effort: s.frontmatter.effort.clone(),
    }
}

async fn list_skills(
    State(state): State<UnifiedState>,
) -> Json<Vec<SkillDto>> {
    let dtos: Vec<SkillDto> = state
        .skills
        .all_skills()
        .iter()
        .filter(|s| s.is_user_invocable())
        .map(skill_to_dto)
        .collect();
    Json(dtos)
}

async fn get_skill(
    State(state): State<UnifiedState>,
    Path(name): Path<String>,
) -> Result<Json<SkillDto>, (StatusCode, String)> {
    let skill = state
        .skills
        .by_name(&name)
        .ok_or((StatusCode::NOT_FOUND, format!("skill not found: {}", name)))?;
    Ok(Json(skill_to_dto(skill)))
}

#[derive(Deserialize)]
struct InvokeSkillRequest {
    arguments: Option<String>,
    session_id: Option<String>,
}

#[derive(Serialize)]
struct InvokeSkillResponse {
    skill_name: String,
    rendered_instructions: String,
    is_fork: bool,
}

async fn invoke_skill(
    State(state): State<UnifiedState>,
    Path(name): Path<String>,
    Json(req): Json<InvokeSkillRequest>,
) -> Result<Json<InvokeSkillResponse>, (StatusCode, String)> {
    let skill = state
        .skills
        .by_name(&name)
        .ok_or((StatusCode::NOT_FOUND, format!("skill not found: {}", name)))?;

    let args = req.arguments.unwrap_or_default();
    let session = req.session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let rendered = state.skills.render_instructions(skill, &args, &session);

    Ok(Json(InvokeSkillResponse {
        skill_name: skill.name.clone(),
        rendered_instructions: rendered,
        is_fork: skill.is_fork(),
    }))
}

#[derive(Serialize)]
struct HooksStatusDto {
    total_hooks: usize,
    disabled: bool,
}

async fn hooks_status(
    State(state): State<UnifiedState>,
) -> Json<HooksStatusDto> {
    Json(HooksStatusDto {
        total_hooks: state.hooks.count(),
        disabled: state.hooks.is_disabled(),
    })
}

#[derive(Deserialize)]
struct AuditQueryParams {
    #[serde(default)]
    event_type: Option<String>,
    #[serde(default)]
    agent_type: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

async fn query_audit(
    State(state): State<UnifiedState>,
    Query(params): Query<AuditQueryParams>,
) -> Json<Vec<serde_json::Value>> {
    use crate::audit::logger::AuditFilter;
    let filter = AuditFilter {
        agent_type: params.agent_type,
        limit: params.limit,
        ..Default::default()
    };

    let entries = state.audit.query(filter).await.unwrap_or_default();
    let values: Vec<serde_json::Value> = entries
        .iter()
        .filter_map(|e| serde_json::to_value(e).ok())
        .collect();
    Json(values)
}

async fn list_profiles(
    State(state): State<UnifiedState>,
) -> Json<Vec<serde_json::Value>> {
    let profiles = state.profiles.all_profiles();
    let values: Vec<serde_json::Value> = profiles
        .iter()
        .filter_map(|p| serde_json::to_value(p).ok())
        .collect();
    Json(values)
}

async fn get_profile(
    State(state): State<UnifiedState>,
    Path(agent_type): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let profile = state
        .profiles
        .get_profile(&agent_type)
        .ok_or((
            StatusCode::NOT_FOUND,
            format!("no profile for agent type: {}", agent_type),
        ))?;
    let value = serde_json::to_value(profile)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(value))
}

#[derive(Deserialize)]
struct RecommendRequest {
    task_description: String,
    #[serde(default)]
    domain: Option<String>,
}

async fn recommend_agent(
    State(state): State<UnifiedState>,
    Json(req): Json<RecommendRequest>,
) -> Json<serde_json::Value> {
    let recommended = state
        .profiles
        .recommend_agent(req.domain.as_deref());
    Json(serde_json::json!({
        "recommended_agent_type": recommended,
        "task_description": req.task_description,
    }))
}

async fn context_stats(
    State(state): State<UnifiedState>,
) -> Json<serde_json::Value> {
    let stats = state.compaction.stats(0, 0, 0).await;
    let budget = state.compaction.budget();
    Json(serde_json::json!({
        "budget": {
            "max_context_tokens": budget.max_context_tokens,
            "output_headroom": budget.output_headroom,
            "compaction_headroom": budget.compaction_headroom,
            "usable_tokens": budget.usable_tokens(),
            "auto_compact_threshold": budget.auto_compact_threshold,
        },
        "stats": {
            "offloaded_results": stats.offloaded_results,
            "hot_tail_results": stats.hot_tail_results,
            "compaction_count": stats.compaction_count,
        }
    }))
}

async fn compaction_history(
    State(state): State<UnifiedState>,
) -> Json<Vec<serde_json::Value>> {
    let history = state.compaction.compaction_history().await;
    let values: Vec<serde_json::Value> = history
        .iter()
        .filter_map(|s| serde_json::to_value(s).ok())
        .collect();
    Json(values)
}

async fn permission_stats(
    State(state): State<UnifiedState>,
) -> Json<serde_json::Value> {
    let stats = state.permissions.stats().await;
    serde_json::to_value(stats)
        .map(Json)
        .unwrap_or_else(|_| Json(serde_json::json!({})))
}

#[derive(Deserialize)]
struct SetModeRequest {
    mode: crate::permissions::types::PermissionMode,
}

async fn set_permission_mode(
    State(state): State<UnifiedState>,
    Json(req): Json<SetModeRequest>,
) -> Json<serde_json::Value> {
    state.permissions.set_mode(req.mode).await;
    Json(serde_json::json!({
        "mode": format!("{}", req.mode),
    }))
}

async fn sse_stream(
    State(state): State<UnifiedState>,
) -> axum::response::sse::Sse<impl futures_util::stream::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>> + 'static>
{
    crate::streaming::sse::sse_response(state.broadcaster)
}

async fn budget_stats(
    State(state): State<UnifiedState>,
) -> Json<serde_json::Value> {
    let stats = state.budget.global_stats().await;
    serde_json::to_value(stats)
        .map(Json)
        .unwrap_or_else(|_| Json(serde_json::json!({})))
}

#[derive(Deserialize)]
struct CostReportParams {
    days: Option<u32>,
}

async fn cost_report(
    State(state): State<UnifiedState>,
    Query(params): Query<CostReportParams>,
) -> Json<serde_json::Value> {
    let since = params.days.map(|d| {
        Utc::now() - chrono::Duration::days(d as i64)
    });
    let report = state.cost_reporter.generate_report(since, None).await;
    serde_json::to_value(report)
        .map(Json)
        .unwrap_or_else(|_| Json(serde_json::json!({})))
}

use chrono::Utc;

// ── HITL Handlers ──────────────────────────────────────────────

async fn hitl_list_pending(
    State(state): State<UnifiedState>,
) -> Json<Vec<serde_json::Value>> {
    let pending = state.hitl.list_pending().await;
    let values: Vec<serde_json::Value> = pending
        .iter()
        .filter_map(|p| serde_json::to_value(p).ok())
        .collect();
    Json(values)
}

async fn hitl_get_pending(
    State(state): State<UnifiedState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let interaction = state
        .hitl
        .get_pending(&id)
        .await
        .ok_or((StatusCode::NOT_FOUND, format!("interaction not found: {}", id)))?;
    let value = serde_json::to_value(interaction)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(value))
}

async fn hitl_respond(
    State(state): State<UnifiedState>,
    Json(response): Json<InteractionResponse>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    state
        .hitl
        .respond(response)
        .await
        .map_err(|e| (StatusCode::from_u16(e.status_code()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), e.to_string()))?;
    Ok(Json(serde_json::json!({"status": "answered"})))
}

async fn hitl_cancel(
    State(state): State<UnifiedState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    state
        .hitl
        .cancel(&id)
        .await
        .map_err(|e| (StatusCode::from_u16(e.status_code()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), e.to_string()))?;
    Ok(Json(serde_json::json!({"status": "cancelled"})))
}

async fn hitl_stats(
    State(state): State<UnifiedState>,
) -> Json<serde_json::Value> {
    let stats = state.hitl.stats().await;
    serde_json::to_value(stats)
        .map(Json)
        .unwrap_or_else(|_| Json(serde_json::json!({})))
}

#[derive(Deserialize)]
struct HitlHistoryParams {
    limit: Option<usize>,
}

async fn hitl_history(
    State(state): State<UnifiedState>,
    Query(params): Query<HitlHistoryParams>,
) -> Json<Vec<serde_json::Value>> {
    let limit = params.limit.unwrap_or(50);
    let history = state.hitl.history(limit).await;
    let values: Vec<serde_json::Value> = history
        .iter()
        .filter_map(|h| serde_json::to_value(h).ok())
        .collect();
    Json(values)
}

// ── Orchestrator Handlers ──────────────────────────────────────

async fn orch_list_sessions(
    State(state): State<UnifiedState>,
) -> Json<Vec<serde_json::Value>> {
    let sessions = state.orchestrator.list_sessions().await;
    let values: Vec<serde_json::Value> = sessions
        .iter()
        .filter_map(|s| serde_json::to_value(s).ok())
        .collect();
    Json(values)
}

async fn orch_get_session(
    State(state): State<UnifiedState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let session = state
        .orchestrator
        .get_session(&id)
        .await
        .ok_or((StatusCode::NOT_FOUND, format!("session not found: {}", id)))?;
    let value = serde_json::to_value(session)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(value))
}

async fn orch_results(
    State(state): State<UnifiedState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let results = state
        .orchestrator
        .aggregate_results(&id)
        .await
        .map_err(|e| (StatusCode::from_u16(e.status_code()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), e.to_string()))?;
    let value = serde_json::to_value(results)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(value))
}

async fn orch_cancel(
    State(state): State<UnifiedState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    state
        .orchestrator
        .cancel_session(&id)
        .await
        .map_err(|e| (StatusCode::from_u16(e.status_code()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), e.to_string()))?;
    Ok(Json(serde_json::json!({"status": "cancelled"})))
}

async fn orch_record_result(
    State(state): State<UnifiedState>,
    Path(id): Path<String>,
    Json(result): Json<SubTaskResult>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let status = state
        .orchestrator
        .record_result(&id, result)
        .await
        .map_err(|e| (StatusCode::from_u16(e.status_code()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), e.to_string()))?;
    Ok(Json(serde_json::json!({"session_status": status})))
}

async fn orch_stats(
    State(state): State<UnifiedState>,
) -> Json<serde_json::Value> {
    let stats = state.orchestrator.stats().await;
    serde_json::to_value(stats)
        .map(Json)
        .unwrap_or_else(|_| Json(serde_json::json!({})))
}
