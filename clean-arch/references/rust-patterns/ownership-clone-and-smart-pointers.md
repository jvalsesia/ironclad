# Rust — ownership, `clone()` and smart pointers

The three reflexes that make a borrow-checker error disappear without fixing the design: ignoring ownership, `.clone()` everywhere, and `Rc<RefCell<_>>` / `Arc<Mutex<_>>` everywhere. Each *compiles*, usually *works*, and quietly costs allocations, runtime panics and a data flow nobody can read. This file says what to write instead in the `domain` / `usecase` / `infra` layers, and which uses of these tools are legitimate here.

Rule of thumb: **`clone`, `Rc`, `Arc`, `RefCell` and `Mutex` are tools for a stated reason, never for silencing the compiler.** If you reach for one because an error message appeared, stop and redraw who owns the data.

---

## 1. Ownership by layer

Decide this before writing the code, so the borrow checker has nothing to argue about.

| Data | Owner | How it moves |
|---|---|---|
| Entity being changed | The use case, for one `execute` call | Loaded **owned** from the repository, mutated through `&mut self` methods, passed to `save` as `&Entity` |
| Input DTO | The use case | Moved in by the handler; destructured or borrowed, never cloned "just in case" |
| Output DTO / read model | The caller (handler) | Built by `impl From<&Entity>` or by the query; moved out |
| Value object | The entity that holds it | Borrowed through getters (`&Email`); copied only if it is `Copy` (`Id<T>`) |
| Ports (`Arc<dyn Trait>`) | Shared, built once in `main.rs` | Cloned as `Arc` into each use case at composition time only |
| Config, pool | `main.rs` | Passed to constructors; no globals (rule 11) |

Access is stated in the signature: `&self` reads, `&mut self` mutates, `self` consumes. A method that mutates through `&self` (via `RefCell`) hides that fact from every caller.

---

## 2. Where these tools ARE right

| Tool | Legitimate use in this skill |
|---|---|
| `Arc<dyn Trait>` | Ports injected into use cases (`../architecture/use-cases-and-ports.md` § 3). Shared, read-only, cloned once at startup. |
| `Arc<UseCase>` in axum `State` | One use case instance shared by all requests. |
| `Arc<Mutex<_>>` / `RwLock` | The **in-memory fakes**: the port methods take `&self`, so the fake needs interior mutability. Test-only code, in `infra`. |
| `.clone()` on `Arc` / `PgPool` | A pointer-copy, cheap and intended. Write `Arc::clone(&x)` to make that visible. |
| `.clone()` on `Copy`-like small values | `Id<T>`, `DateTime<Utc>`, short strings you must own. Derive `Copy` where you can so the clone disappears. |
| `RefCell`, `Rc` | Almost never. Single-threaded shared ownership, e.g. a graph. Not needed in a request/response backend. |

Everything else needs a stated reason in a comment, or it is one of the entries below.

---

## 3. Anti-patterns

### C1. Interior mutability to avoid `&mut self`

❌ Wrong:
```rust
pub struct User {
    is_suspended: RefCell<bool>,
    history: RefCell<Vec<UserEvent>>,
}
impl User {
    pub fn suspend(&self) -> Result<(), UserError> {      // looks read-only; mutates
        if *self.is_suspended.borrow() { return Err(UserError::AlreadySuspended(..)); }
        *self.is_suspended.borrow_mut() = true;            // panics if borrowed elsewhere
        Ok(())
    }
}
```

The compile-time guarantee is replaced by a runtime one: two overlapping `borrow_mut()` calls panic. Every caller now has to know that `&User` can change.

✅ Right: `pub fn suspend(&mut self) -> Result<(), UserError>`. The use case owns the loaded entity, so it can hold `&mut`. If two parts of the code want to mutate the same entity at the same time, restructure the flow (load → mutate → save), do not share it.

**Violates rule 6** (rich domain: `&mut self` methods named after the business operation). Detection: `[no-interior-mutability]` flags `Rc` / `RefCell` / `Cell` / `Mutex` / `RwLock` in `domain` and `usecase`.

---

### C2. Splitting a type into "viewer" and "manager" traits to model access levels

❌ Wrong:
```rust
trait HistoryViewer  { fn view_history(&self) -> &[Entry]; }
trait HistoryManager { fn add_to_history(&self, e: Entry); }   // needs &mut, so: RefCell
```

Access levels are already in the signatures. Traits for them force `&self` on the writer, which forces interior mutability.

✅ Right: methods on the owning type, `&self` to read and `&mut self` to write. For a restricted read-only handle, return a borrowed view:
```rust
pub struct HistoryView<'a> { entries: &'a [Entry] }
impl Calculator { pub fn history_view(&self) -> HistoryView<'_> { HistoryView { entries: &self.history } } }
```
In this skill the same split already exists structurally: `FeatureRepository` (write) and `FeatureQueries` (read) are different *ports* with different purposes (rule 13), not a workaround for mutability.

**Violates rule 13** when it is a rebuilt read/write split inside one aggregate. Detection: review.

---

### C3. `.clone()` to make the borrow checker stop complaining

❌ Wrong:
```rust
let users = self.user_repo.find_all().await?;
let email = user.email().clone();          // then used once, by reference would do
let tokens = tokens.clone();               // clone the whole Vec, then mutate the copy
let left = working[op_pos - 1].clone();    // cloning an element to read a field
```

Each clone allocates and copies, and it hides the real question: who should own this? A derive of `Clone` on every struct is the first symptom.

✅ Right, in order of preference:

1. **Borrow.** `&Email`, `&[T]`, `&str`. Make the callee accept a reference.
2. **Move.** If the caller is done with the value, pass it by value. Use `Option::take`, `std::mem::take` or `std::mem::replace` to take ownership out of `&mut` state.
3. **Narrow the borrow.** Many errors vanish when the borrow ends earlier: read the field into a local, drop the guard, then mutate.
4. **Restructure.** Parse into owned types, evaluate by consuming them, store the result. Data flows one way.
5. **Clone deliberately,** with a reason: the value must outlive its source, or it crosses a task boundary (`tokio::spawn`).

A token that only refers to a variable can hold `&'a Variable` instead of owning a copy. A DTO built from an entity borrows it: `impl From<&User> for CreateUserOutput`, which is why that signature takes a reference.

**Violates:** the intent of rules 6 and 15 (entities are owned and mapped once, not duplicated around). Detection: review; clippy's `redundant_clone` catches only the trivial cases.

---

### C4. Cloning an entity to "keep the old one"

❌ Wrong:
```rust
let before = user.clone();
user.suspend()?;
self.user_repo.save(&user).await?;
audit.record(&before, &user);              // two full copies per request
```

✅ Right: record what changed, not the whole before-and-after (`audit.record(user.id(), "suspended")`), or capture just the field you need before the mutation (`let was_suspended = user.is_suspended();`). If you really need a snapshot, make it explicit (`FeatureSnapshot`, see `../architecture/domain-modeling.md` § 1).

**Violates rule 6.** Detection: review.

---

### C5. `Rc<RefCell<_>>` / `Arc<Mutex<_>>` around domain data

❌ Wrong:
```rust
pub struct CreateUserUseCase {
    users: Arc<Mutex<Vec<User>>>,          // a repository in disguise, plus a lock held across .await
    config: Rc<RefCell<Config>>,
}
```

Shared ownership of *mutable domain state* means any handler can change it at any time. It also deadlocks or panics at runtime, and a `std::sync::Mutex` guard held across `.await` makes the future `!Send`.

✅ Right:
- State lives in the **database**, behind a repository port. The use case holds `Arc<dyn UserRepository>` and nothing mutable (rule 11).
- Config is immutable: `Arc<Config>` or plain values copied into constructors.
- If something truly needs process-wide mutable state (a cache, a rate limiter), make it a **port** with its own trait, implemented in `infra` with the lock *inside* the implementation. The use case sees `&self` methods and nothing else.

**Violates rule 11.** Detection: `[no-interior-mutability]` in `domain` / `usecase`, `[no-global-state]` for a `static` anywhere. (`static` holding a dependency is R5 in `../architecture/anti-patterns.md`.)

---

### C6. A lock held across an `.await`

❌ Wrong:
```rust
let mut guard = self.cache.lock().unwrap();       // std::sync::Mutex
let user = self.repo.find_by_id(id).await?;       // lock held while suspended
guard.insert(id, user);
```

✅ Right: take the lock, copy or move out what you need, drop the guard, **then** await. Where a lock must span an await, use `tokio::sync::Mutex`, and question why. Also never `.unwrap()` a poisoned lock; map it to `AppError::unexpected` (rule 19 denies `unwrap_used`).

**Violates rule 19** (clippy `unwrap_used`). Detection: clippy, plus `await_holding_lock` if enabled.

---

### C7. Wrapping the type for threads before it needs threads

❌ Wrong: `Arc<Mutex<_>>` as the default shape of every service "in case it's shared".

✅ Right: write the core as a plain owned struct with `&self` / `&mut self` methods. If it must be shared, add the synchronization at the edge, in a thin wrapper (`Arc<Mutex<Core>>`), so the logic stays free of locks.

In the usual layout, axum shares `Arc<UseCase>` and each use case is stateless, so no wrapper is needed. A wrapper is a smell in `usecase`.

**Violates rule 10** (one use case, one `execute`, no shared mutable state). Detection: `[no-interior-mutability]` for a lock in `usecase`, `[usecase-stateless]` for `execute(&mut self)`.

---

## 4. Before reaching for a smart pointer or `clone`

Answer these in order:

1. **Can the callee take `&T` / `&mut T`?** → change the signature.
2. **Is the caller done with the value?** → move it.
3. **Is the borrow just too long?** → end it sooner (local variable, inner block).
4. **Is the data shared by design, across requests?** → it is a port or immutable config: `Arc<dyn Trait>` / `Arc<Config>`.
5. **Does it need mutation through a shared reference by design?** → it belongs in the database or behind a port; the lock goes inside the `infra` implementation.
6. Only then: `.clone()` / `Rc` / `RefCell`, with a one-line comment stating why.

---

## Cross-references

- `designing-for-rust-not-oo.md` — the companion language-level anti-patterns (sub-traits, `Deref`, generics-as-classes).
- `../architecture/use-cases-and-ports.md` — § 3 (`Arc<dyn Trait>`), § 9 (multiple writes).
- `../architecture/domain-modeling.md` — entities with `&mut self` methods, `FeatureSnapshot`.
- `../architecture/anti-patterns.md` — R5 (globals instead of injection), R10 (panicking instead of returning an error).

Based on *Design Patterns and Best Practices in Rust* (Packt), ch. 3, "Anti-Pattern: Using Clone and Rc Everywhere."
