# Rust — workspace layout, naming, and the 19 rules

How the architecture in `SKILL.md` is laid out in a Rust backend. A complete, compiling example of everything below lives in `templates/initial-project-rust/`.

Default stack: **axum + tokio, sqlx + PostgreSQL, thiserror in libraries, anyhow only in the binary.**

---

## 1. Two layouts

### Workspace — one crate per layer (default)

```
backend/
  Cargo.toml                         # [workspace], shared versions, shared lints
  clippy.toml
  migrations/
  crates/
    domain/                          # business core — no workspace deps, no I/O crates
      Cargo.toml
      src/
        lib.rs
        shared/                      # whitelist: id, errors, pagination, unit_of_work, event
          mod.rs  id.rs  errors.rs  pagination.rs
        user/
          mod.rs                     # facade: private mods + named re-exports
          user_entity.rs
          email_vo.rs
          user_repository.rs         # trait (write side)
          user_queries.rs            # trait + read models (read side)
          errors.rs
    usecase/                         # application — depends on domain only
      Cargo.toml
      src/
        lib.rs
        user/
          mod.rs
          create_user.rs             # Input + Output + CreateUserUseCase
          list_users.rs
          suspend_user.rs
    infra/                           # outside world — depends on domain + usecase
      Cargo.toml
      src/
        lib.rs
        http/
          mod.rs  router.rs  error.rs  extract.rs
          middleware/  mod.rs  auth.rs
          user/
            mod.rs
            create_user_handler.rs
            list_users_handler.rs
            suspend_user_handler.rs
            user_routes.rs
        repository/user/
          mod.rs
          pg_user_repository.rs
          in_memory_user_repository.rs
          user_row.rs                # row struct + mapping to the entity
        queries/user/
          mod.rs
          pg_user_queries.rs
          in_memory_user_queries.rs
        gateway/                     # external API adapters: <provider>_<concept>_gateway.rs
        persistence/                 # db_error.rs, transaction plumbing
        messaging/                   # opt-in, messaging.md: producers, subscribers, outbox relay, disposition.rs
          <feature>/                 # <feature>_message.rs, *_publisher.rs + fake, *_consumer.rs
    app/                             # binary — composition root
      Cargo.toml
      src/
        main.rs                      # the only place that names concrete infra types
        config.rs                    # the only place that reads the environment
```

This is the default because **the compiler enforces the dependency rule**: `domain`'s `Cargo.toml` does not list `infra`, so `use infra::…` inside `domain` does not compile. No linter can be bypassed, because there is no linter.

### Single crate — one module per layer (small projects)

```
backend/
  Cargo.toml
  src/
    main.rs                          # composition root
    config.rs                        # the only place that reads the environment
    domain/    mod.rs  shared/  user/
    usecase/   mod.rs  user/
    infra/     mod.rs  http/  repository/  queries/  gateway/  persistence/
```

Same folders, same file names, same rules. The difference: modules of one crate can import each other freely, so the dependency rule is enforced by `check-architecture-rust.mjs` (rule `layer-import`) instead of by Cargo. Start here only when the project is small; move to the workspace when a second binary appears or build times start to matter.

**Do not invent a third layout.** No `adapter` crate, no `core` crate, no per-feature crates.

---

## 2. The dependency rule, in `Cargo.toml`

| Crate     | May depend on (workspace) | External crates                                                      |
|-----------|---------------------------|----------------------------------------------------------------------|
| `domain`  | nothing                   | `thiserror`, `uuid`, `chrono`, `async-trait`, `serde` (see below), validation and numeric crates. **No I/O crate.** |
| `usecase` | `domain`                  | `serde`, `chrono`. **No I/O crate.**                                  |
| `infra`   | `domain`, `usecase`       | anything: `axum`, `sqlx`, `reqwest`, `tracing`, …                     |
| `app`     | all three                 | `anyhow`, `tokio`, `tracing-subscriber`, …                            |

I/O crates are: `sqlx`, `diesel`, `sea-orm`, `tokio-postgres`, `rusqlite`, `mongodb`, `redis`, `axum`, `actix-web`, `warp`, `rocket`, `hyper`, `tower`, `tower-http`, `reqwest`, `ureq`, `tokio`, and the broker clients `rdkafka`, `lapin`, `async-nats`, `aws-sdk-sqs`, `aws-sdk-sns`, `aws-config`. `std::fs`, `std::net`, `std::process` and `std::env` count too.

`[dev-dependencies]` are exempt — see § 5.

Versions are declared once in `[workspace.dependencies]`; each crate opts in with `name.workspace = true`. Lints are declared once in `[workspace.lints]`; each crate opts in with `[lints] workspace = true`.

---

## 3. Naming and suffixes

Files are `snake_case`. Types are `PascalCase`. No `I` prefix on traits.

| Artifact            | File                                              | Type                                   |
|---------------------|---------------------------------------------------|----------------------------------------|
| Entity              | `domain/<feature>/<feature>_entity.rs`            | `struct Feature`                       |
| Value Object        | `domain/<feature>/<concept>_vo.rs`                | `struct Concept`                       |
| Typed ID            | declared in the entity file                       | `type FeatureId = Id<Feature>`         |
| Repository (trait)  | `domain/<feature>/<feature>_repository.rs`        | `trait FeatureRepository`              |
| Queries (trait)     | `domain/<feature>/<feature>_queries.rs`           | `trait FeatureQueries` + read models   |
| Gateway (trait)     | `domain/<feature>/<concept>_gateway.rs`           | `trait ConceptGateway`                 |
| Errors              | `domain/<feature>/errors.rs`                      | `enum FeatureError`                    |
| Domain events       | `domain/<feature>/events.rs`                      | `enum FeatureEvent`                    |
| Event envelope      | `domain/shared/event.rs`                          | `struct Recorded<E>`                   |
| Event publisher (trait) | `domain/<feature>/<feature>_event_publisher.rs` | `trait FeatureEventPublisher`        |
| Use case + DTOs     | `usecase/<feature>/<action>_<feature>.rs`         | `ActionFeatureInput`, `ActionFeatureOutput`, `ActionFeatureUseCase` |
| Repository (impl)   | `infra/repository/<feature>/<provider>_<feature>_repository.rs` | `struct ProviderFeatureRepository` |
| Repository (fake)   | `infra/repository/<feature>/in_memory_<feature>_repository.rs`  | `struct InMemoryFeatureRepository` |
| Row + mapping       | `infra/repository/<feature>/<feature>_row.rs`     | `struct FeatureRow`                    |
| Queries (impl/fake) | `infra/queries/<feature>/<provider>_<feature>_queries.rs`, `in_memory_<feature>_queries.rs` | `struct ProviderFeatureQueries` |
| Handler             | `infra/http/<feature>/<action>_<feature>_handler.rs` | `async fn action_feature_handler`   |
| Routes              | `infra/http/<feature>/<feature>_routes.rs`        | `fn feature_routes(deps) -> Router`    |
| Gateway (impl)      | `infra/gateway/<provider>_<concept>_gateway.rs`   | `struct ProviderConceptGateway`        |
| Event → message     | `infra/messaging/<feature>/<feature>_message.rs`  | wire structs + `impl TryFrom<&Recorded<FeatureEvent>> for OutboundMessage` |
| Event publisher (impl/fake) | `infra/messaging/<feature>/broker_<feature>_event_publisher.rs`, `in_memory_<feature>_event_publisher.rs` | `struct BrokerFeatureEventPublisher` |
| Consumer            | `infra/messaging/<feature>/<action>_<feature>_consumer.rs` | `async fn action_feature_consumer` |
| Producer, subscriber | `infra/messaging/<broker>_producer.rs`, `<broker>_subscriber.rs` (`kafka`, `rabbitmq`, `nats`, `sqs`) | `struct KafkaProducer`, … |

Messaging rows are opt-in; see `messaging.md`.

Choices worth knowing, all deliberate:

- **Input, Output and the use case share one file.** There is no separate DTO file: the module is the unit, and the three are useless apart.
- **The mapper is the row file.** `impl From<FeatureRow> for Feature` *is* the mapper.
- **`shared/`, not `_shared/`.** Leading underscores are not idiomatic in module names.

---

## 4. `mod.rs` and `lib.rs` are facades

They may contain module declarations and **named** re-exports. Nothing else: no functions, no types, no `pub use x::*`.

- A **domain feature** keeps its files private and re-exports its vocabulary, so callers write `use domain::user::{Email, User, UserRepository}`:

  ```rust
  // crates/domain/src/user/mod.rs
  mod email_vo;
  mod errors;
  mod user_entity;
  mod user_queries;
  mod user_repository;

  pub use email_vo::Email;
  pub use errors::UserError;
  pub use user_entity::{User, UserId};
  pub use user_queries::{UserQueries, UserSummary};
  pub use user_repository::UserRepository;
  ```

- **`usecase` and `infra`** declare `pub mod` and are addressed by path — `usecase::user::create_user::CreateUserUseCase`, `infra::repository::user::pg_user_repository::PgUserRepository`. Each file is one artifact; the path says which.

This is rule 4. The module facade is how visibility is controlled in Rust, so it is kept — but kept empty of logic, so that one import never drags in hidden behavior.

---

## 5. Tests

- Unit tests are co-located: `#[cfg(test)] mod tests { … }` as **the last item of the file** it tests. (The architecture check treats everything after the first `#[cfg(test)]` as test code.)
- Use case tests run against the in-memory fakes from `infra`, never against mocks written inside the test:

  ```toml
  # crates/usecase/Cargo.toml
  [dev-dependencies]
  infra.workspace = true
  tokio.workspace = true
  ```

  This dev-dependency points outward, and that is allowed: it exists only in test builds, and the fakes it pulls in speak nothing but `domain` types. `usecase`'s normal `[dependencies]` still list `domain` alone.
- Tests that need a real database (`#[sqlx::test]`) and end-to-end tests live in each crate's `tests/` folder. What to test and how is out of scope for this skill.

---

## 6. The 19 rules, in Rust

| #  | Rule                                   | In Rust                                                                                   |
|----|----------------------------------------|-------------------------------------------------------------------------------------------|
| 1  | Three layers, arrows inward            | Crates `domain` ← `usecase` ← `infra` ← `app`. Enforced by `Cargo.toml` (§ 2).            |
| 2  | Env read in one place                  | `crates/app/src/config.rs` (single crate: `src/config.rs`). Enforced by clippy `disallowed-methods` and the architecture check. |
| 3  | Feature folders mirrored               | Same feature name under `domain/`, `usecase/`, `infra/repository/`, `infra/queries/`, `infra/http/`. Flat inside. |
| 4  | No barrel files                        | `mod.rs` / `lib.rs` are facades: declarations and named re-exports only (§ 4).            |
| 5  | Shared whitelist                       | `domain/src/shared/`: `id.rs`, `errors.rs`, `pagination.rs`, `unit_of_work.rs`, `event.rs`. |
| 6  | Rich domain                            | Private fields, `create` + `restore`, `&mut self` methods named after the business operation, read-only getters. No `pub` field, no `set_*`. |
| 7  | Self-validating value objects          | Private field, `create(..) -> Result<Self, FeatureError>`, `from_trusted`, accessor, `PartialEq`. |
| 8  | IDs generated in the domain            | `Id<T>::generate()`; `pub type UserId = Id<User>` makes IDs of different aggregates different types. |
| 9  | Domain uses libraries, never I/O       | See the table in § 2.                                                                     |
| 10 | One use case, one `execute`            | One `pub struct …UseCase` per file; its only public methods are `new` and `async fn execute`. |
| 11 | Dependencies via constructor           | `Arc<dyn Trait>` fields set in `new`. No globals: no `static`, `OnceLock`, `lazy_static` holding a pool or a config. |
| 12 | Use cases neither validate shape nor hold invariants | Shape → handler (serde). Invariants → entity / VO. Use case → rules that need queried state. |
| 13 | CQRS-lite                              | `trait FeatureRepository` (returns the entity) and `trait FeatureQueries` (returns read models), both in `domain/<feature>/`. |
| 14 | Canonical repository contract          | `find_by_id`, `save` (upsert), `delete`. `find_by_x` only for uniqueness checks.           |
| 15 | Repository returns the entity          | Mapping lives in `<feature>_row.rs` as `impl From<FeatureRow> for Feature`, calling `restore`. |
| 16 | Handler: one method, no error handling | One `pub async fn <action>_<feature>_handler` per file returning `Result<_, HttpError>`. `?` only: no `match` on errors, no `map_err`, no error status codes. |
| 17 | Entities never serialized              | Entities and VOs never derive `Serialize` / `Deserialize`. The use case maps with `impl From<&Entity> for Output`. |
| 18 | Authn in middleware, authz in use case | `authenticate` layer + `CurrentUser` extractor in `infra/http/middleware/auth.rs`; `actor_id` in the use case Input. |
| 19 | Self-audit before done                 | The 3 gates below. `--no-verify` is forbidden. So is silencing a gate with `#[allow(..)]` — fix the code, or stop and ask. |

---

## 7. Self-audit gates

```bash
cargo fmt --all -- --check                                  # Gate 1 — format
cargo clippy --workspace --all-targets -- -D warnings       # Gate 2 — compile + lint
node <skill>/scripts/check-architecture-rust.mjs            # Gate 3 — structure
```

Or all three at once, from the backend root or from a monorepo root that contains `backend/` or `apps/backend/`:

```bash
node <skill>/scripts/run-gates.mjs
```

Why only three: Cargo already rejects cross-layer imports and circular crate dependencies, and clippy includes the type check.

The workspace lints the gates rely on are in the starter's `Cargo.toml` and `clippy.toml`: `unsafe_code = "forbid"`, clippy `unwrap_used`, `expect_used`, `todo`, `dbg_macro` denied (allowed in tests), and `std::env::var*` disallowed outside `config.rs`.

---

## 8. Where this layout comes from

It combines two public reference projects and tightens both:

- **[flosse/clean-architecture-with-rust](https://github.com/flosse/clean-architecture-with-rust)** — one crate per circle, with Cargo enforcing the dependency rule; one file per use case carrying its own request and response types; `Id<T>` typed by a phantom parameter. Taken as the default layout. Its separate `adapter` and `infrastructure` circles are merged into `infra`, and its repository traits move from the application crate into `domain`, to match the rest of this skill.
- **[eldimious/rust-api-ddd](https://github.com/eldimious/rust-api-ddd)** — a single crate with feature folders inside each layer, repository trait in the domain, a row struct mapped to the model with `From`, `sqlx` on PostgreSQL, wiring in `main.rs`. Taken as the single-crate variant and as the persistence pattern.

Where this skill is stricter than those projects: entities have private fields and factories (not public-field structs); one use case per struct (not a service with many methods); the domain never sees `sqlx` or HTTP types, even through a shared error enum; ports are injected as `Arc<dyn Trait>` so handler signatures never name a concrete repository; and the environment is read in one module, not through a global.

---

## Cross-references

- `domain-modeling.md` — entities, value objects, IDs, errors.
- `use-cases-and-ports.md` — use case shape, DTOs, repository / queries / gateway traits.
- `infra-axum-sqlx.md` — handlers, error mapping, auth, sqlx repositories, composition root.
- `messaging.md` — domain events, the outbox, Kafka / RabbitMQ / NATS / SQS producers and consumers.
- `anti-patterns.md` — what to avoid, and which gate catches it.
