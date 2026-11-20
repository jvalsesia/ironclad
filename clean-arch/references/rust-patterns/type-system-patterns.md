# Rust — patterns that use the type system

Four techniques that move correctness from runtime checks into types: **NewType**, **parse, don't validate**, **TypeState** and **sealed traits**. Two of them are the backbone of this skill (`Id<T>` and the self-validating value object); the other two are narrower tools with clear limits. Each section says what to use, where it lives, and where it does *not* belong.

| Pattern | In this skill |
|---|---|
| NewType | `Id<T>`, value objects (`Email`), and any primitive that can be confused or has an invariant |
| Parse, don't validate | `Vo::create(raw) -> Result`, `Config::from_env()`, `TryFrom` at boundaries; downstream code trusts the type |
| TypeState | In-memory, short-lived flows only. **Persisted** lifecycles use a status `enum` |
| Sealed traits | Marker traits and closed families. **Never** a port (ports are meant to be implemented in `infra`) |

Related: `../architecture/domain-modeling.md` (§§ 2–3: value objects, ids), `behavioral-patterns-keeping-track.md` § 2 (State as an enum), `creational-patterns.md` § 1 (constructors), `designing-for-rust-not-oo.md`.

---

## 1. NewType

A newtype wraps a primitive in a distinct type so values that mean different things cannot be swapped. It is a zero-cost abstraction: the wrapper has the same layout as the inner type.

### What to wrap

| Wrap it when… | Example |
|---|---|
| It identifies something, and mix-ups are plausible | `Id<User>` vs `Id<Video>`; `ActorId`; a tenant id |
| It has an invariant | `Email`, `Slug`, `Percentage(0..=100)`, `PageSize(1..=100)` |
| Two values share a primitive but differ in unit or meaning | `Cents` vs `Euros`; `Degrees` vs `Radians` |
| It must not leak when printed | `Password`, `ApiToken`: custom `Debug` that prints `[redacted]` |
| You need a local type for the **orphan rule** | A wrapper around a foreign type so you can implement a foreign trait (`structural-patterns.md` § 3) |

Do **not** wrap every `String`. A free-text `title` with no rule and no confusable sibling gains nothing; the book itself leaves message offsets as a plain `u64` for that reason.

### Shape

IDs are one generic newtype typed by the aggregate (`../architecture/domain-modeling.md` § 3):

```rust
pub struct Id<T> { value: Uuid, marker: PhantomData<fn() -> T> }   // `fn() -> T` keeps it Copy + Send + Sync
pub type UserId = Id<User>;
```

Value objects use a private tuple field and a validating constructor:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Slug(String);
impl Slug {
    pub fn create(raw: &str) -> Result<Self, ArticleError> { /* normalize, check, wrap */ }
    pub fn from_trusted(value: String) -> Self { Self(value) }    // rehydration only
    pub fn as_str(&self) -> &str { &self.0 }
}
```

### Rules

- **Private field.** A `pub` field defeats the type: anyone can write `Slug("")`.
- **No `Deref` to the inner type**, which re-exposes every method of the primitive (O3, `designing-for-rust-not-oo.md`). Give an accessor (`as_str`, `value`).
- **No infallible `From<String>` / `From<u32>`** for a type with an invariant. That is a validation bypass (rule 7). Use `create` or `TryFrom`.
- **No `Deserialize`** on a value object: serde would build it without `create`. Deserialize into a raw field of the Input DTO and call `create` in the use case.
- **Derive only what you need.** `Debug, Clone, PartialEq, Eq` for a VO; add `Hash` / `Ord` when it is a map key or sorted. `Copy` only for small plain values (`Id<T>`, numeric newtypes). Implement the traits of `Id<T>` by hand so `T` is not required to implement them.
- **`Display` for user-facing text** (ids, messages); a **hand-written `Debug`** for anything secret.
- **Name the wrapper after the concept**, not the representation (`Slug`, not `NormalizedString`).

**Violates rules 7 and 8** when broken. Detection: `[vo-private-fields]`, `[vo-create-factory]`, `[vo-not-serializable]`, `[vo-no-infallible-from]`.

---

## 2. Parse, don't validate

Validate-and-forget leaves a raw `String` that *might* be valid; every later function either re-checks it (duplicated, drifting rules) or trusts it (bugs). **Parsing** turns the raw value into a type that can only hold valid data, once, at the boundary. After that, no code checks again.

### Where the boundary is

| Boundary | Parse into |
|---|---|
| HTTP body, path, query | serde deserializes **raw** shape into the Input DTO (shape checks, rule 12). `Id::parse` for path ids |
| Use case entry | `Email::create(&input.email)?`, `Slug::create(..)?`: the invariants (rule 12) |
| Environment / files | `Config::from_env() -> Result<Config, ConfigError>` once, at startup |
| Database rows | `impl From<Row> for Entity` with `from_trusted` / `restore` (the data was parsed on the way in) |
| External APIs | The gateway adapter parses vendor JSON into domain types and errors at the edge |

```rust
// usecase: parse once, then work with types that cannot be invalid
let email = Email::create(&input.email)?;          // &str  →  Email
let user  = User::create(email);                   // takes Email, not &str
```

`User::create(email: &str)` would re-open the door; taking the VO closes it.

### Configuration

Validate configuration when it is **loaded**, and fail fast at startup, not on the first request:

```rust
pub struct Config { port: NonZeroU16, db_max_connections: NonZeroU32, /* … */ }

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> { /* parse each var into its type; collect or return the first error */ }
}
```

- Use the standard library's `NonZero*` types where "not zero" is the whole rule, and a small newtype (`NetworkPort`, `Percentage`) for richer ones.
- Fields are private; getters return the primitive (the stored value is already valid).
- Reading the environment happens only in `config.rs` (rule 2).
- **A builder is optional.** If every field is required, a plain constructor with typed arguments is clearer, and an `Option`-field builder moves a *compile-time* mistake (missing field) to runtime. Use a builder only for many optional fields (`creational-patterns.md` § 3).

### Rules

- **No defensive re-validation downstream.** If `max_connections` is a `NonZeroU32`, do not write `if max_connections == 0` in the broker. Duplicated checks are the thing parsing removes.
- **One rule, one place.** The VO's `create` is the only definition of "valid email". A handler that also checks `contains('@')` is two rules (R13).
- **Return a typed error, not `String`.** `Result<Self, UserError>`; each variant says what failed. Match the variant to the failure: do not reuse an unrelated variant to signal a *missing* field (the book returns `PortInReservedRange(0)` for "port not set").
- **Normalize while parsing** (`trim`, `to_lowercase`) so equal values compare equal.
- **`from_trusted` is for data the system already parsed** (rows it wrote). If the table may hold legacy or hand-edited data, make the row mapping `TryFrom` and fail loudly instead.
- **Parse the whole thing, not pieces of it.** Take `Email` / `Money` as parameters instead of `&str` / `f64` plus a note that "it must be valid".

**Violates rules 7 and 12.** Detection: `[vo-create-factory]`; duplicated checks are review (R13).

---

## 3. TypeState: compile-time state machines

TypeState encodes the state in the type (`Consumer<Disconnected>` → `Consumer<Connected>`), so calling an operation in the wrong state does not compile. Transitions take `self` by value, so the old state cannot be reused.

```rust
pub struct Registration<S> { inner: RegistrationData, _state: PhantomData<fn() -> S> }
pub struct Pending;  pub struct Confirmed;

impl Registration<Pending> {
    pub fn start(email: Email) -> Self { /* … */ }
    pub fn confirm(self, token: &Token) -> Result<Registration<Confirmed>, RegistrationError> { /* … */ }
}
impl Registration<Confirmed> {
    pub fn into_user(self) -> User { /* … */ }              // only exists once confirmed
}
```

### When to use it, and when not

| Situation | Use |
|---|---|
| An **entity whose status is stored in the database** (`Order`: Draft → Placed → Shipped) | **A status `enum`** and `&mut self` transition methods (`behavioral-patterns-keeping-track.md` § 2). A loaded row has to choose its state at runtime, and the repository returns one type |
| A **short-lived, in-memory workflow** inside one use case or one module (registration steps, a protocol/connection session, a multi-step form object) | TypeState |
| A builder where *required* fields must all be set | TypeState builder (`Builder<NoEmail>` → `Builder<HasEmail>`), or just a constructor with all required arguments |
| "Validated vs unvalidated" data | A newtype (§ 2); a `Verified<T>` wrapper when the proof is separate from the data |
| Open or growing set of states | `enum`, or `Box<dyn State>` |

### Rules

- **Do not make a port generic over a state.** `Arc<dyn UserRepository>` takes and returns concrete types; `Order<Draft>` vs `Order<Placed>` would force the repository (and every use case) to be generic or duplicated (R12).
- **Keep the data in one inner struct** and the state in a `PhantomData<fn() -> S>` marker. The book re-lists every field in each transition; a shared `inner` makes a transition a one-line `Registration { inner: self.inner, _state: PhantomData }`.
- **Marker types are zero-sized and sealed** (§ 4) if outsiders must not add states.
- **Fallible transitions:** `self` is consumed, so a failure loses the value. If the caller may retry, return it with the error (`Result<Next, (Self, Error)>` or an error type that holds the original). The book's prose says the original is returned, but its signature returns only `SamsaError`.
- **Test that wrong calls don't compile** with `compile_fail` doctests or `trybuild`, not just that right calls work.
- **Cost is boilerplate**: one `impl` per state. Reach for it when a wrong call is genuinely dangerous or common, not for a three-state enum that a `match` handles.

**Violates rule 6 when it replaces a persisted status.** Detection: review.

---

## 4. Sealed traits

A sealed trait is public to *use* but impossible to *implement* outside its module, because it requires a supertrait that outsiders cannot name:

```rust
mod sealed { pub trait Sealed {} }                 // private module, public trait

pub trait State: sealed::Sealed {}                 // visible, but not implementable externally
pub struct Pending;  impl sealed::Sealed for Pending {}  impl State for Pending {}
```

### When it is right

- **Marker traits for TypeState** (`State`), so no one invents a state.
- A **closed family** of implementations that your code relies on being exactly that set (a fixed set of serialization schemas, a set of supported units).
- A library-style crate whose trait you want to extend later (adding a required method) without breaking external implementors.

### When it is wrong

- **Never seal a port.** A repository, query, or gateway trait exists to be implemented in another crate (`infra`) and by in-memory fakes. Sealing it breaks the architecture.
- **Not for a closed set with per-variant data.** That is an `enum`; it is exhaustive and needs no `Box` (`designing-for-rust-not-oo.md` O5).
- **Not to forbid `unsafe` in implementors.** The book's motivation is "external crates could use `unsafe`"; here `unsafe_code = "forbid"` is already set in the workspace lints (`borrow-checker-as-design-feedback.md` B3).

### Related tools

- **`#[non_exhaustive]`** on a public enum or struct lets a library add variants or fields without a breaking change. Do not put it on `ErrorKind` or other enums that `infra` matches exhaustively inside this workspace; it would force wildcard arms and hide missing cases.
- **Generic over a closed schema type** (`TypedMessage<JsonSchema>`) is fine when the type is known at compile time. When the schema is chosen at runtime (a message arrives and declares its format), use an `enum` instead; generics cannot be mixed in one collection (O4).

### Checking the book's example

- The `JsonSchema::serialize` uses `unwrap_or_default()`, so a serialization failure silently produces **empty bytes**. Return a `Result` instead (rule 19).
- `S::Error` as an associated type on the schema leaks into every caller; prefer one error type per feature (`SchemaError`).

**Violates rule 11** when a port is sealed or made generic by implementor. Detection: review.

---

## 5. Putting them together

The patterns stack, which is why the skill's domain code looks the way it does:

1. **NewType** creates distinct types (`UserId`, `Email`).
2. **Parse, don't validate** makes those types hold only valid data (`create`, `Config::from_env`).
3. **TypeState** (rarely) tracks short-lived transitions between them; the status `enum` does it for stored entities.
4. **Sealed traits** (rarely) close a family you rely on.

A function signature should say almost everything: `fn create(email: Email, owner: UserId) -> User` cannot receive a raw string, an unrelated id, or an invalid address.

---

## 6. Quick decision guide

1. **Two values of the same primitive type that must not be swapped?** → newtype (`Id<T>` for identities).
2. **A value with a rule?** → private-field VO with `create`; never `From<String>`, never `Deserialize`.
3. **Raw input arriving?** → parse once at the boundary; downstream functions take the parsed types.
4. **Configuration?** → `Config::from_env()` returns typed, valid values or fails at startup.
5. **A lifecycle?** → persisted: status `enum` + transition methods. Only in memory and short-lived: TypeState.
6. **Want to stop others implementing a trait?** → seal it, **unless it is a port**.
7. **Closed set with data?** → an `enum`, not a sealed trait.

---

## Cross-references

- `../architecture/domain-modeling.md` — § 2 (value objects), § 3 (`Id<T>`), § 4 (errors).
- `creational-patterns.md` — § 1 (constructor conventions), § 3 (when a builder is worth it).
- `behavioral-patterns-keeping-track.md` — § 2 (State as an enum), § 3 (snapshot and `restore`).
- `structural-patterns.md` — § 3 (adapters, orphan-rule newtypes).
- `designing-for-rust-not-oo.md`, `ownership-clone-and-smart-pointers.md`, `borrow-checker-as-design-feedback.md` — the other language-level companions.
- `../architecture/anti-patterns.md` — R8 (a value object built without validation), R13 (shape checks or invariants in the use case), R12 (generic ports).

Based on *Design Patterns and Best Practices in Rust* (Packt), ch. 10, "Patterns That Leverage the Type System."
