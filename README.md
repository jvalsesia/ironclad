# ironclad

Claude Code skills for building Rust backends on a strict Clean Architecture. At the core is `clean-arch`: one Cargo workspace layout (`domain` ← `usecase` ← `infra` ← `app`, dependencies pointing inward only), 19 rules with canonical shapes for axum + sqlx + PostgreSQL, and gates (cargo fmt, clippy, an architecture checker) that enforce them mechanically, so the layering holds as the codebase grows instead of eroding one shortcut at a time.

Around it sits a pipeline that takes a product from an idea to merged pull requests: write the PRD, spec each feature, implement it, verify it against a behavior contract, and fix what fails. The pipeline itself is stack-agnostic; on a Rust backend, `clean-arch` keeps every feature it implements inside that architecture.

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
| [`implement-and-evaluate-tmux`](implement-and-evaluate-tmux/SKILL.md) | Runs a whole PRD wave at once: one git worktree and one tmux window per feature, each running `/ironclad:implement-and-evaluate`, with a live dashboard and a consolidated report at the end. |
| [`clean-arch`](clean-arch/SKILL.md) | Clean Architecture and tactical DDD for Rust backends (axum + sqlx): 19 rules, a canonical Cargo workspace layout, a compiling starter project, and gates that check the rules mechanically. Independent of the pipeline. |

Each `SKILL.md` documents its full input grammar, overrides and edge cases.

## Install

ironclad is a Claude Code plugin: the repo is both the plugin and its own marketplace (`.claude-plugin/`). Its skills are namespaced, so `evaluator` is invoked as `/ironclad:evaluator` and cannot collide with another skill of the same name.

Clone the repo and run the installer:

```bash
git clone git@github.com:jvalsesia/ironclad.git
cd ironclad
./install.sh
```

This registers the checkout as a marketplace and installs the plugin for your user. The plugin loads in place from the checkout, so edits and a later `git pull` apply at the next session start or on `/reload-plugins`.

```bash
./install.sh --github               # install from GitHub instead; update with `claude plugin update ironclad@ironclad`
./install.sh --scope project        # from your project's directory: enable it in that project's .claude/settings.json
./install.sh --dry-run              # show what would happen
./uninstall.sh                      # remove the plugin and its marketplace (same as ./install.sh --uninstall)
```

Without a checkout, use the `claude` CLI directly:

```bash
claude plugin marketplace add jvalsesia/ironclad
claude plugin install ironclad@ironclad
```

Things to know:

- **The repo is private.** Installing from GitHub clones it with your own git credentials, which must work without a prompt: run `gh auth login` and `gh auth setup-git`, or have an SSH key loaded in `ssh-agent`.
- **Pre-plugin installs are cleaned up.** Earlier versions of the installer linked or copied each skill into `~/.claude/skills`, where it would load a second time without the prefix. Both scripts remove such leftovers: links into any clone of this repo (recognized by its root commit, so a checkout from before the `mba-skills` → `ironclad` rename counts), dangling links left by a deleted clone, and copies carrying the old install marker. Anything else with the same name is left alone, with a warning.
- **`--scope project` always uses GitHub.** A local path committed to a project's settings would exist only on your machine. Each collaborator still runs `claude plugin install ironclad@ironclad --scope project` once per clone.
- **GitHub installs don't auto-update.** Third-party marketplaces have auto-update off by default. Turn it on under `/plugin` → Marketplaces, or run `claude plugin update ironclad@ironclad`.

## Requirements

- [Claude Code](https://claude.com/claude-code).
- `git` in the target project. The implementation skills commit as they go.
- `gh`, authenticated, for the steps that open or read pull requests (`implement-and-evaluate`, and `fix-runner` when given a PR).
- `node` and `cargo` for the `clean-arch` gates.
- `tmux`, `watch`, `lsof` and the `claude` CLI on `PATH` for `implement-and-evaluate-tmux`.

The installer warns when a tool a skill needs is missing. It does not check for `watch` or `lsof`.

## Usage

Inside Claude Code, in the project being built:

```
/ironclad:prd-writer <product description, or a path to context files>
/ironclad:spec-writer F03
/ironclad:spec-writer wave 2
/ironclad:implement-feature F03
/ironclad:evaluator F03
/ironclad:evaluator F03 only failed-last-run
/ironclad:implement-and-evaluate F03 max 5 retries
/ironclad:implement-and-evaluate-tmux wave 3 except F04 max-parallel=2
```

Features can be named by ID (`F03`), by folder (`docs/F03-video-upload/`), by a file inside that folder, or by name. Most skills also accept plain-language overrides such as `skip UI`, `keep env` or `no retries`.

`clean-arch` is not usually invoked by hand. Claude loads it when a task touches backend code in a project that follows the architecture, or when the project's `CLAUDE.md` asks for it. Its gates run with `scripts/run-gates.mjs` from the skill's folder inside the installed plugin; from a shell:

```bash
CLEAN_ARCH="$(claude plugin list --json | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8")).find(p=>p.id.startsWith("ironclad@"));console.log((p.readFromFolder||p.installPath)+"/clean-arch")')"
node "$CLEAN_ARCH/scripts/run-gates.mjs"
```

It runs the 3 Rust gates: `cargo fmt --check`, `cargo clippy -D warnings`, and the architecture check.

Projects generated before the plugin reference `~/.claude/skills/clean-arch/` in their `CLAUDE.md` and README. That path no longer exists once the pre-plugin install is removed, so update those references the same way (see [`templates/project-claude-rust.md`](clean-arch/templates/project-claude-rust.md)).

## clean-arch

A prescriptive Clean Architecture and tactical DDD skill for Rust backends (axum + tokio, sqlx + PostgreSQL). It fixes one Cargo workspace layout, `domain` ← `usecase` ← `infra` ← `app`, with dependencies pointing inward only, and codifies 19 rules plus canonical shapes for entities, value objects, use cases, ports, repositories, handlers and errors.

| Path | Contents |
|---|---|
| [`SKILL.md`](clean-arch/SKILL.md) | The dependency rule, the 19 rules, canonical shapes and the self-audit gates. |
| [`references/architecture/`](clean-arch/references/architecture/) | Depth on workspace layout, domain modeling, use cases and ports, infra with axum + sqlx, messaging (Kafka, RabbitMQ, NATS, SQS; opt-in), and anti-patterns. |
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
.claude-plugin/
  plugin.json     the plugin manifest; skills are discovered at the repo root
  marketplace.json  the single-plugin marketplace that installs it
<skill>/
  SKILL.md        the skill itself
  references/     templates and depth docs, loaded on demand
  scripts/        executables the skill runs
clean-arch/
  templates/      the Rust starter project and the CLAUDE.md template for projects using the skill
install.sh        installs the plugin with the claude CLI
uninstall.sh      shorthand for install.sh --uninstall
```

## Development

The `clean-arch` architecture checker has tests, run from the repo root with Node's built-in test runner:

```bash
npm --prefix clean-arch run test:rust-arch    # Rust architecture checker
```

With the default install, the plugin loads in place from this checkout, so edits take effect at the next session start or on `/reload-plugins`. To try a change without installing, run `claude --plugin-dir .` from the repo root. `claude plugin validate .` checks the manifests.
