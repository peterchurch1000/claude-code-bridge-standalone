#!/bin/bash
# ── Bridge session reaper ─────────────────────────────────────────────────────
# Prevents the two runaway patterns that jam the container:
#   A) DUPLICATES — the bridge's turn/blip-recovery can spawn a new
#      `claude --resume <session-id>` without reaping the previous one, so
#      orphaned copies of the SAME session pile up and spin. A session should
#      only ever have ONE live proc, so we keep the newest and kill older dupes.
#   B) STUCK LOOPS — a proc pegged on CPU for a long time with no session id to
#      dedupe on (e.g. an abandoned first-turn). Caught by lifetime CPU ratio.
#
# SAFE BY DESIGN:
#   * only ever touches procs whose comm is exactly `claude` owned by a bridge-* user
#   * never kills the NEWEST proc of any session id (protects the live/active turn,
#     including the very conversation that may be running this)
#   * never kills a proc younger than MIN_AGE
#   * stuck-rule needs BOTH long age AND high lifetime CPU ratio; a healthy idle
#     session sits at ~1-5% ratio, the observed runaways were 50-67%
#   * logs every kill with its reason to reaper.log
# Runs as root (launched from start.sh) so it can reap any pane's procs.
# Remove it by deleting the launch block in start.sh; kill this loop to stop now.

LOG="${REAPER_LOG:-/var/www/html/claude-code-bridge-standalone/logs/reaper.log}"
INTERVAL="${REAPER_INTERVAL:-180}"   # seconds between sweeps
MIN_AGE="${REAPER_MIN_AGE:-90}"      # never touch procs younger than this
STUCK_AGE="${REAPER_STUCK_AGE:-1800}"  # stuck-rule only past this age
STUCK_RATIO="${REAPER_STUCK_RATIO:-40}" # % of one core, averaged over lifetime

log(){ echo "$(date '+%F %T') $*" >> "$LOG" 2>/dev/null; }

do_kill(){ # pid
  kill "$1" 2>/dev/null
  for _ in 1 2; do sleep 1; kill -0 "$1" 2>/dev/null || return 0; done
  kill -9 "$1" 2>/dev/null
}

reap_once(){
  local rows pid user age ct rid ratio grp keeper cnt
  rows="$(for pid in $(pgrep -x claude); do
    user=$(ps -o user= -p "$pid" 2>/dev/null | tr -d ' '); case "$user" in bridge-*) ;; *) continue;; esac
    age=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' '); [ -z "$age" ] && continue
    ct=$(ps -o cputimes= -p "$pid" 2>/dev/null | tr -d ' '); [ -z "$ct" ] && ct=0
    rid=$(tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | awk 'p{print;exit} /^--resume$/{p=1}'); [ -z "$rid" ] && rid=NONE
    echo "$pid $user $rid $age $ct"
  done)"
  [ -z "$rows" ] && return

  # keeper (youngest = newest) per session id, incl the NONE bucket
  for rid in $(echo "$rows" | awk '{print $3}' | sort -u); do
    grp="$(echo "$rows" | awk -v r="$rid" '$3==r{print $1,$4,$5}')"
    keeper=$(echo "$grp" | sort -k2 -n | head -1 | awk '{print $1}')
    cnt=$(echo "$grp" | grep -c .)

    # Rule A: duplicate real session ids -> keep newest, kill the older ones
    if [ "$rid" != "NONE" ] && [ "$cnt" -gt 1 ]; then
      while read -r pid age ct; do
        [ "$pid" = "$keeper" ] && continue
        [ "$age" -lt "$MIN_AGE" ] && continue
        log "KILL dup pid=$pid session=$rid age=${age}s cpu=${ct}s (keeping newest $keeper)"
        do_kill "$pid"
      done <<< "$grp"
    fi

    # Rule B: stuck loop -> old AND high lifetime CPU ratio, never the keeper
    while read -r pid age ct; do
      [ "$pid" = "$keeper" ] && continue
      kill -0 "$pid" 2>/dev/null || continue   # may already be gone via Rule A
      [ "$age" -lt "$STUCK_AGE" ] && continue
      ratio=$(( age > 0 ? 100 * ct / age : 0 ))
      if [ "$ratio" -ge "$STUCK_RATIO" ]; then
        log "KILL stuck pid=$pid session=$rid age=${age}s cpu=${ct}s ratio=${ratio}%"
        do_kill "$pid"
      fi
    done <<< "$grp"
  done
}

log "reaper started pid=$$ interval=${INTERVAL}s stuck_age=${STUCK_AGE}s stuck_ratio=${STUCK_RATIO}% min_age=${MIN_AGE}s"
while true; do
  reap_once 2>>"$LOG"
  sleep "$INTERVAL"
done
