use std::sync::Arc;

use domain::shared::errors::AppError;
use domain::user::{User, UserError, UserId, UserRepository};
use serde::Serialize;

#[derive(Debug)]
pub struct SuspendUserInput {
    /// The authenticated caller, passed in by the handler.
    pub actor_id: String,
    pub user_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuspendUserOutput {
    pub id: String,
    pub is_suspended: bool,
}

impl From<&User> for SuspendUserOutput {
    fn from(user: &User) -> Self {
        Self {
            id: user.id().to_string(),
            is_suspended: user.is_suspended(),
        }
    }
}

pub struct SuspendUserUseCase {
    user_repo: Arc<dyn UserRepository>,
}

impl SuspendUserUseCase {
    pub fn new(user_repo: Arc<dyn UserRepository>) -> Self {
        Self { user_repo }
    }

    pub async fn execute(&self, input: SuspendUserInput) -> Result<SuspendUserOutput, AppError> {
        let actor_id = UserId::parse(&input.actor_id)?;
        let user_id = UserId::parse(&input.user_id)?;

        // Authorization depends on domain state, so it lives in the use case.
        if actor_id == user_id {
            return Err(AppError::forbidden("You cannot suspend your own account"));
        }

        let mut user = self
            .user_repo
            .find_by_id(user_id)
            .await?
            .ok_or_else(|| UserError::NotFound(input.user_id.clone()))?;

        // The invariant ("not already suspended") is the entity's business.
        user.suspend()?;
        self.user_repo.save(&user).await?;

        Ok(SuspendUserOutput::from(&user))
    }
}

#[cfg(test)]
mod tests {
    use domain::shared::errors::ErrorKind;
    use domain::user::Email;
    use infra::repository::user::in_memory_user_repository::InMemoryUserRepository;

    use super::*;

    async fn seeded() -> (SuspendUserUseCase, User) {
        let repo = Arc::new(InMemoryUserRepository::new());
        let user = User::create(Email::create("ada@example.com").unwrap());
        repo.save(&user).await.unwrap();
        (SuspendUserUseCase::new(repo), user)
    }

    fn input(actor_id: String, user: &User) -> SuspendUserInput {
        SuspendUserInput {
            actor_id,
            user_id: user.id().to_string(),
        }
    }

    #[tokio::test]
    async fn suspends_another_user() {
        let (use_case, user) = seeded().await;
        let actor_id = UserId::generate().to_string();

        let output = use_case.execute(input(actor_id, &user)).await.unwrap();

        assert!(output.is_suspended);
    }

    #[tokio::test]
    async fn forbids_suspending_yourself() {
        let (use_case, user) = seeded().await;

        let err = use_case
            .execute(input(user.id().to_string(), &user))
            .await
            .unwrap_err();

        assert_eq!(err.kind(), ErrorKind::Forbidden);
    }

    #[tokio::test]
    async fn reports_an_unknown_user() {
        let (use_case, _) = seeded().await;

        let err = use_case
            .execute(SuspendUserInput {
                actor_id: UserId::generate().to_string(),
                user_id: UserId::generate().to_string(),
            })
            .await
            .unwrap_err();

        assert_eq!(err.kind(), ErrorKind::NotFound);
    }
}
