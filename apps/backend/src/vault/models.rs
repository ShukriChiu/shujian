//! Wire types for vault endpoints.
//!
//! The plaintext value of a secret is **only** accepted on POST/PUT and
//! **never** returned by GET. Callers can verify a secret exists, see
//! its metadata, and delete it — full stop.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct UpsertSecretBody {
    /// Lowercase, dot-separated. Example: `onion.database_url`.
    pub name: String,
    pub value: String,
    pub kind: Option<String>,
    pub description: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct SecretMetadata {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub name: String,
    pub kind: String,
    pub description: Option<String>,
    pub kek_version: i32,
    pub metadata: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub rotated_at: Option<DateTime<Utc>>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub created_by: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct CreateOperatorRefBody {
    pub system: String,
    pub operator_id: String,
    pub operator_name: String,
    #[serde(default = "default_true")]
    pub is_shadow: bool,
    pub role_hint: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct OperatorRef {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub system: String,
    pub operator_id: String,
    pub operator_name: String,
    pub is_shadow: bool,
    pub role_hint: Option<String>,
    pub metadata: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct UpsertScopeBody {
    pub name: String,
    pub description: Option<String>,
    pub bindings: serde_json::Value,
    pub primary_operator_ref_id: Option<Uuid>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Scope {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub bindings: serde_json::Value,
    pub primary_operator_ref_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct UpsertPersonaBody {
    pub slug: String,
    pub display_name: String,
    pub description: Option<String>,
    pub system_prompt: String,
    pub allowed_scopes: Vec<Uuid>,
    pub cursor_settings: serde_json::Value,
    pub domain: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Persona {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub slug: String,
    pub display_name: String,
    pub description: Option<String>,
    pub system_prompt: String,
    pub allowed_scopes: Vec<Uuid>,
    pub cursor_settings: serde_json::Value,
    pub domain: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Read shape for `vault_issuance_log`. Surfaced via the audit dashboard
/// and the persona launch endpoint; constructed by sqlx in P3+, so it's
/// `#[allow(dead_code)]` until then.
#[allow(dead_code)]
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct IssuanceLogRow {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub persona_id: Option<Uuid>,
    pub issued_to_user: Option<Uuid>,
    pub bridge_name: Option<String>,
    pub cursor_agent_id: Option<String>,
    pub cursor_run_id: Option<String>,
    pub scope_ids: Vec<Uuid>,
    pub env_keys: Vec<String>,
    pub onion_jti: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

/// KEK status surfaced to the dashboard. `source` mirrors the values stored
/// in `vault_kek_versions.source` (`env_prod` / `env_dev` / `kms:...`).
#[derive(Debug, Serialize)]
pub struct KekStatus {
    pub configured: bool,
    pub active_version: Option<i32>,
    pub fingerprint: Option<String>,
    pub source: String,
}
