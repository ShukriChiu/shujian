use axum::extract::{FromRef, FromRequestParts};
use axum::http::request::Parts;
use chrono::Utc;
use uuid::Uuid;

use crate::auth::{parse_bearer, sha256_hex};
use crate::error::{AppError, AppResult};
use crate::models::{Session, User};
use crate::state::AppState;

/// Resolved caller identity. Extracted from `Authorization: Bearer <token>`
/// against the `sessions` table. Refreshes `last_active_at`.
#[derive(Debug, Clone)]
pub struct AuthContext {
    pub user: User,
    pub session: Session,
}

impl AuthContext {
    pub fn require_superuser(&self) -> AppResult<()> {
        if self.user.is_superuser {
            Ok(())
        } else {
            Err(AppError::Forbidden)
        }
    }
}

impl<S> FromRequestParts<S> for AuthContext
where
    AppState: axum::extract::FromRef<S>,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let app: AppState = AppState::from_ref(state);

        let token = parse_bearer(
            parts
                .headers
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok()),
        )?;
        let token_hash = sha256_hex(token);

        let session = sqlx::query_as::<_, Session>(
            r#"
            SELECT id, user_id, tenant_id, token_hash, user_agent,
                   expires_at, last_active_at, created_at
            FROM sessions
            WHERE token_hash = $1
            "#,
        )
        .bind(&token_hash)
        .fetch_optional(&app.db)
        .await?
        .ok_or(AppError::Unauthorized)?;

        if session.expires_at <= Utc::now() {
            // expire-on-read; lazy GC keeps it simple
            let _ = sqlx::query("DELETE FROM sessions WHERE id = $1")
                .bind(session.id)
                .execute(&app.db)
                .await;
            return Err(AppError::Unauthorized);
        }

        let user = sqlx::query_as::<_, User>(
            r#"
            SELECT id, identifier, password_hash, display_name, status, is_superuser,
                   last_login_at, metadata, created_at, updated_at
            FROM users
            WHERE id = $1
            "#,
        )
        .bind(session.user_id)
        .fetch_optional(&app.db)
        .await?
        .ok_or(AppError::Unauthorized)?;

        if user.status != "active" {
            return Err(AppError::Unauthorized);
        }

        // touch last_active — best-effort, don't fail the request if it fails
        let session_id: Uuid = session.id;
        let pool = app.db.clone();
        tokio::spawn(async move {
            let _ = sqlx::query("UPDATE sessions SET last_active_at = now() WHERE id = $1")
                .bind(session_id)
                .execute(&pool)
                .await;
        });

        Ok(Self { user, session })
    }
}
