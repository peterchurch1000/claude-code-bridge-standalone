#!/bin/bash
# Relaunch ONLY the per-user bridge-server watchdog loops (browser stacks are
# left untouched). Mirrors the bridge-server section of start.sh. Used to restore
# the bridge servers without a full container restart.
SCRIPT_DIR=/var/www/html/claude-code-bridge-standalone
LOG_DIR="$SCRIPT_DIR/logs"

# Format: linux_user:display:novnc_port:mcp_port:bridge_port:base_path
declare -a USERS=(
  "bridge-peter:31:6093:8941:3467:/peter"
  "bridge-roy:32:6094:8942:3468:/roy"
  "bridge-john:33:6095:8943:3470:/john"
)

for ENTRY in "${USERS[@]}"; do
  IFS=: read -r LUSER DN NP MP BP BASE <<< "$ENTRY"
  UHOME="/home/$LUSER"
  ULOG="$LOG_DIR/$LUSER"
  (
    while true; do
      fuser -k "${BP}/tcp" 2>/dev/null && sleep 1
      ( cd "$SCRIPT_DIR" && env \
          HOME="$UHOME" DISPLAY_NUM="$DN" BRIDGE_PORT="$BP" NOVNC_PORT="$NP" MCP_PORT="$MP" \
          CLAUDE_CWD=/var/www/castle-sistema BASE_PATH="$BASE" CHAT_DB="$UHOME/chat.db" \
          NOVNC_URL="https://claude-bridge.castle-global.com$BASE/vnc" \
          CLAUDE_TZ=America/Argentina/Buenos_Aires \
          node bridge-server.js ) >> "$ULOG/bridge.log" 2>&1
      echo "[watchdog:$LUSER] Bridge server exited, restarting in 3s..." >> "$ULOG/bridge.log"
      sleep 3
    done
  ) &
  echo "[relaunch] $LUSER watchdog started on port $BP (pid $!)"
done
