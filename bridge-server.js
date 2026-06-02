const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { spawn, execFile } = require('child_process');
const path = require('path');
const http = require('http');

  const BRIDGE_PORT  = parseInt(process.env.BRIDGE_PORT  || '3467');
  const NOVNC_URL    = process.env.NOVNC_URL   ||
  'https://claude-bridge.procyss-automation.com/vnc';
  const NOVNC_WEB    = process.env.NOVNC_WEB   || '/usr/share/novnc';
  const NOVNC_PORT   = parseInt(process.env.NOVNC_PORT   || '6093');
  const CLAUDE_CWD   = process.env.CLAUDE_CWD  || __dirname;
  const MCP_PORT     = parseInt(process.env.MCP_PORT || '8931');

const app = express();
app.use(express.json());
  // Serve noVNC static files at /vnc so the iframe works without a separate proxy
app.use('/vnc', express.static(NOVNC_WEB));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.BRIDGE_CONFIG = ${JSON.stringify({ novncUrl: NOVNC_URL })};`);
});

app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Chat history persistence ──────────────────────────────────────────────────
const Database = require('better-sqlite3');
const chatDb = new Database(path.join(__dirname, 'chat.db'));
chatDb.exec(`CREATE TABLE IF NOT EXISTS chat_history (
  session_id TEXT PRIMARY KEY,
  messages   TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT 0
)`);
const stmtHistGet    = chatDb.prepare('SELECT messages FROM chat_history WHERE session_id = ?');
const stmtHistUpsert = chatDb.prepare(`INSERT INTO chat_history (session_id, messages, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET messages=excluded.messages, updated_at=excluded.updated_at`);
const stmtHistDelete = chatDb.prepare('DELETE FROM chat_history WHERE session_id = ?');

app.get('/history/:sessionId', (req, res) => {
  try {
    const row = stmtHistGet.get(req.params.sessionId);
    res.json({ messages: row ? JSON.parse(row.messages) : [] });
  } catch { res.json({ messages: [] }); }
});
app.post('/history/:sessionId', (req, res) => {
  try {
    const msgs = req.body?.messages;
    if (!Array.isArray(msgs)) return res.status(400).json({ error: 'messages array required' });
    stmtHistUpsert.run(req.params.sessionId, JSON.stringify(msgs), Date.now());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/history/:sessionId', (req, res) => {
  try { stmtHistDelete.run(req.params.sessionId); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Read real API rate limit data saved by claude-session-status statusline script
const fs = require('fs');
const os = require('os');
// Try multiple locations: user's home cache, then /tmp (for cross-instance access)
const RATE_LIMITS_PATHS = [
  path.join(os.homedir(), '.cache', 'claude', 'rate-limits.json'),
  '/tmp/claude-rate-limits.json',
  path.join(__dirname, 'claude-rate-limits.json')
];
function readRateLimits() {
  for (const rateLimitsPath of RATE_LIMITS_PATHS) {
    try {
      const raw = fs.readFileSync(rateLimitsPath, 'utf8');
      const d = JSON.parse(raw);
      const age = Date.now() - new Date(d.updated_at).getTime();
      if (age < 600_000) return d;
    } catch {}
  }
  return null;
}

// Claude token/cost usage — 5-hour block + weekly, parallel fetch
app.get('/usage', (req, res) => {
  let blockResult = null, weekResult = null, done = 0;
  const rateLimits = readRateLimits();

  function finish() {
    if (++done < 2) return;
    res.json({ ok: true, block: blockResult, week: weekResult, rateLimits });
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
      const resetsAtMs = endTime ? endTime.getTime() : null;
      const pct = rateLimits ? rateLimits.five_hour_pct : (tokens / 72_117_641) * 100;
      blockResult = {
        active: true, tokens,
        pct, minsLeft, resetsAtMs, burnRate: active.burnRate?.costPerHour || 0,
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

  const env = { ...process.env, DISPLAY: process.env.DISPLAY_NUM || ':31' };

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

// Use noServer so two WebSocket paths can share one HTTP server without conflicts
const wss      = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const wssProxy = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const pathname = (req.url || '').split('?')[0];
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else if (pathname === '/websockify') {
    wssProxy.handleUpgrade(req, socket, head, ws => wssProxy.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// Proxy /websockify → local websockify (noVNC ↔ VNC)
wssProxy.on('connection', (clientWs) => {
  const target = new WebSocket(`ws://localhost:${NOVNC_PORT}`, { perMessageDeflate: false });
  const queue = [];
  target.on('open', () => { queue.forEach(m => target.send(m.data, { binary: m.binary })); queue.length = 0; });
  clientWs.on('message', (data, isBinary) => {
    if (target.readyState === WebSocket.OPEN) target.send(data, { binary: isBinary });
    else if (target.readyState === WebSocket.CONNECTING) queue.push({ data, binary: isBinary });
  });
  target.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
  });
  const close = () => { try { clientWs.close(); } catch {} try { target.close(); } catch {} };
  clientWs.on('close', close);
  target.on('close', close);
  clientWs.on('error', close);
  target.on('error', close);
});

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
const CLAUDE_TIMEOUT_MS      = 10 * 60 * 1000; // 10 min — max silence once running
const CLAUDE_STARTUP_TIMEOUT = 2  * 60 * 1000; // 2 min  — must produce first output

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  console.log('[Bridge] Client connected');

  let sessionId    = null;
  let processing   = false;
  let currentProc  = null;
  let watchdogTimer = null;
  const msgQueue   = [];

  function send(data) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }

  function killCurrentProc(reason) {
    if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
    if (currentProc)   { try { currentProc.kill('SIGKILL'); } catch {} currentProc = null; }
    if (processing)    { processing = false; send({ type: 'done', code: -1 }); }
    msgQueue.length = 0;
    if (reason) console.log('[Bridge] Killed Claude proc:', reason);
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
    currentProc = proc;

    // Startup watchdog: must produce first output within 2 minutes (catches MCP init hangs)
    let firstOutput = false;
    watchdogTimer = setTimeout(() => {
      console.log('[Bridge] Startup watchdog fired — no output within 2 min');
      send({ type: 'error', text: '⏱ Claude failed to start (MCP/init timeout) — session reset.' });
      killCurrentProc('startup timeout');
    }, CLAUDE_STARTUP_TIMEOUT);

    proc.stdin.write(text + '\n');
    proc.stdin.end();

    let buf = '';
    proc.stdout.on('data', chunk => {
      // Switch from startup watchdog to running watchdog on first output
      if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
      if (!firstOutput) { firstOutput = true; }
      watchdogTimer = setTimeout(() => {
        send({ type: 'error', text: '⏱ Claude stopped responding (10 min timeout) — session reset.' });
        killCurrentProc('watchdog timeout after output');
      }, CLAUDE_TIMEOUT_MS);

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
      if (currentProc === proc) {
        if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
        currentProc = null;
        processing  = false;
        send({ type: 'done', code });
        if (msgQueue.length > 0) {
          const next = msgQueue.shift();
          setTimeout(() => runClaude(next), 150);
        }
      }
    });

    proc.on('error', err => {
      if (currentProc === proc) {
        if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
        currentProc = null;
        processing  = false;
        console.error('[Bridge] spawn error:', err.message);
        send({ type: 'error', text: `Failed to start Claude: ${err.message}` });
      }
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
    } else if (msg.type === 'cancel') {
      killCurrentProc('user cancel');
      send({ type: 'status', text: 'Cancelled.' });
    } else if (msg.type === 'reset') {
      killCurrentProc('user reset');
      sessionId = null;
      send({ type: 'status', text: 'Session reset — next message starts a fresh Claude session.' });
    }
  });

  ws.on('close', () => {
    killCurrentProc('client disconnected');
    console.log('[Bridge] Client disconnected');
  });
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
