use std::fmt;
use std::hash::{Hash, Hasher};
use std::marker::PhantomData;

use uuid::Uuid;

use super::errors::AppError;

/// Identifier typed by the aggregate it belongs to: `Id<User>` and `Id<Video>`
/// are different types, so the compiler rejects a mix-up.
///
/// Generated in the domain, never by the database.
pub struct Id<T> {
    value: Uuid,
    // `fn() -> T` keeps `Id<T>` Copy + Send + Sync whatever `T` is.
    marker: PhantomData<fn() -> T>,
}

impl<T> Id<T> {
    pub fn generate() -> Self {
        Self::from_uuid(Uuid::new_v4())
    }

    /// For rehydration from a trusted source (the database).
    pub const fn from_uuid(value: Uuid) -> Self {
        Self {
            value,
            marker: PhantomData,
        }
    }

    /// For untrusted input (path parameters, request bodies).
    pub fn parse(raw: &str) -> Result<Self, AppError> {
        Uuid::parse_str(raw)
            .map(Self::from_uuid)
            .map_err(|_| AppError::invalid_id(raw))
    }

    pub const fn as_uuid(&self) -> Uuid {
        self.value
    }
}

// Implemented by hand: `#[derive]` would demand the same trait of `T`.

impl<T> Clone for Id<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T> Copy for Id<T> {}

impl<T> PartialEq for Id<T> {
    fn eq(&self, other: &Self) -> bool {
        self.value == other.value
    }
}

impl<T> Eq for Id<T> {}

impl<T> Hash for Id<T> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.value.hash(state);
    }
}

impl<T> fmt::Debug for Id<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Id({})", self.value)
    }
}

impl<T> fmt::Display for Id<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.value.fmt(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Thing;

    #[test]
    fn parse_round_trips_through_display() {
        let id = Id::<Thing>::generate();
        assert_eq!(Id::<Thing>::parse(&id.to_string()).unwrap(), id);
    }

    #[test]
    fn parse_rejects_garbage() {
        let err = Id::<Thing>::parse("not-a-uuid").unwrap_err();
        assert_eq!(err.code(), "INVALID_ID");
    }
}
