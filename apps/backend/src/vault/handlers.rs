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
use crate::vault::onion_client;

/// Default for the `spec_version` column when an upsert body omits it.
/// Tracks PERSONA_SPEC.md.
const PERSONA_SPEC_DEFAULT_VERSION: &str = "1.0";

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

/// Validate `spec_version`: must look like "1.x". We accept any minor in
/// the v1 series so existing rows keep working as we evolve the spec.
fn validate_spec_version(s: &str) -> AppResult<()> {
    // Accept "1", "1.0", "1.5", "1.10". Reject "2.x" / non-numeric / blank.
    let mut parts = s.split('.');
    let major = parts.next().and_then(|p| p.parse::<u32>().ok());
    let minor_ok = parts.next().map(|p| p.parse::<u32>().is_ok()).unwrap_or(true);
    let extra = parts.next().is_some();
    if major != Some(1) || !minor_ok || extra {
        return Err(AppError::bad_request(format!(
            "unsupported spec_version '{s}' (only 1.x is recognised)"
        )));
    }
    Ok(())
}

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

    let spec_version = body
        .spec_version
        .as_deref()
        .unwrap_or(PERSONA_SPEC_DEFAULT_VERSION)
        .to_string();
    validate_spec_version(&spec_version)?;

    // capabilities is opaque to us — only enforce it's a JSON array.
    let capabilities = body
        .capabilities
        .clone()
        .unwrap_or_else(|| serde_json::json!([]));
    if !capabilities.is_array() {
        return Err(AppError::bad_request("capabilities must be a JSON array"));
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
            system_prompt, allowed_scopes, cursor_settings, domain,
            spec_version, capabilities, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (tenant_id, slug) DO UPDATE
        SET display_name    = EXCLUDED.display_name,
            description     = EXCLUDED.description,
            system_prompt   = EXCLUDED.system_prompt,
            allowed_scopes  = EXCLUDED.allowed_scopes,
            cursor_settings = EXCLUDED.cursor_settings,
            domain          = EXCLUDED.domain,
            spec_version    = EXCLUDED.spec_version,
            capabilities    = EXCLUDED.capabilities
        RETURNING id, tenant_id, slug, display_name, description,
                  system_prompt, allowed_scopes, cursor_settings, domain,
                  spec_version, capabilities, created_at, updated_at
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
    .bind(&spec_version)
    .bind(&capabilities)
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
               spec_version, capabilities, created_at, updated_at
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

pub async fn get_persona(
    State(state): State<AppState>,
    auth: AuthContext,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> AppResult<Json<Persona>> {
    let tenant_id = require_tenant_admin(&state.db, &auth, &headers).await?;
    let row: Option<Persona> = sqlx::query_as(
        r#"
        SELECT id, tenant_id, slug, display_name, description,
               system_prompt, allowed_scopes, cursor_settings, domain,
               spec_version, capabilities, created_at, updated_at
        FROM agent_personas
        WHERE tenant_id = $1 AND slug = $2
        "#,
    )
    .bind(tenant_id)
    .bind(slug.to_lowercase())
    .fetch_optional(&state.db)
    .await?;
    row.map(Json).ok_or(AppError::NotFound)
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
// Persona launch pipeline: preview-env / issue / record-launch / revoke
// ─────────────────────────────────────────────────────────────────────────────

/// Internal sqlx shim — we need raw byte columns to decrypt secrets, which
/// the public `SecretMetadata` deliberately hides.
#[derive(sqlx::FromRow)]
struct SecretFullRow {
    id: Uuid,
    name: String,
    ciphertext: Vec<u8>,
    nonce: Vec<u8>,
    auth_tag: Vec<u8>,
    dek_wrapped: Vec<u8>,
    dek_nonce: Vec<u8>,
}

/// Internal sqlx shim for operator refs lookup during issue.
#[derive(sqlx::FromRow)]
struct OperatorRefRow {
    operator_id: String,
    operator_name: String,
}

/// Resolve a persona's `allowed_scopes` into a flat list of env vars.
/// `reveal=true` → actually decrypt secrets and (if `mint=true`) mint
/// JWTs; `reveal=false` → return shape only, never plaintext.
///
/// On `issue` (reveal+mint), we additionally collect the minted jtis and
/// the earliest expiry so the audit log + UI countdown work.
async fn resolve_scopes(
    state: &AppState,
    kek: &KekProvider,
    tenant_id: Uuid,
    persona_id: Uuid,
    scope_ids: &[Uuid],
    reveal: bool,
    mint: bool,
) -> AppResult<(Vec<ResolvedEnvVar>, Vec<String>, Option<f64>, Vec<String>)> {
    if scope_ids.is_empty() {
        return Ok((vec![], vec![], None, vec![]));
    }

    let scopes: Vec<Scope> = sqlx::query_as(
        r#"
        SELECT id, tenant_id, name, description, bindings,
               primary_operator_ref_id, created_at, updated_at
        FROM vault_scopes
        WHERE tenant_id = $1 AND id = ANY($2)
        "#,
    )
    .bind(tenant_id)
    .bind(scope_ids)
    .fetch_all(&state.db)
    .await?;

    if scopes.len() != scope_ids.len() {
        return Err(AppError::bad_request(
            "one or more allowed_scopes do not belong to this tenant",
        ));
    }

    // Decrypt KEK once per request (cheap; the provider caches).
    let active_kek = if reveal {
        Some(kek.active().await.map_err(map_kek_err)?)
    } else {
        None
    };

    let mut out: Vec<ResolvedEnvVar> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut jtis: Vec<String> = Vec::new();
    let mut min_expiry: Option<f64> = None;
    // Ensure we don't issue two bindings claiming the same env name.
    let mut seen_envs: std::collections::HashSet<String> = std::collections::HashSet::new();

    for scope in &scopes {
        let arr = scope
            .bindings
            .as_array()
            .cloned()
            .unwrap_or_default();
        for (i, binding) in arr.iter().enumerate() {
            let kind = binding
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let env_name = binding
                .get("env")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if env_name.is_empty() {
                errors.push(format!("scope '{}' bindings[{}].env missing", scope.name, i));
                continue;
            }
            if !seen_envs.insert(env_name.clone()) {
                errors.push(format!(
                    "scope '{}' bindings[{}] duplicates env '{}'",
                    scope.name, i, env_name
                ));
                continue;
            }

            match kind {
                "static" => {
                    let value_str = binding
                        .get("value")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let value_len = value_str.len();
                    out.push(ResolvedEnvVar {
                        env: env_name,
                        kind: "static".into(),
                        value: if reveal { Some(value_str) } else { None },
                        value_len,
                        secret_name: None,
                        operator_name: None,
                        ttl_seconds: None,
                        jti: None,
                        expires_at: None,
                        readonly: None,
                    });
                }
                "passthrough" => {
                    let secret_name = binding
                        .get("secret_name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if secret_name.is_empty() {
                        errors.push(format!(
                            "scope '{}' bindings[{}] passthrough missing secret_name",
                            scope.name, i
                        ));
                        continue;
                    }
                    if reveal {
                        let row: Option<SecretFullRow> = sqlx::query_as(
                            r#"
                            SELECT id, name, ciphertext, nonce, auth_tag,
                                   dek_wrapped, dek_nonce
                            FROM vault_secrets
                            WHERE tenant_id = $1 AND name = $2
                            "#,
                        )
                        .bind(tenant_id)
                        .bind(&secret_name)
                        .fetch_optional(&state.db)
                        .await?;
                        let Some(row) = row else {
                            errors.push(format!(
                                "scope '{}' passthrough refers to missing secret '{}'",
                                scope.name, secret_name
                            ));
                            continue;
                        };
                        let kek_material = &active_kek.as_ref().expect("kek loaded").material;
                        let nonce = bytes_to_array_12(&row.nonce)?;
                        let tag = bytes_to_array_16(&row.auth_tag)?;
                        let dek_nonce = bytes_to_array_12(&row.dek_nonce)?;
                        let dek = crypto::unwrap_dek(
                            kek_material,
                            &row.dek_wrapped,
                            &dek_nonce,
                            &tenant_id,
                            &row.name,
                        )
                        .map_err(AppError::Internal)?;
                        let plaintext = crypto::decrypt_with_dek(
                            &dek,
                            &nonce,
                            &tag,
                            &row.ciphertext,
                        )
                        .map_err(AppError::Internal)?;
                        let value_str = String::from_utf8(plaintext).map_err(|e| {
                            AppError::Internal(anyhow::anyhow!(
                                "secret '{}' is not valid UTF-8: {e}",
                                secret_name
                            ))
                        })?;
                        // Touch last_used_at; best-effort, ignore failure.
                        let _ = sqlx::query(
                            "UPDATE vault_secrets SET last_used_at = now() WHERE id = $1",
                        )
                        .bind(row.id)
                        .execute(&state.db)
                        .await;
                        let value_len = value_str.len();
                        out.push(ResolvedEnvVar {
                            env: env_name,
                            kind: "passthrough".into(),
                            value: Some(value_str),
                            value_len,
                            secret_name: Some(secret_name),
                            operator_name: None,
                            ttl_seconds: None,
                            jti: None,
                            expires_at: None,
                            readonly: None,
                        });
                    } else {
                        // Preview-only: confirm the secret exists, return shape.
                        let exists: Option<i32> = sqlx::query_scalar(
                            "SELECT 1 FROM vault_secrets WHERE tenant_id = $1 AND name = $2",
                        )
                        .bind(tenant_id)
                        .bind(&secret_name)
                        .fetch_optional(&state.db)
                        .await?;
                        if exists.is_none() {
                            errors.push(format!(
                                "scope '{}' passthrough refers to missing secret '{}'",
                                scope.name, secret_name
                            ));
                        }
                        out.push(ResolvedEnvVar {
                            env: env_name,
                            kind: "passthrough".into(),
                            value: None,
                            value_len: 0,
                            secret_name: Some(secret_name),
                            operator_name: None,
                            ttl_seconds: None,
                            jti: None,
                            expires_at: None,
                            readonly: None,
                        });
                    }
                }
                "onion_jwt" => {
                    let operator_ref_id = binding
                        .get("operator_ref_id")
                        .and_then(|v| v.as_str())
                        .and_then(|s| Uuid::parse_str(s).ok());
                    let Some(op_id) = operator_ref_id else {
                        errors.push(format!(
                            "scope '{}' bindings[{}] onion_jwt missing operator_ref_id",
                            scope.name, i
                        ));
                        continue;
                    };
                    let ttl = binding
                        .get("ttl_seconds")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(state.cfg.default_persona_jwt_ttl_seconds);
                    let readonly = binding
                        .get("readonly")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true);

                    let op_row: Option<OperatorRefRow> = sqlx::query_as(
                        r#"
                        SELECT operator_id, operator_name
                        FROM vault_operator_refs
                        WHERE tenant_id = $1 AND id = $2
                        "#,
                    )
                    .bind(tenant_id)
                    .bind(op_id)
                    .fetch_optional(&state.db)
                    .await?;
                    let Some(op) = op_row else {
                        errors.push(format!(
                            "scope '{}' onion_jwt operator_ref_id {} not found",
                            scope.name, op_id
                        ));
                        continue;
                    };

                    if reveal && mint {
                        let scope_id_str = scope.id.to_string();
                        let persona_id_str = persona_id.to_string();
                        let mint_req = onion_client::MintTokenRequest {
                            operator_id: &op.operator_id,
                            operator_name: Some(&op.operator_name),
                            persona_id: Some(&persona_id_str),
                            scope_id: Some(&scope_id_str),
                            ttl_seconds: ttl,
                            readonly,
                        };
                        match onion_client::mint_token(&state.cfg, mint_req).await {
                            Ok(resp) => {
                                jtis.push(resp.jti.clone());
                                min_expiry = Some(match min_expiry {
                                    Some(prev) => prev.min(resp.expires_at),
                                    None => resp.expires_at,
                                });
                                let value_len = resp.token.len();
                                out.push(ResolvedEnvVar {
                                    env: env_name,
                                    kind: "onion_jwt".into(),
                                    value: Some(resp.token),
                                    value_len,
                                    secret_name: None,
                                    operator_name: Some(op.operator_name),
                                    ttl_seconds: Some(ttl),
                                    jti: Some(resp.jti),
                                    expires_at: Some(resp.expires_at),
                                    readonly: Some(readonly),
                                });
                            }
                            Err(e) => {
                                tracing::warn!(error = ?e, scope = %scope.name,
                                    "onion mint-token failed");
                                // Use {:#} to render the full error chain
                                // (reqwest → DNS / TLS / status); the bare
                                // {e} only gives the outermost context line.
                                errors.push(format!(
                                    "scope '{}' onion_jwt mint failed: {:#}",
                                    scope.name, e
                                ));
                            }
                        }
                    } else {
                        // Preview only: don't burn a JWT just to render the wizard.
                        out.push(ResolvedEnvVar {
                            env: env_name,
                            kind: "onion_jwt".into(),
                            value: None,
                            value_len: 0,
                            secret_name: None,
                            operator_name: Some(op.operator_name),
                            ttl_seconds: Some(ttl),
                            jti: None,
                            expires_at: None,
                            readonly: Some(readonly),
                        });
                    }
                }
                "r2_presigned" => {
                    // P2 — design lives in ARCHITECTURE_VAULT.md but we don't
                    // ship the AWS SigV4 wrapper yet. Surface the shape so the
                    // wizard renders correctly, mark it errored so issue blocks.
                    errors.push(format!(
                        "scope '{}' r2_presigned binding is not implemented yet",
                        scope.name
                    ));
                    out.push(ResolvedEnvVar {
                        env: env_name,
                        kind: "r2_presigned".into(),
                        value: None,
                        value_len: 0,
                        secret_name: binding
                            .get("secret_name")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        operator_name: None,
                        ttl_seconds: binding.get("ttl_seconds").and_then(|v| v.as_i64()),
                        jti: None,
                        expires_at: None,
                        readonly: None,
                    });
                }
                other => {
                    errors.push(format!(
                        "scope '{}' bindings[{}] unknown kind '{}'",
                        scope.name, i, other
                    ));
                }
            }
        }
    }

    if !errors.is_empty() {
        // Stash on the AppError if we're in mint mode (caller will turn into 400).
        if mint {
            return Err(AppError::bad_request(format!(
                "persona resolution failed: {}",
                errors.join("; ")
            )));
        }
    }

    Ok((out, errors, min_expiry, jtis))
}

fn bytes_to_array_12(b: &[u8]) -> AppResult<[u8; 12]> {
    if b.len() != 12 {
        return Err(AppError::Internal(anyhow::anyhow!(
            "expected 12-byte nonce, got {}",
            b.len()
        )));
    }
    let mut a = [0u8; 12];
    a.copy_from_slice(b);
    Ok(a)
}

fn bytes_to_array_16(b: &[u8]) -> AppResult<[u8; 16]> {
    if b.len() != 16 {
        return Err(AppError::Internal(anyhow::anyhow!(
            "expected 16-byte tag, got {}",
            b.len()
        )));
    }
    let mut a = [0u8; 16];
    a.copy_from_slice(b);
    Ok(a)
}

pub async fn preview_persona_env(
    State(state): State<AppState>,
    State(kek): State<KekProvider>,
    auth: AuthContext,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Query(q): Query<PreviewEnvQuery>,
) -> AppResult<Json<PersonaPreview>> {
    let tenant_id = require_tenant_admin(&state.db, &auth, &headers).await?;
    let persona: Option<Persona> = sqlx::query_as(
        r#"
        SELECT id, tenant_id, slug, display_name, description,
               system_prompt, allowed_scopes, cursor_settings, domain,
               spec_version, capabilities, created_at, updated_at
        FROM agent_personas
        WHERE tenant_id = $1 AND slug = $2
        "#,
    )
    .bind(tenant_id)
    .bind(slug.to_lowercase())
    .fetch_optional(&state.db)
    .await?;
    let persona = persona.ok_or(AppError::NotFound)?;

    // reveal=true on preview also mints JWTs (so the dashboard shows real
    // expiry countdowns). Use this carefully: every preview burns tokens.
    let scope_ids = persona.allowed_scopes.clone();
    let persona_id = persona.id;
    let cursor_settings = persona.cursor_settings.clone();

    let result = resolve_scopes(
        &state,
        &kek,
        tenant_id,
        persona_id,
        &scope_ids,
        q.reveal,
        q.reveal,
    )
    .await;

    // In preview we want to surface errors instead of failing the request,
    // so swallow bad_request from resolve_scopes and re-derive ok=false.
    let (env, errors) = match result {
        Ok((env, errors, _expiry, _jtis)) => (env, errors),
        Err(AppError::BadRequest(msg)) => (vec![], vec![msg]),
        Err(other) => return Err(other),
    };

    let total_value_bytes: usize = env.iter().map(|e| e.value_len).sum();
    let ok = errors.is_empty();
    Ok(Json(PersonaPreview {
        persona,
        env,
        total_value_bytes,
        cursor_settings,
        ok,
        errors,
    }))
}

pub async fn issue_persona(
    State(state): State<AppState>,
    State(kek): State<KekProvider>,
    auth: AuthContext,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Json(body): Json<IssuePersonaBody>,
) -> AppResult<Json<IssuanceResponse>> {
    let tenant_id = require_tenant_admin(&state.db, &auth, &headers).await?;
    let persona: Persona = sqlx::query_as(
        r#"
        SELECT id, tenant_id, slug, display_name, description,
               system_prompt, allowed_scopes, cursor_settings, domain,
               spec_version, capabilities, created_at, updated_at
        FROM agent_personas
        WHERE tenant_id = $1 AND slug = $2
        "#,
    )
    .bind(tenant_id)
    .bind(slug.to_lowercase())
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let (env, _errors, min_expiry, jtis) = resolve_scopes(
        &state,
        &kek,
        tenant_id,
        persona.id,
        &persona.allowed_scopes,
        true,
        true,
    )
    .await?;

    let env_keys: Vec<String> = env.iter().map(|e| e.env.clone()).collect();
    let scope_ids = persona.allowed_scopes.clone();
    let primary_jti = jtis.first().cloned();
    let expires_at = min_expiry.and_then(|exp| chrono::DateTime::from_timestamp(exp as i64, 0));

    let id = Uuid::now_v7();
    sqlx::query(
        r#"
        INSERT INTO vault_issuance_log (
            id, tenant_id, persona_id, issued_to_user,
            bridge_name, cursor_agent_id, cursor_run_id,
            scope_ids, env_keys, onion_jti, onion_jtis,
            metadata, expires_at
        )
        VALUES ($1, $2, $3, $4,
                $5, $6, $7,
                $8, $9, $10, $11,
                $12, $13)
        "#,
    )
    .bind(id)
    .bind(tenant_id)
    .bind(persona.id)
    .bind(auth.user.id)
    .bind(&body.bridge_name)
    .bind(&body.cursor_agent_id)
    .bind(&body.cursor_run_id)
    .bind(&scope_ids)
    .bind(&env_keys)
    .bind(&primary_jti)
    .bind(&jtis)
    .bind(serde_json::json!({
        "cursor_settings": persona.cursor_settings,
        "spec_version": persona.spec_version,
    }))
    .bind(expires_at)
    .execute(&state.db)
    .await?;

    tracing::info!(
        tenant = %tenant_id,
        persona = %persona.slug,
        issuance = %id,
        env_keys = ?env_keys,
        jtis = ?jtis,
        "persona issued"
    );

    Ok(Json(IssuanceResponse {
        id,
        persona_id: persona.id,
        env,
        env_keys,
        scope_ids,
        min_expires_at: min_expiry,
        jtis,
        cursor_settings: persona.cursor_settings,
    }))
}

pub async fn record_launch(
    State(state): State<AppState>,
    auth: AuthContext,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<RecordLaunchBody>,
) -> AppResult<Json<serde_json::Value>> {
    let tenant_id = require_tenant_admin(&state.db, &auth, &headers).await?;
    let n = sqlx::query(
        r#"
        UPDATE vault_issuance_log
        SET bridge_name = COALESCE($3, bridge_name),
            cursor_agent_id = $4,
            cursor_run_id = COALESCE($5, cursor_run_id)
        WHERE tenant_id = $1 AND id = $2
        "#,
    )
    .bind(tenant_id)
    .bind(id)
    .bind(&body.bridge_name)
    .bind(&body.cursor_agent_id)
    .bind(&body.cursor_run_id)
    .execute(&state.db)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(serde_json::json!({ "ok": true, "id": id })))
}

pub async fn revoke_issuance(
    State(state): State<AppState>,
    auth: AuthContext,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<RevokeIssuanceBody>,
) -> AppResult<Json<serde_json::Value>> {
    let tenant_id = require_tenant_admin(&state.db, &auth, &headers).await?;
    let row: Option<(Vec<String>, Option<chrono::DateTime<chrono::Utc>>)> = sqlx::query_as(
        r#"
        SELECT onion_jtis, revoked_at
        FROM vault_issuance_log
        WHERE tenant_id = $1 AND id = $2
        "#,
    )
    .bind(tenant_id)
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let Some((jtis, revoked_at)) = row else {
        return Err(AppError::NotFound);
    };
    if revoked_at.is_some() {
        return Ok(Json(serde_json::json!({ "ok": true, "already_revoked": true })));
    }

    let mut revoked: Vec<String> = Vec::new();
    let mut failed: Vec<serde_json::Value> = Vec::new();
    for jti in &jtis {
        match onion_client::revoke_token(
            &state.cfg,
            onion_client::RevokeTokenRequest {
                jti,
                reason: body.reason.as_deref(),
                revoked_by: Some("shujian-backend"),
            },
        )
        .await
        {
            Ok(resp) => revoked.push(resp.jti),
            Err(e) => {
                tracing::warn!(error = ?e, jti = %jti, "onion revoke-token failed");
                failed.push(serde_json::json!({ "jti": jti, "error": e.to_string() }));
            }
        }
    }

    sqlx::query(
        "UPDATE vault_issuance_log SET revoked_at = now() WHERE tenant_id = $1 AND id = $2",
    )
    .bind(tenant_id)
    .bind(id)
    .execute(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "ok": true,
        "id": id,
        "revoked_jtis": revoked,
        "failed": failed,
    })))
}

#[derive(Debug, Deserialize, Default)]
pub struct ListIssuancesQuery {
    pub persona_slug: Option<String>,
    pub limit: Option<i64>,
}

pub async fn list_issuances(
    State(state): State<AppState>,
    auth: AuthContext,
    headers: HeaderMap,
    Query(q): Query<ListIssuancesQuery>,
) -> AppResult<Json<Vec<IssuanceLogRow>>> {
    let tenant_id = require_tenant_admin(&state.db, &auth, &headers).await?;
    let limit = q.limit.unwrap_or(100).clamp(1, 500);

    let rows: Vec<IssuanceLogRow> = match q.persona_slug.as_deref() {
        Some(slug) => sqlx::query_as(
            r#"
            SELECT l.id, l.tenant_id, l.persona_id, l.issued_to_user,
                   l.bridge_name, l.cursor_agent_id, l.cursor_run_id,
                   l.scope_ids, l.env_keys, l.onion_jti, l.onion_jtis,
                   l.metadata, l.expires_at, l.revoked_at, l.created_at
            FROM vault_issuance_log l
            JOIN agent_personas p ON p.id = l.persona_id
            WHERE l.tenant_id = $1 AND p.slug = $2
            ORDER BY l.created_at DESC
            LIMIT $3
            "#,
        )
        .bind(tenant_id)
        .bind(slug.to_lowercase())
        .bind(limit)
        .fetch_all(&state.db)
        .await?,
        None => sqlx::query_as(
            r#"
            SELECT id, tenant_id, persona_id, issued_to_user,
                   bridge_name, cursor_agent_id, cursor_run_id,
                   scope_ids, env_keys, onion_jti, onion_jtis,
                   metadata, expires_at, revoked_at, created_at
            FROM vault_issuance_log
            WHERE tenant_id = $1
            ORDER BY created_at DESC
            LIMIT $2
            "#,
        )
        .bind(tenant_id)
        .bind(limit)
        .fetch_all(&state.db)
        .await?,
    };
    Ok(Json(rows))
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
