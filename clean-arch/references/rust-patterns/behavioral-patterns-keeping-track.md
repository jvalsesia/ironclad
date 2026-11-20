# Rust — behavioral patterns: keeping track

How Iterator, State, Memento, Observer and Visitor map onto this skill's layers. Four of the five are mostly language features (`Iterator`, `enum` + `match`, `Clone`, channels), so the work is knowing which tool fits where, and where the book's stateful, in-process versions do not belong in a stateless backend.

| Pattern | In Rust | In this skill |
|---|---|---|
| Iterator | The `Iterator` trait and combinators | Inside the domain and infra. At a port boundary return `Vec` / `PageOutput`, not a lazy iterator |
| State | A closed `enum` with transition methods; `Box<dyn State>` only if the set is open | The **status** of an entity (`Draft → Published`), transitions as `&mut self` methods returning `Result` |
| Memento | A snapshot struct, `Clone` | The `FeatureSnapshot` for `restore`; persisted as a **row**, never by serializing the entity |
| Observer | Events + channels | **Domain events** published through a port, handled after `save`. No in-process `Vec<Box<dyn Observer>>` |
| Visitor | `enum` + `match` (a visitor is just a function) | Functions over a closed enum; the double-dispatch machinery is unnecessary |

Related: `behavioral-patterns-actions.md` (Command, Mediator, Strategy), `structural-patterns.md` (Composite as an enum), `designing-for-rust-not-oo.md`, `borrow-checker-as-design-feedback.md`.

---

## 1. Iterator

`Iterator` is a core trait, not a pattern you build. A custom iterator (`impl Iterator for HistoryIterator<'a>`, with a position index and a lifetime) is needed only for **structures the standard collections cannot walk**: a tree, a ring buffer, a graph.

### Rules

- **Expose borrowed iteration, not the collection.** An aggregate that owns a `Vec<Item>` gives callers `pub fn items(&self) -> impl Iterator<Item = &Item>` or `&[Item]`, never `&mut Vec<Item>`. Mutation stays in `&mut self` methods named after the business operation (rule 6).
- **Return `impl Iterator<Item = &T> + '_`** from a method; do not write a named iterator type unless callers must name it.
- **Prefer combinators to index loops** (`filter`, `map`, `take`, `fold`, `rev`). They are lazy and compile to one loop; `collect::<Result<Vec<_>, _>>()` turns an iterator of `Result` into one `Result`.
- **Always annotate `collect`'s target** (`Vec<_>`, `HashSet<_>`, `Result<Vec<_>, _>`).
- **Trees:** walk with an explicit stack (pre-order) in a function or method on the enum; push children in reverse so the left is popped first. For a closed `enum` tree this is a plain method; no downcasting `as_binary_op()` is needed.

### At the port boundary

An iterator borrows from its source. A port that talks to the database cannot hand a borrowed iterator back across an `await`.

| Need | Return |
|---|---|
| A bounded read | `Result<Vec<Entity>, AppError>` or `PageOutput<Summary>` (rule 13) |
| "Search the history" | Do it **in SQL** through `FeatureQueries` with a filter and a page, not `find_all()` and `.filter()` in Rust (R14) |
| A genuinely large export | A `Stream` inside `infra` (sqlx `fetch`), consumed there; the use case sees a count or a file handle behind a port |

**Violates rule 13** when a use case loads everything to filter or page in memory. Detection: `[list-page-input]` for missing pagination; the rest is review.

---

## 2. State: an enum with transitions

The pattern replaces `match self.mode { … }` scattered through many methods with one type per state. In Rust the usual answer is the opposite and simpler: keep **one `enum`** and put the `match` in the methods that care.

### Entity lifecycle

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderStatus { Draft, Placed, Shipped, Cancelled }

impl Order {
    pub fn place(&mut self) -> Result<(), OrderError> {
        match self.status {
            OrderStatus::Draft => { self.status = OrderStatus::Placed; Ok(()) }
            other => Err(OrderError::InvalidTransition { from: other, to: OrderStatus::Placed }),
        }
    }
    pub fn cancel(&mut self) -> Result<(), OrderError> {
        match self.status {
            OrderStatus::Draft | OrderStatus::Placed => { self.status = OrderStatus::Cancelled; Ok(()) }
            other => Err(OrderError::InvalidTransition { from: other, to: OrderStatus::Cancelled }),
        }
    }
}
```

- **Transitions are methods named after the business operation** (`place`, `cancel`, `suspend`), not `set_status` (rule 6, R7).
- **Illegal transitions return a feature error**, with the current and attempted state in the variant. No `panic!`, no silent no-op.
- **Exhaustive `match`**: when a state is added, the compiler lists every method that must decide what to do. Avoid a wildcard `_ =>` on the status unless the default is deliberately "reject".
- **The status is a column.** The row stores it as text or an enum; row mapping parses with `TryFrom<&str>` and `restore` receives the typed value. Do not let an unknown string reach `from_trusted` unparsed.
- **Data that belongs to one state lives in that variant**: `Shipped { tracking: TrackingNumber }`, so it cannot exist in other states.

### When to use per-state types (trait objects)

`Box<dyn State>` with `handle(&self, …) -> Transition` is justified only if states are **open** (third parties add them) or each carries a lot of behavior and data. If you use it:

- Return the next state as **data** (`Transition::To(Box<dyn State>)`), as the book does, so a state never mutates the context that owns it.
- Keep shared data in a separate struct from the state holder so both can be borrowed independently (the borrow-checker fix, `borrow-checker-as-design-feedback.md`).
- Do not default every method (`format_output`, `supported_operations`) on the trait and override by mode; that is a base class (O1).

For strict machines, where an illegal call should not compile, use **TypeState** (`Order<Draft>` → `Order<Placed>`), covered in the type-system patterns. It costs ergonomics around persistence, because a loaded row has to pick a type at runtime, so reserve it for in-memory flows.

### Not a process-wide mode

The book's calculator holds a "mode" that the user switches. A backend serves many callers at once, so a mode is a **field of the Input** (or of the entity it concerns) mapped to behavior with one `match`, never a mutable setting on a shared use case (rule 11).

**Violates rules 6 and 11.** Detection: `[no-setters-in-domain]`; wildcard or panic arms are review.

---

## 3. Memento: snapshot and restore

The Memento saves state without exposing internals. This skill already has that mechanism, with a specific purpose.

| Memento role | This skill |
|---|---|
| Memento | `FeatureSnapshot`: the plain struct passed to `restore` (`../architecture/domain-modeling.md` § 1) once it has more than six or seven fields |
| Originator | The entity, via `restore(snapshot)` |
| Caretaker | The repository: `save` writes it, `find_by_id` reads and rehydrates it |
| Private memento constructor | Private fields on the entity; a snapshot-producing method lives next to `restore` in the same module |

### Persistence: row, not serialized entity

The book adds `#[derive(Serialize, Deserialize)]` to the memento and writes it to a file. Here:

- **Do not derive `Serialize` / `Deserialize` on an entity or value object** (rule 17). A domain snapshot is not a wire format.
- Persist through a **row** struct in `infra` (`impl From<&User> for UserRow`, `impl From<UserRow> for User`, calling `restore` and `from_trusted`). That is your save/load.
- A JSON document column (history, preferences) is fine **as a row field**, with its own versioned struct in `infra`, mapped to and from domain values. Unknown versions fail at the mapping, not deep in the domain.
- **I/O never lives in `usecase` or `domain`.** `File::create` and `serde_json::to_writer` in a "save to file" method is R2; put it behind a gateway port if a file really is the target.

### Rules for snapshots

- **A snapshot is constructed from a validated entity** and restored through `restore`, which runs no creation rules and assigns no new id or timestamp.
- **Do not clone the whole aggregate** to "keep the old one" for undo or audit (C4 in `ownership-clone-and-smart-pointers.md`). Keep the **fields you need** or record the change as an event (§ 4).
- **History inside the domain** (a document's revisions) is its own aggregate: a `Vec` of snapshots plus a **position index**, mutated through `&mut self`, truncating the redo branch on a new push (B2, `behavioral-patterns-actions.md` § 1).
- **Bound the history.** Cap its length in the root; it is an invariant, not a caller's job.
- **Named user snapshots** ("before optimization") are rows with a name and an owner (`actor_id`), written by a use case. They are not a `HashMap` held in memory.
- **Restoration is fallible.** `restore` from persisted data returns `Result` when the saved value can be invalid (a removed strategy name, an unknown status); return the error, never fall back silently.

**Violates rules 15 and 17.** Detection: `[entity-not-serializable]`, `[vo-not-serializable]`; I/O in the use case is `[forbidden-crate]`.

---

## 4. Observer: domain events, not callbacks

The pattern keeps a subject ignorant of who reacts. In this stack the same goal is reached with **domain events** and a publisher port, not a `Vec<Box<dyn Observer>>` the subject owns.

```rust
// domain/shared/event.rs (whitelisted) or the feature's own file: plain data
#[derive(Debug, Clone)]
pub enum UserEvent {
    Registered { user_id: UserId },
    Suspended  { user_id: UserId },
}

// domain: the port
#[async_trait]
pub trait EventPublisher: Send + Sync {
    async fn publish(&self, event: UserEvent) -> Result<(), AppError>;
}
```

```rust
// usecase: save first, then publish
self.user_repo.save(&user).await?;
self.events.publish(UserEvent::Suspended { user_id: user.id() }).await?;
```

### Rules

- **Events are data.** Ids and facts; no entity references, no closures, no `Arc<Mutex<…>>`.
- **Publish after a successful `save`.** Never before: an event for a state that was never persisted is a lie.
- **Atomicity:** if "save and publish" must be all-or-nothing, write the event to an **outbox table in the same `save` transaction** and let a worker publish it. A second write from the use case after the first has no such guarantee, and the use case must not open the transaction (`../architecture/use-cases-and-ports.md` § 9; a Unit of Work needs the user's agreement first).
- **Observers live in `infra` or `app`**, registered in `main.rs`. The subject (a use case) knows only the `EventPublisher` port.
- **In-process fan-out uses channels** (`tokio::sync::mpsc` or `broadcast`), not a list of observers behind a lock. The subject sends; each observer receives on its own task. No shared mutable state, no lock held while an observer runs.
- **Observers do not fail the request.** A handler error is logged and retried by the worker; it does not turn the HTTP response into a 500 after the write has succeeded. Do not `unwrap()` a lock or a send (rule 19).
- **`&self` observers** (the book's choice) are right: take `&self`, keep any mutable state behind a lock inside the observer.
- **Watch cascades.** An observer that triggers another event can loop; keep handlers idempotent and keep the chain shallow.
- **In-memory fake** for tests: an `InMemoryEventPublisher` that records events in a `Mutex<Vec<_>>`, kept behaviorally in step like the repository fakes.

### Not the same as the Mediator

A mediator coordinates an operation across collaborators (the use case itself). An observer reacts *after* a change, with no say in whether it succeeds. If the reaction must succeed together with the write, it is not an observer; make it part of the aggregate change.

**Violates rule 11** when a subject owns a mutable observer registry shared across requests. Detection: `[no-global-state]` for a `static` registry, `[no-interior-mutability]` for a locked registry in `usecase`; the rest is review.

---

## 5. Visitor: an enum and a function

A visitor adds operations to a stable structure without editing its types, using `accept` + `visit_*` (double dispatch). With a **closed `enum`**, the compiler already gives you that: each operation is a function with an exhaustive `match`.

```rust
pub enum Expr {
    Number(f64),
    Variable(String),
    Binary { op: Op, left: Box<Expr>, right: Box<Expr> },
    Call   { func: Func, arg: Box<Expr> },
}

pub fn variables(e: &Expr) -> BTreeSet<&str> {
    match e {
        Expr::Number(_) => BTreeSet::new(),
        Expr::Variable(n) => BTreeSet::from([n.as_str()]),
        Expr::Binary { left, right, .. } => &variables(left) | &variables(right),
        Expr::Call { arg, .. } => variables(arg),
    }
}
```

- **Adding an operation** = one new function (or a method in another `impl` block, or another file); no type changes.
- **Adding a variant** = the compiler flags every `match` that must handle it. That is the "tradeoff" the book describes, enforced instead of remembered.
- **Traversal** is a function or a custom `Iterator` (§ 1). Combine them (`expr.iter().filter(..).count()`) rather than threading a `&mut dyn Visitor`.
- **Transformations return a new tree** (`fn optimize(e: Expr) -> Expr`, consuming and rebuilding) rather than recording a replacement map and applying it later. Ownership makes this natural and removes the "was it optimized?" flag.

### When a visitor trait is justified

Only for an **open** hierarchy of trait objects where you must add both new element types and new operations without touching existing code. That is rare in a backend; prefer the enum (`designing-for-rust-not-oo.md` O5, `structural-patterns.md` § 5).

### Rules

- **Do not swallow errors.** The book's `get_expression_dependencies` logs with `eprintln!` and returns an empty set on failure. Return `Result` (a feature error) and let `?` propagate. Silent fallback hides bugs.
- **Domain validation of a tree is an invariant of its root**, checked where the tree is built or changed (the aggregate's method or `create`), not a separate visitor run by whoever remembers.
- **Keep the algorithm out of the entity when it is not the entity's responsibility** (formatting, LaTeX, reporting): a free function or a type in `usecase` / `infra`, not a method on the aggregate.
- **Recursion depth is a resource.** For untrusted input (a parsed request), bound the depth when building the tree, or use an explicit stack.

---

## 6. Quick decision guide

1. **Walking a collection or tree?** → `Iterator` combinators. Custom iterator only for a non-standard structure.
2. **Loading data to filter it?** → filter in SQL via `FeatureQueries`; return a page.
3. **Entity with a lifecycle?** → a status `enum` and one `&mut self` method per transition, returning a feature error on an illegal one.
4. **States open to extension?** → trait objects, transitions as data. Otherwise `enum`.
5. **Need to save or restore state?** → `FeatureSnapshot` + `restore`; persist via a row; never serialize the entity; never clone the aggregate to keep a copy.
6. **Something must react to a change?** → a domain event through a port, published after `save`; an outbox if it must be atomic; channels for in-process fan-out.
7. **New operation over a tree?** → a function with an exhaustive `match`. A visitor trait only for an open hierarchy.

---

## Cross-references

- `../architecture/domain-modeling.md` — § 1 entities, `restore`, `FeatureSnapshot`, per-feature errors.
- `../architecture/use-cases-and-ports.md` — § 4 ports, § 7 pagination, § 9 multiple writes and events.
- `../architecture/infra-axum-sqlx.md` — § 5 row mapping and fakes, § 6 composition root.
- `behavioral-patterns-actions.md` — Command (undo as an inverse use case), Mediator (events), Strategy.
- `structural-patterns.md` — § 5 Composite as an enum.
- `../architecture/anti-patterns.md` — R2 (I/O crate in `usecase`), R7 (setters), R14 (reading through the repository), R9 (serializable entity).

Based on *Design Patterns and Best Practices in Rust* (Packt), ch. 8, "Behavioral Patterns 2: Keeping Track."
