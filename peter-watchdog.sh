#!/bin/bash
set +e
SCRIPT_DIR=/var/www/html/claude-code-bridge-standalone
export DISPLAY_NUM=":31" VNC_PORT=5931 NOVNC_PORT=6093 CDP_PORT=9231 MCP_PORT=8941
export CHROME_PROFILE_DIR=/home/bridge-peter/.claude/chromium-bridge-profile
export LOG_DIR=$SCRIPT_DIR/logs/bridge-peter
export NOVNC_WEB=/usr/share/novnc HOME=/home/bridge-peter
while true; do
  rm -f "$CHROME_PROFILE_DIR"/Singleton* 2>/dev/null
  setsid bash "$SCRIPT_DIR/start-browser.sh" > "$LOG_DIR/browser.log" 2>&1
  echo "[watchdog:bridge-peter] stack exited, restart in 5s" >> "$LOG_DIR/browser.log"
  sleep 5
done
