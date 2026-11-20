---
name: clean-arch
version: 2.0.0
description: Use when creating, modifying, moving, or renaming any backend artifact (entity, value object, use case, repository, query, handler, route, DTO, error, row mapping, gateway, middleware, composition root) in a Rust backend; when the user asks for a new endpoint, feature, CRUD, or backend change in Rust; when the user mentions clean architecture, DDD, domain, layer, infra, use case, aggregate, Cargo workspace layering, axum or sqlx structure; or whenever a project's CLAUDE.md asks to use this skill.
---

# Clean Architecture + tactical DDD for Rust

Prescriptive philosophy and folder organization for Rust backends. Codifies one way to do things so the codebase stays consistent. Read this file first; load `references/architecture/` for depth on a specific topic.

If the project follows this architecture (a `Cargo.toml` with `crates/domain` or `src/domain`, or a CLAUDE.md referencing this skill), follow the rules strictly.

Default stack: **axum + tokio, sqlx + PostgreSQL, thiserror in libraries, anyhow only in the binary.** A complete, compiling example is in `templates/initial-project-rust/`.

---

## The dependency rule (read first, internalize)

```
              ┌─────────────────────────────────────┐
              │            crates/app/              │  composition root
              │  main.rs: the only place that names │  + config.rs: the only
              │  concrete infra types               │    env reader
              └────────────┬────────────────────────┘
                           │ depends on
              ┌────────────▼────────────────────────┐
              │           crates/infra/             │  external world
              │  http/   repository/   queries/     │  (HTTP, DB, APIs,
              │  gateway/   persistence/            │   filesystem, queues)
              └────────────┬────────────────────────┘
                           │ depends on
              ┌────────────▼────────────────────────┐
              │          crates/usecase/            │  application
              │  (orchestration, no business rules) │
              └────────────┬────────────────────────┘
                           │ depends on
              ┌────────────▼────────────────────────┐
              │          crates/domain/             │  business core
              │  entities, VOs, traits, errors      │
              │  (no workspace deps, no I/O crates) │
              └─────────────────────────────────────┘
```

**Arrows point inward, never outward.** One crate per layer is the default because **Cargo enforces the rule**: `domain`'s `Cargo.toml` does not list `infra`, so `use infra::…` inside `domain` does not compile.

- `domain` depends on no workspace crate and on no I/O crate.
- `usecase` depends on `domain` only.
- `infra` depends on `domain` and `usecase`. It implements the traits defined inward.
- `app` depends on all three. `main.rs` is the only place that constructs concrete `infra` types; `config.rs` is the only place that reads the environment.

The flow of a request:

```
HTTP Request
    → handler (extractors parse and check shape into a serde body struct, build Input)
        → use_case.execute(input).await?
            → repo.find_by_id() / queries.list() / gateway.call()
                ← Option<Entity> / read model / external response
            → entity.some_business_method()?
            → repo.save(&entity).await?
            ← Output
        ← Output
    ← (StatusCode, Json<Output>)   — or HttpError → status, mapped in one place
```

---

## Canonical layout

```
backend/
  Cargo.toml                     # [workspace] + shared versions + shared lints
  clippy.toml
  migrations/
  crates/
    domain/src/                  # no workspace deps, no I/O crates
      shared/                    # whitelist: id, errors, pagination, unit_of_work, event
      user/                      # mod.rs, user_entity.rs, email_vo.rs,
                                 # user_repository.rs, user_queries.rs, errors.rs
    usecase/src/                 # depends on domain only
      user/                      # create_user.rs, list_users.rs, suspend_user.rs
    infra/src/                   # depends on domain + usecase
      http/                      # router.rs, error.rs, extract.rs, middleware/auth.rs
        user/                    # create_user_handler.rs, …, user_routes.rs
      repository/user/           # pg_user_repository.rs, in_memory_user_repository.rs, user_row.rs
      queries/user/              # pg_user_queries.rs, in_memory_user_queries.rs
      gateway/  persistence/
      messaging/                 # opt-in: broker producers, consumers, outbox relay (messaging.md)
    app/src/                     # main.rs (composition root), config.rs (only env reader)
```

Small projects may use a **single crate** with the same tree under `src/` (`src/domain`, `src/usecase`, `src/infra`, `src/config.rs`, `src/main.rs`); the architecture check then enforces the dependency rule instead of Cargo. **No third layout**: no `adapter` crate, no `core` crate, no per-feature crates.

**Rules for the layout**:
- Feature folders are mirrored across `domain/`, `usecase/`, `infra/repository/`, `infra/queries/`, `infra/http/`. The same feature name (`user/`, `video/`) appears in every layer.
- Inside a feature folder: **flat**. Use file naming + suffix to group.
- `mod.rs` and `lib.rs` are facades: module declarations and **named** re-exports only — no functions, no types, no `pub use x::*`.
- Tests are co-located: `#[cfg(test)] mod tests { … }` as the **last item** of the file. Use case tests run against the in-memory fakes from `infra` (a `[dev-dependencies]` entry), never against mocks written inside the test.

Full trees, `Cargo.toml` per crate and the facade rules: `references/architecture/workspace-layout.md`.

---

## The 19 inviolable rules

### Structural

1. **Three layers, dependency rule**: `domain` ← `usecase` ← `infra` ← `app`. Arrows inward only. Enforced by each crate's `Cargo.toml`.
2. **The environment is read in one place**: `crates/app/src/config.rs` (single crate: `src/config.rs`). `std::env::var*` anywhere else is denied by clippy `disallowed-methods` and by the architecture check.
3. **Feature folders are mirrored** across `domain/`, `usecase/`, `infra/repository/`, `infra/queries/`, `infra/http/`. Same name, same boundary. Flat inside.
4. **`mod.rs` / `lib.rs` are facades**: declarations and named re-exports only. No logic, no glob re-exports.
5. **`domain/src/shared/` is a closed whitelist**: `id.rs`, `errors.rs`, `pagination.rs`, `unit_of_work.rs`, `event.rs`. Anything else you want to put there belongs to a feature.

### Domain

6. **Domain is rich**: entities have private fields, `pub fn create` (applies creation rules) and `pub fn restore` (rehydrates from persistence without re-running them), `&mut self` methods named after the business operation (`suspend()`, `rename(title)`), and read-only getters. **No `pub` field, no `set_*`, ever.**
7. **Value objects are self-validating**: private field, `create(..) -> Result<Self, FeatureError>`, `from_trusted` for rehydration, an accessor, `PartialEq`.
8. **IDs are generated in the domain** via `Id::<T>::generate()`. Each aggregate has a phantom-typed alias (`pub type UserId = Id<User>`) so IDs of different aggregates are different types.
9. **Domain may use libraries, never I/O**: validation, date (`chrono`) and numeric crates are fine inside VOs and entities. I/O crates (`sqlx`, `axum`, `reqwest`, `tokio`, broker clients such as `rdkafka` and `lapin`, …) and `std::fs`/`std::net`/`std::process`/`std::env` are forbidden in `domain` and `usecase`.

### Use Cases

10. **One use case = one `pub struct …UseCase` per file**, whose only public methods are `new` and `async fn execute(&self, input) -> Result<Output, AppError>`. A second public method means a second use case — split it.
11. **Dependencies via constructor, always**: `Arc<dyn Trait>` fields set in `new`. No globals — no `static`, `OnceLock` or `lazy_static` holding a pool or a config. The composition root wires everything.
12. **Use cases never validate input shape** (that's the handler's serde body struct) and **never contain business invariants** (that's the entity's / VO's job). Use cases only orchestrate and may verify **rules requiring queried state** (e.g. "is this email already taken?" → `user_repo.find_by_email(..)`).

### Read vs Write

13. **CQRS-lite**: write-side use cases use `trait FeatureRepository` (returns the entity). Read-side use cases use `trait FeatureQueries` (returns read models directly). Both traits live in `domain/<feature>/`; both implementations live in `infra/`.
14. **Repository contract is canonical**: `find_by_id`, `save` (upsert), `delete`. Add `find_by_x` only for uniqueness checks. A missing row is `Ok(None)`, not an error.
15. **Repository returns the entity**, never raw rows or DTOs. Mapping lives in `<feature>_row.rs` as `impl From<FeatureRow> for Feature`, calling `restore`.

### HTTP / Boundary

16. **Handler is one `pub async fn <action>_<feature>_handler` per file**, returning `Result<_, HttpError>`. It extracts, builds the Input, calls `execute`, returns. **`?` only** — no `match` on errors, no `map_err`, no error status codes. Status codes are chosen in exactly one place: `infra/src/http/error.rs`.
17. **Entities are never serialized**: entities and VOs never derive `Serialize` / `Deserialize`. Each use case maps with `impl From<&Entity> for Output`.
18. **Authentication in middleware, authorization in the use case**. The `authenticate` layer and the `CurrentUser` extractor in `infra/http/middleware/auth.rs` reject unauthenticated requests with 401. **For authenticated operations**, the handler passes `actor_id` into the use case Input, and the use case enforces the rules that depend on domain state ("only the owner can delete this video"). Anonymous endpoints (registration, login) take no `actor_id`.

### Process

19. **Self-audit before declaring done**: run the 3 gates below. **`--no-verify` on commit/push is forbidden, and so is `#[allow(..)]` to silence a gate.** If a gate fails, fix the code — never the gate. If you believe the gate is wrong, stop and ask the user.

---

## Canonical shapes (minimal examples)

```rust
// domain/src/user/user_entity.rs — rich, closed, not serializable
pub type UserId = Id<User>;

#[derive(Debug, Clone)]
pub struct User { id: UserId, email: Email, is_suspended: bool, created_at: DateTime<Utc> }

impl User {
    pub fn create(email: Email) -> Self { /* generates the id, applies creation rules */ }
    pub fn restore(id: UserId, email: Email, is_suspended: bool, created_at: DateTime<Utc>) -> Self { /* no rules */ }
    pub fn suspend(&mut self) -> Result<(), UserError> { /* the invariant lives here */ }
    pub const fn id(&self) -> UserId { self.id }
}
```

```rust
// domain/src/user/user_repository.rs — port
#[async_trait]
pub trait UserRepository: Send + Sync {
    async fn find_by_id(&self, id: UserId) -> Result<Option<User>, AppError>;
    async fn find_by_email(&self, email: &Email) -> Result<Option<User>, AppError>;  // uniqueness check only
    async fn save(&self, user: &User) -> Result<(), AppError>;   // upsert
    async fn delete(&self, id: UserId) -> Result<(), AppError>;
}
```

```rust
// usecase/src/user/create_user.rs — Input + Output + one execute
pub struct CreateUserUseCase { user_repo: Arc<dyn UserRepository> }

impl CreateUserUseCase {
    pub fn new(user_repo: Arc<dyn UserRepository>) -> Self { Self { user_repo } }

    pub async fn execute(&self, input: CreateUserInput) -> Result<CreateUserOutput, AppError> {
        let email = Email::create(&input.email)?;
        if self.user_repo.find_by_email(&email).await?.is_some() {
            return Err(UserError::EmailTaken(email.as_str().to_owned()).into());
        }
        let user = User::create(email);
        self.user_repo.save(&user).await?;
        Ok(CreateUserOutput::from(&user))
    }
}
```

```rust
// infra/src/http/user/create_user_handler.rs — extract, build Input, execute, return
pub async fn create_user_handler(
    State(create_user): State<Arc<CreateUserUseCase>>,
    ApiJson(body): ApiJson<CreateUserBody>,
) -> Result<(StatusCode, Json<CreateUserOutput>), HttpError> {
    let output = create_user.execute(CreateUserInput { email: body.email }).await?;
    Ok((StatusCode::CREATED, Json(output)))
}
```

---

## Naming

Files are `snake_case` with an underscore suffix (`user_entity.rs`, `email_vo.rs`, `pg_user_repository.rs`, `create_user_handler.rs`). Types are `PascalCase`; no `I` prefix on traits. Input, Output and the use case share one file (`usecase/<feature>/<action>_<feature>.rs`); the row file is the mapper. The full table is in `references/architecture/workspace-layout.md` § 3, and the architecture check enforces it.

---

## Validation responsibilities

| Where           | Validates                                                  | On failure                          |
|-----------------|------------------------------------------------------------|-------------------------------------|
| **Handler**     | Shape: required fields, JSON types, basic format — the serde body struct, through the `ApiJson` / `ApiQuery` extractors | `HttpError::BadRequest` → 400 |
| **Domain**      | Invariants of a single aggregate: `Email::create` checks the format, `User::suspend` refuses a second suspension | `FeatureError` variant → its `ErrorKind` (`Invalid` → 422, `Conflict` → 409) |
| **Use Case**    | Rules requiring queried state: "is the email already taken?", "is the actor the owner?" | `ErrorKind::Conflict` / `Forbidden` → 409 / 403 |

Use cases **never** validate shape (`if input.email.is_empty()` is a smell — the handler should have caught it). Entities **never** check rules that need other aggregates (they have no repository access).

---

## Repository vs Queries — decision rule

**Use `FeatureRepository`** when:
- The use case will **mutate** the loaded data (rename, suspend, delete).
- The use case needs the entity to enforce business rules (`video.mark_as_ready()?`).
- You're checking uniqueness for a write (`user_repo.find_by_email(..)` to reject duplicates).

**Use `FeatureQueries`** when:
- The use case **only reads** for display (list, get-detail, search).
- The output is meant for the API consumer, not for further mutation.
- You need aggregated, derived, or joined data that doesn't fit the entity (`video_count` per user, `latest_upload`).

Same feature → both traits. `domain/src/video/video_repository.rs` (write) and `domain/src/video/video_queries.rs` (read) coexist.

---

## Self-audit gates (mandatory)

After **any** structural change (new, moved or renamed file in `domain`, `usecase`, `infra` or `app`), run all 3 gates and fix any failure before declaring the task done:

```bash
node ~/.claude/skills/clean-arch/scripts/run-gates.mjs
```

From a monorepo root the helper auto-detects `apps/backend` or `backend`; otherwise run it from the backend root or pass `--cwd=<backend-path>`. It runs:

1. `cargo fmt --all -- --check` — formatting.
2. `cargo clippy --workspace --all-targets -- -D warnings` — compiles everything; denies `unwrap`, `expect`, `todo!`, `dbg!` outside tests, `unsafe`, and `std::env::var` outside `config.rs`.
3. `node ~/.claude/skills/clean-arch/scripts/check-architecture-rust.mjs` — crate dependencies, I/O crates in `domain`/`usecase`, naming per location, use case / entity / VO / handler / consumer shapes, in-memory fakes, `shared` whitelist, `mod.rs` facades, silenced lints (`#[allow]`, `#[rustfmt::skip]`), global state, `Rc`/`RefCell`/`Mutex` in `domain`/`usecase`, generic / `&mut self` / composed use cases, `Deref` and `Default` in the domain, infallible `From<String>` on value objects, ports without `Send + Sync`, `anyhow` outside `app`.

Cargo already rejects cross-layer and circular crate dependencies, and clippy includes the type check, so three gates cover the rules. **`git commit --no-verify`, `git push --no-verify` and `#[allow(..)]` to quiet a gate are forbidden.** If a gate fails, fix the code. If you genuinely believe the gate itself is wrong, stop and ask the user — do not bypass.

---

## Reference index

For the concrete layout, rules and shapes, load the relevant file from `references/architecture/`:

- **`workspace-layout.md`** — both layouts, `Cargo.toml` per crate, the naming table, `mod.rs` facades, where tests live, the 19 rules as a table, where the layout comes from.
- **`domain-modeling.md`** — entities, value objects, `Id<T>`, `AppError` / `ErrorKind`, per-feature error enums, what `domain` may depend on.
- **`use-cases-and-ports.md`** — use case shape, DTOs, why `Arc<dyn Trait>`, repository / queries / gateway traits, authorization, pagination, tests, multiple writes.
- **`infra-axum-sqlx.md`** — handlers, extractors, the central `HttpError` mapper, routes, authentication, sqlx repositories and row mapping, in-memory fakes, composition root, config.
- **`messaging.md`** — opt-in: domain events, the transactional outbox, Kafka (`rdkafka`), RabbitMQ (`lapin`), NATS JetStream (`async-nats`) and SQS (`aws-sdk-sqs`) producers, consumers and the ack / retry / dead-letter mapper, idempotency.
- **`anti-patterns.md`** — violations to actively avoid and which gate catches each.

For language idioms and design patterns adapted to Rust (the reasoning behind the rules, with where each pattern does and does not belong), load from `references/rust-patterns/`. Start with `thinking-in-rust.md`:

- **`designing-for-rust-not-oo.md`** — why OO habits (sub-traits, base use cases, `Deref` inheritance, generic "classes", over-nested enums) fail in Rust, where `dyn` is legitimate (ports), and a decision guide.
- **`ownership-clone-and-smart-pointers.md`** — ownership by layer, why `.clone()` / `Rc<RefCell>` / `Arc<Mutex>` are not fixes for borrow errors, where they are legitimate (`Arc<dyn Port>`, in-memory fakes), and an escalation checklist.
- **`borrow-checker-as-design-feedback.md`** — reading borrow errors as design questions, fixes in order (phases, keys over references, downward data flow), and why `RefCell` workarounds, `unsafe` (`forbid`den in the starter) and global mutable state are not answers.
- **`creational-patterns.md`** — Factory Method (`create` / `restore` / `from_trusted` / `TryFrom`), why Abstract Factory is the composition root, Builder (test data only), why Singleton is forbidden as a global, and `Clone` / `Default` as Prototype (never on entities or VOs).
- **`structural-patterns.md`** — Decorator on ports (not use cases), gateways and row mapping as Adapters, use case and `mod.rs` re-exports as Facades, Composite as an enum owned by one aggregate, Flyweight via `Arc`, and ports as the Bridge.
- **`behavioral-patterns-actions.md`** — Command (a use case is the command; undo as an inverse use case), Chain of Responsibility (middleware, not handler lists), Strategy (port / enum / closure, chosen per request), Mediator (use case + composition root + domain events, never `Arc<Mutex<dyn Mediator>>`), Template Method (a fixed `execute`, not an inherited trait).
- **`behavioral-patterns-keeping-track.md`** — Iterator (borrowed iteration, pages at ports), State (status enum with transition methods), Memento (`FeatureSnapshot` + row, never a serialized entity), Observer (domain events, outbox, channels), Visitor (enum + `match`).
- **`architectural-principles.md`** — the four principles behind the layout (data flows downward, mutability stays contained, modules are interfaces, pack lightly), where `Arc<Mutex>` is legitimate, lock-order and unbounded-growth pitfalls, and a four-step review checklist.
- **`type-system-patterns.md`** — NewType (`Id<T>`, value objects), parse-don't-validate at boundaries and in `Config::from_env`, TypeState (in-memory flows only, status `enum` for stored entities), and sealed traits (never for ports).
- **`functional-patterns.md`** — iterator pipelines over in-memory data, traits as small capabilities (ports), exhaustive `match` and pure state-transition functions, and closures (where they fit, why not in entities, alias instead of `#[allow]`).
- **`core-language-patterns.md`** — `Result` / `Option` flow across layers (never drop the cause, absent vs invalid config, batch failure policy), smart constructors, block expressions (scoped init, ending a guard before `.await`), and RAII (what `sqlx` / `tokio` already clean up, `Drop` rules).
- **`thinking-in-rust.md`** — the mindset behind the others: a symptom-to-fix lookup, compiler-driven order for building a feature, ownership / types / explicitness principles applied to the layers, the three gates as a workflow, a pre-"done" checklist, and a file map of this folder.

Load `anti-patterns.md` before any non-trivial structural change. It is the most operational reference.
