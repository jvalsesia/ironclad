# Rust — the borrow checker is design feedback

A borrow-checker error is rarely a typing problem. It usually says two responsibilities are tangled in one place: something both reads and writes the same state, or something holds a pointer into data that will move. The wrong response is a workaround (`RefCell`, `unsafe`, a global). The right one is to change the shape of the code so the conflict cannot occur.

This file covers the three workarounds the compiler can't stop you from writing and what to do instead in a `domain` / `usecase` / `infra` backend. Companion files: `ownership-clone-and-smart-pointers.md` (`clone` / `Rc` / `RefCell` / `Mutex`) and `designing-for-rust-not-oo.md`.

---

## 1. Read the error as a question

| Error | What it is really asking |
|---|---|
| `E0502` cannot borrow as immutable because it is also borrowed as mutable | Why does one method both mutate and look things up in the same `&mut self` scope? Split the phases. |
| `E0499` cannot borrow as mutable more than once | Why do two things need to change the same value at once? Give each its own data, or sequence them. |
| `E0505` / `E0382` move out of / use after move | Who should own this value after this line? |
| `E0597` / `E0515` does not live long enough / returns reference to local | Should this return an owned value (or a DTO) instead of a reference? |
| "self-referential" struct | Store a key or an index, not a pointer into your own storage. |

Before changing code, write one sentence: *"this value is owned by X, read by Y, and changed by Z, in that order."* If you cannot, the design is unfinished, not the borrow checker wrong.

---

## 2. Fixes that work, in order of preference

1. **Separate by phase.** Parse → resolve → evaluate → store. Each phase finishes before the next starts, so the borrows never overlap.
2. **Store keys, not references.** An `Id<T>`, a `usize` position or a `HashMap` key stays valid when the collection grows; a pointer or `&` does not.
3. **Let data flow downward.** Create it, transform it, store it. Avoid back-references to a parent.
4. **Keep mutable state local.** The smaller the scope of `&mut`, the fewer conflicts.
5. **Narrow the borrow.** Copy the one field you need into a local and let the borrow end.

In this skill's layers, the canonical shape already follows these:

```rust
// usecase: phases are explicit, and nothing borrows across them
let email = Email::create(&input.email)?;                       // 1. validate  (owned VO)
if self.user_repo.find_by_email(&email).await?.is_some() {      // 2. read      (&email borrow ends)
    return Err(UserError::EmailTaken(email.to_string()));
}
let user = User::create(email);                                 // 3. build     (email moved)
self.user_repo.save(&user).await?;                              // 4. write     (&user borrow ends)
Ok(CreateUserOutput::from(&user))                               // 5. map       (owned DTO out)
```

Compare `../architecture/use-cases-and-ports.md` § 1 for the full example.

---

## 3. Anti-patterns

### B1. `RefCell` to make a `&self` / `&mut self` conflict compile

❌ Wrong:
```rust
struct Calculator { current: f64, memory: RefCell<Vec<f64>> }
fn evaluate(&self, expr: &str) -> Result<f64, String> {   // mutates through &self
    let r = self.parse_and_evaluate(expr)?;
    self.memory.borrow_mut().push(r);                      // BorrowMutError if a borrow() is alive
    Ok(r)
}
```

The conflict was real: `parse_and_evaluate` both resolved references to earlier results (read) and lived inside a `&mut self` method (write). `RefCell` moved the check to runtime, so the compile error became a possible panic.

✅ Right: tokenize (no state), resolve references (read-only `&self`), evaluate (pure), then push the result (`&mut self`). Four short steps, no `RefCell`.

For the application layers: a use case that reads then writes does it in sequence (`find_by_id` → mutate → `save`), never by holding a repository handle and an entity borrow at once.

**Violates rule 6** (`&mut self` for mutation). Detection: `[no-interior-mutability]` in `domain` / `usecase`; see C1 in `ownership-clone-and-smart-pointers.md`.

---

### B2. A pointer or reference stored next to the data it points into

❌ Wrong:
```rust
struct History {
    states: Vec<State>,
    current: Option<*const State>,    // dangles when `states` reallocates
}
```
```rust
// or its "safe" cousin, which the compiler rejects: a &State field borrowed from the same struct's Vec
```

✅ Right: a position or a key.
```rust
struct History { states: Vec<State>, position: usize }
fn undo(&mut self) -> Option<&State> {
    if self.position > 1 { self.position -= 1; self.states.get(self.position - 1) } else { None }
}
fn push(&mut self, s: State) {
    self.states.truncate(self.position);   // drop the redo branch
    self.states.push(s);
    self.position = self.states.len();
}
```

The index version is also *more correct*: it handles "push after undo", which the pointer version never did.

Same shape in the backend: an entity refers to another aggregate by `Id<T>`, never by `&Other` or `Rc<Other>`. `Order` holds a `UserId`, not a `User`. This is why `pub type UserId = Id<User>` exists (rule 8).

**Violates rules 6 and 8.** Detection: `unsafe_code = "forbid"` stops the pointer form; the rest is review.

---

### B3. `unsafe` to "get past" the borrow checker

❌ Wrong:
```rust
self.current.map(|ptr| unsafe { (*ptr).result })
```

It compiled, passed tests for the first ten entries, and then read freed memory when the `Vec` grew past its initial capacity. Undefined behavior can corrupt data unrelated to the `unsafe` block, and nothing in the program can reason about it afterwards. "The borrow checker is being difficult" is not a reason for `unsafe`.

✅ Right: redesign with an index, key or owned value (B2). A backend over axum + sqlx has **no** legitimate need for `unsafe`: FFI, hardware access and foundational data structures live in dependencies that have already audited them.

**Violates rule 19.** The starter's workspace lints set `unsafe_code = "forbid"`, and `forbid` cannot be overridden by `#[allow(unsafe_code)]`. Do not remove that lint to make code compile; if a dependency genuinely needs it, stop and ask the user (R22 in `../architecture/anti-patterns.md`). Detection: rustc (`forbid`).

---

### B4. Global mutable state (`static`, `lazy_static!`, `OnceLock`, `Mutex<static>`)

❌ Wrong:
```rust
lazy_static! {
    static ref MEMORY:    Mutex<Vec<f64>>           = Mutex::new(Vec::new());
    static ref VARIABLES: Mutex<HashMap<String, f64>> = Mutex::new(HashMap::new());
}
struct Calculator;                         // a unit struct: all state is elsewhere
```

It compiled and seemed to work. Then:

- **Tests interfere.** `cargo test` runs in parallel; one test's `x = 5` leaks into another, producing intermittent, non-deterministic failures. Every test must clear the globals first.
- **Hidden dependencies.** No signature says which functions read or write which state.
- **Lock problems.** Repeated `lock().unwrap()` risks deadlock and panics on poison; a lock held across `.await` blocks the executor.
- **No second instance.** You cannot run two calculators, two tenants or two test fixtures side by side.

✅ Right: the state is a field, the owner is explicit, and each test builds its own.
```rust
struct Calculator { memory: Vec<f64>, variables: HashMap<String, f64> }

#[test]
fn y_depends_on_x() {
    let mut calc = Calculator::new();          // fresh, isolated
    calc.evaluate("x = 5").unwrap();
    …
}
```

In the backend: the pool, config and clients are built in `main.rs` and passed through constructors as `Arc<dyn Trait>` or values (rule 11). In tests, the in-memory fakes are built per test.

Fine as `static`: compile-time constants, a compiled `Regex` (`LazyLock`), lookup tables. Not fine: anything that holds a dependency, connection, config or mutable state.

**Violates rule 11 and rule 2** (config read in one place). Detection: clippy `disallowed_methods` for `std::env::var` outside `config.rs`; global mutable state is `[no-global-state]` (R5 in `../architecture/anti-patterns.md`).

---

### B5. Making the data "available everywhere" instead of designing the flow

❌ Wrong: reaching for a global, a `thread_local!`, a task-local or a request-scoped `Arc<Mutex<Context>>` so a deep function can read something without it being passed.

✅ Right: pass what is needed as an argument, or put it in the struct that owns the behavior.

- Authenticated actor → `actor_id` in the use case Input (rule 18).
- Current time, id generation → a port, or `Utc::now()` / `Id::generate()` inside the domain, never a hidden global clock.
- Request-wide values → axum extractors (`CurrentUser`), not a shared bag.

The argument list getting long is the compiler-adjacent signal that a struct is missing (an Input DTO, a `FeatureSnapshot`), not a reason to hide the parameter.

**Violates rule 11 and rule 18.** Detection: review.

---

## 4. Checklist before a workaround

When the compiler objects:

1. **Phases.** Is one method doing two things (look up and mutate)? Split it.
2. **Keys, not pointers.** Can you hold an `Id`, an index or a map key instead of a reference?
3. **Direction.** Does the data flow in one direction (input → entity → port → output)? Remove the back-reference.
4. **Scope.** Can the mutable value live in a smaller scope or be passed as `&mut` to one function?
5. **Ownership.** Is it a missing `Option::take`, `mem::take`, or a move instead of a borrow?
6. Only then consider `RefCell` / `Arc<Mutex>` (§ 2 of `ownership-clone-and-smart-pointers.md`), with a one-line reason. **`unsafe` and `static` mutable state are not on the list.**

---

## Cross-references

- `ownership-clone-and-smart-pointers.md` — when `clone`, `Arc`, `RefCell` and `Mutex` are legitimate, and how they go wrong.
- `designing-for-rust-not-oo.md` — the type-system companions.
- `../architecture/use-cases-and-ports.md` — § 1 (the order inside `execute`), § 3 (injection), § 8 (tests with per-test fakes).
- `../architecture/anti-patterns.md` — R5 (globals instead of injection), R10 (panicking), R22 (silencing a gate).

Based on *Design Patterns and Best Practices in Rust* (Packt), ch. 4, "Don't Fight the Borrow Checker."
