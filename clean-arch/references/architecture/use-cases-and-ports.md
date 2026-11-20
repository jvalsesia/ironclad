# Rust — use cases and ports

The `usecase` crate, and the traits in `domain` that use cases depend on. Snippets come from `templates/initial-project-rust/`.

---

## 1. Use case shape

One file per use case: `usecase/<feature>/<action>_<feature>.rs`. It contains, in this order:

1. `<Action><Feature>Input` — a plain struct.
2. `<Action><Feature>Output` — a struct deriving `Serialize`, plus `impl From<&Entity>`.
3. `<Action><Feature>UseCase` — a struct holding its ports as `Arc<dyn Trait>`.
4. `impl`: `pub fn new(..)` and `pub async fn execute(&self, input) -> Result<Output, AppError>`. **No other public method.**
5. `#[cfg(test)] mod tests`.

### Full example

```rust
// crates/usecase/src/user/create_user.rs
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
```

### Order inside `execute`

1. Build value objects and parse IDs from the input (`Email::create`, `UserId::parse`).
2. Authorization that depends on domain state.
3. Load what is needed through the ports.
4. Rules that need queried state (uniqueness, existence).
5. Call the entity method — the invariant lives there.
6. Persist.
7. Map to the Output.

---

## 2. DTOs

- **Input is a plain struct.** No `Deserialize`: the wire shape belongs to the handler, which builds the Input by hand (rule 16). Fields are primitives and `PageInput` — not entities, not VOs.
- **Output derives `Serialize`** with `#[serde(rename_all = "camelCase")]` and goes straight into `Json(output)`. IDs are `String`.
- **`impl From<&Entity> for Output`** is the only path from an entity to the outside (rule 17).
- When a read-side use case returns a read model unchanged, alias it: `pub type ListUsersOutput = PageOutput<UserSummary>;`.

---

## 3. Dependencies: `Arc<dyn Trait>`

Ports are injected as trait objects:

```rust
pub struct SuspendUserUseCase {
    user_repo: Arc<dyn UserRepository>,
}
```

Both reference projects use generics instead (`CreateThought<'r, R: Repo>`, `UserService<R: IUserRepository>`). This skill prescribes trait objects for one reason: with generics the concrete repository leaks into every type that mentions the use case — the handler signature becomes `State<Arc<UserService<PgUserRepository>>>`, and `infra/http` now depends on `infra/repository`. With `Arc<dyn UserRepository>` the composition root is the only place that names a concrete type (rule 11). The cost is one virtual call per port method, which is noise next to a database round trip.

Because of that, port traits use `#[async_trait]` and require `Send + Sync`:

```rust
#[async_trait]
pub trait UserRepository: Send + Sync { /* … */ }
```

No service locator, no global: never a `static POOL`, `OnceLock<Config>` or `lazy_static!` reached from inside a use case.

---

## 4. Ports

All four kinds are traits declared in `domain/<feature>/` and implemented in `infra`.

### Repository — write side

```rust
// crates/domain/src/user/user_repository.rs
#[async_trait]
pub trait UserRepository: Send + Sync {
    async fn find_by_id(&self, id: UserId) -> Result<Option<User>, AppError>;

    /// Exists only for the uniqueness check on registration.
    async fn find_by_email(&self, email: &Email) -> Result<Option<User>, AppError>;

    /// Upsert.
    async fn save(&self, user: &User) -> Result<(), AppError>;

    async fn delete(&self, id: UserId) -> Result<(), AppError>;
}
```

- The canonical contract is `find_by_id`, `save`, `delete`. Add `find_by_x` only for a uniqueness check.
- It returns the **entity**. Never a row, never a DTO.
- "Not found" is `Ok(None)`. `Err` means the store itself failed.
- No `list`, `search` or `count` here — those are queries.

### Queries — read side

```rust
// crates/domain/src/user/user_queries.rs
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSummary {
    pub id: String,
    pub email: String,
    pub is_suspended: bool,
    pub created_at: DateTime<Utc>,
}

#[async_trait]
pub trait UserQueries: Send + Sync {
    async fn list(&self, page: PageInput) -> Result<PageOutput<UserSummary>, AppError>;
}
```

- Returns **read models**: public-field structs shaped for the consumer, declared in the same file as the trait. No entity is rehydrated.
- Use it when the use case only reads for display, or needs joined or aggregated data that does not fit the entity.

### Gateway — external systems

```rust
// crates/domain/src/video/transcription_gateway.rs
#[async_trait]
pub trait TranscriptionGateway: Send + Sync {
    async fn transcribe(&self, audio_path: &str) -> Result<Transcript, AppError>;
}
```

The trait speaks domain types only. The implementation (`infra/gateway/openai_transcription_gateway.rs`) owns the HTTP client, the API key (received through its constructor) and the provider's wire format.

### Event publisher — only when publishing is the only write

```rust
// crates/domain/src/report/report_event_publisher.rs
#[async_trait]
pub trait ReportEventPublisher: Send + Sync {
    async fn publish(&self, event: &Recorded<ReportEvent>) -> Result<(), AppError>;
}
```

Opt-in, like the broker behind it. Use it only when the use case saves nothing else; an event that accompanies a `save` goes through the outbox instead (§ 9). The implementation (`infra/messaging/<feature>/broker_<feature>_event_publisher.rs`) and its in-memory fake are in `messaging.md` § 5.

### Which one?

**Repository** when the use case mutates what it loads, needs the entity to enforce a rule, or checks uniqueness before a write. **Queries** when it only reads for display. The same feature normally has both. **Gateway** for a call to an external system that answers. **Event publisher** for a fire-and-forget event that is the use case's only effect.

---

## 5. Validation responsibilities

| Where        | Validates                                                         | How it fails                                   |
|--------------|-------------------------------------------------------------------|------------------------------------------------|
| **Handler**  | Shape: valid JSON, required fields, types (serde)                 | `HttpError::BadRequest` → 400                  |
| **Domain**   | Invariants of one aggregate: `Email::create`, `User::suspend`     | `FeatureError` → `ErrorKind::Invalid`/`Conflict` → 422/409 |
| **Use case** | Rules that need queried state: "email taken?", "is the actor allowed?" | `AppError` → 409 / 403 / 404              |

A use case containing `if input.email.is_empty()` is doing the handler's or the value object's job.

---

## 6. Authorization

Authentication is middleware (`infra/http/middleware/auth.rs`). Authorization that depends on domain state is the use case's job, and it gets the caller through its Input:

```rust
// crates/usecase/src/user/suspend_user.rs
pub struct SuspendUserInput {
    /// The authenticated caller, passed in by the handler.
    pub actor_id: String,
    pub user_id: String,
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
```

Anonymous use cases (registration, login) have no `actor_id`.

---

## 7. Pagination

`PageInput` and `PageOutput<T>` live in `domain/shared/pagination.rs`.

- Every `list_*` and `search_*` use case carries a `PageInput` in its Input (the architecture check enforces it).
- `PageInput::new(page, page_size)` clamps instead of rejecting: `page >= 1`, `1 <= page_size <= 100`.
- The handler builds it from query parameters; the queries implementation turns `page_size()` and `offset()` into `LIMIT` / `OFFSET`.

```rust
#[derive(Debug)]
pub struct ListUsersInput {
    pub page: PageInput,
}

pub type ListUsersOutput = PageOutput<UserSummary>;
```

---

## 8. Tests

Use case tests use the in-memory fakes from `infra` (see `workspace-layout.md` § 5 for the dev-dependency):

```rust
#[cfg(test)]
mod tests {
    use domain::shared::errors::ErrorKind;
    use infra::repository::user::in_memory_user_repository::InMemoryUserRepository;

    use super::*;

    #[tokio::test]
    async fn rejects_a_taken_email() {
        let use_case = CreateUserUseCase::new(Arc::new(InMemoryUserRepository::new()));
        let input = || CreateUserInput { email: "ada@example.com".to_owned() };
        use_case.execute(input()).await.unwrap();

        let err = use_case.execute(input()).await.unwrap_err();

        assert_eq!(err.kind(), ErrorKind::Conflict);
        assert_eq!(err.code(), "USER_EMAIL_TAKEN");
    }
}
```

Assert on `err.kind()` and `err.code()`, not on message text.

---

## 9. Multiple writes

Default: **one aggregate, one `save`, one transaction.** When saving an aggregate touches several tables, the repository implementation opens a transaction itself (`pool.begin()`) inside `save`. The use case never sees it.

A use case that must change two aggregates atomically is rare, and usually a sign that the aggregate boundary is wrong or that the second change should react to a domain event.

**Events go through the outbox.** When a change must be announced to other services (Kafka, RabbitMQ, NATS, SQS), the entity records the event and the repository's `save` writes it to an outbox table in the same transaction; a relay publishes it afterwards. The use case never calls a broker after `save`: that is a second write with no shared transaction. Opt-in; see `messaging.md` § 4.

When it is genuinely needed, a Unit of Work is opt-in: the trait goes in `domain/shared/unit_of_work.rs` (already on the whitelist) and the implementation in `infra/persistence/`. **The Rust starter does not ship one.** Passing a transaction across `Arc<dyn Trait>` ports has more than one reasonable design in Rust and each has real costs, so stop and agree on it with the user before building it.

---

## 10. Common pitfalls

- **A second public method** (`execute_batch`, `preview`). That is a second use case; give it its own file.
- **`pub fn` helpers in a use case file.** Private functions are fine; public ones are not.
- **Generic ports** (`CreateUserUseCase<R: UserRepository>`). Use `Arc<dyn UserRepository>`.
- **Returning the entity** from `execute`. Return the Output.
- **`Deserialize` on the Input.** The handler owns the wire shape.
- **Matching on an error to translate it.** `?` and the `From<FeatureError> for AppError` impl already do it.
- **Calling another use case.** Use cases do not compose; shared logic moves into the domain or behind a port. Detection: `[usecase-no-composition]`.

---

## Cross-references

- `domain-modeling.md` — entities, VOs, `AppError`.
- `infra-axum-sqlx.md` — implementing the ports, handlers, wiring.
- `messaging.md` — domain events, the outbox, broker producers and consumers.
