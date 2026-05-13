//! KEK provider.
//!
//! The KEK lives **outside the Postgres database** so a leaked PG dump is
//! useless on its own (the wrapped DEKs in `vault_secrets` cannot be
//! unwrapped without the KEK). For early-stage deployments we keep the KEK
//! in a Railway env var; the abstraction here is intentionally narrow so we
//! can later swap to AWS KMS / GCP KMS / 1Password Connect by changing only
//! `KekProvider::new` and the `fetch_material` body.
//!
//! Source of the active KEK is, in priority order:
//!   1. `SHUJIAN_VAULT_KEK_B64` (production). 32 bytes, base64-encoded.
//!      `openssl rand -base64 32`. Set in Railway → service env.
//!   2. `SHUJIAN_VAULT_DEV_KEK_B64` (local dev). Same shape; presence of
//!      this env triggers a loud "DEV KEK active — DO NOT USE IN PROD"
//!      banner so we never accidentally ship a dev KEK to prod.
//!   3. Neither set → vault endpoints return 503 with a helpful message.
//!
//! Why not Cloudflare Secrets Store? It's a Worker-binding product, not a
//! KMS — there's no public REST endpoint to read a secret value from a
//! non-Worker process. We could deploy a tiny Worker as a proxy, but the
//! Worker's bearer token would itself be the new "real" KEK, just shifting
//! the boundary. Until we want HSM-backed unwrap (AWS KMS Decrypt API),
//! Railway env is the right level of paranoia.
//!
//! `vault_kek_versions` is the source of truth for "which version is active
//! right now". On boot the provider reads the row with the highest
//! `version` that has `deprecated_at IS NULL`, and that's the version it
//! resolves against. Rotation = an admin endpoint inserts a new active
//! version (and sets `SHUJIAN_VAULT_KEK_B64` to the new value via Railway)
//! + re-wraps every row's DEK in a bg task using the historical material
//! cached here.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
use sqlx::PgPool;
use tokio::sync::Mutex;

use crate::vault::crypto::{decode_kek_b64, kek_fingerprint};

/// How long we cache resolved KEK material in memory before re-checking the
/// active version. Longer = fewer DB round-trips on hot paths; shorter =
/// faster propagation when we rotate. 5 minutes is fine because rotation
/// is a rare manual-ish event.
const CACHE_TTL: Duration = Duration::from_secs(300);

#[derive(Clone)]
pub struct KekProvider {
    inner: Arc<Mutex<KekState>>,
    /// Production KEK loaded once at boot from `SHUJIAN_VAULT_KEK_B64`.
    /// Versions newer than what we have here are unreachable until the
    /// process is restarted with the new env (intentional: KEK rotation =
    /// a deploy event in this design).
    prod_kek: Option<[u8; 32]>,
    /// Local dev fallback. Mutually exclusive with `prod_kek`; if both are
    /// set, prod wins and we log a warning.
    dev_kek: Option<[u8; 32]>,
    db: PgPool,
}

#[derive(Default)]
struct KekState {
    cached_at: Option<Instant>,
    /// Version → KEK material. We keep historical entries so unwrap of
    /// older rows during rotation still works without re-reading env.
    /// In env-source mode we only ever have the current version's material
    /// here; older versions during rotation have to be re-loaded by
    /// temporarily setting `SHUJIAN_VAULT_KEK_B64_V<N>` (deliberately
    /// awkward to discourage long rotation windows).
    versions: std::collections::HashMap<i32, [u8; 32]>,
    active_version: Option<i32>,
}

#[derive(Clone, Copy)]
pub struct ActiveKek {
    pub version: i32,
    pub material: [u8; 32],
}

impl KekProvider {
    pub fn new(db: PgPool) -> Result<Self> {
        let prod = std::env::var("SHUJIAN_VAULT_KEK_B64")
            .ok()
            .filter(|s| !s.is_empty());
        let dev = std::env::var("SHUJIAN_VAULT_DEV_KEK_B64")
            .ok()
            .filter(|s| !s.is_empty());

        let (prod_kek, dev_kek) = match (prod, dev) {
            (Some(p), _) => {
                tracing::info!("vault KEK loaded from SHUJIAN_VAULT_KEK_B64 (production env)");
                (Some(decode_kek_b64(&p)?), None)
            }
            (None, Some(d)) => {
                tracing::warn!(
                    "SHUJIAN_VAULT_DEV_KEK_B64 active — DO NOT USE IN PROD. \
                     Vault encryption is using a local dev KEK. \
                     Set SHUJIAN_VAULT_KEK_B64 in Railway to switch to prod mode."
                );
                (None, Some(decode_kek_b64(&d)?))
            }
            (None, None) => {
                tracing::warn!(
                    "Vault has no KEK source. Set SHUJIAN_VAULT_KEK_B64 (prod) or \
                     SHUJIAN_VAULT_DEV_KEK_B64 (dev). Vault endpoints will return 503 \
                     until configured. Generate one with: openssl rand -base64 32"
                );
                (None, None)
            }
        };

        Ok(Self {
            inner: Arc::new(Mutex::new(KekState::default())),
            prod_kek,
            dev_kek,
            db,
        })
    }

    pub fn is_configured(&self) -> bool {
        self.prod_kek.is_some() || self.dev_kek.is_some()
    }

    /// Which env var the active material came from. Used by `KekStatus`
    /// so the dashboard can surface the right warning to operators.
    pub fn source_label(&self) -> &'static str {
        if self.prod_kek.is_some() {
            "env_prod"
        } else if self.dev_kek.is_some() {
            "env_dev"
        } else {
            "none"
        }
    }

    /// Fetch the active KEK, cached for `CACHE_TTL`. On cache miss this
    /// queries `vault_kek_versions` for the active version, then resolves
    /// the actual key material from the configured env source.
    pub async fn active(&self) -> Result<ActiveKek> {
        // Fast path: cache hit.
        {
            let state = self.inner.lock().await;
            if let (Some(at), Some(v)) = (state.cached_at, state.active_version) {
                if at.elapsed() < CACHE_TTL {
                    if let Some(material) = state.versions.get(&v).copied() {
                        return Ok(ActiveKek {
                            version: v,
                            material,
                        });
                    }
                }
            }
        }

        // Slow path: ask the DB which version is active, then resolve material.
        let version_row: Option<(i32,)> = sqlx::query_as(
            r#"
            SELECT version
            FROM vault_kek_versions
            WHERE deprecated_at IS NULL
            ORDER BY version DESC
            LIMIT 1
            "#,
        )
        .fetch_optional(&self.db)
        .await
        .context("failed to load active KEK version")?;

        let version = match version_row {
            Some((v,)) => v,
            None => {
                // First boot: bootstrap version 1 from the configured env source.
                self.bootstrap_initial_version().await?
            }
        };

        let material = self.fetch_material(version).await?;

        let mut state = self.inner.lock().await;
        state.versions.insert(version, material);
        state.active_version = Some(version);
        state.cached_at = Some(Instant::now());

        Ok(ActiveKek { version, material })
    }

    /// Resolve a specific historical KEK version (used when unwrapping rows
    /// during rotation). With env-source provider, only the current version
    /// is reliably available — older versions require a deploy with
    /// `SHUJIAN_VAULT_KEK_B64_V<N>` set, which we look up here.
    #[allow(dead_code)] // Wired up for KEK rotation in P3+.
    pub async fn material_for(&self, version: i32) -> Result<[u8; 32]> {
        {
            let state = self.inner.lock().await;
            if let Some(m) = state.versions.get(&version).copied() {
                return Ok(m);
            }
        }
        let material = self.fetch_material(version).await?;
        let mut state = self.inner.lock().await;
        state.versions.insert(version, material);
        Ok(material)
    }

    async fn fetch_material(&self, version: i32) -> Result<[u8; 32]> {
        // Look up the active version first; that one comes from the
        // primary env. Historical versions optionally come from
        // `SHUJIAN_VAULT_KEK_B64_V<N>` for rotation windows.
        let active_v = self.active_version_unlocked();

        if Some(version) == active_v || active_v.is_none() {
            if let Some(p) = self.prod_kek {
                return Ok(p);
            }
            if let Some(d) = self.dev_kek {
                return Ok(d);
            }
        }

        // Historical version path.
        let env_name = format!("SHUJIAN_VAULT_KEK_B64_V{version}");
        if let Ok(s) = std::env::var(&env_name) {
            if !s.is_empty() {
                return decode_kek_b64(&s);
            }
        }

        Err(anyhow!(
            "KEK version {version} is not loaded. Set {env_name} in env (used during rotation), \
             or restart with the active KEK if {version} is current."
        ))
    }

    /// Snapshot of `active_version` without re-acquiring the lock async.
    /// Returns `None` if the cache hasn't been primed yet.
    fn active_version_unlocked(&self) -> Option<i32> {
        // try_lock is fine here — caller holds no lock and contention is rare.
        self.inner.try_lock().ok().and_then(|s| s.active_version)
    }

    /// First-boot bootstrap: insert version 1 into `vault_kek_versions`
    /// pointing at the current env source. Safe to run twice across two
    /// boots via INSERT ... ON CONFLICT DO NOTHING + re-read.
    async fn bootstrap_initial_version(&self) -> Result<i32> {
        // Compute fingerprint from the configured material so the row is
        // meaningful. If neither prod nor dev is set we can't bootstrap.
        let probe = self
            .prod_kek
            .or(self.dev_kek)
            .ok_or_else(|| anyhow!("no KEK env configured (set SHUJIAN_VAULT_KEK_B64)"))?;
        let fingerprint = kek_fingerprint(&probe);
        let source = if self.prod_kek.is_some() {
            "env_prod"
        } else {
            "env_dev"
        };

        sqlx::query(
            r#"
            INSERT INTO vault_kek_versions (version, fingerprint, source, notes)
            VALUES (1, $1, $2, 'auto-bootstrapped on first boot')
            ON CONFLICT (version) DO NOTHING
            "#,
        )
        .bind(&fingerprint)
        .bind(source)
        .execute(&self.db)
        .await?;

        // Re-read so we always return what's actually in the DB (covers the
        // race where another process bootstrapped first).
        let row: (i32,) =
            sqlx::query_as("SELECT version FROM vault_kek_versions ORDER BY version DESC LIMIT 1")
                .fetch_one(&self.db)
                .await?;

        tracing::warn!(version = row.0, fp = %fingerprint, source = source,
            "bootstrapped vault KEK version 1");
        Ok(row.0)
    }
}
