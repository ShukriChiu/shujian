//! Student ↔ project assignments. The growth-tracking primitive.

use axum::Json;
use axum::extract::{Path, State};
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
pub struct Assignment {
    pub student_id: Uuid,
    pub project_id: Uuid,
    pub project_name: String,
    pub student_name: String,
    pub role: String,
    pub status: String,
    pub joined_at: NaiveDate,
    pub left_at: Option<NaiveDate>,
    pub notes: String,
    pub updated_at: DateTime<Utc>,
}

/// `GET /v1/future/students/:id/assignments` — every project this
/// student is on, joined with project name for display.
pub async fn list_for_student(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(student_id): Path<Uuid>,
) -> AppResult<Json<Vec<Assignment>>> {
    let tenant_id = require_tenant(&auth)?;
    let rows = sqlx::query_as::<_, Assignment>(
        r#"
        SELECT a.student_id, a.project_id,
               p.name AS project_name,
               s.full_name AS student_name,
               a.role, a.status, a.joined_at, a.left_at, a.notes, a.updated_at
        FROM future_assignments a
        JOIN future_projects p
          ON p.tenant_id = a.tenant_id AND p.id = a.project_id
        JOIN future_students s
          ON s.tenant_id = a.tenant_id AND s.id = a.student_id
        WHERE a.tenant_id = $1 AND a.student_id = $2
        ORDER BY a.joined_at DESC, p.name
        "#,
    )
    .bind(tenant_id)
    .bind(student_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

/// `GET /v1/future/projects/:id/assignments` — every student on this
/// project. Mirror of `list_for_student`.
pub async fn list_for_project(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(project_id): Path<Uuid>,
) -> AppResult<Json<Vec<Assignment>>> {
    let tenant_id = require_tenant(&auth)?;
    let rows = sqlx::query_as::<_, Assignment>(
        r#"
        SELECT a.student_id, a.project_id,
               p.name AS project_name,
               s.full_name AS student_name,
               a.role, a.status, a.joined_at, a.left_at, a.notes, a.updated_at
        FROM future_assignments a
        JOIN future_projects p
          ON p.tenant_id = a.tenant_id AND p.id = a.project_id
        JOIN future_students s
          ON s.tenant_id = a.tenant_id AND s.id = a.student_id
        WHERE a.tenant_id = $1 AND a.project_id = $2
        ORDER BY a.status, s.full_name
        "#,
    )
    .bind(tenant_id)
    .bind(project_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAssignment {
    pub project_id: Uuid,
    #[serde(default = "default_role")]
    pub role: String,
    #[serde(default = "default_assignment_status")]
    pub status: String,
    pub joined_at: Option<NaiveDate>,
    #[serde(default)]
    pub notes: String,
}

fn default_role() -> String {
    "队员".into()
}

fn default_assignment_status() -> String {
    "active".into()
}

/// `POST /v1/future/students/:id/assignments` — assign a student to a
/// project. Idempotent: re-assigning the same pair updates the existing
/// row instead of erroring.
pub async fn create(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(student_id): Path<Uuid>,
    Json(body): Json<CreateAssignment>,
) -> AppResult<Json<Assignment>> {
    let tenant_id = require_tenant(&auth)?;
    if !is_valid_status(&body.status) {
        return Err(AppError::bad_request(format!(
            "invalid status: {}",
            body.status
        )));
    }

    sqlx::query(
        r#"
        INSERT INTO future_assignments (
            tenant_id, student_id, project_id, role, status, joined_at, notes
        ) VALUES ($1, $2, $3, $4, $5, COALESCE($6, current_date), $7)
        ON CONFLICT (tenant_id, student_id, project_id) DO UPDATE SET
            role       = EXCLUDED.role,
            status     = EXCLUDED.status,
            joined_at  = EXCLUDED.joined_at,
            notes      = EXCLUDED.notes,
            updated_at = now()
        "#,
    )
    .bind(tenant_id)
    .bind(student_id)
    .bind(body.project_id)
    .bind(&body.role)
    .bind(&body.status)
    .bind(body.joined_at)
    .bind(&body.notes)
    .execute(&state.db)
    .await?;

    let row = sqlx::query_as::<_, Assignment>(
        r#"
        SELECT a.student_id, a.project_id,
               p.name AS project_name,
               s.full_name AS student_name,
               a.role, a.status, a.joined_at, a.left_at, a.notes, a.updated_at
        FROM future_assignments a
        JOIN future_projects p
          ON p.tenant_id = a.tenant_id AND p.id = a.project_id
        JOIN future_students s
          ON s.tenant_id = a.tenant_id AND s.id = a.student_id
        WHERE a.tenant_id = $1 AND a.student_id = $2 AND a.project_id = $3
        "#,
    )
    .bind(tenant_id)
    .bind(student_id)
    .bind(body.project_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(row))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAssignment {
    pub role: Option<String>,
    pub status: Option<String>,
    pub joined_at: Option<NaiveDate>,
    pub left_at: Option<NaiveDate>,
    pub notes: Option<String>,
}

/// `PATCH /v1/future/students/:student_id/assignments/:project_id`
pub async fn update(
    State(state): State<AppState>,
    auth: AuthContext,
    Path((student_id, project_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateAssignment>,
) -> AppResult<Json<Assignment>> {
    let tenant_id = require_tenant(&auth)?;
    if let Some(s) = body.status.as_deref()
        && !is_valid_status(s)
    {
        return Err(AppError::bad_request(format!("invalid status: {s}")));
    }

    let result = sqlx::query(
        r#"
        UPDATE future_assignments SET
            role       = COALESCE($4, role),
            status     = COALESCE($5, status),
            joined_at  = COALESCE($6, joined_at),
            left_at    = COALESCE($7, left_at),
            notes      = COALESCE($8, notes),
            updated_at = now()
        WHERE tenant_id = $1 AND student_id = $2 AND project_id = $3
        "#,
    )
    .bind(tenant_id)
    .bind(student_id)
    .bind(project_id)
    .bind(body.role.as_deref())
    .bind(body.status.as_deref())
    .bind(body.joined_at)
    .bind(body.left_at)
    .bind(body.notes.as_deref())
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    let row = sqlx::query_as::<_, Assignment>(
        r#"
        SELECT a.student_id, a.project_id,
               p.name AS project_name,
               s.full_name AS student_name,
               a.role, a.status, a.joined_at, a.left_at, a.notes, a.updated_at
        FROM future_assignments a
        JOIN future_projects p
          ON p.tenant_id = a.tenant_id AND p.id = a.project_id
        JOIN future_students s
          ON s.tenant_id = a.tenant_id AND s.id = a.student_id
        WHERE a.tenant_id = $1 AND a.student_id = $2 AND a.project_id = $3
        "#,
    )
    .bind(tenant_id)
    .bind(student_id)
    .bind(project_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(row))
}

/// `DELETE /v1/future/students/:student_id/assignments/:project_id`
pub async fn delete(
    State(state): State<AppState>,
    auth: AuthContext,
    Path((student_id, project_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let tenant_id = require_tenant(&auth)?;
    let result = sqlx::query(
        r#"
        DELETE FROM future_assignments
        WHERE tenant_id = $1 AND student_id = $2 AND project_id = $3
        "#,
    )
    .bind(tenant_id)
    .bind(student_id)
    .bind(project_id)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

fn is_valid_status(s: &str) -> bool {
    matches!(s, "active" | "completed" | "left")
}
