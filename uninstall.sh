#!/usr/bin/env bash
# uninstall.sh — removes the ironclad plugin from Claude Code.
#
#   ./uninstall.sh                     from your user scope
#   ./uninstall.sh --scope project     from the project in the current directory
#   ./uninstall.sh --keep-marketplace  keep the marketplace registered
#   ./uninstall.sh --dry-run           show what would be removed
#
# Shorthand for `install.sh --uninstall`; takes the same options. It also removes
# skills the pre-plugin installer linked or copied into a skills directory (links
# into a clone of this repo, dangling links left by a deleted clone, copies with
# the install marker). Anything else under the same name is left alone.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
[ -f "$here/install.sh" ] || { echo "[uninstall] FATAL: install.sh not found next to $0" >&2; exit 1; }

exec bash "$here/install.sh" --uninstall "$@"
