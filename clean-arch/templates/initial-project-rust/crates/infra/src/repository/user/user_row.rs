use chrono::{DateTime, Utc};
use domain::user::{Email, User, UserId};
use uuid::Uuid;

/// Persistence shape of a user. The mapping to and from the entity lives here
/// and nowhere else.
#[derive(Debug, sqlx::FromRow)]
pub(crate) struct UserRow {
    id: Uuid,
    email: String,
    is_suspended: bool,
    created_at: DateTime<Utc>,
}

impl From<UserRow> for User {
    fn from(row: UserRow) -> Self {
        Self::restore(
            UserId::from_uuid(row.id),
            Email::from_trusted(row.email),
            row.is_suspended,
            row.created_at,
        )
    }
}
