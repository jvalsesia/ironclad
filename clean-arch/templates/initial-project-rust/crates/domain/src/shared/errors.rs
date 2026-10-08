use std::error::Error;

/// Category of a failure. The HTTP layer maps each kind to one status code;
/// nothing else in the system knows about status codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// An invariant of a single aggregate was violated.
    Invalid,
    NotFound,
    /// The request conflicts with current state.
    Conflict,
    Unauthenticated,
    Forbidden,
    /// Infrastructure failure. Never shown to the caller.
    Unexpected,
}

/// The one error type that crosses layer boundaries.
///
/// Features declare their own error enum in `domain/<feature>/errors.rs` and
/// convert it with `impl From<FeatureError> for AppError`, so `?` does the rest.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    kind: ErrorKind,
    code: &'static str,
    message: String,
    #[source]
    source: Option<Box<dyn Error + Send + Sync>>,
}

impl AppError {
    pub fn new(kind: ErrorKind, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            code,
            message: message.into(),
            source: None,
        }
    }

    /// Wraps an infrastructure failure, keeping the original as `source()`.
    pub fn unexpected(source: impl Into<Box<dyn Error + Send + Sync>>) -> Self {
        Self {
            kind: ErrorKind::Unexpected,
            code: "INTERNAL_ERROR",
            message: "Unexpected error".to_owned(),
            source: Some(source.into()),
        }
    }

    pub fn unauthenticated() -> Self {
        Self::new(
            ErrorKind::Unauthenticated,
            "UNAUTHENTICATED",
            "Authentication required",
        )
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Forbidden, "FORBIDDEN", message)
    }

    pub fn invalid_id(raw: &str) -> Self {
        Self::new(
            ErrorKind::Invalid,
            "INVALID_ID",
            format!("Invalid id: \"{raw}\""),
        )
    }

    pub const fn kind(&self) -> ErrorKind {
        self.kind
    }

    pub const fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}
