//! Thin HTTP client for the onion-agent internal persona endpoints.
//!
//! shujian-backend is the *control plane* for AI personas, so it talks to
//! onion-agent's internal endpoints (gated by `X-Backend-Secret`) ONLY for:
//!
//!   POST /api/internal/persona/mint-token   → `mint_persona_jwt`
//!   POST /api/internal/persona/revoke-token → `revoke_persona_jwt`
//!   GET  /api/internal/persona/whoami       (debug; not used here)
//!
//! Critically, the backend does NOT proxy any business data. Personas
//! declare their data surfaces in `capabilities[]` (see PERSONA_SPEC.md);
//! the dashboard calls those URLs directly using the persona JWT we mint.
//! Keeping this client focused on persona lifecycle is what lets us add
//! new business endpoints in onion-agent without ever touching backend
//! code or its deploy pipeline.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

use crate::config::Config;

const BACKEND_SECRET_HEADER: &str = "X-Backend-Secret";
const REQUEST_TIMEOUT_SECS: u64 = 10;

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .user_agent("shujian-backend/0.1 (+vault)")
            .build()
            .expect("reqwest client builds")
    })
}

#[derive(Serialize)]
pub struct MintTokenRequest<'a> {
    pub operator_id: &'a str,
    pub operator_name: Option<&'a str>,
    pub persona_id: Option<&'a str>,
    pub scope_id: Option<&'a str>,
    pub ttl_seconds: i64,
    pub readonly: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct MintTokenResponse {
    pub token: String,
    pub jti: String,
    pub expires_at: f64,
    #[allow(dead_code)]
    pub kind: String,
}

pub async fn mint_token(cfg: &Config, body: MintTokenRequest<'_>) -> Result<MintTokenResponse> {
    if cfg.backend_shared_secret.is_empty() {
        return Err(anyhow!(
            "BACKEND_SHARED_SECRET is empty — cannot mint persona JWT"
        ));
    }
    let url = format!("{}/api/internal/persona/mint-token", cfg.onion_api_base);
    let resp = http()
        .post(&url)
        .header(BACKEND_SECRET_HEADER, &cfg.backend_shared_secret)
        .json(&body)
        .send()
        .await
        .with_context(|| format!("POST {url}"))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!(
            "onion mint-token returned {status}: {}",
            truncate(&text, 400)
        ));
    }
    serde_json::from_str(&text)
        .with_context(|| format!("decoding mint-token response: {}", truncate(&text, 200)))
}

#[derive(Serialize)]
pub struct RevokeTokenRequest<'a> {
    pub jti: &'a str,
    pub reason: Option<&'a str>,
    pub revoked_by: Option<&'a str>,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub struct RevokeTokenResponse {
    pub jti: String,
    pub revoked: bool,
    pub already_revoked: bool,
}

pub async fn revoke_token(
    cfg: &Config,
    body: RevokeTokenRequest<'_>,
) -> Result<RevokeTokenResponse> {
    if cfg.backend_shared_secret.is_empty() {
        return Err(anyhow!(
            "BACKEND_SHARED_SECRET is empty — cannot revoke persona JWT"
        ));
    }
    let url = format!("{}/api/internal/persona/revoke-token", cfg.onion_api_base);
    let resp = http()
        .post(&url)
        .header(BACKEND_SECRET_HEADER, &cfg.backend_shared_secret)
        .json(&body)
        .send()
        .await
        .with_context(|| format!("POST {url}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!(
            "onion revoke-token returned {status}: {}",
            truncate(&text, 400)
        ));
    }
    serde_json::from_str(&text).with_context(|| "decoding revoke-token response".to_string())
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}
