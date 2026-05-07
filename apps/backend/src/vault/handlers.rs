//! HTTP handlers for the vault subsystem.
//!
//! Mounted under `/v1/vault/*` and `/v1/personas/*`. All handlers require
//! an authenticated `AuthContext` and a tenant scope (taken from the
//! caller's active session, optionally overridden by `X-Tenant-Id` for
//! superusers).
//!
//! Tenant scoping is enforced at every query: caller can only see / mutate
//! rows where `tenant_id = active_tenant_id`. Superusers can pass
//! `X-Tenant-Id` to operate on any tenant (used by the dashboard's
//! tenant-switcher).

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::middleware::AuthContext;
use crate::state::AppState;
use crate::vault::crypto;
use crate::vault::kek::KekProvider;
use crate::vault::models::*;

// ─────────────────────────────────────────────────────────────────────────────
// Tenant scoping helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Resolve the tenant scope for a vault request.
///
/// Priority:
///   1. `X-Tenant-Id` header (superuser only — gated by `require_tenant_member`).
///   2. The session's currently-active tenant (`sessions.tenant_id`).
///
/// Then verify the caller is a member with the right role.
async fn require_tenant_admin(
    db: &PgPool,
    auth: &AuthContext,
    headers: &HeaderMap,
) -> AppResult<Uuid> {
    let header_tenant: Option<Uuid> = headers
        .get("x-tenant-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| Uuid::parse_str(s).ok());

    let tenant_id = match header_tenant {
        Some(t) if auth.user.is_superuser => t,
        Some(_) => return Err(AppError::Forbidden),
        None => auth.session.tenant_id.ok_or_else(|| {
            AppError::bad_request("no active tenant — switch tenant first or send X-Tenant-Id")
        })?,
    };

    if auth.user.is_superuser {
        return Ok(tenant_id);
    }
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2",
    )
    .bind(tenant_id)
    .bind(auth.user.id)
    .fetch_optional(db)
    .await?;
    match role.as_deref() {
        Some("owner") | Some("admin") => Ok(tenant_id),
        _ => Err(AppError::Forbidden),
    }
}

fn validate_lowercase_name(name: &str, kind: &'static str) -> AppResult<()> {
    if name.is_empty() {
        return Err(AppError::bad_request(format!("{kind} name required")));
    }
    if name != name.to_lowercase() {
        return Err(AppError::bad_request(format!(
            "{kind} name must be lowercase (got {name})"
        )));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return Err(AppError::bad_request(format!(
            "{kind} name allows [a-z0-9.-_] only"
        )));
    }
    Ok(())
}

fn map_kek_err(e: anyhow::Error) -> AppError {
    tracing::error!(error = ?e, "KEK provider error");
    AppError::bad_request(format!(
        "vault is not ready: {e}. Set SHUJIAN_VAULT_KEK_B64 (prod) or \
         SHUJIAN_VAULT_DEV_KEK_B64 (dev) and restart."
    ))
}

// ─────────────────────────────────────────────────────────────────────────────
// Secrets
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_KINDS: &[&str] = &["env", "jwt_signing", "webhook", "oauth", "r2_secret", "misc"];

pub async fn upsert_secret(
    State(state): State<AppState>,
    State(kek): State<KekProvider>,
    auth: AuthContext,
    headers: HeaderMap,
    Json(body): Json<UpsertSecretBody>,
) -> AppResult<Json<SecretMetadata>> {
    let tenant_id = require_tenant_admin(&state.db, &auth, &headers).await?;
    let name = body.name.trim().to_lowercase();
    validate_lowercase_name(&name, "secret")?;
    if body.value.is_empty() {
        return Err(AppError::bad_request("value cannot be empty"));
    }
    let kind = body.kind.unwrap_or_else(|| "env".into());
    if !ALLOWED_KINDS.contains(&kind.as_str()) {
        return Err(AppError::bad_request(format!(
            "kind must be one of {ALLOWED_KINDS:?}"
        )));
    }

    let active = kek.active().await.map_err(map_kek_err)?;

    // Encrypt + wrap.
    let env = crypto::encrypt_with_fresh_dek(body.value.as_bytes())
        .map_err(|e| AppError::Internal(e))?;
    let wrapped = crypto::wrap_dek(&active.material, &env.dek, &tenant_id, &name)
        .map_err(|e| AppError::Internal(e))?;
    let metadata = body.metadata.unwrap_or(serde_json::json!({}));

    // INSERT ... ON CONFLICT for upsert. We bump rotated_at on overwrite
    // and reset last_used_at because the underlying value changed.
    let id = Uuid::now_v7();
    let row: SecretMetadata = sqlx::query_as::<_, SecretMetadataRow>(
        r#"
        INSERT INTO vault_secrets (
            id, tenant_id, name, kind, description,
            ciphertext, nonce, auth_tag,
            dek_wrapped, dek_nonce, kek_version,
            metadata, created_by
        )
        VALUES ($1, $2, $3, $4, $5,
                $6, $7, $8,
                $9, $10, $11,
                $12, $13)
        ON CONFLICT (tenant_id, name) DO UPDATE
        SET kind         = EXCLUDED.kind,
            description  = EXCLUDED.description,
            ciphertext   = EXCLUDED.ciphertext,
            nonce        = EXCLUDED.nonce,
            auth_tag     = EXCLUDED.auth_tag,
            dek_wrapped  = EXCLUDED.dek_wrapped,
            dek_nonce    = EXCLUDED.dek_nonce,
            kek_version  = EXCLUDED.kek_version,
            metadata     = EXCLUDED.metadata,
            rotated_at   = now(),
            last_used_at = NULL
        RETURNING id, tenant_id, name, kind, description,
                  kek_version, metadata, created_at, rotated_at,
                  last_used_at, created_by
        "#,
    )
    .bind(id)
    .bind(tenant_id)
    .bind(&name)
    .bind(&kind)
    .bind(&body.description)
    .bind(&env.ciphertext)
    .bind(&env.nonce[..])
    .bind(&env.auth_tag[..])
    .bind(&wrapped.wrapped)
    .bind(&wrapped.nonce[..])
    .bind(active.version)
    .bind(&metadata)
    .bind(auth.user.id)
    .fetch_one(&state.db)
    .await?
    .into();

    tracing::info!(
        tenant = %tenant_id,
        name = %name,
        kind = %kind,
        kek_version = active.version,
        "vault secret upserted"
    );
    Ok(Json(row))
}

#[derive(Debug, Deserialize)]
pub struct ListSecretsQuery {
    pub kind: Option<String>,
}

pub async fn list_secrets(
    State(state): State<AppState>,
    auth: AuthContext,
    headers: HeaderMap,
    Query(q): Query<ListSecretsQuery>,
) -> AppResult<Json<Vec<SecretMetadata>>> {
    let tenant_id = require_tenant_admin(&state.db, &auth, &headers).await?;

    // We accept `kind` as an optional filter. Built without dynamic SQL
    // because sqlx doesn't have a clean optional-where helper and we want
    // statement caching.
    let rows: Vec<SecretMetadataRow> = match q.kind.as_deref() {
        Some(kind) => sqlx::query_as(
            r#"
            SELECT id, tenant_id, name, kind, description,
                   kek_version, metadata, created_at, rotated_at,
                   last_used_at, created_by
            FROM vault_secrets
            WHERE tenant_id = $1 AND kind = $2
            ORDER BY name
            "#,
        )
        .bind(tenant_id)
        .bind(kind)
        .fetch_all(&state.db)
        .await?,
        None => sqlx::query_as(
            r#"
            SELECT id, tenant_id, name, kind, description,
                   kek_version, metadata, created_at, rotated_at,
                   last_used_at, created_by
            FROM vault_secrets
            WHERE tenant_id = $1
            ORDER BY name
            "#,
        )
        .bind(tenant_id)
        .fetch_all(&state.db)
        .await?,
    };
    Ok(Json(rows.into_iter().map(SecretMetadata::from).collect()))
}

pub async fn get_secret_metadata(
    State(state): State<AppState>,
    auth: AuthContext,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> AppResult<Json<SecretMetadata>> {
    let tenant_id = require_tenant_admin(&state.db, &auth, &headers).await?;
    let row: Option<SecretMetadataRow> = sqlx::query_as(
        r#"
        SELECT id, tenant_id, name, kind, description,
               kek_version, metadata, created_at, rotated_at,
               last_used_at, created_by
        FROM vault_secrets
        WHERE tenant_id = $1 AND name = $2
        "#,
    )
    .bind(tenant_id)
    .bind(name.to_lowercase())
    .fetch_optional(&state.db)
    .await?;
    row.map(|r| Json(r.into())).ok_or(AppError::NotFound)
}

pub async fn delete_secret(
    State(state): State<AppState>,
    auth: AuthContext,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let tenant_id = require_tenant_admin(&state.db, &auth, &headers).await?;
    let n = sqlx::query("DELETE FROM vault_secrets WHERE tenant_id = $1 AND name = $2")
        .bind(tenant_id)
        .bind(name.to_lowercase())
        .execute(&state.db)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(serde_json::json!({ "deleted": name })))
}

// SQLx FromRow shim — the migration constraints require nonce=12 / auth_tag=16
// but we don't include the raw bytes in the public type.
#[derive(sqlx::FromRow)]
struct SecretMetadataRow {
    id: Uuid,
    tenant_id: Uuid,
    name: String,
    kind: String,
    description: Option<String>,
    kek_version: i32,
    metadata: serde_json::Value,
    created_at: chrono::DateTime<chrono::Utc>,
    rotated_at: Option<chrono::DateTime<chrono::Utc>>,
    last_used_at: Option<chrono::DateTime<chrono::Utc>>,
    created_by: Option<Uuid>,
}

impl From<SecretMetadataRow> for SecretMetadata {
    fn from(r: SecretMetadataRow) -> Self {
        SecretMetadata {
            id: r.id,
            tenant_id: r.tenant_id,
            name: r.name,
            kind: r.kind,
            description: r.description,
            kek_version: r.kek_version,
            metadata: r.metadata,
            created_at: r.created_at,
            rotated_at: r.rotated_at,
            last_used_at: r.last_used_at,
            created_by: r.created_by,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Operator refs
// ─────────────────────────────────────────────────────────────────────────────

pub async fn create_operator_ref(
    State(state): State<AppState>,
    auth: AuthContext,
    headers: HeaderMap,
    Json(body): Json<CreateOperatorRefBody>,
) -> AppResult<Json<OperatorRef>> {
    let tenant_id = require_tenant_admin(&state.db, &auth, &headers).await?;
    if body.system.is_empty() || body.operator_id.is_empty() || body.operator_name.is_empty() {
        return Err(AppError::bad_request(
            "system / operator_id / operator_name are required",
        ));
    }
    let id = Uuid::now_v7();
    let row: OperatorRef = sqlx::query_as(
        r#"
        INSERT INTO vault_operator_refs (
            id, tenant_id, system, operator_id, operator_name,
            is_shadow, role_hint, metadata, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, '{}'::jsonb), $9)
        ON CONFLICT (tenant_id, system, operator_id) DO UPDATE
        SET operator_name = EXCLUDED.operator_name,
            is_shadow     = EXCLUDED.is_shadow,
            role_hint     = EXCLUDED.role_hint,
            metadata      = EXCLUDED.metadata
        RETURNING id, tenant_id, system, operator_id, operator_name,
                  is_shadow, role_hint, metadata, created_at
        "#,
    )
    .bind(id)
    .bind(tenant_id)
    .bind(&body.system)
    .bind(&body.operator_id)
    .bind(&body.operator_name)
    .bind(body.is_shadow)
    .bind(&body.role_hint)
    .bind(&body.metadata)
    .bind(auth.user.id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(row))
}

pub async fn list_operator_refs(
    State(state): State<AppState>,
    auth: AuthContext,
    headers: HeaderMap,
) -> AppResult<Json<Vec<OperatorRef>>> {
    let tenant_id = require_tenant_admin(&state.db, &auth, &headers).await?;
    let rows: Vec<OperatorRef> = sqlx::query_as(
        r#"
        SELECT id, tenant_id, system, operator_id, operator_name,
               is_shadow, role_hint, metadata, created_at
        FROM vault_operator_refs
        WHERE tenant_id = $1
        ORDER BY system, created_at
        "#,
    )
    .bind(tenant_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

pub async fn delete_operator_ref(
    State(state): State<AppState>,
    auth: AuthContext,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let tenant_id = require_tenant_admin(&state.db, &auth, &headers).await?;
    let n = sqlx::query("DELETE FROM vault_operator_refs WHERE tenant_id = $1 AND id = $2")
        .bind(tenant_id)
        .bind(id)
        .execute(&state.db)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(serde_json::json!({ "deleted": id })))
}

// ─────────────────────────────────────────────────────────────────────────────
// Scopes
// ─────────────────────────────────────────────────────────────────────────────

/// Validate a `bindings` JSONB array, returning the list of declared env keys.
/// Used both at scope-write time and during persona launch.
fn validate_bindings(bindings: &serde_json::Value) -> AppResult<Vec<String>> {
    let arr = bindings
        .as_array()
        .ok_or_else(|| AppError::bad_request("bindings must be a JSON array"))?;
    let mut env_keys = Vec::with_capacity(arr.len());
    for (i, b) in arr.iter().enumerate() {
        let kind = b
            .get("kind")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::bad_request(format!("bindings[{i}].kind missing")))?;
        let env = b
            .get("env")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::bad_request(format!("bindings[{i}].env missing")))?
            .to_string();
        match kind {
            "passthrough" => {
                if b.get("secret_name").and_then(|v| v.as_str()).is_none() {
                    return Err(AppError::bad_request(format!(
                        "bindings[{i}] passthrough needs secret_name"
                    )));
                }
            }
            "static" => {
                if b.get("value").and_then(|v| v.as_str()).is_none() {
                    return Err(AppError::bad_request(format!(
                        "bindings[{i}] static needs value (string)"
                    )));
                }
            }
            "onion_jwt" => {
                if b.get("operator_ref_id").and_then(|v| v.as_str()).is_none() {
                    return Err(AppError::bad_request(format!(
                        "bindings[{i}] onion_jwt needs operator_ref_id (uuid)"
                    )));
                }
            }
            "r2_presigned" => {
                if b.get("secret_name").and_then(|v| v.as_str()).is_none()
                    || b.get("bucket").and_then(|v| v.as_str()).is_none()
                {
                    return Err(AppError::bad_request(format!(
                        "bindings[{i}] r2_presigned needs secret_name + bucket"
                    )));
                }
            }
            other => {
                return Err(AppError::bad_request(format!(
                    "bindings[{i}] unknown kind: {other}"
                )));
            }
        }
        if env_keys.contains(&env) {
            return Err(AppError::bad_request(format!(
                "bindings duplicate env name: {env}"
            )));
        }
        env_keys.push(env);
    }
    Ok(env_keys)
}

pub async fn upsert_scope(
    State(state): State<AppState>,
    auth: AuthContext,
    headers: HeaderMap,
    Json(body): Json<UpsertScopeBody>,
) -> AppResult<Json<Scope>> {
    let tenant_id = require_tenant_admin(&state.db, &auth, &headers).await?;
    let name = body.name.trim().to_lowercase();
    validate_lowercase_name(&name, "scope")?;
    let _ = validate_bindings(&body.bindings)?;

    let id = Uuid::now_v7();
    let row: Scope = sqlx::query_as(
        r#"
        INSERT INTO vault_scopes (
            id, tenant_id, name, description, bindings, primary_operator_ref_id, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (tenant_id, name) DO UPDATE
        SET description             = EXCLUDED.description,
            bindings                = EXCLUDED.bindings,
            primary_operator_ref_id = EXCLUDED.primary_operator_ref_id
        RETURNING id, tenant_id, name, description, bindings,
                  primary_operator_ref_id, created_at, updated_at
        "#,
    )
    .bind(id)
    .bind(tenant_id)
    .bind(&name)
    .bind(&body.description)
    .bind(&body.bindings)
    .bind(body.primary_operator_ref_id)
    .bind(auth.user.id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(row))
}

pub async fn list_scopes(
    State(state): State<AppState>,
    auth: AuthContext,
    headers: HeaderMap,
) -> AppResult<Json<Vec<Scope>>> {
    let tenant_id = require_tenant_admin(&state.db, &auth, &headers).await?;
    let rows: Vec<Scope> = sqlx::query_as(
        r#"
        SELECT id, tenant_id, name, description, bindings,
               primary_operator_ref_id, created_at, updated_at
        FROM vault_scopes
        WHERE tenant_id = $1
        ORDER BY name
        "#,
    )
    .bind(tenant_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

pub async fn delete_scope(
    State(state): State<AppState>,
    auth: AuthContext,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let tenant_id = require_tenant_admin(&state.db, &auth, &headers).await?;
    let n = sqlx::query("DELETE FROM vault_scopes WHERE tenant_id = $1 AND name = $2")
        .bind(tenant_id)
        .bind(name.to_lowercase())
        .execute(&state.db)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(serde_json::json!({ "deleted": name })))
}

// ─────────────────────────────────────────────────────────────────────────────
// Personas
// ─────────────────────────────────────────────────────────────────────────────

pub async fn upsert_persona(
    State(state): State<AppState>,
    auth: AuthContext,
    headers: HeaderMap,
    Json(body): Json<UpsertPersonaBody>,
) -> AppResult<Json<Persona>> {
    let tenant_id = require_tenant_admin(&state.db, &auth, &headers).await?;
    let slug = body.slug.trim().to_lowercase();
    validate_lowercase_name(&slug, "persona slug")?;
    if body.display_name.is_empty() {
        return Err(AppError::bad_request("display_name required"));
    }
    if body.system_prompt.is_empty() {
        return Err(AppError::bad_request("system_prompt required"));
    }
    if !body.cursor_settings.is_object() {
        return Err(AppError::bad_request("cursor_settings must be an object"));
    }

    // Verify all referenced scopes belong to this tenant. Cheap & catches
    // typos / cross-tenant leakage attempts early.
    if !body.allowed_scopes.is_empty() {
        let count: i64 = sqlx::query_scalar(
            r#"SELECT count(*) FROM vault_scopes
               WHERE tenant_id = $1 AND id = ANY($2)"#,
        )
        .bind(tenant_id)
        .bind(&body.allowed_scopes)
        .fetch_one(&state.db)
        .await?;
        if count as usize != body.allowed_scopes.len() {
            return Err(AppError::bad_request(
                "one or more allowed_scopes do not belong to this tenant",
            ));
        }
    }

    let id = Uuid::now_v7();
    let row: Persona = sqlx::query_as(
        r#"
        INSERT INTO agent_personas (
            id, tenant_id, slug, display_name, description,
            system_prompt, allowed_scopes, cursor_settings, domain, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (tenant_id, slug) DO UPDATE
        SET display_name    = EXCLUDED.display_name,
            description     = EXCLUDED.description,
            system_prompt   = EXCLUDED.system_prompt,
            allowed_scopes  = EXCLUDED.allowed_scopes,
            cursor_settings = EXCLUDED.cursor_settings,
            domain          = EXCLUDED.domain
        RETURNING id, tenant_id, slug, display_name, description,
                  system_prompt, allowed_scopes, cursor_settings, domain,
                  created_at, updated_at
        "#,
    )
    .bind(id)
    .bind(tenant_id)
    .bind(&slug)
    .bind(&body.display_name)
    .bind(&body.description)
    .bind(&body.system_prompt)
    .bind(&body.allowed_scopes)
    .bind(&body.cursor_settings)
    .bind(&body.domain)
    .bind(auth.user.id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(row))
}

pub async fn list_personas(
    State(state): State<AppState>,
    auth: AuthContext,
    headers: HeaderMap,
) -> AppResult<Json<Vec<Persona>>> {
    let tenant_id = require_tenant_admin(&state.db, &auth, &headers).await?;
    let rows: Vec<Persona> = sqlx::query_as(
        r#"
        SELECT id, tenant_id, slug, display_name, description,
               system_prompt, allowed_scopes, cursor_settings, domain,
               created_at, updated_at
        FROM agent_personas
        WHERE tenant_id = $1
        ORDER BY display_name
        "#,
    )
    .bind(tenant_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

pub async fn delete_persona(
    State(state): State<AppState>,
    auth: AuthContext,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let tenant_id = require_tenant_admin(&state.db, &auth, &headers).await?;
    let n = sqlx::query("DELETE FROM agent_personas WHERE tenant_id = $1 AND slug = $2")
        .bind(tenant_id)
        .bind(slug.to_lowercase())
        .execute(&state.db)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(serde_json::json!({ "deleted": slug })))
}

// ─────────────────────────────────────────────────────────────────────────────
// KEK status + admin
// ─────────────────────────────────────────────────────────────────────────────

pub async fn kek_status(
    State(state): State<AppState>,
    State(kek): State<KekProvider>,
    auth: AuthContext,
    headers: HeaderMap,
) -> AppResult<Json<KekStatus>> {
    // Tenant scoping isn't strictly necessary (status is global) but we
    // still require a tenant admin to even know about the vault.
    let _ = require_tenant_admin(&state.db, &auth, &headers).await?;

    if !kek.is_configured() {
        return Ok(Json(KekStatus {
            configured: false,
            active_version: None,
            fingerprint: None,
            source: "none".to_string(),
        }));
    }
    let active = kek.active().await.map_err(map_kek_err)?;
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT fingerprint, source FROM vault_kek_versions WHERE version = $1",
    )
    .bind(active.version)
    .fetch_optional(&state.db)
    .await?;
    let (fingerprint, db_source) = match row {
        Some((fp, src)) => (Some(fp), Some(src)),
        None => (None, None),
    };
    // Prefer the DB-recorded source (so the UI can spot a mismatch like
    // "row says env_prod but process is running env_dev"); fall back to
    // whatever the live provider reports.
    let source = db_source.unwrap_or_else(|| kek.source_label().to_string());
    Ok(Json(KekStatus {
        configured: true,
        active_version: Some(active.version),
        fingerprint,
        source,
    }))
}
