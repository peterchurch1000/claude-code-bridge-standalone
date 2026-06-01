#!/bin/bash

# Claude Bridge Multi-Instance Deploy Script
# Supports bidirectional deployment across 3 instances
# Returns JSON output for Claude Code parsing

set -e

INSTANCE_NAME="${INSTANCE_NAME:-unknown}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
LOG_FILE="/tmp/deploy_${INSTANCE_NAME}_$(date +%s).log"

# Initialize output JSON
OUTPUT_FILE="/tmp/deploy_output_$$.json"
cat > "$OUTPUT_FILE" << 'EOF'
{
  "status": "pending",
  "instance": "",
  "timestamp": "",
  "files_changed": 0,
  "commits_pulled": 0,
  "migrations_run": false,
  "services_need_restart": false,
  "restart_reason": "",
  "other_instances_updated": [],
  "errors": [],
  "warnings": []
}
EOF

log() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

json_update() {
  local key="$1"
  local value="$2"
  python3 << PYSCRIPT
import json
with open('$OUTPUT_FILE', 'r') as f:
  data = json.load(f)
data[$key] = $value
with open('$OUTPUT_FILE', 'w') as f:
  json.dump(data, f, indent=2)
PYSCRIPT
}

json_append_error() {
  python3 << PYSCRIPT
import json
with open('$OUTPUT_FILE', 'r') as f:
  data = json.load(f)
data['errors'].append('$1')
with open('$OUTPUT_FILE', 'w') as f:
  json.dump(data, f, indent=2)
PYSCRIPT
}

cd "$REPO_ROOT" || { echo "Failed to cd to $REPO_ROOT"; exit 1; }

log "Starting deployment from $INSTANCE_NAME"
json_update '"instance"' "\"$INSTANCE_NAME\""
json_update '"timestamp"' "\"$(date -u +'%Y-%m-%dT%H:%M:%SZ')\""

# ===== Step 1: Handle uncommitted changes =====
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "Uncommitted changes detected. Stashing..."
  git stash push -m "Claude Code auto-stash before deploy $(date +%s)" || {
    json_append_error "Failed to stash changes"
    exit 1
  }
  HAS_STASH=1
else
  HAS_STASH=0
fi

trap 'if [ $HAS_STASH -eq 1 ]; then log "Popping stashed changes..."; git stash pop || log "Warning: stash pop failed"; fi' EXIT

# ===== Step 2: Detect what changed (for restart decision) =====
CHANGED_FILES=$(git diff HEAD~1..HEAD --name-only 2>/dev/null || echo "")
NEEDS_RESTART=false
RESTART_REASON=""

if echo "$CHANGED_FILES" | grep -qE "(package\.json|\.env|config/|database/migrations|public/)" 2>/dev/null; then
  NEEDS_RESTART=true
  if echo "$CHANGED_FILES" | grep -q "package.json"; then
    RESTART_REASON="package.json changed (dependencies)"
  elif echo "$CHANGED_FILES" | grep -q "database/migrations"; then
    RESTART_REASON="migrations run"
  elif echo "$CHANGED_FILES" | grep -qE "(config/|\.env)"; then
    RESTART_REASON="config or .env changed"
  fi
fi

json_update '"services_need_restart"' "$([ "$NEEDS_RESTART" = true ] && echo 'True' || echo 'False')"
json_update '"restart_reason"' "\"$RESTART_REASON\""

# ===== Step 3: Count files changed =====
FILES_CHANGED=$(git log -1 --name-status --pretty=format: | wc -l)
json_update '"files_changed"' "$FILES_CHANGED"

# ===== Step 4: Check for and run migrations =====
if [ -d "$REPO_ROOT/database/migrations" ]; then
  PENDING_MIGRATIONS=$(find "$REPO_ROOT/database/migrations" -name "*.js" -o -name "*.sql" 2>/dev/null | wc -l)
  if [ "$PENDING_MIGRATIONS" -gt 0 ]; then
    log "Found $PENDING_MIGRATIONS migration files. Attempting to run migrations..."

    if [ -f "$REPO_ROOT/package.json" ] && grep -q "migrate" "$REPO_ROOT/package.json"; then
      npm run migrate 2>&1 | tee -a "$LOG_FILE" || {
        json_append_error "Migration failed"
      }
      json_update '"migrations_run"' 'True'
      log "Migrations completed"
    fi
  fi
fi

# ===== Step 5: Push to GitHub =====
log "Pushing to GitHub..."
git push origin $(git rev-parse --abbrev-ref HEAD) 2>&1 | tee -a "$LOG_FILE" || {
  json_append_error "Failed to push to GitHub"
  exit 1
}

# ===== Step 6: Update other instances =====
case "$INSTANCE_NAME" in
  "instance2-claude-bridge")
    log "Pulling into Instance 3 (claude-bridge-standalone)..."
    cd /var/www/html/claude-code-bridge-standalone || exit 1
    git pull origin $(git rev-parse --abbrev-ref HEAD) 2>&1 | tee -a "$LOG_FILE"
    json_update '"other_instances_updated"' '["instance3-claude-bridge-standalone"]'

    log "Pulling into Instance 6 (castle-data via SSH)..."
    ssh -i ~/.ssh/id_rsa_PBC -o ConnectTimeout=10 root@64.23.255.113 \
      "docker exec castle-app bash -c 'cd /var/www/html/claude-code-bridge-standalone && git pull origin master'" \
      2>&1 | tee -a "$LOG_FILE" && \
    json_update '"other_instances_updated"' '["instance3-claude-bridge-standalone", "instance6-castle-data"]' || \
    json_append_error "Failed to update castle-data"
    ;;

  "instance3-claude-bridge-standalone")
    log "Pulling into Instance 2 (claude-bridge)..."
    cd /root/claude-code-bridge || exit 1
    git pull origin $(git rev-parse --abbrev-ref HEAD) 2>&1 | tee -a "$LOG_FILE"
    json_update '"other_instances_updated"' '["instance2-claude-bridge"]'

    log "Pulling into Instance 6 (castle-data via SSH)..."
    ssh -i ~/.ssh/id_rsa_PBC -o ConnectTimeout=10 root@64.23.255.113 \
      "docker exec castle-app bash -c 'cd /var/www/html/claude-code-bridge-standalone && git pull origin master'" \
      2>&1 | tee -a "$LOG_FILE" && \
    json_update '"other_instances_updated"' '["instance2-claude-bridge", "instance6-castle-data"]' || \
    json_append_error "Failed to update castle-data"
    ;;

  "instance6-castle-data")
    log "Pulling from castle-data to Instance 2..."
    cd /root/claude-code-bridge || exit 1
    git pull origin $(git rev-parse --abbrev-ref HEAD) 2>&1 | tee -a "$LOG_FILE"
    json_update '"other_instances_updated"' '["instance2-claude-bridge"]'

    log "Pulling from castle-data to Instance 3..."
    cd /var/www/html/claude-code-bridge-standalone || exit 1
    git pull origin $(git rev-parse --abbrev-ref HEAD) 2>&1 | tee -a "$LOG_FILE"
    json_update '"other_instances_updated"' '["instance2-claude-bridge", "instance3-claude-bridge-standalone"]'
    ;;
esac

# ===== Step 7: Final status =====
json_update '"status"' '"success"'

log "Deployment completed successfully"
log "Full log: $LOG_FILE"
log "Output: $OUTPUT_FILE"

# Output JSON for Claude Code to parse
cat "$OUTPUT_FILE"
