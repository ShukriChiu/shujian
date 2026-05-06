use anyhow::{Context, Result};
use sqlx::postgres::{PgPoolOptions, PgConnectOptions};
use sqlx::{ConnectOptions, PgPool};
use std::str::FromStr;
use std::time::Duration;

pub async fn connect(database_url: &str) -> Result<PgPool> {
    // Mute the default per-statement INFO traces — they're noisy in serverless
    // logs. Switch to TRACE manually when debugging slow queries.
    let opts = PgConnectOptions::from_str(database_url)
        .context("invalid DATABASE_URL")?
        .log_statements(tracing::log::LevelFilter::Debug);

    let pool = PgPoolOptions::new()
        .max_connections(env_pool_size())
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(opts)
        .await
        .context("failed to connect to Postgres")?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("migrations failed")?;

    Ok(pool)
}

fn env_pool_size() -> u32 {
    std::env::var("DB_POOL_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(10)
}
