//! Admin-side students CRUD.

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Datelike, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::middleware::AuthContext;
use crate::state::AppState;

use super::require_tenant;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct StudentSummary {
    pub id: Uuid,
    pub full_name: String,
    pub birth_year: Option<i16>,
    pub wechat_nickname: String,
    pub university: String,
    pub major: String,
    pub grade_year: String,
    pub status: String,
    pub tags: Vec<String>,
    pub has_resume: bool,
    pub submitted_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct StudentDetail {
    pub id: Uuid,
    pub full_name: String,
    pub wechat_id: String,
    pub wechat_nickname: String,
    pub email: String,
    pub phone: String,
    pub birth_year: Option<i16>,
    pub university: String,
    pub major: String,
    pub grade_year: String,
    pub ai_understanding: String,
    pub ai_experience: String,
    pub past_projects: String,
    pub motivation: String,
    pub status: String,
    pub admin_notes: String,
    pub tags: Vec<String>,
    pub has_resume: bool,
    pub submitted_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub reviewed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    /// Optional comma-separated status filter, e.g. `?status=new,reviewing`.
    /// Omitted → all non-archived rows.
    pub status: Option<String>,
    /// Free-text search over name / wechat_nickname / wechat_id /
    /// university / major / email / phone. Case-insensitive contains.
    pub q: Option<String>,
}

/// `GET /v1/future/students` — list, newest first.
pub async fn list(
    State(state): State<AppState>,
    auth: AuthContext,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Vec<StudentSummary>>> {
    let tenant_id = require_tenant(&auth)?;

    let statuses: Option<Vec<String>> = q
        .status
        .as_deref()
        .map(|s| s.split(',').map(|x| x.trim().to_string()).collect());

    let needle =
        q.q.as_deref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

    let rows = sqlx::query_as::<_, StudentSummary>(
        r#"
        SELECT id, full_name, birth_year, wechat_nickname, university, major, grade_year,
               status, tags, has_resume, submitted_at, updated_at
        FROM future_students
        WHERE tenant_id = $1
          AND ( $2::text[] IS NULL OR status = ANY($2) )
          AND ( $2::text[] IS NOT NULL OR status <> 'archived' )
          AND ( $3::text IS NULL
                OR full_name        ILIKE '%' || $3 || '%'
                OR wechat_nickname  ILIKE '%' || $3 || '%'
                OR wechat_id        ILIKE '%' || $3 || '%'
                OR university       ILIKE '%' || $3 || '%'
                OR major            ILIKE '%' || $3 || '%'
                OR email            ILIKE '%' || $3 || '%'
                OR phone            ILIKE '%' || $3 || '%' )
        ORDER BY submitted_at DESC, id
        "#,
    )
    .bind(tenant_id)
    .bind(statuses.as_deref())
    .bind(needle.as_deref())
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

/// `GET /v1/future/students/:id` — full detail.
pub async fn get(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(id): Path<Uuid>,
) -> AppResult<Json<StudentDetail>> {
    let tenant_id = require_tenant(&auth)?;

    let row = sqlx::query_as::<_, StudentDetail>(
        r#"
        SELECT id, full_name, wechat_id, wechat_nickname, email, phone, birth_year,
               university, major, grade_year, ai_understanding, ai_experience,
               past_projects, motivation, status, admin_notes, tags,
               has_resume, submitted_at, updated_at, reviewed_at
        FROM future_students
        WHERE tenant_id = $1 AND id = $2
        "#,
    )
    .bind(tenant_id)
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(Json(row))
}

/// Admin-editable fields. Anything `Some` overwrites; anything `None`
/// preserves. `intake fields` (full_name etc.) are also editable here so
/// admins can correct typos in the original survey.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStudent {
    pub full_name: Option<String>,
    pub wechat_id: Option<String>,
    pub wechat_nickname: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub birth_year: Option<i16>,
    pub university: Option<String>,
    pub major: Option<String>,
    pub grade_year: Option<String>,
    pub ai_understanding: Option<String>,
    pub ai_experience: Option<String>,
    pub past_projects: Option<String>,
    pub motivation: Option<String>,
    pub status: Option<String>,
    pub admin_notes: Option<String>,
    pub tags: Option<Vec<String>>,
}

/// `PATCH /v1/future/students/:id` — partial update.
///
/// Stamps `reviewed_at` / `reviewed_by_user_id` the first time status
/// moves off `new`, so the list view can show "review queue: 3" by
/// counting `status = 'new'`.
pub async fn update(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateStudent>,
) -> AppResult<Json<StudentDetail>> {
    let tenant_id = require_tenant(&auth)?;
    if let Some(s) = body.status.as_deref()
        && !is_valid_status(s)
    {
        return Err(AppError::bad_request(format!("invalid status: {s}")));
    }
    if let Some(g) = body.grade_year.as_deref()
        && !is_valid_grade(g)
    {
        return Err(AppError::bad_request(format!("invalid gradeYear: {g}")));
    }
    if let Some(y) = body.birth_year {
        let y_now = chrono::Utc::now().year() as i16;
        if y < 1940 || y > y_now {
            return Err(AppError::bad_request("invalid birthYear"));
        }
    }

    let user_id = auth.user.id;
    sqlx::query(
        r#"
        UPDATE future_students SET
            full_name        = COALESCE($3,  full_name),
            wechat_id        = COALESCE($4,  wechat_id),
            wechat_nickname  = COALESCE($5,  wechat_nickname),
            email            = COALESCE($6,  email),
            phone            = COALESCE($7,  phone),
            birth_year       = COALESCE($8,  birth_year),
            university       = COALESCE($9,  university),
            major            = COALESCE($10, major),
            grade_year       = COALESCE($11, grade_year),
            ai_understanding = COALESCE($12, ai_understanding),
            ai_experience    = COALESCE($13, ai_experience),
            past_projects    = COALESCE($14, past_projects),
            motivation       = COALESCE($15, motivation),
            status           = COALESCE($16, status),
            admin_notes      = COALESCE($17, admin_notes),
            tags             = COALESCE($18, tags),
            updated_at       = now(),
            reviewed_at      = CASE
                                  WHEN reviewed_at IS NULL AND $16 IS NOT NULL AND $16 <> 'new'
                                  THEN now()
                                  ELSE reviewed_at
                               END,
            reviewed_by_user_id = CASE
                                  WHEN reviewed_by_user_id IS NULL AND $16 IS NOT NULL AND $16 <> 'new'
                                  THEN $19
                                  ELSE reviewed_by_user_id
                               END
        WHERE tenant_id = $1 AND id = $2
        "#,
    )
    .bind(tenant_id)
    .bind(id)
    .bind(body.full_name.as_deref().map(str::trim))
    .bind(body.wechat_id.as_deref().map(str::trim))
    .bind(body.wechat_nickname.as_deref().map(str::trim))
    .bind(body.email.as_deref().map(str::trim))
    .bind(body.phone.as_deref().map(str::trim))
    .bind(body.birth_year)
    .bind(body.university.as_deref().map(str::trim))
    .bind(body.major.as_deref().map(str::trim))
    .bind(body.grade_year.as_deref())
    .bind(body.ai_understanding.as_deref())
    .bind(body.ai_experience.as_deref())
    .bind(body.past_projects.as_deref())
    .bind(body.motivation.as_deref())
    .bind(body.status.as_deref())
    .bind(body.admin_notes.as_deref())
    .bind(body.tags.as_deref())
    .bind(user_id)
    .execute(&state.db)
    .await?;

    get(State(state), auth, Path(id)).await
}

/// `DELETE /v1/future/students/:id` — soft delete (status=archived).
/// Hard delete would also wipe assignments + notes; we'd rather keep
/// historical context for retrospective analyses.
pub async fn delete(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let tenant_id = require_tenant(&auth)?;

    let result = sqlx::query(
        r#"
        UPDATE future_students
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

/// `GET /v1/future/students/:id/resume` — stream the resume blob.
/// Sets Content-Disposition with the original filename so the browser
/// downloads with the right name.
pub async fn download_resume(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let tenant_id = require_tenant(&auth)?;

    let row = sqlx::query_as::<_, (String, String, Vec<u8>)>(
        r#"
        SELECT filename, mime, data
        FROM future_resumes
        WHERE tenant_id = $1 AND student_id = $2
        "#,
    )
    .bind(tenant_id)
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let (filename, mime, data) = row;

    let mut resp = Response::new(Body::from(data));
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&mime)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    let disp = format!("attachment; filename*=UTF-8''{}", urlencode_path(&filename));
    resp.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&disp).unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );

    Ok(resp.into_response())
}

/// Minimal RFC 5987 percent-encoding for filename* values. We only need
/// it for resume download and the input is short, so a hand-rolled pass
/// avoids a dep just for this.
fn urlencode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        let safe = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~');
        if safe {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn is_valid_status(s: &str) -> bool {
    matches!(
        s,
        "new"
            | "reviewing"
            | "interview"
            | "accepted"
            | "rejected"
            | "in_project"
            | "alumni"
            | "archived"
    )
}

fn is_valid_grade(s: &str) -> bool {
    matches!(
        s,
        "freshman"
            | "sophomore"
            | "junior"
            | "senior"
            | "master_1"
            | "master_2"
            | "master_3"
            | "phd"
            | "alumni"
            | "other"
    )
}
