use axum::Json;
use axum::extract::{Path, State};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::middleware::AuthContext;
use crate::models::{Tenant, UserPublic};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct CreateTenantBody {
    pub slug: String,
    pub name: String,
    pub display_name: Option<String>,
}

#[derive(Serialize)]
pub struct MemberRow {
    pub user: UserPublic,
    pub role: String,
    pub joined_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct AddMemberBody {
    pub user_id: Uuid,
    pub role: String,
}

pub async fn list_tenants(
    State(state): State<AppState>,
    auth: AuthContext,
) -> AppResult<Json<Vec<Tenant>>> {
    auth.require_superuser()?;
    let rows = sqlx::query_as::<_, Tenant>(
        r#"
        SELECT id, slug, name, display_name, status, metadata, created_at, updated_at
        FROM tenants
        ORDER BY created_at
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

pub async fn create_tenant(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(body): Json<CreateTenantBody>,
) -> AppResult<Json<Tenant>> {
    auth.require_superuser()?;

    let slug = body.slug.trim().to_lowercase();
    if slug.is_empty() {
        return Err(AppError::bad_request("slug required"));
    }
    if !slug
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::bad_request(
            "slug must be ascii alphanumeric, '-' or '_'",
        ));
    }

    let id = Uuid::now_v7();
    let inserted = sqlx::query_as::<_, Tenant>(
        r#"
        INSERT INTO tenants (id, slug, name, display_name)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (slug) DO NOTHING
        RETURNING id, slug, name, display_name, status, metadata, created_at, updated_at
        "#,
    )
    .bind(id)
    .bind(&slug)
    .bind(&body.name)
    .bind(&body.display_name)
    .fetch_optional(&state.db)
    .await?;

    match inserted {
        Some(t) => Ok(Json(t)),
        None => Err(AppError::conflict(format!("slug '{slug}' already exists"))),
    }
}

#[derive(sqlx::FromRow)]
struct MemberQueryRow {
    id: Uuid,
    identifier: String,
    display_name: Option<String>,
    status: String,
    is_superuser: bool,
    last_login_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    role: String,
    joined_at: DateTime<Utc>,
}

impl From<MemberQueryRow> for MemberRow {
    fn from(r: MemberQueryRow) -> Self {
        MemberRow {
            user: UserPublic {
                id: r.id,
                identifier: r.identifier,
                display_name: r.display_name,
                status: r.status,
                is_superuser: r.is_superuser,
                last_login_at: r.last_login_at,
                created_at: r.created_at,
            },
            role: r.role,
            joined_at: r.joined_at,
        }
    }
}

const MEMBER_QUERY: &str = r#"
    SELECT
        u.id            AS id,
        u.identifier    AS identifier,
        u.display_name  AS display_name,
        u.status        AS status,
        u.is_superuser  AS is_superuser,
        u.last_login_at AS last_login_at,
        u.created_at    AS created_at,
        m.role          AS role,
        m.created_at    AS joined_at
    FROM memberships m
    JOIN users u ON u.id = m.user_id
"#;

pub async fn list_members(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(tenant_id): Path<Uuid>,
) -> AppResult<Json<Vec<MemberRow>>> {
    require_tenant_admin(&state.db, &auth, tenant_id).await?;

    let q = format!("{MEMBER_QUERY} WHERE m.tenant_id = $1 ORDER BY m.created_at");
    let rows = sqlx::query_as::<_, MemberQueryRow>(&q)
        .bind(tenant_id)
        .fetch_all(&state.db)
        .await?;

    Ok(Json(rows.into_iter().map(MemberRow::from).collect()))
}

pub async fn add_member(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(tenant_id): Path<Uuid>,
    Json(body): Json<AddMemberBody>,
) -> AppResult<Json<MemberRow>> {
    require_tenant_admin(&state.db, &auth, tenant_id).await?;
    if !["owner", "admin", "member", "viewer"].contains(&body.role.as_str()) {
        return Err(AppError::bad_request("invalid role"));
    }

    sqlx::query(
        r#"
        INSERT INTO memberships (tenant_id, user_id, role)
        VALUES ($1, $2, $3)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role
        "#,
    )
    .bind(tenant_id)
    .bind(body.user_id)
    .bind(&body.role)
    .execute(&state.db)
    .await?;

    let q = format!("{MEMBER_QUERY} WHERE m.tenant_id = $1 AND m.user_id = $2");
    let row = sqlx::query_as::<_, MemberQueryRow>(&q)
        .bind(tenant_id)
        .bind(body.user_id)
        .fetch_one(&state.db)
        .await?;

    Ok(Json(row.into()))
}

async fn require_tenant_admin(
    db: &sqlx::PgPool,
    auth: &AuthContext,
    tenant_id: Uuid,
) -> AppResult<()> {
    if auth.user.is_superuser {
        return Ok(());
    }
    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2")
            .bind(tenant_id)
            .bind(auth.user.id)
            .fetch_optional(db)
            .await?;
    match role.as_deref() {
        Some("owner") | Some("admin") => Ok(()),
        _ => Err(AppError::Forbidden),
    }
}
