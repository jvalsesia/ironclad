use axum::Json;
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use domain::shared::errors::{AppError, ErrorKind};
use serde::Serialize;

/// Central error mapper — the only place that knows about status codes.
///
/// Handlers return `Result<_, HttpError>` and use `?`. They never `match` on an
/// error to pick a status.
#[derive(Debug)]
pub enum HttpError {
    /// The request did not have the expected shape (malformed JSON, missing
    /// field, wrong type). Raised by the extractors in `extract.rs`.
    BadRequest(String),
    App(AppError),
}

impl From<AppError> for HttpError {
    fn from(err: AppError) -> Self {
        Self::App(err)
    }
}

impl From<JsonRejection> for HttpError {
    fn from(rejection: JsonRejection) -> Self {
        Self::BadRequest(rejection.body_text())
    }
}

impl From<QueryRejection> for HttpError {
    fn from(rejection: QueryRejection) -> Self {
        Self::BadRequest(rejection.body_text())
    }
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

const fn status_of(kind: ErrorKind) -> StatusCode {
    match kind {
        ErrorKind::Invalid => StatusCode::UNPROCESSABLE_ENTITY,
        ErrorKind::NotFound => StatusCode::NOT_FOUND,
        ErrorKind::Conflict => StatusCode::CONFLICT,
        ErrorKind::Unauthenticated => StatusCode::UNAUTHORIZED,
        ErrorKind::Forbidden => StatusCode::FORBIDDEN,
        ErrorKind::Unexpected => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        let (status, body) = match self {
            Self::BadRequest(message) => (
                StatusCode::BAD_REQUEST,
                ErrorBody {
                    code: "VALIDATION_ERROR",
                    message,
                },
            ),
            Self::App(err) => {
                if err.kind() == ErrorKind::Unexpected {
                    // Log the cause; never leak it to the caller.
                    tracing::error!(error = ?err, "unexpected error");
                }
                (
                    status_of(err.kind()),
                    ErrorBody {
                        code: err.code(),
                        message: err.message().to_owned(),
                    },
                )
            }
        };
        (status, Json(body)).into_response()
    }
}
