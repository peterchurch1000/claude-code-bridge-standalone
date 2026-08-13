#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Self-healing health monitor for the multi-user Claude Code Bridge.
#
# Runs from HOST cron once a minute (docker exec). For each user it checks the
# Live-Browser stack (noVNC port) and the chat bridge (bridge port); if either
# has been DOWN for >=FAIL_THRESHOLD consecutive checks it relaunches ONLY that
# user's watchdog, leaving every healthy stack untouched.
#
# Why this exists: the per-user watchdog subshells spawned by start.sh are
# themselves unsupervised — if one dies (OOM, stray pkill/fuser, signal) nothing
# restarts it and that user's Live Browser stays dead. This monitor supervises
# the watchdogs from outside, and is itself re-run every minute by cron, so it
# cannot share their fate.
#
# Duplicate-safe (see project_castle_bridge memory):
#   * watchdogs launched here carry a unique marker in their argv
#     (ccbmon-browser-<user> / ccbmon-bridge-<user>); a relaunch is skipped if a
#     marked watchdog for that user already exists -> never two fighting a port.
#   * FAIL_THRESHOLD debounce means a healthy watchdog mid-restart (port back in
#     ~5s) is never mistaken for a dead one (only acts after ~2 min down).
#   * start-browser.sh self-cleans stale X-locks/ports, so relaunch can't collide.
# ─────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR=/var/www/html/claude-code-bridge-standalone
LOG_DIR="$SCRIPT_DIR/logs"
NOVNC_WEB=/usr/share/novnc
CLAUDE_CWD=/var/www/castle-sistema
STATE_DIR=/tmp/ccbmon
FAIL_THRESHOLD=2          # consecutive down-checks before relaunch (~min, at 1/min cron)
MONLOG="$LOG_DIR/monitor.log"

mkdir -p "$STATE_DIR" "$LOG_DIR"

# Format: linux_user:display:vnc_port:novnc_port:cdp_port:mcp_port:bridge_port:base_path
declare -a USERS=(
  "bridge-peter:31:5931:6093:9231:8941:3467:/peter"
  "bridge-roy:32:5932:6094:9232:8942:3468:/roy"
  "bridge-john:33:5933:6095:9233:8943:3470:/john"
)

log(){ echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$MONLOG"; }
listening(){ (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":$1 "; }

# bump <statefile> -> echoes the new consecutive-failure count
bump(){ local f="$1" n; n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$f"; echo "$n"; }

launch_browser(){   # $1=luser  rest via positional below
  local LUSER="$1" DN="$2" VNC="$3" NOVNC="$4" CDP="$5" MCP="$6"
  local UHOME="/home/$LUSER" ULOG="$LOG_DIR/$LUSER"
  setsid bash -c '
    # MARKER=ccbmon-browser-'"$LUSER"'
    export DISPLAY_NUM=":'"$DN"'" VNC_PORT="'"$VNC"'" NOVNC_PORT="'"$NOVNC"'" \
           CDP_PORT="'"$CDP"'" MCP_PORT="'"$MCP"'" \
           CHROME_PROFILE_DIR="'"$UHOME"'/.claude/chromium-bridge-profile" \
           LOG_DIR="'"$ULOG"'" NOVNC_WEB="'"$NOVNC_WEB"'" HOME="'"$UHOME"'"
    mkdir -p "$LOG_DIR"
    while true; do
      bash "'"$SCRIPT_DIR"'/start-browser.sh" > "$LOG_DIR/browser.log" 2>&1
      echo "[ccbmon-browser:'"$LUSER"'] browser stack exited, restarting in 5s..." >> "$LOG_DIR/browser.log"
      sleep 5
    done
  ' ccbmon-browser-"$LUSER" >/dev/null 2>&1 < /dev/null &
}

launch_bridge(){   # $1=luser $2=display $3=novnc $4=mcp $5=bridge $6=base
  local LUSER="$1" DN="$2" NP="$3" MP="$4" BP="$5" BASE="$6"
  local UHOME="/home/$LUSER" ULOG="$LOG_DIR/$LUSER"
  setsid bash -c '
    # MARKER=ccbmon-bridge-'"$LUSER"'
    while true; do
      fuser -k "'"$BP"'/tcp" 2>/dev/null && sleep 1
      ( cd "'"$SCRIPT_DIR"'" && env \
          HOME="'"$UHOME"'" DISPLAY_NUM="'"$DN"'" BRIDGE_PORT="'"$BP"'" NOVNC_PORT="'"$NP"'" MCP_PORT="'"$MP"'" \
          CLAUDE_CWD="'"$CLAUDE_CWD"'" BASE_PATH="'"$BASE"'" CHAT_DB="'"$UHOME"'/chat.db" \
          NOVNC_URL="https://claude-bridge.castle-global.com'"$BASE"'/vnc" \
          CLAUDE_TZ=America/Argentina/Buenos_Aires \
          node bridge-server.js ) >> "'"$ULOG"'/bridge.log" 2>&1
      echo "[ccbmon-bridge:'"$LUSER"'] bridge exited, restarting in 3s..." >> "'"$ULOG"'/bridge.log"
      sleep 3
    done
  ' ccbmon-bridge-"$LUSER" >/dev/null 2>&1 < /dev/null &
}

for ENTRY in "${USERS[@]}"; do
  IFS=: read -r LUSER DN VNC NOVNC CDP MCP BRIDGE BASE <<< "$ENTRY"
  BFAIL="$STATE_DIR/$LUSER.browser"
  RFAIL="$STATE_DIR/$LUSER.bridge"

  # ── Browser / Live-View stack (noVNC websockify port) ──
  if listening "$NOVNC"; then
    echo 0 > "$BFAIL"
  else
    n=$(bump "$BFAIL")
    if [ "$n" -ge "$FAIL_THRESHOLD" ]; then
      if pgrep -f "ccbmon-browser-$LUSER" >/dev/null; then
        log "$LUSER browser down ($n) but a ccbmon-browser watchdog already exists — waiting, no relaunch"
      else
        log "$LUSER browser DOWN for $n checks — relaunching browser watchdog (display :$DN, noVNC $NOVNC)"
        launch_browser "$LUSER" "$DN" "$VNC" "$NOVNC" "$CDP" "$MCP"
        echo 0 > "$BFAIL"
      fi
    fi
  fi

  # ── Chat bridge (WebSocket/HTTP bridge port) ──
  if listening "$BRIDGE"; then
    echo 0 > "$RFAIL"
  else
    n=$(bump "$RFAIL")
    if [ "$n" -ge "$FAIL_THRESHOLD" ]; then
      if pgrep -f "ccbmon-bridge-$LUSER" >/dev/null; then
        log "$LUSER bridge down ($n) but a ccbmon-bridge watchdog already exists — waiting, no relaunch"
      else
        log "$LUSER bridge DOWN for $n checks — relaunching bridge watchdog (port $BRIDGE)"
        launch_bridge "$LUSER" "$DN" "$NOVNC" "$MCP" "$BRIDGE" "$BASE"
        echo 0 > "$RFAIL"
      fi
    fi
  fi
done
