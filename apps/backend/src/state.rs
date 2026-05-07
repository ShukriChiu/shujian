use std::sync::Arc;

use axum::extract::FromRef;
use sqlx::PgPool;

use crate::config::Config;
use crate::vault::KekProvider;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub cfg: Arc<Config>,
    pub kek: KekProvider,
}

impl AppState {
    pub fn new(db: PgPool, cfg: Config, kek: KekProvider) -> Self {
        Self {
            db,
            cfg: Arc::new(cfg),
            kek,
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

// Same for KekProvider — vault handlers can extract it directly.
impl FromRef<AppState> for KekProvider {
    fn from_ref(s: &AppState) -> Self {
        s.kek.clone()
    }
}
