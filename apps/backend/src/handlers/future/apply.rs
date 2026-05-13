//! Public submission endpoints — no bearer auth.
//!
//! `GET  /v1/future/apply/:token` — tenant info for the apply page header
//! `POST /v1/future/apply/:token` — multipart submission (`payload` JSON
//!    field + optional `resume` file field, ≤5 MB).
//!
//! The token is the only access-control primitive here. Bad tokens and
//! closed links both return 404 — leaks less info than 410/403 about
//! whether a tenant exists.

use axum::Json;
use axum::extract::{Multipart, Path, State};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::PublicTenantInfo;

const MAX_RESUME_BYTES: usize = 5 * 1024 * 1024;
const ALLOWED_RESUME_MIME: &[&str] = &[
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/png",
    "image/jpeg",
];

/// Request body for `POST /v1/future/apply/:token` (delivered as the
/// `payload` multipart field in JSON form). Only `full_name` is
/// strictly required — everything else is optional intake data.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPayload {
    pub full_name: String,
    #[serde(default)]
    pub wechat_id: String,
    #[serde(default)]
    pub wechat_nickname: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub university: String,
    #[serde(default)]
    pub major: String,
    /// One of: freshman | sophomore | junior | senior | master_1 |
    /// master_2 | master_3 | phd | alumni | other. Anything else falls
    /// back to "other" (we'd rather accept the row than lose a
    /// student to a strict client-side validator drift).
    #[serde(default = "default_grade_year")]
    pub grade_year: String,
    #[serde(default)]
    pub ai_understanding: String,
    #[serde(default)]
    pub ai_experience: String,
    #[serde(default)]
    pub past_projects: String,
    #[serde(default)]
    pub motivation: String,
}

fn default_grade_year() -> String {
    "other".into()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub student_id: Uuid,
}

/// `GET /v1/future/apply/:token` — public-safe tenant header.
pub async fn get_tenant_info(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> AppResult<Json<PublicTenantInfo>> {
    let row = sqlx::query_as::<_, (Uuid, String, bool, String)>(
        r#"
        SELECT s.tenant_id, s.label, s.is_open, COALESCE(t.display_name, t.name)
        FROM future_share_links s
        JOIN tenants t ON t.id = s.tenant_id
        WHERE s.token = $1
        "#,
    )
    .bind(&token)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let (_tenant_id, label, is_open, tenant_name) = row;
    Ok(Json(PublicTenantInfo {
        tenant_name,
        label,
        is_open,
    }))
}

/// `POST /v1/future/apply/:token` — accept a survey + optional resume.
///
/// Multipart layout:
///   field name | content
///   -----------|--------
///   payload    | JSON blob matching `ApplyPayload`
///   resume     | (optional) file blob, ≤5 MB, mime in `ALLOWED_RESUME_MIME`
///
/// Returns the new student's ID for the front-end to redirect to a
/// "thanks" page; the ID by itself isn't sensitive (it's a uuid v4 in a
/// per-tenant namespace).
pub async fn submit(
    State(state): State<AppState>,
    Path(token): Path<String>,
    mut multipart: Multipart,
) -> AppResult<Json<ApplyResult>> {
    // Resolve tenant first so we don't waste cycles parsing megabytes
    // for a bogus URL.
    let row = sqlx::query_as::<_, (Uuid, bool)>(
        r#"
        SELECT tenant_id, is_open
        FROM future_share_links
        WHERE token = $1
        "#,
    )
    .bind(&token)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let (tenant_id, is_open) = row;
    if !is_open {
        return Err(AppError::NotFound);
    }

    let mut payload: Option<ApplyPayload> = None;
    let mut resume_bytes: Option<Vec<u8>> = None;
    let mut resume_filename: Option<String> = None;
    let mut resume_mime: Option<String> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::bad_request(format!("multipart error: {e}")))?
    {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "payload" => {
                let text = field
                    .text()
                    .await
                    .map_err(|e| AppError::bad_request(format!("payload field: {e}")))?;
                let parsed: ApplyPayload = serde_json::from_str(&text)
                    .map_err(|e| AppError::bad_request(format!("payload json: {e}")))?;
                payload = Some(parsed);
            }
            "resume" => {
                let filename = field
                    .file_name()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "resume".to_string());
                let mime = field
                    .content_type()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "application/octet-stream".to_string());
                let bytes = field
                    .bytes()
                    .await
                    .map_err(|e| AppError::bad_request(format!("resume read: {e}")))?;
                if bytes.is_empty() {
                    continue;
                }
                if bytes.len() > MAX_RESUME_BYTES {
                    return Err(AppError::bad_request("简历超过 5MB 上限"));
                }
                if !ALLOWED_RESUME_MIME.contains(&mime.as_str()) {
                    return Err(AppError::bad_request(format!(
                        "不支持的简历格式: {mime}（支持 PDF / Word / 图片）"
                    )));
                }
                resume_bytes = Some(bytes.to_vec());
                resume_filename = Some(filename);
                resume_mime = Some(mime);
            }
            _ => {
                // unknown field; skip rather than reject — keeps the
                // form forward-compatible if a newer client adds fields
                // before the server learns about them.
                let _ = field.bytes().await;
            }
        }
    }

    let p = payload.ok_or_else(|| AppError::bad_request("missing payload field"))?;
    if p.full_name.trim().is_empty() {
        return Err(AppError::bad_request("姓名是必填的"));
    }
    let grade = normalize_grade_year(&p.grade_year);

    let student_id = Uuid::new_v4();
    let mut tx = state.db.begin().await?;

    sqlx::query(
        r#"
        INSERT INTO future_students (
            tenant_id, id, full_name, wechat_id, wechat_nickname,
            email, phone, university, major, grade_year,
            ai_understanding, ai_experience, past_projects, motivation,
            has_resume, status
        ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14,
            $15, 'new'
        )
        "#,
    )
    .bind(tenant_id)
    .bind(student_id)
    .bind(p.full_name.trim())
    .bind(p.wechat_id.trim())
    .bind(p.wechat_nickname.trim())
    .bind(p.email.trim())
    .bind(p.phone.trim())
    .bind(p.university.trim())
    .bind(p.major.trim())
    .bind(&grade)
    .bind(p.ai_understanding.trim())
    .bind(p.ai_experience.trim())
    .bind(p.past_projects.trim())
    .bind(p.motivation.trim())
    .bind(resume_bytes.is_some())
    .execute(&mut *tx)
    .await?;

    if let (Some(bytes), Some(filename), Some(mime)) =
        (resume_bytes, resume_filename, resume_mime)
    {
        sqlx::query(
            r#"
            INSERT INTO future_resumes (tenant_id, student_id, filename, mime, size_bytes, data)
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(tenant_id)
        .bind(student_id)
        .bind(filename)
        .bind(mime)
        .bind(bytes.len() as i32)
        .bind(&bytes)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    Ok(Json(ApplyResult { student_id }))
}

fn normalize_grade_year(raw: &str) -> String {
    match raw {
        "freshman" | "sophomore" | "junior" | "senior" | "master_1" | "master_2"
        | "master_3" | "phd" | "alumni" | "other" => raw.to_string(),
        _ => "other".to_string(),
    }
}
