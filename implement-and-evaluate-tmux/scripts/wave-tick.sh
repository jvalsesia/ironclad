#!/usr/bin/env bash
# wave-tick.sh — one polling tick of the wave (Step 6). Short-lived: run it on
# every Monitor / ScheduleWakeup wake-up until it prints ALL_DONE.
#
# Per tick:
#   1. Timeout — a team still `running` past team_timeout gets its tmux window
#      killed and its status file rewritten to status=timeout.
#   2. Respawn — while fewer than max_parallel teams are running, pops the next
#      F<ID>:<slug> line from queue.txt and spawns it via spawn-team.sh.
#   3. Report — prints `TIMEOUT F<ID>` per team timed out this tick, a one-line
#      summary, and ALL_DONE once the queue is empty and every selected feature
#      has a terminal status file.
#
# Inputs (positional):
#   $1  wave_dir  e.g. .claude/worktrees/.wave-2026-05-02T18-02-13Z
#
# Reads run_id, wave_tag, max_parallel, team_timeout and selected_features from
# $wave_dir/wave.meta.

set -uo pipefail
shopt -s nullglob

wave_dir="${1:?usage: wave-tick.sh <wave_dir>}"
wave_abs="$(cd "$wave_dir" 2>/dev/null && pwd)" || { echo "[wave-tick] FATAL: wave dir not found: $wave_dir" >&2; exit 1; }
meta_file="$wave_abs/wave.meta"
status_dir="$wave_abs/status"
queue_file="$wave_abs/queue.txt"

[ -f "$meta_file" ] || { echo "[wave-tick] FATAL: no wave.meta at $meta_file" >&2; exit 1; }

get_meta()  { awk -F= -v k="$1" '$1==k { sub(/^[^=]+=/, ""); print; exit }' "$meta_file"; }
get_field() { awk -F= -v k="$2" '$1==k { sub(/^[^=]+=/, ""); print; exit }' "$1"; }

now_iso() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# ISO-8601 UTC timestamp → epoch seconds. BSD date (macOS) first; GNU date
# (Linux) rejects `-j` and falls through to `-d`.
iso_to_epoch() {
    date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$1" +%s 2>/dev/null || date -u -d "$1" +%s 2>/dev/null
}

session="iaet-$(get_meta wave_tag)-$(get_meta run_id)"

max_parallel=$(get_meta max_parallel)
case "$max_parallel" in ''|*[!0-9]*|0) max_parallel=3 ;; esac

# team_timeout is "<N>m".
timeout_min=$(get_meta team_timeout)
timeout_min="${timeout_min%m}"
case "$timeout_min" in ''|*[!0-9]*) timeout_min=90 ;; esac
timeout_s=$(( timeout_min * 60 ))

IFS=',' read -r -a pairs <<< "$(get_meta selected_features | tr -d ' ')"
total=${#pairs[@]}

# Preserve every field, flip the terminal ones. Atomic (write-to-tmp + rename).
mark_timeout() {
    local sf="$1" fid="$2" slug="$3" now tmp worktree journal
    now="$(now_iso)"
    tmp="${sf}.tmp.$$"
    journal="$(get_field "$sf" journal)"
    if [ -z "$journal" ]; then
        worktree="$(get_field "$sf" worktree)"
        journal="$(ls -1t "$worktree/docs/${fid}-${slug}"/orchestration-*.md 2>/dev/null | head -n1)"
    fi
    {
        grep -vE '^(status|phase|finished_at|last_updated|abort_reason|journal)=' "$sf"
        printf '%s\n' \
            "last_updated=$now" \
            "finished_at=$now" \
            "phase=done" \
            "status=timeout" \
            "abort_reason=wall-clock-timeout-${timeout_min}m"
        [ -n "$journal" ] && printf 'journal=%s\n' "$journal"
    } > "$tmp"
    mv -f "$tmp" "$sf"
}

# --- 1. Enforce timeout on running teams ---
now_s=$(date -u +%s)
running=0
for sf in "$status_dir"/*.status; do
    [ "$(get_field "$sf" status)" = "running" ] || continue
    started="$(get_field "$sf" started_at)"
    s0=$(iso_to_epoch "$started" || echo "$now_s")
    if [ $(( now_s - s0 )) -gt "$timeout_s" ]; then
        fid="$(basename "$sf" .status)"
        slug="$(get_field "$sf" feature_slug)"
        tmux kill-window -t "${session}:${fid}-${slug}" 2>/dev/null || true
        mark_timeout "$sf" "$fid" "$slug"
        echo "TIMEOUT $fid"
    else
        running=$(( running + 1 ))
    fi
done

# --- 2. Respawn from queue while capacity is available ---
while [ "$running" -lt "$max_parallel" ] && [ -s "$queue_file" ]; do
    line="$(head -n1 "$queue_file" | tr -d ' ')"
    sed -i.bak '1d' "$queue_file" && rm -f "$queue_file.bak"
    [ -n "$line" ] || continue
    fid="${line%%:*}"; slug="${line#*:}"
    # A failed spawn leaves status=aborted behind, so it frees the slot.
    if "$wave_abs/spawn-team.sh" "$wave_abs" "$fid" "$slug"; then
        running=$(( running + 1 ))
    fi
done

# --- 3. Summary and done condition ---
status_files=( "$status_dir"/*.status )
spawned=${#status_files[@]}
queued=0
[ -s "$queue_file" ] && queued=$(grep -c . "$queue_file")
done_count=$(( spawned - running ))

printf 'running=%s queued=%s done=%s total=%s\n' "$running" "$queued" "$done_count" "$total"

if [ "$queued" -eq 0 ] && [ "$running" -eq 0 ] && [ "$spawned" -ge "$total" ]; then
    echo "ALL_DONE"  # Main reads this and proceeds to Step 7.
fi
