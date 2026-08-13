#!/bin/bash
# Multi-user Claude Code Bridge launcher — AdLux Instance 3 (claude-bridge-standalone).
# Mirrors Castle Instance 6: independent bridge stacks with isolated X displays, ports, homes.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
NOVNC_WEB="${NOVNC_WEB:-/usr/share/novnc}"
DOMAIN="${BRIDGE_DOMAIN:-claude-bridge-standalone.procyss-automation.com}"
CLAUDE_TZ="${CLAUDE_TZ:-Pacific/Auckland}"
mkdir -p "$LOG_DIR"

# Free bridge ports from any previous run
fuser -k 3467/tcp 3470/tcp 3471/tcp 3472/tcp 2>/dev/null || true

# Format: "linux_user:display:vnc_port:novnc_port:cdp_port:mcp_port:bridge_port:base_path"
declare -a USERS=(
  "matthew:31:5931:6093:9231:8941:3467:/matthew"
  "bryce:32:5932:6094:9232:8942:3470:/bryce"
  "tamara:33:5933:6095:9233:8943:3471:/tamara"
  "mae:34:5934:6096:9234:8944:3472:/mae"
)

ALL_PIDS=()

echo "[start] Starting browser stacks..."
for ENTRY in "${USERS[@]}"; do
  IFS=: read -r LUSER DISPLAY_NUM VNC_PORT NOVNC_PORT CDP_PORT MCP_PORT BRIDGE_PORT BASE_PATH <<< "$ENTRY"
  UHOME="/home/${LUSER}"
  CHROME_PROFILE_DIR="${UHOME}/.claude/chromium-bridge-profile"
  ULOG_DIR="${LOG_DIR}/${LUSER}"
  mkdir -p "$ULOG_DIR"; chown "${LUSER}:${LUSER}" "$ULOG_DIR" 2>/dev/null || true
  (
    set +e
    export DISPLAY_NUM=":$DISPLAY_NUM"
    export VNC_PORT="$VNC_PORT" NOVNC_PORT="$NOVNC_PORT" CDP_PORT="$CDP_PORT" MCP_PORT="$MCP_PORT"
    export CHROME_PROFILE_DIR="$CHROME_PROFILE_DIR" LOG_DIR="$ULOG_DIR" NOVNC_WEB="$NOVNC_WEB" HOME="$UHOME"
    while true; do
      bash "$SCRIPT_DIR/start-browser.sh" > "$ULOG_DIR/browser.log" 2>&1
      echo "[watchdog:${LUSER}] Browser stack exited, restarting in 5s..." >> "$ULOG_DIR/browser.log"
      sleep 5
    done
  ) &
  ALL_PIDS+=($!)
  echo "[start] Browser watchdog for ${LUSER} started (PID $!)"
done

echo "[start] Waiting 12s for browser stacks..."
sleep 12

echo "[start] Starting bridge servers..."
for ENTRY in "${USERS[@]}"; do
  IFS=: read -r LUSER DISPLAY_NUM VNC_PORT NOVNC_PORT CDP_PORT MCP_PORT BRIDGE_PORT BASE_PATH <<< "$ENTRY"
  UHOME="/home/${LUSER}"; ULOG_DIR="${LOG_DIR}/${LUSER}"
  CHAT_DB="${UHOME}/.claude/bridge-chat.json"
  BRIDGE_ENV="HOME=${UHOME}"
  BRIDGE_ENV="${BRIDGE_ENV} DISPLAY_NUM=${DISPLAY_NUM}"
  BRIDGE_ENV="${BRIDGE_ENV} BRIDGE_PORT=${BRIDGE_PORT}"
  BRIDGE_ENV="${BRIDGE_ENV} NOVNC_PORT=${NOVNC_PORT}"
  BRIDGE_ENV="${BRIDGE_ENV} MCP_PORT=${MCP_PORT}"
  BRIDGE_ENV="${BRIDGE_ENV} CLAUDE_CWD=${UHOME}"
  BRIDGE_ENV="${BRIDGE_ENV} BASE_PATH=${BASE_PATH}"
  BRIDGE_ENV="${BRIDGE_ENV} CHAT_DB=${CHAT_DB}"
  BRIDGE_ENV="${BRIDGE_ENV} NOVNC_URL=https://${DOMAIN}${BASE_PATH}/vnc"
  BRIDGE_ENV="${BRIDGE_ENV} CLAUDE_TZ=${CLAUDE_TZ}"
  (
    set +e
    while true; do
      fuser -k "${BRIDGE_PORT}/tcp" 2>/dev/null && sleep 1
      su -s /bin/bash "${LUSER}" -c "cd ${SCRIPT_DIR} && exec env ${BRIDGE_ENV} node bridge-server.js >> ${ULOG_DIR}/bridge.log 2>&1"
      echo "[watchdog:${LUSER}] Bridge server exited, restarting in 3s..." >> "${ULOG_DIR}/bridge.log"
      sleep 3
    done
  ) &
  ALL_PIDS+=($!)
  echo "[start] Bridge watchdog for ${LUSER} started on port ${BRIDGE_PORT} (PID $!)"
done

echo "✅ All user stacks running (matthew:3467 bryce:3470 tamara:3471 mae:3472)"
cleanup(){ echo "[start] Shutting down..."; kill "${ALL_PIDS[@]}" 2>/dev/null || true; }
trap cleanup EXIT SIGTERM SIGINT
wait "${ALL_PIDS[@]}"
