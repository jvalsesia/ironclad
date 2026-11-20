# CLAUDE.md

This project follows the Clean Architecture + tactical DDD philosophy defined in the `clean-arch` skill of the ironclad Claude Code plugin (`ironclad:clean-arch`), in its **Rust** form.

**Before any structural change** (creating, moving, renaming, or modifying an entity, value object, use case, repository, queries, handler, routes, DTO, error, row mapping, gateway, middleware, or the composition root), invoke the skill via the Skill tool and read its `references/architecture/`.

## Project stack

<!-- Replace these with the actual stack of this project. -->

- **Language**: Rust (edition 2024), Cargo workspace
- **HTTP framework**: axum + tokio
- **Database**: PostgreSQL via sqlx
- **Errors**: thiserror in `domain`/`usecase`/`infra`, anyhow only in `app`
- **Testing**: `cargo test`, use cases against the in-memory fakes in `infra`

## Structural rules

The 19 inviolable rules are defined in the skill's `SKILL.md`; their Rust form is the table in its `references/architecture/workspace-layout.md` § 6. For the reasoning behind them and the Rust idioms and patterns that fit each layer, read its `references/rust-patterns/thinking-in-rust.md`.

## Self-audit gates

Before declaring any structural change complete, run all 3 gates. `$CLEAN_ARCH` is the skill's folder inside the installed plugin; the skill states its path when invoked, and this sets it from a shell:

```bash
CLEAN_ARCH="$(claude plugin list --json | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8")).find(p=>p.id.startsWith("ironclad@"));console.log((p.readFromFolder||p.installPath)+"/clean-arch")')"

cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
node "$CLEAN_ARCH/scripts/check-architecture-rust.mjs"
```

**`git commit/push --no-verify` is forbidden, and so is `#[allow(..)]` to silence a gate.** If a gate fails, fix the code; never bypass.

## Project-specific addenda

<!-- Add anything specific to this project: business glossary, special endpoints,
     conventions that override the skill, deployment notes, etc.
     Keep skill-level prescriptions in the skill; keep project specifics here. -->
