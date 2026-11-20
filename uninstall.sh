#!/usr/bin/env bash
# uninstall.sh — removes ironclad skills from a Claude Code skills directory.
#
#   ./uninstall.sh                        every ironclad skill from ~/.claude/skills
#   ./uninstall.sh clean-arch evaluator   just these (dependencies are kept)
#   ./uninstall.sh --project              from ./.claude/skills of the current project
#   ./uninstall.sh --dry-run              show what would be removed
#
# Shorthand for `install.sh --uninstall`; takes the same options (--dest, --project,
# --force, --dry-run). Only skills installed from a checkout of this repo are
# removed: links into this or another clone of it (e.g. an old mba-skills
# checkout), dangling links left by a deleted clone, and copies carrying the
# install marker. Anything else under the same name needs --force.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
[ -f "$here/install.sh" ] || { echo "[uninstall] FATAL: install.sh not found next to $0" >&2; exit 1; }

exec bash "$here/install.sh" --uninstall "$@"
