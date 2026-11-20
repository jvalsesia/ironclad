#!/usr/bin/env bash
# install.sh — installs ironclad as a Claude Code plugin; its skills become
# /ironclad:<skill> (e.g. /ironclad:prd-writer).
#
#   ./install.sh                   for you, loaded in place from this checkout
#                                  (edits and `git pull` apply next session)
#   ./install.sh --github          for you, from GitHub (update with `claude plugin update`)
#   ./install.sh --scope project   for the project in the current directory, via
#                                  its .claude/settings.json (always from GitHub)
#   ./install.sh --uninstall       remove it again (same as ./uninstall.sh)
#
# Either way it first removes skills that the pre-plugin installer linked or
# copied into a skills directory: left there, every skill would load twice.
# Without a checkout, install with:
#   claude plugin marketplace add jvalsesia/ironclad && claude plugin install ironclad@ironclad

set -euo pipefail

PLUGIN="ironclad"
MARKETPLACE="ironclad"
GITHUB_REPO="${IRONCLAD_REPO:-jvalsesia/ironclad}"
MARKER=".ironclad-install"   # left in copies by the pre-plugin installer

usage() {
    cat <<EOF
Usage: install.sh [options]

Installs the ironclad plugin (all its skills) with the \`claude\` CLI.

Options:
  --scope SCOPE        user (default), project or local. project and local apply to
                       the project in the current directory; project is written to
                       its committed .claude/settings.json and always uses GitHub
  --github             install from GitHub ($GITHUB_REPO) instead of this checkout
  --uninstall          remove the plugin and any pre-plugin skill installs
  --keep-marketplace   with --uninstall: keep the marketplace registered
  --dry-run            show what would happen, change nothing
  -h, --help           show this help

Environment:
  IRONCLAD_REPO        GitHub repo used by --github and --scope project
                       (default: $GITHUB_REPO)
EOF
}

die() { echo "[install] FATAL: $*" >&2; exit 1; }
warn() { echo "[install] WARN: $*" >&2; }
say() { echo "[install] $*"; }
report() { printf '  %-10s %s\n' "$1" "$2"; }

# Commands a skill shells out to.
tools_of() {
    case "$1" in
        clean-arch)                  echo "node cargo" ;;
        implement-and-evaluate)      echo "git gh" ;;
        implement-and-evaluate-tmux) echo "tmux git" ;;
    esac
}

# --- arguments ---
scope="user"
github=0
action="install"
keep_marketplace=0
dry_run=0

while [ $# -gt 0 ]; do
    case "$1" in
        --scope)            scope="${2:?--scope needs user, project or local}"; shift ;;
        --scope=*)          scope="${1#--scope=}" ;;
        --github)           github=1 ;;
        --uninstall)        action="uninstall" ;;
        --keep-marketplace) keep_marketplace=1 ;;
        --dry-run)          dry_run=1 ;;
        -h|--help)          usage; exit 0 ;;
        -*)                 die "unknown option: $1 (see --help)" ;;
        *)                  die "the plugin installs every skill together; naming skills ($1) is no longer supported" ;;
    esac
    shift
done

case "$scope" in user|project|local) ;; *) die "--scope must be user, project or local, not '$scope'" ;; esac

run() {
    if [ "$dry_run" = 1 ]; then echo "  would run: $*"; else "$@"; fi
}

# --- this checkout ---
src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
[ -f "$src/.claude-plugin/marketplace.json" ] || die "no plugin found next to this script; without a checkout run: claude plugin marketplace add $GITHUB_REPO && claude plugin install $PLUGIN@$MARKETPLACE"
command -v claude >/dev/null 2>&1 || die "the \`claude\` CLI is not on PATH"

skills=""
for skill_md in "$src"/*/SKILL.md; do
    skills="$skills $(basename "$(dirname "$skill_md")")"
done

if [ "$scope" = "user" ]; then
    skills_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
else
    [ "$(pwd -P)" != "$src" ] || die "that is the ironclad repo itself; run --scope $scope from your project's directory"
    skills_dir="$(pwd -P)/.claude/skills"
fi
# A local path exists only on this machine, so a committed project setting must name GitHub.
if [ "$scope" = "project" ]; then github=1; fi

# --- pre-plugin installs ---
# Root commit of this checkout: another clone sharing it is the same project
# under another path or name (e.g. a checkout from before the mba-skills rename).
src_root="$(git -C "$src" rev-list --max-parents=0 HEAD 2>/dev/null | sort | head -n 1 || true)"

same_project() {
    [ -n "$src_root" ] && [ -f "$1/install.sh" ] || return 1
    [ "$(git -C "$1" rev-list --max-parents=0 HEAD 2>/dev/null | sort | head -n 1)" = "$src_root" ]
}

# What sits at $skills_dir/<skill>: none | legacy | foreign
#   legacy: a link into a clone of this repo, a dangling link named after the
#   skill (its clone is gone), or a copy carrying the old installer's marker.
legacy_state() {
    local target="$skills_dir/$1" resolved
    if [ -L "$target" ]; then
        if [ ! -e "$target" ]; then
            case "$(readlink "$target")" in */"$1"|*/"$1"/) echo legacy ;; *) echo foreign ;; esac
            return 0
        fi
        resolved="$(cd "$target" 2>/dev/null && pwd -P)"
        if [ "$(basename "$resolved")" = "$1" ] && same_project "$(dirname "$resolved")"; then
            echo legacy
        else
            echo foreign
        fi
    elif [ -e "$target" ]; then
        if [ -f "$target/$MARKER" ]; then echo legacy; else echo foreign; fi
    else
        echo none
    fi
}

remove_legacy() {
    local name target what
    [ -d "$skills_dir" ] || return 0
    for name in $skills; do
        target="$skills_dir/$name"
        case "$(legacy_state "$name")" in
            legacy)
                if [ -L "$target" ]; then
                    what="link to $(readlink "$target")"
                    run rm -f "$target"
                else
                    what="copy"
                    run rm -rf "$target"
                fi
                report removed "$target (pre-plugin $what)" ;;
            foreign)
                warn "$target is not from ironclad and was left alone; /$name may now be ambiguous, so use /$PLUGIN:$name" ;;
        esac
    done
}

# "<source> <path-or-repo>" of the registered marketplace, empty if none.
marketplace_now() {
    claude plugin marketplace list --json 2>/dev/null | node -e '
        let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
            let list = []; try { list = JSON.parse(s); } catch {}
            const m = list.find(m => m.name === process.argv[1]);
            if (m) console.log(`${m.source} ${m.path || m.repo || m.url || ""}`);
        });' "$MARKETPLACE" 2>/dev/null || true
}

installed_in_scope() {
    claude plugin list --json 2>/dev/null | node -e '
        let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
            let list = []; try { list = JSON.parse(s); } catch {}
            process.exit(list.some(p => p.id === process.argv[1] && p.scope === process.argv[2]) ? 0 : 1);
        });' "$PLUGIN@$MARKETPLACE" "$scope" 2>/dev/null
}

# --- go ---
if [ "$dry_run" = 1 ]; then say "dry run: nothing below is actually changed"; fi
say "pre-plugin skills in $skills_dir"
remove_legacy

if [ "$action" = "uninstall" ]; then
    if installed_in_scope; then
        run claude plugin uninstall "$PLUGIN@$MARKETPLACE" --scope "$scope"
    else
        report absent "$PLUGIN@$MARKETPLACE ($scope scope)"
    fi
    if [ "$keep_marketplace" != 1 ] && [ -n "$(marketplace_now)" ]; then
        run claude plugin marketplace remove "$MARKETPLACE" --scope "$scope"
    fi
    say "done; restart Claude Code (or /reload-plugins) to drop the skills"
    exit 0
fi

if [ "$github" = 1 ]; then mkt_source="$GITHUB_REPO"; else mkt_source="$src"; fi
current="$(marketplace_now)"
if [ -n "$current" ]; then
    # Switching between this checkout and GitHub means re-registering.
    if { [ "$github" = 1 ] && [ "${current%% *}" = "directory" ]; } ||
       { [ "$github" != 1 ] && [ "$current" != "directory $src" ]; }; then
        say "marketplace $MARKETPLACE currently points at: $current; re-registering"
        run claude plugin marketplace remove "$MARKETPLACE"
    fi
fi

say "installing $PLUGIN@$MARKETPLACE ($scope scope) from $mkt_source"
if ! run claude plugin marketplace add "$mkt_source" --scope "$scope"; then
    if [ "$github" = 1 ]; then
        die "could not add $GITHUB_REPO; the repo is private, so git needs credentials that work without a prompt (e.g. gh auth login && gh auth setup-git)"
    fi
    die "could not add the marketplace at $mkt_source"
fi
run claude plugin install "$PLUGIN@$MARKETPLACE" --scope "$scope"

for name in $skills; do
    for tool in $(tools_of "$name"); do
        command -v "$tool" >/dev/null 2>&1 || warn "$name needs \`$tool\`, which is not on PATH"
    done
done
say "done; start a new Claude Code session (or run /reload-plugins) and use /$PLUGIN:<skill>"
