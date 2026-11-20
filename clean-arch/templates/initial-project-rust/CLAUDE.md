# CLAUDE.md

This project follows the Clean Architecture + tactical DDD philosophy defined in the global skill `clean-arch` (`~/.claude/skills/clean-arch/`), in its **Rust** form.

**Before any structural change** (creating, moving, renaming, or modifying an entity, value object, use case, repository, queries, handler, routes, DTO, error, row mapping, gateway, middleware, or the composition root), invoke the skill via the Skill tool and read `references/architecture/`.

## Project stack

<!-- Replace these with the actual stack of this project. -->

- **Language**: Rust (edition 2024), Cargo workspace
- **HTTP framework**: axum + tokio
- **Database**: PostgreSQL via sqlx
- **Errors**: thiserror in `domain`/`usecase`/`infra`, anyhow only in `app`
- **Testing**: `cargo test`, use cases against the in-memory fakes in `infra`

## Structural rules

The 19 inviolable rules are defined in `~/.claude/skills/clean-arch/SKILL.md`; their Rust form is the table in `references/architecture/workspace-layout.md` § 6. For the reasoning behind them and the Rust idioms and patterns that fit each layer, read `references/rust-patterns/thinking-in-rust.md`.

## Self-audit gates

Before declaring any structural change complete, run all 3 gates:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
node ~/.claude/skills/clean-arch/scripts/check-architecture-rust.mjs
```

**`git commit/push --no-verify` is forbidden, and so is `#[allow(..)]` to silence a gate.** If a gate fails, fix the code; never bypass.

## Project-specific addenda

<!-- Add anything specific to this project: business glossary, special endpoints,
     conventions that override the skill, deployment notes, etc.
     Keep skill-level prescriptions in the skill; keep project specifics here. -->
