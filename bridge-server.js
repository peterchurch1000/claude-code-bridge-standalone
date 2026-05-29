const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { spawn, execFile } = require('child_process');
const path = require('path');
const http = require('http');

const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '3457');
const NOVNC_URL   = process.env.NOVNC_URL  || 'https://claude-bridge.procyss-automation.com/vnc';
const CLAUDE_CWD  = process.env.CLAUDE_CWD || __dirname;
const MCP_PORT    = parseInt(process.env.MCP_PORT || '8931');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.BRIDGE_CONFIG = ${JSON.stringify({ novncUrl: NOVNC_URL })};`);
});

app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Read real API rate limit data saved by claude-session-status statusline script
const fs = require('fs');
function readRateLimits() {
  try {
    const raw = fs.readFileSync('/tmp/claude-rate-limits.json', 'utf8');
    const d = JSON.parse(raw);
    const age = Date.now() - new Date(d.updated_at).getTime();
    if (age < 600_000) return d;
  } catch {}
  return null;
}

// Claude token/cost usage — 5-hour block + weekly, parallel fetch
app.get('/usage', (req, res) => {
  let blockResult = null, weekResult = null, done = 0;
  const rateLimits = readRateLimits();

  function finish() {
    if (++done < 2) return;
    res.json({ ok: true, block: blockResult, week: weekResult });
  }

  // 5-hour block data
  execFile('ccusage', ['blocks', '--json'], { timeout: 8000 }, (err, stdout) => {
    try {
      const data = JSON.parse(stdout);
      const blocks = (data.blocks || []).filter(b => !b.isGap);
      const active = blocks.find(b => b.isActive);
      const today = new Date().toISOString().slice(0, 10);
      const todayCost = blocks
        .filter(b => (b.startTime || '').slice(0, 10) === today)
        .reduce((s, b) => s + (b.costUSD || 0), 0);
      if (!active) { blockResult = { active: false, todayCost }; return finish(); }
      const tokens = active.totalTokens || 0;
      const endTime = active.endTime ? new Date(active.endTime) : null;
      const minsLeft = endTime ? Math.max(0, Math.round((endTime - Date.now()) / 60000)) : null;
      const pct = rateLimits ? rateLimits.five_hour_pct : (tokens / 72_117_641) * 100;
      blockResult = {
        active: true, tokens,
        pct, minsLeft, burnRate: active.burnRate?.costPerHour || 0,
        blockCost: active.costUSD || 0, todayCost,
      };
    } catch { blockResult = { active: false }; }
    finish();
  });

  // Weekly data
  execFile('ccusage', ['claude', 'weekly', '--json'], { timeout: 8000 }, (err, stdout) => {
    try {
      const data = JSON.parse(stdout);
      const weeks = data.weekly || [];
      const today = new Date();
      const dayOfWeek = today.getDay();
      const weekStart = new Date(today);
      weekStart.setDate(today.getDate() - dayOfWeek);
      const weekKey = weekStart.toISOString().slice(0, 10);
      const current = weeks.find(w => w.week === weekKey) || weeks[weeks.length - 1];
      const prev    = weeks.length >= 2 ? weeks[weeks.length - 2] : null;
      weekResult = {
        weekCost:   current?.totalCost   || 0,
        weekTokens: current?.totalTokens || 0,
        prevCost:   prev?.totalCost      || 0,
        weekStart:  current?.week        || weekKey,
        pct: rateLimits ? rateLimits.seven_day_pct : null,
      };
    } catch { weekResult = null; }
    finish();
  });
});

// MCP health check — probes the Playwright MCP server
app.get('/mcp-health', async (req, res) => {
  const MCP_URL = `http://localhost:${MCP_PORT}/mcp`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(MCP_URL, { method: 'GET', signal: ctrl.signal });
    clearTimeout(timer);
    res.json({ ok: true, status: r.status });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Paste host clipboard into the VNC display.
// Sets the X11 clipboard via xclip, then fires Ctrl+V via xdotool so the
// focused window in Xvfb :21 (Chrome) pastes it — all atomically on the server.
app.post('/type-text', (req, res) => {
  const text = req.body?.text;
  if (typeof text !== 'string' || text.length === 0) {
    return res.status(400).json({ error: 'text required' });
  }

  const env = { ...process.env, DISPLAY: process.env.DISPLAY_NUM || ':21' };

  function fallbackType() {
    // xclip unavailable — type character-by-character via xdotool
    execFile('xdotool', ['type', '--clearmodifiers', '--delay', '12', '--', text],
      { env, timeout: 30000 },
      err => res.json({ ok: !err, method: 'xdotool-type', error: err?.message }));
  }

  // Write text to X11 CLIPBOARD via xclip stdin
  const xclip = spawn('xclip', ['-selection', 'clipboard'], { env });
  xclip.stdin.end(Buffer.from(text, 'utf8'));
  xclip.on('error', fallbackType);
  xclip.on('close', code => {
    if (code !== 0) return fallbackType();
    // xclip succeeded — send Ctrl+V to the currently-focused Xvfb window
    execFile('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], { env, timeout: 3000 },
      err => res.json({ ok: !err, method: 'xclip+ctrl+v', error: err?.message }));
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PING_INTERVAL = 30_000;
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL);
wss.on('close', () => clearInterval(heartbeat));

// ── One connection = one Claude Code session ──────────────────────────────────
// Claude is spawned per-message with --resume so the conversation context
// persists. The Playwright MCP browser persists independently as a standalone
// SSE server (started in start-browser.sh), so the browser stays open between
// Claude invocations.
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  console.log('[Bridge] Client connected');

  let sessionId   = null;
  let processing  = false;
  const msgQueue  = [];

  function send(data) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }

  function runClaude(text) {
    if (processing) {
      msgQueue.push(text);
      send({ type: 'queued', queueLength: msgQueue.length });
      return;
    }
    processing = true;
    send({ type: 'thinking' });

    const args = ['--output-format', 'stream-json', '--verbose'];
    if (sessionId) args.push('--resume', sessionId);

    const proc = spawn('claude', args, {
      cwd: CLAUDE_CWD,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdin.write(text + '\n');
    proc.stdin.end();

    let buf = '';
    proc.stdout.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);

          if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
            sessionId = ev.session_id;
            console.log('[Bridge] Session ID:', sessionId);
            send({ type: 'session_id', id: sessionId });
          }

          send({ type: 'stream', data: ev });
        } catch {
          send({ type: 'raw', text: line });
        }
      }
    });

    proc.stderr.on('data', chunk => {
      const txt = chunk.toString().trim();
      if (txt) console.log('[claude stderr]', txt.slice(0, 300));
    });

    proc.on('close', code => {
      processing = false;
      send({ type: 'done', code });
      if (msgQueue.length > 0) {
        const next = msgQueue.shift();
        setTimeout(() => runClaude(next), 150);
      }
    });

    proc.on('error', err => {
      processing = false;
      console.error('[Bridge] spawn error:', err.message);
      send({ type: 'error', text: `Failed to start Claude: ${err.message}` });
    });
  }

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'ping') {
      send({ type: 'pong', ts: Date.now() });
    } else if (msg.type === 'chat') {
      if (!msg.text?.trim()) return;
      runClaude(msg.text.trim());
    } else if (msg.type === 'resume_session') {
      if (msg.id && !sessionId) {
        sessionId = msg.id;
        console.log('[Bridge] Resumed session:', sessionId);
        send({ type: 'status', text: 'Context restored — previous session resumed.' });
      }
    } else if (msg.type === 'compact') {
      console.log('[Bridge] Compacting session:', sessionId);
      runClaude('/compact');
    } else if (msg.type === 'reset') {
      sessionId  = null;
      processing = false;
      msgQueue.length = 0;
      send({ type: 'status', text: 'Session reset — next message starts a fresh Claude session.' });
    }
  });

  ws.on('close', () => console.log('[Bridge] Client disconnected'));
  ws.on('error', err => console.error('[Bridge] WS error:', err.message));

  send({ type: 'status', text: 'Connected to Claude Code bridge. Ready.' });
});

server.listen(BRIDGE_PORT, '0.0.0.0', () => {
  console.log(`\n✅ Claude Code Bridge running`);
  console.log(`   HTTP:      http://0.0.0.0:${BRIDGE_PORT}`);
  console.log(`   WebSocket: ws://0.0.0.0:${BRIDGE_PORT}/ws`);
  console.log(`   noVNC URL: ${NOVNC_URL}`);
  console.log(`   Claude CWD: ${CLAUDE_CWD}\n`);
});
