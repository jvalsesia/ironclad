# Rust — functional patterns

Four ideas Rust took from functional languages and where they fit in a `domain` / `usecase` / `infra` backend: **function pipelines** (iterator chains), **traits as type classes** (capabilities), **pattern matching** (exhaustive `match`, state machines) and **closures** (captured behavior). They are independent tools, not a style to adopt wholesale. The aim is clearer, testable code, not code that looks like Haskell.

| Idea | In this skill |
|---|---|
| Pipelines | Iterator chains over **in-memory** data in the domain and use cases; aggregation over large data stays in SQL |
| Traits as type classes | Small capability traits: ports (`UserRepository`, `UserQueries`), `impl Trait` arguments. Not a hierarchy |
| Pattern matching | Exhaustive `match` on closed enums; pure transition functions; `?` (not `match`) for errors in handlers |
| Closures | Tiny strategies, predicates, `map_err` / `ok_or_else`, retry helpers. Not stored in entities |

Related: `behavioral-patterns-keeping-track.md` (Iterator, State, Visitor), `behavioral-patterns-actions.md` (Strategy), `type-system-patterns.md` (TypeState), `designing-for-rust-not-oo.md`.

---

## 1. Function pipelines

A pipeline chains `filter`, `map`, `fold` and friends over an iterator. It is lazy (nothing runs until a terminal operation such as `collect`, `sum`, `count`), allocates no intermediate collections, and compiles to a loop as fast as a hand-written one.

### Rules

- **Use it for in-memory transformation**: a use case that already holds a `Vec`, an aggregate's own collection, a parsed document. Do not load a table and filter it in Rust; filter, group and count in SQL through `FeatureQueries` (rule 13, R14).
- **Terminal operation decides the shape.** `collect::<Vec<_>>()`, `collect::<Result<Vec<_>, E>>()` (stops at the first error), `collect::<HashMap<_, _>>()`, `try_fold` for "thread a value through steps that can fail", `sum`, `count`, `any`, `all`.
- **No side effects in `map` / `filter`.** If you need to do something per item (write, send, log), use a `for` loop or `inspect` for diagnostics only. A lazy chain that is never consumed silently does nothing.
- **No `unwrap()` / `expect()` inside closures** in production code (rule 19). Return `Result` from the closure and let `collect::<Result<_, _>>()` or `try_fold` carry the error.
- **Borrow, don't clone, through the chain.** `.iter()` yields `&T`; clone once at the end if the result must be owned. The book's example clones a `String` per event in a `fold`; `entry(&str)` lookups or `*acc.entry(topic).or_default() += 1` on borrowed keys avoid it where possible.
- **Name the intent.** When a closure needs a comment to be understood, give the predicate a method (`event.is_subscription()`) or a small function. That is the point of the book's "domain-specific combinators".

### Domain combinators: functions, not iterator extension traits

The book adds methods to every `Iterator<Item = SubscriptionEvent>` through a blanket extension trait and then returns `Box<dyn Iterator>` (its trait signature and its `impl` even disagree). In this skill:

```rust
// a free function returning `impl Iterator` is enough: no trait, no Box
pub fn valid_subscriptions<'a>(events: &'a [SubscriptionEvent])
    -> impl Iterator<Item = &'a SubscriptionEvent> + 'a
{
    events.iter().filter(|e| e.is_subscription())
}

let by_topic = count_by_topic(valid_subscriptions(&events).filter(|e| e.at >= cutoff));
```

An extension trait (`trait EventsExt: Iterator { … }` with a blanket `impl<I: Iterator<Item = E>> EventsExt for I`) is acceptable inside one module when the method chain reads much better. Return `impl Iterator`, not `Box<dyn Iterator>`, unless the concrete type genuinely varies at runtime.

### Do not re-validate inside the pipeline

The book filters with `.filter(|e| e.is_valid())` because a `SubscriptionType::Invalid` variant and `user_id: u64 == 0` can exist. Per *parse, don't validate* (`type-system-patterns.md` § 2), invalid events should not be representable: parse at the boundary into `UserId`, `Topic`, and a `SubscriptionKind` enum with only valid variants, then the pipeline has nothing to filter out.

**Violates rule 13** when a use case loads everything to filter in memory. Detection: `[list-page-input]` for missing pagination; the rest is review.

---

## 2. Traits as type classes: capabilities

A trait abstracts over **behavior**: "any type that can do X". Rust's traits are modelled on Haskell's type classes. In this skill the main use is the **port**: a small trait per capability, implemented in `infra`.

```rust
#[async_trait] pub trait UserRepository: Send + Sync { /* find_by_id, save, delete */ }   // write capability
#[async_trait] pub trait UserQueries:    Send + Sync { /* list, summary */ }              // read capability
```

### Rules

- **Small and specific.** One capability per trait (rule 13). A `Repository<T>` with `find_all` for every aggregate is the abstract-class instinct (O2, `designing-for-rust-not-oo.md`).
- **`impl Trait` or generics for static polymorphism** inside one crate, when one concrete type is used per call. **`Arc<dyn Trait>`** for ports chosen at composition time (`../architecture/use-cases-and-ports.md` § 3).
- **Blanket impls** (`impl<T: Port> Other for T`) must respect the orphan rule: you cannot implement a foreign trait for a type parameter (the `Deref` error in `designing-for-rust-not-oo.md` O3).
- **Associated types sparingly.** They are right when the output type is fixed by the implementor (`Iterator::Item`). On a port they leak the adapter into every caller (`architectural-principles.md` § 3); return the domain's own types.

### Capability traits for TypeState: usually too much

The book makes `Activatable`, `Suspendable`, `Cancellable` traits with an associated `Output`, implemented for `Subscription<Pending>`, `Subscription<Active>` and so on, plus a `SubscriptionManager` holding one `Vec` per state. That is a valid illustration of generics over states, but for a **stored subscription** it is the wrong tool here:

- The state is a **status column** (`type-system-patterns.md` § 3): the repository returns one `Subscription` type, and the entity's `&mut self` methods (`activate`, `suspend`, `cancel`) enforce the legal transitions, returning a feature error for an illegal one.
- "An active subscription cannot be in the cancelled list" is a **query** (`WHERE status = 'cancelled'`), not a struct with three `Vec`s.
- Generic code over "anything cancellable" (`cancel_with_audit<S: Cancellable>`) is rarely needed; an entity method that records an event does the same job.

Use capability traits over states only for **in-memory, short-lived flows** where several states share a behavior and a generic helper would otherwise be duplicated.

Also fix what the book glosses over: generate ids with `Id::generate()` in the domain (not `rand::random()` in a manager), take time from `Utc::now()` rather than `SystemTime::now().duration_since(..).unwrap()` (rule 19), and use typed ids rather than `u64`.

**Violates rules 6, 11 and 13** when capability traits replace the status enum on a persisted entity or a repository is made generic. Detection: `[usecase-generic-ports]` for a generic use case; the rest is review.

---

## 3. Pattern matching

`match` is exhaustive: the compiler tells you every place that must handle a new variant. That is the main reason this skill models closed sets as enums.

### Rules

- **Prefer exhaustive arms on domain enums.** A wildcard `_ =>` on `OrderStatus` or `ErrorKind` hides the new variant you just added. Use `_` only where "everything else" is genuinely the same (a default route), and say so.
- **Destructure to extract**: `Shipped { tracking, .. }`, `Event::Registered { user_id, .. }`. Bind by reference (`ref` / match ergonomics on `&self`) to avoid moves.
- **Guards (`if`) refine, but order matters.** The first matching arm wins, so list specific arms before general ones, comment the ordering, and test it. Unreachable arms are a compiler warning.
- **`matches!`, `if let`, `let … else`** for single-case checks. `let Some(x) = opt else { return Err(UserError::NotFound(id)) };` keeps the happy path flat.
- **In handlers, use `?`, not `match` on errors** (rule 16, R16). Matching on `Result` belongs in the central `HttpError` mapper, not in each handler.
- **No `unreachable!()` / `panic!()` arms for "can't happen".** Return an error, or restructure the types so the case cannot arise.

### State machines as pure functions

`match (state, event)` is a compact transition table. Make it a **pure function** that returns the next state or an error:

```rust
fn next(state: ConnState, event: ConnEvent) -> Result<ConnState, TransitionError> {
    match (state, event) {
        (ConnState::Disconnected, ConnEvent::Connect)                     => Ok(ConnState::Connecting { attempt: 1 }),
        (ConnState::Connecting { attempt }, ConnEvent::Timeout) if attempt < MAX_ATTEMPTS
                                                                          => Ok(ConnState::Connecting { attempt: attempt + 1 }),
        (ConnState::Connecting { .. }, ConnEvent::Timeout)                => Ok(ConnState::Failed { retry_after: RETRY_AFTER }),
        (ConnState::Connecting { .. }, ConnEvent::Established)            => Ok(ConnState::Connected),
        (from, event) => Err(TransitionError::Invalid { from, event }),
    }
}
```

What differs from the book's version, and why:

- **Illegal transitions are errors.** The book's catch-all `(current_state, _) => "Invalid transition ignored"` swallows them. A silent no-op hides bugs; return `Err` and let the caller decide.
- **Return effects as data, not strings.** The book returns `(State, Vec<String>)` of messages. Return `(State, Vec<Action>)` with an `enum Action { StartConnection, ScheduleRetry(Duration), … }`, so the caller performs the I/O and tests assert on values, not text.
- **Keep the function free of I/O and time.** Take `now: DateTime<Utc>` as a parameter instead of calling `current_timestamp()` inside (`.unwrap()` on `duration_since` also violates rule 19).
- **Persisted entity lifecycles** put the `match self.status` inside the entity's transition methods (`behavioral-patterns-keeping-track.md` § 2); the table form above fits in-memory or protocol state.

### Routing and policy

A tuple `match` over `(priority, content, topic)` is a good way to express a business rule in the **domain**, as a pure function from facts to a decision (`Routing::Immediate | Queue | Reject(reason) | RequireAuth`). Keep it side-effect free (no `println!` in the arm, as the book does) and cover each arm with a unit test. Logging belongs in `infra` through `tracing`.

**Violates rules 16 and 19** when handlers match on errors or arms panic. Detection: `[handler-no-error-mapping]`, clippy `unwrap_used` / `todo`.

---

## 4. Closures

A closure is a function that captures values from its scope. The compiler picks one of three traits from how it uses them:

| Trait | The closure… | Callable |
|---|---|---|
| `Fn` | only reads captures | many times, concurrently |
| `FnMut` | mutates captures | many times, one at a time |
| `FnOnce` | moves a capture out | once |

Accept the weakest bound that works (`FnOnce` if you call it once, `FnMut` for a loop, `Fn` if shared).

### Where closures fit in this skill

| Use | Example |
|---|---|
| Error mapping | `.map_err(db_error)?`, `.ok_or_else(|| UserError::NotFound(id))?` |
| Small predicates and sort keys | `users.iter().filter(\|u\| u.is_suspended())`, `sort_by_key(\|u\| u.created_at())` |
| A tiny one-off **strategy** | `fn retain_if(items: &mut Vec<T>, keep: impl Fn(&T) -> bool)` (`behavioral-patterns-actions.md` § 3) |
| Retry and timeout wrappers around a gateway call | `with_retry(3, \|\| async { client.send(&req).await }).await` |
| Test setup helpers | `let make = \|email: &str\| User::create(Email::create(email).unwrap());` (test code only) |
| Parsing and mapping rows | `rows.into_iter().map(User::from).collect()` (a path to a function works as the closure) |

### Rules

- **Capture once, present a plain interface.** The book's `is_recent` closure captures the cutoff so callers pass only the message. That is the reason to choose a closure over a function.
- **`move` when the closure outlives its scope**: returned, stored, or sent to `tokio::spawn`. Spawned closures and futures need `Send + 'static`; capturing an `Rc` fails to compile, which is the point.
- **Static dispatch by default**: `impl Fn(&T) -> bool` in arguments and returns. Use `Box<dyn Fn…>` only to store closures of different types in one collection, and add `Send + Sync + 'static` if it is shared across tasks.
- **Name complex closure types with an alias**:

```rust
type Predicate<T> = Box<dyn Fn(&T) -> bool + Send + Sync>;
```

The book silences clippy with `#[allow(clippy::type_complexity)]`. **Do not.** Rule 19 forbids `#[allow(..)]` to quiet a gate; fix the type with an alias or a small struct.
- **Do not store closures in entities or value objects.** They are not `Clone`, `Debug`, `PartialEq` or serializable, and they hide behavior where the invariant should be visible. Entities hold data; behavior is a method, a port, or an enum.
- **Combinators** (`and`, `or`, `not` on filters) are fine for a *query-building* helper in `infra` or a test; for a closed set of conditions, an `enum Filter { … }` with a `match` is clearer and can be turned into SQL.
- **Async closures need care.** Prefer a named `async fn`, or return a boxed future, over a closure that must be both async and `Send`.

### The pipeline-of-stages pattern

A `Vec<Box<dyn Fn(T) -> Result<T, E>>>` run with `try_fold` is a reasonable way to build a configurable processing chain:

```rust
stages.iter().try_fold(input, |acc, stage| stage(acc))
```

In this skill, where it applies, change two things from the book:

- **Use a typed error** (`Result<T, FeatureError>`), not `Box<dyn std::error::Error + Send + Sync>`; a boxed error erases what failed and the HTTP mapper cannot classify it (rule 16).
- **Prefer plain functions in a fixed order** when the stages are known: `validate(input)?; normalize(&mut input); check_size(&input)?;`. A dynamic stage list pays for flexibility you usually do not need. Reserve it for a genuinely configurable chain (user-defined steps, plugin stages).

Inputs to such a pipeline are parsed domain types, so a "topic cannot be empty" stage disappears: `Topic::create` already rejected it.

**Violates rules 6 and 19** when a closure sits in an entity or an `allow` hides a lint. Detection: `[no-silenced-lint]` for `#[allow(..)]` (R22); a closure in an entity is review.

---

## 5. Quick decision guide

1. **Transforming a collection already in memory?** → iterator chain with an explicit terminal (`collect`, `try_fold`, `sum`). Large data → SQL.
2. **Domain-specific filter used often?** → a named function returning `impl Iterator`, not a boxed extension trait.
3. **Abstracting over behavior?** → a small capability trait (a port) with `Arc<dyn Trait>`, or `impl Trait` inside one crate.
4. **A stored entity with a lifecycle?** → status `enum` + transition methods. Capability traits over states only for in-memory flows.
5. **Branching on a closed set?** → exhaustive `match`; illegal transitions return `Err`, effects return as data.
6. **Need to pass behavior in?** → `impl Fn` argument; `Box<dyn Fn + Send + Sync>` only to store several; alias the type, never `allow` the lint.
7. **Tempted to put a closure in an entity?** → make it a method, a port or an enum.

---

## Cross-references

- `../architecture/use-cases-and-ports.md` — § 3 (`Arc<dyn Trait>`), § 4 (ports), § 7 (pagination).
- `../architecture/domain-modeling.md` — entities, per-feature errors, `Id<T>`.
- `behavioral-patterns-keeping-track.md` — § 1 (Iterator), § 2 (State as an enum), § 5 (Visitor as `match`).
- `behavioral-patterns-actions.md` — § 3 (Strategy: port, enum or closure).
- `type-system-patterns.md` — § 2 (parse, don't validate), § 3 (TypeState).
- `designing-for-rust-not-oo.md`, `ownership-clone-and-smart-pointers.md`, `borrow-checker-as-design-feedback.md` — the language-level companions.
- `../architecture/anti-patterns.md` — R10 (panicking), R12 (generic ports), R14 (reading through the repository), R16 (error handling in the handler), R22 (making a gate pass without fixing the code).

Based on *Design Patterns and Best Practices in Rust* (Packt), ch. 11, "Patterns from Functional Programming."
