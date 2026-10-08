use std::sync::Arc;

use domain::shared::errors::AppError;
use domain::shared::pagination::{PageInput, PageOutput};
use domain::user::{UserQueries, UserSummary};

#[derive(Debug)]
pub struct ListUsersInput {
    pub page: PageInput,
}

pub type ListUsersOutput = PageOutput<UserSummary>;

/// Read side: goes through `UserQueries`, never through the repository.
pub struct ListUsersUseCase {
    user_queries: Arc<dyn UserQueries>,
}

impl ListUsersUseCase {
    pub fn new(user_queries: Arc<dyn UserQueries>) -> Self {
        Self { user_queries }
    }

    pub async fn execute(&self, input: ListUsersInput) -> Result<ListUsersOutput, AppError> {
        self.user_queries.list(input.page).await
    }
}

#[cfg(test)]
mod tests {
    use domain::user::{Email, User, UserRepository};
    use infra::queries::user::in_memory_user_queries::InMemoryUserQueries;
    use infra::repository::user::in_memory_user_repository::InMemoryUserRepository;

    use super::*;

    #[tokio::test]
    async fn returns_one_page() {
        let repo = Arc::new(InMemoryUserRepository::new());
        for name in ["ada", "grace", "linus"] {
            let email = Email::create(&format!("{name}@example.com")).unwrap();
            repo.save(&User::create(email)).await.unwrap();
        }
        let use_case = ListUsersUseCase::new(Arc::new(InMemoryUserQueries::new(repo)));

        let output = use_case
            .execute(ListUsersInput {
                page: PageInput::new(1, 2),
            })
            .await
            .unwrap();

        assert_eq!((output.items.len(), output.total), (2, 3));
    }
}
