use async_trait::async_trait;

use super::email_vo::Email;
use super::user_entity::{User, UserId};
use crate::shared::errors::AppError;

/// Write side. Returns the aggregate — never rows, never DTOs.
#[async_trait]
pub trait UserRepository: Send + Sync {
    async fn find_by_id(&self, id: UserId) -> Result<Option<User>, AppError>;

    /// Exists only for the uniqueness check on registration.
    async fn find_by_email(&self, email: &Email) -> Result<Option<User>, AppError>;

    /// Upsert.
    async fn save(&self, user: &User) -> Result<(), AppError>;

    async fn delete(&self, id: UserId) -> Result<(), AppError>;
}
