#!/usr/bin/env bash
# ============================================================================
# e2e-isolated-bridge.sh — TRUE end-to-end reproduction on an ISOLATED
# instrumented bridge (alt ports, temp HOME/state). Does NOT touch production
# and does NOT restart the live bridge / kill any conference.
#
# It boots bridge-server.js.instr with a temp HOME, seeds ONE fake codex test
# account, holds that account's lane lock, then drives a REAL codex-led
# conference turn through the bridge's own WS API. The real _runCodexTurn ->
# confSpawnFailed FSM runs: 3 flock timeouts => the exact "Could not obtain
# Codex credentials after 3 attempts" pause, with 3 per-attempt telemetry
# records. Fake tokens are fine — codex never runs (lock held), so no network,
# and access+refresh fingerprints must be unchanged (no rotation).
# ============================================================================
set -uo pipefail
D=/var/www/castle-container/claude-code-bridge-standalone
CONTAINER="${CONTAINER:-castle-app}"
# Steward source: validated path arg/env, else copy out of the running container
# (overlay layer IDs are ephemeral — never hardcode them).
STEWARD_SRC="${STEWARD_SRC:-}"
PORT=3999; MCP=8999; NOVNC=6999
TS=$(date +%s)
TMP=/tmp/codex-e2e-$TS
RESULTS_ROOT="${RESULTS_ROOT:-/root/codex-e2e-results}"
BUNDLE="$RESULTS_ROOT/e2e-$TS"
ROOM=e2e-test-room
E2E_BRIDGE="$D/bridge-server.e2e.js"
E2E_CLIENT="$D/e2e-client.js"
LOCK="$TMP/.credential-steward/codex-test.lock"
BRIDGE_LOG="$TMP/bridge.log"
HOLDER=""; BRIDGE_PID=""
cleanup() {
  [ -n "$BRIDGE_PID" ] && kill "$BRIDGE_PID" 2>/dev/null
  [ -n "$HOLDER" ] && kill "$HOLDER" 2>/dev/null
  rm -f "$E2E_BRIDGE"
}
trap cleanup EXIT INT TERM

echo "=== isolated e2e  $(date -Is)  port=$PORT home=$TMP ==="
mkdir -p "$TMP/.codex/accounts" "$TMP/.claude/accounts" "$TMP/.credential-steward"
echo castle > "$TMP/credential-steward.host"
cat > "$TMP/.codex/auth.json" <<'J'
{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"eyJhbGciOiJmYWtlIn0.eyJlbWFpbCI6InRlc3QifQ.sig","access_token":"eyJhbGciOiJmYWtlIn0.eyJleHAiOjE5MDAwMDAwMDB9.sig","refresh_token":"rt.fake.TESTREFRESHTOKEN","account_id":"testid-018b"},"last_refresh":"2026-09-19T22:33:21Z"}
J
cp "$TMP/.codex/auth.json" "$TMP/.codex/accounts/test.auth.json"
cat > "$TMP/credential-accounts.json" <<'J'
{"accounts":[{"name":"test","provider":"codex","accountId":"testid-018b","email":"test@example.com","ownerHost":"castle","credPath":"unused"}]}
J
# Resolve credential-steward.js reproducibly: explicit path, else docker cp from the container.
if [ -n "$STEWARD_SRC" ] && [ -f "$STEWARD_SRC" ]; then
  cp "$STEWARD_SRC" "$TMP/credential-steward.js"
else
  docker cp "$CONTAINER:/home/bridge-peter/credential-steward.js" "$TMP/credential-steward.js" 2>/dev/null \
    || { echo "FATAL: could not obtain credential-steward.js (set STEWARD_SRC=<path> or ensure container '$CONTAINER' runs)"; exit 2; }
fi
cp "$D/bridge-server.js.instr" "$E2E_BRIDGE"

fps() { python3 - "$1" <<'PY' 2>/dev/null || echo "NA NA"
import json,sys,hashlib
t=json.load(open(sys.argv[1])).get("tokens",{})
f=lambda x: hashlib.sha256(x.encode()).hexdigest()[:16] if x else "none"
print(f(t.get("access_token","")), f(t.get("refresh_token","")))
PY
}
read A0 R0 <<<"$(fps "$TMP/.codex/auth.json")"
echo "seed access_fp=$A0 refresh_fp=$R0"

# Hold the test lane lock so every codex turn's flock -w 30 times out.
: > "$LOCK"
flock -w 0 "$LOCK" -c 'echo HELD; sleep 160' & HOLDER=$!
sleep 1
flock -w 0 "$LOCK" -c true 2>/dev/null && { echo "FATAL: holder failed"; exit 2; }
echo "holding $LOCK"

# Boot the isolated instrumented bridge (run from $D so node_modules + telemetry resolve).
cd "$D"
HOME="$TMP" BRIDGE_PORT=$PORT MCP_PORT=$MCP NOVNC_PORT=$NOVNC BASE_PATH= \
  CHAT_DB="$TMP/chat.json" CLAUDE_CWD="$TMP" CREDENTIAL_STEWARD_ENABLED=1 ENGINE=codex CLAUDE_TZ=UTC \
  nohup node "$E2E_BRIDGE" > "$BRIDGE_LOG" 2>&1 & BRIDGE_PID=$!
for i in $(seq 1 30); do ss -ltn 2>/dev/null | grep -q ":$PORT " && break; sleep 1; done
ss -ltn 2>/dev/null | grep -q ":$PORT " || { echo "FATAL: bridge did not listen; log:"; tail -30 "$BRIDGE_LOG"; exit 3; }
echo "bridge listening on :$PORT (pid $BRIDGE_PID)"

# Drive a real codex-led conference; wait through the full 3-attempt budget.
HOME="$TMP" node "$E2E_CLIENT" "$PORT" "$ROOM" 112000 | tee "$TMP/client-stdout.txt"
CLIENT_RC="${PIPESTATUS[0]}"
ws_pause=no; grep -q "WS_PAUSE_SEEN: yes" "$TMP/client-stdout.txt" && ws_pause=yes

read A1 R1 <<<"$(fps "$TMP/.codex/auth.json")"

# ---- assertions ----
CONF="$TMP/.claude/bridge-conference/${ROOM}.json"
ATT="$TMP/.credential-steward"/codex-attempts.*.jsonl
tele_close_transient=0
compgen -G "$ATT" >/dev/null && tele_close_transient=$(grep -h '"phase":"close"' $ATT 2>/dev/null | grep -c '"classification":"transient"' || true)
tele_spawn=0
compgen -G "$ATT" >/dev/null && tele_spawn=$(grep -hc '"phase":"spawn"' $ATT 2>/dev/null || true)
sr="?"; pr="?"; pause="no"
if [ -f "$CONF" ]; then
  grep -q '"spawnRetries":3' "$CONF" && sr=3 || sr="$(grep -o '"spawnRetries":[0-9]*' "$CONF" | tail -1)"
  grep -q '"pendingRetry":null' "$CONF" && pr=null || pr="set"
  grep -q "Could not obtain Codex credentials after 3 attempts" "$CONF" && pause="yes"
fi
acc_ok=no; [ "$A0" = "$A1" ] && acc_ok=yes
ref_ok=no; [ "$R0" = "$R1" ] && ref_ok=yes

PASS=no
[ "$tele_close_transient" -ge 3 ] && [ "$sr" = 3 ] && [ "$pr" = null ] && [ "$pause" = yes ] \
  && [ "$ws_pause" = yes ] && [ "$acc_ok" = yes ] && [ "$ref_ok" = yes ] && PASS=yes

# ---- Preserve a SANITIZED, non-secret result bundle BEFORE deleting $TMP ----
# All copied artifacts are non-secret: telemetry JSONL is redacted by the module
# (fingerprints only), conf JSON + bridge log carry no tokens. Raw evidence
# snapshots (which DO contain credential material) are NOT copied — only their
# metadata + sha256 are recorded.
mkdir -p "$BUNDLE"; chmod 700 "$RESULTS_ROOT" "$BUNDLE" 2>/dev/null
cp "$TMP/client-stdout.txt" "$BUNDLE/client-stdout.txt" 2>/dev/null
[ -f "$CONF" ] && cp "$CONF" "$BUNDLE/conference.json" 2>/dev/null
compgen -G "$ATT" >/dev/null && cat $ATT > "$BUNDLE/codex-attempts.jsonl" 2>/dev/null
tail -60 "$BRIDGE_LOG" > "$BUNDLE/bridge.log.tail" 2>/dev/null
# evidence-file metadata + hashes (NOT contents)
: > "$BUNDLE/evidence-manifest.txt"
if [ -d "$TMP/.credential-steward/codex-evidence" ]; then
  for f in "$TMP/.credential-steward/codex-evidence"/*; do
    [ -f "$f" ] && printf '%s  size=%s  %s\n' "$(sha256sum "$f" | cut -d" " -f1)" "$(stat -c%s "$f")" "$(basename "$f")" >> "$BUNDLE/evidence-manifest.txt"
  done
fi
# staged-artifact + result hashes -> manifest.json
sha() { [ -f "$1" ] && sha256sum "$1" | cut -d' ' -f1 || echo missing; }
cat > "$BUNDLE/manifest.json" <<M
{
  "ts": "$(date -Is)", "container": "$CONTAINER", "room": "$ROOM", "port": $PORT,
  "result": { "pass": "$PASS", "telemetry_spawn": $tele_spawn, "telemetry_close_transient": $tele_close_transient,
              "conf_spawnRetries": "$sr", "conf_pendingRetry": "$pr", "conf_pause_message": "$pause",
              "ws_pause_observed": "$ws_pause", "access_token_unchanged": "$acc_ok", "refresh_token_unchanged": "$ref_ok" },
  "tokens": { "access_fp_before": "$A0", "access_fp_after": "$A1", "refresh_fp_before": "$R0", "refresh_fp_after": "$R1" },
  "artifact_sha256": {
    "bridge-server.js.instr": "$(sha "$D/bridge-server.js.instr")",
    "codex-cred-telemetry.js": "$(sha "$D/codex-cred-telemetry.js")",
    "patch-codex-cred-instr.cjs": "$(sha "$D/patch-codex-cred-instr.cjs")",
    "e2e-isolated-bridge.sh": "$(sha "$D/e2e-isolated-bridge.sh")",
    "e2e-client.js": "$(sha "$D/e2e-client.js")"
  }
}
M
chmod -R go-rwx "$BUNDLE" 2>/dev/null

echo "=== RESULT ==="
echo "telemetry spawn records:            $tele_spawn"
echo "telemetry close transient records:  $tele_close_transient"
echo "conf spawnRetries:                  $sr"
echo "conf pendingRetry:                  $pr"
echo "conf persisted pause message:       $pause"
echo "ws-observed exact pause:            $ws_pause"
echo "access_token_unchanged:             $acc_ok"
echo "refresh_token_unchanged:            $ref_ok"
echo "result bundle (0700):               $BUNDLE"
echo "--- sample telemetry close records ---"
compgen -G "$ATT" >/dev/null && grep -h '"phase":"close"' $ATT 2>/dev/null | head -1
if [ "$PASS" = yes ]; then
  echo "E2E-ISOLATED: PASS — real FSM produced the exact pause (WS + persisted) + 3 transient telemetry records; no rotation."
  rm -rf "$TMP"; exit 0
else
  echo "E2E-ISOLATED: FAIL (bundle retained at $BUNDLE; live $TMP kept for debug)"; exit 1
fi
