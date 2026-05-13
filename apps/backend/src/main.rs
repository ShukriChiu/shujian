use std::time::Duration;

use anyhow::Result;
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE};
use axum::http::{HeaderName, HeaderValue, Method};
use axum::routing::{delete, get, post};
use axum::Router;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer};
use tower_http::LatencyUnit;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

mod auth;
mod config;
mod db;
mod error;
mod handlers;
mod middleware;
mod models;
mod seed;
mod state;
mod vault;

use crate::config::Config;
use crate::state::AppState;
use crate::vault::KekProvider;

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    let cfg = Config::from_env()?;
    tracing::info!(addr = %cfg.bind_addr, "shujian-backend booting");

    let db = db::connect(&cfg.database_url).await?;
    seed::ensure_seed(&db, &cfg).await?;

    let kek = KekProvider::new(db.clone())?;
    let state = AppState::new(db, cfg.clone(), kek);

    let app = build_router(state, &cfg);

    let listener = tokio::net::TcpListener::bind(&cfg.bind_addr).await?;
    tracing::info!(addr = %cfg.bind_addr, "listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

fn build_router(state: AppState, cfg: &Config) -> Router {
    let cors = build_cors(cfg);
    let trace = TraceLayer::new_for_http()
        .make_span_with(DefaultMakeSpan::new().include_headers(false))
        .on_response(
            DefaultOnResponse::new()
                .include_headers(false)
                .latency_unit(LatencyUnit::Millis),
        );

    Router::new()
        .route("/healthz", get(handlers::health::healthz))
        .route("/readyz", get(handlers::health::readyz))
        .nest("/v1/auth", auth_routes())
        .nest("/v1/tenants", tenant_routes())
        .nest("/v1/vault", vault_routes())
        .nest("/v1/personas", persona_routes())
        .nest("/v1/future", future_routes())
        .with_state(state)
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(trace)
        .layer(cors)
}

fn auth_routes() -> Router<AppState> {
    Router::new()
        .route("/login", post(handlers::auth::login))
        .route("/logout", post(handlers::auth::logout))
        .route("/me", get(handlers::auth::me))
        .route("/switch-tenant", post(handlers::auth::switch_tenant))
}

fn tenant_routes() -> Router<AppState> {
    Router::new()
        .route("/", get(handlers::tenants::list_tenants).post(handlers::tenants::create_tenant))
        .route(
            "/{tenant_id}/members",
            get(handlers::tenants::list_members).post(handlers::tenants::add_member),
        )
        // placeholder for future remove-member route — keeps the verb wired up
        .route("/{tenant_id}/members/{user_id}", delete(remove_member_stub))
}

async fn remove_member_stub() -> error::AppResult<()> {
    Err(error::AppError::bad_request("not implemented yet"))
}

fn vault_routes() -> Router<AppState> {
    use vault::handlers as v;
    Router::new()
        // Secrets are write-only over HTTP — list / get returns metadata only,
        // delete returns the freed name. The plaintext value never leaves
        // the backend except via the persona launch flow.
        .route("/secrets", post(v::upsert_secret).get(v::list_secrets))
        .route(
            "/secrets/{name}",
            get(v::get_secret_metadata).delete(v::delete_secret),
        )
        .route(
            "/operator-refs",
            post(v::create_operator_ref).get(v::list_operator_refs),
        )
        .route("/operator-refs/{id}", delete(v::delete_operator_ref))
        .route("/scopes", post(v::upsert_scope).get(v::list_scopes))
        .route("/scopes/{name}", delete(v::delete_scope))
        // Per-user "named bag of envVars" — see migration 0004 / handlers
        // §"Agent vaults". Owned by the calling user inside the active
        // tenant; no admin role required.
        .route(
            "/agent-vaults",
            post(v::upsert_agent_vault).get(v::list_agent_vaults),
        )
        .route(
            "/agent-vaults/{id}",
            get(v::get_agent_vault).delete(v::delete_agent_vault),
        )
        .route("/_admin/kek", get(v::kek_status))
}

fn persona_routes() -> Router<AppState> {
    use vault::handlers as v;
    Router::new()
        .route("/", post(v::upsert_persona).get(v::list_personas))
        // Audit log of every issuance. Tenant-scoped; supports
        // ?persona_slug=... and ?limit=N (default 100, max 500).
        .route("/issuances", get(v::list_issuances))
        // Manual revoke: the dashboard's "stop this run" button. Calls
        // onion to invalidate every JWT minted under this issuance, then
        // marks the row revoked_at = now().
        .route("/issuances/{id}/revoke", post(v::revoke_issuance))
        // After the dashboard launches a Cursor agent with the env we
        // issued, it comes back here to record the agent_id/run_id so
        // the audit log links audit ↔ run.
        .route(
            "/issuances/{id}/record-launch",
            post(v::record_launch),
        )
        // Per-persona endpoints. Note the order: /:slug must come AFTER
        // the literal "issuances" routes above — axum matches in order
        // and "issuances" would otherwise be interpreted as a slug.
        .route("/{slug}", get(v::get_persona).delete(v::delete_persona))
        // Preview shows what env vars *would* be issued, with values
        // masked by default. ?reveal=true mints real JWTs and returns
        // plaintext — used by the wizard's final-confirm step.
        .route("/{slug}/preview-env", get(v::preview_persona_env))
        // The launch endpoint: resolves all scopes, decrypts secrets,
        // mints onion JWTs, writes the audit row, returns the env to
        // hand off to cursor-bridge.
        .route("/{slug}/issue", post(v::issue_persona))
}

/// Routes for `apps/future` — the AI 学生实战人才池管理台.
///
/// V1 ships a single composite state endpoint (`GET`/`PUT /v1/future/state`).
/// Tables are namespaced with `future_*` so this app stays cleanly isolated
/// from the rest of the backend.
///
/// When per-entity mutations become useful (collaborative editing, large
/// payloads, fine-grained audit), promote `handlers/future.rs` into
/// `handlers/future/{students,projects,squads,feedback}.rs` and add routes
/// here. Existing `state` endpoint stays for read convenience.
fn future_routes() -> Router<AppState> {
    Router::new().route(
        "/state",
        get(handlers::future::get_state).put(handlers::future::put_state),
    )
}

fn build_cors(cfg: &Config) -> CorsLayer {
    let layer = CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        // x-tenant-id: superusers / multi-tenant clients pin a tenant per
        // request. Without it in the allow list, the browser preflight
        // strips the header and the dashboard sees "Failed to fetch".
        .allow_headers([
            AUTHORIZATION,
            CONTENT_TYPE,
            HeaderName::from_static("x-tenant-id"),
        ])
        .max_age(Duration::from_secs(60 * 30));

    if cfg
        .cors_allow_origins
        .iter()
        .any(|o| o == "*")
    {
        layer.allow_origin(AllowOrigin::any())
    } else {
        let origins: Vec<HeaderValue> = cfg
            .cors_allow_origins
            .iter()
            .filter_map(|s| HeaderValue::from_str(s).ok())
            .collect();
        layer.allow_origin(origins).allow_credentials(true)
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,sqlx::query=warn"));
    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_target(false))
        .init();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
