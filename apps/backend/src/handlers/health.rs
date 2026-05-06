use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::error::AppResult;

pub async fn healthz() -> Json<Value> {
    Json(json!({ "ok": true, "service": "shujian-backend" }))
}

pub async fn readyz(State(db): State<PgPool>) -> AppResult<Json<Value>> {
    sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}
