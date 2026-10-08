---
name: clean-arch
version: 1.1.0
description: Use when creating, modifying, moving, or renaming any backend artifact (entity, value object, use case, repository, query, handler, route, DTO, error, mapper, gateway, middleware, composition root) in a TypeScript or Rust backend; when the user asks for a new endpoint, feature, CRUD, or backend change; when the user mentions clean architecture, DDD, domain, layer, infra, use case, aggregate, Cargo workspace layering, axum or sqlx structure; or whenever a project's CLAUDE.md asks to use this skill.
---

# Clean Architecture + tactical DDD

Prescriptive philosophy and folder organization for backend projects. Codifies one way to do things so the codebase stays consistent. Read this file first; load `references/` for depth on a specific topic.

If the project follows this architecture (`src/domain/`, `src/usecase/`, `src/infra/`, or a CLAUDE.md referencing this skill), follow the rules strictly.

**Two languages, one philosophy.** The rules below are language-independent. The examples in this file are TypeScript. For a **Rust** backend (a `Cargo.toml` with `crates/domain` or `src/domain`), read this file for the rules, then go to [Rust backends](#rust-backends) for the layout, shapes and gates, and to `references/rust/` for depth.

---

## The dependency rule (read first, internalize)

```
              ┌─────────────────────────────────────┐
              │           src/main.ts               │  composition root
              │     (only place that does `new`     │
              │      on infra concrete classes)     │
              └────────────┬────────────────────────┘
                           │ imports
              ┌────────────▼────────────────────────┐
              │            src/infra/               │  external world
              │  http/   repository/   queries/     │  (HTTP, DB, APIs,
              │  gateway/   persistence/            │   filesystem, queues)
              └────────────┬────────────────────────┘
                           │ imports
              ┌────────────▼────────────────────────┐
              │           src/usecase/              │  application
              │  (orchestration, no business rules) │
              └────────────┬────────────────────────┘
                           │ imports
              ┌────────────▼────────────────────────┐
              │           src/domain/               │  business core
              │  entities, VOs, interfaces, errors  │
              │  (zero dependencies on outer layers)│
              └─────────────────────────────────────┘
```

**Arrows point inward, never outward.**

- `domain/` imports nothing from `usecase/`, `infra/`, or `config/`. Pure business.
- `usecase/` imports only from `domain/`. Never from `infra/`.
- `infra/` may import from `domain/` and `usecase/`. It implements interfaces defined inward.
- `main.ts` (composition root) may import everything. It is the only place where concrete `infra` classes are instantiated with `new`.
- `config/` (env reading) is the only top-level folder besides the three layers. `process.env` is forbidden everywhere except `src/config/env.ts`.

The flow of a request:

```
HTTP Request
    → Handler (parses, validates shape, builds InputDTO)
        → UseCase.execute(InputDTO)
            → Repository.findById() / Queries.list() / Gateway.call()
                ← Entity / DTO / external response
            → Entity.someBusinessMethod()
            → Repository.save(entity)
            ← OutputDTO
        ← OutputDTO
    ← HTTP Response (serialized)
```

---

## Canonical folder structure

```
src/
  config/
    env.ts                                  # the ONLY place reading process.env
  domain/
    _shared/                                # whitelisted: id, errors, unit-of-work, pagination
      id.vo.ts
      errors.ts                             # AppError + DomainError/NotFoundError/ConflictError (abstract) + UnauthenticatedError/ForbiddenError/InvalidIdError (concrete)
      unit-of-work.ts                       # opt-in interface
      pagination.ts                         # PageInput, PageOutput<T>
    user/
      user.entity.ts
      email.vo.ts
      hashed-password.vo.ts
      user-id.vo.ts
      user.repository.ts                    # interface (write side)
      user.queries.ts                       # interface (read side)
      errors.ts                             # InvalidEmailError, UserNotFoundError, ...
    video/
      video.entity.ts
      video-id.vo.ts
      video-status.vo.ts
      video.repository.ts
      video.queries.ts
      errors.ts
  usecase/
    user/
      create-user.usecase.ts
      create-user.dto.ts
      create-user.usecase.spec.ts
      authenticate-user.usecase.ts
      authenticate-user.dto.ts
      authenticate-user.usecase.spec.ts
      list-users.usecase.ts                 # uses UserQueries (read side)
      list-users.dto.ts
    video/
      ...
  infra/
    http/
      handler.ts                            # interface Handler
      types.ts                              # HttpRequest, HttpResponse, HttpRoute
      error-handler.ts                      # toHttpResponse(err) — central mapping
      middleware/
        auth.ts                             # extracts current user, populates req.user
      user/
        create-user.handler.ts
        authenticate-user.handler.ts
        user.routes.ts                      # exports HttpRoute[]
      video/
        ...
      index.ts                              # buildHttpRoutes(deps): HttpRoute[]
    repository/
      user/
        user.prisma-repository.ts           # implementation
        user.in-memory-repository.ts        # fake (LSP-substitutable)
        user.mapper.ts                      # Entity ↔ persistence row
      video/
        ...
    queries/
      user/
        user.prisma-queries.ts
        user.in-memory-queries.ts
      video/
        ...
    gateway/
      openai-transcription.gateway.ts       # external API adapter
      local-storage.gateway.ts
    persistence/
      transaction-context.ts                # AsyncLocalStorage for UoW
      prisma-unit-of-work.ts                # opt-in implementation
  main.ts                                   # composition root: wires everything
```

**Rules for the folder structure**:
- Submodules per feature, mirrored across `domain/`, `usecase/`, `infra/repository/`, `infra/queries/`, `infra/http/`. The same feature name (`user/`, `video/`) appears in every layer.
- Inside a feature folder: **flat**. No `upload-video/upload-video.usecase.ts` nested folder. Use file naming + suffix to group.
- `_shared/` (in `domain/`) is a **whitelist**: only `id.vo.ts`, `errors.ts`, `unit-of-work.ts`, `pagination.ts`. If you want to add anything else there, stop and re-evaluate — it probably belongs to a feature.
- Tests are co-located with the file under test (`*.spec.ts` next to `*.ts`). See `references/testing.md` for what to test.

---

## The 19 inviolable rules

### Structural

1. **Three layers, dependency rule**: `domain/` ← `usecase/` ← `infra/`. Arrows inward only. Never reverse.
2. **`config/` is the only top-level folder besides the three layers**. `process.env` is forbidden anywhere except `src/config/env.ts`.
3. **Feature folders are mirrored** across `domain/`, `usecase/`, `infra/repository/`, `infra/queries/`, `infra/http/`. Same name, same boundary.
4. **No barrel files** (`index.ts` re-exporting many things). Imports go to the specific file: `from '@/domain/user/user.entity'`, never `from '@/domain/user'`. Single allowed exception: `infra/http/index.ts` (the routes builder). `main.ts` is unaffected — it is a single file, not a barrel.
5. **`domain/_shared/` is a closed whitelist**: `id.vo.ts`, `errors.ts`, `unit-of-work.ts`, `pagination.ts`. Anything else you want to put there belongs to a feature.

### Domain

6. **Domain is rich**: entities have private constructors, `static create()` (applies creation rules) and `static restore()` (rehydrates from persistence without re-running creation rules), mutations via methods with domain-meaningful names (`suspend()`, `rename(title)`), getters only — **no `set` keyword, ever**.
7. **Value objects are self-validating**: private constructor, `static create()` factory that validates, `value` getter, `equals(other)` method.
8. **IDs are generated in the domain** via `Id.generate()` (UUID v4). Each feature has a typed VO (`UserId extends Id`, `VideoId extends Id`) so the type system catches misuse.
9. **Domain may use external libraries** for validation (zod, valibot, class-validator), dates (date-fns, dayjs), and numerics (decimal.js, big.js) inside VOs and entities. Domain may **NOT** import any I/O library (Prisma, axios, fs, http) — those belong to `infra/`.

### Use Cases

10. **One use case = one class with a single public method `execute(input): Promise<output>`**. If you find yourself adding a second public method, you have two use cases — split them.
11. **Dependencies via constructor (DI), always**. No service locator, no singleton imports, no `new SomeRepository()` inside the use case. The composition root wires everything.
12. **Use cases never validate input shape** (that's the handler's job) and **never contain business invariants** (that's the entity's job). Use cases only orchestrate and may verify **inter-aggregate rules requiring queried state** (e.g., "is this email already taken?" → `userRepo.findByEmail(...)`).

### Read vs Write

13. **CQRS-lite**: write-side use cases use `Repository<T, Id>` (returns Entity). Read-side use cases use `Queries` (returns DTO directly). Both interfaces live in `domain/<feature>/`; both implementations live in `infra/`.
14. **Repository contract is canonical**: every `Repository<T, Id>` implements at minimum `findById(id)`, `save(aggregate)` (upsert), `delete(id)`. Add `findByX` only when needed for uniqueness checks.
15. **Repository returns Entity / Aggregate Root**, never raw rows or DTOs. Mapping happens inside the implementation, in `<feature>.mapper.ts`.

### HTTP / Boundary

16. **Handler is one class, one method `handle(req): Promise<response>`**. It parses the body, validates shape with a schema library (zod, valibot, class-validator), calls the use case, maps the result. **`try/catch` is forbidden in handlers** — exceptions delegate to `toHttpResponse(err)` in `infra/http/error-handler.ts`.
17. **Entities are never serialized directly**. Handlers always return DTOs. Each use case provides a `toOutput(entity): OutputDTO` function in its `.dto.ts`. Entity has a `toJSON()` that throws to fail-loud if anyone tries `JSON.stringify(entity)`.
18. **Authentication in middleware, authorization in use case**. Middleware (in `infra/http/middleware/auth.ts`) populates `req.user` from session/JWT and rejects unauthenticated requests with 401. **For authenticated operations**, the handler passes `actorId` into the use case input, and the use case enforces authorization rules that depend on domain state ("only the owner can delete this video", "only admins can suspend"). Anonymous endpoints (registration, login) do not pass `actorId`.

### Process

19. **Self-audit before declaring done**: run all 6 gates listed below. **`--no-verify` on commit/push is forbidden**. If a gate fails, fix the code — never the gate. If you believe the gate is wrong, stop and ask the user; do not bypass.

---

## Canonical shapes (minimal examples)

The four artifacts below are the most-used patterns. For repository implementations, queries, errors hierarchy, and composition root, see the corresponding files in `references/`.

### Entity (rich, factories, no setters)

```ts
// domain/user/user.entity.ts
export class User {
  private constructor(
    private readonly _id: UserId,
    private _email: Email,
    private _password: HashedPassword,
    private _isSuspended: boolean,
    private readonly _createdAt: Date,
  ) {}

  static create(props: { email: string; password: string }): User {
    return new User(
      UserId.generate(),
      Email.create(props.email),
      HashedPassword.create(props.password),
      false,
      new Date(),
    );
  }

  static restore(props: { id: string; email: string; hashedPassword: string; isSuspended: boolean; createdAt: Date }): User {
    return new User(
      UserId.from(props.id),
      Email.fromTrusted(props.email),
      HashedPassword.restore(props.hashedPassword),
      props.isSuspended,
      props.createdAt,
    );
  }

  suspend(): void {
    if (this._isSuspended) throw new UserAlreadySuspendedError(this._id.value);
    this._isSuspended = true;
  }

  get id(): string { return this._id.value; }
  get email(): string { return this._email.value; }
  get isSuspended(): boolean { return this._isSuspended; }
  get createdAt(): Date { return this._createdAt; }

  toJSON(): never {
    throw new Error('Do not serialize Entity directly. Use toOutput() in the use case DTO.');
  }
}
```

### Value Object (validation via library is encouraged)

```ts
// domain/user/email.vo.ts
import { z } from 'zod';
import { InvalidEmailError } from './errors';

const schema = z.string().trim().toLowerCase().email();

export class Email {
  private constructor(public readonly value: string) {}

  static create(raw: string): Email {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new InvalidEmailError(raw);
    return new Email(parsed.data);
  }

  /** Skips validation. Only for rehydration from a trusted source (DB). */
  static fromTrusted(value: string): Email {
    return new Email(value);
  }

  equals(other: Email): boolean {
    return this.value === other.value;
  }
}
```

Use whatever validation library reads best (zod, valibot, class-validator). Hand-rolled regex is fine for trivial cases. The point is: domain owns the rule, regardless of who validates.

### Use Case (single `execute`, DI, no validation)

```ts
// usecase/user/create-user.usecase.ts
import { User } from '@/domain/user/user.entity';
import type { UserRepository } from '@/domain/user/user.repository';
import { UserAlreadyExistsError } from '@/domain/user/errors';
import { type CreateUserInput, type CreateUserOutput, toOutput } from './create-user.dto';

export class CreateUserUseCase {
  constructor(private readonly userRepo: UserRepository) {}

  async execute(input: CreateUserInput): Promise<CreateUserOutput> {
    const existing = await this.userRepo.findByEmail(input.email);
    if (existing) throw new UserAlreadyExistsError(input.email);

    const user = User.create({ email: input.email, password: input.password });
    await this.userRepo.save(user);

    return toOutput(user);
  }
}
```

### Handler (single `handle`, zod for shape, no try/catch)

```ts
// infra/http/user/create-user.handler.ts
import { z } from 'zod';
import type { Handler } from '@/infra/http/handler';
import type { HttpRequest, HttpResponse } from '@/infra/http/types';
import type { CreateUserUseCase } from '@/usecase/user/create-user.usecase';
import type { CreateUserInput } from '@/usecase/user/create-user.dto';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
}) satisfies z.ZodType<CreateUserInput>;

export class CreateUserHandler implements Handler {
  constructor(private readonly createUser: CreateUserUseCase) {}

  async handle(req: HttpRequest): Promise<HttpResponse> {
    const input = schema.parse(req.body);
    const output = await this.createUser.execute(input);
    return { status: 201, body: output };
  }
}
```

---

## Naming and suffixes

| Artifact            | File pattern                  | Class/Type pattern        |
|---------------------|-------------------------------|---------------------------|
| Entity              | `<feature>.entity.ts`         | `class Feature`           |
| Value Object        | `<concept>.vo.ts`             | `class Concept`           |
| Use Case            | `<action>-<feature>.usecase.ts` | `class ActionFeatureUseCase` |
| DTO                 | `<action>-<feature>.dto.ts`   | `type ActionFeatureInput`, `type ActionFeatureOutput` |
| Repository (iface)  | `<feature>.repository.ts`     | `interface FeatureRepository` |
| Repository (impl)   | `<feature>.<provider>-repository.ts` | `class Feature<Provider>Repository` |
| Queries (iface)     | `<feature>.queries.ts`        | `interface FeatureQueries` |
| Queries (impl)      | `<feature>.<provider>-queries.ts` | `class Feature<Provider>Queries` |
| Mapper              | `<feature>.mapper.ts`         | `class FeatureMapper` (static methods) |
| Handler             | `<action>-<feature>.handler.ts` | `class ActionFeatureHandler` |
| Routes              | `<feature>.routes.ts`         | `function <feature>Routes(deps): HttpRoute[]` |
| Gateway (iface)     | `<concept>.gateway.ts`        | `interface ConceptGateway` |
| Gateway (impl)      | `<provider>-<concept>.gateway.ts` | `class ProviderConceptGateway` |
| Error               | inside `errors.ts`            | `class XxxError`          |
| Test                | `<file>.spec.ts`              | —                         |

All file names are **kebab-case**. All class names are **PascalCase**. All types and interfaces are **PascalCase** (no `I` prefix on interfaces).

---

## Validation responsibilities

| Where           | Validates                                                  | On failure                          |
|-----------------|------------------------------------------------------------|-------------------------------------|
| **Handler**     | Shape: required fields, JSON types, basic format (zod schema) | `ZodError` → 400 Bad Request       |
| **Domain**      | Invariants of a single aggregate: `Email.create()` validates format, `HashedPassword.create()` validates strength before hashing, `Video.duration` ≤ 2h | `DomainError` subclass → 400/422 |
| **Use Case**    | Inter-aggregate rules requiring queried state: "is email already taken?", "is the actor the owner?" | `ConflictError`/`ForbiddenError` → 403/409 |

Use cases **never** validate shape (`if (!input.email)` is a smell — handler should have caught it). Entities **never** validate inter-aggregate rules (they don't have repo access).

---

## Repository vs Queries — decision rule

**Use `Repository<T, Id>`** when:
- The use case will **mutate** the loaded data (rename, suspend, delete).
- The use case needs the entity to enforce business rules (`video.markAsReady()`).
- You're checking uniqueness for a write (`userRepo.findByEmail(...)` to reject duplicates).

**Use `Queries`** when:
- The use case **only reads** for display (list, get-detail, search).
- The output is meant for the UI / API consumer, not for further mutation.
- You need aggregated, derived, or joined data that doesn't fit the entity (`videoCount` per user, `latestUpload`).

Same feature → both contracts. `domain/video/video.repository.ts` (write) and `domain/video/video.queries.ts` (read) coexist.

---

## Self-audit checklist (mandatory)

After **any** structural change (new file, moved file, renamed file in `domain/`, `usecase/`, or `infra/`), run all 6 gates and fix any failure before declaring the task done:

You can run the full set with the skill helper:

`node .claude/skills/clean-arch/scripts/run-gates.mjs`

From a monorepo root, the helper auto-detects `apps/backend` or `backend`; otherwise run it from the backend root or pass `--cwd=<backend-path>`. In a Rust project it runs the 3 Rust gates instead — see [Rust backends](#rust-backends).

1. `npx tsc --noEmit -p tsconfig.json` — TypeScript strict, zero errors.
2. `npx eslint . --max-warnings=0` — zero warnings (skill ships with `.eslintrc.cjs`).
3. `npx depcruise src --config .dependency-cruiser.cjs` — zero cross-layer violations.
4. `npx tsx scripts/check-architecture.ts` — zero structural violations (factories, SRP, no setters, etc.).
5. `npx madge --circular --extensions ts src` — zero circular dependencies.
6. `npx knip` — zero orphan exports.

Husky enforces gates 1–2 on `pre-commit` and gates 3–6 on `pre-push`.

**`git commit --no-verify` and `git push --no-verify` are forbidden.** If a gate fails, fix the code. If you genuinely believe the gate itself is wrong, stop and ask the user — do not bypass.

---

## Rust backends

Same three layers, same 19 rules. What changes is the mechanics. Default stack: **axum + tokio, sqlx + PostgreSQL, thiserror in libraries, anyhow only in the binary.** A complete, compiling example is in `templates/initial-project-rust/`.

### Layout

```
backend/
  Cargo.toml                     # [workspace] + shared versions + shared lints
  clippy.toml
  migrations/
  crates/
    domain/src/                  # no workspace deps, no I/O crates
      shared/                    # whitelist: id, errors, pagination, unit_of_work, event
      user/                      # mod.rs, user_entity.rs, email_vo.rs,
                                 # user_repository.rs, user_queries.rs, errors.rs
    usecase/src/                 # depends on domain only
      user/                      # create_user.rs, list_users.rs, suspend_user.rs
    infra/src/                   # depends on domain + usecase
      http/                      # router.rs, error.rs, extract.rs, middleware/auth.rs
        user/                    # create_user_handler.rs, …, user_routes.rs
      repository/user/           # pg_user_repository.rs, in_memory_user_repository.rs, user_row.rs
      queries/user/              # pg_user_queries.rs, in_memory_user_queries.rs
      gateway/  persistence/
    app/src/                     # main.rs (composition root), config.rs (only env reader)
```

One crate per layer is the default because **Cargo enforces the dependency rule**: `domain`'s manifest does not list `infra`, so importing it does not compile. Small projects may use a single crate with the same tree under `src/` (`src/domain`, `src/usecase`, `src/infra`, `src/config.rs`, `src/main.rs`); the architecture check then enforces the rule instead. No third layout.

### What changes from TypeScript

| Topic                 | TypeScript                                   | Rust                                                                 |
|-----------------------|----------------------------------------------|----------------------------------------------------------------------|
| Dependency rule       | dependency-cruiser                           | `Cargo.toml` per crate (the compiler)                                |
| File names            | `kebab-case` + dotted suffix (`user.entity.ts`) | `snake_case` + underscore suffix (`user_entity.rs`)               |
| Entity                | private constructor, `static create/restore` | private fields, `pub fn create` / `restore`, no `pub` field, no `set_*` |
| Value object          | private constructor, `equals`                | private field, `create -> Result`, `from_trusted`, `PartialEq`       |
| ID                    | `UserId extends Id`                          | `pub type UserId = Id<User>` (phantom-typed)                         |
| Errors                | `throw` an `AppError` subclass               | `Result<_, AppError>`; per-feature `enum` + `From<FeatureError> for AppError`; no panics |
| Use case + DTO        | `x.usecase.ts` + `x.dto.ts`                  | one file: `XInput`, `XOutput`, `XUseCase`                            |
| Dependency injection  | constructor params typed by interface        | `Arc<dyn Trait>` fields set in `new`                                 |
| Mapper                | `<feature>.mapper.ts`                        | `<feature>_row.rs`: `impl From<FeatureRow> for Feature`               |
| Handler               | class with `handle`, zod schema, no `try/catch` | one `pub async fn`, serde body struct, `?` only — no `match`/`map_err` on errors |
| Entity serialization  | `toJSON()` throws                            | entities and VOs never derive `Serialize`/`Deserialize`              |
| Barrel files          | forbidden                                    | `mod.rs`/`lib.rs` are facades: declarations + named re-exports, no logic, no globs |
| Env                   | `src/config/env.ts`                          | `crates/app/src/config.rs`, enforced by clippy `disallowed-methods`  |
| Tests                 | `*.spec.ts` next to the file                 | `#[cfg(test)] mod tests` as the last item of the file                |

### Canonical shapes

```rust
// domain/src/user/user_entity.rs — rich, closed, not serializable
pub type UserId = Id<User>;

#[derive(Debug, Clone)]
pub struct User { id: UserId, email: Email, is_suspended: bool, created_at: DateTime<Utc> }

impl User {
    pub fn create(email: Email) -> Self { /* generates the id, applies creation rules */ }
    pub fn restore(id: UserId, email: Email, is_suspended: bool, created_at: DateTime<Utc>) -> Self { /* no rules */ }
    pub fn suspend(&mut self) -> Result<(), UserError> { /* the invariant lives here */ }
    pub const fn id(&self) -> UserId { self.id }
}
```

```rust
// domain/src/user/user_repository.rs — port
#[async_trait]
pub trait UserRepository: Send + Sync {
    async fn find_by_id(&self, id: UserId) -> Result<Option<User>, AppError>;
    async fn find_by_email(&self, email: &Email) -> Result<Option<User>, AppError>;  // uniqueness check only
    async fn save(&self, user: &User) -> Result<(), AppError>;   // upsert
    async fn delete(&self, id: UserId) -> Result<(), AppError>;
}
```

```rust
// usecase/src/user/create_user.rs — Input + Output + one execute
pub struct CreateUserUseCase { user_repo: Arc<dyn UserRepository> }

impl CreateUserUseCase {
    pub fn new(user_repo: Arc<dyn UserRepository>) -> Self { Self { user_repo } }

    pub async fn execute(&self, input: CreateUserInput) -> Result<CreateUserOutput, AppError> {
        let email = Email::create(&input.email)?;
        if self.user_repo.find_by_email(&email).await?.is_some() {
            return Err(UserError::EmailTaken(email.as_str().to_owned()).into());
        }
        let user = User::create(email);
        self.user_repo.save(&user).await?;
        Ok(CreateUserOutput::from(&user))
    }
}
```

```rust
// infra/src/http/user/create_user_handler.rs — extract, build Input, execute, return
pub async fn create_user_handler(
    State(create_user): State<Arc<CreateUserUseCase>>,
    ApiJson(body): ApiJson<CreateUserBody>,
) -> Result<(StatusCode, Json<CreateUserOutput>), HttpError> {
    let output = create_user.execute(CreateUserInput { email: body.email }).await?;
    Ok((StatusCode::CREATED, Json(output)))
}
```

### Self-audit gates (Rust)

```bash
node .claude/skills/clean-arch/scripts/run-gates.mjs      # detects Rust and runs all three
```

1. `cargo fmt --all -- --check` — formatting.
2. `cargo clippy --workspace --all-targets -- -D warnings` — compiles everything; denies `unwrap`, `expect`, `todo!`, `dbg!` outside tests, `unsafe`, and `std::env::var` outside `config.rs`.
3. `node .claude/skills/clean-arch/scripts/check-architecture-rust.mjs` — crate dependencies, I/O crates in `domain`/`usecase`, naming per location, use case / entity / VO / handler shapes, in-memory fakes, `shared` whitelist, `mod.rs` facades.

Three gates, not six: Cargo already rejects cross-layer and circular crate dependencies, and clippy includes the type check. Rule 19 applies unchanged — and adding `#[allow(..)]` to quiet a gate counts as bypassing it.

### Rust reference index

- **`rust/workspace-layout.md`** — both layouts, `Cargo.toml` per crate, the naming table, `mod.rs` facades, where tests live, **the 19 rules restated for Rust**, where the layout comes from.
- **`rust/domain-modeling.md`** — entities, value objects, `Id<T>`, `AppError` / `ErrorKind`, per-feature error enums, what `domain` may depend on.
- **`rust/use-cases-and-ports.md`** — use case shape, DTOs, why `Arc<dyn Trait>`, repository / queries / gateway traits, authorization, pagination, tests, multiple writes.
- **`rust/infra-axum-sqlx.md`** — handlers, extractors, the central `HttpError` mapper, routes, authentication, sqlx repositories and row mapping, in-memory fakes, composition root, config.
- **`rust/anti-patterns.md`** — Rust-specific violations and which gate catches each. Load it before any non-trivial structural change in a Rust project.

The topic references below (`domain-events.md`, `cross-feature-use-cases.md`, `solid-principles.md`, …) are written with TypeScript examples, but their reasoning applies to Rust as is.

---

## Reference index

For depth on specific topics, load the relevant file from `references/`:

- **`folder-structure.md`** — full canonical tree, where every artifact lives, how to add a new feature, cross-feature use case placement.
- **`domain-modeling.md`** — entities, value objects, factories (`create` vs `restore`), aggregate roots, IDs, where errors live.
- **`use-case-pattern.md`** — class shape, DTO conventions, validation flow, pagination contract.
- **`repository-and-queries.md`** — CQRS-lite, contract methods, mappers, in-memory fakes, gateways for external APIs.
- **`composition-root.md`** — `main.ts` structure, dependency wiring order, framework-agnostic adapters, Unit of Work mechanism (opt-in).
- **`error-handling.md`** — error class hierarchy, HTTP status mapping, central `toHttpResponse` adapter.
- **`authorization.md`** — middleware (auth) vs use case (authz), `actorId` pattern, common scenarios.
- **`config-and-env.md`** — `src/config/env.ts` shape, why `process.env` is restricted.
- **`cross-feature-use-cases.md`** — where multi-feature flows live (default: primary aggregate's feature folder).
- **`domain-events.md`** — when to use them, publish from use case (never from entity), event handlers in `infra/event-handlers/`.
- **`solid-principles.md`** — SRP/OCP/LSP/ISP/DIP applied to this architecture, with anti-patterns referenced.
- **`testing.md`** — co-location, `.spec.ts`, fakes vs mocks, structural conventions only (the *what* and *how* of testing belong to a separate testing skill).
- **`anti-patterns.md`** — comprehensive list of violations the agent must actively avoid: detection rules, why they are bad, how to fix.

Load `anti-patterns.md` before any non-trivial structural change. It is the most operational reference.
