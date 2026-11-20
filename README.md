# ironclad

Claude Code skills for taking a product from an idea to merged pull requests: write the PRD, spec each feature, implement it, verify it against a behavior contract, and fix what fails. A separate skill keeps Rust backends on a strict Clean Architecture layout.

## The pipeline

```
prd-writer ──▶ spec-writer ──▶ implement-feature ──▶ evaluator ◀──▶ fix-runner
                               └────────── implement-and-evaluate ──────────┘
                               └── implement-and-evaluate-tmux (a whole wave) ──┘
```

Each stage reads the files the previous one wrote, so the stages can be run one at a time or driven end to end by the two orchestrators.

| Stage | Skill | Reads | Writes |
|---|---|---|---|
| Requirements | `prd-writer` | a product description or context files | the PRD (9 sections, features `F01`, `F02`, … grouped in waves) and `prd_progress.json` |
| Specification | `spec-writer` | the PRD and the codebase | `docs/F<ID>-<slug>/spec.md`, `plan.md` and `contract.md` |
| Implementation | `implement-feature` | `spec.md`, `plan.md`, `contract.md` | code, one commit per plan phase |
| Verification | `evaluator` | `contract.md` and the running app | `eval-report-<timestamp>.md` with a verdict per contract item |
| Correction | `fix-runner` | a failing eval report, or a merge conflict | one fix commit |

`contract.md` is what holds the pipeline together. It states the feature's testable promise as Given/When/Then items, derived from the PRD's acceptance criteria and not from the implementation. The evaluator exercises every item directly over HTTP, the browser, the database or the filesystem, and never edits code. The fix runner edits code and never judges the result.

## Skills

| Skill | What it does |
|---|---|
| [`prd-writer`](prd-writer/SKILL.md) | Builds a PRD through rounds of clarifying questions. |
| [`spec-writer`](spec-writer/SKILL.md) | Turns one PRD feature into a spec, a plan and a behavior contract. Given several feature IDs or a wave, it runs them in parallel and accepts its own interview recommendations. |
| [`implement-feature`](implement-feature/SKILL.md) | Implements a feature phase by phase and produces every prerequisite the contract declares (fixtures, seeds, migrations, config defaults). |
| [`evaluator`](evaluator/SKILL.md) | Brings up an environment, exercises every contract item and persists a timestamped report. Read-only on the project. |
| [`fix-runner`](fix-runner/SKILL.md) | Turns failed contract items green, or resolves the merge conflicts of a PR. |
| [`implement-and-evaluate`](implement-and-evaluate/SKILL.md) | Runs `implement-feature` once, then alternates `evaluator` and `fix-runner` until the contract holds, the retry budget (default 3) runs out, or a circuit breaker trips. Opens the PR on success and keeps a journal of every cycle. |
| [`implement-and-evaluate-tmux`](implement-and-evaluate-tmux/SKILL.md) | Runs a whole PRD wave at once: one git worktree and one tmux window per feature, each running `/implement-and-evaluate`, with a live dashboard and a consolidated report at the end. |
| [`clean-arch`](clean-arch/SKILL.md) | Clean Architecture and tactical DDD for Rust backends (axum + sqlx): 19 rules, a canonical Cargo workspace layout, a compiling starter project, and gates that check the rules mechanically. Independent of the pipeline. |

Each `SKILL.md` documents its full input grammar, overrides and edge cases.

## Install

Clone the repo and run the installer:

```bash
git clone git@github.com:jvalsesia/ironclad.git
cd ironclad
./install.sh
```

This symlinks every skill into `~/.claude/skills`, so a later `git pull` updates them in place. Start a new Claude Code session afterwards.

```bash
./install.sh clean-arch evaluator   # only these, plus the skills they invoke
./install.sh --copy                 # copy instead of symlinking; re-run to refresh
./install.sh --project=../my-app    # copy into that project's .claude/skills
./install.sh --dry-run              # show what would happen
./install.sh --list                 # available skills and what each needs
./install.sh --uninstall            # remove what the installer put there
```

Things to know:

- **Dependencies are followed.** Asking for `implement-and-evaluate-tmux` also installs `implement-and-evaluate`, `implement-feature`, `evaluator` and `fix-runner`.
- **Existing skills are left alone.** A skill of the same name that the installer did not put there is skipped and the script exits 1. `--force` replaces it.
- **Copies are overwritten on re-run.** Edits made inside a copied skill are lost the next time the installer refreshes it.
- **`--project` copies by default.** A symlink committed to a project would point at a path that exists only on your machine. `--link` overrides this.
- **`clean-arch` expects `~/.claude/skills`.** Its templates and docs reference `~/.claude/skills/clean-arch/`, so those commands only resolve when it is installed there.

Without a checkout, the installer clones the repo into `~/.local/share/ironclad` and installs from that clone. The repo is private, so fetch the script through an authenticated `gh`:

```bash
gh api repos/jvalsesia/ironclad/contents/install.sh \
  -H 'Accept: application/vnd.github.raw' | bash
```

## Requirements

- [Claude Code](https://claude.com/claude-code).
- `git` in the target project. The implementation skills commit as they go.
- `gh`, authenticated, for the steps that open or read pull requests (`implement-and-evaluate`, and `fix-runner` when given a PR).
- `node` and `cargo` for the `clean-arch` gates.
- `tmux`, `watch`, `lsof` and the `claude` CLI on `PATH` for `implement-and-evaluate-tmux`.

The installer warns when a tool needed by a selected skill is missing. It does not check for `watch` or `lsof`.

## Usage

Inside Claude Code, in the project being built:

```
/prd-writer <product description, or a path to context files>
/spec-writer F03
/spec-writer wave 2
/implement-feature F03
/evaluator F03
/evaluator F03 only failed-last-run
/implement-and-evaluate F03 max 5 retries
/implement-and-evaluate-tmux wave 3 except F04 max-parallel=2
```

Features can be named by ID (`F03`), by folder (`docs/F03-video-upload/`), by a file inside that folder, or by name. Most skills also accept plain-language overrides such as `skip UI`, `keep env` or `no retries`.

`clean-arch` is not usually invoked by hand. Claude loads it when a task touches backend code in a project that follows the architecture, or when the project's `CLAUDE.md` asks for it. Its gates run with:

```bash
node ~/.claude/skills/clean-arch/scripts/run-gates.mjs
```

It runs the 3 Rust gates: `cargo fmt --check`, `cargo clippy -D warnings`, and the architecture check.

## clean-arch

A prescriptive Clean Architecture and tactical DDD skill for Rust backends (axum + tokio, sqlx + PostgreSQL). It fixes one Cargo workspace layout, `domain` ← `usecase` ← `infra` ← `app`, with dependencies pointing inward only, and codifies 19 rules plus canonical shapes for entities, value objects, use cases, ports, repositories, handlers and errors.

| Path | Contents |
|---|---|
| [`SKILL.md`](clean-arch/SKILL.md) | The dependency rule, the 19 rules, canonical shapes and the self-audit gates. |
| [`references/architecture/`](clean-arch/references/architecture/) | Depth on workspace layout, domain modeling, use cases and ports, infra with axum + sqlx, and anti-patterns. |
| [`references/rust-patterns/`](clean-arch/references/rust-patterns/) | Rust idioms and classic design patterns, mapped onto the layers. |
| [`scripts/`](clean-arch/scripts/) | `run-gates.mjs` (fmt, clippy, architecture check) and `check-architecture-rust.mjs`, which enforces the rules mechanically. |
| [`templates/`](clean-arch/templates/) | A compiling, violation-free starter project and the `CLAUDE.md` template for projects that use the skill. |

## What the skills leave in a project

```
docs/
  PRD.md                              wherever prd-writer was told to save it
  prd_progress.json                   per-feature status, next to the PRD
  F03-video-upload/
    spec.md  plan.md  contract.md
    eval-report-<timestamp>.md        one per evaluator run
    eval-screenshots-<timestamp>/     UI and E2E runs only
    orchestration-<timestamp>.md      implement-and-evaluate journal
.claude/worktrees/                    implement-and-evaluate-tmux only
  F03-video-upload/                   one worktree per feature
  .wave-<run-id>/                     lock, status files, wave-status.md
```

## Repository layout

```
<skill>/
  SKILL.md        the skill itself
  references/     templates and depth docs, loaded on demand
  scripts/        executables the skill runs
clean-arch/
  templates/      the Rust starter project and the CLAUDE.md template for projects using the skill
install.sh
```

## Development

The `clean-arch` architecture checker has tests, run with Node's built-in test runner:

```bash
cd clean-arch
npm run test:rust-arch    # Rust architecture checker
```

With the default symlink install, edits made in this checkout take effect in the next Claude Code session.
