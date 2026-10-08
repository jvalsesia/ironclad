#!/usr/bin/env bash
# spawn-team.sh — creates one team's tmux window (three panes) in the wave session.
# Used for the initial batch (Step 5) and for queue respawns (wave-tick.sh), so
# every team gets the same layout.
#
# Layout:
#   left          team-driver.sh    (claude TUI)
#   top right     services-tail.sh
#   bottom right  ports-tail.sh
#
# Inputs (positional):
#   $1  wave_dir      e.g. .claude/worktrees/.wave-2026-05-02T18-02-13Z
#   $2  feature_id    e.g. F03
#   $3  feature_slug  e.g. video-upload
#
# Reads run_id, wave_tag and tail from $wave_dir/wave.meta.
#
# Writes the team's initial status file BEFORE creating the window, so a tick
# that runs right after the spawn already counts the team as running. If the
# window cannot be created, the status file is flipped to status=aborted.

set -uo pipefail

wave_dir="${1:?usage: spawn-team.sh <wave_dir> <feature_id> <feature_slug>}"
feature_id="${2:?missing feature_id}"
feature_slug="${3:?missing feature_slug}"

wave_abs="$(cd "$wave_dir" 2>/dev/null && pwd)" || { echo "[spawn-team] FATAL: wave dir not found: $wave_dir" >&2; exit 1; }
meta_file="$wave_abs/wave.meta"
[ -f "$meta_file" ] || { echo "[spawn-team] FATAL: no wave.meta at $meta_file" >&2; exit 1; }

get_meta() { awk -F= -v k="$1" '$1==k { sub(/^[^=]+=/, ""); print; exit }' "$meta_file"; }

session="iaet-$(get_meta wave_tag)-$(get_meta run_id)"
tail_override="$(get_meta tail)"
# wave_dir is .claude/worktrees/.wave-<run-id>/ — three levels below project root.
project_root="$(cd "$wave_abs/../../.." && pwd)"
worktree_abs="$project_root/.claude/worktrees/${feature_id}-${feature_slug}"
window="${feature_id}-${feature_slug}"
status_file="$wave_abs/status/$feature_id.status"

now_iso() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

write_status() {
    local tmp="${status_file}.tmp.$$"
    printf '%s\n' "$@" > "$tmp"
    mv -f "$tmp" "$status_file"
}

mkdir -p "$wave_abs/status"

started_at="$(now_iso)"
write_status \
    "feature_id=$feature_id" \
    "feature_slug=$feature_slug" \
    "worktree=$worktree_abs" \
    "started_at=$started_at" \
    "last_updated=$started_at" \
    "phase=spawning" \
    "status=running"

# tmux runs each command string through a shell — quote every argument so paths
# and a tail with spaces survive.
driver_cmd=$(printf '%q ' "$wave_abs/team-driver.sh" "$feature_id" "$feature_slug" "$wave_abs" "$tail_override")
services_cmd=$(printf '%q ' "$wave_abs/services-tail.sh" "$worktree_abs")
ports_cmd=$(printf '%q ' "$wave_abs/ports-tail.sh" "$worktree_abs")
log_cmd="cat >> $(printf '%q' "$wave_abs/status/$feature_id.log")"

# Panes are targeted by id (%N), never by index: indexes shift with the user's
# base-index / pane-base-index settings.

# 1) Team window with claude as the sole pane. Do NOT pipe the driver through
#    `| tee` — claude detects "not a terminal" and produces no output.
claude_pane=$(tmux new-window -P -F '#{pane_id}' -t "${session}:" -n "$window" "$driver_cmd")
if [ -z "$claude_pane" ]; then
    finished_at="$(now_iso)"
    write_status \
        "feature_id=$feature_id" \
        "feature_slug=$feature_slug" \
        "worktree=$worktree_abs" \
        "started_at=$started_at" \
        "last_updated=$finished_at" \
        "finished_at=$finished_at" \
        "phase=done" \
        "status=aborted" \
        "abort_reason=spawn-failed"
    echo "[spawn-team] FATAL: could not create window $window in session $session" >&2
    exit 1
fi

# 2) Vertical divider — right column = services-tail, 50% of the window width.
#    (`-l 50%`, not `-p 50`: tmux 3.4 rejects `-p` with "size missing" in a
#    detached session.)
services_pane=$(tmux split-window -h -l 50% -P -F '#{pane_id}' -t "$claude_pane" "$services_cmd")

# 3) Horizontal divider INSIDE the right column — bottom = ports-tail, 14 rows
#    (room for header + ~7 listening ports with full command lines).
if [ -n "$services_pane" ]; then
    tmux split-window -v -l 14 -t "$services_pane" "$ports_cmd" \
        || echo "[spawn-team] WARN: ports pane not created for $window" >&2
else
    echo "[spawn-team] WARN: services/ports panes not created for $window" >&2
fi

# 4) Capture ONLY the claude pane for the .log debug artifact. pipe-pane does
#    not interfere with the TTY of the running process.
tmux pipe-pane -t "$claude_pane" -o "$log_cmd" \
    || echo "[spawn-team] WARN: pipe-pane failed for $window" >&2

echo "[spawn-team] $feature_id spawned in ${session}:${window}"
