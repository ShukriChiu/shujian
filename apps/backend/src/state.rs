use std::sync::Arc;

use axum::extract::FromRef;
use sqlx::PgPool;

use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub cfg: Arc<Config>,
}

impl AppState {
    pub fn new(db: PgPool, cfg: Config) -> Self {
        Self {
            db,
            cfg: Arc::new(cfg),
        }
    }
}

// Lets handlers extract `State<PgPool>` directly without needing the
// rest of AppState — handy for liveness/readiness probes.
impl FromRef<AppState> for PgPool {
    fn from_ref(s: &AppState) -> Self {
        s.db.clone()
    }
}
