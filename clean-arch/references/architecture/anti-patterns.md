# Rust — anti-patterns

The operational checklist for Rust backends. Load it before any non-trivial structural change. Each entry: **what it looks like, the fix, the rule it violates, what catches it.**

"Architecture check" means `scripts/check-architecture-rust.mjs`; the name in brackets is the rule id it prints.

---

## Layer violations

### R1. `usecase` or `domain` depends on an outer crate

❌ Wrong:
```toml
# crates/usecase/Cargo.toml
[dependencies]
domain.workspace = true
infra.workspace = true
```

✅ Right: `usecase` lists `domain` only. `infra` may appear under `[dev-dependencies]`, for the in-memory fakes.

**Violates rule 1.** Detection: architecture check `[crate-deps]`. In the single-crate layout, `use crate::infra::…` inside `domain` or `usecase` is `[layer-import]`.

---

### R2. An I/O crate in `domain` or `usecase`

❌ Wrong:
```rust
// crates/domain/src/user/user_entity.rs
#[derive(sqlx::FromRow)]
pub struct User { /* … */ }
```
```rust
// crates/usecase/src/report/export_report.rs
tokio::fs::write(path, bytes).await?;
```

✅ Right: the derive goes on a row struct in `infra/repository/<feature>/<feature>_row.rs`; the file write goes behind a gateway trait declared in `domain` and implemented in `infra`.

**Violates rules 1 and 9.** Detection: architecture check `[forbidden-crate]` (both the manifest and the source are scanned).

---

### R3. Infrastructure types in the shared error

❌ Wrong — the pattern in one of the reference projects:
```rust
// domain sees this through `crate::common::error`
impl From<sqlx::Error> for CustomError { /* … */ }
impl warp::reject::Reject for CustomError {}
```

✅ Right: `AppError` in `domain/shared/errors.rs` knows neither the database nor HTTP. `infra` converts on the way in (`db_error`: `sqlx::Error → AppError::unexpected`) and on the way out (`HttpError: IntoResponse`).

**Violates rule 1.** Detection: `[forbidden-crate]`; in the workspace layout it does not compile.

---

### R4. Reading the environment outside `config.rs`

❌ Wrong:
```rust
// crates/infra/src/gateway/openai_transcription_gateway.rs
let api_key = std::env::var("OPENAI_API_KEY")?;
```

✅ Right: `Config::from_env()` reads it once; `main.rs` passes it to the constructor.

**Violates rule 2.** Detection: clippy `disallowed_methods` (configured in `clippy.toml`) and architecture check `[env-outside-config]`.

---

### R5. Globals instead of injection

❌ Wrong:
```rust
lazy_static! { static ref CONFIGURATION: Configuration = Configuration::new(); }
static POOL: OnceLock<PgPool> = OnceLock::new();
```

✅ Right: construct in `main`, pass through constructors as `Arc<dyn Trait>` or by value.

**Violates rule 11.** Detection: architecture check `[no-global-state]` (`static mut`, `lazy_static!`, `thread_local!`, a `static` lock, a `static` `OnceLock`/`LazyLock` holding a config, pool, client or lock). (A `static` regex or constant table is fine; a `static` holding a dependency is not.)

---

## Domain

### R6. Anemic entity with public fields

❌ Wrong:
```rust
pub struct User {
    pub user_id: Uuid,
    pub email: String,
    pub password: String,
}
```

✅ Right: private fields, `create` / `restore`, getters, behavior as methods.

**Violates rule 6.** Detection: `[entity-private-fields]`, `[entity-create-factory]`, `[entity-restore-factory]`.

---

### R7. Setters

❌ Wrong: `pub fn set_status(&mut self, status: Status)`

✅ Right: `pub fn suspend(&mut self) -> Result<(), UserError>` — a name from the business, with the invariant inside.

**Violates rule 6.** Detection: `[no-setters-in-domain]`.

---

### R8. A value object that can be built without validation

❌ Wrong:
```rust
#[derive(Deserialize)]
pub struct Email(pub String);

impl From<String> for Email { /* … */ }
```

✅ Right: private field; `create` returns `Result`; `from_trusted` is the single, explicitly named bypass, used only by row mapping.

**Violates rule 7.** Detection: `[vo-private-fields]`, `[vo-create-factory]`, `[vo-not-serializable]`, `[vo-no-infallible-from]`.

---

### R9. Serializable entity

❌ Wrong: `#[derive(Serialize)] pub struct User { … }` and then `Json(user)`.

✅ Right: `impl From<&User> for CreateUserOutput` in the use case file; the handler returns `Json(output)`.

**Violates rule 17.** Detection: `[entity-not-serializable]`.

---

### R10. Panicking instead of returning an error

❌ Wrong: `let user = repo.find_by_id(id).await.unwrap().expect("user exists");`

✅ Right: `?` and `.ok_or_else(|| UserError::NotFound(..))?`.

**Violates rule 19** (the gate exists; do not silence it). Detection: clippy `unwrap_used` / `expect_used` / `todo`, denied in `[workspace.lints]`.

---

## Use cases

### R11. The service with many methods

❌ Wrong:
```rust
impl UserService {
    pub async fn create_user(..) { }
    pub async fn list_users(..) { }
    pub async fn get_user(..) { }
}
```

✅ Right: `create_user.rs`, `list_users.rs`, `get_user.rs`, each with one `…UseCase` and one `execute`.

**Violates rule 10.** Detection: `[usecase-single-execute]`, `[usecase-shape]`.

---

### R12. Generic ports

❌ Wrong: `pub struct CreateUserUseCase<R: UserRepository> { repo: R }` — and then `State<Arc<CreateUserUseCase<PgUserRepository>>>` in the handler.

✅ Right: `user_repo: Arc<dyn UserRepository>`.

**Violates rule 11.** Detection: `[usecase-generic-ports]`. See `use-cases-and-ports.md` § 3 for the reasoning.

---

### R13. Shape checks or invariants in the use case

❌ Wrong:
```rust
if input.email.is_empty() { /* … */ }          // shape → handler
if !input.email.contains('@') { /* … */ }      // invariant → Email::create
```

✅ Right: the use case calls `Email::create(&input.email)?` and moves on.

**Violates rule 12.** Detection: review.

---

### R14. Reading through the repository

❌ Wrong: a `list_users` use case that calls `user_repo.find_all()` and maps entities to DTOs in a loop.

✅ Right: `UserQueries::list(page)` returning `PageOutput<UserSummary>`.

**Violates rule 13.** Detection: `[list-page-input]` catches the missing pagination; the repository misuse is caught in review.

---

### R15. `usecase/shared`

❌ Wrong: `crates/usecase/src/shared/`, `common/`, `utils/`, `helpers/`.

✅ Right: the use case goes in the primary aggregate's folder, or in a named composite-flow folder (`user_onboarding/`).

Detection: `[usecase-forbidden-folder]`.

---

## Infra

### R16. Error handling in the handler

❌ Wrong:
```rust
match user_service.get_user(&id).await {
    Ok(user) => Ok(json(&user)),
    Err(_) => Err(reject()),
}
```

✅ Right:
```rust
let output = get_user.execute(GetUserInput { user_id }).await?;
Ok(Json(output))
```

**Violates rule 16.** Detection: `[handler-no-error-mapping]` (flags `Err(`, `.map_err(` and error status constants in `*_handler.rs`).

---

### R17. Several handlers in one "controller" file

❌ Wrong: `user_controller.rs` with `list_users`, `create_user`, `get_user`.

✅ Right: one `<action>_<feature>_handler.rs` per endpoint, plus `<feature>_routes.rs`.

**Violates rule 16.** Detection: `[handler-shape]`, `[naming-suffix]`.

---

### R18. A handler that reaches past the use case

❌ Wrong: `State(pool): State<PgPool>` followed by `sqlx::query(..)` in the handler.

✅ Right: `State<Arc<SomeUseCase>>`. If there is no use case yet, write it.

**Violates rule 1** (in spirit: infra/http skipping the application layer). Detection: review.

---

### R19. A repository without its fake

❌ Wrong: `pg_user_repository.rs` alone in `infra/repository/user/`.

✅ Right: `in_memory_user_repository.rs` next to it, kept behaviorally in step.

Detection: `[missing-in-memory-repo]`, `[missing-in-memory-queries]`.

---

### R20. Logic in `mod.rs`

❌ Wrong: types, functions or `pub use errors::*;` in a `mod.rs`.

✅ Right: module declarations and named re-exports only. The router lives in `router.rs`, not in `http/mod.rs`.

**Violates rule 4.** Detection: `[mod-facade]`.

---

### R21. Catch-all files

❌ Wrong: `utils.rs`, `helpers.rs`, `common.rs`, `types.rs` in a feature folder; anything beyond the whitelist in `domain/shared/`.

✅ Right: name the file after the artifact it holds (see the table in `workspace-layout.md` § 3).

**Violates rules 3 and 5.** Detection: `[naming-suffix]`, `[shared-whitelist]`.

---

## Process

### R22. Making a gate pass without fixing the code

❌ Wrong: `#[allow(clippy::unwrap_used)]` on a function, `#[rustfmt::skip]`, renaming a file so a rule stops matching, `git commit --no-verify`.

✅ Right: fix the code. If you believe the gate is wrong, stop and ask the user.

**Violates rule 19.** Detection: `[no-silenced-lint]` flags `#[allow(..)]`, `#![allow(..)]` and `#[rustfmt::skip]` in production code; `--no-verify` and renamed files are caught in review. The one sanctioned exception in the starter is `#![expect(clippy::disallowed_methods)]` at the top of `config.rs`.

---

## Cross-references

- `workspace-layout.md` — the rules these entries cite, and the naming table.
