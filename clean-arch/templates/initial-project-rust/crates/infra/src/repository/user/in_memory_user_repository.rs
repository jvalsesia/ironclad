use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
use domain::shared::errors::AppError;
use domain::user::{Email, User, UserId, UserRepository};

/// Fake with the same observable behavior as the PostgreSQL implementation.
/// Part of the architecture, not test scaffolding: every repository has one.
#[derive(Default)]
pub struct InMemoryUserRepository {
    users: Mutex<HashMap<UserId, User>>,
}

impl InMemoryUserRepository {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every stored user, for the in-memory queries of the same feature.
    pub(crate) fn snapshot(&self) -> Vec<User> {
        self.lock().values().cloned().collect()
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<UserId, User>> {
        self.users.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[async_trait]
impl UserRepository for InMemoryUserRepository {
    async fn find_by_id(&self, id: UserId) -> Result<Option<User>, AppError> {
        Ok(self.lock().get(&id).cloned())
    }

    async fn find_by_email(&self, email: &Email) -> Result<Option<User>, AppError> {
        Ok(self
            .lock()
            .values()
            .find(|user| user.email() == email)
            .cloned())
    }

    async fn save(&self, user: &User) -> Result<(), AppError> {
        self.lock().insert(user.id(), user.clone());
        Ok(())
    }

    async fn delete(&self, id: UserId) -> Result<(), AppError> {
        self.lock().remove(&id);
        Ok(())
    }
}
