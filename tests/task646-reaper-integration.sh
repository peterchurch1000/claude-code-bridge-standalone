#!/usr/bin/env bash
# [TASK646] Self-contained, reproducible integration test.
#   PRODUCER = REAL reaper.sh mark_reaped() (home redirected to a temp dir = only substitution).
#   CONSUMER = REAL replayPending() in a SEPARATE node process (tests/task646-selftest.cjs),
#              run under its OWN temp HOME so the marker (kept in the producer dir) is not wiped.
# Non-destructive. Re-run: bash this file.
set -uo pipefail
D=/var/www/castle-container/claude-code-bridge-standalone
PH="$(mktemp -d /tmp/t646-prod.XXXXXX)"   # producer dir (holds the marker)
CH="$(mktemp -d /tmp/t646-cons.XXXXXX)"   # consumer HOME (replayPending PENDING_DIR lives here)
mkdir -p "$PH/.claude/bridge-pending" "$CH/.claude/bridge-pending"
LO=$(grep -n '^log()' "$D/reaper.sh" | head -1 | cut -d: -f1)
HI=$(awk 'NR>='"$LO"' && /^mark_reaped\(\)/{m=1} m&&/^}/{print NR; exit}' "$D/reaper.sh")
sed -n "${LO},${HI}p" "$D/reaper.sh" | sed "s#/home/\$user#$PH#" > "$PH/reaper-funcs.sh"
echo "[producer] extracted reaper.sh lines ${LO}-${HI}; home -> $PH"
sleep 0.05 & DEADPID=$!; wait "$DEADPID" 2>/dev/null || true
PRODCMD="REAP_MARK=1 LOG=$PH/reaper.log HOME=$PH bash -c 'source $PH/reaper-funcs.sh; mark_reaped $DEADPID SELFTEST-REAPER-SESS runaway-keeper bridge-peter'"
echo "[producer] CMD: $PRODCMD"
eval "$PRODCMD"
MARKER="$PH/.claude/bridge-pending/SELFTEST-REAPER-SESS.reaped"
echo "[producer] marker artifact:"; cat "$MARKER"; echo
echo "[consumer] REAL replayPending in a separate node process (HOME=$CH), consuming the produced marker..."
HOME="$CH" REAL_MARKER="$MARKER" node "$D/tests/task646-selftest.cjs"
RC=$?
rm -rf "$PH" "$CH"
exit $RC
