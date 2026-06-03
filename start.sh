#!/bin/bash
# Multi-user Claude Code Bridge launcher.
# Starts three independent bridge stacks (peter, roy, john) with isolated X displays, ports, and home directories.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
NOVNC_WEB="${NOVNC_WEB:-/usr/share/novnc}"
CLAUDE_CWD="${CLAUDE_CWD:-/var/www/castle-sistema}"

mkdir -p "$LOG_DIR"

# Kill any previously running bridge ports
fuser -k 3467/tcp 3468/tcp 3470/tcp 2>/dev/null || true

echo "=== Claude Code Bridge (Multi-User) ==="
echo ""

# ── User configuration table ──────────────────────────────────────────────────
# Format: "linux_user:display:vnc_port:novnc_port:cdp_port:mcp_port:bridge_port:base_path:api_key_env"
declare -a USERS=(
  "bridge-peter:31:5931:6093:9231:8941:3467:/peter:ANTHROPIC_API_KEY_PETER"
  "bridge-roy:32:5932:6094:9232:8942:3468:/roy:ANTHROPIC_API_KEY_ROY"
  "bridge-john:33:5933:6095:9233:8943:3470:/john:ANTHROPIC_API_KEY_JOHN"
)

ALL_PIDS=()

echo "[start] Starting browser stacks..."
for ENTRY in "${USERS[@]}"; do
  IFS=: read -r LUSER DISPLAY_NUM VNC_PORT NOVNC_PORT CDP_PORT MCP_PORT BRIDGE_PORT BASE_PATH API_KEY_ENV <<< "$ENTRY"
  API_KEY="${!API_KEY_ENV}"

  echo "[start] Initializing $LUSER (display :$DISPLAY_NUM, bridge port $BRIDGE_PORT)..."

  UHOME="/home/${LUSER}"
  CHROME_PROFILE_DIR="${UHOME}/.config/chromium-bridge-profile"
  ULOG_DIR="${LOG_DIR}/${LUSER}"
  mkdir -p "$ULOG_DIR"
  chown "${LUSER}:${LUSER}" "$ULOG_DIR" 2>/dev/null || true

  # ── Browser+VNC watchdog (runs as root, sets DISPLAY/etc. env, starts Xvfb/Chrome as children) ──
  (
    export DISPLAY_NUM=":$DISPLAY_NUM"
    export VNC_PORT="$VNC_PORT"
    export NOVNC_PORT="$NOVNC_PORT"
    export CDP_PORT="$CDP_PORT"
    export MCP_PORT="$MCP_PORT"
    export CHROME_PROFILE_DIR="$CHROME_PROFILE_DIR"
    export LOG_DIR="$ULOG_DIR"
    export NOVNC_WEB="$NOVNC_WEB"
    export HOME="$UHOME"

    while true; do
      bash "$SCRIPT_DIR/start-browser.sh" > "$ULOG_DIR/browser.log" 2>&1
      echo "[watchdog:${LUSER}] Browser stack exited, restarting in 5s..." >> "$ULOG_DIR/browser.log"
      sleep 5
    done
  ) &
  ALL_PIDS+=($!)

  echo "[start] Browser watchdog for ${LUSER} started (PID $!)"
done

echo "[start] Waiting 12s for browser stacks to initialize..."
sleep 12

echo "[start] Starting bridge servers..."
for ENTRY in "${USERS[@]}"; do
  IFS=: read -r LUSER DISPLAY_NUM VNC_PORT NOVNC_PORT CDP_PORT MCP_PORT BRIDGE_PORT BASE_PATH API_KEY_ENV <<< "$ENTRY"
  API_KEY="${!API_KEY_ENV}"
  UHOME="/home/${LUSER}"
  ULOG_DIR="${LOG_DIR}/${LUSER}"
  CHAT_DB="${UHOME}/chat.db"

  # Build env string for bridge process
  BRIDGE_ENV="HOME=${UHOME}"
  BRIDGE_ENV="${BRIDGE_ENV} DISPLAY_NUM=${DISPLAY_NUM}"
  BRIDGE_ENV="${BRIDGE_ENV} BRIDGE_PORT=${BRIDGE_PORT}"
  BRIDGE_ENV="${BRIDGE_ENV} NOVNC_PORT=${NOVNC_PORT}"
  BRIDGE_ENV="${BRIDGE_ENV} MCP_PORT=${MCP_PORT}"
  BRIDGE_ENV="${BRIDGE_ENV} CLAUDE_CWD=${CLAUDE_CWD}"
  BRIDGE_ENV="${BRIDGE_ENV} BASE_PATH=${BASE_PATH}"
  BRIDGE_ENV="${BRIDGE_ENV} CHAT_DB=${CHAT_DB}"
  BRIDGE_ENV="${BRIDGE_ENV} ANTHROPIC_API_KEY=${API_KEY}"
  BRIDGE_ENV="${BRIDGE_ENV} NOVNC_URL=https://claude-bridge.castle-global.com${BASE_PATH}/vnc"
  BRIDGE_ENV="${BRIDGE_ENV} CLAUDE_TZ=America/Argentina/Buenos_Aires"

  # ── Bridge server watchdog (restarts the node process if it ever exits) ──
  (
    while true; do
      # Free the port first so a relaunch can never collide with a stale/orphaned
      # node still holding it (avoids EADDRINUSE crash loops).
      fuser -k "${BRIDGE_PORT}/tcp" 2>/dev/null && sleep 1
      bash -c "cd ${SCRIPT_DIR} && exec env ${BRIDGE_ENV} node bridge-server.js >> ${ULOG_DIR}/bridge.log 2>&1"
      echo "[watchdog:${LUSER}] Bridge server exited, restarting in 3s..." >> "${ULOG_DIR}/bridge.log"
      sleep 3
    done
  ) &
  ALL_PIDS+=($!)
  echo "[start] Bridge watchdog for ${LUSER} started on port ${BRIDGE_PORT} (PID $!)"
done

echo ""
echo "✅ All user stacks running"
echo "   Peter Church (peter):  http://0.0.0.0:3467"
echo "   Roy James (roy):       http://0.0.0.0:3468"
echo "   John Pollard (john):   http://0.0.0.0:3470"
echo "   Logs:                  $LOG_DIR/"
echo ""

cleanup() {
  echo "[start] Shutting down all user stacks..."
  kill "${ALL_PIDS[@]}" 2>/dev/null || true
}
trap cleanup EXIT SIGTERM SIGINT

wait "${ALL_PIDS[@]}"
