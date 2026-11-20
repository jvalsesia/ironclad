# Rust — thinking in Rust

The other files in this folder are specific: one pattern, one anti-pattern, one rule. This one is the habit that produces them. It is a short guide to **how to approach a task in this skill so you stop fighting the language**, and an index of where each symptom is covered.

The shift has three stages. Know which one you are in:

| Stage | How it shows up | Result |
|---|---|---|
| **Writing X in Rust syntax** | Class hierarchies, `Rc<RefCell<_>>` everywhere, `clone()` to quiet errors, `unsafe` or a global to "get past" the compiler | Compiles (sometimes), fights the language at every step |
| **Translating patterns** | Replace inheritance with traits, interfaces with ports, `State` with an enum | Works, but you still ask "how do I do *this Java thing* in Rust?" |
| **Rust-native** | Start from ownership, types and data flow; ask "what is the Rust solution?" | Code that reads as obvious and that the compiler checks for you |

The practical test: **when you are fighting the compiler, the approach is wrong, not the compiler.**

---

## 1. Symptoms and where to look

Use this as a lookup when something feels awkward.

| You are doing / feeling | It usually means | Fix | Read |
|---|---|---|---|
| Adding `Rc<RefCell<_>>` / `Arc<Mutex<_>>` to make a borrow compile | Ownership is unclear | Redraw who owns, reads, changes | `ownership-clone-and-smart-pointers.md` |
| `.clone()` to silence an error | Same | Borrow, move, narrow, restructure | `ownership-clone-and-smart-pointers.md` § 3 |
| A `&self` method that needs to mutate | A read and a write are tangled | Split by phase; `&mut self` | `borrow-checker-as-design-feedback.md` |
| Reaching for `unsafe`, `static`, `lazy_static`, a global | Hiding a data-flow problem | Index/key instead of pointer; inject via constructor | `borrow-checker-as-design-feedback.md` |
| A base trait, `Deref` "inheritance", a `Vec<Foo<_>>` of different instantiations | Class thinking | Enum for closed sets, port for open ones, composition | `designing-for-rust-not-oo.md` |
| The same validation in three places | Parsed data is not a type | Value object + parse at the boundary | `type-system-patterns.md` |
| `if status == …` scattered, "invalid state" runtime errors | State is a string or a flag | Status `enum` + transition methods | `behavioral-patterns-keeping-track.md` § 2 |
| `unwrap()`, `eprintln!` + continue, `.ok()` on an error | Failure treated as an afterthought | `Result`, typed errors, keep the cause | `core-language-patterns.md` |
| A "manager"/"facade" with a dozen methods | Responsibilities merged | One use case per operation | `structural-patterns.md` § 4 |
| A generic wrapper or factory to select an implementation | Over-abstraction | `Arc<dyn Port>` wired in `main.rs` | `creational-patterns.md` § 2 |
| Components referencing each other, a mediator holding `Arc`s | A cycle | Use case coordinates ports; reactions as events | `behavioral-patterns-actions.md` § 4 |
| Layers importing each other, data coming "back up" | Wrong direction | Inward arrows; return values, not callbacks | `architectural-principles.md` |

---

## 2. Design from the types inward (compiler-driven development)

Write the types that express the design, then let the compiler list what is missing. In this skill's layers the order is:

1. **Errors and identity.** The feature error enum (`UserError`), the `Id` alias (`UserId`).
2. **Value objects.** `Email::create`, each rule in one place (rule 7).
3. **The entity.** Private fields, `create` / `restore`, methods named after business operations (rule 6).
4. **The ports.** `UserRepository`, `UserQueries`: only the methods the use cases need.
5. **The use case.** `Input`, `Output`, `execute` in the fixed order (`../architecture/use-cases-and-ports.md` § 1).
6. **In-memory fakes and tests.** The use case is now testable without `infra`.
7. **The adapters.** Row struct and mapping, the sqlx repository, the queries.
8. **The handler and route**, then the **composition root**.

Run `cargo check` after each step. The compiler tells you which trait method is missing, which `match` needs a new arm, which signature no longer fits. Adding a variant to an enum or a field to a struct becomes a to-do list, so large changes are safe. A refactor is "change the type, follow the errors".

If an error is hard to satisfy, do not add a workaround; return to § 1 and ask what the error says about the design.

---

## 3. Principles, applied to this skill

### Ownership is the design

Signatures state the relationships, so write them deliberately:

| Signature | Meaning |
|---|---|
| `fn f(self)` / `fn f(x: T)` | Consumes it. The caller cannot use it afterward (a move into a repository, a DTO handed down) |
| `fn f(&self)` / `fn f(x: &T)` | Shares read access |
| `fn f(&mut self)` / `fn f(x: &mut T)` | Exclusive access. An entity operation (`suspend`) |
| `Arc<dyn Port>` | Shared, read-only dependency, built once in `main.rs` |
| `Arc::clone(&x)` | A visible, cheap pointer copy |

One owner at a time; the use case owns the loaded entity for one `execute`. Shared mutation exists only inside an adapter (`architectural-principles.md` § 2).

### Types first: make the wrong thing impossible

Ask "how can I make this impossible to use incorrectly?" instead of "how do I check for every error?":

```rust
// defensive: runtime checks at every call
fn send(topic_id: u64, body: &[u8]) -> Result<(), String> { if topic_id == 0 { … } if body.is_empty() { … } … }

// type-safe: the checks happened once, at the boundary
fn send(topic: TopicId, body: ValidatedBody) -> Result<MessageId, BrokerError> { /* nothing to re-check */ }
```

Decide in this order: **what invariants hold** (value objects), **what states are valid** (status enum, `Option` for optional), **what transitions are legal** (methods that return `Result`).

### Safety without paranoia

Do not re-validate what a type already guarantees, do not `unwrap()` "because it can't fail" (rule 19 denies it), and do not add `if x.is_none()` guards for something the signature rules out. Trust the types, and put the effort at the boundary where raw data enters (`type-system-patterns.md` § 2).

### Composition over inheritance

Ask "what does this need?" and pass it in. A use case has the ports it uses as fields; an entity has its value objects. `has-a` composed through constructors replaces `is-a` hierarchies (`structural-patterns.md`). Test each part by substituting a fake for one dependency.

### Explicit over clever

- **Named operations, not mode flags.** `suspend()` and `reinstate()`, not `set_status(Status)`; separate use cases, not one with an `action: String`.
- **Explicit conversions.** `From` / `TryFrom` between layers; no implicit coercion, no `Deref` tricks, no operator overloading for domain logic.
- **Specific errors.** A variant per failure (`UserError::EmailTaken`), never `String`.
- **Visible costs.** `Arc<dyn Trait>`, `Box`, `clone()` and `.await` are all written down. If a line pays a cost, the code shows it.

Explicit code is a little longer and much easier to read, test and debug.

### Zero-cost abstractions, chosen consciously

Use the abstractions that compile away and are clearer: newtypes and value objects, iterator chains, enums, generics inside one crate. Spend the runtime cost deliberately and in one place: dynamic dispatch (`dyn`) at the **ports**, because that is the one seam that must vary at runtime. Do not avoid an abstraction out of fear of its cost, and do not hand-optimise before measuring.

### Errors are part of the model

Failure is a domain fact, so model it: feature enums for what can go wrong in the business, `AppError` with an `ErrorKind` across layers, one mapper to HTTP (rule 16). Absence is `Option`; failure is `Result`. Keep the cause (`core-language-patterns.md`).

---

## 4. Tooling as a quality multiplier

The skill's self-audit is three gates, run from the project root (`scripts/run-gates.mjs`):

| Gate | Command | Catches |
|---|---|---|
| Format | `cargo fmt --check` | Formatting disagreements (none left to debate) |
| Lint | `cargo clippy --workspace --all-targets -- -D warnings` | Idiom, `unwrap_used`, `expect_used`, `todo`, `dbg_macro`, `print_stdout` / `print_stderr`, `disallowed_methods` (env reads), plus `unsafe_code = "forbid"` from the workspace lints |
| Architecture | `node ~/.claude/skills/clean-arch/scripts/check-architecture-rust.mjs` | Crate dependencies, I/O crates in `domain` / `usecase`, naming, shapes, fakes, facades, silenced lints, global state, interior mutability in `domain` / `usecase`, generic / stateful / composed use cases, `Deref` and `Default` in the domain, infallible `From<String>` on value objects, ports without `Send + Sync`, `anyhow` outside `app` |

Habits:

- **Run them continuously, not at the end.** `cargo check` while writing, the gates before declaring done, `cargo test` for behavior. A gate that fails late costs more than the same failure early.
- **Fix the code, never the gate** (rule 19, R22). `#[allow(..)]`, `#[rustfmt::skip]`, `--no-verify` and renaming a file so a rule stops matching are all forbidden. If a gate seems wrong, stop and ask the user. The one sanctioned exception is the `#![expect(clippy::disallowed_methods)]` at the top of `config.rs`.
- **Tests may `unwrap()` and `expect()`** (`clippy.toml` allows it inside `#[cfg(test)]` code); production code may not. A test-data builder used from many crates must live inside `#[cfg(test)]` or a dev-only module, or the lint applies to it.
- **Let clippy teach.** Its suggestions move code toward idiomatic Rust; read the explanation before applying a fix.
- **Use `rust-analyzer`** (type hints, inline errors, rename) so the compiler's knowledge is on screen while you write.
- **Document with `cargo doc`.** A short `///` on a port or a value object states its contract; doc tests keep examples honest.

---

## 5. Before you call a change done

Ask, in order. Each question points to the file that answers it.

1. **Direction.** Do all arrows point inward, and do results come back as return values? → `architectural-principles.md` § 1
2. **Ownership.** Is every value owned by one place, with `&mut` only where something truly changes? → `ownership-clone-and-smart-pointers.md`
3. **Types.** Is every invariant a type, parsed once at the boundary? → `type-system-patterns.md`
4. **Lifecycle.** Is each stateful entity a status `enum` with named transitions? → `behavioral-patterns-keeping-track.md`
5. **Errors.** Is every failure a typed value that keeps its cause, with no `unwrap`, no swallowed `Result`? → `core-language-patterns.md`
6. **Polymorphism.** Is every `dyn` a port wired in `main.rs`, and every closed set an enum? → `designing-for-rust-not-oo.md`
7. **Patterns.** Did you reach for a pattern the language or the architecture already provides? → `creational-patterns.md`, `structural-patterns.md`, `behavioral-patterns-actions.md`
8. **Gates.** Do fmt, clippy and the architecture check all pass with nothing silenced? → rule 19

---

## 6. File map

| Topic | File |
|---|---|
| Why Rust is not OO; sub-traits, `Deref`, generics-as-classes, enum misuse | `designing-for-rust-not-oo.md` |
| `clone`, `Rc`, `Arc`, `RefCell`, `Mutex` | `ownership-clone-and-smart-pointers.md` |
| Borrow errors as design feedback; `unsafe`; globals | `borrow-checker-as-design-feedback.md` |
| Factory, Builder, Singleton, Prototype | `creational-patterns.md` |
| Decorator, Adapter, Facade, Composite, Bridge | `structural-patterns.md` |
| Command, Chain, Strategy, Mediator, Template Method | `behavioral-patterns-actions.md` |
| Iterator, State, Memento, Observer, Visitor | `behavioral-patterns-keeping-track.md` |
| Data flow, contained mutability, modules, light structs | `architectural-principles.md` |
| NewType, parse-don't-validate, TypeState, sealed traits | `type-system-patterns.md` |
| Pipelines, type classes, `match`, closures | `functional-patterns.md` |
| `Result` / `Option`, blocks, RAII | `core-language-patterns.md` |

The concrete layout, naming, rules and shapes live in `../architecture/workspace-layout.md`, `../architecture/domain-modeling.md`, `../architecture/use-cases-and-ports.md` and `../architecture/infra-axum-sqlx.md`; the violation checklist is `../architecture/anti-patterns.md`.

---

## Cross-references

- `../architecture/anti-patterns.md` — R22 (making a gate pass without fixing the code), R10 (panicking), R5 (globals).
- `../architecture/workspace-layout.md` — the 19 rules; rule 19 is the self-audit.

Based on *Design Patterns and Best Practices in Rust* (Packt), ch. 13, "Leaning into Rust."
