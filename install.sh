#!/usr/bin/env bash
# install.sh — installs the ironclad collection into a Claude Code skills directory.
#
#   ./install.sh                        every skill, symlinked into ~/.claude/skills
#   ./install.sh clean-arch evaluator   just these, plus the skills they invoke
#   ./install.sh --project              copied into ./.claude/skills of the current project
#   ./install.sh --uninstall            remove what this installer put there
#
# Run outside a checkout (piped from curl, say) it clones the repo first and
# installs from that clone. `--help` lists every option.
#
# Ownership: a symlink that points back into this checkout, or a copy carrying
# the marker file, counts as installed from here. Anything else under the same
# name is left alone unless --force is given.

set -euo pipefail

REPO_URL="${IRONCLAD_REPO:-https://github.com/jvalsesia/ironclad.git}"
CLONE_DIR="${IRONCLAD_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/ironclad}"
MARKER=".ironclad-install"

usage() {
    cat <<EOF
Usage: install.sh [options] [skill...]

With no skill names, every skill in the repo is installed. Naming skills
installs just those, plus the skills they invoke at runtime.

Options:
  --link           symlink each skill to this checkout, so \`git pull\` updates it
                   (default for ~/.claude/skills)
  --copy           copy each skill instead; re-run to refresh the copies
                   (default with --project)
  --project[=DIR]  install into DIR/.claude/skills instead of ~/.claude/skills;
                   DIR defaults to the current directory
  --dest DIR       install into an arbitrary skills directory
  --uninstall      remove skills this installer put there
  --force          replace (with --uninstall: remove) skills it did not install
  --dry-run        show what would happen, change nothing
  --list           list the available skills and exit
  -h, --help       show this help

Environment:
  IRONCLAD_REPO    repo to clone when run outside a checkout
                   (default: $REPO_URL)
  IRONCLAD_HOME    where that clone lives
                   (default: $CLONE_DIR)
EOF
}

die() { echo "[install] FATAL: $*" >&2; exit 1; }
warn() { echo "[install] WARN: $*" >&2; }
say() { echo "[install] $*"; }
report() { printf '  %-10s %s\n' "$1" "$2"; }

has_word() { case " $1 " in *" $2 "*) return 0 ;; esac; return 1; }
has_skills() { ls "$1"/*/SKILL.md >/dev/null 2>&1; }

# Skills a skill invokes at runtime; installing it without them leaves it broken.
deps_of() {
    case "$1" in
        implement-and-evaluate)      echo "implement-feature evaluator fix-runner" ;;
        implement-and-evaluate-tmux) echo "implement-and-evaluate" ;;
    esac
}

# Commands a skill shells out to.
tools_of() {
    case "$1" in
        clean-arch)                  echo "node cargo" ;;
        implement-and-evaluate)      echo "git gh" ;;
        implement-and-evaluate-tmux) echo "tmux git claude" ;;
    esac
}

# --- arguments ---
mode=""
dest=""
project=0
project_dir=""
action="install"
force=0
dry_run=0
requested=""

while [ $# -gt 0 ]; do
    case "$1" in
        --link)      mode="link" ;;
        --copy)      mode="copy" ;;
        --project)   project=1; project_dir="$PWD" ;;
        --project=*) project=1; project_dir="${1#--project=}" ;;
        --dest)      dest="${2:?--dest needs a directory}"; shift ;;
        --dest=*)    dest="${1#--dest=}" ;;
        --uninstall) action="uninstall" ;;
        --list)      action="list" ;;
        --force)     force=1 ;;
        --dry-run)   dry_run=1 ;;
        -h|--help)   usage; exit 0 ;;
        -*)          die "unknown option: $1 (see --help)" ;;
        *)           requested="$requested $1" ;;
    esac
    shift
done

run() { if [ "$dry_run" != 1 ]; then "$@"; fi; }

# --- locate the skills: next to this script, else a clone we manage ---
src=""
script_path="${BASH_SOURCE[0]:-}"
if [ -n "$script_path" ] && [ -f "$script_path" ]; then
    src="$(cd "$(dirname "$script_path")" && pwd -P)"
fi

if [ -z "$src" ] || ! has_skills "$src"; then
    src="$CLONE_DIR"
    if [ "$action" = "install" ]; then
        command -v git >/dev/null 2>&1 || die "git is needed to fetch $REPO_URL"
        if [ -d "$src/.git" ]; then
            say "updating $src"
            run git -C "$src" pull --ff-only --quiet
        else
            say "cloning $REPO_URL into $src"
            run git clone --quiet --depth 1 "$REPO_URL" "$src"
        fi
    fi
    if ! has_skills "$src"; then
        if [ "$dry_run" = 1 ]; then say "dry run: nothing cloned, so nothing further to show"; exit 0; fi
        die "no skills found at $src"
    fi
    src="$(cd "$src" && pwd -P)"
fi

available=""
for skill_md in "$src"/*/SKILL.md; do
    available="$available $(basename "$(dirname "$skill_md")")"
done

if [ "$action" = "list" ]; then
    for name in $available; do
        needs="$(deps_of "$name")"
        if [ -n "$needs" ]; then echo "$name (needs: $needs)"; else echo "$name"; fi
    done
    exit 0
fi

# --- which skills ---
selected=""
add_skill() {
    local name="$1" needed_by="${2:-}" dep
    has_word "$available" "$name" || die "unknown skill: $name (available:$available)"
    if has_word "$selected" "$name"; then return 0; fi
    selected="$selected $name"
    if [ -n "$needed_by" ]; then say "adding $name (needed by $needed_by)"; fi
    # Uninstall removes exactly what was named: a dependency may serve other skills.
    if [ "$action" != "install" ]; then return 0; fi
    for dep in $(deps_of "$name"); do add_skill "$dep" "$name"; done
}

if [ -z "$requested" ]; then
    selected="$available"
else
    for name in $requested; do add_skill "$name"; done
fi

# --- where to ---
if [ "$project" = 1 ]; then
    if [ -n "$dest" ]; then die "--project and --dest cannot be combined"; fi
    [ -d "$project_dir" ] || die "project directory not found: $project_dir"
    project_dir="$(cd "$project_dir" && pwd -P)"
    if [ "$project_dir" = "$src" ]; then
        die "that is the skills repo itself; run this from your project or pass --project=DIR"
    fi
    dest="$project_dir/.claude/skills"
    # A symlink into this checkout is an absolute path: committed to the project,
    # it would dangle on every other machine.
    : "${mode:=copy}"
fi
: "${dest:=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills}"
: "${mode:=link}"

# Root commit of this checkout. Another clone with the same root is the same
# project under a different path or name (e.g. before the mba-skills rename).
src_root="$(git -C "$src" rev-list --max-parents=0 HEAD 2>/dev/null | sort | head -n 1 || true)"

same_project() {
    [ -n "$src_root" ] && [ -f "$1/install.sh" ] || return 1
    [ "$(git -C "$1" rev-list --max-parents=0 HEAD 2>/dev/null | sort | head -n 1)" = "$src_root" ]
}

# What sits at $dest/<skill>: none | ours-link | stale-link | ours-copy | foreign
#   stale-link: a link into another checkout of this repo, or a dangling link
#   whose target is named after the skill (an install whose checkout is gone)
state_of() {
    local target="$dest/$1" resolved
    if [ -L "$target" ]; then
        if [ ! -e "$target" ]; then
            case "$(readlink "$target")" in */"$1"|*/"$1"/) echo stale-link ;; *) echo foreign ;; esac
            return 0
        fi
        resolved="$(cd "$target" 2>/dev/null && pwd -P)"
        if [ "$resolved" = "$src/$1" ]; then
            echo ours-link
        elif [ "$(basename "$resolved")" = "$1" ] && same_project "$(dirname "$resolved")"; then
            echo stale-link
        else
            echo foreign
        fi
    elif [ -e "$target" ]; then
        if [ -f "$target/$MARKER" ]; then echo ours-copy; else echo foreign; fi
    else
        echo none
    fi
}

remove_target() {
    if [ -L "$1" ]; then run rm -f "$1"; else run rm -rf "$1"; fi
}

conflicts=0

install_skill() {
    local name="$1" target="$dest/$1" state verb
    state="$(state_of "$name")"
    case "$state" in
        foreign)
            if [ "$force" != 1 ]; then
                report skipped "$name: $target exists and was not installed from here (--force replaces it)"
                conflicts=$((conflicts + 1))
                return 0
            fi ;;
        ours-link)
            if [ "$mode" = "link" ]; then report current "$name"; return 0; fi ;;
        ours-copy)
            if [ "$mode" = "copy" ] && diff -rq -x "$MARKER" "$src/$name" "$target" >/dev/null 2>&1; then
                report current "$name"
                return 0
            fi ;;
    esac

    if [ "$state" = "stale-link" ]; then
        say "$name: replacing link to $(readlink "$target") (another or missing checkout)"
    fi
    if [ "$state" = "none" ]; then verb="installed"; else verb="replaced"; fi
    [ "$state" = "none" ] || remove_target "$target"
    if [ "$mode" = "link" ]; then
        run ln -s "$src/$name" "$target"
        report "$verb" "$name -> $src/$name"
    else
        run cp -R "$src/$name" "$target"
        if [ "$dry_run" != 1 ]; then
            {
                echo "source=$src"
                echo "commit=$(git -C "$src" rev-parse --short HEAD 2>/dev/null || echo unknown)"
            } > "$target/$MARKER"
        fi
        report "$verb" "$name (copy)"
    fi
}

uninstall_skill() {
    local name="$1" target="$dest/$1" state
    state="$(state_of "$name")"
    case "$state" in
        none)
            report absent "$name"
            return 0 ;;
        foreign)
            if [ "$force" != 1 ]; then
                report skipped "$name: $target was not installed from here (--force removes it)"
                conflicts=$((conflicts + 1))
                return 0
            fi ;;
    esac
    local note=""
    if [ "$state" = "stale-link" ]; then note=" (was a link to $(readlink "$target"))"; fi
    remove_target "$target"
    report removed "$name$note"
}

# --- go ---
if [ "$dry_run" = 1 ]; then say "dry run: nothing below is actually changed"; fi

if [ "$action" = "uninstall" ]; then
    say "removing from $dest"
    for name in $selected; do uninstall_skill "$name"; done
else
    say "installing into $dest ($mode)"
    run mkdir -p "$dest"
    for name in $selected; do install_skill "$name"; done

    for name in $selected; do
        for tool in $(tools_of "$name"); do
            command -v "$tool" >/dev/null 2>&1 || warn "$name needs \`$tool\`, which is not on PATH"
        done
    done
    if has_word "$selected" "clean-arch" && [ "$dest" != "$HOME/.claude/skills" ]; then
        warn "clean-arch's templates and docs point at ~/.claude/skills/clean-arch; those commands only resolve if it is installed there too"
    fi
fi

if [ "$conflicts" != 0 ]; then
    say "$conflicts skill(s) skipped, see above"
    exit 1
fi
if [ "$action" = "install" ]; then say "done; start a new Claude Code session to pick the skills up"; fi
