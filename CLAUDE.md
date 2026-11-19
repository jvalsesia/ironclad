# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A collection of Claude Code skills, not an application. Each top-level directory with a `SKILL.md` is one skill (`<skill>/SKILL.md`, plus optional `references/` loaded on demand and `scripts/` the skill executes). The "code" is mostly prose instructions in `SKILL.md`; editing a skill means editing that markdown. `README.md` is the user-facing overview — keep it in sync when a skill's inputs, outputs or dependencies change.

## Commands

```bash
# clean-arch script tests (Node built-in runner, no install step)
cd clean-arch && npm run test:scaffold     # scaffolder: scripts/scaffold/test/*.test.mjs
cd clean-arch && npm run test:rust-arch    # Rust architecture checker: scripts/test/*.test.mjs
node --test clean-arch/scripts/scaffold/test/plan.test.mjs   # a single test file
node --test --test-name-pattern='<regex>' <file>             # a single test

# installer
./install.sh --dry-run          # preview; --list shows skills, deps and required tools
./install.sh                    # symlink every skill into ~/.claude/skills
```

With the default symlink install, edits here go live in the next Claude Code session. There is no build or lint step for the repo itself.

## The pipeline and its shared contracts

`prd-writer → spec-writer → implement-feature → evaluator ⇄ fix-runner`, with `implement-and-evaluate` (one feature, retry loop, opens the PR) and `implement-and-evaluate-tmux` (a whole wave, one worktree + tmux window per feature) as orchestrators. The skills are coupled only through files they read and write in the *target* project, so a change to one of these formats must be propagated to every skill that reads or writes it:

- **PRD** (`prd-writer`): 9 sections; features `F01…` with wave, priority and dependencies in Section 8.
- **`prd_progress.json`**: per-feature lifecycle state. Its schema and status values (`pending`, `implementing`, `implemented`, `done`, `fail`, `pr-blocked`, `removed`) are canonical in `prd-writer/SKILL.md`; the other skills document only their own writes and must touch only the target feature's entry. Discovery rule shared by all: `progress-path=` argument, else search up from CWD max 4 levels.
- **`docs/F<ID>-<slug>/{spec,plan,contract}.md`** (`spec-writer`): templates in `spec-writer/references/`. `contract.md` (Given/When/Then items + Prerequisites + Coverage Manifest) is the central coupling: `implement-feature` produces its prerequisites, `evaluator` verifies it, `fix-runner` repairs against it.
- **`eval-report-<ts>.md`** (`evaluator`, template in `evaluator/references/`): consumed by `fix-runner` and the orchestrators.

Role boundaries are deliberate and should be preserved when editing: `evaluator` is read-only on the project (only writes its report and its feature's progress entry) and references no other skill; `fix-runner` edits but never judges; `implement-and-evaluate` never edits code and runs every sub-skill in a fresh `general-purpose` subagent; `implement-and-evaluate-tmux` only dispatches (`team-driver.sh` runs `claude --dangerously-skip-permissions "/implement-and-evaluate F<ID>"` per worktree) and must not write `prd_progress.json` in the main checkout unless an absolute `progress-path` was given.

Skill-to-skill runtime dependencies and required CLI tools are hardcoded in `install.sh` (`deps_of`, `tools_of`). Update them when a skill starts invoking another skill or a new tool.

## clean-arch

Independent of the pipeline. `SKILL.md` holds the 19 rules and canonical shapes (TypeScript examples, with a Rust section); depth lives in `references/` and `references/rust/`.

- `scripts/run-gates.mjs` auto-detects TS (6 gates: tsc, eslint, depcruise, check-architecture.ts, madge, knip) vs Rust (3 gates: fmt, clippy, `check-architecture-rust.mjs`) in the cwd, `apps/backend` or `backend`.
- `scripts/scaffold.mjs` (wrapper `scaffold.sh`) is a pipeline of modules: `args → wizard → plan → dry-run | runner/writer`, composing fragments from `templates/scaffold/`.
- **Duplicated files must stay byte-identical:** `scripts/check-architecture.ts` is copied in `templates/initial-project/scripts/` and `templates/scaffold/backend/scripts/`; `linters/.eslintrc.cjs` and `linters/.dependency-cruiser.cjs` are copied in `templates/initial-project/`. Edit all copies together.
- `templates/initial-project-rust/` doubles as the fixture for `test:rust-arch` (tests copy it and mutate it), so it must remain a valid, violation-free project.
- `templates/**/CLAUDE.md` and `templates/project-claude*.md` are templates for *generated* projects, not instructions for this repo. They and the linter configs reference `~/.claude/skills/clean-arch/`, which is why clean-arch assumes a user-level install.

## graft

`graft/` is a local code-graph index (gitignored, re-admitted to search via `.ignore`). Regenerate with `graft build`; don't commit it.
