use std::sync::Arc;

use async_trait::async_trait;
use domain::shared::errors::AppError;
use domain::shared::pagination::{PageInput, PageOutput};
use domain::user::{User, UserQueries, UserSummary};

use crate::repository::user::in_memory_user_repository::InMemoryUserRepository;

/// Reads the same store the in-memory repository writes to.
pub struct InMemoryUserQueries {
    repo: Arc<InMemoryUserRepository>,
}

impl InMemoryUserQueries {
    pub fn new(repo: Arc<InMemoryUserRepository>) -> Self {
        Self { repo }
    }
}

fn to_summary(user: User) -> UserSummary {
    UserSummary {
        id: user.id().to_string(),
        email: user.email().as_str().to_owned(),
        is_suspended: user.is_suspended(),
        created_at: user.created_at(),
    }
}

#[async_trait]
impl UserQueries for InMemoryUserQueries {
    async fn list(&self, page: PageInput) -> Result<PageOutput<UserSummary>, AppError> {
        let mut users = self.repo.snapshot();
        users.sort_by_key(|user| (user.created_at(), user.id().as_uuid()));

        let total = users.len() as u64;
        let offset = usize::try_from(page.offset()).map_err(AppError::unexpected)?;
        let items = users
            .into_iter()
            .skip(offset)
            .take(page.page_size() as usize)
            .map(to_summary)
            .collect();

        Ok(PageOutput {
            items,
            page: page.page(),
            page_size: page.page_size(),
            total,
        })
    }
}
