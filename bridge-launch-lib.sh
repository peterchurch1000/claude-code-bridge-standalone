#!/bin/bash
# bridge-launch-lib.sh — recreate-storm hardening helpers for the Castle bridge.
#
# SAFE TO SOURCE: this file defines functions only and has NO top-level side
# effects at source time. The helpers ARE intentionally effectful WHEN INVOKED
# (they signal processes, delete lock files, acquire flock, probe endpoints).
# Sourced by start.sh and start-browser.sh, and by test-launch-lib.sh.
#
# Env consumed by callers (exported by start.sh / start-browser.sh):
#   CHROME_PROFILE_DIR  Chrome --user-data-dir root (where Singleton* live)
#   CDP_PORT MCP_PORT   readiness probe targets
#   HOME                per-user home ($HOME/.claude holds on-demand flags)
#
# Tunables (env, with conservative safe defaults):
#   LAUNCH_LOCK=/tmp/castle-chrome-launch.lock  shared cold-launch mutex file
#   MEM_HEADROOM_MB=1200        min free cgroup mem before admitting a launch
#                               (grounded: measured warm Chrome+MCP stack ~600MB,
#                                x2 for cold/transient peak + margin)
#   CHROME_LAUNCH_TIMEOUT=45    max secs to wait for the launch slot, then DEFER
#   ADMISSION_RETRY=15          secs between admission attempts while deferred
#   SETTLE_TIMEOUT=20           max secs to hold slot for CDP+MCP+RSS settle
#   SETTLE_EPSILON_MB=40        RSS "settled" when delta < this across a tick
#   WATCHDOG_BACKOFF_START=5    outer-watchdog restart backoff floor
#   WATCHDOG_BACKOFF_MAX=300    outer-watchdog restart backoff ceiling
#   WATCHDOG_STABLE_RESET=120   a run this long resets backoff to the floor
#   CGROUP_MEM_DIR=/sys/fs/cgroup   (override for testing)

LAUNCH_LOCK="${LAUNCH_LOCK:-/tmp/castle-chrome-launch.lock}"

# --- memory (cgroup v2) -------------------------------------------------------
mem_free_mb() {
  local base="${CGROUP_MEM_DIR:-/sys/fs/cgroup}" max cur
  max="$(cat "$base/memory.max" 2>/dev/null)"
  # Unlimited or unreadable => report a large value so we never hard-block.
  if [ -z "$max" ] || [ "$max" = "max" ]; then echo 100000; return 0; fi
  cur="$(cat "$base/memory.current" 2>/dev/null || echo 0)"
  echo $(( (max - cur) / 1048576 ))
}

_cg_current_mb() {
  local base="${CGROUP_MEM_DIR:-/sys/fs/cgroup}" cur
  cur="$(cat "$base/memory.current" 2>/dev/null || echo 0)"
  echo $(( cur / 1048576 ))
}

# --- profile / lock hygiene ---------------------------------------------------
# TRUE (0) if any live process still references the profile dir. Used to prove a
# profile is free BEFORE we clear its locks or launch a new Chrome on it, so we
# can never create a second user of the same profile.
profile_in_use() {
  [ -n "$CHROME_PROFILE_DIR" ] || return 1
  pgrep -f -- "--user-data-dir=$CHROME_PROFILE_DIR" >/dev/null 2>&1
}

# Remove Chrome's singleton artifacts. Caller MUST have proven the profile is
# free (profile_in_use == false) — except at boot, where entrypoint.sh sweeps
# unconditionally because no Chrome exists yet.
clear_singleton_locks() {
  [ -n "$CHROME_PROFILE_DIR" ] || return 0
  rm -f "$CHROME_PROFILE_DIR/SingletonLock" \
        "$CHROME_PROFILE_DIR/SingletonSocket" \
        "$CHROME_PROFILE_DIR/SingletonCookie" 2>/dev/null || true
}

# Ensure NO live process still uses the profile, with bounded escalation. Used by
# the in-place recovery path BEFORE re-admission so surviving Chrome children can
# never pin profile_in_use true forever (which would permanently park recovery).
# Returns 0 if the profile is free afterwards, 1 if something survived even SIGKILL.
reap_profile() {  # $1 = timeout secs (default 10)
  local timeout="${1:-10}" t0
  [ -n "$CHROME_PROFILE_DIR" ] || return 0
  pkill -f -- "$CHROME_PROFILE_DIR" 2>/dev/null || true
  t0=$(date +%s)
  while profile_in_use; do
    if [ $(( $(date +%s) - t0 )) -ge "$timeout" ]; then
      pkill -9 -f -- "$CHROME_PROFILE_DIR" 2>/dev/null || true
      sleep 1; break
    fi
    sleep 0.5
  done
  profile_in_use && return 1 || return 0
}

# --- shared cold-launch slot (flock on fd 9) ----------------------------------
open_launch_lock() { exec 9>"$LAUNCH_LOCK"; }
release_launch_slot() { flock -u 9 2>/dev/null || true; }

# Attempt admission. On success returns 0 HOLDING the slot (fd 9 locked); the
# caller must call release_launch_slot() after wait_stack_ready(). On any
# deferral (memory short, slot timeout, profile contention) returns non-zero
# WITHOUT holding the slot and WITHOUT launching anything.
try_admit() {
  # Cheap early-out before contending for the lock.
  [ "$(mem_free_mb)" -ge "${MEM_HEADROOM_MB:-1200}" ] || return 1
  # Serialize cold launches; timeout => DEFER (never bypass serialization).
  flock -x -w "${CHROME_LAUNCH_TIMEOUT:-45}" 9 || return 1
  # Authoritative recheck UNDER the lock (kills the stale-capacity race).
  if [ "$(mem_free_mb)" -lt "${MEM_HEADROOM_MB:-1200}" ]; then
    flock -u 9; return 1
  fi
  # Profile contention => DEFER (do not create a second profile user).
  if profile_in_use; then
    flock -u 9; return 1
  fi
  # Provably safe now: no live process uses this profile.
  clear_singleton_locks
  return 0
}

# --- on-demand awareness ------------------------------------------------------
# Delegates to start-browser.sh's _wanted_fresh when present; otherwise every
# user is treated as "wanted" so non-on-demand users are always admissible.
_admission_wanted_fresh() {
  if declare -F _wanted_fresh >/dev/null 2>&1; then _wanted_fresh; return $?; fi
  return 0
}

# --- general admission gate (ALL users) ---------------------------------------
# Runs before every cold Chrome launch. Memory/lock/contention deferrals never
# exit the process: they loop in-place, staying alive as a normal long-lived
# state so the outer watchdog is NOT involved in ordinary deferrals.
#
# On-demand idle is handled per mode ($1):
#   initial  (default) — park until wanted, then admit (stack is coming up).
#   recovery           — return 2 (IDLE) immediately so the caller can follow the
#                        EXISTING idle-stop cleanup path (KILL_AUX + exit) instead
#                        of holding X/VNC open waiting for demand that may not come.
#
# Returns: 0 = admitted, HOLDING the launch slot;  2 = on-demand idle (recovery).
await_admission() {
  local mode="${1:-initial}"
  while true; do
    if [ -f "$HOME/.claude/browser-on-demand" ] && ! _admission_wanted_fresh; then
      [ "$mode" = "recovery" ] && return 2
      while [ -f "$HOME/.claude/browser-on-demand" ] && ! _admission_wanted_fresh; do sleep 5; done
    fi
    if try_admit; then
      rm -f "$HOME/.claude/.parked-lowmem" 2>/dev/null || true
      return 0
    fi
    # Deferral is a normal quiescent state, not a crash. Mark and retry.
    : > "$HOME/.claude/.parked-lowmem" 2>/dev/null || true
    sleep "${ADMISSION_RETRY:-15}"
  done
}

# --- readiness / settle -------------------------------------------------------
_port_open() {  # $1 = port
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; }
  return 1
}

_cdp_ready() {
  if command -v curl >/dev/null 2>&1; then
    curl -sf -o /dev/null "http://127.0.0.1:${CDP_PORT:-9231}/json/version"
  else
    _port_open "${CDP_PORT:-9231}"
  fi
}

# Hold the slot through the material startup + settle phase so the next cold
# launch cannot overlap this stack's MCP startup / RSS ramp.
# Returns: 0 = CDP+MCP came up (RSS settled or best-effort within the window);
#          1 = CDP or MCP TIMED OUT — the launch failed and the caller MUST tear
#              down the partial stack / enter controlled recovery rather than
#              treat a wedged launch as "settled".
wait_stack_ready() {
  local t0 prev cur d
  t0=$(date +%s)
  while ! _cdp_ready; do
    [ $(( $(date +%s) - t0 )) -ge "${SETTLE_TIMEOUT:-20}" ] && return 1
    sleep 1
  done
  while ! _port_open "${MCP_PORT:-8941}"; do
    [ $(( $(date +%s) - t0 )) -ge "${SETTLE_TIMEOUT:-20}" ] && return 1
    sleep 1
  done
  # CDP+MCP are up. Let RSS quiesce so the next launch doesn't overlap the ramp;
  # if it doesn't fully settle within the window that's acceptable (stack is up).
  prev=$(_cg_current_mb)
  while [ $(( $(date +%s) - t0 )) -lt "${SETTLE_TIMEOUT:-20}" ]; do
    sleep 2
    cur=$(_cg_current_mb)
    d=$(( cur - prev )); [ "$d" -lt 0 ] && d=$(( -d ))
    [ "$d" -lt "${SETTLE_EPSILON_MB:-40}" ] && return 0
    prev=$cur
  done
  return 0
}

# --- outer watchdog backoff (demote to backstop) ------------------------------
# Echoes the next backoff interval given how long the last run lasted and the
# current backoff. A run >= WATCHDOG_STABLE_RESET resets to the floor; otherwise
# doubles up to the ceiling. Turns a tight 5s relaunch into a backstop.
next_backoff() {  # $1 = ran_seconds  $2 = current_backoff
  local ran="$1" cur="$2"
  local start="${WATCHDOG_BACKOFF_START:-5}" max="${WATCHDOG_BACKOFF_MAX:-300}" stable="${WATCHDOG_STABLE_RESET:-120}"
  if [ "$ran" -ge "$stable" ]; then echo "$start"; return 0; fi
  local nxt=$(( cur * 2 ))
  [ "$nxt" -lt "$start" ] && nxt="$start"
  [ "$nxt" -gt "$max" ] && nxt="$max"
  echo "$nxt"
}
