#!/bin/bash
# Stop the on-demand Peter test browser stack (display :41).
pkill -f "Xvfb :41 " 2>/dev/null || true
pkill -f "x11vnc.*rfbport 5941" 2>/dev/null || true
pkill -f "websockify.*6193" 2>/dev/null || true
fuser -k 8951/tcp 2>/dev/null || true
fuser -k 9241/tcp 2>/dev/null || true
pkill -f "chromium-test-profile" 2>/dev/null || true
pkill -f "start-test-browser.sh" 2>/dev/null || true
rm -f /tmp/.X41-lock /tmp/.X11-unix/X41 2>/dev/null || true
echo "[test-browser] stopped."
