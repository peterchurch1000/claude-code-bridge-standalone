#!/usr/bin/env bash
# ============================================================================
# repro-codex-conference.sh — DETERMINISTIC, on-demand, production-PATH repro.
#
# ⚠ RUN IN THE VERIFICATION STAGE ONLY. MUTATING at the fleet level: it holds
#   the REAL active Codex lane lock, so live conference Codex turns on that
#   account queue during the window. Requires an ANNOUNCED WINDOW. If the
#   instrumentation build is live, the real _runCodexTurn->confSpawnFailed path
#   is also captured per attempt in codex-attempts.*.jsonl.
#
# Unlike repro-codex-lock.sh (throwaway lock, dummy payload — proves the flock
# MECHANISM), this drives the REAL credential-acquisition path deterministically:
# a synthetic holder holds the REAL lane lock, then we fire EXACTLY 3 sequential
# bridge-identical wrappers (real `codex exec` under `flock -w 30`, backoff 2s/8s
# = CONF_CRED_MAX_ATTEMPTS with its real budget). All three time out pre-sentinel
# => 3/3 transient => the exact input that makes confSpawnFailed emit
# "Could not obtain Codex credentials after 3 attempts". Codex never runs (lock
# held), so BOTH the access AND refresh token fingerprints must be unchanged —
# proving no rotation / no reuse event.
#
# Usage: repro-codex-conference.sh <ACCOUNT> [HOLD_SECS] [ROOM_KEY]
#   ACCOUNT   active codex account (from `node credential-steward.js active-codex`)
#   HOLD_SECS hold window (default 120; must exceed 3x30s + 2s + 8s = 100s)
#   ROOM_KEY  optional: a live instrumented conference room to also assert
#             spawnRetries:3 / pendingRetry:null / exact pause message against.
# ============================================================================
set -uo pipefail
ACCOUNT="${1:?usage: repro-codex-conference.sh <ACCOUNT> [HOLD_SECS] [ROOM_KEY]}"
HOLD_SECS="${2:-120}"
ROOM_KEY="${3:-}"

DIR="$(cd "$(dirname "$0")" && pwd)"
STATE="$HOME/.credential-steward"
LOCK="$STATE/codex-${ACCOUNT}.lock"
AUTH="${CODEX_AUTH:-$HOME/.codex/auth.json}"
CONF_DIR="$HOME/.claude/bridge-conference"
SENTINEL="__LOCK_ACQUIRED__"
START_EPOCH="$(date +%s)"
OUTDIR="$(mktemp -d /tmp/codex-conf-repro.XXXXXX)"
HOLDER=""
cleanup() { [ -n "$HOLDER" ] && kill "$HOLDER" 2>/dev/null; rm -rf "$OUTDIR" 2>/dev/null; }  # never leave the real lane locked
trap cleanup EXIT INT TERM

[ -e "$LOCK" ] || { echo "FATAL: lane lock $LOCK not found (wrong account?)"; exit 2; }
# Non-secret access+refresh fingerprints of the LIVE credential (never its contents).
fps() { python3 - "$AUTH" <<'PY' 2>/dev/null || echo "NA NA"
import json,sys,hashlib
try:
    t=json.load(open(sys.argv[1])).get("tokens",{}) or {}
    def fp(x): return hashlib.sha256(x.encode()).hexdigest()[:16] if x else "none"
    print(fp(t.get("access_token","")), fp(t.get("refresh_token","")))
except Exception: print("NA NA")
PY
}
read A_BEFORE R_BEFORE <<<"$(fps)"
echo "=== conference e2e repro  $(date -Is)  account=$ACCOUNT hold=${HOLD_SECS}s ==="
echo "access_fp BEFORE=$A_BEFORE  refresh_fp BEFORE=$R_BEFORE"
echo ">>> ANNOUNCE: real Codex turns on '$ACCOUNT' will queue for ${HOLD_SECS}s."

# Hold the REAL active lane so the 3 attempts (and live turns) starve as in prod.
flock -w 0 "$LOCK" -c "echo HELD_REAL_LANE pid=\$\$; sleep $HOLD_SECS" &
HOLDER=$!
sleep 1
flock -w 0 "$LOCK" -c true 2>/dev/null && { echo "FATAL: could not hold $LOCK"; exit 2; }
echo "holding real lane $LOCK"

# Fire EXACTLY 3 sequential bridge-identical attempts (real codex under flock -w 30).
transient=0
for a in 1 2 3; do
  t0=$(date +%s)
  flock -w 30 "$LOCK" bash -c "printf '${SENTINEL}\n' >&2; exec codex exec --json --sandbox read-only --skip-git-repo-check 'reply OK'" \
      >"$OUTDIR/a$a.out" 2>"$OUTDIR/a$a.err"
  rc=$?; t1=$(date +%s)
  seen=no; grep -q "$SENTINEL" "$OUTDIR/a$a.err" && seen=yes
  cls=$([ "$seen" = no ] && echo transient || echo runtime)
  echo "attempt $a rc=$rc waited=$((t1-t0))s sentinel=$seen classification=$cls"
  [ "$rc" != 0 ] && [ "$seen" = no ] && transient=$((transient+1))
  [ "$a" -lt 3 ] && sleep $([ "$a" = 1 ] && echo 2 || echo 8)
done

cleanup_holder() { kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null; HOLDER=""; }
cleanup_holder
read A_AFTER R_AFTER <<<"$(fps)"
echo "access_fp AFTER =$A_AFTER  refresh_fp AFTER =$R_AFTER"

# Corroborate from telemetry (only records written AFTER START_EPOCH count).
tele_transient=0
if compgen -G "$STATE/codex-attempts.*.jsonl" >/dev/null; then
  tele_transient=$(python3 - "$START_EPOCH" "$ACCOUNT" "$STATE" <<'PY'
import json,glob,sys,os
start=int(sys.argv[1]); acct=sys.argv[2]; st=sys.argv[3]; n=0
for f in glob.glob(os.path.join(st,"codex-attempts.*.jsonl")):
    for line in open(f,errors="ignore"):
        try: r=json.loads(line)
        except Exception: continue
        ts=r.get("ts","")
        # ISO -> epoch (coarse); only count post-start close transients on this acct
        import calendar,time
        try: e=calendar.timegm(time.strptime(ts[:19],"%Y-%m-%dT%H:%M:%S"))
        except Exception: e=0
        if e>=start and r.get("phase")=="close" and r.get("acct")==acct and r.get("classification")=="transient": n+=1
print(n)
PY
)
fi

# Optional: assert the live FSM state on a specific instrumented room.
room_ok="n/a"
if [ -n "$ROOM_KEY" ] && [ -f "$CONF_DIR/$ROOM_KEY.json" ]; then
  if grep -q "Could not obtain Codex credentials after 3 attempts" "$CONF_DIR/$ROOM_KEY.json" \
     && grep -q '"spawnRetries":3' "$CONF_DIR/$ROOM_KEY.json" \
     && grep -q '"pendingRetry":null' "$CONF_DIR/$ROOM_KEY.json"; then room_ok=yes; else room_ok=no; fi
fi

acc_ok=no; [ "$A_BEFORE" = "$A_AFTER" ] && acc_ok=yes
ref_ok=no; [ "$R_BEFORE" = "$R_AFTER" ] && ref_ok=yes
echo "=== RESULT ==="
echo "attempts_transient_pre_sentinel:  $transient/3"
echo "telemetry_transient_closes(post): $tele_transient  (0 unless instrumentation live)"
echo "access_token_unchanged:           $acc_ok"
echo "refresh_token_unchanged:          $ref_ok"
echo "live_room_exhausted_assert:       $room_ok  (ROOM_KEY optional)"
if [ "$transient" = 3 ] && [ "$acc_ok" = yes ] && [ "$ref_ok" = yes ]; then
  echo "E2E: DETERMINISTIC PASS — 3/3 real credential-acquisition attempts starved; no access/refresh rotation."
  exit 0
else
  echo "E2E: FAIL"; exit 1
fi
