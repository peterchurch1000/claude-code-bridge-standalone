#!/usr/bin/env bash
# Install the Codex browser CLI. bridge-server.js (_runCodexTurn) prepends /usr/local/bin
# to PATH and sets CODEX_BROWSER_MCP_URL so Codex can drive the per-room shim browser.
set -e
D="$(cd "$(dirname "$0")" && pwd)"
install -m 755 "$D/browser" /usr/local/bin/browser
echo "installed /usr/local/bin/browser"
