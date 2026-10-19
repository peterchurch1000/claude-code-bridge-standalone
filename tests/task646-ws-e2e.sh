#!/usr/bin/env bash
# [TASK646H] In-container isolated-bridge WS E2E with draft- keys (representative of
# real new rooms, so draft->session promotion fires). Non-destructive; own temp HOME + port.
set -uo pipefail
# Resolve the live bridge dir from either the container path or the host bind-mount path.
D=""
for c in /var/www/html/claude-code-bridge-standalone /var/www/castle-container/claude-code-bridge-standalone; do
  [ -f "$c/bridge-server.js" ] && { D="$c"; break; }
done
[ -n "$D" ] || { echo "NO bridge-server.js found"; exit 8; }
# This script and its siblings (stub, e2e client) live next to it; resolve T to its own dir.
T="$(cd "$(dirname "$0")" && pwd)"
TH=$(mktemp -d /tmp/t646-ws.XXXXXX)
mkdir -p "$TH/.claude" "$TH/bin"
echo claude > "$TH/.claude/engine"; echo tok > "$TH/.claude/bridge-oauth-token"
echo complete > "$TH/stub-mode"; echo 0 > "$TH/stub-count"
cp "$T/task646-stub-claude.js" "$TH/bin/claude"; chmod +x "$TH/bin/claude"
sed -i '1s|.*|#!/usr/bin/env node|' "$TH/bin/claude"
# free the port if a prior run lingers (kill by matching our own node on 3999)
pkill -f 'BRIDGE_PORT=3999' 2>/dev/null || true; sleep 1
PATH="$TH/bin:$PATH" HOME="$TH" BRIDGE_PORT=3999 MCP_PORT=8999 NOVNC_PORT=6999 BASE_PATH=/peter \
  CLAUDE_CWD="$TH" DURABLE_SEND=1 RESUME_TURNS=1 CLAUDE_TIMEOUT_MS=4000 CREDENTIAL_STEWARD_ENABLED=0 \
  STUB_MODE_FILE="$TH/stub-mode" STUB_COUNT_FILE="$TH/stub-count" \
  CHAT_DB="$TH/.claude/bridge-chat.json" node "$D/bridge-server.js" > "$TH/bridge.log" 2>&1 &
BP=$!
up=0
for i in $(seq 1 25); do sleep 1; curl -s -o /dev/null --max-time 2 http://127.0.0.1:3999/ && { up=1; break; }; kill -0 $BP 2>/dev/null||{ echo "BRIDGE DIED"; sed -n '1,40p' "$TH/bridge.log"; break; }; done
[ "$up" = 1 ] || { echo "BRIDGE NOT UP"; sed -n '1,40p' "$TH/bridge.log"; kill $BP 2>/dev/null; rm -rf "$TH"; exit 9; }
HOME="$TH" WS_MODULE="$D/node_modules/ws" WSD="ws://127.0.0.1:3999/ws" \
  STUB_MODE_FILE="$TH/stub-mode" STUB_COUNT_FILE="$TH/stub-count" node "$T/task646-ws-e2e.js"
RC=$?
echo "--- bridge.log tail (stall/fail/kill/promote lines) ---"
grep -iE 'watchdog|fail|kill|promote|rekey|drift|stall|durable_send' "$TH/bridge.log" | tail -20 || true
kill $BP 2>/dev/null||true; pkill -f 'BRIDGE_PORT=3999' 2>/dev/null||true; rm -rf "$TH"
exit $RC
