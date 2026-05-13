//! Admin-side projects CRUD.
//!
//! Slim model: name + summary + status + dates. Anything richer (skill
//! needs, milestones, perks) can live in the notes timeline until it
//! demonstrably needs structure.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::middleware::AuthContext;
use crate::state::AppState;

use super::require_tenant;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: Uuid,
    pub name: String,
    pub summary: String,
    pub status: String,
    pub started_at: Option<NaiveDate>,
    pub ended_at: Option<NaiveDate>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Convenience: how many active assignments. Cheap aggregate to
    /// drive the project list UI ("3 students on this").
    pub active_member_count: i64,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub status: Option<String>,
}

pub async fn list(
    State(state): State<AppState>,
    auth: AuthContext,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Vec<Project>>> {
    let tenant_id = require_tenant(&auth)?;
    let statuses: Option<Vec<String>> = q
        .status
        .as_deref()
        .map(|s| s.split(',').map(|x| x.trim().to_string()).collect());

    let rows = sqlx::query_as::<_, Project>(
        r#"
        SELECT
          p.id, p.name, p.summary, p.status,
          p.started_at, p.ended_at, p.created_at, p.updated_at,
          COALESCE((
            SELECT COUNT(*) FROM future_assignments a
            WHERE a.tenant_id = p.tenant_id
              AND a.project_id = p.id
              AND a.status = 'active'
          ), 0) AS active_member_count
        FROM future_projects p
        WHERE p.tenant_id = $1
          AND ( $2::text[] IS NULL OR p.status = ANY($2) )
          AND ( $2::text[] IS NOT NULL OR p.status <> 'archived' )
        ORDER BY p.created_at DESC, p.id
        "#,
    )
    .bind(tenant_id)
    .bind(statuses.as_deref())
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

pub async fn get(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Project>> {
    let tenant_id = require_tenant(&auth)?;
    let row = sqlx::query_as::<_, Project>(
        r#"
        SELECT
          p.id, p.name, p.summary, p.status,
          p.started_at, p.ended_at, p.created_at, p.updated_at,
          COALESCE((
            SELECT COUNT(*) FROM future_assignments a
            WHERE a.tenant_id = p.tenant_id
              AND a.project_id = p.id
              AND a.status = 'active'
          ), 0) AS active_member_count
        FROM future_projects p
        WHERE p.tenant_id = $1 AND p.id = $2
        "#,
    )
    .bind(tenant_id)
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(row))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProject {
    pub name: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default = "default_project_status")]
    pub status: String,
    pub started_at: Option<NaiveDate>,
    pub ended_at: Option<NaiveDate>,
}

fn default_project_status() -> String {
    "planning".into()
}

pub async fn create(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(body): Json<CreateProject>,
) -> AppResult<(StatusCode, Json<Project>)> {
    let tenant_id = require_tenant(&auth)?;
    if body.name.trim().is_empty() {
        return Err(AppError::bad_request("name is required"));
    }
    if !is_valid_status(&body.status) {
        return Err(AppError::bad_request(format!(
            "invalid status: {}",
            body.status
        )));
    }
    let id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO future_projects (
            tenant_id, id, name, summary, status, started_at, ended_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(tenant_id)
    .bind(id)
    .bind(body.name.trim())
    .bind(body.summary)
    .bind(&body.status)
    .bind(body.started_at)
    .bind(body.ended_at)
    .execute(&state.db)
    .await?;

    let r = get(State(state), auth, Path(id)).await?;
    Ok((StatusCode::CREATED, r))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProject {
    pub name: Option<String>,
    pub summary: Option<String>,
    pub status: Option<String>,
    pub started_at: Option<NaiveDate>,
    pub ended_at: Option<NaiveDate>,
}

pub async fn update(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateProject>,
) -> AppResult<Json<Project>> {
    let tenant_id = require_tenant(&auth)?;
    if let Some(s) = body.status.as_deref()
        && !is_valid_status(s)
    {
        return Err(AppError::bad_request(format!("invalid status: {s}")));
    }

    sqlx::query(
        r#"
        UPDATE future_projects SET
          name       = COALESCE($3, name),
          summary    = COALESCE($4, summary),
          status     = COALESCE($5, status),
          started_at = COALESCE($6, started_at),
          ended_at   = COALESCE($7, ended_at),
          updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        "#,
    )
    .bind(tenant_id)
    .bind(id)
    .bind(body.name.as_deref().map(str::trim))
    .bind(body.summary.as_deref())
    .bind(body.status.as_deref())
    .bind(body.started_at)
    .bind(body.ended_at)
    .execute(&state.db)
    .await?;

    get(State(state), auth, Path(id)).await
}

pub async fn delete(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let tenant_id = require_tenant(&auth)?;
    let result = sqlx::query(
        r#"
        UPDATE future_projects
           SET status = 'archived', updated_at = now()
         WHERE tenant_id = $1 AND id = $2
        "#,
    )
    .bind(tenant_id)
    .bind(id)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

fn is_valid_status(s: &str) -> bool {
    matches!(
        s,
        "planning" | "active" | "paused" | "completed" | "archived"
    )
}
