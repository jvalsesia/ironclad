# Rust — creational patterns

How Factory Method, Abstract Factory, Builder, Singleton and Prototype map onto this skill's layers. In Rust most of them are either built into the language or are better served by a convention the skill already enforces. This file says which pattern is which, so you do not reintroduce the heavy OO form.

| Pattern | In Rust | In this skill |
|---|---|---|
| Factory Method | Associated functions returning `Self` | `create`, `restore`, `from_trusted`, `TryFrom` / `FromStr`, row mapping |
| Abstract Factory | Traits + associated types, or just an enum | Almost never. The **composition root** wires a consistent "family" (Pg vs in-memory) |
| Builder | Consuming `self` methods, `build() -> Result` | Rare in production. Common as **test data builders** |
| Singleton | `const`, passing a value, `Arc` | **Forbidden** as a global. Build once in `main.rs`, inject |
| Prototype | `Clone`, `Copy`, `Default`, `Arc`, `Cow` | `Clone` on VOs and DTOs; **never `Default` on entities or value objects** |

Related: `designing-for-rust-not-oo.md` (why the class-based forms do not fit), `ownership-clone-and-smart-pointers.md` (when `clone` and `Arc` are right).

---

## 1. Factory Method: the constructor convention

A Rust "factory method" is an associated function without `self` that returns a concrete type. The skill uses a fixed set of named ones, each with a different meaning:

| Constructor | Meaning | Validates? | New ID / timestamp? |
|---|---|---|---|
| `Entity::create(vo, ..) -> Self` or `Result<Self, FeatureError>` | A brand-new instance | Applies creation rules | Yes |
| `Entity::restore(..) -> Self` | Rehydrate persisted state | No | No |
| `Vo::create(raw) -> Result<Self, FeatureError>` | Self-validating value object | **Yes** | n/a |
| `Vo::from_trusted(raw) -> Self` | The one explicit bypass; row mapping only | No | n/a |
| `impl TryFrom<Raw> for X` / `FromStr` | Fallible conversion at a boundary (config, parsing) | Yes | n/a |
| `impl From<&Entity> for Output` | Mapping out (DTO) | n/a | n/a |
| `Type::new(deps..) -> Self` | Plain wiring: use cases, repositories, gateways | n/a | n/a |

The names carry the intent. Details and examples: `../architecture/domain-modeling.md` §§ 1–2.

### Rules

- **Fields private, constructor public.** The private fields are what make the factory the only way in (rule 6, rule 7).
- **One constructor per meaning.** Do not overload one `new` with a `String` discriminator ("add", "sub", "mul"). Variants are chosen with typed arguments, not strings.
- **`create` takes value objects, not raw strings.** The caller builds `Email::create(..)?` first (`../architecture/domain-modeling.md` § 1).
- **Accept `impl Into<String>` only for non-validated labels.** Never for a value that has an invariant.
- **Infallible `From<String>` for a VO is a validation bypass.** Use `create` or `from_trusted`.
- **Dedicated error type, not `String`.** A parsing constructor returns `Result<Self, FeatureError>` (per-feature `thiserror` enum), not `Result<Self, String>`.

### Parsing text into a closed set

When text maps to an enum, implement `FromStr` or `TryFrom` on the enum and let callers use `.parse()`:

```rust
impl FromStr for Role {
    type Err = RoleError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "admin" => Ok(Self::Admin),
            "member" => Ok(Self::Member),
            other => Err(RoleError::Unknown(other.to_owned())),
        }
    }
}
```

The match is exhaustive over *known* strings and returns a typed error for the rest. Do not hide a `panic!` or `unwrap()` in the default arm.

**Violates rules 6, 7 and 19** when broken. Detection: `[entity-private-fields]`, `[entity-create-factory]`, `[entity-restore-factory]`, `[vo-private-fields]`, `[vo-create-factory]`; stringly-typed selection is caught in review.

---

## 2. Abstract Factory: you rarely need it

The pattern builds *families* of types that must stay consistent. In Rust the family is usually expressed by a trait with associated types, and it adds real complexity (generic `Calculator<F: TokenFactory>`, `F::Number`, `F::Operator` throughout).

Before using it, check the cheaper options:

| Situation | Use |
|---|---|
| One thing varies (number format, repository implementation) | A single trait or generic. No factory. |
| Closed, known set of variants | An `enum` + `match`. |
| Behavior chosen at startup between production and test | **`Arc<dyn Port>`**, wired in the composition root. |
| Several types that must always come together, and mixing them would be a bug | Then (and only then) a trait with associated types. |

### What this skill already does

The **composition root** is the abstract factory. `main.rs` builds one consistent set of adapters and hands them to the use cases; the use cases never name the concrete types:

```rust
// crates/app/src/main.rs
let pool = PgPool::connect(&config.database_url).await?;
let user_repo: Arc<dyn UserRepository> = Arc::new(PgUserRepository::new(pool.clone()));
let user_queries: Arc<dyn UserQueries> = Arc::new(PgUserQueries::new(pool));
let create_user = Arc::new(CreateUserUseCase::new(user_repo.clone()));
```

A test builds the other family (`InMemoryUserRepository`, `InMemoryUserQueries`) and passes it to the same use case. The seam is the port; the "family" is chosen once, in one place (`../architecture/infra-axum-sqlx.md` § 6).

### Do not

- Make use cases generic over a factory type (`CreateUserUseCase<F: RepoFactory>`): the handler would then have to name the concrete types (R12 in `../architecture/anti-patterns.md`).
- Create a `RepositoryFactory` trait whose methods return repositories. It is a service locator in disguise and hides each use case's real dependencies.
- Use associated-type families across layers. The associated types would have to be visible to `usecase`, so `usecase` would know the adapter family.

**Violates rule 11** (constructor injection of `Arc<dyn Trait>` per dependency). Detection: `[usecase-generic-ports]` for a use case generic over a factory; a `RepositoryFactory` trait is review.

---

## 3. Builder: only when it earns its keep

A builder separates construction into steps with validation at the end. Idiomatic Rust uses **consuming** methods (`fn x(mut self, ..) -> Self`) so a builder cannot be reused half-built, and `build(self) -> Result<T, E>` for final validation.

### When it IS worth it

- Many optional fields **plus** cross-field validation that must hold before the value exists.
- A value built incrementally from parsed input where each step can fail.
- **Test data.** A `UserBuilder` in test support that defaults everything and overrides what the test cares about. This is the common case here.

```rust
// test support (dev-dependencies / #[cfg(test)]), not production code
pub struct UserBuilder { email: String, suspended: bool }
impl Default for UserBuilder { fn default() -> Self { Self { email: "a@example.com".into(), suspended: false } } }
impl UserBuilder {
    pub fn email(mut self, e: &str) -> Self { self.email = e.into(); self }
    pub fn suspended(mut self) -> Self { self.suspended = true; self }
    pub fn build(self) -> User {
        let mut u = User::create(Email::create(&self.email).expect("valid test email"));
        if self.suspended { u.suspend().expect("fresh user"); }
        u
    }
}
```

Note the builder calls `create` and the domain methods. It does **not** reach into private fields or use `restore` to fabricate invalid states. (`expect` is acceptable in test support; see `../architecture/use-cases-and-ports.md` § 8.)

### When it is NOT

- Few fields, no cross-field rule: a constructor or a struct literal is clearer. For configuration, use `..Default::default()` (§ 5).
- **Input DTOs.** They are plain structs filled by serde at the handler. No builder.
- **Entities.** `create` and `restore` are the only entry points. A production `UserBuilder` that sets fields freely bypasses the invariants (rule 6).
- A long chain of `.number("2")?.operator("+")?` to assemble something that is really text. Parse the text instead (§ 1).

If a builder does exist in production code, put the type being built as the entry point (`Report::builder()`), keep the built value immutable, and validate everything in `build()`.

**Violates rule 6** when a builder bypasses `create` / `restore`. Detection: review.

---

## 4. Singleton: never as a global

The traditional form (`static mut INSTANCE` behind `unsafe`, or a lazy global) fails every test in this skill: it hides dependencies, cannot be replaced in tests, is not thread-safe without more machinery, and `unsafe_code` is `forbid`den in the starter's workspace lints.

| What you wanted | Do this |
|---|---|
| "One config for the whole program" | `Config::from_env()` in `config.rs`, called once in `main.rs`; pass `Arc<Config>` or the needed fields to constructors (rules 2 and 11) |
| "One DB pool" | Built in `main.rs`; `PgPool` is itself a cheap-clone handle; pass it to the adapters that need it |
| "Compile-time constants" | `const` / `static` for immutable data (a table, a compiled `Regex` via `LazyLock`) |
| "Shared mutable cache / limiter" | A **port** with its own trait; the lock lives inside the `infra` implementation (`ownership-clone-and-smart-pointers.md` C5) |
| "Two calculators with different settings" | Pass a config to each. A singleton would forbid that. |

### Where this skill differs from the book

The book's last resort is `OnceLock<Config>` with `get_config()`. **Do not use it here.** Rule 11 forbids a `static` holding a pool or a config, and rule 2 keeps environment reading in `config.rs` only. A hidden `get_config()` call anywhere re-introduces the global the rule exists to prevent.

**Violates rules 2 and 11.** Detection: `[env-outside-config]`, clippy `disallowed_methods`, `unsafe_code = "forbid"`; a global holding a dependency is `[no-global-state]` (R5 in `../architecture/anti-patterns.md`).

---

## 5. Prototype: `Clone`, `Copy`, `Default`, `Arc`, `Cow`

Rust has no Prototype pattern because the traits already cover it:

| Need | Tool | Use in this skill |
|---|---|---|
| Duplicate a value | `Clone` | Value objects, DTOs, small config. See `ownership-clone-and-smart-pointers.md` before cloning anything large. |
| Duplicate for free | `Copy` | `Id<T>`, small numeric newtypes |
| A sensible base to override | `Default` + `..Default::default()` | **Config and Input DTOs** (`CalculatorConfig::scientific()` style presets), test fixtures |
| Share one immutable template | `Arc<T>` | Shared read-only data across requests |
| Pass-through-unless-modified strings | `Cow<'a, str>` | Parsers and formatters; rare in this stack |

### Do NOT derive `Default` (or `Clone` casually) on entities or value objects

- `Default` on an entity yields an entity that skipped `create`: no real ID, no creation rules (`../architecture/domain-modeling.md` pitfalls).
- `Default` on a value object yields an unvalidated empty value (`Email("")`), a bypass of rule 7.
- Cloning an entity to use as a template produces two aggregates with the **same ID**. A new entity always comes from `create`.

```rust
// ❌
#[derive(Default)] pub struct User { /* … */ }
let template = existing_user.clone();   // same id, same created_at

// ✅
let user = User::create(Email::create("b@example.com")?);   // new id, new timestamp
```

A "template" in the domain is a function that returns arguments for `create`, or a Snapshot used with `restore` in tests.

**Violates rules 6, 7 and 8** (IDs generated in the domain). Detection: `[vo-create-factory]`, `[entity-create-factory]` for missing factories; `[no-default-entity-vo]` for `Default` on an entity or value object.

---

## 6. Quick decision guide

1. **Creating a new domain value?** → `create`. **Rebuilding from storage?** → `restore` / `from_trusted`. **From untrusted text?** → `TryFrom` / `FromStr` returning the feature error.
2. **Choosing an implementation (Pg vs fake)?** → a port, wired in `main.rs`. No factory trait.
3. **Many optional inputs with a final check?** → a consuming builder, ideally in test support only. Otherwise a struct literal with `..Default::default()`.
4. **"Only one of these should exist"?** → build it once in `main.rs` and pass it. No `static`.
5. **"Make me another like this one"?** → `Clone` for VOs and DTOs; for an entity, call `create`.

---

## Cross-references

- `../architecture/domain-modeling.md` — `create` / `restore` / `from_trusted`, ids, errors.
- `../architecture/infra-axum-sqlx.md` — § 5 row mapping (`impl From<Row> for Entity`), § 6 composition root and config.
- `../architecture/use-cases-and-ports.md` — § 3 `Arc<dyn Trait>`, § 8 tests and fakes.
- `designing-for-rust-not-oo.md`, `ownership-clone-and-smart-pointers.md`, `borrow-checker-as-design-feedback.md` — the companions.
- `../architecture/anti-patterns.md` — R5 (globals instead of injection), R6–R8 (entity and VO construction), R12 (generic ports).

Based on *Design Patterns and Best Practices in Rust* (Packt), ch. 5, "Creational Patterns: Making Things."
