# Claude Code Bridge Standalone

A parallel, isolated copy of the Claude Code Bridge browser automation platform.

## Overview

This is a standalone instance of the Claude Code Bridge, designed to run independently alongside:
- Original Claude Code Bridge (`claude-bridge.procyss-automation.com`, port 3457)
- Procyss Playwright MCP (`playwright-mcp.procyss-automation.com`, ports 3000/3001)

Each instance uses completely separate resources (ports, displays, Chrome profiles, systemd services, logs).

## Quick Start

### Start the Service
```bash
systemctl start claude-bridge-standalone
```

### Check Status
```bash
systemctl status claude-bridge-standalone
```

### View Logs
```bash
journalctl -u claude-bridge-standalone -f
```

### Stop the Service
```bash
systemctl stop claude-bridge-standalone
```

## Configuration

### Port Allocation

| Service | Port | Binding | Purpose |
|---------|------|---------|---------|
| Bridge UI/HTTP | **3467** | 0.0.0.0:3467 | Main chat interface + API |
| Bridge WS | **3467** | 0.0.0.0:3467 | WebSocket for real-time updates |
| Playwright MCP | **8941** | 127.0.0.1:8941 | Playwright browser automation API |
| Chrome CDP | **9231** | 127.0.0.1:9231 | Chrome debugging protocol |
| x11vnc (VNC) | **5931** | 127.0.0.1:5931 | Virtual desktop VNC server |
| websockify (noVNC) | **6093** | 0.0.0.0:6093 | WebSocket-to-VNC proxy |
| X Display | **:31** | Virtual X11 | Virtual framebuffer display |

### Environment Variables

Set in `/etc/systemd/system/claude-bridge-standalone.service`:

```
DISPLAY_NUM=:31
VNC_PORT=5931
NOVNC_PORT=6093
BRIDGE_PORT=3467
MCP_PORT=8941
CDP_PORT=9231
NOVNC_URL=https://claude-bridge-standalone.procyss-automation.com/vnc
CLAUDE_CWD=/var/www/html/claude-code-bridge-standalone
```

### Directory Structure

```
/var/www/html/claude-code-bridge-standalone/
├── start.sh                 (Main startup orchestrator)
├── start-browser.sh         (Virtual display + browser stack launcher)
├── bridge-server.js         (Node.js HTTP/WS server)
├── public/
│   ├── app.js              (Frontend chat UI)
│   ├── index.html
│   └── style.css
├── logs/                    (Runtime logs)
│   ├── bridge.log
│   ├── browser.log
│   ├── chrome.log
│   ├── playwright-mcp.log
│   ├── websockify.log
│   ├── x11vnc.log
│   └── xvfb.log
├── .claude/
│   └── settings.local.json  (Claude Code CLI permissions + model)
├── .mcp.json                (Playwright MCP server config)
├── .config/
│   └── chromium-profile-standalone/  (Chrome persistent profile)
├── .playwright-mcp/         (Playwright browser cache)
└── README.md (this file)
```

## Domain & Public Access

### Domain Setup

- **Domain**: `claude-bridge-standalone.procyss-automation.com`
- **Nginx Config**: `/etc/nginx/sites-available/claude-bridge-standalone.procyss-automation.com`
- **Status**: HTTP only (port 80 redirect)

### Enable HTTPS

1. **Run certbot** (one-time):
   ```bash
   certbot certonly --nginx \
     -d claude-bridge-standalone.procyss-automation.com \
     --non-interactive --agree-tos --email your-email@example.com
   ```

2. **Uncomment SSL in nginx config**:
   ```bash
   nano /etc/nginx/sites-available/claude-bridge-standalone.procyss-automation.com
   # Uncomment the SSL directives and comment out plain HTTP
   ```

3. **Reload nginx**:
   ```bash
   nginx -t && systemctl reload nginx
   ```

## Testing

### Test Local Connectivity

```bash
# Bridge HTTP endpoint
curl http://localhost:3467/ping

# Playwright MCP API
curl http://localhost:8941/mcp

# Chrome CDP
curl http://localhost:9231/json/version
```

### Test Public Access

```bash
# (After HTTPS setup)
curl https://claude-bridge-standalone.procyss-automation.com/ping
```

### View Virtual Desktop (noVNC)

1. Navigate to: `http://localhost:6093/vnc_auto.html`
   - Or: `https://claude-bridge-standalone.procyss-automation.com/vnc/` (after HTTPS)
2. You'll see the virtual X11 display (:31) running inside Xvfb
3. Chrome will appear automatically after startup

## Service Management

### Systemd Service File

Location: `/etc/systemd/system/claude-bridge-standalone.service`

Key settings:
- User: root
- Restart: on-failure (5 sec retry)
- Working directory: `/var/www/html/claude-code-bridge-standalone`
- Environment: All ports configured via Environment variables

### Manual Startup (without systemd)

```bash
cd /var/www/html/claude-code-bridge-standalone
./start.sh
```

This will start the entire stack:
1. Virtual display (Xvfb) on :31
2. VNC server (x11vnc) on port 5931
3. noVNC proxy (websockify) on port 6093
4. Chrome persistent process on CDP port 9231
5. Playwright MCP server on port 8941
6. Bridge Node.js server on port 3467

## Docker & Containerization

### Preparing for Docker

This project is structured to be containerized in the future:

**Current Docker-Ready Structure**:
```
.
├── Dockerfile              (To be created)
├── docker-compose.yml      (To be created)
├── docker/
│   ├── entrypoint.sh       (To be created)
│   └── chrome-policy/      (To be created - Chrome policies)
├── kubernetes/             (To be created - K8s manifests)
└── .dockerignore          (To be created)
```

**Current Limitations** (prevents containerization):
- Chrome requires `/dev/shm` (shared memory)
- X11 display requires virtual framebuffer
- Systemd service expects host-level management

**Containerization Steps** (future):
1. Create Dockerfile with multi-stage build
2. Use dind (Docker-in-Docker) or privileged containers for Xvfb/Chrome
3. Create docker-compose.yml for orchestration
4. Add Kubernetes manifests for production deployment
5. Configure volume mounts for Chrome profile persistence
6. Set resource limits and health checks

**Expected Changes**:
- Port binding will use Docker network instead of host binding
- Chrome profile will mount as Docker volume
- Logs will mount as Docker volume
- Environment variables will be injected via docker-compose

### Running with Docker (Future)

```bash
# Build
docker build -t claude-bridge-standalone:latest .

# Run
docker-compose up -d

# Logs
docker-compose logs -f

# Stop
docker-compose down
```

## Troubleshooting

### Port Already in Use

If you get "Address already in use" error:

```bash
# Find process using port
lsof -i :3467      # Bridge
lsof -i :8941      # MCP
lsof -i :9231      # Chrome CDP
lsof -i :5931      # VNC
lsof -i :6093      # websockify

# Kill and retry
systemctl restart claude-bridge-standalone
```

### Chrome Not Starting

Check logs:
```bash
tail -50 /var/www/html/claude-code-bridge-standalone/logs/chrome.log
```

Common issues:
- GPU errors → Check browser-start.sh GPU flags
- Display errors → Check :31 is available (`ps aux | grep -i xvfb`)
- Memory issues → Chrome uses ~200MB; ensure available

### MCP Connection Error

Check MCP logs:
```bash
tail -20 /var/www/html/claude-code-bridge-standalone/logs/playwright-mcp.log
```

Verify connection:
```bash
curl http://localhost:8941/mcp
```

## Differences from Original Bridge

| Aspect | Original | Standalone |
|--------|----------|------------|
| **Path** | `/root/claude-code-bridge` | `/var/www/html/claude-code-bridge-standalone` |
| **Service** | `claude-bridge.service` | `claude-bridge-standalone.service` |
| **Domain** | `claude-bridge.procyss-automation.com` | `claude-bridge-standalone.procyss-automation.com` |
| **Bridge Port** | 3457 | 3467 |
| **MCP Port** | 8931 | 8941 |
| **Chrome CDP** | 9221 | 9231 |
| **VNC Port** | 5921 | 5931 |
| **WebSocket** | 6083 | 6093 |
| **X Display** | :21 | :31 |
| **Chrome Profile** | `/root/.config/chromium-bridge-profile` | `/var/www/html/claude-code-bridge-standalone/.config/chromium-profile-standalone` |
| **Logs** | `/root/claude-code-bridge/logs` | `/var/www/html/claude-code-bridge-standalone/logs` |

## Maintenance

### Backup Chrome Profile

```bash
tar czf claude-bridge-standalone-profile-backup.tar.gz \
  /var/www/html/claude-code-bridge-standalone/.config/chromium-profile-standalone/
```

### Rotate Logs

```bash
# Manual rotation
gzip /var/www/html/claude-code-bridge-standalone/logs/*.log

# Or configure logrotate
cat > /etc/logrotate.d/claude-bridge-standalone << EOF
/var/www/html/claude-code-bridge-standalone/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    notifempty
    create 0640 root root
}
EOF
```

### Monitor Resource Usage

```bash
# Watch memory and CPU
watch -n 1 'ps aux | grep -E "chrome|x11vnc|websockify|node" | grep -v grep'

# Check disk usage
du -sh /var/www/html/claude-code-bridge-standalone/

# Check Chrome profile size
du -sh /var/www/html/claude-code-bridge-standalone/.config/chromium-profile-standalone/
```

## License

Same as original Claude Code Bridge.

## Support

For issues with the standalone instance:
1. Check systemd logs: `journalctl -u claude-bridge-standalone`
2. Check service status: `systemctl status claude-bridge-standalone`
3. Verify all ports are available
4. Ensure original Bridge is not affected (test: `curl http://localhost:3457/ping`)
5. Ensure Procyss Playwright MCP is not affected (test: `curl http://localhost:3001/mcp`)

---

## PETER TEST BROWSER (on-demand parallel stack — Peter only)

A second, isolated Playwright browser + noVNC used to TEST this app without the
noVNC infinite-mirror effect. Start/stop by hand; not supervised by any watchdog.

Start: `./start-test-browser.sh`   Stop: `./stop-test-browser.sh`
Live view: **https://claude-bridge.castle-global.com/peter/playwrite_browser_test**
MCP (for Claude): second server `playwright-test` → `http://localhost:8951/mcp`
in `/home/bridge-peter/.claude/settings.json`.

### Test-stack port allocation (verified non-conflicting)

| Service | Test port | Interactive (Peter) | Others in use |
|---------|-----------|---------------------|---------------|
| Playwright MCP | **8951** | 8941 | roy 8942, john 8943, luciano 8944, playwright.castle 8931 |
| Chrome CDP | **9241** | 9231 | roy/john/luciano 9232-9234 |
| x11vnc (VNC) | **5941** | 5931 | roy/john/luciano 5932-5934 |
| websockify (noVNC) | **6193** | 6093 | 6094-6096; playwright.castle 6920; browser-automation 6080/6081 |
| X Display | **:41** | :31 | :32-:34 |

nginx route lives in `sites-available/claude-bridge.castle-global.com`
(location `/peter/playwrite_browser_test`, proxies to noVNC 6193).

### Host port bridge (important)

The container publishes 6093-6096 but NOT 6193, and adding a published port needs a
container recreate (avoided — OOM-prone box). Instead a host systemd service bridges it:
`testbrowser-6193.service` runs `/usr/local/bin/testbrowser-6193-forward.sh`
(socat 127.0.0.1:6193 -> castle-app container :6193, re-resolves container IP on start).
On container recreate: `systemctl restart testbrowser-6193` AND re-run `start-test-browser.sh`.
