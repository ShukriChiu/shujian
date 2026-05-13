use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{hash_password, mint_session_token, verify_password};
use crate::error::{AppError, AppResult};
use crate::middleware::AuthContext;
use crate::models::{Tenant, TenantMembership, User, UserPublic};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct LoginBody {
    pub identifier: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub token: String,
    pub expires_at: DateTime<Utc>,
    pub user: UserPublic,
    pub memberships: Vec<TenantMembership>,
    pub current_tenant: Option<Tenant>,
}

#[derive(Serialize)]
pub struct MeResponse {
    pub user: UserPublic,
    pub memberships: Vec<TenantMembership>,
    pub current_tenant: Option<Tenant>,
}

#[derive(Deserialize)]
pub struct SwitchTenantBody {
    pub tenant_id: Uuid,
}

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> AppResult<Json<LoginResponse>> {
    let identifier = body.identifier.trim().to_lowercase();
    if identifier.is_empty() || body.password.is_empty() {
        return Err(AppError::bad_request(
            "identifier and password are required",
        ));
    }

    let user = sqlx::query_as::<_, User>(
        r#"
        SELECT id, identifier, password_hash, display_name, status, is_superuser,
               last_login_at, metadata, created_at, updated_at
        FROM users
        WHERE identifier = $1
        "#,
    )
    .bind(&identifier)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::Unauthorized)?;

    if user.status != "active" {
        return Err(AppError::Unauthorized);
    }

    if !verify_password(&body.password, &user.password_hash)? {
        return Err(AppError::Unauthorized);
    }

    let memberships = load_memberships(&state.db, user.id).await?;
    let current_tenant = memberships.first().map(|m| m.tenant.clone());

    let (raw, hash) = mint_session_token();
    let expires_at = Utc::now() + Duration::days(state.cfg.session_ttl_days);
    let session_id = Uuid::now_v7();

    let user_agent = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    sqlx::query(
        r#"
        INSERT INTO sessions (id, user_id, tenant_id, token_hash, user_agent, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(session_id)
    .bind(user.id)
    .bind(current_tenant.as_ref().map(|t| t.id))
    .bind(&hash)
    .bind(&user_agent)
    .bind(expires_at)
    .execute(&state.db)
    .await?;

    sqlx::query("UPDATE users SET last_login_at = now() WHERE id = $1")
        .bind(user.id)
        .execute(&state.db)
        .await?;

    Ok(Json(LoginResponse {
        token: raw,
        expires_at,
        user: user.into(),
        memberships,
        current_tenant,
    }))
}

pub async fn logout(
    State(state): State<AppState>,
    auth: AuthContext,
) -> AppResult<Json<serde_json::Value>> {
    sqlx::query("DELETE FROM sessions WHERE id = $1")
        .bind(auth.session.id)
        .execute(&state.db)
        .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn me(State(state): State<AppState>, auth: AuthContext) -> AppResult<Json<MeResponse>> {
    let memberships = load_memberships(&state.db, auth.user.id).await?;
    let current_tenant = match auth.session.tenant_id {
        Some(tid) => memberships
            .iter()
            .find(|m| m.tenant.id == tid)
            .map(|m| m.tenant.clone()),
        None => memberships.first().map(|m| m.tenant.clone()),
    };
    Ok(Json(MeResponse {
        user: auth.user.into(),
        memberships,
        current_tenant,
    }))
}

pub async fn switch_tenant(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(body): Json<SwitchTenantBody>,
) -> AppResult<Json<MeResponse>> {
    let memberships = load_memberships(&state.db, auth.user.id).await?;
    let target = memberships
        .iter()
        .find(|m| m.tenant.id == body.tenant_id)
        .ok_or(AppError::Forbidden)?
        .clone();

    sqlx::query("UPDATE sessions SET tenant_id = $1 WHERE id = $2")
        .bind(target.tenant.id)
        .bind(auth.session.id)
        .execute(&state.db)
        .await?;

    Ok(Json(MeResponse {
        user: auth.user.into(),
        memberships,
        current_tenant: Some(target.tenant),
    }))
}

#[derive(sqlx::FromRow)]
struct MembershipRow {
    id: Uuid,
    slug: String,
    name: String,
    display_name: Option<String>,
    status: String,
    metadata: serde_json::Value,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    role: String,
}

async fn load_memberships(db: &sqlx::PgPool, user_id: Uuid) -> AppResult<Vec<TenantMembership>> {
    let rows = sqlx::query_as::<_, MembershipRow>(
        r#"
        SELECT
            t.id           AS id,
            t.slug         AS slug,
            t.name         AS name,
            t.display_name AS display_name,
            t.status       AS status,
            t.metadata     AS metadata,
            t.created_at   AS created_at,
            t.updated_at   AS updated_at,
            m.role         AS role
        FROM memberships m
        JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = $1
        ORDER BY m.created_at
        "#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| TenantMembership {
            tenant: Tenant {
                id: r.id,
                slug: r.slug,
                name: r.name,
                display_name: r.display_name,
                status: r.status,
                metadata: r.metadata,
                created_at: r.created_at,
                updated_at: r.updated_at,
            },
            role: r.role,
        })
        .collect())
}

/// Helper used by the seed bootstrap (not exposed as an endpoint).
pub(crate) async fn create_user(
    db: &sqlx::PgPool,
    identifier: &str,
    password: &str,
    display_name: Option<&str>,
    is_superuser: bool,
) -> AppResult<User> {
    let identifier = identifier.trim().to_lowercase();
    let hash = hash_password(password)?;
    let id = Uuid::now_v7();
    let user = sqlx::query_as::<_, User>(
        r#"
        INSERT INTO users (id, identifier, password_hash, display_name, is_superuser)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, identifier, password_hash, display_name, status, is_superuser,
                  last_login_at, metadata, created_at, updated_at
        "#,
    )
    .bind(id)
    .bind(&identifier)
    .bind(&hash)
    .bind(display_name)
    .bind(is_superuser)
    .fetch_one(db)
    .await?;
    Ok(user)
}
