# Deploy System - Quick Start

## TL;DR

```bash
./deploy
# Follow prompts, done.
```

---

## What Was Built

Three scripts deployed to all 3 instances:

| Script | Purpose | Location |
|--------|---------|----------|
| `deploy` | User-facing command | Repo root |
| `scripts/deploy.sh` | Core orchestration | `scripts/` |
| `scripts/detect-instance.sh` | Auto-detect instance | `scripts/` |

All three instances now have identical copies.

---

## How It Works (5 Steps)

1. **Run** `./deploy` from repo root
2. **Review** changes shown in diff
3. **Confirm** commit message (edit or accept Claude's suggestion)
4. **Deploy** automatically:
   - Commits locally
   - Pushes to GitHub
   - Pulls into other instances
   - Runs migrations if needed
5. **Restart** services if prompted

**Total time**: ~30 seconds to 2 minutes depending on changes

---

## Key Features

✅ **Bidirectional**: Works from any instance (2, 3, or 6)
✅ **Auto-detect**: Figures out which instance you're in
✅ **Stash/Pop**: Uncommitted changes preserved
✅ **Smart restart**: Only restarts if files changed warrant it
✅ **Sync**: All 3 instances stay in perfect sync
✅ **SSH-ready**: Handles castle-data Docker container automatically
✅ **JSON output**: Results parseable by Claude Code
✅ **Interactive**: Prompts for commit message, restart decision
✅ **Safe**: No force pushes, no destructive operations

---

## Usage Examples

### Normal flow
```bash
./deploy
# Interactive prompts guide you through
```

### Non-interactive (for automation)
```bash
./deploy --message "Fix auth bug in login module"
```

### Skip updating other instances
```bash
./deploy --skip-other-instances
```

### Always restart services
```bash
./deploy --restart-always
```

### Show help
```bash
./deploy --help
```

---

## Instance Names

- **Instance 2**: `claude-bridge.procyss-automation.com` → `/root/claude-code-bridge/`
- **Instance 3**: `claude-bridge-standalone.procyss-automation.com` → `/var/www/html/claude-code-bridge-standalone/`
- **Instance 6**: `castle-data` (Docker) → Remote SSH tunnel to 64.23.255.113

System auto-detects which you're in.

---

## What Gets Deployed

Each deployment:
1. ✓ Creates a commit with your message
2. ✓ Pushes to `https://github.com/peterchurch1000/claude-code-bridge-standalone.git`
3. ✓ Pulls into other instances via:
   - Direct git pull (Instance 2 ↔ 3)
   - SSH + docker exec (to Instance 6)
4. ✓ Runs migrations (if `npm run migrate` exists)
5. ✓ Suggests service restart if needed

---

## When Services Restart

System detects restart needed if:
- `package.json` changed (dependencies)
- `database/migrations/` changed (schema)
- `.env` or `config/` changed (configuration)

User is **asked** to confirm before restart (unless --restart-always flag).

---

## Logs & Output

- **Full log**: `/tmp/deploy_<instance>_<timestamp>.log`
- **JSON results**: `/tmp/deploy_output_$$.json`
- **Latest log**: `tail -f /tmp/deploy_instance3_*.log`

---

## Documentation

Three detailed docs in repo root:

1. **QUICK_START.md** ← You are here
2. **DEPLOYMENT_GUIDE.md** → Complete user guide
3. **DEPLOY_ARCHITECTURE.md** → Technical deep dive

---

## Troubleshooting

**Q: SSH to castle-data fails?**
```bash
ssh -i ~/.ssh/id_rsa_PBC root@64.23.255.113 "pwd"
# Should return: /root
```

**Q: Deployment fails silently?**
```bash
tail -f /tmp/deploy_instance3_*.log
# See detailed error messages
```

**Q: Want to test without updating others?**
```bash
./deploy --skip-other-instances
```

**Q: Services not restarting?**
```bash
./deploy --restart-always
```

---

## What's Next?

1. **Test** the flow: `./deploy` with a real change
2. **Verify** all 3 instances are in sync after deploy
3. **Check** logs: `/tmp/deploy_instance3_*.log`
4. **Try** from different instances to confirm bidirectional sync

---

## Made Safe

This system:
- ✓ Never force-pushes
- ✓ Never rebases
- ✓ Never deletes branches
- ✓ Never overwrites uncommitted work (stashes instead)
- ✓ Lets user approve service restarts
- ✓ Logs everything
- ✓ Returns to Claude session on failure

You can safely use it multiple times per day.

---

**Status**: Ready to use. All scripts deployed to all 3 instances.

**Last deployed**: 2026-06-01
