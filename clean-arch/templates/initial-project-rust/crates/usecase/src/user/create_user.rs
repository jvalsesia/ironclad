use std::sync::Arc;

use chrono::{DateTime, Utc};
use domain::shared::errors::AppError;
use domain::user::{Email, User, UserError, UserRepository};
use serde::Serialize;

#[derive(Debug)]
pub struct CreateUserInput {
    pub email: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUserOutput {
    pub id: String,
    pub email: String,
    pub created_at: DateTime<Utc>,
}

/// The only path from the entity to the boundary.
impl From<&User> for CreateUserOutput {
    fn from(user: &User) -> Self {
        Self {
            id: user.id().to_string(),
            email: user.email().as_str().to_owned(),
            created_at: user.created_at(),
        }
    }
}

pub struct CreateUserUseCase {
    user_repo: Arc<dyn UserRepository>,
}

impl CreateUserUseCase {
    pub fn new(user_repo: Arc<dyn UserRepository>) -> Self {
        Self { user_repo }
    }

    pub async fn execute(&self, input: CreateUserInput) -> Result<CreateUserOutput, AppError> {
        let email = Email::create(&input.email)?;

        // Inter-aggregate rule: needs queried state, so it lives here.
        if self.user_repo.find_by_email(&email).await?.is_some() {
            return Err(UserError::EmailTaken(email.as_str().to_owned()).into());
        }

        let user = User::create(email);
        self.user_repo.save(&user).await?;

        Ok(CreateUserOutput::from(&user))
    }
}

#[cfg(test)]
mod tests {
    use domain::shared::errors::ErrorKind;
    use infra::repository::user::in_memory_user_repository::InMemoryUserRepository;

    use super::*;

    fn use_case() -> CreateUserUseCase {
        CreateUserUseCase::new(Arc::new(InMemoryUserRepository::new()))
    }

    fn input(email: &str) -> CreateUserInput {
        CreateUserInput {
            email: email.to_owned(),
        }
    }

    #[tokio::test]
    async fn creates_a_user() {
        let output = use_case().execute(input("Ada@Example.com")).await.unwrap();
        assert_eq!(output.email, "ada@example.com");
    }

    #[tokio::test]
    async fn rejects_a_taken_email() {
        let use_case = use_case();
        use_case.execute(input("ada@example.com")).await.unwrap();

        let err = use_case
            .execute(input("ada@example.com"))
            .await
            .unwrap_err();

        assert_eq!(err.kind(), ErrorKind::Conflict);
        assert_eq!(err.code(), "USER_EMAIL_TAKEN");
    }

    #[tokio::test]
    async fn rejects_an_invalid_email() {
        let err = use_case().execute(input("nope")).await.unwrap_err();
        assert_eq!(err.kind(), ErrorKind::Invalid);
    }
}
