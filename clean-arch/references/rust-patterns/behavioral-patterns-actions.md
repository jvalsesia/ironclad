# Rust — behavioral patterns: taking action

How Command, Chain of Responsibility, Strategy, Mediator and Template Method map onto this skill's layers. In a stateless backend most of them are already the architecture (a use case *is* a command; middleware *is* a chain; a port *is* a strategy; the composition root and use cases *are* the mediator). This file shows where each one lives so you do not rebuild it in a heavier, stateful form.

| Pattern | In this skill |
|---|---|
| Command | A **use case**: Input DTO + `execute`. Undo is a domain operation; queued work stores the Input, not a trait object |
| Chain of Responsibility | **Middleware / tower layers**, the router, and sequential rule checks. Not a `Vec<Box<dyn Handler>>` of "try me" objects |
| Strategy | A **port** (chosen at composition time), an `enum` (closed set), or a closure / `fn` (tiny) |
| Mediator | The **use case** coordinating ports, the **composition root**, and **domain events**. Never `Arc<Mutex<dyn Mediator>>` |
| Template Method | A fixed sequence **in code** (`execute` order, phased functions). Not a trait whose default methods are "inherited" |

Related: `designing-for-rust-not-oo.md`, `ownership-clone-and-smart-pointers.md`, `borrow-checker-as-design-feedback.md`, `structural-patterns.md`.

---

## 1. Command: a use case is the command

The pattern encapsulates a request as a value you can name, validate, log, queue and sometimes reverse. Here that value is the **Input DTO**, and the operation is the use case:

```rust
pub struct SuspendUserInput  { pub actor_id: UserId, pub user_id: UserId }
pub struct SuspendUserUseCase { user_repo: Arc<dyn UserRepository> }
impl SuspendUserUseCase { pub async fn execute(&self, input: SuspendUserInput) -> Result<SuspendUserOutput, AppError> { … } }
```

Each use case has its own Input, Output and `execute`. There is **no common `Command` trait** with `execute`/`undo`/`description`: each command would have to share one signature, which is O2 in `designing-for-rust-not-oo.md`.

### Undo / redo

An in-memory `CommandProcessor` with `history: Vec<Box<dyn Command>>` and an `undo_stack` is client-session state. A backend serving many requests cannot hold it: it is lost on restart, not shared between instances, and it ends up as global mutable state (B4 in `borrow-checker-as-design-feedback.md`).

| Need | Do this |
|---|---|
| Reverse a business action | A **new use case** that is the inverse, with its own invariants (`SuspendUser` ↔ `ReinstateUser`). The entity method does the work (`suspend` / `reinstate`, rule 6). Reversal may be illegal in some states; the entity says so |
| Audit trail / "who did what" | Record an **event** (§ 4) or an append-only row, written in the same `save`. Do not reconstruct from a command stack |
| Interactive undo/redo (editor, calculator UI) | Client-side state, or a persisted **document history** modelled as its own aggregate: a `Vec` of snapshots plus a **position index** (B2), mutated through `&mut self` methods on the root |
| Queue work for later | Persist the **Input** (it is plain data, `Serialize` is fine on DTOs) in a jobs table; a worker deserializes it and calls the use case. Never persist an entity (rule 17) or a `Box<dyn Command>` |
| Macro / batch | A composite-flow use case in a named folder (`user_onboarding/`), not a list of boxed commands executed in a loop |

If the history is part of the domain (a document's revision list), push-after-undo must **truncate the redo branch**, and it belongs inside the aggregate, as in B2.

### Do not

- **Call one use case from another.** Use cases do not compose (`../architecture/use-cases-and-ports.md` § 10). Shared logic moves into the domain or behind a port.
- **Give a command a back-reference to the whole application state** (`execute(&mut self, calculator: &mut Calculator)`). Pass the narrow thing it needs: one entity, one port.
- **Make `execute` take `&mut self`.** A use case is stateless and shared as `Arc<UseCase>`; per-call state lives in locals and the Input.

**Violates rules 10 and 11.** Detection: `[usecase-single-execute]`, `[usecase-shape]`, `[usecase-stateless]` (`execute(&mut self)`), `[usecase-no-composition]` (a use case calling another); in-memory command processors are review.

---

## 2. Chain of Responsibility: middleware and rule sequences

A chain passes a request along handlers until one handles it. In this stack it already exists, in three places, and none is a hand-built `Vec<Box<dyn Handler>>`:

| Chain | Where | Notes |
|---|---|---|
| Request pipeline | tower layers: tracing → request id → `authenticate` → handler | Order is set where `.layer(..)` is applied. Each layer may short-circuit (401) |
| Routing | axum's router matches method + path to **one** handler | Never loop over handlers asking "is this yours?" |
| Input dispatch | `match` on an `enum` | A closed set of command kinds is an enum with an exhaustive `match`, not a chain of `try_handle` objects |
| Rule checking | A sequence of checks in the use case or domain | Each check returns `Result`; `?` short-circuits |

### The `Option<Result<_>>` signal

The book's handlers return `Option<Result<..>>`: `None` = decline, `Some(Err)` = claimed but failed, `Some(Ok)` = handled. That three-way signal is sound for a **parser or dispatcher**, where `?` on `split_once` or a regex capture declines cleanly. Keep it for a small, closed, internal tokenizer. Do not use it for request handling.

### Rules

- **Order is behavior.** Put the order in one place and comment why (`/undo` before variable assignment; function definitions before assignment because `f(x) = …` contains `=`). A test per ordering constraint.
- **A middleware does one thing** and delegates (`authenticate` authenticates; authorization stays in the use case, rule 18).
- **A fallback must be explicit.** The last link either handles everything or returns a typed "not recognized" error. An empty chain must not silently succeed.
- **Handlers are errors-as-values.** No `unwrap()` / `expect()` on parse or lock failures (rule 19).
- **A handler that reaches past the use case is wrong.** An axum handler that "chains" by calling the repository is R18.

**Violates rule 16** when a handler does error mapping or branching on error kind. Detection: `[handler-no-error-mapping]`, `[handler-shape]`.

---

## 3. Strategy: three shapes, pick by variability

| The variants are… | Use | Example |
|---|---|---|
| Chosen at startup, behind a seam, implemented in `infra` | A **port** held as `Arc<dyn Trait>` | `PasswordHasher`, `Clock`, a gateway |
| Pure domain policy, closed set, known at compile time | An **`enum`** + `match` | `Discount::{None, Percent(u8), Fixed(Money)}` |
| Pure domain policy, open set, no I/O | A **trait in the domain**, held as `Arc<dyn Policy>` | `PricingPolicy` selected by the composition root |
| A tiny one-off variation | A closure or `fn` pointer argument | A comparator, a retry predicate |

```rust
// domain: no I/O, so a strategy here is fine
pub trait PricingPolicy: Send + Sync { fn price(&self, base: Money, qty: u32) -> Money; }

// usecase: depends on the trait, not on a concrete policy
pub struct QuoteOrderUseCase { pricing: Arc<dyn PricingPolicy> }
```

### Rules

- **Select the strategy at composition time or from the Input**, not by mutating a shared calculator. The book's `set_strategy(&mut self, ..)` on a live object is global mutable state (rule 11): two concurrent requests would fight over it. A per-request choice is a field in the Input (`mode: EvaluationMode`) mapped to a strategy value, with the `match` in one place.
- **Strategies are stateless** (or immutable), so one `Arc` can serve all requests. If a strategy needs a cache, the lock lives inside it (`ownership-clone-and-smart-pointers.md` § 2).
- **Strategies take references** to what they evaluate (`&Expression`, `&Order`), not ownership, so one value can be run through several.
- **Keep selection and use separate.** The use case calls `self.pricing.price(..)`; it never asks which strategy it has.
- **Prefer `enum` over a trait when the set is closed.** It is exhaustive, needs no `Box`, and cannot be implemented elsewhere (`designing-for-rust-not-oo.md` O4).
- **`name()` / `description()` on a strategy for UI feedback is presentation**, not domain. Keep it out of the trait unless the domain really needs it.

**Violates rule 11** when selection mutates shared state or a use case is made generic over a strategy. Detection: `[usecase-generic-ports]` for a generic use case, `[no-global-state]` for a `static` strategy; a mutated shared field is review.

---

## 4. Mediator: don't build one; you already have three

The Mediator decouples components that would otherwise reference each other, by routing through a coordinator. The book's version (`Arc<Mutex<dyn CalculatorMediator>>`, components holding the mediator, the mediator holding `Option<Arc<Component>>`) is a **reference cycle**, plus a lock around everything, plus `lock().unwrap()` in every method. In Rust that means leaks (`Arc` cycles never drop), deadlocks, and panics on poison.

What this skill uses instead:

| Role of a mediator | Use |
|---|---|
| Coordinate several collaborators for one operation | The **use case**. It holds the ports it needs and calls them in order (`../architecture/use-cases-and-ports.md` § 1). That is its job |
| Decide which concrete parts exist and connect them | The **composition root** in `main.rs`: builds adapters once, injects them (rule 11) |
| Let part A react when part B changes, without B knowing A | A **domain event**: the aggregate records an event; after `save`, an application-level handler (or a job) reacts. The event type lives in `domain/shared/event.rs` (on the whitelist) |
| Share read-only state | `Arc<Config>`, a port; no mediator "get_variable" accessors |

### Events, not callbacks

```rust
// domain (in the aggregate's own file or event.rs): plain data
pub enum UserEvent { Registered { user_id: UserId, email: String } }

// the use case saves the aggregate, then publishes through a port
self.user_repo.save(&user).await?;
self.events.publish(UserEvent::Registered { user_id: user.id(), email: user.email().to_string() }).await?;   // port: Arc<dyn EventPublisher>
```

A second change that should "react" to the first is usually a **consumer of the event**, not a second write inside the same use case (`../architecture/use-cases-and-ports.md` § 9). Reaching for a Unit of Work is opt-in and needs the user's agreement first; the starter does not ship one.

### Rules

- **No component holds the thing that holds it.** If A needs B and B needs A, extract what they share (a third type, a port) or flip one to an event.
- **Never `unwrap()` a lock.** If a lock exists (inside an infra adapter), map poison to `AppError::unexpected` (C6).
- **Never hold a lock across `.await`.**
- **A use case that coordinates *many* features** goes in a named composite-flow folder (`usecase/user_onboarding/`), not in `shared/` or `common/` (R15).
- **Events are data.** They carry ids and facts, not entity references or closures.

**Violates rule 11** and, for `usecase/shared`, rule 3 (R15). Detection: `[usecase-forbidden-folder]`, `[no-interior-mutability]` (an `Arc<Mutex<..>>` mediator in `usecase`); reference cycles are review.

---

## 5. Template Method: a fixed sequence, not an inherited one

The pattern fixes the order of steps (tokenize → validate → parse → evaluate) and lets implementations supply some of them. In Rust the book does this with a trait whose `evaluate` is a default method calling other trait methods. That works **inside one trait**, but it is the part of the OO toolbox this skill avoids spreading:

- A default method on a **base trait** does not carry over to "sub-traits" (O1 in `designing-for-rust-not-oo.md`); each implementor still has to satisfy every trait it names.
- Calling an overridden default needs `<Self as Trait>::method(self, ..)`, because there is no "super". That is a sign the hierarchy is fighting you.

### What to write instead

1. **A fixed `execute`.** The sequence is the use case body, in the order given in `../architecture/use-cases-and-ports.md` § 1 (validate → read → decide → write → map). It is the template; the varying steps are ports.
2. **Phased functions** for pipelines inside one concern (§ 2 of `borrow-checker-as-design-feedback.md`):

```rust
pub fn evaluate(&self, input: &str, vars: &Vars) -> Result<f64, EvalError> {
    let tokens = tokenize(input)?;
    validate(&tokens)?;
    let tree = parse(tokens)?;          // consumes; the next phase owns it
    tree.evaluate(vars)
}
```

3. **Variation by injection.** If the parse step varies, pass it in (a closure, an `enum`, or an `Arc<dyn Parser>`) rather than overriding a trait method. Mix and match by composition (scientific tokenizer + shunting-yard parser) with plain fields.

### When a template trait is fine

A trait with required methods and **derived** default methods, where the defaults only call the required ones, is idiomatic (`Iterator`). A port may offer a default convenience such as `find_by_id_or_not_found` built on `find_by_id`. Keep defaults free of I/O and of policy; the repository contract stays `find_by_id`, `save`, `delete` (rule 14).

### Do not

- Put the algorithm's fixed order in a trait in `domain` and ask `infra` implementors to "fill in the blanks" in the middle of a use case. The use case stays in control.
- Interleave steps with `RefCell` caches to make a template compile.

**Violates rules 10 and 14** when a base trait carries the flow or a repository grows many default methods. Detection: review.

---

## 6. Quick decision guide

1. **Wrapping one user request as data?** → the Input DTO + use case. No `Command` trait.
2. **Need to reverse it?** → an inverse use case with its own invariants; for history, an aggregate with a position index.
3. **Need to run it later?** → persist the Input, not an entity or a trait object.
4. **Pipeline of "maybe-handlers"?** → tower layers for HTTP; `match` on an enum for a closed input set; `?` over a sequence of checks.
5. **Several ways to do one step?** → port (infra / composition-time), `enum` (closed domain policy), closure (tiny). Select per request from the Input, never by mutating a shared object.
6. **Components that know too much about each other?** → the use case coordinates ports; reactions go through domain events; wiring stays in `main.rs`. No mediator object.
7. **Same steps, different details?** → one fixed function, inject the varying step. No base trait.

---

## Cross-references

- `../architecture/use-cases-and-ports.md` — § 1 (shape and order), § 9 (multiple writes, events, Unit of Work), § 10 (pitfalls: calling another use case).
- `../architecture/infra-axum-sqlx.md` — § 4 (authentication middleware), § 6 (composition root).
- `designing-for-rust-not-oo.md`, `ownership-clone-and-smart-pointers.md`, `borrow-checker-as-design-feedback.md`, `creational-patterns.md`, `structural-patterns.md` — the companions.
- `../architecture/anti-patterns.md` — R5 (globals), R12 (generic ports), R15 (`usecase/shared`), R18 (handler reaching past the use case).

Based on *Design Patterns and Best Practices in Rust* (Packt), ch. 7, "Behavioral Patterns 1: Taking Action."
