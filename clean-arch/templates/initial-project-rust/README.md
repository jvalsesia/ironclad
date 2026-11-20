# Clean Architecture starter — Rust

A Cargo workspace laid out per the `clean-arch` skill of the ironclad Claude Code plugin (`ironclad:clean-arch`): one crate per layer, **axum + sqlx + PostgreSQL**, and one worked feature (`user`) to copy the shapes from.

Read the skill's `SKILL.md` for the prescription and its `references/architecture/` for depth. Read this project's `CLAUDE.md` for project-specific addenda.

## Quick start

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/app   # see .env.example
cargo run -p app                # runs the migrations in ./migrations, then serves on :3000
```

```bash
curl -X POST localhost:3000/users -H 'content-type: application/json' -d '{"email":"ada@example.com"}'
curl 'localhost:3000/users?page=1&pageSize=20'
```

`POST /users/{id}/suspend` is a protected route and answers 401 until the project provides a `SessionStore` (see the comment in `crates/app/src/main.rs`).

## Layout

```
crates/
  domain/     # entities, value objects, traits (ports), errors — no I/O crate
  usecase/    # one use case per file — depends on domain only
  infra/      # axum handlers, sqlx repositories, in-memory fakes
  app/        # main.rs (composition root) + config.rs (the only env reader)
migrations/
```

The dependency rule is enforced by the manifests: `domain`'s `Cargo.toml` does not list `infra`, so it cannot import it.

## Self-audit

Before any commit, from this folder:

```bash
# the clean-arch folder inside the installed ironclad plugin
CLEAN_ARCH="$(claude plugin list --json | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8")).find(p=>p.id.startsWith("ironclad@"));console.log((p.readFromFolder||p.installPath)+"/clean-arch")')"

node "$CLEAN_ARCH/scripts/run-gates.mjs"
```

which runs:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
node "$CLEAN_ARCH/scripts/check-architecture-rust.mjs"
```

**Never use `--no-verify`, and never silence a lint to get a gate green.**

## Making it yours

- Rename or delete the `user` feature once you have your own: its folders are `crates/domain/src/user`, `crates/usecase/src/user`, `crates/infra/src/{http,repository,queries}/user`, plus the wiring in `crates/infra/src/http/router.rs` and `crates/app/src/main.rs`.
- Queries use the runtime-checked sqlx functions so the workspace builds without a database. To get compile-time checking, enable sqlx's `macros` feature, switch to `query_as!`, and commit the cache from `cargo sqlx prepare --workspace`.
- `Cargo.lock` is not shipped. Commit the one Cargo generates.
