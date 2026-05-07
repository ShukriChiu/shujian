use std::time::Duration;

use anyhow::Result;
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE};
use axum::http::{HeaderValue, Method};
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
        .route("/_admin/kek", get(v::kek_status))
}

fn persona_routes() -> Router<AppState> {
    use vault::handlers as v;
    Router::new()
        .route("/", post(v::upsert_persona).get(v::list_personas))
        .route("/{slug}", delete(v::delete_persona))
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
        .allow_headers([AUTHORIZATION, CONTENT_TYPE])
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
