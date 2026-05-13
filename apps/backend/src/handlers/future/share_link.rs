//! Per-tenant share-link management.
//!
//! Exactly one share link per tenant. The token is opaque (32 chars
//! base64-url, ~192 bits of entropy); rotating it is the way to
//! invalidate an old public URL. Tenants can also flip `is_open` to
//! pause submissions without rotating.

use axum::Json;
use axum::extract::State;
use base64::Engine as _;
use rand::TryRngCore;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::middleware::AuthContext;
use crate::state::AppState;

use super::require_tenant;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ShareLink {
    pub token: String,
    pub label: String,
    pub is_open: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateShareLink {
    pub label: Option<String>,
    pub is_open: Option<bool>,
}

/// Generate a cryptographically random share token. 24 random bytes →
/// 32 chars of base64url, no padding. Long enough to make guessing
/// attacks irrelevant for an audience of one workspace owner.
fn generate_token() -> AppResult<String> {
    let mut buf = [0u8; 24];
    rand::rngs::OsRng
        .try_fill_bytes(&mut buf)
        .map_err(|e| anyhow::anyhow!("rng: {e}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf))
}

/// `GET /v1/future/share-link` — returns the current tenant's link,
/// creating a fresh one on first access. Admins see the token plain
/// because they're the audience that needs to share it.
pub async fn get_share_link(
    State(state): State<AppState>,
    auth: AuthContext,
) -> AppResult<Json<ShareLink>> {
    let tenant_id = require_tenant(&auth)?;

    if let Some(row) = sqlx::query_as::<_, ShareLink>(
        "SELECT token, label, is_open FROM future_share_links WHERE tenant_id = $1",
    )
    .bind(tenant_id)
    .fetch_optional(&state.db)
    .await?
    {
        return Ok(Json(row));
    }

    let token = generate_token()?;
    let row = sqlx::query_as::<_, ShareLink>(
        r#"
        INSERT INTO future_share_links (tenant_id, token, label, is_open)
        VALUES ($1, $2, '招募中', true)
        RETURNING token, label, is_open
        "#,
    )
    .bind(tenant_id)
    .bind(&token)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(row))
}

/// `POST /v1/future/share-link/rotate` — mint a new token. The old one
/// stops resolving immediately. Existing students don't move.
pub async fn rotate_share_link(
    State(state): State<AppState>,
    auth: AuthContext,
) -> AppResult<Json<ShareLink>> {
    let tenant_id = require_tenant(&auth)?;
    let token = generate_token()?;

    let row = sqlx::query_as::<_, ShareLink>(
        r#"
        INSERT INTO future_share_links (tenant_id, token, label, is_open)
        VALUES ($1, $2, '招募中', true)
        ON CONFLICT (tenant_id) DO UPDATE
            SET token = EXCLUDED.token,
                updated_at = now()
        RETURNING token, label, is_open
        "#,
    )
    .bind(tenant_id)
    .bind(&token)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(row))
}

/// `PATCH /v1/future/share-link` — change label or toggle open. The
/// token is intentionally not editable here; use rotate for that.
pub async fn update_share_link(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(body): Json<UpdateShareLink>,
) -> AppResult<Json<ShareLink>> {
    let tenant_id = require_tenant(&auth)?;

    let row = sqlx::query_as::<_, ShareLink>(
        r#"
        UPDATE future_share_links
           SET label = COALESCE($2, label),
               is_open = COALESCE($3, is_open),
               updated_at = now()
         WHERE tenant_id = $1
        RETURNING token, label, is_open
        "#,
    )
    .bind(tenant_id)
    .bind(body.label.as_deref())
    .bind(body.is_open)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        crate::error::AppError::bad_request(
            "no share link yet — GET /v1/future/share-link to create one",
        )
    })?;
    Ok(Json(row))
}
