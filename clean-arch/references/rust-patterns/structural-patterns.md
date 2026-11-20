# Rust — structural patterns

How Proxy, Decorator, Adapter, Facade, Composite, Flyweight and Bridge map onto this skill's layers. Most are either already part of the architecture (ports are the Bridge, gateways are Adapters, use cases are Facades) or are covered by a language feature. This file says which is which, and where each pattern is legitimate so you do not build it a second time.

| Pattern | In Rust | In this skill |
|---|---|---|
| Proxy | `LazyLock`, `pub` visibility, smart pointers | Module visibility for access control; no hand-written proxy |
| Decorator | Wrapper struct implementing the same trait | A **port decorator** in `infra` (cache, metrics); cross-cutting HTTP concerns as middleware, not use-case wrappers |
| Adapter | Wrapper + trait, `From` / `Into`, newtype | **Gateways** and **row mapping**: the external shape stays in `infra` |
| Facade | `pub use`, a struct owning subsystems | The **use case** (for the handler) and the **crate / `mod.rs` re-exports** |
| Composite | Recursive `enum` with `Box`, or trait objects | `enum` for closed trees; trait objects only when extension is required |
| Flyweight | `const`, `Arc`, `Cow`, `Copy` | `Arc<Config>`, `Id<T>: Copy`, `&'static str` |
| Bridge | Abstraction holds `Arc<dyn Impl>` | **Ports.** The use case is the abstraction, the `infra` adapter is the implementation |

Related: `designing-for-rust-not-oo.md` (why traits are contracts, not base classes), `ownership-clone-and-smart-pointers.md`, `creational-patterns.md`.

---

## 1. Proxy: the language already covers it

| Proxy use | Rust mechanism |
|---|---|
| Lazy initialization | `LazyLock` (`LazyCell` single-threaded). For a compiled `Regex` or a lookup table only; not for a pool or config (rule 11) |
| Access control | Visibility: `pub`, `pub(crate)`, `pub(super)`. Private fields on entities are the proxy (rule 6) |
| Ownership / sharing | `Box`, `Arc` |
| Remote access | A port + an adapter (§ 2) |

Do not use `Deref` to build a proxy (O3 in `designing-for-rust-not-oo.md`). In the rare case none of these fit, a proxy is a decorator (§ 2).

---

## 2. Decorator: wrap a port, not a use case

A decorator implements the same trait as the thing it wraps, holds the inner one, and adds behavior before or after. In this architecture the thing that varies by implementation is the **port**, so that is where a decorator belongs.

### Port decorator (infra)

```rust
// crates/infra/src/queries/user/caching_user_queries.rs
pub struct CachingUserQueries {
    inner: Arc<dyn UserQueries>,
    cache: tokio::sync::RwLock<HashMap<UserId, UserSummary>>,   // lock lives inside the adapter
}

#[async_trait]
impl UserQueries for CachingUserQueries {
    async fn get(&self, id: UserId) -> Result<Option<UserSummary>, AppError> {
        if let Some(hit) = self.cache.read().await.get(&id) { return Ok(Some(hit.clone())); }
        let found = self.inner.get(id).await?;
        if let Some(ref s) = found { self.cache.write().await.insert(id, s.clone()); }   // read guard dropped above
        Ok(found)
    }
    // the remaining methods delegate to `self.inner`
}
```

Composed in `main.rs` (the composition root, `../architecture/infra-axum-sqlx.md` § 6):

```rust
let queries: Arc<dyn UserQueries> =
    Arc::new(CachingUserQueries::new(Arc::new(PgUserQueries::new(pool))));
```

Properties to preserve:

- **Transparent.** The use case receives `Arc<dyn UserQueries>` and cannot tell. No use case changes.
- **Order matters.** `Logging(Caching(Pg))` logs cache hits; `Caching(Logging(Pg))` logs only misses. Decide on purpose and say so in a comment at the wiring line.
- **Interior mutability is legitimate here.** The port takes `&self`, so a cache needs a lock. It stays inside the `infra` type and is never visible to the use case (`ownership-clone-and-smart-pointers.md` § 2). Take the guard, copy what you need, drop it, then `.await`; do not hold a `std::sync::Mutex` across an await (C6).
- **Cache invalidation is a design decision.** Decorate **read** ports (`FeatureQueries`) freely. Decorating a repository's `find_by_id` is risky because the use case then reads stale state before a write. If you must, invalidate in `save` and `delete`.
- **Keep the in-memory fake behaviorally in step.** The fake does not need the decorator; it is the thing under test.

### Cross-cutting concerns that are NOT decorators

| Concern | Use |
|---|---|
| Authentication | `authenticate` middleware + `CurrentUser` extractor (rule 18) |
| Request logging, timing, tracing | A tower layer (`TraceLayer`, a timing layer) on the router |
| Error → HTTP mapping | `HttpError: IntoResponse` (rule 16) |
| Authorization | In the use case, with `actor_id` in the Input (rule 18) |

### Do not

- **Wrap use cases** in `LoggingUseCase<T>` / `TimedUseCase<T>`. Each use case has its own `execute` signature, so there is no shared trait to decorate (rule 10, O2), and a generic wrapper brings back generic ports (R12).
- **Add `evaluate_with_logging` / `evaluate_with_caching` methods** to a trait. That is the combinatorial explosion the pattern exists to avoid.
- **Use decorators when the combination is known at compile time and needs no runtime stacking.** A plain function or a generic is simpler.

**Violates rules 10 and 11** when a use case is wrapped or made generic to be decorated. Detection: `[usecase-single-execute]`, `[usecase-shape]`, `[usecase-generic-ports]`; wiring order is review.

---

## 3. Adapter: the gateway and the row

An adapter translates one interface into another. This skill has two.

### 3a. Gateways (external systems)

The domain declares what it needs in its own words; `infra` implements it by wrapping an SDK or HTTP client and translating everything: types, units, errors.

```rust
// domain: crates/domain/src/transcription/transcription_gateway.rs
#[async_trait]
pub trait TranscriptionGateway: Send + Sync {
    async fn transcribe(&self, audio: &[u8], language: Language) -> Result<Transcript, AppError>;
}

// infra: crates/infra/src/gateway/openai_transcription_gateway.rs
pub struct OpenAiTranscriptionGateway { client: reqwest::Client, api_key: String }

#[async_trait]
impl TranscriptionGateway for OpenAiTranscriptionGateway {
    async fn transcribe(&self, audio: &[u8], language: Language) -> Result<Transcript, AppError> {
        let resp = self.client.post(URL)/* … */.send().await.map_err(gateway_error)?;
        let body: OpenAiResponse = resp.json().await.map_err(gateway_error)?;
        Ok(Transcript::from_trusted(body.text))          // external shape ends here
    }
}
```

Rules:

- **The trait is in the domain's vocabulary** (`Transcript`, `Language`), never the vendor's (`WhisperResponse`). Switching vendors is one new adapter.
- **Translate errors at the edge.** A vendor error becomes `AppError::unexpected` (or a feature error); `reqwest::Error` and `sqlx::Error` never cross into `domain` / `usecase` (R3).
- **Translate units and conventions** (angle mode, timestamps, `NaN` → `Result`) inside the adapter. The book's `f64::ln()` returning `NaN` becomes an `Err`.
- **Secrets are constructor arguments** from `Config`; the adapter does not read the environment (rule 2).
- **One adapter per vendor.** If two vendors share a translation helper, extract it inside `infra`.

### 3b. Row mapping

`impl From<UserRow> for User` (calling `restore` and `from_trusted`) is an adapter between a table shape and the entity. The `sqlx::FromRow` derive lives on the row, never on the entity (`../architecture/infra-axum-sqlx.md` § 5, rule 15).

### Conversions: `From` / `Into` first

For a simple value conversion, a `From` impl beats an adapter struct:

```rust
impl From<Degrees> for Radians { fn from(d: Degrees) -> Self { Radians(d.0.to_radians()) } }
```

Reach for a full adapter struct when the adaptation holds **state**, spans several calls, or bridges two trait interfaces. The orphan rule (you cannot implement a foreign trait for a foreign type) is the usual reason for a local **newtype wrapper**.

**Violates rules 1, 2 and 9** when a vendor type leaks inward. Detection: `[forbidden-crate]`, `[env-outside-config]`.

---

## 4. Facade: the use case, and the re-exports

### The use case is the facade over the domain

A handler calls one `execute`. Behind it, the use case coordinates validation, the repository, other ports and the DTO mapping (`../architecture/use-cases-and-ports.md` § 1). The handler does not orchestrate; it never sees the repository or the pool (R18).

### Module and crate facades

`mod.rs` and `lib.rs` are facades by rule 4: declarations and named re-exports only.

```rust
// crates/domain/src/user/mod.rs
mod email_vo;
mod errors;
mod user_entity;
mod user_repository;

pub use email_vo::Email;
pub use errors::UserError;
pub use user_entity::{User, UserId};
pub use user_repository::{UserQueries, UserRepository};
```

Re-export **named** items. No `pub use errors::*;`, no logic, no types in `mod.rs` (R20). Use `pub(crate)` to keep items visible inside the crate but out of the public API.

### Do not

- **Build a `CalculatorFacade`-style god struct** with `evaluate`, `set_variable`, `get_history`, `calculate_quadratic`… That is R11 (the service with many methods) wearing a pattern's name. One use case per operation, each with one `execute` (rule 10).
- **Put pure functions on a facade as methods** (`&self` never used). Make them associated functions or free functions in the module that owns the concept.
- **Hide the subsystem so well that tests cannot reach it.** The in-memory fakes plug in at the port, below the use case, which keeps both the facade and the subsystems testable.

Facades **own** their dependencies (`Arc<dyn Trait>` fields, no lifetime parameters) so that a use case is `Send + Sync` and can sit in axum `State`.

**Violates rules 4 and 10.** Detection: `[mod-facade]`, `[usecase-single-execute]`.

---

## 5. Composite: prefer an enum

A tree whose nodes and leaves are handled uniformly. Two ways in Rust:

| | `enum Node { Leaf(..), Branch(Vec<Node>) }` | `trait Node` + `Box<dyn Node>` |
|---|---|---|
| Variants | Closed, known at compile time | Open; third parties can add |
| Dispatch | `match`, exhaustive | vtable |
| Decorating nodes | Add a variant | Wrap with any struct |
| This skill | **Default** (`designing-for-rust-not-oo.md` O5) | Only if you really need extension *and* decoration |

```rust
pub enum Category {
    Leaf { name: CategoryName },
    Group { name: CategoryName, children: Vec<Category> },    // Vec already boxes; a single child needs Box<Category>
}
```

Recursive types need indirection (`Box`, `Vec`) so the compiler can size them.

### Rules for the domain

- **A composite is one aggregate.** Its nodes are owned by the root and changed only through the root's methods (`&mut self`, rule 6).
- **Cross-aggregate links are ids, not nested nodes.** `Order` holds a `UserId`, never a `Box<User>` or `Rc<User>` (B2 in `borrow-checker-as-design-feedback.md`).
- **Keep the tree bounded.** Enforce depth or size in the root's method (an invariant), not in the caller. For very large trees, store parent ids or a closure table and query them (`FeatureQueries`) instead of loading the whole tree.
- **Parse text into a tree in one place**, a `FromStr` / parser function, not by hand-building `Box::new(..)` at every call site.
- **Persist with rows, not by serializing the entity** (rule 17): flatten to rows with a parent id, rebuild in `restore`.

---

## 6. Flyweight: share with `Arc`, `const`, `Copy`

| To share | Use |
|---|---|
| Compile-time constants, lookup tables | `const` / `static` (immutable data) |
| Immutable config read by many | `Arc<Config>` built in `main.rs`, cloned into constructors |
| Identifiers | `Id<T>: Copy`; no sharing needed |
| Strings usually static, sometimes dynamic | `Cow<'static, str>` or `&'static str` |
| Large read-only value shared across tasks | `Arc<T>` / `Arc<str>` |

**Not** a flyweight: a `OnceLock<Config>` read through `get_global_config()`. The book offers it; this skill does not allow a `static` holding a config (rules 2, 11; `creational-patterns.md` § 4). Pass the `Arc<Config>`.

Clone an `Arc` with `Arc::clone(&x)` so it reads as a cheap pointer copy.

---

## 7. Bridge: ports are the bridge

A Bridge separates an abstraction from its implementation so both can vary. That is exactly the hexagon:

| Bridge term | This skill |
|---|---|
| Abstraction | The use case (domain vocabulary) |
| Implementation interface | The port: `FeatureRepository`, `FeatureQueries`, a gateway trait |
| Concrete implementation | `PgUserRepository`, `OpenAiTranscriptionGateway`, in-memory fakes |
| The bridge | `Arc<dyn Port>` held by the use case, built in `main.rs` |

You get M abstractions × N implementations as M + N pieces. Do not add another layer of bridge between the use case and the port.

### Presentation: no M × N

The book's display bridge (results / errors × console / HTML / JSON) disappears here because the response is a format-agnostic **Output DTO**, and `Json(output)` is the single rendering. A second format is a second handler or an `Accept`-aware extractor, not a branch in the use case. The use case never knows the output medium.

### Strategy overlap

A struct that holds an `Arc<dyn Strategy>` and delegates is a Bridge or a Strategy depending on intent. In this skill both are ports. Do not add a generic `Evaluator<S: Strategy>` in front of a use case (R12).

### `dyn` or generics?

Use **`Arc<dyn Port>`** for ports (the concrete type is chosen at composition time in another crate; `designing-for-rust-not-oo.md` § 2). Use generics only inside one crate where the type is known at compile time and never mixed at runtime. Do not use generics to parameterize use cases by their repositories.

**Violates rule 11** when a use case is generic over its ports. Detection: `[usecase-generic-ports]` (R12).

---

## 8. Quick decision guide

1. **Want to add caching / metrics to a read?** → decorate the **port** in `infra`; wire it in `main.rs`.
2. **Want logging, auth or timing on every request?** → tower layer / middleware.
3. **Calling a vendor SDK?** → a gateway trait in `domain` (own vocabulary), adapter in `infra`, errors translated.
4. **Just converting a value?** → `From` / `Into` (a newtype for the orphan rule).
5. **Handler needs to coordinate several things?** → that is a use case. One `execute`.
6. **Tree-shaped data?** → an `enum` owned by one aggregate; links to other aggregates by id.
7. **Sharing immutable data?** → `Arc` / `const`, built in `main.rs`. No `static` config.
8. **Two things that vary independently?** → it is already a port + adapter. Do not add a bridge layer.

---

## Cross-references

- `../architecture/use-cases-and-ports.md` — § 1 (shape), § 3 (`Arc<dyn Trait>`), § 4 (repository / queries / gateway).
- `../architecture/infra-axum-sqlx.md` — § 5 (row mapping, fakes), § 6 (composition root).
- `../architecture/workspace-layout.md` — § 4 (`mod.rs` facades).
- `designing-for-rust-not-oo.md`, `ownership-clone-and-smart-pointers.md`, `borrow-checker-as-design-feedback.md`, `creational-patterns.md` — the companions.
- `../architecture/anti-patterns.md` — R3 (infra types in the shared error), R11 (service with many methods), R12 (generic ports), R18, R20 (logic in `mod.rs`).

Based on *Design Patterns and Best Practices in Rust* (Packt), ch. 6, "Structural Patterns: Connecting and Aggregating Components."
