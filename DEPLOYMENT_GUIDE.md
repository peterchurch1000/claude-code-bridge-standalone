# Claude Bridge Multi-Instance Deployment System

## Overview

This deployment system manages three Claude Bridge instances with bidirectional synchronization:

- **Instance 2**: `claude-bridge.procyss-automation.com` (`/root/claude-code-bridge/`)
- **Instance 3**: `claude-bridge-standalone.procyss-automation.com` (`/var/www/html/claude-code-bridge-standalone/`)
- **Instance 6**: `castle-data` (Docker container at `/var/www/html/claude-code-bridge-standalone/`)

All instances share the same GitHub repository: `https://github.com/peterchurch1000/claude-code-bridge-standalone.git`

---

## Quick Start

### From Claude Code, run:

```bash
./deploy
```

This interactive command:
1. **Detects** which instance you're in
2. **Shows** what changed
3. **Suggests** a commit message (you can edit)
4. **Commits** changes with your message
5. **Pushes** to GitHub
6. **Pulls** into other instances
7. **Runs** migrations if needed
8. **Detects** if services need restart
9. **Prompts** to restart if needed

---

## Deployment Scripts

### `deploy` (Master Wrapper)
Interactive deployment command. Run from any instance:

```bash
./deploy                          # Interactive mode
./deploy --message "Your message" # Non-interactive
./deploy --restart-always         # Force restart after deploy
./deploy --skip-other-instances   # Deploy only this instance
./deploy --help                   # Show options
```

### `scripts/deploy.sh` (Core Engine)
Low-level deployment orchestration:
- Handles stash/pop for uncommitted changes
- Commits with provided message
- Runs migrations
- Pushes to GitHub
- Pulls into other instances via git or SSH
- Outputs JSON results for parsing

Set `INSTANCE_NAME` environment variable:
```bash
INSTANCE_NAME=instance3-claude-bridge-standalone ./scripts/deploy.sh
```

### `scripts/detect-instance.sh` (Auto-Detection)
Automatically detects which instance you're in based on current directory:

```bash
source scripts/detect-instance.sh
# Outputs:
# - Line 1: INSTANCE_NAME (instance2, instance3, or instance6)
# - Line 2: INSTANCE_PATH (full path)
# - Line 3: INSTANCE_PORT (web port)
```

---

## How It Works

### 1. Change Detection
- Runs `git diff` to show what changed
- Counts affected files
- Analyzes file types to detect restart needs

### 2. Commit Message
- Claude Code (or user) provides message (max 10 words recommended)
- Message is validated and applied to commit

### 3. Stash Management
- If uncommitted changes exist, they're stashed
- Deploy proceeds with clean working tree
- Stashed changes are popped back at the end (via trap)

### 4. Migrations
- Detects `database/migrations/` directory
- If migrations exist, runs: `npm run migrate`
- Reports success/failure

### 5. Push & Pull
**From Instance 2 → Push, then pull into Instance 3 & 6**
**From Instance 3 → Push, then pull into Instance 2 & 6**
**From Instance 6 → Push, then pull into Instance 2 & 3**

### 6. Service Restart Detection
Suggests restart if these files changed:
- `package.json` (dependencies changed)
- `database/migrations/*` (migrations run)
- `.env` or `config/*` (configuration changed)
- `public/*` (static assets changed)

### 7. Output & Feedback
Deployment returns JSON with:
```json
{
  "status": "success|pending|error",
  "instance": "instance name",
  "files_changed": 5,
  "migrations_run": true,
  "services_need_restart": true,
  "restart_reason": "package.json changed",
  "other_instances_updated": ["instance2", "instance6"],
  "errors": [],
  "warnings": []
}
```

---

## Examples

### Example 1: Normal deployment from Instance 3

```bash
cd /var/www/html/claude-code-bridge-standalone
./deploy

# Output:
# Shows diff
# Suggests: "Add authentication system with email reset"
# You type: "Fix login bug in auth module"
# ✓ Commits, pushes, updates other instances
# ⚠️  Detects package.json changed
# Asks: Restart services? (y/n)
# You type: y
# ✓ Services restart, deployment complete
```

### Example 2: Deploy from castle-data

```bash
ssh -i ~/.ssh/id_rsa_PBC root@64.23.255.113
docker exec -it castle-app bash
cd /var/www/html/claude-code-bridge-standalone
./deploy

# Works exactly the same:
# - Commits locally
# - Pushes to GitHub
# - Pulls into Instance 2 & Instance 3 (both on procyss-automation)
# - Suggests restart if needed
```

### Example 3: Scripted deployment (no interaction)

```bash
./deploy --message "Hotfix: correct API response formatting"

# Automatically:
# - Commits with exact message
# - Pushes
# - Updates other instances
# - Shows results
# - Asks about restart (still interactive)
```

### Example 4: Full automation

```bash
./deploy --message "Update config" --restart-always --skip-other-instances

# No interaction:
# - Commits
# - Pushes
# - Skips updating other instances
# - Restarts services without asking
```

---

## Stash & Pop Behavior

If you have uncommitted changes when deploying:

1. **Automatic stash** happens before deploy
2. **Deployment** proceeds with clean working tree
3. **Automatic pop** happens after, restoring your uncommitted changes
4. If pop fails, a warning is shown with stash reference

Example flow:
```bash
$ ./deploy

# You have uncommitted changes:
# - src/auth.js (modified)
# - config.json (modified)

# Deployment stashes them:
# [WIP deploy] 1a2b3c4

# Deploy completes...

# Stash is popped:
# src/auth.js (restored, modified)
# config.json (restored, modified)

# You can continue editing
```

---

## Bidirectional Synchronization

The system works **bidirectionally**:

```
Instance 3 (Standalone)
        ↓ deploy
        → Pushes to GitHub
        → Pulls into Instance 2
        → SSH pulls into Instance 6
        
Instance 2 (Bridge)
        ↓ deploy
        → Pushes to GitHub
        → Pulls into Instance 3
        → SSH pulls into Instance 6

Instance 6 (Castle-Data)
        ↓ deploy
        → Pushes to GitHub
        → SSH pulls into Instance 2
        → Pulls into Instance 3
```

No matter which instance you deploy from, **all three stay synchronized**.

---

## SSH Access to castle-data

Deployment uses SSH key-based authentication:
- **Key**: `~/.ssh/id_rsa_PBC`
- **Host**: `root@64.23.255.113` (alias: `castle-data`)
- **Container**: `castle-app` (Docker)

Script uses:
```bash
ssh -i ~/.ssh/id_rsa_PBC root@64.23.255.113 "docker exec castle-app bash -c '...'"
```

No password prompts—fully automated.

---

## Troubleshooting

### Deployment fails due to stale working tree

**Symptom**: "Uncommitted changes detected" but you want to skip deployment

**Solution**: Use `--skip-other-instances` flag:
```bash
./deploy --skip-other-instances
# Only deploys current instance, doesn't update others
```

### Castle-data unreachable

**Symptom**: "Failed to update castle-data" error

**Check SSH access**:
```bash
ssh -i ~/.ssh/id_rsa_PBC root@64.23.255.113 "docker exec castle-app pwd"
# Should return: /var/www/html/claude-code-bridge-standalone
```

**If fails**: Verify SSH key and IP address are correct.

### Migrations fail

**Symptom**: "Migration failed" in deploy output

**Check manually**:
```bash
# On Instance 3:
npm run migrate

# On castle-data:
ssh -i ~/.ssh/id_rsa_PBC root@64.23.255.113 \
  "docker exec castle-app npm run migrate"
```

### Services don't restart

**Symptom**: Deploy complete but changes not live

**Manual restart**:
```bash
# Instance 2:
cd /root/claude-code-bridge && bash start.sh

# Instance 3:
cd /var/www/html/claude-code-bridge-standalone && bash start.sh

# Instance 6:
ssh -i ~/.ssh/id_rsa_PBC root@64.23.255.113 "docker restart castle-app"
```

---

## Logs

Deployment logs are saved to `/tmp/deploy_<instance>_<timestamp>.log`

View latest deployment:
```bash
tail -f /tmp/deploy_instance3_*.log
```

JSON output saved to `/tmp/deploy_output_$$.json` for programmatic parsing.

---

## Integration with Claude Code

The deployment system is designed to work seamlessly with Claude Code:

1. Claude Code runs `./deploy` from the repository root
2. Claude Code **suggests commit message** based on diff
3. User **edits or accepts** the suggestion
4. Script runs `git commit` with that message
5. Deployment proceeds automatically
6. Claude Code **parses JSON output** and handles failures
7. Failures are reported back to the **current Claude session**

This means you can handle deployment errors and restart decisions **within your Claude Code workflow**, not in a separate terminal.

---

## Last Updated

- Created: 2026-06-01
- Scripts location: `./scripts/`
- Master wrapper: `./deploy`
- All instances synchronized and tested
