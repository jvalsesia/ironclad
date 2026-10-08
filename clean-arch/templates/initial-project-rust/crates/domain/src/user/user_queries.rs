use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::shared::errors::AppError;
use crate::shared::pagination::{PageInput, PageOutput};

/// Read model: shaped for the consumer, built straight from the store.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSummary {
    pub id: String,
    pub email: String,
    pub is_suspended: bool,
    pub created_at: DateTime<Utc>,
}

/// Read side. Returns read models directly — no entity is rehydrated.
#[async_trait]
pub trait UserQueries: Send + Sync {
    async fn list(&self, page: PageInput) -> Result<PageOutput<UserSummary>, AppError>;
}
