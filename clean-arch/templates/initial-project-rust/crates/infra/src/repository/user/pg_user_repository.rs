use async_trait::async_trait;
use domain::shared::errors::AppError;
use domain::user::{Email, User, UserId, UserRepository};
use sqlx::PgPool;

use super::user_row::UserRow;
use crate::persistence::db_error::db_error;

pub struct PgUserRepository {
    pool: PgPool,
}

impl PgUserRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl UserRepository for PgUserRepository {
    async fn find_by_id(&self, id: UserId) -> Result<Option<User>, AppError> {
        let row = sqlx::query_as::<_, UserRow>(
            "SELECT id, email, is_suspended, created_at FROM users WHERE id = $1",
        )
        .bind(id.as_uuid())
        .fetch_optional(&self.pool)
        .await
        .map_err(db_error)?;

        Ok(row.map(User::from))
    }

    async fn find_by_email(&self, email: &Email) -> Result<Option<User>, AppError> {
        let row = sqlx::query_as::<_, UserRow>(
            "SELECT id, email, is_suspended, created_at FROM users WHERE email = $1",
        )
        .bind(email.as_str())
        .fetch_optional(&self.pool)
        .await
        .map_err(db_error)?;

        Ok(row.map(User::from))
    }

    async fn save(&self, user: &User) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO users (id, email, is_suspended, created_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (id) DO UPDATE
             SET email = EXCLUDED.email, is_suspended = EXCLUDED.is_suspended",
        )
        .bind(user.id().as_uuid())
        .bind(user.email().as_str())
        .bind(user.is_suspended())
        .bind(user.created_at())
        .execute(&self.pool)
        .await
        .map_err(db_error)?;

        Ok(())
    }

    async fn delete(&self, id: UserId) -> Result<(), AppError> {
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(id.as_uuid())
            .execute(&self.pool)
            .await
            .map_err(db_error)?;

        Ok(())
    }
}
