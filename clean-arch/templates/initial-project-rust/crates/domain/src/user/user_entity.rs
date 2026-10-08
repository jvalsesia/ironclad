use chrono::{DateTime, Utc};

use super::email_vo::Email;
use super::errors::UserError;
use crate::shared::id::Id;

pub type UserId = Id<User>;

/// Aggregate root. Fields are private: the only ways in are `create` and
/// `restore`, and the only ways to change state are the domain methods below.
///
/// Deliberately not `Serialize` — entities never leave through the boundary.
#[derive(Debug, Clone)]
pub struct User {
    id: UserId,
    email: Email,
    is_suspended: bool,
    created_at: DateTime<Utc>,
}

impl User {
    /// A brand-new user. Applies the creation rules.
    pub fn create(email: Email) -> Self {
        Self {
            id: UserId::generate(),
            email,
            is_suspended: false,
            created_at: Utc::now(),
        }
    }

    /// Rehydrates persisted state. Runs no creation rules.
    pub fn restore(
        id: UserId,
        email: Email,
        is_suspended: bool,
        created_at: DateTime<Utc>,
    ) -> Self {
        Self {
            id,
            email,
            is_suspended,
            created_at,
        }
    }

    pub fn suspend(&mut self) -> Result<(), UserError> {
        if self.is_suspended {
            return Err(UserError::AlreadySuspended(self.id.to_string()));
        }
        self.is_suspended = true;
        Ok(())
    }

    pub const fn id(&self) -> UserId {
        self.id
    }

    pub const fn email(&self) -> &Email {
        &self.email
    }

    pub const fn is_suspended(&self) -> bool {
        self.is_suspended
    }

    pub const fn created_at(&self) -> DateTime<Utc> {
        self.created_at
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ada() -> User {
        User::create(Email::create("ada@example.com").unwrap())
    }

    #[test]
    fn a_new_user_is_active() {
        assert!(!ada().is_suspended());
    }

    #[test]
    fn suspending_twice_is_rejected() {
        let mut user = ada();
        user.suspend().unwrap();
        assert!(matches!(
            user.suspend(),
            Err(UserError::AlreadySuspended(_))
        ));
    }
}
