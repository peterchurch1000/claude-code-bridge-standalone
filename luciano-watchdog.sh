#!/bin/bash
set +e
SCRIPT_DIR=/var/www/html/claude-code-bridge-standalone
export DISPLAY_NUM=":34" VNC_PORT=5934 NOVNC_PORT=6096 CDP_PORT=9234 MCP_PORT=8944
export CHROME_PROFILE_DIR=/home/bridge-luciano/.claude/chromium-bridge-profile
export LOG_DIR=$SCRIPT_DIR/logs/bridge-luciano
export NOVNC_WEB=/usr/share/novnc HOME=/home/bridge-luciano
mkdir -p $LOG_DIR
while true; do
  rm -f "$CHROME_PROFILE_DIR"/Singleton* 2>/dev/null
  setsid bash "$SCRIPT_DIR/start-browser.sh" > "$LOG_DIR/browser.log" 2>&1
  echo "[watchdog:bridge-luciano] stack exited, restart in 5s" >> "$LOG_DIR/browser.log"
  sleep 5
done
