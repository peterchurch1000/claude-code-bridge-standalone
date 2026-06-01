# Claude Bridge Deployment Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    GitHub Repository                            │
│        github.com/peterchurch1000/claude-code-bridge-standalone │
└──────────────────┬──────────────────┬──────────────────────┬────┘
                   │                  │                      │
         ┌─────────▼────────┐ ┌──────▼──────────┐ ┌────────▼─────┐
         │  Instance 2      │ │  Instance 3     │ │  Instance 6  │
         │  (claude-bridge) │ │  (standalone)   │ │  (castle-data)
         │                  │ │                 │ │              │
         │ /root/           │ │ /var/www/html/  │ │  Docker      │
         │ claude-code-     │ │ claude-code-    │ │  Container   │
         │ bridge           │ │ bridge-         │ │              │
         │                  │ │ standalone      │ │ procyss-aut  │
         │                  │ │                 │ │ 64.23.255.113
         │ Port: 3457       │ │ Port: 3467      │ │ Port: 3467   │
         └──────────────────┘ └─────────────────┘ └──────────────┘
                   ▲                  ▲                     ▲
                   │                  │                     │
                   └──────────────────┼─────────────────────┘
                                      │
                   ┌──────────────────┴─────────────────────┐
                   │  ./deploy Command                      │
                   │  (Orchestrates: commit, push, pull)   │
                   └────────────────────────────────────────┘
```

---

## Directory Structure

```
claude-code-bridge-standalone/
├── deploy                              # Master wrapper (entry point)
├── scripts/
│   ├── deploy.sh                       # Core deployment engine
│   ├── detect-instance.sh              # Auto-detect current instance
│   └── commit-and-deploy.sh            # (Legacy, not used in new flow)
├── DEPLOYMENT_GUIDE.md                 # User-facing documentation
├── DEPLOY_ARCHITECTURE.md              # This file
├── package.json                        # Node.js project config
├── database/
│   └── migrations/                     # Migration files
└── [app source...]
```

Same structure deployed to all three instances via SCP.

---

## Deployment Flow Diagram

```
User in Claude Code Session
        │
        │ Runs: ./deploy
        │
        ▼
    ┌─────────────────────┐
    │ 1. Auto-detect      │ → Determines INSTANCE_NAME
    │    current instance │   (Instance 2, 3, or 6)
    └─────────────────────┘
        │
        ▼
    ┌─────────────────────┐
    │ 2. Show git diff    │ → Displays what changed
    │    and stats        │   (file count, line changes)
    └─────────────────────┘
        │
        ▼
    ┌─────────────────────┐
    │ 3. Suggest commit   │ → Claude/AI analyzes diff
    │    message          │   and suggests (max 10 words)
    │    (Interactive)    │   User can edit or accept
    └─────────────────────┘
        │
        ▼
    ┌─────────────────────┐
    │ 4. Stash check      │ → If uncommitted changes:
    │    & stage          │   git stash (with trap for pop)
    │                     │   git add -A
    └─────────────────────┘
        │
        ▼
    ┌─────────────────────┐
    │ 5. Commit           │ → git commit -m "User message"
    │                     │   (Using provided message)
    └─────────────────────┘
        │
        ▼
    ┌─────────────────────┐
    │ 6. Execute core     │ → INSTANCE_NAME=instance3... 
    │    deploy.sh        │   ./scripts/deploy.sh
    │                     │   (Returns JSON output)
    └─────────────────────┘
        │
        ▼
    ┌─────────────────────────────────────────────┐
    │ Inside deploy.sh:                           │
    │                                             │
    │ 6a. Push to GitHub                          │
    │     git push origin <branch>                │
    │                                             │
    │ 6b. Pull into other instances               │
    │     Instance 3→2,6  Instance 2→3,6 etc.    │
    │     Uses git pull or SSH docker exec       │
    │                                             │
    │ 6c. Run migrations (if exist)               │
    │     npm run migrate                         │
    │                                             │
    │ 6d. Detect restart needs                    │
    │     Check: package.json, .env, migrations  │
    │                                             │
    │ 6e. Output JSON results                     │
    │     {status, files_changed, restart_needed}│
    └─────────────────────────────────────────────┘
        │
        ▼
    ┌─────────────────────┐
    │ 7. Parse JSON       │ → Python extracts:
    │    results          │   - Deployment status
    │                     │   - Files changed count
    │                     │   - Instances updated
    │                     │   - Restart needed (true/false)
    └─────────────────────┘
        │
        ▼
    ┌─────────────────────┐
    │ 8. Display summary  │ → Shows results to user
    │    (formatted)      │   in readable format
    └─────────────────────┘
        │
        ▼
    ┌─────────────────────┐
    │ 9. Restart prompt   │ → If restart needed:
    │    (if needed)      │   "Restart services? (y/n)"
    │                     │   User confirms
    └─────────────────────┘
        │
        ▼
    ┌─────────────────────┐
    │ 10. Restart svc     │ → Based on instance:
    │     (conditional)   │   Instance 2: bash start.sh
    │                     │   Instance 3: bash start.sh
    │                     │   Instance 6: docker restart
    └─────────────────────┘
        │
        ▼
    ┌─────────────────────┐
    │ 11. Pop stash       │ → Restores uncommitted changes
    │     (trap exit)     │   (auto-executed via trap)
    └─────────────────────┘
        │
        ▼
    ✅ Deployment Complete
       All 3 instances updated
       Services restarted (if needed)
       Stash restored
```

---

## Script Responsibilities

### `deploy` (Master Wrapper)
**Responsibility**: User-facing orchestration

```
- Parse command-line arguments
- Detect current instance
- Show changes to user
- Prompt for commit message
- Stage changes (git add -A)
- Commit locally
- Execute core deploy.sh
- Parse and display JSON results
- Prompt for service restart
- Execute restart if approved
```

**Inputs**:
- Command-line flags (--message, --restart-always, etc.)
- User input (commit message, restart yes/no)

**Outputs**:
- User-friendly formatted results
- Service restart decisions

---

### `scripts/deploy.sh` (Core Engine)
**Responsibility**: Low-level orchestration and coordination

```
- Detect current working directory → determine instance
- Stash uncommitted changes (with trap for pop)
- Analyze changed files for restart detection
- Push to GitHub
- Pull into other instances:
  * Instance 2 ↔ Instance 3: Direct git pull
  * Instance 2/3 ↔ Instance 6: SSH + docker exec
- Run migrations if they exist
- Collect and format results in JSON
- Output results for Claude Code parsing
```

**Inputs**:
- Environment: INSTANCE_NAME (set by deploy wrapper)
- Current git state (changes, commits, branches)

**Outputs**:
- `/tmp/deploy_output_$$.json` (structured results)
- `/tmp/deploy_<instance>_<timestamp>.log` (detailed log)

**Error Handling**:
- Continues on non-critical failures (e.g., migration runs)
- Reports failures in JSON errors array
- Exit code reflects overall success/failure

---

### `scripts/detect-instance.sh` (Auto-Detection)
**Responsibility**: Identify which instance is running

```
- Check current working directory
- Match against known paths:
  * /root/claude-code-bridge → Instance 2
  * /var/www/html/claude-code-bridge-standalone → Instance 3
  * (default) → Instance 6
- Output: instance name, full path, port
```

**Inputs**:
- Current directory

**Outputs**:
- Three lines: INSTANCE_NAME, INSTANCE_PATH, INSTANCE_PORT

---

## Bidirectional Synchronization Logic

When Instance A deploys:

```
Instance A (Source)
├─ Commits locally
├─ Pushes to GitHub (branch: master)
└─ Pulls into Instance B & C
   ├─ Instance B ← git pull origin master
   ├─ Instance C ← SSH: docker exec git pull origin master
   └─ All instances now at same commit
```

**Key insight**: GitHub is the "single source of truth"

1. Local commit + push to GitHub first
2. Then pull from GitHub into other instances
3. This prevents conflicts and ensures consistency
4. All instances converge on same commit hash

---

## Service Restart Detection

The system detects if restart is needed by checking which files changed:

```
File pattern matches → Suggests restart?
─────────────────────────────────────────
package.json         → YES (dependencies changed)
database/migrations  → YES (schema updated, migrations ran)
.env or config/*     → YES (environment/config changed)
public/*             → MAYBE (assets changed, browser cache)
src/                 → NO (code changes don't require restart)
```

User is **prompted** before restart—not automatic (unless --restart-always flag).

---

## Error Handling & Reporting

All errors are:

1. **Caught** within scripts (no silent failures)
2. **Logged** to `/tmp/deploy_*.log`
3. **Reported** in JSON `errors[]` array
4. **Displayed** to user in formatted output
5. **Returned** to Claude Code session for further handling

Example error flow:

```bash
$ ./deploy --message "Fix auth"

# If push fails:
# "Failed to push to GitHub: [error details]"
# Script exits with code 1
# Deploy output JSON includes error in "errors" array
# Claude Code can then:
#   - Suggest troubleshooting steps
#   - Offer to retry
#   - Ask to check network/credentials
```

---

## SSH to castle-data

For Instance 6 (castle-data), deployment uses:

```bash
ssh -i ~/.ssh/id_rsa_PBC root@64.23.255.113 \
  "docker exec castle-app bash -c 'cd /var/www/html/claude-code-bridge-standalone && git pull origin master'"
```

**Requirements**:
- SSH key: `~/.ssh/id_rsa_PBC`
- Permissions: root access on castle-data
- Docker container running: `castle-app`
- Container has git installed and network access

**No password prompts**—fully automated via key auth.

---

## Migration Execution

If `database/migrations/` exists:

```bash
npm run migrate
```

Assumes `package.json` has a "migrate" script defined.

**Examples**:
```json
{
  "scripts": {
    "migrate": "node scripts/migrate.js",
    "migrate:undo": "node scripts/migrate.js --undo"
  }
}
```

Migrations run **after commit/push**, before service restart decision.

---

## Stash Management

If uncommitted changes exist when deploying:

```bash
# Step 1: Stash
git stash push -m "Claude Code auto-stash before deploy $(date +%s)"

# Step 2: Deploy proceeds (clean working tree)

# Step 3: Trap ensures pop on exit (success or failure)
trap 'git stash pop' EXIT
```

**Benefits**:
- User keeps uncommitted work intact
- Deploy doesn't fail on dirty tree
- Changes are preserved for further editing

**Edge case**: If pop fails (merge conflict), warning shown with stash reference.

---

## JSON Output Format

```json
{
  "status": "success",                    // pending|success|error
  "instance": "instance3-claude-bridge-standalone",
  "timestamp": "2026-06-01T13:45:00Z",
  "files_changed": 5,                     // Count of modified files
  "commits_pulled": 0,                    // Commits pulled from GitHub
  "migrations_run": false,                // True if migrations executed
  "services_need_restart": true,          // Restart detection
  "restart_reason": "package.json changed",
  "other_instances_updated": [
    "instance2-claude-bridge",
    "instance6-castle-data"
  ],
  "errors": [],                           // Error messages (if any)
  "warnings": []                          // Non-fatal warnings
}
```

Claude Code parses this to determine:
- Whether deployment succeeded
- What to tell user
- Whether services need restart
- Any follow-up actions needed

---

## Claude Code Integration Points

### 1. Commit Message Generation
Claude Code can:
```
- Analyze git diff
- Generate commit message suggestion (max 10 words)
- User edits or accepts
- Pass to ./deploy as: ./deploy --message "User's message"
```

### 2. Error Handling
If deployment fails, Claude Code can:
```
- Parse JSON errors[]
- Ask user about troubleshooting
- Offer to retry
- Suggest checking logs
- Handle SSH/network issues
```

### 3. Restart Decision
Claude Code receives "services_need_restart" flag:
```
- If true: user already decided interactively
- Claude logs the decision
- Can suggest alternatives if restart fails
```

### 4. Multi-Instance Coordination
Claude Code can:
```
- Track which instances were updated
- Verify all 3 are in sync
- Alert if one instance lags behind
```

---

## Testing Checklist

- [x] Instance detection works on all 3 instances
- [x] Scripts deployed to all 3 instances via SCP
- [x] SSH key auth works to castle-data
- [x] Docker container is accessible
- [ ] (User should test) Full deploy flow end-to-end
- [ ] (User should test) Service restart detection
- [ ] (User should test) Migration execution
- [ ] (User should test) Bidirectional sync

---

## Future Enhancements

Possible improvements:

1. **Slack/Email Notifications**: Post deploy results to external channel
2. **Pre-Deploy Checks**: Verify git state, branch, remote tracking
3. **Dry-Run Mode**: Show what would deploy without actually doing it
4. **Rollback**: Automatically revert last deploy if health check fails
5. **Database Backups**: Auto-backup before migrations on Instance 6
6. **Monitoring**: Track deploy times, success rates, instance sync lag

---

## Last Updated

- **Created**: 2026-06-01
- **Architecture Version**: 1.0
- **Status**: Ready for testing
