use async_trait::async_trait;
use chrono::{DateTime, Utc};
use domain::shared::errors::AppError;
use domain::shared::pagination::{PageInput, PageOutput};
use domain::user::{UserQueries, UserSummary};
use sqlx::PgPool;
use uuid::Uuid;

use crate::persistence::db_error::db_error;

pub struct PgUserQueries {
    pool: PgPool,
}

impl PgUserQueries {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[derive(sqlx::FromRow)]
struct UserSummaryRow {
    id: Uuid,
    email: String,
    is_suspended: bool,
    created_at: DateTime<Utc>,
}

impl From<UserSummaryRow> for UserSummary {
    fn from(row: UserSummaryRow) -> Self {
        Self {
            id: row.id.to_string(),
            email: row.email,
            is_suspended: row.is_suspended,
            created_at: row.created_at,
        }
    }
}

#[async_trait]
impl UserQueries for PgUserQueries {
    async fn list(&self, page: PageInput) -> Result<PageOutput<UserSummary>, AppError> {
        let rows = sqlx::query_as::<_, UserSummaryRow>(
            "SELECT id, email, is_suspended, created_at FROM users
             ORDER BY created_at, id
             LIMIT $1 OFFSET $2",
        )
        .bind(i64::from(page.page_size()))
        .bind(i64::try_from(page.offset()).map_err(AppError::unexpected)?)
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;

        let total = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users")
            .fetch_one(&self.pool)
            .await
            .map_err(db_error)?;

        Ok(PageOutput {
            items: rows.into_iter().map(UserSummary::from).collect(),
            page: page.page(),
            page_size: page.page_size(),
            total: u64::try_from(total).map_err(AppError::unexpected)?,
        })
    }
}
