# Rust — patterns from the core language

The "furniture" of Rust: **`Result` and `Option`**, **block expressions**, and **RAII** (`Drop` guards). You use them in every function, so the question is not whether to use them but how to use them *well* in a layered backend: how failure and absence flow between layers, what a block is good for, and which cleanup Rust already does for you.

| Pattern | In this skill |
|---|---|
| `Result` / `?` | Every fallible function returns `Result<_, AppError>` (or a feature error); `?` propagates; `map_err` converts at the adapter edge |
| `Option` | Absence is not an error: `find_by_id -> Result<Option<Entity>, AppError>`; the use case turns `None` into `NotFound` |
| Smart constructors | `Vo::create(raw) -> Result`, `TryFrom`; the only way to build a type with an invariant |
| Blocks | Scoped initialization, and **ending a borrow or guard before an `.await`** |
| RAII | `sqlx` transactions and pooled connections already roll back / return on drop. Do not hand-roll them |

Related: `../architecture/domain-modeling.md` § 4 (`AppError`, `ErrorKind`, per-feature enums), `type-system-patterns.md` § 2 (parse, don't validate), `ownership-clone-and-smart-pointers.md` (locks, C6), `functional-patterns.md`.

---

## 1. `Result` and `Option`

Errors and absence are **values** in the signature, not exceptions and not nulls.

### How failure flows through the layers

```
sqlx::Error ──map_err──► AppError::unexpected(source)        (infra, at the edge)
UserError::NotFound ─────► (domain error, feature-specific)   (usecase / domain)
        │            `?`
        ▼
HttpError ──IntoResponse──► status code + body               (infra/http, one place)
```

- **Adapters convert once, at the edge** (`db_error`, `gateway_error`): a vendor error becomes `AppError` and keeps the original as `source`. Callers upstream see only domain errors.
- **Use cases and handlers just use `?`.** A handler has no `match` on errors and no `map_err` (rule 16).
- **Domain functions return the feature's error enum** (`UserError`); `AppError` is the cross-layer type with an `ErrorKind` (`Invalid`, `NotFound`, `Conflict`, …).

### Option vs Result

| The situation | Type |
|---|---|
| A lookup that may legitimately find nothing | `Option<T>` inside a `Result`: `Result<Option<User>, AppError>` |
| A required value that must exist | `Result<T, FeatureError>` with a `NotFound` variant |
| A value that may be absent by design (optional field) | `Option<T>` on the entity / DTO |

The use case bridges them: `repo.find_by_id(id).await?.ok_or_else(|| UserError::NotFound(id.to_string()))?`. Prefer `ok_or_else` (lazy) to `ok_or` when building the error allocates.

### Combinators, in one line each

`map` (transform the value), `and_then` (chain a fallible step), `map_err` (convert the error), `ok_or_else` (`Option` → `Result`), `or_else` (alternative on failure), `filter`, `unwrap_or_else(f)` (lazy default), `?` (return early). `collect::<Result<Vec<_>, _>>()` stops at the first error.

### Rules

- **Never drop the cause.** The book's `.map_err(|_| SamsaError::config("Configuration file not found"))` labels every I/O failure (permission denied, is a directory, a bad path) as "not found" and discards the real error. Keep it: `AppError::unexpected(e)` carries it as `source`; a feature error variant can hold it with `#[source]`.
- **Do not swallow errors.** `result.ok()`, `let _ = …`, and `filter_map(|r| r.ok())` throw failures away. If dropping an error is intentional (best-effort cleanup), write a comment and log it with `tracing::warn!`.
- **No `unwrap()` / `expect()` / `todo!()` in production code** (rule 19, R10). The book's `NonZeroUsize::new(4096).unwrap()` is avoidable at compile time:

```rust
const DEFAULT_BUFFER: NonZeroUsize = match NonZeroUsize::new(4096) { Some(n) => n, None => panic!("non-zero") };
```

- **`unwrap_or(default)` is safe from panics but not from mistakes.** `env::var("PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(8080)` turns `PORT=80a` into 8080 and hides the typo. Separate **absent** from **invalid**:

```rust
fn port_from_env() -> Result<NonZeroU16, ConfigError> {
    match env::var("APP_PORT") {
        Err(env::VarError::NotPresent) => Ok(DEFAULT_PORT),                 // absent: default
        Err(e) => Err(ConfigError::unreadable("APP_PORT", e)),             // present but not unicode
        Ok(raw) => raw.parse().map_err(|_| ConfigError::invalid("APP_PORT", &raw)),   // invalid: fail at startup
    }
}
```

  Defaults apply to *absent* values only; invalid ones stop the program at startup (`type-system-patterns.md` § 2). Reading the environment stays in `config.rs` (rule 2).
- **Fallback chains fall back only on the expected failure.** The book's `load_from_file(a).or_else(|_| load_from_file(b)).or_else(|_| Ok(default))` falls back to defaults even when a file exists but is **malformed**. Fall back on "file not found" and report a parse error.
- **`?` needs a `From` conversion** between error types: implement `From<sqlx::Error>` for `AppError` only in `infra`, never in `domain` (R3).
- **No `eprintln!` / `println!` for diagnostics** in library code. Use `tracing` in `infra` / `app`.

**Violates rules 16 and 19.** Detection: `[handler-no-error-mapping]`, clippy `unwrap_used` / `expect_used`; swallowed errors are review.

### Batches: decide the failure policy, then make it visible

A use case that processes many items (import, bulk create) has three honest policies. Pick one and encode it in the Output:

| Policy | Code |
|---|---|
| **All or nothing** | `items.into_iter().map(process).collect::<Result<Vec<_>, _>>()?` (one transaction in the repository) |
| **Partial success, report failures** | A plain loop that pushes to `succeeded` and `failed: Vec<ItemError { index, error }>`; both go in the Output DTO |
| **Stop at the first error** | `try_fold` / `?` in a loop |

The book's "partial success" function ends with `.filter_map(|result| result.ok())` before the fold, so **validation errors are discarded** and only conversion errors are ever collected; its pre-filter also drops obvious bad topics silently. Do not do that: each rejected item must appear in the failures list with the reason.

### Typed stages: parse instead of wrapping

The book models a pipeline as `RawMessage → ValidatedMessage(RawMessage) → TransformedMessage → ProcessedMessage`. The idea (each stage is a type, you cannot skip one) is right, but `ValidatedMessage(RawMessage)` only wraps the raw struct, so its fields are still raw strings. Parse into typed fields (`Topic`, `Payload`) at the first stage (`type-system-patterns.md` § 2); later stages then take parsed types. Generate ids with `Id::generate()` and take time from `Utc::now()`, not `rand::random()` and `SystemTime` (the latter `.unwrap()`s in the book's earlier examples).

---

## 2. Smart constructors

A smart constructor is the only way to build a type, and it validates:

```rust
pub struct Topic(String);

impl Topic {
    pub fn create(raw: &str) -> Result<Self, TopicError> {
        let value = raw.trim();
        if value.is_empty()                       { return Err(TopicError::Empty); }
        if value.len() > MAX_LEN                  { return Err(TopicError::TooLong(value.len())); }
        if !value.chars().all(is_topic_char)      { return Err(TopicError::InvalidChars); }
        Ok(Self(value.to_owned()))
    }
    pub fn as_str(&self) -> &str { &self.0 }
}
```

This is the value object of `../architecture/domain-modeling.md` § 2. Points specific to constructors:

- **Take `&str`** (or `impl AsRef<str>`) so callers do not allocate; copy once inside after validation.
- **Variants say what failed** (`Empty`, `TooLong(n)`, `InvalidChars`), so the HTTP mapper and tests can distinguish them. A `String` message does not.
- **`TryFrom<Raw>` for conversions between types** (`impl TryFrom<ValidatedRequest> for ActiveSubscription`). The book's `try_from` that cannot fail still returns `Result`; if nothing can fail, use `From`.
- **`from_trusted` for rehydration only** (rows already parsed).

---

## 3. Block expressions

A `{ … }` block evaluates to its final expression (no trailing `;`). Two uses are worth the habit.

### Scoped initialization

Keep temporary names out of the surrounding scope, and make the intent a single binding:

```rust
let pool = {
    let options = PgPoolOptions::new().max_connections(config.db_max_connections());
    options.connect(config.database_url()).await?
};
```

`if`, `else`, `match` and `loop … break value` are expressions too: `let status = if user.is_suspended() { Status::Suspended } else { Status::Active };`. `let … else` keeps the happy path flat: `let Some(user) = found else { return Err(UserError::NotFound(id)) };`.

### Ending a borrow or a guard *before* the next step

This is the most useful block in a backend. A lock guard or a borrow lives until the end of its scope; a block ends it early:

```rust
let cached = {
    let guard = self.cache.read().await;      // tokio lock
    guard.get(&id).cloned()                   // copy what you need
};                                             // guard dropped here
if let Some(hit) = cached { return Ok(hit); }
let loaded = self.inner.get(id).await?;        // no lock held across this await
```

It is the idiom behind "take the lock, copy, drop, then `.await`" (C6 in `ownership-clone-and-smart-pointers.md`) and behind splitting a read phase from a write phase (`borrow-checker-as-design-feedback.md` § 2).

### Rules

- **Do not hide control flow in blocks.** A handler stays a few lines (rule 16); a use case follows its fixed order (`../architecture/use-cases-and-ports.md` § 1). Use a block to scope, not to nest.
- **Build-then-validate is the wrong order.** The book constructs `BrokerService` and then calls `service.validate()?`. Validate (parse) the inputs first so the constructed value is valid by construction.
- **Do not clamp silently.** The book's `match secs { 0 => 30, t if t > 300 => 300, t => t }` turns bad input into a plausible value. For user or configuration input, reject it; clamp only an internal, documented default.
- **A block that returns early with `return`/`?` exits the whole function**, not just the block. That is correct, but keep such blocks short so it is obvious.

---

## 4. RAII: cleanup that Rust does for you

`Drop` runs when a value goes out of scope, on every exit path (normal return, `?`, panic). Guards wrap that: `MutexGuard`, `RwLockReadGuard`, a `sqlx` `Transaction`, a pooled connection.

### What you already get

| Resource | Behavior | Do not |
|---|---|---|
| `PgPool` connection | Returned to the pool on drop | Write a `ConnectionGuard` / pool of your own |
| `sqlx` `Transaction` | Rolls back on drop unless you called `commit()` | Write a `TransactionGuard` that tracks `committed` |
| `MutexGuard` / `RwLock*Guard` | Releases on drop | Wrap it in a "timed" guard with `thread::sleep` polling |
| Files, sockets | Closed on drop | Add manual `close()` calls as the only cleanup |

The book's `ConnectionGuard`, `TimedLockGuard` and `TransactionGuard` are teaching examples of what the libraries already provide.

### Transactions in this layout

An aggregate save that touches several tables opens its transaction **inside** the repository implementation (`pool.begin()`, then `commit()`); the use case never sees it (`../architecture/use-cases-and-ports.md` § 9). Dropping the `Transaction` on an early `?` rolls it back, which is the RAII guarantee. Passing a transaction across `Arc<dyn Trait>` ports is a design decision to agree with the user first; the starter ships no Unit of Work.

### Rules for `Drop`

- **`Drop` is synchronous and must not fail or block.** No `.await`, no `thread::sleep`, no panics. In async code, do cleanup with an explicit `async fn shutdown(self)` and call it; keep `Drop` as a backstop that only releases cheap resources.
- **Do not swallow shutdown errors in `Drop`.** The book's `let _ = service.shutdown();` ignores a failure. Shut down explicitly in `main` (axum's `with_graceful_shutdown`), log the result, then let drops run.
- **Do not log with `eprintln!` in `Drop`.** Use `tracing`.
- **Domain types do not implement `Drop`.** Entities and value objects hold no resources; if one seems to need cleanup, the resource belongs in an `infra` adapter.
- **Never hold a guard across `.await`** (§ 3 block, or use `tokio::sync` primitives).
- **A lock timeout is `tokio::time::timeout(d, mutex.lock())`** with a tokio mutex, not a busy-wait loop with `std::thread::sleep(1ms)`, which blocks the executor thread.
- **`mem::forget` and leaked `Arc` cycles skip `Drop`.** Avoid reference cycles (`behavioral-patterns-actions.md` § 4).

**Violates rules 11 and 19** when a hand-rolled guard replaces the library one or `Drop` swallows errors. Detection: review; clippy `unwrap_used` for panics.

---

## 5. Putting them together

The book's conclusion is that these compose: parse input with smart constructors (`Result`), look things up (`Option` → `ok_or_else`), transform with iterator chains, scope with blocks, and let RAII release resources. A typical use case body:

```rust
let email = Email::create(&input.email)?;                                    // smart constructor
let user = {                                                                   // scoped
    let existing = self.user_repo.find_by_email(&email).await?;               // Result<Option<_>>
    if existing.is_some() { return Err(UserError::EmailTaken(email.to_string()).into()); }
    User::create(email)
};
self.user_repo.save(&user).await?;                                            // transaction inside, RAII
Ok(CreateUserOutput::from(&user))
```

---

## 6. Quick decision guide

1. **Can this fail?** → `Result<_, FeatureError>` / `AppError`; `?` to propagate.
2. **Can the value legitimately be missing?** → `Option`; the use case converts to `NotFound` with `ok_or_else`.
3. **Converting a library error?** → `map_err` once, in `infra`, keeping the source.
4. **Environment or file config?** → absent → default; invalid → startup error. Never `ok().unwrap_or()` an invalid value.
5. **Processing a batch?** → pick all-or-nothing or partial success, and put failures in the Output.
6. **Holding a lock or a borrow?** → end it with a block before the next `.await`.
7. **Cleanup needed?** → check whether `sqlx` / `tokio` already does it on drop; async cleanup is an explicit `shutdown().await`.

---

## Cross-references

- `../architecture/domain-modeling.md` — § 2 value objects, § 4 `AppError`, `ErrorKind`, feature enums.
- `../architecture/infra-axum-sqlx.md` — § 2 the central error mapper, § 5 repositories and `db_error`, § 6 composition root and config.
- `../architecture/use-cases-and-ports.md` — § 1 (order inside `execute`), § 9 (multiple writes, transactions).
- `type-system-patterns.md` — parse, don't validate, config validation.
- `ownership-clone-and-smart-pointers.md` — C6 (lock across `.await`).
- `../architecture/anti-patterns.md` — R3 (infra types in the shared error), R4 (env outside `config.rs`), R10 (panicking), R16 (error handling in the handler).

Based on *Design Patterns and Best Practices in Rust* (Packt), ch. 12, "Patterns Emerging from Rust's Core Features."
