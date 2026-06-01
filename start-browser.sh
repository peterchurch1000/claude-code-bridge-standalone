#!/bin/bash
# Starts the isolated virtual display + VNC + noVNC stack for the Claude Code Bridge.
# Uses display :31, x11vnc 5931, websockify 6093 — all separate from the existing setup.
#
# Architecture:
#   Chrome runs as its own persistent process (CDP port 9231).
#   Playwright MCP connects to that Chrome via --cdp-endpoint, so Chrome stays alive
#   even when Claude CLI processes start and stop between messages.
set -e

DISPLAY_NUM="${DISPLAY_NUM:-:31}"
VNC_PORT="${VNC_PORT:-5931}"
NOVNC_PORT="${NOVNC_PORT:-6093}"
NOVNC_WEB="${NOVNC_WEB:-/usr/share/novnc}"
MCP_PORT="${MCP_PORT:-8941}"
CDP_PORT="${CDP_PORT:-9231}"
CHROME_PROFILE_DIR="${CHROME_PROFILE_DIR:-/root/.config/chromium-bridge-profile}"
LOG_DIR="${LOG_DIR:-$(dirname "$0")/logs}"

mkdir -p "$LOG_DIR"

# Kill any leftover processes from a previous run
pkill -f "Xvfb $DISPLAY_NUM " 2>/dev/null || true
DISPLAY_NUM_CLEAN="${DISPLAY_NUM#:}"
rm -f "/tmp/.X${DISPLAY_NUM_CLEAN}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM_CLEAN}" 2>/dev/null || true
pkill -f "x11vnc.*rfbport $VNC_PORT" 2>/dev/null || true
pkill -f "websockify.*$NOVNC_PORT" 2>/dev/null || true
fuser -k ${MCP_PORT}/tcp 2>/dev/null || true
fuser -k ${CDP_PORT}/tcp 2>/dev/null || true
pkill -f "$CHROME_PROFILE_DIR" 2>/dev/null || true
sleep 1

echo "[browser] Starting Xvfb $DISPLAY_NUM ..."
Xvfb $DISPLAY_NUM -screen 0 1920x1080x24 -ac +extension GLX +render -noreset \
  > "$LOG_DIR/xvfb.log" 2>&1 &
XVFB_PID=$!
sleep 1.5

if command -v xfwm4 &>/dev/null; then
  echo "[browser] Starting window manager (xfwm4) ..."
  DISPLAY=$DISPLAY_NUM xfwm4 > "$LOG_DIR/xfwm4.log" 2>&1 &
  XFWM_PID=$!
  sleep 0.5
else
  echo "[browser] xfwm4 not installed, skipping window manager (Chrome works without it)"
  XFWM_PID=""
fi

echo "[browser] Starting x11vnc on port $VNC_PORT ..."
x11vnc -display $DISPLAY_NUM -nopw -forever -shared -rfbport $VNC_PORT \
  -noxdamage -localhost -repeat -noxrecord \
  -o "$LOG_DIR/x11vnc.log" &
X11VNC_PID=$!
sleep 1

echo "[browser] Starting websockify/noVNC on port $NOVNC_PORT ..."
websockify --web="$NOVNC_WEB" $NOVNC_PORT localhost:$VNC_PORT \
  > "$LOG_DIR/websockify.log" 2>&1 &
NOVNC_PID=$!
sleep 1

echo "[browser] Starting persistent Chrome on CDP port $CDP_PORT ..."
DISPLAY=$DISPLAY_NUM /opt/google/chrome/chrome \
  --no-sandbox \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions \
  --disable-background-networking \
  --disable-sync \
  --disable-translate \
  --disable-gpu \
  --disable-gpu-compositing \
  --disable-gpu-sandbox \
  --disable-software-rasterizer \
  --enable-unsafe-swiftshader \
  --use-gl=swiftshader \
  --remote-debugging-port=$CDP_PORT \
  --user-data-dir="$CHROME_PROFILE_DIR" \
  --profile-directory=Default \
  --window-size=1920,1080 \
  --window-position=0,0 \
  about:blank \
  > "$LOG_DIR/chrome.log" 2>&1 &
CHROME_PID=$!
sleep 3
# Ensure Chrome is positioned at 0,0 (profile may override window-position)
CHROME_WIN=$(DISPLAY=$DISPLAY_NUM xdotool search --onlyvisible --class "Chrome" 2>/dev/null | head -1)
if [ -n "$CHROME_WIN" ]; then
  DISPLAY=$DISPLAY_NUM xdotool windowmove "$CHROME_WIN" 0 0
fi

echo "[browser] Starting Playwright MCP SSE server on port $MCP_PORT ..."
DISPLAY=$DISPLAY_NUM npx @playwright/mcp@latest \
  --cdp-endpoint http://localhost:$CDP_PORT \
  --shared-browser-context \
  --host 0.0.0.0 \
  --port $MCP_PORT \
  > "$LOG_DIR/playwright-mcp.log" 2>&1 &
MCP_PID=$!
sleep 2

echo ""
echo "✅ Browser environment ready"
echo "   Display:   $DISPLAY_NUM"
echo "   Chrome:    CDP port $CDP_PORT (PID $CHROME_PID)"
echo "   MCP SSE:   http://localhost:$MCP_PORT/sse"
echo "   noVNC:     http://localhost:$NOVNC_PORT/vnc_auto.html"
echo "   PIDs:      Xvfb=$XVFB_PID xfwm4=${XFWM_PID:-n/a} x11vnc=$X11VNC_PID websockify=$NOVNC_PID MCP=$MCP_PID Chrome=$CHROME_PID"
echo ""

# Trap cleanup
cleanup() {
  echo "[browser] Shutting down..."
  kill $XVFB_PID ${XFWM_PID:-} $X11VNC_PID $NOVNC_PID $MCP_PID $CHROME_PID 2>/dev/null || true
}
trap cleanup EXIT SIGTERM SIGINT

# Monitor critical processes; exit (triggering watchdog restart) if any die
while true; do
  sleep 10
  for pid in $XVFB_PID $CHROME_PID $MCP_PID; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[browser] Process $pid died, triggering restart..."
      exit 1
    fi
  done
done
