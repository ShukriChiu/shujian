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
    /// PERSONA_SPEC.md version. Defaults to "1.0" if omitted.
    #[serde(default)]
    pub spec_version: Option<String>,
    /// Opaque manifest of UI surfaces (kpi_grid / line_chart / etc.)
    /// the dashboard renders. Backend stores verbatim; never inspects.
    #[serde(default)]
    pub capabilities: Option<serde_json::Value>,
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
    pub spec_version: String,
    /// Opaque to the backend — see personas/PERSONA_SPEC.md.
    pub capabilities: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Read shape for `vault_issuance_log`. Surfaced via the audit dashboard
/// and the persona launch endpoint.
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
    pub onion_jtis: Vec<String>,
    pub metadata: serde_json::Value,
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

// ─────────────────────────────────────────────────────────────────────────────
// Persona resolution / launch
// ─────────────────────────────────────────────────────────────────────────────

/// One row in the resolved env. Mirrors a single binding after it's been
/// turned into an actual env var. Always returned for `preview-env`; for
/// `issue` the `value` field is populated, otherwise it's masked.
#[derive(Debug, Serialize)]
pub struct ResolvedEnvVar {
    /// The env var name (e.g. `ONION_API_TOKEN`).
    pub env: String,
    /// Which kind of binding produced it.
    pub kind: String,
    /// The actual value — only set when the caller asked for it (issue mode).
    /// Always None in preview mode so the dashboard can't accidentally leak.
    pub value: Option<String>,
    /// Length of the resolved value in bytes; useful for the preview UI to
    /// show "[redacted, 64 chars]".
    pub value_len: usize,
    /// For `passthrough`: which secret was decrypted.
    pub secret_name: Option<String>,
    /// For `onion_jwt`: the operator (display name).
    pub operator_name: Option<String>,
    /// For `onion_jwt`: TTL the JWT was minted with (or would be).
    pub ttl_seconds: Option<i64>,
    /// For `onion_jwt`: jti of the minted JWT (issue mode only).
    pub jti: Option<String>,
    /// For `onion_jwt`: unix expiry of the JWT (issue mode only).
    pub expires_at: Option<f64>,
    /// For `onion_jwt`: whether the binding is readonly.
    pub readonly: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct PersonaPreview {
    pub persona: Persona,
    pub env: Vec<ResolvedEnvVar>,
    /// Sum of value bytes, useful for "this much will be injected".
    pub total_value_bytes: usize,
    /// Cursor settings parsed out for the wizard's preview pane.
    pub cursor_settings: serde_json::Value,
    /// True if every binding resolved successfully. Errors are reported
    /// per-row in `errors`.
    pub ok: bool,
    pub errors: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct PreviewEnvQuery {
    /// `reveal=true` actually mints JWTs and decrypts secrets. **This is
    /// the only path that surfaces plaintext in the response.** Used by
    /// the launch wizard's final-confirm step and by the workspace probe.
    #[serde(default)]
    pub reveal: bool,
}

#[derive(Debug, Deserialize)]
pub struct IssuePersonaBody {
    /// Optional bridge label (e.g. "mac-mini-studio") — recorded in the
    /// issuance log. Free-form.
    pub bridge_name: Option<String>,
    /// Optional cursor agent id (set by dashboard once it actually launched).
    /// Most callers will issue → launch → then come back and call
    /// `record_launch` to fill these in.
    pub cursor_agent_id: Option<String>,
    pub cursor_run_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct IssuanceResponse {
    /// Row id in `vault_issuance_log`. Use this to revoke later.
    pub id: Uuid,
    pub persona_id: Uuid,
    pub env: Vec<ResolvedEnvVar>,
    pub env_keys: Vec<String>,
    pub scope_ids: Vec<Uuid>,
    /// Earliest expires_at across all minted JWTs. Use this to drive the
    /// dashboard's "x minutes left" countdown.
    pub min_expires_at: Option<f64>,
    pub jtis: Vec<String>,
    pub cursor_settings: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct RecordLaunchBody {
    pub bridge_name: Option<String>,
    pub cursor_agent_id: String,
    pub cursor_run_id: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct RevokeIssuanceBody {
    pub reason: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent vaults: lightweight named env bundles created by end users and
// injected into Cursor cloud agents at launch. See migration 0004 for the
// table layout and `vault/handlers.rs::agent_vaults` module for the routes.
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct UpsertAgentVaultBody {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    /// Flat key→value map. Stored encrypted at rest. Empty map is allowed
    /// (callers sometimes create the bundle first and fill values later).
    #[serde(default)]
    pub envs: std::collections::BTreeMap<String, String>,
}

/// Public read shape — returned by list/get/upsert. `envs` is plaintext
/// **only** on the per-id GET endpoint (used at launch time / the editor)
/// and is omitted from list responses to keep the list cheap.
#[derive(Debug, Serialize)]
pub struct AgentVault {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub user_id: Uuid,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    /// Cached list of env keys — always populated, even when `envs` is None.
    pub env_keys: Vec<String>,
    pub env_count: i32,
    /// Plaintext envs. Populated on detail GET / immediately after upsert
    /// so the dashboard can re-render without an extra round-trip. List
    /// responses leave this `None`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub envs: Option<std::collections::BTreeMap<String, String>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
