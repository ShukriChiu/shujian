//! Per-student timeline notes.
//!
//! Replaces 0005's rigid `feedback_signal` enum with a freeform body
//! plus a `kind` for visual grouping (intake / interview / checkin /
//! milestone / concern / general). Optional project link lets a single
//! note attribute to a specific squad ("shipped onboarding feature on
//! project Atlas").

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::middleware::AuthContext;
use crate::state::AppState;

use super::require_tenant;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: Uuid,
    pub student_id: Uuid,
    pub project_id: Option<Uuid>,
    pub project_name: Option<String>,
    pub kind: String,
    pub body: String,
    pub author_user_id: Option<Uuid>,
    pub author_name: Option<String>,
    pub created_at: DateTime<Utc>,
}

pub async fn list(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(student_id): Path<Uuid>,
) -> AppResult<Json<Vec<Note>>> {
    let tenant_id = require_tenant(&auth)?;
    let rows = sqlx::query_as::<_, Note>(
        r#"
        SELECT n.id, n.student_id, n.project_id,
               p.name AS project_name,
               n.kind, n.body, n.author_user_id,
               COALESCE(u.display_name, u.identifier) AS author_name,
               n.created_at
        FROM future_notes n
        LEFT JOIN future_projects p
          ON p.tenant_id = n.tenant_id AND p.id = n.project_id
        LEFT JOIN users u
          ON u.id = n.author_user_id
        WHERE n.tenant_id = $1 AND n.student_id = $2
        ORDER BY n.created_at DESC, n.id
        "#,
    )
    .bind(tenant_id)
    .bind(student_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNote {
    pub body: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub project_id: Option<Uuid>,
}

fn default_kind() -> String {
    "general".into()
}

pub async fn create(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(student_id): Path<Uuid>,
    Json(body): Json<CreateNote>,
) -> AppResult<(StatusCode, Json<Note>)> {
    let tenant_id = require_tenant(&auth)?;
    if body.body.trim().is_empty() {
        return Err(AppError::bad_request("body is required"));
    }
    if !is_valid_kind(&body.kind) {
        return Err(AppError::bad_request(format!(
            "invalid kind: {}",
            body.kind
        )));
    }
    let id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO future_notes (
            tenant_id, id, student_id, project_id, kind, body, author_user_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(tenant_id)
    .bind(id)
    .bind(student_id)
    .bind(body.project_id)
    .bind(&body.kind)
    .bind(body.body.trim())
    .bind(auth.user.id)
    .execute(&state.db)
    .await?;

    let row = sqlx::query_as::<_, Note>(
        r#"
        SELECT n.id, n.student_id, n.project_id,
               p.name AS project_name,
               n.kind, n.body, n.author_user_id,
               COALESCE(u.display_name, u.identifier) AS author_name,
               n.created_at
        FROM future_notes n
        LEFT JOIN future_projects p
          ON p.tenant_id = n.tenant_id AND p.id = n.project_id
        LEFT JOIN users u
          ON u.id = n.author_user_id
        WHERE n.tenant_id = $1 AND n.id = $2
        "#,
    )
    .bind(tenant_id)
    .bind(id)
    .fetch_one(&state.db)
    .await?;

    Ok((StatusCode::CREATED, Json(row)))
}

pub async fn delete(
    State(state): State<AppState>,
    auth: AuthContext,
    Path((_student_id, note_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let tenant_id = require_tenant(&auth)?;
    let result = sqlx::query(
        r#"
        DELETE FROM future_notes
        WHERE tenant_id = $1 AND id = $2
        "#,
    )
    .bind(tenant_id)
    .bind(note_id)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

fn is_valid_kind(s: &str) -> bool {
    matches!(
        s,
        "general" | "intake" | "interview" | "checkin" | "milestone" | "concern"
    )
}
