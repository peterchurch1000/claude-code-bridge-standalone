#!/usr/bin/env bash
# ============================================================================
# repro-codex-lock.sh  —  Deterministic reproduction of the conference
# "Could not obtain Codex credentials after 3 attempts" pause.
#
# ROOT CAUSE UNDER TEST: per-account flock starvation. The bridge runs every
# Codex turn as:
#     flock -w 30 <lock> bash -c 'printf "__LOCK_ACQUIRED__\n" >&2; exec codex "$@"'
# When a concurrent turn already holds <lock>, a waiter that cannot acquire
# within 30s exits NONZERO *without ever printing the sentinel* — codex never
# runs. bridge-server.js _runCodexTurn reads (!lockAcquired) => classifies
# 'transient' => retries; three such in a row => the exhausted pause.
#
# This harness proves that mechanism with ZERO production impact:
#   * throwaway lock (codex-__repro__.lock), never a real account lane
#   * a dummy payload stands in for `codex` (so no ChatGPT account is touched)
#   * the real active ~/.codex/auth.json is sha256'd before+after to PROVE the
#     harness leaves credential state untouched (no token is ever printed)
#
# EXPECTED "exact Codex CLI error": NONE. Codex is never invoked. The only
# observable evidence is flock's nonzero exit + absent __LOCK_ACQUIRED__
# sentinel + unchanged credential lineage. That is the whole point.
#
# Usage:  repro-codex-lock.sh [WAITERS] [FLOCK_W] [HOLD_SECS]
#   WAITERS   concurrent waiters to fire            (default 4)
#   FLOCK_W   per-attempt flock -w seconds          (default 30, prod value)
#   HOLD_SECS synthetic holder hold time            (default 150, > retry budget)
# ============================================================================
set -uo pipefail

WAITERS="${1:-4}"
FLOCK_W="${2:-30}"
HOLD_SECS="${3:-200}"

LOCK="/tmp/codex-__repro__.lock"
OUTDIR="$(mktemp -d /tmp/codex-repro.XXXXXX)"
SENTINEL="__LOCK_ACQUIRED__"
HOLDER_WRAP=""
# Guaranteed cleanup on any exit/interrupt: kill the synthetic holder + temp dir.
cleanup() { [ -n "$HOLDER_WRAP" ] && kill "$HOLDER_WRAP" 2>/dev/null; rm -rf "$OUTDIR" 2>/dev/null; }
trap cleanup EXIT INT TERM
# Non-secret whole-file fingerprint of the LIVE active credential (never its contents).
AUTH="${CODEX_AUTH:-$HOME/.codex/auth.json}"

echo "=== repro-codex-lock  $(date -Is) ==="
echo "lock=$LOCK waiters=$WAITERS flock_w=${FLOCK_W}s hold=${HOLD_SECS}s outdir=$OUTDIR"

auth_fp() { [ -f "$AUTH" ] && sha256sum "$AUTH" | cut -d' ' -f1 || echo "NO_AUTH_FILE"; }
FP_BEFORE="$(auth_fp)"
echo "active auth.json sha256 BEFORE: $FP_BEFORE   (path=$AUTH)"

# ---- 1. Synthetic holder: take the lock and hold it past the retry budget ----
: > "$LOCK"
flock -w 0 "$LOCK" -c "echo HELD_BY_HOLDER pid=\$\$ at=\$(date -Is); sleep $HOLD_SECS" &
HOLDER_WRAP=$!
# Confirm acquisition before dispatching any waiter (no TOCTOU on the assertion).
sleep 1
if flock -w 0 "$LOCK" -c true 2>/dev/null; then
  echo "FATAL: holder did not acquire the lock; aborting (would not be a valid repro)"; kill "$HOLDER_WRAP" 2>/dev/null; exit 2
fi
echo "holder confirmed holding $LOCK"

# NOTE: every phase below runs INSIDE the holder's hold window (holder=${HOLD_SECS}s);
# we only ever `wait` on explicit waiter PIDs, never bare `wait` (which would also
# block on the holder and desynchronise the phases).

# ---- 2. Emulate the bridge's 3-attempt budget on ONE room (sequential) -------
# Mirrors CONF_CRED_MAX_ATTEMPTS=3 with backoff [2s,8s]; all three must time out
# while the holder still holds => the "after 3 attempts" exhaustion. (~100s < hold)
echo "--- 3-attempt budget emulation (flock -w ${FLOCK_W}, backoff 2s/8s) at $(date -Is) ---"
attempt_fail=0
for a in 1 2 3; do
  t0=$(date +%s)
  flock -w "$FLOCK_W" "$LOCK" bash -c "printf '${SENTINEL}\n' >&2; exec true" >/dev/null 2>"$OUTDIR/attempt-$a.err"
  rc=$?; t1=$(date +%s)
  seen="no"; grep -q "$SENTINEL" "$OUTDIR/attempt-$a.err" && seen="yes"
  echo "attempt $a rc=$rc waited=$((t1-t0))s sentinel=$seen  -> classification=$([ "$seen" = no ] && echo transient || echo runtime)"
  [ "$rc" != 0 ] && [ "$seen" = "no" ] && attempt_fail=$((attempt_fail+1))
  [ "$a" -lt 3 ] && sleep $([ "$a" = 1 ] && echo 2 || echo 8)
done

# ---- 3. Fire WAITERS concurrent waiters replicating the EXACT bridge spawn ----
# The wrapped payload is a dummy (`exec printf`) so no real codex/account. (~30s)
run_waiter() {
  local i="$1" of="$OUTDIR/waiter-$i"
  # Byte-exact stdout/stderr capture per Codex's requirement.
  flock -w "$FLOCK_W" "$LOCK" bash -c "printf '${SENTINEL}\n' >&2; exec printf 'DUMMY_CODEX_RAN\n'" \
      >"$of.out" 2>"$of.err"
  echo "$?" > "$of.rc"
}
echo "--- dispatching $WAITERS concurrent waiters (each flock -w ${FLOCK_W}) at $(date -Is) ---"
WPIDS=""
for i in $(seq 1 "$WAITERS"); do run_waiter "$i" & WPIDS="$WPIDS $!"; done
wait $WPIDS   # only the waiters, NOT the holder

PASS=1
for i in $(seq 1 "$WAITERS"); do
  of="$OUTDIR/waiter-$i"; rc="$(cat "$of.rc")"
  sentinel_seen="no"; grep -q "$SENTINEL" "$of.err" && sentinel_seen="yes"
  dummy_ran="no";      grep -q "DUMMY_CODEX_RAN" "$of.out" && dummy_ran="yes"
  printf "waiter %-2s rc=%-3s sentinel=%-3s payload_ran=%-3s\n" "$i" "$rc" "$sentinel_seen" "$dummy_ran"
  # Deterministic expectation: nonzero rc, NO sentinel, payload NEVER ran.
  if [ "$rc" = "0" ] || [ "$sentinel_seen" = "yes" ] || [ "$dummy_ran" = "yes" ]; then PASS=0; fi
done

# ---- 5. Prove credential lineage untouched ----------------------------------
FP_AFTER="$(auth_fp)"
echo "active auth.json sha256 AFTER:  $FP_AFTER"
cred_ok="no"; [ "$FP_BEFORE" = "$FP_AFTER" ] && cred_ok="yes"

kill "$HOLDER_WRAP" 2>/dev/null; wait "$HOLDER_WRAP" 2>/dev/null

echo "=== RESULT ==="
echo "all_waiters_pre_sentinel_timeout: $([ "$PASS" = 1 ] && echo YES || echo NO)"
echo "three_attempt_budget_exhausted:   $([ "$attempt_fail" = 3 ] && echo YES || echo NO)  ($attempt_fail/3 transient)"
echo "credential_lineage_unchanged:     $cred_ok"
echo "expected_codex_cli_error:         none (codex never invoked)"
if [ "$PASS" = 1 ] && [ "$attempt_fail" = 3 ] && [ "$cred_ok" = "yes" ]; then
  echo "REPRO: DETERMINISTIC PASS — lock starvation reproduces the 3-attempt exhaustion with no credential event."
  rm -rf "$OUTDIR"; exit 0
else
  echo "REPRO: INCONCLUSIVE — see $OUTDIR"; exit 1
fi
