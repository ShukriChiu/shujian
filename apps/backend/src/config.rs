use std::env;

use anyhow::{Context, Result};

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: String,
    pub session_ttl_days: i64,
    pub seed_tenant_slug: String,
    pub seed_tenant_name: String,
    pub seed_tenant_display_name: String,
    pub seed_admin_identifier: String,
    pub seed_admin_password: String,
    pub cors_allow_origins: Vec<String>,
    /// Base URL of the onion-agent we mint persona JWTs against.
    /// e.g. `https://onion-agent.shujian.art` or `http://localhost:8000` in dev.
    pub onion_api_base: String,
    /// Shared secret sent as `X-Backend-Secret` to onion-agent's
    /// `/api/internal/persona/*` endpoints. Must match what onion-agent has.
    /// If empty the persona launch path returns 503 with a clear error.
    pub backend_shared_secret: String,
    /// Default TTL for minted persona JWTs in seconds. Per-binding
    /// `ttl_seconds` overrides this when set.
    pub default_persona_jwt_ttl_seconds: i64,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        // .env in dev only — in production Railway injects vars directly.
        let _ = dotenvy::dotenv();

        let database_url = env::var("DATABASE_URL")
            .context("DATABASE_URL is required (Postgres connection string)")?;

        let port = env::var("PORT").unwrap_or_else(|_| "8080".into());
        let host = env::var("HOST").unwrap_or_else(|_| "0.0.0.0".into());
        let bind_addr = format!("{host}:{port}");

        let session_ttl_days = env::var("SESSION_TTL_DAYS")
            .ok()
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(30);

        // Seed defaults match the user's onboarding spec: one tenant
        // ("书剑未来科技咨询有限公司") + one admin (admin/admin). All overridable.
        let seed_tenant_slug = env::var("SEED_TENANT_SLUG").unwrap_or_else(|_| "onion".into());
        let seed_tenant_name = env::var("SEED_TENANT_NAME").unwrap_or_else(|_| "书剑".into());
        let seed_tenant_display_name = env::var("SEED_TENANT_DISPLAY_NAME")
            .unwrap_or_else(|_| "书剑未来科技咨询有限公司".into());
        let seed_admin_identifier =
            env::var("SEED_ADMIN_IDENTIFIER").unwrap_or_else(|_| "admin".into());
        let seed_admin_password =
            env::var("SEED_ADMIN_PASSWORD").unwrap_or_else(|_| "admin".into());

        let mut cors_allow_origins = env::var("CORS_ALLOW_ORIGINS")
            .map(|s| {
                s.split(',')
                    .map(|p| p.trim().to_string())
                    .filter(|p| !p.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|_| {
                vec![
                    "http://localhost:5173".into(),
                    "http://127.0.0.1:5173".into(),
                    "https://shujian-dashboard.pages.dev".into(),
                ]
            });
        // Keep critical public frontend origins available even when
        // CORS_ALLOW_ORIGINS is partially configured in production.
        for required in [
            "https://shujian-dashboard.pages.dev",
            "https://shujian-future.pages.dev",
            "https://future.shujian.art",
        ] {
            if !cors_allow_origins.iter().any(|origin| origin == required) {
                cors_allow_origins.push(required.to_string());
            }
        }

        let onion_api_base = env::var("ONION_API_BASE")
            .ok()
            .map(|s| s.trim_end_matches('/').to_string())
            .unwrap_or_else(|| "https://onion-api.shujian.art".into());
        let backend_shared_secret = env::var("BACKEND_SHARED_SECRET").unwrap_or_default();
        let default_persona_jwt_ttl_seconds = env::var("DEFAULT_PERSONA_JWT_TTL_SECONDS")
            .ok()
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(3600);

        Ok(Self {
            database_url,
            bind_addr,
            session_ttl_days,
            seed_tenant_slug,
            seed_tenant_name,
            seed_tenant_display_name,
            seed_admin_identifier,
            seed_admin_password,
            cors_allow_origins,
            onion_api_base,
            backend_shared_secret,
            default_persona_jwt_ttl_seconds,
        })
    }
}
