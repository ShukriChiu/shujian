use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("invalid input: {0}")]
    BadRequest(String),

    #[error("authentication required")]
    Unauthorized,

    #[error("forbidden")]
    Forbidden,

    #[error("not found")]
    #[allow(dead_code)] // wired up; first endpoint that returns it lands later
    NotFound,

    #[error("conflict: {0}")]
    Conflict(String),

    #[error("internal error")]
    Internal(#[from] anyhow::Error),

    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),

    #[error("password hash error: {0}")]
    Hash(String),
}

impl AppError {
    pub fn bad_request(s: impl Into<String>) -> Self {
        Self::BadRequest(s.into())
    }

    pub fn conflict(s: impl Into<String>) -> Self {
        Self::Conflict(s.into())
    }
}

impl From<argon2::password_hash::Error> for AppError {
    fn from(err: argon2::password_hash::Error) -> Self {
        AppError::Hash(err.to_string())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message): (StatusCode, &'static str, String) = match &self {
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, "bad_request", m.clone()),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized", self.to_string()),
            AppError::Forbidden    => (StatusCode::FORBIDDEN,    "forbidden",    self.to_string()),
            AppError::NotFound     => (StatusCode::NOT_FOUND,    "not_found",    self.to_string()),
            AppError::Conflict(m)  => (StatusCode::CONFLICT,     "conflict",     m.clone()),
            AppError::Internal(e)  => {
                tracing::error!(error = ?e, "internal error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal", "internal error".into())
            }
            AppError::Db(e) => {
                tracing::error!(error = ?e, "db error");
                (StatusCode::INTERNAL_SERVER_ERROR, "db_error", "database error".into())
            }
            AppError::Hash(m) => {
                tracing::error!(error = %m, "hash error");
                (StatusCode::INTERNAL_SERVER_ERROR, "hash_error", "internal error".into())
            }
        };
        let body = Json(json!({
            "error": code,
            "message": message,
        }));
        (status, body).into_response()
    }
}

pub type AppResult<T> = std::result::Result<T, AppError>;
