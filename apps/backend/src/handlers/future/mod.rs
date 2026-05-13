//! `apps/future` — student intake CRM.
//!
//! Two surfaces:
//!
//! * **Public** (`/v1/future/apply/:token`) — token-gated, no bearer
//!   auth, multipart submission. The token resolves to a tenant via
//!   `future_share_links`, and the body becomes a `future_students` row
//!   plus an optional `future_resumes` row.
//!
//! * **Admin** (`/v1/future/...`) — bearer-auth, tenant-scoped CRUD over
//!   students, projects, assignments, notes, and the share link itself.
//!
//! `future_*` tables are namespaced from the rest of the backend; see
//! `migrations/0006_future_intake_redesign.sql` for the schema.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::middleware::AuthContext;

pub mod apply;
pub mod assignments;
pub mod notes;
pub mod projects;
pub mod share_link;
pub mod students;

/// Resolves the active tenant for an authenticated request. Every
/// admin endpoint demands one (no tenant = the dashboard's tenant
/// switcher hasn't run yet).
fn require_tenant(auth: &AuthContext) -> AppResult<Uuid> {
    auth.session.tenant_id.ok_or_else(|| {
        AppError::bad_request("no active tenant; pick one via /v1/auth/switch-tenant")
    })
}

/// Public-facing snapshot of a tenant for the apply page header.
/// Stripped down vs. the dashboard's tenant payload — strangers landing
/// on a share link should see the workspace name and nothing else.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicTenantInfo {
    pub tenant_name: String,
    pub label: String,
    pub is_open: bool,
}
