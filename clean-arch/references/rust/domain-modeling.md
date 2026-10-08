# Rust — domain modeling

Entities, value objects, IDs and errors in the `domain` crate. Every snippet is taken from `templates/initial-project-rust/crates/domain/`, which compiles and passes the gates.

---

## 1. Entities

### Required shape

- A `struct` whose fields are **all private**. That is the private constructor: nobody outside the module can write `User { .. }`.
- `pub fn create(..)` — a brand-new instance. Applies creation rules, generates the ID.
- `pub fn restore(..)` — rehydrates persisted state. Runs **no** creation rules.
- Mutations are `&mut self` methods named after the business operation (`suspend`, `rename`) returning `Result<(), FeatureError>`.
- Read-only getters. No `set_*`, ever.
- Derives `Debug, Clone` at most. **Never** `Serialize` / `Deserialize` (rule 17).

### Full example

```rust
// crates/domain/src/user/user_entity.rs
use chrono::{DateTime, Utc};

use super::email_vo::Email;
use super::errors::UserError;
use crate::shared::id::Id;

pub type UserId = Id<User>;

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
        Self { id, email, is_suspended, created_at }
    }

    pub fn suspend(&mut self) -> Result<(), UserError> {
        if self.is_suspended {
            return Err(UserError::AlreadySuspended(self.id.to_string()));
        }
        self.is_suspended = true;
        Ok(())
    }

    pub const fn id(&self) -> UserId { self.id }
    pub const fn email(&self) -> &Email { &self.email }
    pub const fn is_suspended(&self) -> bool { self.is_suspended }
    pub const fn created_at(&self) -> DateTime<Utc> { self.created_at }
}
```

### `create` takes value objects, not raw strings

`User::create(email: Email)`, not `User::create(email: &str)`. The caller builds the VO first, which is where validation happens, and the use case usually needs that VO anyway (for the uniqueness check). `create` returns `Self` when nothing else can fail and `Result<Self, FeatureError>` when the entity has creation rules of its own.

When `restore` grows past six or seven parameters, pass one `pub struct FeatureSnapshot { pub … }` declared in the same file instead.

### Why entities are not `Serialize`

In TypeScript the entity has a `toJSON()` that throws. In Rust the same guarantee is free: without the derive, `Json(user)` does not compile. The only way out is an Output DTO built in the use case (`impl From<&User> for CreateUserOutput`).

---

## 2. Value objects

### Required shape

- Private field (a tuple struct with a private field is the usual form).
- `pub fn create(raw) -> Result<Self, FeatureError>` — validates and normalizes.
- `pub fn from_trusted(value) -> Self` — skips validation; only for rehydration from the database.
- An accessor (`as_str`, `value`).
- `#[derive(Debug, Clone, PartialEq, Eq)]` — `PartialEq` is the `equals` of rule 7.
- **Never** `Deserialize`: it would build the value without going through `create`.

```rust
// crates/domain/src/user/email_vo.rs
use super::errors::UserError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Email(String);

impl Email {
    pub fn create(raw: &str) -> Result<Self, UserError> {
        let value = raw.trim().to_lowercase();
        if !Self::is_valid(&value) {
            return Err(UserError::InvalidEmail(raw.to_owned()));
        }
        Ok(Self(value))
    }

    /// Skips validation. Only for rehydration from a trusted source (the database).
    pub fn from_trusted(value: String) -> Self {
        Self(value)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn is_valid(value: &str) -> bool { /* … */ }
}
```

Hand-rolled checks are fine for trivial rules. For anything richer, use a validation crate inside `create` (`validator`, `garde`, `email_address`) — the domain owns the rule regardless of who checks it.

---

## 3. IDs

One generic type in `shared/id.rs`, typed by the aggregate it identifies:

```rust
// crates/domain/src/shared/id.rs
pub struct Id<T> {
    value: Uuid,
    // `fn() -> T` keeps `Id<T>` Copy + Send + Sync whatever `T` is.
    marker: PhantomData<fn() -> T>,
}

impl<T> Id<T> {
    pub fn generate() -> Self { /* Uuid::new_v4() */ }
    /// For rehydration from a trusted source (the database).
    pub const fn from_uuid(value: Uuid) -> Self { /* … */ }
    /// For untrusted input (path parameters, request bodies).
    pub fn parse(raw: &str) -> Result<Self, AppError> { /* INVALID_ID on failure */ }
    pub const fn as_uuid(&self) -> Uuid { /* … */ }
}
```

Each feature declares an alias next to its entity:

```rust
pub type UserId = Id<User>;
```

`Id<User>` and `Id<Video>` are different types, so passing a video ID where a user ID is expected is a compile error. `Clone`, `Copy`, `PartialEq`, `Eq`, `Hash`, `Debug` and `Display` are implemented by hand in `id.rs`, because `#[derive]` would demand the same traits of `T`.

IDs are generated in the domain (`Id::generate()`), never by the database.

---

## 4. Errors

### One type crosses layers: `AppError`

```rust
// crates/domain/src/shared/errors.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    Invalid,          // an invariant of a single aggregate was violated
    NotFound,
    Conflict,         // the request conflicts with current state
    Unauthenticated,
    Forbidden,
    Unexpected,       // infrastructure failure — never shown to the caller
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    kind: ErrorKind,
    code: &'static str,
    message: String,
    #[source]
    source: Option<Box<dyn Error + Send + Sync>>,
}
```

`ErrorKind` plays the role of the abstract error classes on the TypeScript side (`DomainError`, `NotFoundError`, `ConflictError`). `AppError` knows nothing about HTTP: the status code is chosen in exactly one place, `infra/http/error.rs`.

Constructors: `AppError::new(kind, code, message)`, `AppError::unexpected(source)`, `AppError::unauthenticated()`, `AppError::forbidden(message)`, `AppError::invalid_id(raw)`.

### One enum per feature

```rust
// crates/domain/src/user/errors.rs
#[derive(Debug, Error)]
pub enum UserError {
    #[error("Invalid email: \"{0}\"")]
    InvalidEmail(String),
    #[error("User {0} not found")]
    NotFound(String),
    #[error("Email \"{0}\" is already registered")]
    EmailTaken(String),
    #[error("User {0} is already suspended")]
    AlreadySuspended(String),
}

impl From<UserError> for AppError {
    fn from(err: UserError) -> Self {
        let (kind, code) = match &err {
            UserError::InvalidEmail(_) => (ErrorKind::Invalid, "INVALID_EMAIL"),
            UserError::NotFound(_) => (ErrorKind::NotFound, "USER_NOT_FOUND"),
            UserError::EmailTaken(_) => (ErrorKind::Conflict, "USER_EMAIL_TAKEN"),
            UserError::AlreadySuspended(_) => (ErrorKind::Conflict, "USER_ALREADY_SUSPENDED"),
        };
        Self::new(kind, code, err.to_string())
    }
}
```

That `From` impl is the whole integration. Entities and VOs return `Result<_, UserError>`; use cases and ports return `Result<_, AppError>`; `?` converts between them.

### Who returns what

| Situation                         | Where                         | Returns                                                     |
|-----------------------------------|-------------------------------|-------------------------------------------------------------|
| Email format invalid              | `Email::create`               | `Err(UserError::InvalidEmail)`                              |
| Cannot suspend twice              | `User::suspend`               | `Err(UserError::AlreadySuspended)`                          |
| User not found                    | use case, after `find_by_id` returned `None` | `Err(UserError::NotFound(..).into())`        |
| Email already taken               | use case, after `find_by_email` returned `Some` | `Err(UserError::EmailTaken(..).into())`   |
| Actor may not do this             | use case                      | `Err(AppError::forbidden(..))`                              |
| Database or network failure       | `infra`                       | `Err(AppError::unexpected(source))`                         |

A repository **never** returns `NotFound`: a missing row is `Ok(None)`, and the use case decides whether that is an error.

### No panics

`unwrap()`, `expect()`, `todo!()` and `dbg!()` are denied by the workspace lints outside tests. A failure is a `Result`.

---

## 5. What `domain` may and may not depend on

**May:** `thiserror`, `uuid`, `chrono` (or `time`), `async-trait`, validation crates, numeric crates (`rust_decimal`).

**May, narrowly:** `serde` — `Serialize` on read models in `<feature>_queries.rs` and on `shared/pagination.rs`, because those are already shaped for the consumer. Never on an entity or a value object.

**Must not:** any I/O crate (`sqlx`, `axum`, `reqwest`, `tokio`, …), `std::fs`, `std::net`, `std::process`, `std::env`, and of course `usecase` or `infra`. No `#[derive(sqlx::FromRow)]` on a domain type — that derive belongs on the row struct in `infra`.

---

## 6. Common pitfalls

- **`pub` fields "just for now".** They make every invariant optional. Add a getter.
- **`impl Default for Entity`.** A default entity is an entity that skipped `create`.
- **`From<String> for Email`.** An infallible conversion is a validation bypass. Only `create` and `from_trusted` build a VO.
- **Calling `create` in the row mapping.** Rehydration uses `restore` and `from_trusted`: data already in the database is not re-validated, and must not get a new ID or timestamp.
- **A `NotFound` variant returned from the repository.** Return `Ok(None)`.
- **One giant `DomainError` enum for the whole system.** One enum per feature, in that feature's `errors.rs`.

---

## Cross-references

- `workspace-layout.md` — where these files live, naming.
- `use-cases-and-ports.md` — how use cases consume entities and return DTOs.
- `../domain-modeling.md` — aggregates and the modeling heuristics, which are language-independent.
