#!/bin/bash

# Auto-detect which Claude Bridge instance we're in
# Outputs: INSTANCE_NAME, INSTANCE_PATH, INSTANCE_PORT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

case "$REPO_ROOT" in
  "/root/claude-code-bridge")
    echo "instance2-claude-bridge"
    echo "$REPO_ROOT"
    echo "3457"
    ;;
  "/var/www/html/claude-code-bridge-standalone")
    echo "instance3-claude-bridge-standalone"
    echo "$REPO_ROOT"
    echo "3467"
    ;;
  *)
    # Assume it's the standalone on castle-data if none of the above
    echo "instance6-castle-data"
    echo "$REPO_ROOT"
    echo "3467"
    ;;
esac
