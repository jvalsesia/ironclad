use thiserror::Error;

use crate::shared::errors::{AppError, ErrorKind};

#[derive(Debug, Error)]
pub enum UserError {
    #[error("Invalid email: \"{0}\"")]
    InvalidEmail(String),
    #[error("User {0} not found")]
    NotFound(String),
    #[error("Email \"{0}\" is already registered")]
    EmailTaken(String),
    #[error("User {0} is already suspended")]
    AlreadySuspended(String),
}

impl From<UserError> for AppError {
    fn from(err: UserError) -> Self {
        let (kind, code) = match &err {
            UserError::InvalidEmail(_) => (ErrorKind::Invalid, "INVALID_EMAIL"),
            UserError::NotFound(_) => (ErrorKind::NotFound, "USER_NOT_FOUND"),
            UserError::EmailTaken(_) => (ErrorKind::Conflict, "USER_EMAIL_TAKEN"),
            UserError::AlreadySuspended(_) => (ErrorKind::Conflict, "USER_ALREADY_SUSPENDED"),
        };
        Self::new(kind, code, err.to_string())
    }
}
