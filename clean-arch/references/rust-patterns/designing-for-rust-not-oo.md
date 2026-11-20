# Rust — don't design for object orientation

Rust has `struct`, `impl`, `trait` and `Drop`, so it looks like Java or C++ with different spelling. It is not. Designs that start from a class hierarchy compile at first and then get steadily worse. This file lists the OO reflexes that cause that, what to write instead, and where this skill *does* use dynamic polymorphism on purpose.

The rest of the skill already follows these choices (`Arc<dyn Trait>` ports, enums for closed sets, composition for reuse). This file is the reasoning, so you recognise the temptation before you act on it.

---

## 1. Why the OO mapping fails

| OO habit | What Rust actually has |
|---|---|
| Class | `struct`: data plus an `impl` block. No hierarchy; it cannot be extended by a child. |
| Abstract class / interface | `trait`: a **contract**. A "sub-trait" (`trait B: A`) only adds `A`'s contract to `B`'s; it provides nothing to implementors. |
| Base-class method reuse | Does not exist. Reuse comes from composition, free functions and default trait methods. |
| Substituting a child for a parent | Types are distinct and sized. Substitution is explicit: generics (static) or `Box<dyn T>` / `Arc<dyn T>` (dynamic). |
| Objects flowing freely through the system | Data moves under the borrow checker's rules. Design the **data flow** first; the types follow. |

Consequences for this skill's layers:

- Do not draw a class diagram and then translate it. Start from the data each use case needs and where it flows (handler → use case → port → infra).
- Polymorphism is a **choice you pay for** (heap, vtable, `Arc`). Make it where the architecture needs a seam (ports), not by default.

---

## 2. Where dynamic polymorphism is right: ports

`Arc<dyn UserRepository>` is *not* the OO anti-pattern. A port is a genuine runtime seam: `main.rs` picks `PgUserRepository` in production and the in-memory fake in tests, and the use case must not know which. That is the one place a trait object earns its cost. See `../architecture/use-cases-and-ports.md` § 3.

The test for a `dyn`: **"is the concrete type chosen at composition time, in a different crate from the caller?"** If yes, it is a port. If the answer is "it saves me writing an enum", it is the OO reflex; see § 5.

---

## 3. Anti-patterns

### O1. A base trait with "inherited" behavior

❌ Wrong:
```rust
trait Operator { fn pop_operand(&mut self) -> Box<dyn Operand>; fn apply(&mut self) -> Box<dyn Operand>; }
trait BinaryOperator: Operator {
    fn apply_binary(&self, a: Box<dyn Operand>, b: Box<dyn Operand>) -> Box<dyn Operand>;
    fn apply(&mut self) -> Box<dyn Operand> { /* pops, then apply_binary */ }   // not inherited
}
impl BinaryOperator for AdditionOperator { /* … */ }
// error[E0046]: missing `apply` in `impl Operator for AdditionOperator`
```

`BinaryOperator: Operator` is a bound, not a parent class. Implementors must still implement `Operator` in full; the default in the sub-trait does not satisfy it. Chasing this produces `Box<dyn>` everywhere and one screen of boilerplate per operator.

✅ Right: model the closed set as an enum (§ O4), or make each use case a plain struct with one `execute`. In this skill that is `create_user.rs`, `list_users.rs`, … with no shared "base use case".

**Violates rules 10 and 11.** Detection: `[usecase-shape]`, `[usecase-single-execute]` catch the base-class-shaped use case; a "sub-trait" hierarchy is caught in review.

---

### O2. A "base use case", "base entity" or "base repository" trait

❌ Wrong:
```rust
trait UseCase<I, O> { async fn execute(&self, input: I) -> Result<O, AppError>; }
trait CrudRepository<T> { async fn save(&self, t: &T); async fn find_all(&self) -> Vec<T>; }
```

A universal `UseCase` or `CrudRepository<T>` is the abstract-class instinct. It forces every feature into one signature, invites `find_all`, and gives the handler nothing it can use without naming the concrete type anyway.

✅ Right: each use case has its own `…Input`, `…Output` and `execute`; each aggregate has its own repository trait with only the methods that aggregate's use cases need (`../architecture/use-cases-and-ports.md` § 4).

**Violates rules 10 and 13.** Detection: review.

---

### O3. `Deref` to fake inheritance

❌ Wrong:
```rust
impl Deref for AdditionOperator {
    type Target = OperandStack;
    fn deref(&self) -> &OperandStack { &self.stack }
}
addition_operator.push_operand(x);   // "inherited" from OperandStack
addition_operator.clear();           // also compiles. Nobody wanted that.
```

`Deref` exists for smart pointers. Using it to expose an inner type's methods on the outer one:

- leaks the **whole** inner API (including methods added later) into the outer type's public surface;
- cannot be made generic (`impl<T: Operator> Deref for T` violates the orphan rule);
- surprises the next reader, who sees a method that is not defined anywhere on the type.

In this skill the typical victim is an entity or a use case that `Deref`s to a repository, a row struct or a `Vec`.

✅ Right: composition with explicit delegation. Write the two-line forwarding method; it is the API you are choosing to expose:
```rust
impl AdditionOperator {
    pub fn push_operand(&mut self, o: Operand) { self.stack.push_operand(o) }
}
```

**Violates rule 6** (an entity exposes behavior that is not a business operation). Detection: `[no-deref-in-domain]` in `domain`; in other layers, review (`impl Deref` outside genuine pointer-like newtypes).

---

### O4. A type parameter standing in for a base class

❌ Wrong:
```rust
struct Operation<T: OperationType> { symbol: String, op_type: T }

let ops: Vec<Operation<_>> = vec![add_op, mul_op];
// error[E0308]: expected `Operation<Add>`, found `Operation<Multiply>`
```

`Operation<Add>` and `Operation<Multiply>` are unrelated types. There is no "generic `Operation`", so they cannot share a `Vec`, a field or a return type. The design works for exactly one operation at a time and fails the moment you need a heterogeneous collection.

✅ Right: pick by what varies.

| The set of variants is… | Use |
|---|---|
| Closed, known at compile time, you control it | `enum` + `match` (§ O5) |
| Open, chosen at composition time, behind a seam | `Arc<dyn Port>` (§ 2) |
| One concrete type per call site, never mixed | A generic function or `impl Trait` argument |

Generics are for **static** polymorphism: one type, resolved at compile time. The right generic pattern for state machines (typestate) is covered separately; do not use generics to emulate a class tree.

**Violates rule 11** when applied to ports (`CreateUserUseCase<R: UserRepository>` makes `State<Arc<CreateUserUseCase<PgUserRepository>>>` leak infra into the handler). Detection: `[usecase-generic-ports]`.

---

### O5. Enums used where they don't fit

Enums are the idiomatic answer for a closed set with per-variant data. Two ways to ruin that:

**a) Duplicating variant data in fields so methods "don't have to match".**

❌ Wrong:
```rust
enum Operator {
    Addition { lhs: Operand, rhs: Operand, precedence: u8, symbol: char },
    // …every variant repeats precedence and symbol
}
fn new(kind: String, a: Operand, b: Option<Operand>) -> Self {
    match kind.as_str() {
        "sub" => Operator::Addition { /* …, symbol: '-' */ },   // typo: subtraction adds
        "mul" => Operator::Division { /* … */ },                // typo: multiplication divides
        _ => panic!("Unknown operator"),
    }
}
```

You moved the `match` into a stringly-typed constructor, added a runtime failure (`panic!`, `unwrap()`), and created a bug class the compiler cannot see because every variant has the same field types.

✅ Right: keep derived facts (`precedence`, `symbol`) as methods that `match` on the variant. Construct variants directly, or with one constructor per variant. Never select a variant with a `String`.

**b) Nested enums to model a deep hierarchy.**

❌ Wrong:
```rust
enum Operator { Arithmetic(ArithmeticOperator), Text(TextOperator), Date(DateOperator) }
enum Operand  { Numeric(f64), String(String), Range(Range<usize>), Instant(Instant), Duration(Duration) }
// Operator::Text(Concatenate) given Operand::Numeric: only a runtime error can catch it
```

Every level adds a `match` and a runtime type check, and nothing stops a text operator receiving a date operand.

✅ Right: separate concerns by **module** (or by crate), each with its own operator and operand types, so illegal pairings do not type-check. This is the same reason this skill gives each aggregate its own folder, repository and error enum instead of one shared `Operator`-style super-enum.

**Violates rule 3** (feature folders mirrored, one per feature) when a super-enum spans features; a single `enum Error` for the whole domain is the same mistake (use per-feature error enums). Detection: `[shared-whitelist]` catches the dumping ground; the rest is review.

---

### O6. Designing the type tree first, the data flow later

❌ Wrong: a UML diagram of `Entity → AggregateRoot → User`, then implementing `Clone`, `Rc<RefCell<>>` and `Box<dyn>` until the borrow checker stops complaining.

✅ Right: for each use case write down who **owns** the data, who only **reads** it, and where it is **moved**. Entities are owned by the use case for one `execute`; DTOs are moved across the boundary; ports take `&Entity` to save and return owned `Entity` from loads. Shapes that need `Rc` / `RefCell` / `Arc<Mutex<_>>` to compile are a signal to re-draw the flow, not to add wrappers.

**Violates:** the intent of rules 1 and 11 (layers get their dependencies through constructors, not shared mutable state). Detection: review.

---

## 4. Quick decision guide

Before adding a trait, a `dyn`, a type parameter or a `Deref`:

1. **Is it a port?** (swapped between production and test, implemented in `infra`, declared in `domain`.) → `Arc<dyn Trait>`.
2. **Is the set of variants closed and yours?** → `enum` with a `match` in one `impl`.
3. **Do you want to reuse code from another type?** → composition plus an explicit forwarding method, or a free function. Never `Deref`, never a sub-trait.
4. **Do you want one signature for all use cases / repositories?** → Don't. One struct per use case, one trait per aggregate.
5. **Do you need `Vec<Foo<_>>` of different instantiations?** → `Foo<T>` is the wrong shape; use an enum or a trait object.

---

## Cross-references

- `../architecture/use-cases-and-ports.md` — § 3 (why `Arc<dyn Trait>`), § 4 (ports), § 10 (pitfalls).
- `../architecture/domain-modeling.md` — entities, value objects, per-feature error enums.
- `../architecture/anti-patterns.md` — the layer-oriented checklist (R-entries); O-entries here are the language-level companions.

Based on *Design Patterns and Best Practices in Rust* (Packt), ch. 2, "Anti-Pattern: Designing for Object Orientation."
