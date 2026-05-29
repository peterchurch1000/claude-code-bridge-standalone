#!/bin/bash
# Pull latest bridge code from GitHub and restart the service.
# Run as: bash update.sh
# Local data (Chrome profiles, logs, .mcp.json, working files) is never touched.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE="${SERVICE:-claude-bridge-standalone.service}"

echo "=== Claude Code Bridge — Update ==="
echo "  Directory: $SCRIPT_DIR"
echo "  Service:   $SERVICE"
echo ""

cd "$SCRIPT_DIR"

echo "[1/3] Pulling latest code from GitHub..."
git pull origin master

echo "[2/3] Installing/updating Node dependencies..."
npm install --production --silent

echo "[3/3] Restarting service..."
systemctl restart "$SERVICE"
sleep 2
systemctl is-active "$SERVICE" && echo "✅ $SERVICE restarted successfully." || echo "⚠ $SERVICE may not have started — check: journalctl -u $SERVICE -n 30"
