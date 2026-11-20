# Rust — architectural principles

Four principles the language enforces and this skill's layout already encodes: **data flows downward**, **mutability stays contained**, **modules are interfaces**, **pack lightly**. They explain *why* the dependency rule, the one-`execute` use case, the facade `mod.rs` and the `Arc<dyn Trait>` ports look the way they do. Use this file as a check when a design feels tangled: find the principle being broken.

| Principle | Where it shows up here |
|---|---|
| Data flows downward | `handler → use case → port → infra`; arrows point inward (rule 1); results return as values, never via callbacks |
| Mutability stays contained | `&mut self` on entities for one `execute`; shared mutation only inside an `infra` adapter |
| Modules are interfaces | Crates and `mod.rs` facades (rule 4); ports as traits; private by default |
| Pack lightly | Small structs, one use case per file, no god `AppState`; borrow or move, do not clone |

Related: `borrow-checker-as-design-feedback.md` (the same ideas as fixes for compiler errors), `ownership-clone-and-smart-pointers.md`, `structural-patterns.md`, `behavioral-patterns-actions.md`.

---

## 1. Data flows downward

Data moves in one direction through the layers, and each layer depends only on what is below or inside it.

```
HTTP request
   │  deserialize (serde)               infra/http      Input DTO
   ▼
use case ── execute(input) ─────────────► usecase
   │  load / save through ports          domain traits   (Arc<dyn Port>)
   ▼
adapter (sqlx, gateway) ─────────────────► infra
   │
   ▲  the result comes back as a **return value**: Output DTO, never a callback
```

### Rules

- **Inputs go down, results come back as return values.** A use case returns `Result<Output, AppError>`; it does not call back into the handler, a UI or a channel it was handed.
- **No back-references.** An inner type never holds a reference to an outer one. `domain` does not know `usecase`; `usecase` does not know `infra`; an entity does not hold the request or the repository (rule 1, `../architecture/workspace-layout.md`).
- **Separate user data from broker metadata.** The book's `Message` (what the producer sends) versus `Event` (the same plus an offset added by the broker) is the Input DTO versus the persisted/event shape: the caller sends what it knows, the system adds ids, timestamps and ordering (`Id::generate()`, `Utc::now()` inside the domain).
- **Immutable once created while in transit.** An Input or Output DTO is built once and moved; no layer edits it on the way. Do not give DTOs setters, and do not pass `&mut` to them across layers.
- **A second direction is a second downward channel.** When something must flow "back" (a consumer acknowledgment, a status update), do not give the lower layer a handle to the upper one. Use a separate port or a domain event the upper layer consumes (`behavioral-patterns-keeping-track.md` § 4).
- **One owner at a time.** Each value is built in one place, moved down, and dropped; no layer shares ownership of it (`ownership-clone-and-smart-pointers.md` § 1).

### Why it matters

Debugging has a direction (the bug is upstream of where it shows), each layer is tested by feeding it inputs from above, and the borrow checker has nothing to object to. If you find yourself adding `Rc<RefCell<_>>` or a callback to get data "back up", the flow is wrong, not the types.

**Violates rule 1.** Detection: Cargo rejects a cross-layer crate dependency (`[crate-deps]`); single-crate `[layer-import]`; callbacks and back-references are review.

---

## 2. Mutability stays contained

Mutation happens in a few named, visible places. Everywhere else the data is read-only.

| Where mutation is allowed | Why it is safe |
|---|---|
| An **entity**, through `&mut self` methods named after the business operation | One owner (the use case), for one `execute`; the signature shows it (rule 6) |
| A **local variable** inside a function | Scope is tiny |
| An **`infra` adapter that genuinely shares state** across requests (a cache, a rate limiter, an in-process queue, the in-memory test fake) | The lock is inside the adapter, behind a `&self` port; callers never see it |
| **The database** | The real shared mutable state, behind a repository port |

Everything else: DTOs, value objects, config, ports (`Arc<dyn Trait>`) are immutable after construction.

### Rules

- **Mutation is explicit in the signature.** Read operations take `&self`; changes take `&mut self` (or `self` to consume). A query that locks and mutates behind `&self` is the exception and lives in `infra`.
- **No setters.** Constructors plus named operations (`create`, `restore`, `suspend`), then read-only getters (rule 6, R7).
- **`Arc<Mutex<_>>` is right when the thing is genuinely concurrent**: many tasks share it and mutate it. A broker, a cache and a fake repository qualify. It is wrong as a way to silence the borrow checker in single-owner code (`ownership-clone-and-smart-pointers.md` C5). Ask: *do I have a concrete reason (several tasks mutating the same value)?* If yes, keep the lock inside one adapter; if not, redesign the ownership.
- **Pick one lock order, or use one lock.** The book's broker takes `storage` then `offsets` in one version and `offsets` then `storage` in another. Two code paths that take the same two locks in opposite orders can deadlock. Put related state under **one** lock, or document and keep a single acquisition order.
- **Do not hold a `std::sync::Mutex` across `.await`**; take it, copy what you need, drop it, then await (C6).
- **Never `.unwrap()` a lock.** Map `PoisonError` to `AppError::unexpected`; rule 19 denies `unwrap_used`. The book itself notes the repository version uses `map_err`.
- **Bound anything that grows.** An in-memory structure that accumulates without limit (the book's unbounded `Storage`) needs a cap, expiry or backpressure. Read paths here use pagination (rule 13); caches need a size or TTL.

**Violates rules 6 and 11.** Detection: `[no-setters-in-domain]`, `[no-interior-mutability]` (a lock in `domain` / `usecase`), `[no-global-state]`, clippy `unwrap_used`; lock ordering and unbounded growth are review.

---

## 3. Modules become interfaces

The module system is where architecture is physically enforced. This skill uses three nested levels:

| Level | Mechanism | Enforces |
|---|---|---|
| **Layer** | Cargo workspace crates `domain ← usecase ← infra ← app` | The dependency rule; a wrong `use` does not compile (rule 1) |
| **Feature** | A folder per feature, mirrored across crates (rule 3) | Cohesion: everything about `user` is findable under `user/` |
| **File** | One artifact per file; private by default (`pub` only what other modules need) | Encapsulation |

### Public surface = the facade

`lib.rs` and `mod.rs` re-export a **named, minimal** API; the rest stays private (rule 4):

```rust
// crates/usecase/src/user/mod.rs
mod create_user;
mod get_user;

pub use create_user::{CreateUserInput, CreateUserOutput, CreateUserUseCase};
pub use get_user::{GetUserInput, GetUserOutput, GetUserUseCase};
```

- **Private modules, selected re-exports.** Callers cannot reach implementation modules; internals can be reorganized without breaking them.
- **Visibility ladder:** private → `pub(super)` → `pub(crate)` → `pub`. Start at the lowest that compiles.
- **No logic in `mod.rs`** (R20) and no catch-all `common` / `utils` (R21).

### Interfaces are traits in the inner layer

A port is a trait declared in `domain` and implemented in `infra`. Hide the concrete type behind it and build it in one place:

```rust
// domain
#[async_trait]
pub trait UserRepository: Send + Sync { /* find_by_id, save, delete */ }

// app/main.rs: the only place that names the concrete type
let user_repo: Arc<dyn UserRepository> = Arc::new(PgUserRepository::new(pool.clone()));
```

The book's `create_storage() -> Box<dyn StorageBackend<..>>` factory is the same idea; here the composition root is that factory.

### Where this skill differs from the book's trait

- **Errors: use `AppError`, not an associated `type Error`.** The book's `StorageBackend` exposes `type Error: Display`, so every caller is generic over the backend's error. Ports return the shared `AppError` (or a feature error), and the adapter converts its own error at the edge (`R3`). Associated types on ports leak implementation into callers.
- **`Send + Sync` on ports.** They are shared as `Arc<dyn Trait>` across tasks, so the bound is required. The book notes its `Box<dyn StorageBackend>` is not `Send` and relies on a mutex; with async ports the bound belongs on the trait.
- **`Arc<dyn>`, not `Box<dyn>`**, because use cases are cloned into axum state (`../architecture/use-cases-and-ports.md` § 3).

### Benefits you should be able to test for

Clear boundaries (a feature folder is deletable), encapsulation (no outside `use` of a private module), testability (swap the in-memory fake behind the port), extensibility (a new adapter is one new file).

**Violates rules 1, 3 and 4.** Detection: Cargo (`[crate-deps]`), `[mod-facade]`, `[naming-suffix]`, `[port-send-sync]` (a port without `Send + Sync`), `[anyhow-only-in-app]` (an untyped error in a library crate).

---

## 4. Pack lightly

Small, focused types are easier to borrow, test and reason about than one large one.

### Split by how data is accessed

The book's `HeavyBroker` (messages + metrics + configs in one struct) forces every method through one `&mut self`. The fix is independent components, each with the synchronization it needs:

```rust
// ❌ one object, one lock scope
pub struct HeavyService { messages: Messages, metrics: Metrics, config: Config }

// ✅ independent parts, composed
pub struct PublishUseCase {
    messages: Arc<dyn MessageRepository>,   // write path
    metrics:  Arc<dyn Metrics>,             // fire-and-forget
}
```

Note on accuracy: inside **one function**, Rust lets you borrow two *different fields* of a struct mutably at once (`&mut self.a` and `&mut self.b`). The conflict appears when you call a **method** taking `&mut self` (it borrows the whole struct) while holding a borrow of a field. Splitting into separate types avoids that and also makes each part testable alone.

### In this layout

- **One use case per file, one `execute`** (rule 10). No `UserService` with fifteen methods (R11).
- **Handlers extract only what they need.** Each handler takes `State<Arc<TheUseCase>>`, not a god `AppState` that carries the whole application. If you share a state struct, keep it a plain bag of `Arc<UseCase>` fields and extract the one a route needs (`FromRef` or per-route state).
- **Entities hold only their own data.** A `User` does not carry the pool, the config or another aggregate; it holds ids (`UserId`) of related aggregates.
- **Config is immutable**, so it needs no `RwLock`. The book uses `Arc<RwLock<Configs>>` for "read often, write rarely" data; config that is read at startup is `Arc<Config>`. Reserve `RwLock` for data that really changes at runtime.
- **Read models are their own types** (`UserSummary`), separate from the entity, so a list does not load or borrow the whole aggregate (rule 13).

### Zero-copy views: inside a scope, not across layers

A borrowed view (`MessageView<'a> { topic: &'a str, value: &'a [u8] }`) avoids copying when a reader stays inside one function and one owner:

- Good for: formatting, validating or hashing a value you already own, in one scope.
- Not for: DTOs that cross an `await`, a task boundary or a layer. An Output DTO is **owned** (`String`, `Vec<_>`) so the handler can return it after the use case's locals are gone. Lifetimes on DTOs spread to every signature that touches them.
- Cheap sharing across tasks is `Arc<T>` or `Arc<str>`, not a reference with a long lifetime.
- When a lifetime gets complicated, the simplest correct answer is one deliberate clone at the boundary (`ownership-clone-and-smart-pointers.md` § 3, step 5). Say why in a comment.

### Benefits

Fewer borrow conflicts, clearer ownership ("each component owns only what it needs"), flexible composition (reuse a port in another use case), and cheaper tests because each part is a small, fakeable dependency.

**Violates rules 10 and 11.** Detection: `[usecase-single-execute]`, `[usecase-shape]`; god state structs are review.

---

## 5. Applying the principles to a feature

When reviewing or designing a feature, ask in order:

1. **Flow.** Can you draw one arrow per step, all pointing inward? Does anything hand a callback or a reference to the layer above it?
2. **Mutation.** Which single place changes this state? Is the `&mut` visible in the signature? Is any lock inside an adapter, with one acquisition order?
3. **Boundaries.** What is the public surface of each module? Is anything `pub` that nothing outside uses? Does an adapter's error leak through the port?
4. **Weight.** Is each struct small enough that its borrows are obvious? Does a handler or use case depend on more than it uses? Are DTOs owned?

If a step fails, the cure is almost always the same: split the type, narrow the signature, move the lock inside the adapter, or return a value instead of a callback.

---

## Cross-references

- `../architecture/workspace-layout.md` — the crate layout and rules 1, 3, 4, 10, 11.
- `../architecture/use-cases-and-ports.md` — § 1 (shape and order), § 3 (`Arc<dyn Trait>`), § 4 (ports), § 7 (pagination).
- `../architecture/infra-axum-sqlx.md` — § 5 (adapters and fakes), § 6 (composition root).
- `borrow-checker-as-design-feedback.md`, `ownership-clone-and-smart-pointers.md` — the compiler-driven versions of these principles.
- `structural-patterns.md` (Facade, Decorator, Bridge), `behavioral-patterns-actions.md` (Mediator, Strategy), `behavioral-patterns-keeping-track.md` (Observer, State) — the patterns built on them.
- `../architecture/anti-patterns.md` — R5, R10–R12, R20, R21.

Based on *Design Patterns and Best Practices in Rust* (Packt), ch. 9, "Architectural Patterns."
