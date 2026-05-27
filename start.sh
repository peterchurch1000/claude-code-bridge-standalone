#!/bin/bash
# Master launcher for the Claude Code Bridge instance.
# Starts the VNC stack, then the bridge server.
# Run this from /root/claude-code-bridge or as a systemd service.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export DISPLAY_NUM="${DISPLAY_NUM:-:31}"
export VNC_PORT="${VNC_PORT:-5931}"
export NOVNC_PORT="${NOVNC_PORT:-6093}"
export BRIDGE_PORT="${BRIDGE_PORT:-3467}"
export NOVNC_URL="${NOVNC_URL:-https://claude-bridge.procyss-automation.com/vnc}"
export CLAUDE_CWD="${CLAUDE_CWD:-$SCRIPT_DIR}"
export LOG_DIR="$SCRIPT_DIR/logs"

mkdir -p "$LOG_DIR"

# Kill any orphaned bridge server from a previous run
fuser -k ${BRIDGE_PORT}/tcp 2>/dev/null || true

echo "=== Claude Code Bridge ==="
echo "  Bridge server: http://0.0.0.0:$BRIDGE_PORT"
echo "  noVNC URL:     $NOVNC_URL"
echo "  Display:       $DISPLAY_NUM"
echo ""

# ── Start browser environment ──
bash "$SCRIPT_DIR/start-browser.sh" > "$LOG_DIR/browser.log" 2>&1 &
BROWSER_PID=$!
echo "[start] Browser stack started (PID $BROWSER_PID), waiting 4s..."
sleep 4

# ── Start bridge server ──
cd "$SCRIPT_DIR"
node bridge-server.js > "$LOG_DIR/bridge.log" 2>&1 &
BRIDGE_PID=$!
echo "[start] Bridge server started (PID $BRIDGE_PID)"

echo ""
echo "🚀 All services running. Logs in $LOG_DIR/"
echo "   Press Ctrl+C to stop everything."

cleanup() {
  echo "[start] Shutting down..."
  kill $BROWSER_PID $BRIDGE_PID 2>/dev/null || true
}
trap cleanup EXIT SIGTERM SIGINT

wait $BRIDGE_PID
