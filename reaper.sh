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
# TASK-638 FIX (the "stuck draft-room" blind spot):
#   Previously every proc WITHOUT `--resume` (draft / first-turn / room spawns)
#   was lumped into one synthetic `NONE` bucket, and the stuck-rule never kills
#   the NEWEST (keeper) of any bucket. So a wedged draft room that was the sole
#   or newest `NONE` proc was PERMANENTLY exempt and could spin for hours
#   (e.g. PID 1058783: ~91% CPU for 11h, unreaped). Two changes close it:
#     1. Per-ROOM identity: a no-`--resume` proc is bucketed by its
#        `--mcp-config` room id (`room:<id>`), not the shared `NONE` bucket —
#        so each room is deduped on its own and can't hide behind another.
#     2. Runaway-keeper override: even a keeper is reaped by the stuck-rule if it
#        is BOTH very old (>= STUCK_AGE) AND pegged near a full core for its whole
#        life (ratio >= RUNAWAY_RATIO) AND a fresh CPU sample confirms it is STILL
#        burning. A live/active turn is never pegged that hard for that long, so
#        this only ever catches a genuine runaway, never the live turn.
#
# SAFE BY DESIGN:
#   * only ever touches procs whose comm is exactly `claude` owned by a bridge-* user
#   * never kills the NEWEST proc of any session id — EXCEPT a proven runaway-keeper
#     (old + high lifetime ratio + still-pegged right now); protects the live turn,
#     including the very conversation that may be running this
#   * never kills a proc younger than MIN_AGE
#   * stuck-rule needs BOTH long age AND high lifetime CPU ratio; a healthy idle
#     session sits at ~1-5% ratio, the observed runaways were 50-92%
#   * logs every kill with its reason to reaper.log
# Runs as root (launched from start.sh) so it can reap any pane's procs.
# Remove it by deleting the launch block in start.sh; kill this loop to stop now.

LOG="${REAPER_LOG:-/var/www/html/claude-code-bridge-standalone/logs/reaper.log}"
INTERVAL="${REAPER_INTERVAL:-180}"   # seconds between sweeps
MIN_AGE="${REAPER_MIN_AGE:-90}"      # never touch procs younger than this
STUCK_AGE="${REAPER_STUCK_AGE:-1800}"  # stuck-rule only past this age
STUCK_RATIO="${REAPER_STUCK_RATIO:-40}" # % of one core, averaged over lifetime
RUNAWAY_RATIO="${REAPER_RUNAWAY_RATIO:-80}" # keeper-override: lifetime ratio to treat a keeper as a runaway
RECENT_RATIO="${REAPER_RECENT_RATIO:-50}"   # keeper-override: % of one core in a fresh sample to confirm still-pegged
RECENT_SAMPLE="${REAPER_RECENT_SAMPLE:-3}"  # seconds for the fresh CPU sample

log(){ echo "$(date '+%F %T') $*" >> "$LOG" 2>/dev/null; }

do_kill(){ # pid
  kill "$1" 2>/dev/null
  for _ in 1 2; do sleep 1; kill -0 "$1" 2>/dev/null || return 0; done
  kill -9 "$1" 2>/dev/null
}

# [TASK646] Rule-B poison marker. Written ONLY for a proc positively classified as
# a stuck/runaway *keeper* turn (never for Rule-A dup kills, which kill an obsolete
# proc while the healthy newest survives). bridge-server replayPending() correlates
# the marker to a journal by session/room id + killTs freshness and, if it matches,
# surfaces the turn as failed/recoverable instead of respawning it.
REAP_MARK="${REAPER_MARK:-1}"
mark_reaped(){ # pid rid reason user
  [ "$REAP_MARK" = "1" ] || return 0
  local pid="$1" rid="$2" reason="$3" user="$4" home dir sess room key f
  # [TASK646E] Only poison a journal for a target we CONFIRMED dead. A survived/failed
  # kill, or a process that exited on its own, must not falsely mark a valid turn.
  if kill -0 "$pid" 2>/dev/null; then log "MARK skipped rid=$rid: pid=$pid still alive after kill"; return 0; fi
  [ -z "$user" ] && return 0
  case "$user" in bridge-*) ;; *) return 0;; esac
  home="/home/$user"; dir="$home/.claude/bridge-pending"
  mkdir -p "$dir" 2>/dev/null || return 0
  if [ "${rid#room:}" != "$rid" ]; then room="${rid#room:}"; sess=""; else room=""; sess="$rid"; fi
  key=$(printf '%s' "$rid" | sed -E 's/[^A-Za-z0-9_-]/_/g')
  f="$dir/$key.reaped"
  printf '{"reaped":true,"rid":"%s","session":"%s","room":"%s","pid":%s,"killTs":%s,"reason":"%s"}\n' \
    "$rid" "$sess" "$room" "$pid" "$(( $(date +%s) * 1000 ))" "$reason" > "$f" 2>/dev/null || return 0
  chown "$user:$user" "$f" 2>/dev/null || true
  log "MARK reaped rid=$rid reason=$reason -> $f"
}

# jiffies(pid) -> utime+stime ticks for the proc, robust to spaces/parens in comm.
jiffies(){ # pid
  local stat rest
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  rest=${stat#*') '}                 # drop "pid (comm) " — comm may hold spaces
  set -- $rest                       # $1=state ... utime=$12, stime=$13 of rest
  [ -n "${12:-}" ] || return 1
  echo $(( ${12} + ${13} ))
}

# recent_pegged(pid) -> 0 (true) if the proc is STILL burning >= RECENT_RATIO% of a
# core over a fresh RECENT_SAMPLE-second window. Used only to confirm a runaway-keeper.
recent_pegged(){ # pid
  local pid="$1" j1 j2 d need
  j1=$(jiffies "$pid") || return 1
  sleep "$RECENT_SAMPLE"
  j2=$(jiffies "$pid") || return 1
  d=$(( j2 - j1 ))                               # ticks used in the window
  need=$(( RECENT_SAMPLE * 100 * RECENT_RATIO / 100 ))  # CLK_TCK=100; % of one core
  [ "$d" -ge "$need" ]
}

reap_once(){
  local rows pid user age ct rid mcp ratio grp keeper cnt
  rows="$(for pid in $(pgrep -x claude); do
    user=$(ps -o user= -p "$pid" 2>/dev/null | tr -d ' '); case "$user" in bridge-*) ;; *) continue;; esac
    age=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' '); [ -z "$age" ] && continue
    ct=$(ps -o cputimes= -p "$pid" 2>/dev/null | tr -d ' '); [ -z "$ct" ] && ct=0
    rid=$(tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | awk 'p{print;exit} /^--resume$/{p=1}')
    if [ -z "$rid" ]; then
      # no --resume (draft/first-turn/room): give it a per-ROOM identity from
      # --mcp-config so each room is its own bucket, not the shared NONE bucket.
      mcp=$(tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | awk 'p{print;exit} /^--mcp-config$/{p=1}')
      rid=$(basename "$mcp" 2>/dev/null | sed -E 's/^mcp-room-//; s/\.json$//')
      if [ -n "$rid" ] && [ "$rid" != "." ]; then rid="room:$rid"; else rid=NONE; fi
    fi
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

    # Rule B: stuck loop -> old AND high lifetime CPU ratio
    while read -r pid age ct; do
      kill -0 "$pid" 2>/dev/null || continue   # may already be gone via Rule A
      [ "$age" -lt "$STUCK_AGE" ] && continue
      ratio=$(( age > 0 ? 100 * ct / age : 0 ))
      if [ "$pid" = "$keeper" ]; then
        # The keeper (newest of its id) is normally protected as the live/active turn.
        # EXCEPTION — runaway-keeper: a sole/newest proc that is very old AND pegged
        # near a full core for its whole life AND still burning right now is NOT a live
        # turn (it is the PID-1058783 wedged-draft blind spot). Only then do we reap it.
        if [ "$ratio" -ge "$RUNAWAY_RATIO" ] && recent_pegged "$pid"; then
          log "KILL runaway-keeper pid=$pid session=$rid age=${age}s cpu=${ct}s ratio=${ratio}% (sole/newest but pegged)"
          ruser=$(ps -o user= -p "$pid" 2>/dev/null | tr -d ' ')   # [TASK646E] capture owner while alive
          do_kill "$pid"
          mark_reaped "$pid" "$rid" "runaway-keeper" "$ruser"       # [TASK646E] writes only if confirmed dead
        fi
        continue
      fi
      if [ "$ratio" -ge "$STUCK_RATIO" ]; then
        log "KILL stuck pid=$pid session=$rid age=${age}s cpu=${ct}s ratio=${ratio}%"
        ruser=$(ps -o user= -p "$pid" 2>/dev/null | tr -d ' ')   # [TASK646E] capture owner while alive
        do_kill "$pid"
        mark_reaped "$pid" "$rid" "stuck" "$ruser"               # [TASK646E] writes only if confirmed dead
      fi
    done <<< "$grp"
  done
}

log "reaper started pid=$$ interval=${INTERVAL}s stuck_age=${STUCK_AGE}s stuck_ratio=${STUCK_RATIO}% min_age=${MIN_AGE}s runaway_ratio=${RUNAWAY_RATIO}% recent_ratio=${RECENT_RATIO}%/${RECENT_SAMPLE}s"
while true; do
  reap_once 2>>"$LOG"
  sleep "$INTERVAL"
done
