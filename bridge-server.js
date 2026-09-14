const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { spawn, execFile, execFileSync } = require('child_process');
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');

  const BRIDGE_PORT  = parseInt(process.env.BRIDGE_PORT  || '3467');
  const NOVNC_URL    = process.env.NOVNC_URL   ||
  'https://claude-bridge.procyss-automation.com/vnc';
  const NOVNC_WEB    = process.env.NOVNC_WEB   || '/usr/share/novnc';
  const NOVNC_PORT   = parseInt(process.env.NOVNC_PORT   || '6093');
  const CLAUDE_CWD   = process.env.CLAUDE_CWD  || __dirname;
  const MCP_PORT     = parseInt(process.env.MCP_PORT || '8931');
  // Per-room browser shim: when SHIM_PORT is set, each room's Claude is pointed at
  // http://localhost:<SHIM_PORT>/mcp/<roomKey> (via --mcp-config --strict-mcp-config)
  // so it drives its own tab in the shared Chrome. Unset => classic single-tab
  // behaviour (Claude uses the global playwright MCP from settings.json). No-op in prod.
  // Falls back to ~/.claude/shim-port so a tenant can be flipped by writing one file
  // (no start.sh edit / full restart needed — the per-user watchdog picks it up).
  let SHIM_PORT      = process.env.SHIM_PORT ? parseInt(process.env.SHIM_PORT) : null;
  if (!SHIM_PORT) {
    try {
      const _sp = fs.readFileSync(path.join(process.env.HOME || os.homedir(), '.claude', 'shim-port'), 'utf8').trim();
      if (_sp) SHIM_PORT = parseInt(_sp);
    } catch {}
  }
  // Blip recovery: when RESUME_TURNS is enabled, each in-flight user turn is
  // journalled to disk so a bridge-server restart (a "blip") can re-inject the
  // dropped turn against the resumed session instead of silently losing the
  // half-generated answer. Off unless RESUME_TURNS=1 (env or ~/.claude/resume-turns).
  // Mirrors the SHIM_PORT gate — zero behaviour change when unset.
  let RESUME_TURNS = process.env.RESUME_TURNS === '1';
  if (!RESUME_TURNS) {
    try {
      const _rt = fs.readFileSync(path.join(process.env.HOME || os.homedir(), '.claude', 'resume-turns'), 'utf8').trim();
      if (_rt === '1') RESUME_TURNS = true;
    } catch {}
  }
  // Per-room isolated browsers (task 190): each room drives its OWN Chrome+noVNC+MCP
  // stack (own persistent profile on disk) instead of the shared-Chrome shim. Gated
  // per-user by ~/.claude/per-room-browsers (or PER_ROOM_BROWSERS=1). When off,
  // roomStack stays null and every code path below falls back to the exact prior
  // behaviour (shim/global MCP + shared noVNC), so tenants without the flag are
  // byte-for-byte unaffected. The require is wrapped: a broken module cannot stop
  // the server booting — it just disables the feature.
  let PER_ROOM = process.env.PER_ROOM_BROWSERS === '1';
  if (!PER_ROOM) {
    try {
      const _pr = fs.readFileSync(path.join(process.env.HOME || os.homedir(), '.claude', 'per-room-browsers'), 'utf8').trim();
      if (_pr === '1') PER_ROOM = true;
    } catch {}
  }
  let roomStack = null;
  if (PER_ROOM) {
    try {
      roomStack = require(path.join(process.env.HOME || os.homedir(), 'room-browser', 'room-stack.js'));
      console.log('[Bridge] Per-room isolated browsers ENABLED');
    } catch (e) { console.error('[Bridge] room-stack load failed (feature disabled):', e.message); roomStack = null; }
  }
  // Per-room live viewer (task 190): when a roomview relay port is configured
  // (ROOMVIEW_PORT env or ~/.claude/roomview-port), the pane streams each room's
  // own browser window via /roomview -> relay /view/<room>. Unset => classic noVNC.
  let ROOMVIEW_PORT = process.env.ROOMVIEW_PORT || '';
  if (!ROOMVIEW_PORT) {
    try { ROOMVIEW_PORT = fs.readFileSync(path.join(process.env.HOME || os.homedir(), '.claude', 'roomview-port'), 'utf8').trim(); } catch {}
  }
  const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';
  // Credential steward: canonical refresh tokens never enter Claude room homes;
  // Codex (which requires a refresh token) runs one short turn at a time under
  // the per-account flock. Set to 0 for an immediate legacy-path rollback.
  const CREDENTIAL_STEWARD_ENABLED = process.env.CREDENTIAL_STEWARD_ENABLED !== '0';
  const CREDENTIAL_STEWARD = path.join(process.env.HOME || os.homedir(), 'credential-steward.js');
  const CREDENTIAL_STATE_DIR = path.join(process.env.HOME || os.homedir(), '.credential-steward');
  // [CONF_CRED_RETRY_V1] Conference credential-issuance retry policy.
  const CONF_CRED_MAX_ATTEMPTS = 3;            // total attempts (1 initial + 2 retries)
  const CONF_CRED_BACKOFF_MS = [2000, 8000];   // before retry #1, #2
  const CONF_CRED_LEASE_MS = 180000;           // > CLAUDE_STARTUP_TIMEOUT (120s)
  function _confJitter(ms) { return Math.round(ms * (0.75 + Math.random() * 0.5)); }
  function stewardText(args) {
    return execFileSync(process.execPath, [CREDENTIAL_STEWARD, ...args],
      { encoding: 'utf8', timeout: 45000, env: { ...process.env, HOME: process.env.HOME || os.homedir() } }).trim();
  }
  // LLM engine for this tenant: 'claude' (default) or 'codex'. Unset => the bridge
  // behaves EXACTLY as before (Claude), so live panes are unaffected. Flip one pane
  // with the ENGINE env var or by writing 'codex' into ~/.claude/engine.
  let ENGINE = (process.env.ENGINE || '').trim().toLowerCase();
  if (!ENGINE) { try { ENGINE = fs.readFileSync(path.join(process.env.HOME || os.homedir(), '.claude', 'engine'), 'utf8').trim().toLowerCase(); } catch {} }
  if (ENGINE !== 'codex') ENGINE = 'claude';
  console.log('[Bridge] LLM engine:', ENGINE);
  const BASE_PATH    = (process.env.BASE_PATH || '').replace(/\/$/, '');
  const CHAT_DB_PATH = process.env.CHAT_DB || path.join(__dirname, 'chat.db');

const app = express();
app.use(express.json({ limit: '12mb' })); // task #237: base64 image uploads via task proxy
  // Serve noVNC static files at /vnc so the iframe works without a separate proxy
app.use('/vnc', express.static(NOVNC_WEB));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.BRIDGE_CONFIG = ${JSON.stringify({ novncUrl: NOVNC_URL, basePath: BASE_PATH, perRoomBrowsers: !!roomStack, roomViewer: !!ROOMVIEW_PORT })};`);
});

app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── [CONF_ACTIVATION_V1] Activation build id + loopback probe/emitter ─────────
// buildId is a constant baked into THIS code. A conference records the build it is
// waiting for before it self-restarts; on respawn the boot resume only proceeds when
// this constant matches — proving the new code is actually loaded (behaviour, not mtime).
const CONF_BUILD_ID = 'CONF_ACTIVATION_V1+CONF_ACCT_SWITCH_V1';
function _confLoopbackOnly(req, res) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  res.status(403).json({ ok: false, error: 'loopback only' });
  return false;
}
app.get('/__conf/build', (req, res) => {
  if (!_confLoopbackOnly(req, res)) return;
  res.json({ ok: true, buildId: CONF_BUILD_ID, pid: process.pid });
});
// Emitter: a conference at the verification stage asks the host to restart so a
// restart-gated fix goes live, then self-verifies. Checkpoint FIRST (durable on the
// conference record), then self-restart via exit(0) — ccbmon relaunches in ~3s and the
// boot resume re-opens verification. The trigger is deliberate/operator-driven, never
// automatic: only a running conference currently at 'verification' may request it.
app.post('/__conf/activate', (req, res) => {
  if (!_confLoopbackOnly(req, res)) return;
  const key = req.body && req.body.key;
  if (!key || typeof key !== 'string') return res.status(400).json({ ok: false, error: 'key required' });
  const S = clientSessions.get(key);
  const c = (S && S.conf) || confLoad(key);
  if (!c || c.status !== 'running') return res.status(409).json({ ok: false, error: 'no running conference for key' });
  if (c.stage !== 'verification') return res.status(409).json({ ok: false, error: 'conference is at stage ' + c.stage + ', not verification' });
  const expectBuildId = (req.body && typeof req.body.buildId === 'string' && req.body.buildId) || CONF_BUILD_ID;
  const target = S || { key, conf: c, send() {}, killCurrentProc() {} };
  try { confRequestActivation(target, { expectBuildId }); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  res.json({ ok: true, restarting: true, expectBuildId, oldPid: process.pid });
});


// [ROOMTABS_V1] Per-room tab-health diagnostic + live screenshot for Settings > Room
// browser health. The room-view relay binds localhost only (reachable from here, not
// from the client), so proxy its /roomtabs (JSON) and /shot (JPEG) through the bridge.
app.get('/roomtabs', async (req, res) => {
  if (!ROOMVIEW_PORT) return res.json({ error: 'roomview off', tabs: [], orphans: [], multiRoom: [], counts: {} });
  try {
    const room = req.query.room ? String(req.query.room) : '';
    const r = await fetch(`http://127.0.0.1:${ROOMVIEW_PORT}/roomtabs?room=${encodeURIComponent(room)}`);
    res.set('Cache-Control', 'no-store');
    res.status(r.status).type('application/json').send(await r.text());
  } catch (e) { res.status(502).json({ error: String(e && e.message || e) }); }
});
app.get('/tabhealth', async (req, res) => {
  if (!ROOMVIEW_PORT) return res.json({ error: 'roomview off', tabs: [], counts: {} });
  try {
    const r = await fetch(`http://127.0.0.1:${ROOMVIEW_PORT}/tabhealth`);
    res.set('Cache-Control', 'no-store');
    res.status(r.status).type('application/json').send(await r.text());
  } catch (e) { res.status(502).json({ error: String(e && e.message || e) }); }
});
app.get('/roomshot', (req, res) => {
  if (!ROOMVIEW_PORT) return res.status(404).end();
  const room = req.query.room ? String(req.query.room) : '';
  const target = req.query.target ? String(req.query.target) : '';
  const qs = target ? `target=${encodeURIComponent(target)}` : `room=${encodeURIComponent(room)}`;
  const preq = http.get(`http://127.0.0.1:${ROOMVIEW_PORT}/shot?${qs}`, (pr) => {
    res.set('Cache-Control', 'no-store'); res.status(pr.statusCode || 200);
    if (pr.headers['content-type']) res.set('Content-Type', pr.headers['content-type']);
    pr.pipe(res);
  });
  preq.on('error', () => { try { res.status(502).end(); } catch {} });
  preq.setTimeout(4000, () => { preq.destroy(); try { res.status(504).end(); } catch {} });
});

// ── Per-room background colour: recent-colours store (shared across this user's browsers) ──
const ROOMBG_RECENTS_FILE = path.join(process.env.HOME || os.homedir(), '.claude', 'roombg-recents.json');
app.get('/roombg/recents', (req, res) => {
  try { const a = JSON.parse(fs.readFileSync(ROOMBG_RECENTS_FILE, 'utf8')); res.json(Array.isArray(a) ? a : []); }
  catch { res.json([]); }
});
app.post('/roombg/recents', (req, res) => {
  const seen = new Set();
  const colors = ((req.body && Array.isArray(req.body.colors)) ? req.body.colors : [])
    .filter(c => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c))
    .map(c => c.toLowerCase())
    .filter(c => (seen.has(c) ? false : (seen.add(c), true)))
    .slice(0, 12);
  try { fs.writeFileSync(ROOMBG_RECENTS_FILE, JSON.stringify(colors)); res.json({ ok: true, colors }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// ── Per-room background colour: room->colour assignment map (shared across this user's browsers) ──
// [ROOMBG_SYNC_V1] The room->colour assignment used to live only in each browser's localStorage,
// so colours never followed the user across browser profiles/devices. Persist it server-side like
// recents. Every read+write goes through one in-process promise chain: a GET runs only after
// already-enqueued writes commit, and concurrent writes to different rooms can't clobber
// (atomic read-modify-write; server arrival order = last-write-wins). Each op catches so a single
// failed read/write can't leave the chain permanently rejected.
const ROOMBG_ROOMS_FILE = path.join(process.env.HOME || os.homedir(), '.claude', 'roombg-rooms.json');
let _roombgChain = Promise.resolve();
function roombgEnqueue(fn) { const p = _roombgChain.then(fn, fn); _roombgChain = p.then(() => {}, () => {}); return p; }
function roombgReadMap() { try { const o = JSON.parse(fs.readFileSync(ROOMBG_ROOMS_FILE, 'utf8')); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; } catch { return {}; } }
app.get('/roombg/rooms', (req, res) => {
  roombgEnqueue(() => { res.json(roombgReadMap()); }).catch(() => { try { res.json({}); } catch {} });
});
app.post('/roombg/rooms', (req, res) => {
  const roomId = (req.body && typeof req.body.roomId === 'string') ? req.body.roomId : '';
  let color = (req.body && typeof req.body.color === 'string') ? req.body.color : '';
  if (!roomId) return res.status(400).json({ error: 'roomId required' });
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({ error: 'bad color' });
  color = color ? color.toLowerCase() : '';
  roombgEnqueue(() => {
    const map = roombgReadMap();
    if (color) map[roomId] = color; else delete map[roomId];
    fs.writeFileSync(ROOMBG_ROOMS_FILE, JSON.stringify(map));
    res.json({ ok: true, rooms: map });
  }).catch(e => { try { res.status(500).json({ error: e.message }); } catch {} });
});


// [INFRA_HEALTH_V1] Serve the daily infra-health snapshot for Settings > Infra Health.
// infra-health-check.sh (cron, 04:00 BA) writes ~/.claude/autonomy/infra-health-status.json
// (latest per-check snapshot) + appends infra-health-history.jsonl (one line per run).
app.get('/infra-health', (req, res) => {
  const dir = path.join(process.env.HOME || os.homedir(), '.claude', 'autonomy');
  let status = null, history = [];
  try { status = JSON.parse(fs.readFileSync(path.join(dir, 'infra-health-status.json'), 'utf8')); } catch {}
  try {
    const lines = fs.readFileSync(path.join(dir, 'infra-health-history.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    history = lines.slice(-30).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch {}
  res.json({ status, history });
});

// ── Task panel: list/create/update/delete tasks in ~/workspace/tasks/ ─────────
// Each task is a markdown file with YAML-ish frontmatter. Tasks are per-user
// because each bridge process runs with a different HOME (bridge-peter/roy/john).
const TASKS_DIR = path.join(os.homedir(), 'workspace', 'tasks');
try { fs.mkdirSync(TASKS_DIR, { recursive: true }); } catch {}

function parseTaskFile(full) {
  let raw;
  try { raw = fs.readFileSync(full, 'utf8'); } catch { return null; }
  const fm = {};
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].trim();
    }
  }
  let notes = '';
  const nm = raw.match(/##\s*Notes[^\n]*\n([\s\S]*?)(?:\n##\s|\s*$)/);
  if (nm) notes = nm[1].replace(/<!--[\s\S]*?-->/g, '').trim();
  let plan = '';
  const pm = raw.match(/##\s*Plan[^\n]*\n([\s\S]*?)(?:\n##\s|\s*$)/);
  if (pm) plan = pm[1].replace(/<!--[\s\S]*?-->/g, '').trim();
  let description = '';
  const dm = raw.match(/##\s*Task \(as entered\)[^\n]*\n([\s\S]*?)(?:\n##\s|\s*$)/);
  if (dm) description = dm[1].replace(/<!--[\s\S]*?-->/g, '').trim();
  let objective = '';
  const osec = raw.match(/##\s*Objective[^\n]*\n([\s\S]*?)(?:\n##\s|\s*$)/);
  if (osec) objective = osec[1].replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!objective) {
    const om = description.match(/^\s*OBJECTIVE:\s*(.+)$/im);
    if (om) objective = om[1].trim();
  }
  return {
    file: path.basename(full),
    id: fm.id || '',
    title: isJunkTitle(fm.title) ? titleFromSlug(path.basename(full)) : fm.title,
    status: (fm.status || 'new').toLowerCase(),
    objective_clarity: (fm.objective_clarity || 'unknown').toLowerCase(),
    updated: fm.updated || '',
    session: (fm.session && fm.session.toLowerCase() !== 'unknown') ? fm.session : '',
    area: fm.area || '', type: fm.type || '', person: fm.person || '',
    duration: fm.duration || '', priority: fm.priority || '', project: fm.project || '',
    scheduled: fm.scheduled || '', order: fm.order || '', queued: fm.queued || '', queued_autonomous: fm.queued_autonomous || '', requires_desktop: fm.requires_desktop || '', completed_at: fm.completed_at || '',
    notes, plan,
    description, objective, location: full,
  };
}
function setFm(content, key, value) {
  const line = `${key}: ${value}`;
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (re.test(content)) return content.replace(re, line);
  if (/^title:.*$/m.test(content)) return content.replace(/^(title:.*)$/m, `$1\n${line}`);
  return content.replace(/^---\n/, `---\n${line}\n`);
}
const JUNK_TITLE_RE = /(hit your (session|usage) limit|session limit|usage limit|rate limit|resets?\s*\d|try again (later|in)|temporarily unavailable|overloaded|service unavailable|api error|context.{0,20}exceeded)/i;
function isJunkTitle(s) { const t = String(s || '').trim(); return !t || JUNK_TITLE_RE.test(t); }
function titleFromSlug(file) {
  const m = String(file).match(/^task-\d+-(.+)\.md$/);
  const slug = (m ? m[1] : String(file).replace(/\.md$/, '')).replace(/-/g, ' ').trim();
  return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : 'Untitled task';
}

// --- Bridge task store: MariaDB via Laravel API (flag-gated per pane) -------
// If ~/.claude/bridge-task-jwt exists for THIS pane, its task panel reads/writes
// the shared MariaDB `tasks` table through the Laravel bridge API instead of the
// local .md files. Without the file every /tasks route falls through to the
// original file-based handlers below (other panes unchanged). Reversible: delete
// the JWT file to revert instantly. [BRIDGE_TASK_PROXY_V1]
const BRIDGE_TASK_JWT_FILE = path.join(process.env.HOME || os.homedir(), '.claude', 'bridge-task-jwt');
const BRIDGE_TASK_API = (process.env.BRIDGE_TASK_API || 'http://127.0.0.1:8000/api/bridge/tasks').replace(/\/$/, '');
function bridgeTaskJwt() {
  try { return fs.readFileSync(BRIDGE_TASK_JWT_FILE, 'utf8').trim(); } catch { return ''; }
}
// [PENDING_DRAFT_BADGE_V1] Fold autonomy-loop outbox drafts into the task list.
// The loop queues email drafts + WhatsApp-to-self messages under
// ~/.claude/autonomy/outbox/{drafts,whatsapp}/<id>.json (task_key = task file minus
// .md). Drained items move to a done/ subfolder, so anything still in the top-level
// folder whose status is not "done" is awaiting Peter. Each task gets a
// `pending_draft` field ('', 'email', 'whatsapp', 'both') the panel renders as a glyph.
const OUTBOX_DIR = path.join(process.env.HOME || os.homedir(), '.claude', 'autonomy', 'outbox');
function pendingDraftsByTask() {
  const map = {};
  const scan = (kind, sub) => {
    let files = [];
    try { files = fs.readdirSync(path.join(OUTBOX_DIR, sub)).filter(f => f.endsWith('.json')); } catch { return; }
    for (const f of files) {
      try {
        const o = JSON.parse(fs.readFileSync(path.join(OUTBOX_DIR, sub, f), 'utf8'));
        if (!o || !o.task_key) continue;
        if (String(o.status || '').toLowerCase() === 'done') continue;
        const key = (String(o.task_key).match(/^(task-\d+)/) || [])[1];
        if (!key) continue;
        (map[key] = map[key] || {})[kind] = true;
      } catch {}
    }
  };
  scan('email', 'drafts');
  scan('whatsapp', 'whatsapp');
  return map;
}

// [RUN_NOW_V1] Submit & Run: fire ONE immediate autonomy turn on this task so a
// freshly-answered question is acted on within ~1 min instead of waiting for the
// 15-min usage-pacing cron. Registered BEFORE the /tasks proxy so it is not
// forwarded to the Laravel task API. Spawns ~/run-now.sh detached and returns at
// once; that script picks a spare-quota account and runs the actuator (graceful
// no-op if no account has quota or the loop is not armed).
app.post('/tasks/:file/run-now', (req, res) => {
  const file = path.basename(String(req.params.file || ''));
  if (!/^task-[\w.-]+\.md$/.test(file)) return res.status(400).json({ error: 'bad file' });
  try {
    const home = process.env.HOME || os.homedir();
    const child = require('child_process').spawn('/bin/bash', [path.join(home, 'run-now.sh'), file], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    child.unref();
    return res.json({ ok: true, file });
  } catch (e) {
    console.error('[run-now]', e && e.message);
    return res.status(500).json({ error: 'failed to launch run-now' });
  }
});

app.use('/tasks', async (req, res, next) => {
  const jwt = bridgeTaskJwt();
  if (!jwt) return next();                         // file-based fallback
  try {
    const sub = (req.url === '/' ? '' : req.url);   // Express strips the mount path
    const target = BRIDGE_TASK_API + sub;
    const method = req.method.toUpperCase();
    const opts = { method, headers: { Authorization: 'Bearer ' + jwt } };
    if (!['GET', 'HEAD', 'DELETE'].includes(method)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(req.body || {});
    }
    const up = await fetch(target, opts);
    const text = await up.text();
    const ct = up.headers.get('content-type');
    // [PENDING_DRAFT_BADGE_V1] Annotate the task list with outbox draft flags.
    if (method === 'GET' && sub === '' && up.ok && ct && ct.includes('application/json')) {
      try {
        const data = JSON.parse(text);
        if (data && Array.isArray(data.tasks)) {
          const dmap = pendingDraftsByTask();
          for (const t of data.tasks) {
            const p = dmap[(String(t.file || '').match(/^(task-\d+)/) || [])[1]];
            t.pending_draft = p ? (p.email && p.whatsapp ? 'both' : (p.email ? 'email' : 'whatsapp')) : '';
          }
          res.status(up.status).set('Content-Type', ct);
          return res.send(JSON.stringify(data));
        }
      } catch {}
    }
    res.status(up.status);
    if (ct) res.set('Content-Type', ct);
    return res.send(text);
  } catch (e) {
    console.error('[bridge-task-proxy]', e && e.message);
    return res.status(502).json({ error: 'bridge task api unreachable' });
  }
});

// Read-only raw .md of one task (Notes + Plan + Loop Log). The panel task
// list is proxied to MariaDB which does NOT hold the Loop Log, so this route
// always reads the actual file to expose the autonomous loop's journal. [TASKFILE_VIEWER_V1]
app.get('/taskfile/:file', (req, res) => {
  const file = path.basename(String(req.params.file || ''));
  if (!/^task-[\w.-]+\.md$/.test(file)) return res.status(400).json({ error: 'bad file' });
  let content;
  try { content = fs.readFileSync(path.join(TASKS_DIR, file), 'utf8'); }
  catch { return res.status(404).json({ error: 'not found' }); }
  res.set('Content-Type', 'text/plain; charset=utf-8');
  return res.send(content);
});

app.get('/tasks', (req, res) => {
  let files = [];
  try { files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.md') && !f.endsWith('.bak')); }
  catch { return res.json({ tasks: [] }); }
  const tasks = files.map(f => parseTaskFile(path.join(TASKS_DIR, f))).filter(Boolean);
  const rank = { 'needs-clarification': 0, 'blocked': 1, 'planned': 2, 'new': 3, 'objective-clear': 4, 'approved': 5, 'in-progress': 6, 'done': 9 };
  const ord = t => { const n = parseInt(t.order, 10); return Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : n; };
  tasks.sort((a, b) => ord(a) - ord(b) || (rank[a.status] ?? 5) - (rank[b.status] ?? 5) ||
    String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  res.json({ tasks });
});

app.post('/tasks', (req, res) => {
  const title = String((req.body && req.body.title) || '').replace(/[\r\n]+/g, ' ').trim();
  const description = String((req.body && req.body.description) || '').trim();
  if (isJunkTitle(title)) return res.status(400).json({ error: 'title is empty or looks like an error message' });
  try { fs.mkdirSync(TASKS_DIR, { recursive: true }); } catch {}
  let maxId = 0;
  try { for (const f of fs.readdirSync(TASKS_DIR)) { const t = f.match(/^task-(\d+)-/); if (t) maxId = Math.max(maxId, parseInt(t[1], 10)); } } catch {}
  const id = String(maxId + 1).padStart(3, '0');
  const slug = (title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || 'task';
  const file = `task-${id}-${slug}.md`;
  // Local calendar date (avoids the UTC off-by-one for UTC-3 / Buenos Aires).
  const _d = new Date();
  const today = new Date(_d.getTime() - _d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  // Honor optional fields so a task can be created already scheduled forward
  // (e.g. follow-up in 6 months). Previously these were dropped and scheduled
  // was always today, so scheduled-forward tasks wrongly showed as pending.
  const b = req.body || {};
  const clean = v => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
  const sRaw = clean(b.scheduled);
  const scheduled = /^\d{4}-\d{2}-\d{2}$/.test(sRaw) ? sRaw : today;
  const area = clean(b.area);
  const priority = /^[0123]$/.test(clean(b.priority)) ? clean(b.priority) : '';
  const duration = /^\d+$/.test(clean(b.duration)) ? clean(b.duration) : '';
  const project = clean(b.project);
  const content = `---\nid: ${id}\ntitle: ${title}\nstatus: new\nobjective_clarity: unknown\nupdated: ${today}\nscheduled: ${scheduled}\npriority: ${priority}\narea: ${area}\ntype:\nperson:\nduration: ${duration}\nproject: ${project}\norder:\ncompleted_at:\n---\n\n## Task (as entered)\n\n${description || '(no description provided)'}\n\n## Notes — Objective\n\n<!-- The loop fills this in. -->\n\n## Plan\n\n<!-- Step 2. -->\n\n## Loop Log\n`;
  try { fs.writeFileSync(path.join(TASKS_DIR, file), content); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, file, id, title, scheduled });
});

const VALID_STATUS = ['new', 'needs-clarification', 'objective-clear', 'planned', 'approved', 'in-progress', 'blocked', 'done'];
app.post('/tasks/:file/status', (req, res) => {
  const file = String(req.params.file || '');
  if (!/^task-[a-z0-9-]+\.md$/.test(file)) return res.status(400).json({ error: 'bad file name' });
  const status = String((req.body && req.body.status) || '').toLowerCase();
  if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: 'invalid status' });
  const full = path.join(TASKS_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'task not found' });
  let content;
  try { content = fs.readFileSync(full, 'utf8'); } catch (e) { return res.status(500).json({ error: e.message }); }
  const today = new Date().toISOString().slice(0, 10);
  content = content.replace(/^status:.*$/m, 'status: ' + status);
  content = content.replace(/^updated:.*$/m, 'updated: ' + today);
  content = setFm(content, 'completed_at', status === 'done' ? new Date().toISOString() : '');
  content = content.replace(/\s*$/, '') + `\n- ${today}: status set to \`${status}\` (manual, via UI).\n`;
  try { fs.writeFileSync(full, content); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, file, status });
});

app.post('/tasks/:file/session', (req, res) => {
  const file = String(req.params.file || '');
  if (!/^task-[a-z0-9-]+\.md$/.test(file)) return res.status(400).json({ error: 'bad file name' });
  const sessionId = String((req.body && req.body.sessionId) || '').trim();
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(sessionId)) return res.status(400).json({ error: 'invalid sessionId' });
  const full = path.join(TASKS_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'task not found' });
  let content;
  try { content = fs.readFileSync(full, 'utf8'); } catch (e) { return res.status(500).json({ error: e.message }); }
  if (/^session:.*$/m.test(content)) content = content.replace(/^session:.*$/m, 'session: ' + sessionId);
  else if (/^title:.*$/m.test(content)) content = content.replace(/^(title:.*)$/m, `$1\nsession: ${sessionId}`);
  else content = content.replace(/^---\n/, `---\nsession: ${sessionId}\n`);
  try { fs.writeFileSync(full, content); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, file, session: sessionId });
});

const UPDATABLE_FIELDS = ['area', 'type', 'person', 'duration', 'priority', 'project', 'scheduled', 'order', 'queued', 'queued_autonomous', 'requires_desktop'];
app.post('/tasks/:file/update', (req, res) => {
  const file = String(req.params.file || '');
  if (!/^task-[a-z0-9-]+\.md$/.test(file)) return res.status(400).json({ error: 'bad file name' });
  const fields = (req.body && req.body.fields) || {};
  const full = path.join(TASKS_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'task not found' });
  let content;
  try { content = fs.readFileSync(full, 'utf8'); } catch (e) { return res.status(500).json({ error: e.message }); }
  let changed = 0;
  for (const [k, v] of Object.entries(fields)) {
    if (!UPDATABLE_FIELDS.includes(k)) continue;
    content = setFm(content, k, String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim());
    changed++;
  }
  if (!changed) return res.status(400).json({ error: 'no updatable fields' });
  content = setFm(content, 'updated', new Date().toISOString().slice(0, 10));
  try { fs.writeFileSync(full, content); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, file });
});

app.post('/tasks/:file/reorder', (req, res) => {
  const file = String(req.params.file || '');
  if (!/^task-[a-z0-9-]+\.md$/.test(file)) return res.status(400).json({ error: 'bad file name' });
  const move = String((req.body && req.body.move) || '');
  if (!['top', 'up', 'down', 'bottom'].includes(move)) return res.status(400).json({ error: 'bad move' });
  let files;
  try { files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.md') && !f.endsWith('.bak')); }
  catch { return res.status(404).json({ error: 'no tasks' }); }
  const rank = { 'needs-clarification': 0, 'blocked': 1, 'planned': 2, 'new': 3, 'objective-clear': 4, 'approved': 5, 'in-progress': 6, 'done': 9 };
  const ord = t => { const n = parseInt(t.order, 10); return Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : n; };
  const tasks = files.map(f => parseTaskFile(path.join(TASKS_DIR, f))).filter(Boolean)
    .sort((a, b) => ord(a) - ord(b) || (rank[a.status] ?? 5) - (rank[b.status] ?? 5) ||
      String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  const idx = tasks.findIndex(t => t.file === file);
  if (idx < 0) return res.status(404).json({ error: 'task not found' });
  const [moved] = tasks.splice(idx, 1);
  let ni = idx;
  if (move === 'top') ni = 0; else if (move === 'bottom') ni = tasks.length;
  else if (move === 'up') ni = Math.max(0, idx - 1); else if (move === 'down') ni = Math.min(tasks.length, idx + 1);
  tasks.splice(ni, 0, moved);
  const errs = [];
  tasks.forEach((t, i) => {
    const full = path.join(TASKS_DIR, t.file);
    try { fs.writeFileSync(full, setFm(fs.readFileSync(full, 'utf8'), 'order', String(i))); }
    catch { errs.push(t.file); }
  });
  if (errs.length) return res.status(500).json({ error: 'reorder write failed: ' + errs.join(',') });
  res.json({ ok: true, file, move });
});

app.delete('/tasks/:file', (req, res) => {
  const file = String(req.params.file || '');
  if (!/^task-[a-z0-9-]+\.md$/.test(file)) return res.status(400).json({ error: 'bad file name' });
  const full = path.join(TASKS_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'task not found' });
  try { fs.unlinkSync(full); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, file });
});

app.post('/tasks/:file/title', (req, res) => {
  const file = String(req.params.file || '');
  if (!/^task-[a-z0-9-]+\.md$/.test(file)) return res.status(400).json({ error: 'bad file name' });
  const title = String((req.body && req.body.title) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
  if (isJunkTitle(title)) return res.status(400).json({ error: 'invalid title' });
  const full = path.join(TASKS_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'task not found' });
  let content;
  try { content = fs.readFileSync(full, 'utf8'); } catch (e) { return res.status(500).json({ error: e.message }); }
  content = setFm(content, 'title', title);
  content = setFm(content, 'updated', new Date().toISOString().slice(0, 10));
  try { fs.writeFileSync(full, content); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, file, title });
});

// ── Auto-compaction ────────────────────────────────────────────────────────────
// Compact once token occupancy crosses the threshold; absolute token budget wins
// over the % fallback. Set both to 0 to disable.
const AUTO_COMPACT_TOKENS = parseInt(process.env.AUTO_COMPACT_TOKENS || '160000', 10);
const AUTO_COMPACT_PCT = parseInt(process.env.AUTO_COMPACT_PCT || '80', 10);
const AUTO_COMPACT_COOLDOWN_MS = parseInt(process.env.AUTO_COMPACT_COOLDOWN_MS || '120000', 10);

// ── Chat history persistence (file-based, no compilation required) ──────────
let chatData = {};
try {
  if (fs.existsSync(CHAT_DB_PATH)) {
    chatData = JSON.parse(fs.readFileSync(CHAT_DB_PATH, 'utf8'));
  }
} catch (e) {
  // Likely a stale legacy SQLite chat.db baked into the image — discard it and
  // start fresh so the file is rewritten as JSON on the next save.
  console.warn(`Resetting unreadable chat history (${e.message})`);
  chatData = {};
  try { fs.unlinkSync(CHAT_DB_PATH); } catch (_) {}
}

function saveChatData() {
  try {
    fs.writeFileSync(CHAT_DB_PATH, JSON.stringify(chatData, null, 2));
  } catch (e) {
    console.warn(`Failed to save chat history: ${e.message}`);
  }
}

// Claude's own transcripts (~/.claude/projects/<cwd-dashes>/<id>.jsonl) are the
// persisted source of truth and survive container recreation. The bridge's chat.db
// (UI-history index) does NOT survive `docker compose --force-recreate` unless it
// lives under a bind-mounted dir, so we surface sessions straight from the
// transcripts — the menu stays correct even when chat.db is wiped.
function transcriptsDir() {
  return path.join(os.homedir(), '.claude', 'projects', CLAUDE_CWD.replace(/\//g, '-'));
}
function firstUserText(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(131072);             // first user msg sits near the top
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
      if (line.indexOf('"role":"user"') === -1) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'user' && ev.message && ev.message.role === 'user') {
          const t = extractText(ev.message.content);
          if (t) return t.replace(/\s+/g, ' ').trim().slice(0, 80);
        }
      } catch {}
    }
  } catch {}
  return '';
}
function lastUserText(file) {
  try {
    const CHUNK = 524288;                          // final user turn lives in the last 512KB
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - CHUNK);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    let tail = buf.toString('utf8');
    if (start > 0) { const nl = tail.indexOf('\n'); if (nl !== -1) tail = tail.slice(nl + 1); }
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.indexOf('"role":"user"') === -1) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'user' && ev.message && ev.message.role === 'user') {
        const t = stripPlumbing(extractText(ev.message.content));
        if (t) return t.replace(/\s+/g, ' ').trim().slice(0, 80);
      }
    }
  } catch {}
  return '';
}
// Register of per-transcript preview/lastMessage keyed by file mtime so the
// session dropdown never re-reads an unchanged .jsonl (transcripts are append-
// only + huge, so a blind rescan froze Node ~15s per open). Only changed files
// are re-parsed; deleted ones are evicted.
const _sessMetaCache = new Map();
function listTranscriptSessions() {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(transcriptsDir()).filter(f => f.endsWith('.jsonl')); } catch { return out; }
  const seen = new Set();
  for (const f of files) {
    const id = f.slice(0, -6);
    seen.add(id);
    const full = path.join(transcriptsDir(), f);
    let mt = 0;
    try { mt = fs.statSync(full).mtimeMs; } catch {}
    let c = _sessMetaCache.get(id);
    if (!c || c.mtime !== mt) {
      c = { mtime: mt, preview: firstUserText(full), lastMessage: lastUserText(full) };
      _sessMetaCache.set(id, c);
    }
    out[id] = { updatedAt: mt, preview: c.preview, lastMessage: c.lastMessage };
  }
  for (const id of _sessMetaCache.keys()) if (!seen.has(id)) _sessMetaCache.delete(id);
  return out;
}
// Claude transcripts store message content as either a plain string (simple text
// turns) or an array of typed blocks. Normalize both so callers never call array
// methods on a string (which 500s the /history endpoint and blanks the chat box).
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(x => x.type === 'text').map(x => x.text).join('');
  return '';
}
// Claude writes context-management plumbing into the transcript as synthetic
// "user" turns: the /compact (and other slash) command wrappers, their stdout,
// and the local-command caveat banner. These are not real communications, so we
// strip the tagged blocks for display — but a single user turn can carry the
// plumbing AND a genuine instruction appended after it, so we strip the blocks
// rather than dropping the whole message, preserving any real trailing text.
// [XENGINE_TRANSPLANT_V1] Cross-engine context transplant helpers. A room's neutral
// history (chatData, backed by the transcript) holds EVERY turn regardless of engine;
// each engine natively resumes only the turns it produced. On an engine switch we seed
// the target's first turn with the conversation so far and start it fresh.
let XENGINE_TRANSPLANT = true;
try { fs.accessSync(path.join(os.homedir(), '.claude', 'xengine-transplant-off')); XENGINE_TRANSPLANT = false; } catch {}
function roomHistoryMessages(key, sessionId) {
  const d = chatData[key];
  let msgs = (d && Array.isArray(d.messages)) ? d.messages : [];
  const fromT = sessionId ? transcriptToMessages(sessionId) : [];
  if (fromT.length > msgs.length) msgs = fromT;
  return msgs;
}
function renderTransplant(msgs, budget = 24000) {
  const lines = [];
  for (const m of msgs) {
    const who = (m.type === 'user' || m.role === 'user') ? 'User' : 'Assistant';
    const t = String(m.text || '').trim();
    if (!t || t.includes('\u{1F5DC}')) continue;
    lines.push(who + ': ' + t);
  }
  let body = lines.join('\n\n');
  if (body.length > budget) body = '...(earlier context trimmed)...\n\n' + body.slice(-budget);
  return body;
}
function transplantPreamble(body) {
  return 'The text below is the PRIOR conversation in this room, handled by another '
    + 'assistant. Silently absorb it as your own memory and continue seamlessly - do '
    + 'not re-introduce yourself, summarise, or repeat earlier answers.\n\n'
    + '=== CONVERSATION SO FAR ===\n' + body + '\n=== END OF PRIOR CONVERSATION ===\n\n'
    + 'Now respond to the user next message:\n\n';
}
function maybeSeed(S, engine, text) {
  if (!XENGINE_TRANSPLANT) return { text, crossed: false };
  if (S && S.conf && S.conf.status === 'running') return { text, crossed: false };   // [CONFERENCE_V1] keep native threads; deltas carry the partner's turns
  if (!S.lastEngine || S.lastEngine === engine) return { text, crossed: false };
  const msgs = roomHistoryMessages(S.key, S.sessionId);
  if (!msgs.length) return { text, crossed: false };
  console.log('[Bridge] x-engine transplant ' + S.lastEngine + ' -> ' + engine + ': seeded ' + msgs.length + ' msgs');
  return { text: transplantPreamble(renderTransplant(msgs)) + text, crossed: true };
}
function stripPlumbing(t) {
  return String(t || '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .trim();
}

// The full, unaltered conversation rebuilt from the transcript .jsonl — every
// genuine user/assistant turn, with compaction artifacts removed. Compaction is
// thus invisible to the chatbot: the giant "This session is being continued…"
// continuation summary (isCompactSummary) and auto-compact status lines are
// hidden, but no real turn is ever lost. The .jsonl is append-only, so this is
// the complete record even after the live client trims its own in-memory view.
function transcriptToMessages(id) {
  const file = path.join(transcriptsDir(), `${id}.jsonl`);
  const msgs = [];
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return msgs; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.isCompactSummary === true) continue; // drop the continuation summary
    if (ev.type === 'user' && ev.message && ev.message.role === 'user') {
      const t = stripPlumbing(extractText(ev.message.content));
      if (t) msgs.push({ type: 'user', text: t });
    } else if (ev.type === 'assistant' && ev.message && ev.message.content) {
      const t = extractText(ev.message.content);
      if (t.trim() && !t.includes('🗜')) msgs.push({ type: 'assistant', text: t });
    }
  }
  return msgs;
}

// Ordered assistant text bubbles as the UI would have created them: one per
// assistant event, split on tool_use, consecutive text blocks concatenated.
function assistantBubblesFromTranscript(id) {
  const file = path.join(transcriptsDir(), `${id}.jsonl`);
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      let cur = null;
      for (const b of ev.message.content) {
        if (b.type === 'text') cur = (cur || '') + b.text;
        else if (b.type === 'tool_use') { if (cur && cur.trim()) out.push(cur); cur = null; }
      }
      if (cur && cur.trim()) out.push(cur);
    }
  }
  return out;
}

// Legacy client bug saved assistant text that preceded a tool_use as an empty
// bubble (only the turn's final bubble was persisted), so reloads showed blank
// thin lines. Backfill those blanks from the transcript at read time — only fill
// empties, and only when the existing non-empty bubbles still line up by ordinal,
// so we never reorder or corrupt a conversation.
function healEmptyAssistantText(id, messages) {
  const stored = messages.filter(m => m && m.type === 'assistant');
  if (!stored.some(m => !String(m.text || '').trim())) return messages;
  const bubbles = assistantBubblesFromTranscript(id);
  if (!bubbles.length) return messages;
  for (let i = 0; i < stored.length; i++) {
    const cur = String(stored[i].text || '').trim();
    const r = String(bubbles[i] || '').trim();
    if (cur && r && cur !== r) return messages; // misaligned — leave untouched
  }
  let ord = 0;
  for (const m of messages) {
    if (m && m.type === 'assistant') {
      if (!String(m.text || '').trim() && bubbles[ord] != null) m.text = bubbles[ord];
      ord++;
    }
  }
  return messages;
}

// Same idea as healEmptyAssistantText but for USER bubbles: a client save bug
// (and pre-alias session forks) persisted blank user turns. Backfill them from the
// transcript at read time, ordinal-aligned, bailing if any non-empty entry
// disagrees so a conversation is never reordered or corrupted.
function healEmptyUserText(id, messages) {
  const stored = messages.filter(m => m && m.type === 'user');
  if (!stored.some(m => !String(m.text || '').trim())) return messages;
  const tu = transcriptToMessages(id).filter(m => m.type === 'user');
  if (!tu.length) return messages;
  for (let i = 0; i < stored.length; i++) {
    const cur = String(stored[i].text || '').trim();
    const r = String((tu[i] || {}).text || '').trim();
    if (cur && r && cur !== r) return messages; // misaligned — leave untouched
  }
  let ord = 0;
  for (const m of messages) {
    if (m && m.type === 'user') {
      if (!String(m.text || '').trim() && tu[ord] != null) m.text = tu[ord].text;
      ord++;
    }
  }
  return messages;
}

app.get('/history/:sessionId', (req, res) => {
  const id = req.params.sessionId;
  // [CONFERENCE_HISTORY_V1] A conference room is served from its authoritative,
  // ordered conference log — NOT from the divergent raw-stream chatData/transcript
  // (which caused the "jumbled / out of order" rendering). Sits inside the existing
  // handler, so it inherits the same access gating as every other /history read;
  // it only changes WHICH representation an already-authorized read returns. Skips
  // inert 'superseded' tombstones left by an atomic room rekey.
  try {
    // [CONF_CONTAINED_V1] Serve a conference room from its OWN store (chatData) so the
    // room is self-contained. Backfill from the operational side-file on first read.
    const _cd = chatData[id];
    if (_cd && _cd.conf && Array.isArray(_cd.messages) && _cd.messages.length) {
      return res.json({ messages: _cd.messages });
    }
    const _conf = confLoad(id);
    if (_conf && _conf.status !== 'superseded' && Array.isArray(_conf.log) && _conf.log.length) {
      const _msgs = confLogToMessages(_conf);
      try { chatData[id] = { messages: _msgs, updated_at: Date.now(), conf: true }; saveChatData(); } catch (_) {}
      return res.json({ messages: _msgs });
    }
  } catch (e) { /* fall through to the normal record on any error */ }
  const data = chatData[id];
  const fromTranscript = transcriptToMessages(id);
  if (data && Array.isArray(data.messages) && data.messages.length) {
    let healed = healEmptyAssistantText(id, data.messages);
    healed = healEmptyUserText(id, healed);
    // The append-only transcript is the complete, unaltered record. If the stored
    // UI copy is shorter, it was truncated (e.g. a post-compaction client POSTed a
    // shrunken view) — serve the full transcript so no history ever disappears.
    if (fromTranscript.length > healed.length) return res.json({ messages: fromTranscript });
    return res.json({ messages: healed });
  }
  // No saved UI history for this id (e.g. after a recreate) — rebuild the bubbles
  // from the persisted transcript so the conversation still opens in full.
  res.json({ messages: fromTranscript });
});

app.post('/history/:sessionId', (req, res) => {
  try {
    const msgs = req.body?.messages;
    if (!Array.isArray(msgs)) return res.status(400).json({ error: 'messages array required' });
    // Guard against destructive truncation: after a compaction the live client
    // rebuilds its view from only the post-compaction window and POSTs that back.
    // A blind replace here is what wiped 525 stored turns down to 4. Never let a
    // shorter payload overwrite a longer stored history — only grow or match. The
    // transcript backstops GET regardless, but this keeps the index intact too.
    const existing = chatData[req.params.sessionId];
    const prevLen = (existing && Array.isArray(existing.messages)) ? existing.messages.length : 0;
    if (prevLen > msgs.length) {
      return res.json({ ok: true, kept: prevLen, ignored: msgs.length, note: 'shrink-ignored' });
    }
    // [CONF_CONTAINED_V1] A self-contained conference room is server-authoritative and
    // APPEND-ONLY from the client: the stored canonical messages must be an exact prefix
    // of the payload, else reject (409) so a stale/reformatted client cannot flatten or
    // overwrite the conference record (the shrink guard above already blocks truncation).
    if (existing && existing.conf && Array.isArray(existing.messages) && existing.messages.length) {
      const _canon = existing.messages;
      let _isPrefix = msgs.length >= _canon.length;
      if (_isPrefix) for (let _i = 0; _i < _canon.length; _i++) {
        const _a = _canon[_i] || {}, _b = msgs[_i] || {};
        if ((_a.type || '') !== (_b.type || '') || String(_a.text || '') !== String(_b.text || '')) { _isPrefix = false; break; }
      }
      if (!_isPrefix) return res.status(409).json({ ok: false, error: 'conf-canonical-conflict', note: 'conference record is append-only' });
    }
    chatData[req.params.sessionId] = { messages: msgs, updated_at: Date.now(), conf: (existing && existing.conf) ? true : undefined };   // [CONF_CONTAINED_V1] preserve self-contained marker
    saveChatData();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/history/:sessionId', (req, res) => {
  try {
    delete chatData[req.params.sessionId];
    clearRoom(req.params.sessionId);   // [CODEX_DURABLE_V2]
    saveChatData();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Session display names (user-editable labels) ────────────────────
const SESSION_NAMES_PATH = path.join(os.homedir(), '.claude', 'bridge-session-names.json');
let sessionNames = {};
try { if (fs.existsSync(SESSION_NAMES_PATH)) sessionNames = JSON.parse(fs.readFileSync(SESSION_NAMES_PATH, 'utf8')); } catch { sessionNames = {}; }
function saveSessionNames() {
  try { fs.writeFileSync(SESSION_NAMES_PATH, JSON.stringify(sessionNames, null, 2)); }
  catch (e) { console.warn(`Failed to save session names: ${e.message}`); }
}
// ── AUTONAME_ROOM_V2: auto-title a fresh room from its first instruction ──
// Gated per-home: only fires when ~/.claude/bridge-autoname-on exists. Skips
// rooms that already have a name and autonomy task rooms (they carry task labels).
function autoNameEnabled() {
  try { return fs.existsSync(path.join(os.homedir(), '.claude', 'bridge-autoname-on')); }
  catch { return false; }
}
// Like firstUserText but returns more of the instruction (up to ~400 chars, cut
// on a word boundary) so the summariser sees a whole request, not a mid-word stub.
function firstUserInstruction(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(131072);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
      if (line.indexOf('"role":"user"') === -1) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'user' && ev.message && ev.message.role === 'user') {
          let t = extractText(ev.message.content);
          if (t) {
            t = t.replace(/\s+/g, ' ').trim();
            if (t.length > 400) { const cut = t.slice(0, 400); t = cut.slice(0, cut.lastIndexOf(' ') + 1).trim() || cut; }
            return t;
          }
        }
      } catch {}
    }
  } catch {}
  return '';
}
// True only for something that reads like a short label, not a sentence/refusal.
function looksLikeTitle(str) {
  if (!str) return false;
  const words = str.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;
  if (/[.?!:;]/.test(str)) return false;                       // sentence punctuation => prose
  if (/\b(instruction|provide|incomplete|sorry|cannot|unable|please|summar|the user|it seems|appears)\b/i.test(str)) return false;
  return true;
}
// Free fallback: strip filler words and Title-Case the first few content words.
function heuristicTitle(instr) {
  const stop = new Set(('a an the of to in on at for and or but can could would you please i we it this that make made get show when they are is be as with my our your his her their new page cards card slightly').split(' '));
  let words = instr.toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  let picked = words.filter(w => !stop.has(w));
  if (picked.length < 2) picked = words;                        // instruction was all filler
  picked = picked.slice(0, 4);
  return picked.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').slice(0, 60);
}
// AUTONAME_ISOLATE_V1: keep the namer's own CLI transcript out of the room list.
const AUTONAME_SCRATCH = path.join(os.homedir(), '.claude', 'autoname-scratch');
try { fs.mkdirSync(AUTONAME_SCRATCH, { recursive: true }); } catch {}
function purgeAutonameScratch() {
  try {
    const base = path.join(os.homedir(), '.claude', 'projects');
    for (const d of fs.readdirSync(base)) {
      if (d.indexOf('autoname-scratch') === -1) continue;
      const dp = path.join(base, d);
      try { for (const f of fs.readdirSync(dp)) { try { fs.unlinkSync(path.join(dp, f)); } catch {} } } catch {}
    }
  } catch {}
}
function autoNameRoom(S) {
  try {
    if (!autoNameEnabled()) return;
    const id = S.sessionId;
    if (!id) { console.log('[autoname] skip: no sessionId on room'); return; }
    if (sessionNames[id]) return;                       // named already (manual or prior auto)
    if (S._naming) return;                              // a generation is already in flight
    if ((S._nameTurns || 0) >= 2) return;               // only the 1st or 2nd instruction
    try { if (readAutonomyRooms().get(id)) return; } catch {}   // leave task rooms alone
    const file = path.join(transcriptsDir(), id + '.jsonl');
    // [AUTONAME_CONF_BRIEF_V1] A conference's transcript begins with generic
    // role/stage scaffolding (confBuildPrompt), so first-user-message naming
    // yields boilerplate titles ("Diagnosis Conference Round One"). The brief is
    // the real problem statement — name a conference room from it directly.
    let first;
    if (S.conf && S.conf.brief && String(S.conf.brief).trim().length >= 4) {
      first = String(S.conf.brief).replace(/\s+/g, ' ').trim();
      if (first.length > 400) { const cut = first.slice(0, 400); first = cut.slice(0, cut.lastIndexOf(' ') + 1).trim() || cut; }
    } else {
      first = firstUserInstruction(file);
    }
    if (!first || first.length < 4) { console.log('[autoname] skip', id.slice(0, 8), 'no first message yet'); return; }
    S._nameTurns = (S._nameTurns || 0) + 1;
    S._naming = true;
    console.log('[autoname] naming room', id.slice(0, 8), 'turn', S._nameTurns);
    const prompt = 'Give a 3 or 4 word Title Case label for this task. '
      + 'Output ONLY the label — no punctuation, quotes, or explanation. '
      + 'If the request is cut off, infer the topic from what is present.\n\nTask: ' + first;
    const env = { ...process.env };
    let out = '', errout = '';
    let proc;
    try {
      proc = spawn('claude', ['-p', prompt, '--model', 'claude-haiku-4-5-20251001'],
        { cwd: AUTONAME_SCRATCH, env, stdio: ['ignore', 'pipe', 'pipe'] });   /* AUTONAME_ISOLATE_V1 */
    } catch (e) { S._naming = false; console.log('[autoname] spawn failed:', e.message); return; }
    proc.stdout.on('data', c => { out += c.toString(); });
    proc.stderr.on('data', c => { errout += c.toString(); });
    const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 25000);
    proc.on('error', (e) => { clearTimeout(killer); S._naming = false; console.log('[autoname] proc error', id.slice(0, 8), e.message); });
    proc.on('close', (code) => {
      clearTimeout(killer);
      S._naming = false;
      purgeAutonameScratch();   /* AUTONAME_ISOLATE_V1 */
      if (sessionNames[id]) return;                     // user named it meanwhile — respect it
      let name = (out || '').replace(/\s+/g, ' ').trim().replace(/^["'\s]+|["'\s]+$/g, '');
      if (!looksLikeTitle(name)) {
        console.log('[autoname]', id.slice(0, 8), 'model output rejected:', JSON.stringify(name.slice(0, 60)), 'code', code, errout ? ('| err ' + errout.slice(0, 80)) : '');
        name = heuristicTitle(first);
      }
      name = name.split(' ').slice(0, 5).join(' ').trim().slice(0, 60);
      if (!name) { console.log('[autoname]', id.slice(0, 8), 'produced empty name — giving up'); return; }
      sessionNames[id] = name;
      saveSessionNames();
      try { S.send({ type: 'session_named', id, name }); } catch {}
      console.log('[autoname] named room', id.slice(0, 8), '->', name);
    });
  } catch (e) { try { console.warn('[autoname] failed:', e.message); } catch {} }
}

app.post('/sessions/:id/name', (req, res) => {
  try {
    const name = (req.body && typeof req.body.name === 'string') ? req.body.name.trim().slice(0, 80) : '';
    if (name) sessionNames[req.params.id] = name; else delete sessionNames[req.params.id];
    saveSessionNames();
    res.json({ ok: true, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Archived rooms (user-collapsed into a sub-menu) ──────────────────
const SESSION_ARCHIVED_PATH = path.join(os.homedir(), '.claude', 'bridge-session-archived.json');
let archivedSessions = {};
try { if (fs.existsSync(SESSION_ARCHIVED_PATH)) archivedSessions = JSON.parse(fs.readFileSync(SESSION_ARCHIVED_PATH, 'utf8')); } catch { archivedSessions = {}; }
function saveArchivedSessions() {
  try { fs.writeFileSync(SESSION_ARCHIVED_PATH, JSON.stringify(archivedSessions, null, 2)); }
  catch (e) { console.warn(`Failed to save archived sessions: ${e.message}`); }
}
app.post('/sessions/:id/archive', (req, res) => {
  try {
    const id = String(req.params.id || '');
    const on = !(req.body && req.body.archived === false);
    if (on) archivedSessions[id] = true; else delete archivedSessions[id];
    saveArchivedSessions();
    res.json({ ok: true, archived: on });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Permanently delete a session: its transcript (removes it from the dropdown),
// cached history, and saved name. Refuses while a turn is actively running so we
// never yank a session out from under live work; a live-but-idle room is closed.
app.delete('/sessions/:id', (req, res) => {
  try {
    const id = String(req.params.id || '').replace(/[^A-Za-z0-9._-]/g, '');
    if (!id) return res.status(400).json({ error: 'Bad session id' });
    const room = clientSessions.get(id);
    if (room && room.processing) {
      return res.status(409).json({ error: 'Session is running — stop it before deleting.' });
    }
    if (room) { try { room.killCurrentProc('session deleted'); } catch {} clientSessions.delete(id); clearRoom(id); }   // [CODEX_DURABLE_V2]
    try {
      const f = path.join(transcriptsDir(), `${id}.jsonl`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (e) { console.warn('[Bridge] transcript unlink failed:', e.message); }
    if (chatData[id]) { delete chatData[id]; saveChatData(); }
    if (sessionNames[id]) { delete sessionNames[id]; saveSessionNames(); }
    if (archivedSessions[id]) { delete archivedSessions[id]; saveArchivedSessions(); }
    console.log('[Bridge] Session deleted:', id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Claude Code re-authentication (per-user, self-service) ───────────────────
// Runs `claude setup-token` under a PTY (util-linux `script`; node-pty isn't
// installed), captures the OAuth authorize URL it prints, brokers the manual
// code paste-back, and saves the resulting 1-year token to
// ~/.claude/bridge-oauth-token (consumed via CLAUDE_CODE_OAUTH_TOKEN at spawn).
// Each bridge runs as its own OS user with its own HOME, so this only ever
// touches the current user's credentials.
const OAUTH_TOKEN_PATH = path.join(os.homedir(), '.claude', 'bridge-oauth-token');
let authProc = null, authBuf = '', authUrl = '', authDone = false, authResult = null, authToken = '', authId = '';
function stripAnsiSeq(s) {
  return String(s)
    .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[()][0-9A-Za-z]/g, '')
    .replace(/\x1B[=>]/g, '');
}
function parseAuthUrl(buf) {
  const lines = stripAnsiSeq(buf).replace(/\r/g, '\n').split('\n').map(l => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/https:\/\/claude\.com\/cai\/oauth\/authorize\S*/);
    if (!m) continue;
    let url = m[0];
    for (let j = i + 1; j < lines.length; j++) {
      const nxt = lines[j];
      if (nxt && !/\s/.test(nxt) && /^[A-Za-z0-9%=&_.:\/-]+$/.test(nxt)) url += nxt; else break;
    }
    return url;
  }
  return '';
}
function scanAuthToken(buf) {
  const lines = stripAnsiSeq(buf).replace(/\r/g, '\n').split('\n');
  let best = '';
  for (const ln of lines) {
    const m = ln.match(/sk-ant-oat[0-9]*-[A-Za-z0-9_-]{20,}/);
    if (m && m[0].length > best.length) best = m[0];
  }
  return best;
}
// Kill leftover `claude auth login` / `setup-token` PTY brokers for THIS user that
// leaked across a bridge restart or a superseded sign-in. Sign-in is single-flight
// per HOME, so clearing the field on a fresh start is always safe — and it stops a
// stale broker (holding a different PKCE verifier) from later mismatching the code.
function reapStrayBrokers() {
  try { execFileSync('pkill', ['-u', String(process.getuid()), '-f', 'claude (auth login|setup-token)'], { timeout: 5000 }); } catch (e) {}
}
function killAuth() {
  if (authProc) {
    try { process.kill(-authProc.pid, 'SIGKILL'); }   // kill the whole PTY group (script + claude)
    catch { try { authProc.kill('SIGKILL'); } catch {} }
  }
  authProc = null;
}
app.post('/auth/start', (req, res) => {
  try {
    killAuth();
    authBuf = ''; authUrl = ''; authDone = false; authResult = null; authToken = '';
    const env = { ...process.env };
    delete env.DISPLAY;                 // force the manual "copy this URL" mode
    delete env.CLAUDE_CODE_OAUTH_TOKEN; // don't let an existing token short-circuit login
    authProc = spawn('script', ['-qfc', 'stty cols 400 rows 60; claude setup-token', '/dev/null'],
      { env, cwd: os.homedir(), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const onData = d => {
      authBuf += d.toString('utf8');
      if (!authUrl) authUrl = parseAuthUrl(authBuf);
      if (!authToken) authToken = scanAuthToken(authBuf);
    };
    authProc.stdout.on('data', onData);
    authProc.stderr.on('data', onData);
    authProc.on('exit', () => {
      authDone = true;
      if (!authToken) authToken = scanAuthToken(authBuf);
      if (authToken) {
        try { fs.writeFileSync(OAUTH_TOKEN_PATH, authToken, { mode: 0o600 }); fs.chmodSync(OAUTH_TOKEN_PATH, 0o600); } catch (e) {}
      }
      authResult = authToken
        ? { ok: true, message: 'Authenticated — credentials saved.' }
        : { ok: false, message: 'Sign-in did not complete (no token received).' };
      authProc = null;
    });
    let settled = false; const t0 = Date.now();
    const iv = setInterval(() => {
      if (settled) return;
      if (authUrl) { settled = true; clearInterval(iv); res.json({ ok: true, url: authUrl }); }
      else if (authDone || Date.now() - t0 > 20000) {
        settled = true; clearInterval(iv); killAuth();
        res.status(504).json({ ok: false, error: 'Timed out waiting for the sign-in URL.' });
      }
    }, 300);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/auth/code', (req, res) => {
  try {
    const code = (req.body && typeof req.body.code === 'string') ? req.body.code.trim() : '';
    if (!code) return res.status(400).json({ ok: false, error: 'No code provided.' });
    if (!authProc) return res.status(409).json({ ok: false, error: 'No sign-in in progress — start again.' });
    const reqId = String((req.body && req.body.authId) || '');
    if (authId && reqId && reqId !== authId)
      return res.status(409).json({ ok: false, error: 'This sign-in was superseded by a newer one — close and start again.' });
    try {
      /* paste-mode */ // Only use bracketed paste if the CLI enabled it (?2004h);
      // `claude auth login` does NOT, and the literal markers would corrupt the code.
      const bracketed = String(authBuf || '').includes('\x1b[?2004h');
      authProc.stdin.write(bracketed ? ('\x1b[200~' + code + '\x1b[201~') : code);
      setTimeout(() => { try { authProc && authProc.stdin.write('\r'); } catch {} }, 400);
    }
    catch (e) { return res.status(500).json({ ok: false, error: 'Could not submit code: ' + e.message }); }
    let settled = false; const t0 = Date.now();
    const iv = setInterval(() => {
      if (settled) return;
      if (authDone) {
        settled = true; clearInterval(iv);
        res.json(authResult || { ok: !!authToken, message: authToken ? 'Authenticated.' : 'Done.' });
      } else if (Date.now() - t0 > 30000) {
        settled = true; clearInterval(iv);
        res.status(504).json({ ok: false, error: 'Timed out completing sign-in.' });
      }
    }, 300);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/auth/cancel', (req, res) => { killAuth(); res.json({ ok: true }); });

// ── Add / sign in to a Claude account (front-end brokered) ───────────────────
// Runs `claude auth login` under a PTY exactly like /auth/start, but this writes
// ~/.claude/.credentials.json + ~/.claude.json (the files the account switcher
// uses) — NOT a bridge-oauth-token, so it never re-pins the pane. On success it
// auto-saves the new account into ~/.claude/accounts/ so it shows up in the
// switcher. Reuses the shared authProc state, so /auth/code and /auth/cancel
// drive it too. `name` (optional) is the short alias to store it under.
const HOME_DIR   = os.homedir();
const CRED_PATH  = path.join(HOME_DIR, '.claude', '.credentials.json');
const CJSON_PATH = path.join(HOME_DIR, '.claude.json');
function currentEmail() {
  try { return (JSON.parse(fs.readFileSync(CJSON_PATH, 'utf8')).oauthAccount || {}).emailAddress || ''; } catch (e) { return ''; }
}
function credMtime() { try { return fs.statSync(CRED_PATH).mtimeMs; } catch (e) { return 0; } }
function slugFromEmail(email) {
  return String(email || '').split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase().slice(0, 24) || 'account';
}
// Full-email → filename-safe name tag (used when the user leaves the name blank):
// keep the whole address, turning @ and . into hyphens. e.g. a@b.com → a-b-com.
function nameFromEmail(email) {
  return String(email || '').toLowerCase().replace(/[@.]+/g, '-').replace(/[^a-z0-9_-]/g, '').replace(/^-+|-+$/g, '').slice(0, 40) || 'account';
}
app.post('/auth/login', (req, res) => {
  try {
    killAuth();
    reapStrayBrokers();
    authBuf = ''; authUrl = ''; authDone = false; authResult = null; authToken = '';
    authId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    const alias = String((req.body && req.body.name) || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
    const beforeMtime = credMtime();
    // Keep the outgoing account's refresh token fresh before login overwrites it.
    try { if (fs.existsSync(SWITCH_SH)) execFileSync(SWITCH_SH, ['--snapshot'], { timeout: 15000 }); } catch (e) {}
    const env = { ...process.env };
    delete env.DISPLAY;                 // force the manual "copy this URL" mode
    delete env.CLAUDE_CODE_OAUTH_TOKEN; // don't let an existing token short-circuit login
    authProc = spawn('script', ['-qfc', 'stty cols 400 rows 60; claude auth login --claudeai', '/dev/null'],
      { env, cwd: HOME_DIR, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const onData = d => { authBuf += d.toString('utf8'); if (!authUrl) authUrl = parseAuthUrl(authBuf); };
    authProc.stdout.on('data', onData);
    authProc.stderr.on('data', onData);
    authProc.on('exit', () => {
      authDone = true;
      const afterEmail = currentEmail();
      const succeeded = credMtime() > beforeMtime && !!afterEmail;
      if (succeeded) {
        const name = alias || nameFromEmail(afterEmail);
        let saveMsg = '';
        try { execFileSync(SWITCH_SH, ['--save', name], { timeout: 15000 }); saveMsg = ' — saved as “' + name + '”'; } catch (e) {}
        authResult = { ok: true, message: 'Signed in as ' + afterEmail + saveMsg + '.' };
      } else {
        /* auth-detail */
        const clean = String(authBuf || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n');
        const lines = clean.split('\n').map(s => s.trim()).filter(Boolean);
        const fail = [...lines].reverse().find(l => /fail|error|invalid|expired|denied|status code|already/i.test(l));
        console.error('[auth/login] exit without creds. tail:\n' + lines.slice(-8).join('\n'));
        authResult = { ok: false, message: 'Sign-in did not complete' + (fail ? ' — ' + fail : ' (no new credentials saved).') };
      }
      authProc = null;
    });
    let settled = false; const t0 = Date.now();
    const iv = setInterval(() => {
      if (settled) return;
      if (authUrl) { settled = true; clearInterval(iv); res.json({ ok: true, url: authUrl, authId }); }
      else if (authDone || Date.now() - t0 > 20000) {
        settled = true; clearInterval(iv); killAuth();
        res.status(504).json({ ok: false, error: 'Timed out waiting for the sign-in URL.' });
      }
    }, 300);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Account switcher (rotate this pane between saved Claude accounts) ────────
const ACCT_DIR  = path.join(os.homedir(), '.claude', 'accounts');
const SWITCH_SH = path.join(os.homedir(), '.claude', 'switch-account.sh');
// Codex (ChatGPT/OpenAI) account store — parallel to the Claude one above. Each
// login is a snapshot ~/.codex/accounts/<name>.auth.json; the active login is
// ~/.codex/auth.json; codex-switch.sh rotates between them.
const CODEX_DIR       = path.join(os.homedir(), '.codex');
const CODEX_ACCT_DIR  = path.join(CODEX_DIR, 'accounts');
const CODEX_AUTH      = path.join(CODEX_DIR, 'auth.json');
const CODEX_SWITCH_SH = path.join(CODEX_DIR, 'codex-switch.sh');
const ENGINE_FILE     = path.join(os.homedir(), '.claude', 'engine');
// Live engine for this pane, re-read per call so an account switch (which writes
// the marker) takes effect on the NEXT turn without restarting the pane.
function currentEngine() {
  let e = (process.env.ENGINE || '').trim().toLowerCase();
  if (!e) { try { e = fs.readFileSync(ENGINE_FILE, 'utf8').trim().toLowerCase(); } catch {} }
  return e === 'codex' ? 'codex' : 'claude';
}
// [ENGINE_AUTHORITATIVE_V1] Monotonic revision of the shared global-engine marker. It bumps
// whenever the marker VALUE changes, so connected clients can be told to resync. Value-equality
// (never the rev) is the dispatch refusal criterion.
let _globalEngineSeen = null, _globalEngineRev = 0;
function globalEngineNow() {
  const v = currentEngine();
  if (_globalEngineSeen !== v) { _globalEngineSeen = v; _globalEngineRev++; }
  return { engine: v, rev: _globalEngineRev };
}
// The ONE place a room's engine is decided (used by /usage, engineState and the dispatch
// guard so no divergent fallback logic can creep in): a per-room pin wins, else the live
// global marker. NEVER lastEngine (that is display history, not a predictor of dispatch).
function resolveRoomEngine(S) {
  const override = (S && (S.engineOverride === 'claude' || S.engineOverride === 'codex')) ? S.engineOverride : null;
  const g = globalEngineNow();
  return { engine: override || g.engine, mode: override ? override : 'global', rev: g.rev };
}
// Durable-map variant for a room with no live session (offline /usage lookups).
function resolveRoomEngineByKey(key) {
  const S = clientSessions.get(key);
  if (S) return resolveRoomEngine(S);
  let override = null;
  try { const rec = _loadRoomMap()[key]; if (rec && (rec.engineOverride === 'claude' || rec.engineOverride === 'codex')) override = rec.engineOverride; } catch {}
  const g = globalEngineNow();
  return { engine: override || g.engine, mode: override ? override : 'global', rev: g.rev };
}
// Push a fresh room_engine to every room that FOLLOWS the global marker, so an out-of-band
// change (another tab/account switch, a cron) updates their bars without a reload.
function broadcastGlobalEngineChange() {
  for (const S of clientSessions.values()) {
    if (!S || S.engineOverride) continue;
    try { S.send(S.engineState()); } catch {}
  }
}
// Convergence poll (NOT the correctness guarantee): detect a marker value change and broadcast.
function pollEngineMarker() {
  const before = _globalEngineSeen;
  const g = globalEngineNow();
  if (before !== null && g.engine !== before) broadcastGlobalEngineChange();
}
function codexEmail(o) {
  try {
    const t = ((o.tokens || {}).id_token) || '';
    if (t) { const pl = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')); return pl.email || ''; }
    if (o.OPENAI_API_KEY) return 'api-key';
  } catch {}
  return '';
}
function codexAcctId(o) { try { return (o.tokens || {}).account_id || ''; } catch { return ''; } }
function listCodexAccounts() {
  let activeId = '';
  try { activeId = codexAcctId(JSON.parse(fs.readFileSync(CODEX_AUTH, 'utf8'))); } catch {}
  const accounts = [];
  try {
    for (const f of fs.readdirSync(CODEX_ACCT_DIR)) {
      const m = f.match(/^(.+)\.auth\.json$/); if (!m) continue;
      let o = {}; try { o = JSON.parse(fs.readFileSync(path.join(CODEX_ACCT_DIR, f), 'utf8')); } catch {}
      accounts.push({ name: m[1], email: codexEmail(o), type: 'codex', active: !!activeId && codexAcctId(o) === activeId });
    }
  } catch {}
  accounts.sort((a, b) => a.name.localeCompare(b.name));
  return { accounts, enabled: fs.existsSync(CODEX_SWITCH_SH) };
}
// Reset-aware view of a stored usage snapshot: a window's percentage is only
// meaningful until its reset time. Once `resets_at` has passed the window has
// rolled over, so the account is fully available (0% used) again — otherwise a
// stale snapshot keeps reporting the old (e.g. 100%) figure long after reset.
function normalizeUsage(u) {
  if (!u) return u;
  const now = Date.now() / 1000;
  const out = { ...u };
  if (out.five_hour_resets_at != null && out.five_hour_resets_at <= now) {
    out.five_hour_pct = 0; out.five_hour_resets_at = null; out.five_hour_reset_expired = true;
  }
  if (out.seven_day_resets_at != null && out.seven_day_resets_at <= now) {
    out.seven_day_pct = 0; out.seven_day_resets_at = null; out.seven_day_reset_expired = true;
  }
  return out;
}
function listAccounts() {
  let active = '';
  try { active = (JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).oauthAccount || {}).emailAddress || ''; } catch (e) {}
  const accounts = [];
  try {
    for (const f of fs.readdirSync(ACCT_DIR)) {
      const m = f.match(/^(.+)\.account\.json$/); if (!m) continue;
      let email = '';
      try { email = (JSON.parse(fs.readFileSync(path.join(ACCT_DIR, f), 'utf8')) || {}).emailAddress || ''; } catch (e) {}
      let usage = null;
      try { usage = JSON.parse(fs.readFileSync(path.join(ACCT_DIR, m[1] + '.usage.json'), 'utf8')); } catch (e) {}
      let expired = null;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(ACCT_DIR, m[1] + '.credentials.json'), 'utf8'));
        const ex = (c && c.claudeAiOauth && c.claudeAiOauth.expiresAt) || (c && c.expiresAt);
        if (ex) expired = Date.now() >= Number(ex);
      } catch (e) {}
      accounts.push({ name: m[1], email, usage: normalizeUsage(usage), expired });
    }
  } catch (e) {}
  accounts.sort((a, b) => a.name.localeCompare(b.name));
  /* acct-health */ // Tag accounts the hourly refresh cron reported as failing.
  try {
    const al = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'account-refresh-alert.json'), 'utf8'));
    const bad = {}; (al.failing || []).forEach(x => { if (x && x.name) bad[x.name] = x.reason || 'refresh failing'; });
    for (const a of accounts) { if (bad[a.name]) { a.health = 'fail'; a.healthReason = bad[a.name]; } }
  } catch (e) {}
  return { active, accounts, enabled: fs.existsSync(SWITCH_SH) };
}
app.get('/accounts', (req, res) => {
  const base = listAccounts();
  const codex = listCodexAccounts();
  // Tag Claude accounts type:'code'; append Codex accounts. Keep top-level `active`
  // (Claude email) for backward compatibility with the current UI.
  const accounts = base.accounts.map(a => ({ ...a, type: 'code' })).concat(codex.accounts);
  res.json({ ok: true, active: base.active, accounts, enabled: base.enabled, codexEnabled: codex.enabled, engine: currentEngine() });
});
app.post('/accounts/switch', (req, res) => {
  const name = String((req.body && req.body.name) || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const wantType = String((req.body && req.body.type) || '').toLowerCase();
  if (!name) return res.status(400).json({ ok: false, error: 'Missing account name.' });
  // Route to the Codex switcher when the caller says type:'codex' or the name is a
  // stored Codex account. Also drop an engine marker (~/.claude/engine) so the pane
  // runs the matching backend on its next spawn.
  let isCodex = wantType === 'codex';
  if (!isCodex && wantType !== 'code') { try { isCodex = fs.existsSync(path.join(CODEX_ACCT_DIR, name + '.auth.json')); } catch {} }
  if (isCodex) {
    if (!fs.existsSync(CODEX_SWITCH_SH)) return res.status(404).json({ ok: false, error: 'Codex switcher not installed.' });
    return execFile(CODEX_SWITCH_SH, [name], { timeout: 20000, env: { ...process.env, HOME: os.homedir() } }, (err, stdout, stderr) => {
      const out = ((stdout || '') + (stderr || '')).trim();
      if (err) return res.status(500).json({ ok: false, error: out || err.message });
      try { fs.writeFileSync(ENGINE_FILE, 'codex'); } catch {}
      try { broadcastGlobalEngineChange(); } catch {}
      const codex = listCodexAccounts();
      res.json({ ok: true, message: (out.split('\n')[0] || ('Switched to ' + name)), engine: 'codex', ...listAccounts(), codexAccounts: codex.accounts });
    });
  }
  if (!fs.existsSync(SWITCH_SH)) return res.status(404).json({ ok: false, error: 'Account switcher not installed.' });
  execFile(SWITCH_SH, [name], { timeout: 20000 }, (err, stdout, stderr) => {
    const out = ((stdout || '') + (stderr || '')).trim();
    if (err) return res.status(500).json({ ok: false, error: out || err.message });
    try { fs.writeFileSync(ENGINE_FILE, 'claude'); } catch {}
    try { broadcastGlobalEngineChange(); } catch {}
    // [CONF_ACCT_SWITCH_V1] The Claude account is global, but a live session pins the
    // account it was first spawned under (S.credentialClaudeAccount, set-once) and a
    // persistent/kept-alive worker (esp. a conference, which is never idle-evicted) keeps
    // its original CLAUDE_CONFIG_DIR for its whole life. Propagate the switch into every
    // live session so each adopts the new account on its NEXT turn: clear the set-once
    // pin, and retire the Claude worker at a safe boundary. An idle Claude worker is
    // dropped now (direct kill, NOT killCurrentProc, which would pause a conference); a
    // busy worker is flagged to retire when it next goes idle. Sessions with no worker or
    // a non-Claude worker only need the pin cleared. A fresh spawn re-reads the active
    // account, so transcripts resume seamlessly (shared projects symlink).
    try {
      for (const S of clientSessions.values()) {
        S.credentialClaudeAccount = null;
        if (S.currentProc && S.procEngine === 'claude') {
          if (!S.processing) { try { S.currentProc.kill('SIGKILL'); } catch {} S.currentProc = null; S.procEngine = null; S.pendingCredentialRefresh = false; }
          else { S.pendingCredentialRefresh = true; }
        } else {
          S.pendingCredentialRefresh = false;
        }
      }
    } catch (e) { console.log('[Bridge] [CONF_ACCT_SWITCH_V1] account-switch propagation failed:', e.message); }
    res.json({ ok: true, message: (out.split('\n')[0] || ('Switched to ' + name)), engine: 'claude', ...listAccounts() });
  });
});

// Rename a stored account's name tag: the name is a pure label (the switcher matches
// creds by accountUuid), so this just renames the `<name>.*` file trio in ACCT_DIR.
app.post('/accounts/rename', (req, res) => {
  const from = String((req.body && req.body.from) || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const to   = String((req.body && req.body.to)   || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!from || !to) return res.status(400).json({ ok: false, error: 'Missing name.' });
  if (from === to)  return res.json({ ok: true, ...listAccounts() });
  try {
    if (!fs.existsSync(path.join(ACCT_DIR, from + '.account.json')))
      return res.status(404).json({ ok: false, error: `No account named "${from}".` });
    if (fs.existsSync(path.join(ACCT_DIR, to + '.account.json')))
      return res.status(409).json({ ok: false, error: `An account named "${to}" already exists.` });
    for (const f of fs.readdirSync(ACCT_DIR)) {
      if (f === from + '.account.json' || f.startsWith(from + '.')) {
        const rest = f.slice(from.length);            // e.g. ".credentials.json"
        if (rest[0] === '.') fs.renameSync(path.join(ACCT_DIR, f), path.join(ACCT_DIR, to + rest));
      }
    }
    res.json({ ok: true, message: `Renamed "${from}" to "${to}".`, ...listAccounts() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Delete a stored account: removes its `<name>.*` file trio from ACCT_DIR. This
// only forgets the saved login used by the switcher — it does NOT touch the live
// ~/.claude/.credentials.json, so we refuse to delete the currently-active account
// (switch away first) to avoid a confusing orphaned-but-still-running state.
app.post('/accounts/delete', (req, res) => {
  const name = String((req.body && req.body.name) || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!name) return res.status(400).json({ ok: false, error: 'Missing account name.' });
  // Codex account: a saved login is a single `<name>.auth.json` snapshot in
  // CODEX_ACCT_DIR. Route here when the caller says type:'codex' or the name is a
  // known Codex snapshot. Refuse to delete the login this pane is actively running.
  const wantType = String((req.body && req.body.type) || '').toLowerCase();
  let isCodex = wantType === 'codex';
  if (!isCodex && wantType !== 'code') { try { isCodex = fs.existsSync(path.join(CODEX_ACCT_DIR, name + '.auth.json')); } catch {} }
  if (isCodex) {
    try {
      const f = path.join(CODEX_ACCT_DIR, name + '.auth.json');
      if (!fs.existsSync(f)) return res.status(404).json({ ok: false, error: `No Codex account named "${name}".` });
      let activeId = ''; try { activeId = codexAcctId(JSON.parse(fs.readFileSync(CODEX_AUTH, 'utf8'))); } catch {}
      let thisId = '';   try { thisId   = codexAcctId(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch {}
      if (activeId && thisId && activeId === thisId && currentEngine() === 'codex')
        return res.status(409).json({ ok: false, error: 'That is the Codex login this pane is running on — switch to another account first, then delete it.' });
      fs.unlinkSync(f);
      const codex = listCodexAccounts();
      return res.json({ ok: true, message: `Deleted Codex account "${name}".`, removed: 1, ...listAccounts(), codexAccounts: codex.accounts });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  try {
    const acctFile = path.join(ACCT_DIR, name + '.account.json');
    if (!fs.existsSync(acctFile))
      return res.status(404).json({ ok: false, error: `No account named "${name}".` });
    let activeEmail = '';
    try { activeEmail = (JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).oauthAccount || {}).emailAddress || ''; } catch (e) {}
    let thisEmail = '';
    try { thisEmail = (JSON.parse(fs.readFileSync(acctFile, 'utf8')) || {}).emailAddress || ''; } catch (e) {}
    if (activeEmail && thisEmail && activeEmail === thisEmail)
      return res.status(409).json({ ok: false, error: 'That is the account this pane is running on — switch to another account first, then delete it.' });
    let removed = 0;
    for (const f of fs.readdirSync(ACCT_DIR)) {
      if (f === name + '.account.json' || (f.startsWith(name + '.') && f.slice(name.length)[0] === '.')) {
        try { fs.unlinkSync(path.join(ACCT_DIR, f)); removed++; } catch (e) {}
      }
    }
    res.json({ ok: true, message: `Deleted "${name}".`, removed, ...listAccounts() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Codex (ChatGPT) re-authentication via browser OAuth [CODEX_BROWSER_AUTH_V2] ─
// The device-code flow (`codex login --device-auth`) yields a REDUCED-scope token
// (missing api.connectors.read/invoke) that stalls codex_apps/connector calls and
// hangs every turn. The full browser flow (`codex login`) requests those scopes and
// redirects to http://localhost:1455/auth/callback on THIS host. We surface the auth
// URL, let the user sign in in any browser, and paste back the localhost redirect URL
// they land on; we relay it to codex's local callback server to finish the exchange
// (full scopes). Same paste-back shape as the Claude flow; state kept separate.
let cxProc = null, cxBuf = '', cxUrl = '', cxDone = false, cxResult = null, cxName = 'peter';
// [CODEX_DEVICE_OPT_V1] device-code flow state (mode 'device' vs default 'browser')
let cxCode = '', cxMode = 'browser', cxWatch = null;
let cxStartAuthMtime = 0, cxFinalized = false;
function killCodexAuth() {
  if (cxWatch) { try { clearInterval(cxWatch); } catch {} cxWatch = null; }
  if (cxProc) { try { process.kill(-cxProc.pid, 'SIGKILL'); } catch { try { cxProc.kill('SIGKILL'); } catch {} } }
  cxProc = null;
}
// Turn a completed `codex login` into a saved account + success result. Runs at most
// once per sign-in (cxFinalized guard) whether triggered by the process exiting OR by
// /complete's auth.json watcher (codex 0.144.x writes the token but may not exit).
function finalizeCodexAuth() {
  if (cxFinalized) return;
  cxFinalized = true; cxDone = true;
  let ok = false, email = '';
  try { const a = JSON.parse(fs.readFileSync(CODEX_AUTH, 'utf8')); ok = !!((a.tokens || {}).account_id); email = codexEmail(a); } catch {}
  if (ok) {
    try { execFileSync(CODEX_SWITCH_SH, ['--save', cxName], { timeout: 15000, env: { ...process.env, HOME: os.homedir() } }); } catch (e) {}
    try { fs.writeFileSync(ENGINE_FILE, 'codex'); } catch {}
    cxResult = { ok: true, message: 'Re-authenticated' + (email ? ' as ' + email : '') + ' — saved as “' + cxName + '”.' };
  } else {
    const clean = stripAnsiSeq(cxBuf).replace(/\r/g, '\n').split('\n').map(x => x.trim()).filter(Boolean);
    const fail = [...clean].reverse().find(l => /fail|error|invalid|expired|denied|cancel|timed? ?out/i.test(l));
    cxResult = { ok: false, message: 'Sign-in did not complete' + (fail ? ' — ' + fail : '.') };
  }
}
// [CODEX_DEVICE_OPT_V1] parse `codex login --device-auth` output: a fixed
// https://auth.openai.com/codex/device link + a one-time XXXX-XXXXX code.
function parseCodexDevice(buf) {
  const t = stripAnsiSeq(buf).replace(/\r/g, '\n');
  const url = (t.match(/https:\/\/auth\.openai\.com\/codex\/device\S*/) || [])[0] || 'https://auth.openai.com/codex/device';
  const code = (t.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/) || [])[0] || '';
  return code ? { url: url.replace(/["'\)\]\s]+$/, ''), code } : null;
}
function parseCodexAuthUrl(buf) {
  const s = stripAnsiSeq(buf).replace(/\r/g, '\n');
  const m = s.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?\S+/);
  return m ? m[0].replace(/["'\)\]\s]+$/, '') : '';
}
app.post('/codex/auth/start', (req, res) => {
  try {
    killCodexAuth();
    cxBuf = ''; cxUrl = ''; cxCode = ''; cxDone = false; cxResult = null; cxFinalized = false;
    try { cxStartAuthMtime = fs.statSync(CODEX_AUTH).mtimeMs; } catch { cxStartAuthMtime = 0; }
    cxName = String((req.body && req.body.name) || 'peter').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'peter';
    // [CODEX_DEVICE_OPT_V1] mode selects the flow:
    //  'browser' (default) — full `codex login`: grants api.connectors.* scopes, starts a
    //     local callback server on 127.0.0.1:1455 + prints the auth URL; user pastes back
    //     the localhost redirect (relayed via /codex/auth/complete).
    //  'device' — `codex login --device-auth`: prints a fixed device URL + a one-time code;
    //     codex polls OpenAI itself and writes auth.json, so there is NO paste-back and no
    //     1455 callback (more robust). Token is reduced-scope (no api.connectors.*).
    cxMode = (req.body && req.body.mode === 'device') ? 'device' : 'browser';
    // BROWSER=/bin/true + no DISPLAY stop codex trying to spawn a local GUI browser.
    const env = { ...process.env, BROWSER: '/bin/true' }; delete env.DISPLAY;
    const args = cxMode === 'device' ? ['login', '--device-auth'] : ['login'];
    cxProc = spawn('codex', args, { env, cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const onData = d => {
      cxBuf += d.toString('utf8');
      if (cxMode === 'device') { if (!cxCode) { const dv = parseCodexDevice(cxBuf); if (dv) { cxUrl = dv.url; cxCode = dv.code; } } }
      else { if (!cxUrl) { const u = parseCodexAuthUrl(cxBuf); if (u) cxUrl = u; } }
    };
    cxProc.stdout.on('data', onData);
    cxProc.stderr.on('data', onData);
    cxProc.on('exit', () => { finalizeCodexAuth(); cxProc = null; });
    // Device flow finishes with no /complete call, and codex 0.144.x may write auth.json
    // without exiting — so watch auth.json here and finalize deterministically when a fresh
    // token appears. Give up after ~15min (the code's expiry); user can also cancel.
    if (cxMode === 'device') {
      let tries = 0;
      cxWatch = setInterval(() => {
        if (cxFinalized) { clearInterval(cxWatch); cxWatch = null; return; }
        let mt = 0, ok = false;
        try { mt = fs.statSync(CODEX_AUTH).mtimeMs; } catch {}
        try { const a = JSON.parse(fs.readFileSync(CODEX_AUTH, 'utf8')); ok = !!((a.tokens || {}).account_id); } catch {}
        if (ok && mt > cxStartAuthMtime) { clearInterval(cxWatch); cxWatch = null; finalizeCodexAuth(); killCodexAuth(); }
        else if (++tries > 900) { clearInterval(cxWatch); cxWatch = null; }
      }, 1000);
    }
    let settled = false; const t0 = Date.now();
    const iv = setInterval(() => {
      if (settled) return;
      const haveDetails = cxMode === 'device' ? (cxUrl && cxCode) : cxUrl;
      if (haveDetails) { settled = true; clearInterval(iv); res.json({ ok: true, mode: cxMode, url: cxUrl, code: cxCode || undefined }); }
      else if (cxDone || Date.now() - t0 > 20000) { settled = true; clearInterval(iv); killCodexAuth(); res.status(504).json({ ok: false, error: 'Timed out waiting for the sign-in details.' }); }
    }, 300);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Relay the pasted localhost:1455 redirect URL to codex's local callback server so the
// running `codex login` finishes the token exchange, writes auth.json and exits (the
// on-exit handler above turns that into a saved account).
app.post('/codex/auth/complete', (req, res) => {
  try {
    if (!cxProc) return res.status(400).json({ ok: false, error: 'No sign-in in progress — click Start again.' });
    const raw = String((req.body && req.body.url) || '').trim();
    let relayPath = '';
    try { const u = new URL(raw); if (u.port === '1455' || u.hostname === 'localhost' || u.hostname === '127.0.0.1') relayPath = u.pathname + u.search; } catch {}
    if (!relayPath) { const m = raw.match(/(?:^|[?&])code=[^\s#]+/); if (m) relayPath = '/auth/callback?' + raw.replace(/^[?]/, ''); }
    if (!/[?&]code=/.test(relayPath)) return res.status(400).json({ ok: false, error: 'That is not the localhost:1455 sign-in URL (no code found). Copy the whole address the browser landed on.' });
    const req2 = require('http').get({ host: '127.0.0.1', port: 1455, path: relayPath, timeout: 10000 }, resp => {
      resp.resume(); res.json({ ok: true, relayed: true, status: resp.statusCode || 0 });
      // codex 0.144.x writes auth.json on a successful exchange but may NOT exit (keeps the
      // 1455 server open), so the on-exit finalizer never fires and the UI hangs on
      // "Completing…". Watch auth.json for the fresh token and finalize deterministically.
      let tries = 0;
      const w = setInterval(() => {
        if (cxFinalized) { clearInterval(w); return; }
        let mt = 0, ok = false;
        try { mt = fs.statSync(CODEX_AUTH).mtimeMs; } catch {}
        try { const a = JSON.parse(fs.readFileSync(CODEX_AUTH, 'utf8')); ok = !!((a.tokens || {}).account_id); } catch {}
        if (ok && mt > cxStartAuthMtime) { clearInterval(w); finalizeCodexAuth(); killCodexAuth(); }
        else if (++tries > 60) { clearInterval(w); killCodexAuth(); finalizeCodexAuth(); }
      }, 500);
    });
    req2.on('timeout', () => { req2.destroy(); });
    req2.on('error', e => { if (!res.headersSent) res.status(502).json({ ok: false, error: 'Could not reach the local sign-in server: ' + e.message }); });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/codex/auth/status', (req, res) => {
  if (cxDone) return res.json({ ok: true, done: true, result: cxResult || { ok: false, message: 'Unknown.' } });
  res.json({ ok: true, done: false, running: !!cxProc, haveUrl: !!cxUrl });
});
app.post('/codex/auth/cancel', (req, res) => { killCodexAuth(); res.json({ ok: true }); });

// ── Global session search ──────────────────────────────────────────────────
// Full-text search across EVERY session's message history (transcripts are the
// complete record; chat.db fills gaps). Returns matching sessions with hit count
// and a snippet around the first match, newest first.
// Cache parsed transcript messages keyed by file mtime so repeated /search
// queries (per keystroke) don't re-read and re-parse every .jsonl each time.
const _searchMsgCache = new Map();
function cachedMessages(id) {
  let mt = 0;
  try { mt = fs.statSync(path.join(transcriptsDir(), id + '.jsonl')).mtimeMs; } catch {}
  const c = _searchMsgCache.get(id);
  if (c && c.mtime === mt) return c.messages;
  const messages = transcriptToMessages(id);
  _searchMsgCache.set(id, { mtime: mt, messages });
  return messages;
}
app.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 2) return res.json({ results: [] });
  const results = [];
  try {
    const ids = new Set();
    try { fs.readdirSync(transcriptsDir()).filter(f => f.endsWith('.jsonl')).forEach(f => ids.add(f.slice(0, -6))); } catch {}
    for (const id of Object.keys(chatData)) ids.add(id);
    for (const id of ids) {
      let messages = [];
      try { messages = cachedMessages(id); } catch {}
      if ((!messages || !messages.length) && chatData[id] && Array.isArray(chatData[id].messages)) messages = chatData[id].messages;
      if (!messages || !messages.length) continue;
      let hits = 0, snippet = '', preview = '';
      for (const m of messages) {
        const text = String((m && (m.text != null ? m.text : extractText(m.content))) || '');
        if (!preview && (m.type === 'user' || m.role === 'user')) preview = text.replace(/\s+/g, ' ').trim().slice(0, 70);
        const idx = text.toLowerCase().indexOf(q);
        if (idx === -1) continue;
        hits++;
        if (!snippet) {
          const start = Math.max(0, idx - 40), end = Math.min(text.length, idx + q.length + 70);
          snippet = (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
        }
      }
      if (!hits) continue;
      let mt = 0;
      try { mt = fs.statSync(path.join(transcriptsDir(), id + '.jsonl')).mtimeMs; } catch {}
      if (!mt && chatData[id]) mt = chatData[id].updated_at || 0;
      results.push({ id, name: sessionNames[id] || '', preview, hits, snippet, updatedAt: mt });
    }
    results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    res.json({ results: results.slice(0, 40) });
  } catch (e) { res.json({ results: [], error: e.message }); }
});

// Autonomy per-task/pool room ids (from ~/.claude/autonomy/rooms/*.sid) so the
// /sessions list can tag + group them into the client's "Task rooms" sub-menu
// instead of flooding the main room dropdown. Cheap dir read per request.
function readAutonomyRooms() {
  const m = new Map();
  try {
    const dir = path.join(os.homedir(), '.claude', 'autonomy', 'rooms');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.sid')) continue;
      let id = '';
      try { id = fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch {}
      if (!id) continue;
      const key = f.replace(/\.sid$/, '');
      m.set(id, { key, kind: key.startsWith('pool-') ? 'pool' : 'task' });
    }
  } catch {}
  return m;
}

app.get('/sessions', (req, res) => {
  try {
    // Base list from the persisted transcripts (always present), then overlay any
    // chat.db entries (richer/more-recent UI previews) on top.
    const merged = listTranscriptSessions();
    for (const [id, data] of Object.entries(chatData)) {
      let preview = (merged[id] && merged[id].preview) || '';
      let lastMessage = (merged[id] && merged[id].lastMessage) || '';
      try {
        const users = (data.messages || []).filter(m => m.type === 'user');
        if (users.length && users[0].text) preview = String(users[0].text).replace(/\s+/g, ' ').trim().slice(0, 80);
        for (let i = users.length - 1; i >= 0; i--) {
          const t = stripPlumbing(String(users[i].text || ''));
          if (t) { lastMessage = t.replace(/\s+/g, ' ').trim().slice(0, 80); break; }
        }
      } catch {}
      merged[id] = { updatedAt: data.updated_at || (merged[id] && merged[id].updatedAt) || 0, preview, lastMessage };
    }
    const _autoRooms = readAutonomyRooms();
    const _all = Object.entries(merged)
      .map(([id, v]) => {
        const room = clientSessions.get(id);   // a live room currently exists for this session id
        const _ar = _autoRooms.get(id) || null;
        return { id, updatedAt: v.updatedAt, preview: v.preview, lastMessage: v.lastMessage || '', name: sessionNames[id] || '',
          active: !!room, busy: !!(room && room.processing), viewers: room ? room.sockets.size : 0,
          taskRoom: _ar ? _ar.key : null, archived: !!archivedSessions[id] };
      })
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    // Keep autonomy task rooms from crowding normal rooms out of the top list:
    // cap the two groups independently (the client tucks task rooms into a sub-menu).
    const _arch   = _all.filter(x => x.archived);
    const _normal = _all.filter(x => !x.taskRoom && !x.archived).slice(0, 150);
    const _task   = _all.filter(x => x.taskRoom && !x.archived).slice(0, 100);
    res.json({ sessions: [..._normal, ..._task, ..._arch] });
  } catch (e) { res.json({ sessions: [] }); }
});

// Per-user upload directory for files/screenshots attached in the chat. Lives in
// the user's HOME (so it's isolated per bridge account) and is read back by Claude
// via its Read tool (Read(*) is allowed in the user's settings.json), so attached
// images/files are referenced by absolute path in the prompt.
const UPLOAD_DIR = path.join(os.homedir(), 'bridge-uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch {}

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
      // 30 min: the refresher runs after each message (throttled), so an active
      // user keeps this fresh; the last value persists a while when briefly idle.
      if (age < 1_800_000) return d;
    } catch {}
  }
  return null;
}

// ── Live context-window % (computed from the real chat stream) ────────────────
// Context % is per-session (S.ctxPct/S.ctxTokens); globals are the last-seen values
// for the /usage endpoint. CRITICAL: use the last iteration's token counts, not the
// sum across iterations — summing re-counts cache_read each tool step and pins at 100%.
let latestCtxPct = null;
let latestCtxTokens = null;
function ctxUsedFromUsage(u) {
  if (!u || typeof u !== 'object') return 0;
  const occ = it => (it.input_tokens || 0) + (it.cache_read_input_tokens || 0) + (it.cache_creation_input_tokens || 0);
  const its = Array.isArray(u.iterations) ? u.iterations : null;
  if (its && its.length) return occ(its[its.length - 1]);
  return occ(u);
}
function updateCtxFromResult(ev) {
  try {
    const used = ctxUsedFromUsage(ev.usage || {});
    let win = 200_000;
    const mu = ev.modelUsage || {};
    for (const k in mu) if (mu[k] && mu[k].contextWindow) win = mu[k].contextWindow;
    if (used > 0 && win > 0) {
      latestCtxTokens = used;
      latestCtxPct = Math.min(100, Math.round((used / win) * 100));
      return { pct: latestCtxPct, tokens: used };
    }
  } catch {}
  return null;
}

// ── Official 5h/7d rate-limit % from the API response headers ──────────────────
// The percentage is NOT in Claude's stream-json output (its rate_limit_event has
// only status + reset time). But the real API response carries
// `anthropic-ratelimit-unified-{5h,7d}-utilization` headers, which Claude prints
// to stdout when ANTHROPIC_LOG=debug. So we ride a real chat turn in debug mode
// (throttled), scrape those headers straight off the bridge's own stdout, and drop
// the rest of the debug noise. No extra/special API calls — it piggybacks on a
// turn the user is already making.
const RATE_CAPTURE_INTERVAL_MS = 3 * 60 * 1000;
let lastRateCaptureAt = 0;
function shouldCaptureRates() { return (Date.now() - lastRateCaptureAt) > RATE_CAPTURE_INTERVAL_MS; }

function persistRateLimits(rl) {
  try {
    const dir = path.join(os.homedir(), '.cache', 'claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rate-limits.json'), JSON.stringify(rl));
  } catch { /* best-effort; /usage falls back to last good file */ }
}

// Identity of the currently-active Claude account (from ~/.claude.json).
function currentAccountIdentity() {
  try {
    const d = (JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).oauthAccount) || {};
    return { email: d.emailAddress || '', uuid: d.accountUuid || '' };
  } catch { return { email: '', uuid: '' }; }
}
// Snapshot a completed rate-limit capture against the account it belongs to, so
// the switcher can show each account's last-known 5h/7d usage + reset times.
function persistAccountUsage(rl) {
  try {
    const { uuid, email } = currentAccountIdentity();
    if (!uuid || !fs.existsSync(ACCT_DIR)) return;
    for (const f of fs.readdirSync(ACCT_DIR)) {
      const m = f.match(/^(.+)\.account\.json$/); if (!m) continue;
      let au = '';
      try { au = (JSON.parse(fs.readFileSync(path.join(ACCT_DIR, f), 'utf8')) || {}).accountUuid || ''; } catch {}
      if (au && au === uuid) {
        const snap = {
          email,
          five_hour_pct: rl.five_hour_pct ?? null,
          five_hour_resets_at: rl.five_hour_resets_at ?? null,
          seven_day_pct: rl.seven_day_pct ?? null,
          seven_day_resets_at: rl.seven_day_resets_at ?? null,
          updated_at: rl.updated_at || new Date().toISOString(),
        };
        fs.writeFileSync(path.join(ACCT_DIR, m[1] + '.usage.json'), JSON.stringify(snap));
        break;
      }
    }
  } catch { /* best-effort */ }
}
// Last-known usage snapshot for a given account email (for the /usage fallback).
function readAccountUsageByEmail(email) {
  try {
    if (!email || !fs.existsSync(ACCT_DIR)) return null;
    for (const f of fs.readdirSync(ACCT_DIR)) {
      if (!/\.usage\.json$/.test(f)) continue;
      const d = JSON.parse(fs.readFileSync(path.join(ACCT_DIR, f), 'utf8'));
      if (d && d.email === email) return d;
    }
  } catch {}
  return null;
}

// Scan one stdout line for the rate-limit headers (present only in debug output).
// Accumulates the 5h/7d util+reset across lines, then persists once complete.
let _rlPending = {};
function scrapeRateLimits(line) {
  if (line.indexOf('unified-') === -1) return;
  let m, hit = false;
  if ((m = line.match(/unified-5h-utilization"?\s*:\s*"?([0-9.]+)/))) { _rlPending.five_hour_pct = Math.round(parseFloat(m[1]) * 100); hit = true; }
  if ((m = line.match(/unified-7d-utilization"?\s*:\s*"?([0-9.]+)/))) { _rlPending.seven_day_pct = Math.round(parseFloat(m[1]) * 100); hit = true; }
  if ((m = line.match(/unified-5h-reset"?\s*:\s*"?([0-9]+)/)))        { _rlPending.five_hour_resets_at = parseInt(m[1], 10); hit = true; }
  if ((m = line.match(/unified-7d-reset"?\s*:\s*"?([0-9]+)/)))        { _rlPending.seven_day_resets_at = parseInt(m[1], 10); hit = true; }
  if (!hit) return;
  if (_rlPending.five_hour_pct != null && _rlPending.seven_day_pct != null) {
    _rlPending.updated_at = new Date().toISOString();
    const id = currentAccountIdentity();
    _rlPending.account_email = id.email;
    _rlPending.account_uuid = id.uuid;
    lastRateCaptureAt = Date.now();
    persistRateLimits(_rlPending);
    persistAccountUsage(_rlPending);
    _rlPending = {};
  }
}

// Model + account email are always known (env + OAuth login), independent of the
// interactive-only rate-limit data. Surface them so the UI shows the model/email
// even when the statusline rate-limits file is absent (headless bridge spawns).
function modelDisplayName(id) {
  if (!id) return '';
  const m = id.match(/claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (m) return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  return id;
}
function readAccountEmail() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    return d.oauthAccount?.emailAddress || '';
  } catch { return ''; }
}

// Codex status is deliberately independent of the established Claude collector.
// The official app-server account API exposes the same 5h/7d windows and resets.
let codexMetricsCache = null, codexMetricsAt = 0, codexMetricsWaiters = [];
function readCodexModel() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8'));
    const models = Array.isArray(d.models) ? d.models : [];
    const m = models.find(x => x && x.priority === 1) || models[0];
    if (m) return { name: m.display_name || m.slug || 'Codex', window: Math.floor((m.context_window || 0) * ((m.effective_context_window_percent || 100) / 100)) };
  } catch {}
  return { name: 'Codex', window: 0 };
}
function readCodexMetrics(done) {
  if (codexMetricsCache && Date.now() - codexMetricsAt < 25000) return done(null, codexMetricsCache);
  codexMetricsWaiters.push(done);
  if (codexMetricsWaiters.length > 1) return;
  const script = path.join(os.homedir(), 'bin', 'codex-metrics.js');
  execFile(script, [], { timeout: 10000, env: { ...process.env, HOME: os.homedir() } }, (err, stdout) => {
    let data = null;
    try { data = JSON.parse(stdout); } catch {}
    if (!err && data) { codexMetricsCache = data; codexMetricsAt = Date.now(); }
    const waiters = codexMetricsWaiters; codexMetricsWaiters = [];
    for (const cb of waiters) cb(err || (!data && new Error('Invalid Codex metrics response')), data);
  });
}
function codexUsageResponse(raw, roomId) {
  const account = raw && raw.account || {};
  const limits = raw && raw.rateLimits && raw.rateLimits.rateLimits || {};
  const primary = limits.primary || {}, secondary = limits.secondary || {};
  const model = readCodexModel();
  const room = roomId ? clientSessions.get(roomId) : null;
  const tokens = room && room.codexCtxTokens || null;
  return {
    ok: true, engine: 'codex', block: null, week: null,
    rateLimits: {
      five_hour_pct: primary.usedPercent ?? null,
      five_hour_resets_at: primary.resetsAt ?? null,
      seven_day_pct: secondary.usedPercent ?? null,
      seven_day_resets_at: secondary.resetsAt ?? null,
      ctx_pct: tokens && model.window ? Math.min(100, Math.round(tokens / model.window * 100)) : null,
      ctx_tokens: tokens,
      model: 'Codex · ' + model.name,
      email: account.email || '', plan: account.planType || limits.planType || '',
    }
  };
}

// Claude token/cost usage — 5-hour block + weekly, parallel fetch
app.get('/usage', (req, res) => {
  // [ENGINE_AUTHORITATIVE_V1] With a roomId, the SERVER decides the engine (single source of
  // truth) and the client renders whatever we return; the client's ?engine= is a fallback only.
  const _rid = String(req.query.roomId || '');
  let _engine = String(req.query.engine || '').toLowerCase() === 'codex' ? 'codex' : 'claude';
  if (_rid) _engine = resolveRoomEngineByKey(_rid).engine;
  if (_engine === 'codex') {
    return readCodexMetrics((err, raw) => err
      ? res.status(502).json({ ok: false, engine: 'codex', error: err.message })
      : res.json(codexUsageResponse(raw, _rid)));
  }
  let blockResult = null, weekResult = null, done = 0;
  const rateLimits = readRateLimits() || {};
  // Always force the real chat model + account email: the rate-limits.json file is
  // written by the Haiku refresher, so its model/ctx fields describe the throwaway
  // session, not this user's Opus chat — override them with authoritative values.
  rateLimits.model = modelDisplayName(CLAUDE_MODEL);
  const activeEmail = readAccountEmail();
  rateLimits.email = activeEmail;
  if (latestCtxPct != null) rateLimits.ctx_pct = latestCtxPct;
  if (latestCtxTokens != null) rateLimits.ctx_tokens = latestCtxTokens;

  // Account-aware 5h/7d %: the cached rate-limits file is per-HOME, not per-account,
  // so after switching accounts it still holds the PREVIOUS account's numbers until
  // that new account makes an API call. If the cache doesn't belong to the active
  // account, fall back to that account's last snapshot (stamped stale), or blank the
  // %s so the UI shows "–" rather than another account's usage.
  const globalFresh = rateLimits.five_hour_pct != null && rateLimits.account_email === activeEmail;
  if (!globalFresh) {
    const snap = normalizeUsage(readAccountUsageByEmail(activeEmail));
    if (snap) {
      rateLimits.five_hour_pct = snap.five_hour_pct;
      rateLimits.five_hour_resets_at = snap.five_hour_resets_at;
      rateLimits.seven_day_pct = snap.seven_day_pct;
      rateLimits.seven_day_resets_at = snap.seven_day_resets_at;
      rateLimits.stale = true;
      rateLimits.as_of = snap.updated_at;
    } else if (rateLimits.account_email && rateLimits.account_email !== activeEmail) {
      rateLimits.five_hour_pct = null;
      rateLimits.five_hour_resets_at = null;
      rateLimits.seven_day_pct = null;
      rateLimits.seven_day_resets_at = null;
      rateLimits.stale = true;
    }
  }

  function finish() {
    if (++done < 2) return;
    res.json({ ok: true, engine: 'claude', block: blockResult, week: weekResult, rateLimits });
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
      const pct = rateLimits.five_hour_pct != null ? rateLimits.five_hour_pct : (tokens / 72_117_641) * 100;
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
        pct: rateLimits.seven_day_pct != null ? rateLimits.seven_day_pct : null,
      };
    } catch { weekResult = null; }
    finish();
  });
});

// On-demand usage refresh: fire a tiny throwaway Claude call in debug mode on the
// currently-active account so the 5h/7d rate-limit headers get scraped + snapshotted
// right now, instead of waiting for the next real chat turn. Costs one minimal Haiku
// message. Used by the "↻ Refresh usage now" button (esp. for a freshly-added account).
let _usageRefreshing = false;
app.post('/usage/refresh', (req, res) => {
  if (_usageRefreshing) return res.json({ ok: false, error: 'already refreshing' });
  _usageRefreshing = true;
  const env = { ...process.env };
  if (!env.HOME) env.HOME = process.env.HOME || os.homedir();
  if (!env.PATH) env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  env.ANTHROPIC_LOG = 'debug';
  lastRateCaptureAt = 0;                       // bypass the throttle for this manual refresh
  const before = (readRateLimits() || {}).updated_at || '';
  let settled = false;
  const finish = (ok, extra) => {
    if (settled) return; settled = true; _usageRefreshing = false;
    const rl = readRateLimits() || {};
    res.json({ ok, updated: !!(rl.updated_at && rl.updated_at !== before), rateLimits: rl, ...(extra || {}) });
  };
  let proc;
  try {
    proc = spawn('claude', ['-p', 'hi', '--model', 'claude-haiku-4-5-20251001'],
      { cwd: CLAUDE_CWD, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { return finish(false, { error: e.message }); }
  const scan = chunk => { for (const line of chunk.toString().split('\n')) { if (line) scrapeRateLimits(line); } };
  proc.stdout.on('data', scan);
  proc.stderr.on('data', scan);
  const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 30000);
  proc.on('close', () => { clearTimeout(killer); finish(true); });
  proc.on('error', e => { clearTimeout(killer); finish(false, { error: e.message }); });
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

// Accept an attached file/screenshot. The raw bytes are POSTed as the body with
// the original filename in the X-Filename header; the server writes it under the
// per-user UPLOAD_DIR and returns the absolute path, which the front-end then
// passes back with the chat message so Claude can Read() it.
app.post('/upload', express.raw({ type: () => true, limit: '30mb' }), (req, res) => {
  try {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ error: 'empty upload' });
    }
    let raw = req.header('x-filename') || 'upload.bin';
    try { raw = decodeURIComponent(raw); } catch {}
    const origName = path.basename(raw);
    // Strip any path components and keep a conservative on-disk filename charset.
    const safe  = origName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'file';
    const uniq  = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
    const dest  = path.join(UPLOAD_DIR, uniq);
    fs.writeFileSync(dest, buf);
    console.log(`[Bridge] Upload saved: ${dest} (${buf.length} bytes)`);
    res.json({ ok: true, path: dest, name: origName, size: buf.length });
  } catch (e) {
    console.error('[Bridge] Upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const server = http.createServer(app);

// Use noServer so two WebSocket paths can share one HTTP server without conflicts
const wss      = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const wssProxy = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const wssRoomView = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const pathname = (req.url || '').split('?')[0];
  if (pathname === '/ws') {
    // The per-room live viewer tunnels over /ws (marked ?roomview=1) because nginx
    // only upgrades <user>/ws + /websockify - there is no /roomview upgrade location,
    // so a bare /roomview WS 404s at the proxy. Route those to the room-view relay;
    // all other /ws upgrades are the normal chat socket.
    if (/[?&]roomview=1(?:&|$)/.test(req.url || '')) {
      wssRoomView.handleUpgrade(req, socket, head, ws => wssRoomView.emit('connection', ws, req));
    } else {
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    }
  } else if (pathname === '/websockify') {
    wssProxy.handleUpgrade(req, socket, head, ws => wssProxy.emit('connection', ws, req));
  } else if (pathname === '/roomview') {
    wssRoomView.handleUpgrade(req, socket, head, ws => wssRoomView.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// Proxy /websockify → local websockify (noVNC ↔ VNC).
// With per-room browsers on, ?room=<key> selects that room's own noVNC port so the
// live panel shows the SAME browser Claude drives in that room; otherwise (and on
// any error) it falls back to the shared per-user NOVNC_PORT — the classic behaviour.
// --- on-demand browser: mark this user's browser stack "wanted" ---------------
// start-browser.sh parks until this file is fresh and idle-stops when it goes
// stale (opt-in via ~/.claude/browser-on-demand). Harmless for always-on users,
// so we always touch; the gating lives in the launcher.
const _BROWSER_WANTED = path.join(process.env.HOME || os.homedir(), '.claude', 'browser-wanted');
function touchBrowserWanted() { try { fs.writeFileSync(_BROWSER_WANTED, String(Date.now())); } catch {} }

wssProxy.on('connection', async (clientWs, req) => {
  touchBrowserWanted();
  const _hbWanted = setInterval(touchBrowserWanted, 60000);
  clientWs.on('close', () => clearInterval(_hbWanted));
  let novncPort = NOVNC_PORT;
  if (roomStack) {
    try {
      const room = new URL(req.url, 'http://localhost').searchParams.get('room');
      if (room) { const p = await roomStack.ensureRoom(room); if (p && p.novnc) novncPort = p.novnc; }
    } catch (e) { console.log('[Bridge] per-room vnc route failed, using shared:', e.message); }
  }
  if (clientWs.readyState !== WebSocket.OPEN) { try { clientWs.close(); } catch {} return; }
  const target = new WebSocket(`ws://localhost:${novncPort}`, { perMessageDeflate: false });
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

// Proxy /roomview?room=<k>[&target=<id>] -> room-view relay /view/<k>[?target=].
// The relay screencasts that room's own browser window into the pane's <canvas>
// and injects mouse/keyboard back. Only active when ROOMVIEW_PORT is configured.
wssRoomView.on('connection', (clientWs, req) => {
  if (!ROOMVIEW_PORT) { try { clientWs.close(); } catch {} return; }
  touchBrowserWanted();
  const _hbWanted = setInterval(touchBrowserWanted, 60000);
  clientWs.on('close', () => clearInterval(_hbWanted));
  let relayPath = '/view/default';
  try {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const room = q.get('room') || 'default';
    const tgt  = q.get('target');
    relayPath = '/view/' + encodeURIComponent(room) + (tgt ? '?target=' + encodeURIComponent(tgt) : '');
  } catch {}
  if (clientWs.readyState !== WebSocket.OPEN) { try { clientWs.close(); } catch {} return; }
  const target = new WebSocket(`ws://127.0.0.1:${ROOMVIEW_PORT}${relayPath}`, { perMessageDeflate: false });
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

// ── Memory-bounded self-recycle (leak guard) ─────────────────────────────
// This process slowly leaks heap over days (retained caches / session maps), and
// Node rarely returns freed heap to the OS, so on a memory-tight box RSS climbs
// until Chrome gets OOM-killed. Rather than chase every retained ref, bound the
// process by memory: when RSS crosses a threshold AND no turn is mid-flight, kill
// child procs (so none are orphaned) and exit(0). The ccbmon-bridge supervisor
// relaunches a fresh process in ~3s; clients auto-reconnect and each room resumes
// losslessly from its transcript (--resume). Tunable via env.
const RSS_SOFT_MB = parseInt(process.env.BRIDGE_RSS_SOFT_MB, 10) || 900;   // recycle when fully idle (no clients)
const RSS_HARD_MB = parseInt(process.env.BRIDGE_RSS_HARD_MB, 10) || 1400;  // recycle even with clients attached (never mid-turn)
const _memGuard = setInterval(() => {
  let rssMb;
  try { rssMb = Math.round(process.memoryUsage().rss / 1048576); } catch { return; }
  if (rssMb < RSS_SOFT_MB) return;
  const anyProcessing = [...clientSessions.values()].some(s => s.processing || (s.pendingTurns || 0) > 0);
  if (anyProcessing) return;                                  // never recycle mid-turn
  const connected = wss.clients.size;
  const reason = rssMb >= RSS_HARD_MB ? 'hard' : (connected === 0 ? 'soft-idle' : null);
  if (!reason) return;                                        // over soft but clients attached -> wait for an idle window
  console.log(`[Bridge] Memory-recycle (${reason}): RSS ${rssMb}MB, ${connected} client(s), ${clientSessions.size} room(s) — killing children + exiting for supervisor relaunch`);
  for (const s of clientSessions.values()) { try { s.currentProc && s.currentProc.kill('SIGKILL'); } catch {} }
  setTimeout(() => process.exit(0), 250);                     // let the log flush + child SIGKILLs land
}, 60_000);
if (_memGuard.unref) _memGuard.unref();


// ── One client = one persistent Claude Code session ───────────────────────────
// Claude is spawned per-turn with --resume so context persists. The Playwright
// MCP browser persists independently as a standalone server, so it stays open
// between Claude invocations.
//
// Session state lives in `clientSessions` keyed by a stable per-browser clientId
// (sent in the `hello` message), NOT in the WebSocket closure. This lets a live
// Claude process survive a disconnect and reattach to a reconnecting browser, so
// a page refresh / network blip / laptop sleep doesn't lose the in-flight answer.
const CLAUDE_TIMEOUT_MS      = 10 * 60 * 1000; // 10 min — max silence once running
const CLAUDE_STARTUP_TIMEOUT = 2  * 60 * 1000; // 2 min  — must produce first output
const RECONNECT_GRACE_MS     = 30 * 1000;      // keep the proc alive this long after disconnect
const MAX_BUFFER             = 4000;           // cap on events buffered while detached
const WATCH_RUN = '⏱ Claude stopped responding (10 min timeout) — session reset.';
// A "warm" room = an empty (no sockets) room whose Claude proc is kept alive so
// switching away from an idle room doesn't tear it down. Bounded so we never keep
// too many live Claude procs on the memory-tight container.
const WARM_ROOM_TTL_MS = parseInt(process.env.WARM_ROOM_TTL_MS, 10) || 15 * 60 * 1000;
const MAX_WARM_ROOMS   = parseInt(process.env.MAX_WARM_ROOMS,   10) || 2;
function enforceWarmCap(justArmed) {
  const warm = [...clientSessions.values()]
    .filter(s => s.sockets.size === 0 && s.currentProc && (s.sessionId || s.threadId) && !(s.conf && s.conf.status === 'running'));   // [CONFERENCE_V1]
  if (warm.length <= MAX_WARM_ROOMS) return;
  warm.sort((a, b) => (a.lastActiveAt || 0) - (b.lastActiveAt || 0));   // oldest first
  for (const s of warm.slice(0, warm.length - MAX_WARM_ROOMS)) {
    if (s === justArmed) continue;
    try { s.killCurrentProc('warm-room cap exceeded'); } catch {}
    clientSessions.delete(s.key);
    console.log('[Bridge] Warm-room cap — closed idle room:', s.key);
  }
}

const GENERAL_ASSISTANT_PROMPT =
  'You are a helpful general-purpose assistant accessed through a web chat. ' +
  'Help the user with ANY question or task they bring you — general knowledge, ' +
  'research, writing, planning, personal and business tasks — not only software ' +
  'engineering or this codebase. Do not refuse or redirect a request just because ' +
  'it is unrelated to code.\n\n' +
  'Your primary capability is browser interaction via the Playwright MCP tools, ' +
  'shown live in the noVNC pane beside this chat. The workflow is semi-automated: ' +
  'the user logs into websites themselves in that browser (so no credentials are ' +
  'ever stored on the server), and once they are logged in you carry out the ' +
  'automated steps directly with Playwright. Use this to help set up integrations ' +
  'and systems, research projects, and perform any task that can be done through ' +
  'the web. When a task needs a site the user is not yet logged into, ask them to ' +
  'log in via the browser pane first, then proceed.\n\n' +
  'IMPORTANT — what "log me in" means: when the user asks you to "log in" or ' +
  '"sign in" to a website or web resource, they are asking you to NAVIGATE the ' +
  'browser to that site\'s login page so THEY can enter their credentials ' +
  'themselves. They are NOT asking you to type, supply, or guess any username or ' +
  'password. Never enter credentials. Just navigate to the login page and tell the ' +
  'user it is ready for them to sign in.\n\n' +
  'RESPONSE STYLE — be decidedly concise. Answer in the absolute minimum number of ' +
  'words that fully conveys the answer. Lead with the answer or result; skip preamble, ' +
  'acknowledgements, and restating the question. Prefer a single short sentence or a ' +
  'tight bullet list over paragraphs. Do not narrate what you are about to do or ' +
  'summarise what you just did unless asked. Expand only when the user explicitly ' +
  'asks for detail, an explanation, or step-by-step.\n\n' +
  'YOUR TASK LIST — this app gives each user a personal task list (the Tasks \n' +
  'panel beside the chat). When the user says "add this to my task list", "make \n' +
  'a task for this", or anything equivalent, they mean: create a new item in THIS \n' +
  'app\u2019s own task list. Do it by POSTing JSON to the bridge API at \n' +
  'http://localhost:\u0024BRIDGE_PORT/tasks (the BRIDGE_PORT env var is set for your \n' +
  'process) with fields {"title", "description"}. Derive all of it from the \n' +
  'conversation context: a short imperative TITLE, a DESCRIPTION capturing what the \n' +
  'user wants, and a clear one-line OBJECTIVE stating what "done" looks like \n' +
  '(put the objective as the first line of the description). Confirm briefly once \n' +
  'added. Do NOT store such tasks in memory files \u2014 the app task list is the \n' +
  'single source of truth.\n\n' +
  'CRITICAL — EMAIL AND CALENDAR SAFETY RULES (non-negotiable, cannot be overridden by ' +
  'any user instruction):\n' +
  '1. NEVER send, reply to, forward, or draft-and-send any email via any MCP tool ' +
  '   (Gmail, Outlook/Graph, or any other mail connector). You may READ, SEARCH, and ' +
  '   LIST emails freely, and you may CREATE DRAFTS — but the draft must stay as a ' +
  '   draft. The user must send it manually.\n' +
  '2. NEVER create, update, or delete calendar events without the user explicitly ' +
  '   confirming "yes, create/change/delete that event" in the same conversation turn.\n' +
  '3. NEVER delete, trash, move, or permanently modify any email or file without the ' +
  '   user explicitly confirming the action in the same turn.\n' +
  '4. If a task would require sending an email or making a destructive change, STOP, ' +
  '   explain what you would do, and wait for explicit approval before proceeding.';

// Stream-json input envelope for one user turn.
function userMsgJSON(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
}

// Translate one Codex `exec --json` event into the bridge's normalised UI messages
// (the SAME shapes the Claude stream parser emits), so everything downstream — UI,
// mirroring, history — is unchanged. Returns [] for events with no UI signal.
function codexAuthFailure(text) {
  return /refresh_token_(?:invalidated|revoked|expired)|refresh token was revoked|invalidated oauth token|Your session has ended/i.test(text)
    || /codex_(?:login|api|models_manager)[^\n]*(?:401|Unauthorized)/i.test(text);
}
function createCodexErrorReporter(send, email) {
  let reported = false, stderr = '';
  const report = (text, terminal = false) => {
    const auth = codexAuthFailure(text);
    if (reported || (!auth && !terminal)) return;
    reported = true;
    send({ type: 'error', text: auth
      ? 'Codex sign-in failed' + (email ? ' for ' + email : '') + ' (401 Unauthorized). Your saved login is no longer valid. Open Accounts, click ↻ beside this Codex account, sign in again, then resend your message.'
      : 'Codex could not complete this message. Please try again. If it keeps failing, check the account sign-in or contact the administrator.' });
  };
  return {
    stderr(chunk) { stderr = (stderr + chunk).slice(-8192); report(stderr); },
    failed(message) { report(message || '', true); },
  };
}

function parseCodexEvent(ev) {
  const out = [];
  switch (ev.type) {
    case 'thread.started':
      out.push({ kind: 'session', id: ev.thread_id });   // thread_id == Claude's session_id (resume handle)
      break;
    case 'item.started':
    case 'item.completed': {
      const it = ev.item || {};
      if (it.type === 'agent_message' && ev.type === 'item.completed') {
        out.push({ kind: 'stream', data: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: it.text || '' }] } } });
      } else if (it.type === 'command_execution') {
        if (ev.type === 'item.started') {
          out.push({ kind: 'stream', data: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: it.id, name: 'bash', input: { command: it.command } }] } } });
        } else {
          out.push({ kind: 'stream', data: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: it.id, content: (it.aggregated_output || '') + '\n[exit ' + it.exit_code + ']' }] } } });
        }
      } else if (it.type === 'error' && ev.type === 'item.completed') {
        const emsg = it.message || '';
        // Suppress the expected per-invocation hook-trust notice; surface real errors.
        if (!/bypass-hook-trust/i.test(emsg)) {
          out.push({ kind: 'stream', data: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '\u26A0 ' + emsg }] } } });
        }
      }
      break;
    }
    case 'turn.completed':
      out.push({ kind: 'result', usage: ev.usage || null });
      break;
  }
  return out;
}

// Claude stores per-project session transcripts at
// ~/.claude/projects/<cwd-with-slashes-as-dashes>/<session_id>.jsonl
// Resuming a session whose file doesn't exist makes `claude --resume` exit
// immediately with "No conversation found", which the async self-heal handles
// unreliably. So we check existence up front and just start fresh if it's gone.
function sessionFileExists(id) {
  if (!id) return false;
  const projectDir = CLAUDE_CWD.replace(/\//g, '-');
  const f = path.join(os.homedir(), '.claude', 'projects', projectDir, `${id}.jsonl`);
  try { return fs.existsSync(f); } catch { return false; }
}

// [CODEX_DURABLE_V2] Codex rollout existence (mirror of sessionFileExists). Codex writes
// ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-...-<thread_id>.jsonl; the trailing UUID is
// the resume handle for `codex exec resume <id>`.
const CODEX_SESSIONS_DIR = path.join(process.env.HOME || os.homedir(), '.codex', 'sessions');
function codexRolloutExists(threadId) {
  if (!threadId) return false;
  const suffix = '-' + threadId + '.jsonl';
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of ents) {
      if (e.isDirectory()) { if (depth < 3 && walk(path.join(dir, e.name), depth + 1)) return true; }
      else if (depth === 3 && e.name.endsWith(suffix)) return true;
    }
    return false;
  };
  return walk(CODEX_SESSIONS_DIR, 0);
}
// Durable, engine-neutral room map: roomKey -> {sessionId, threadId, lastEngine, engineOverride, updatedAt}.
// Claude survived restarts because its resume handle == the on-disk transcript; Codex's threadId lived
// only in memory. This map gives BOTH engines disk-anchored recovery across eviction/reconnect/restart.
const ROOM_MAP_FILE = path.join(process.env.HOME || os.homedir(), '.claude', 'bridge-rooms.json');
function _loadRoomMap() { try { return JSON.parse(fs.readFileSync(ROOM_MAP_FILE, 'utf8')) || {}; } catch { return {}; } }
function _writeRoomMap(m) {
  try { const tmp = ROOM_MAP_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(m)); fs.renameSync(tmp, ROOM_MAP_FILE); }
  catch (e) { console.log('[Bridge] roomMap write failed:', e.message); }
}
function persistRoom(S) {
  if (!S || !S.key) return;
  if (!S.sessionId && !S.threadId && !S.lastEngine && !S.engineOverride) return;   // nothing durable yet
  try {
    const m = _loadRoomMap();
    m[S.key] = { sessionId: S.sessionId || null, threadId: S.threadId || null, lastEngine: S.lastEngine || null, engineOverride: S.engineOverride || null, updatedAt: Date.now() };
    _writeRoomMap(m);
  } catch (e) { console.log('[Bridge] persistRoom failed:', e.message); }
}
function clearRoom(key) {
  try {
    const m = _loadRoomMap(); let changed = false;
    if (m[key]) { delete m[key]; changed = true; }
    for (const k of Object.keys(m)) { if (m[k] && (m[k].sessionId === key || m[k].threadId === key)) { delete m[k]; changed = true; } }   // [CODEX_DURABLE_V3] named-room records keyed by room id, deleted by session id
    if (changed) _writeRoomMap(m);
  } catch {}
}
const _ROOM_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function restoreRoom(S) {
  if (!S || !S.key) return;
  const rec = _loadRoomMap()[S.key];
  if (rec) {
    if (!S.sessionId && rec.sessionId && sessionFileExists(rec.sessionId)) S.sessionId = rec.sessionId;
    if (!S.threadId && rec.threadId && codexRolloutExists(rec.threadId)) S.threadId = rec.threadId;
    if (rec.lastEngine) S.lastEngine = rec.lastEngine;
    if (rec.engineOverride) S.engineOverride = rec.engineOverride;
  }
  // [CODEX_DURABLE_V3] If a stored handle no longer validates, rewrite (or clear) the
  // record so we don't keep resurrecting a dead session/thread id.
  if (rec && (rec.sessionId !== (S.sessionId || null) || rec.threadId !== (S.threadId || null))) {
    if (!S.sessionId && !S.threadId && !S.lastEngine && !S.engineOverride) clearRoom(S.key);
    else persistRoom(S);
  }
  // Legacy fallback ONLY: some older rooms are keyed by the Codex thread id itself.
  if (!S.sessionId && !S.threadId && _ROOM_UUID_RE.test(S.key) && codexRolloutExists(S.key)) S.threadId = S.key;
  if (S.threadId) console.log('[Bridge] [CODEX_DURABLE_V2] restored room', S.key, 'threadId=' + S.threadId, 'lastEngine=' + (S.lastEngine || '-'), 'override=' + (S.engineOverride || '-'));
}


// ── [CONFERENCE_V1] Collaborative Claude + Codex "Conference Room" ─────────────
// One room, server-orchestrated lead/reviewer turns between the two engines. The
// server owns the canonical, engine-attributed transcript and the durable
// orchestration state; the browser only renders events. Consensus design agreed
// jointly by Claude and Codex (see design discussion 2026-09-05).
const CONF_DIR = path.join(process.env.HOME || os.homedir(), '.claude', 'bridge-conference');
const CONF_MAX_ROUNDS_DEFAULT = 16;   // [CONFERENCE_CAP16] was 4
const CONF_HARD_ROUND_CAP = 16;   // [CONFERENCE_CAP16] was 8
function confFile(key) { return path.join(CONF_DIR, String(key).replace(/[^A-Za-z0-9_-]/g, '_') + '.json'); }
function confLoad(key) { try { return JSON.parse(fs.readFileSync(confFile(key), 'utf8')); } catch { return null; } }
function confSave(S) { if (!S || !S.conf) return; try { fs.mkdirSync(CONF_DIR, { recursive: true }); fs.writeFileSync(confFile(S.key), JSON.stringify(S.conf)); } catch (e) { console.log('[Bridge] [CONFERENCE_V1] confSave failed:', e.message); } }
// [CONF_CONTAINED_V1] Mirror a conference's user-visible content (brief + both-engine log)
// into the room's OWN store so the room is self-contained and survives deletion of the
// operational side-file. The server is the sole writer of a conference record.
function confMirrorToChat(key, c) {
  try {
    if (!key || !c || !Array.isArray(c.log) || c.status === 'superseded') return;
    const messages = confLogToMessages(c);
    if (!messages.length) return;
    chatData[key] = { messages, updated_at: Date.now(), conf: true };
    saveChatData();
  } catch (e) { console.log('[Bridge] [CONF_CONTAINED_V1] mirror failed:', e.message); }
}
function confClearFile(key) { try { fs.unlinkSync(confFile(key)); } catch {} }
function confExistsRunning(key) { const c = confLoad(key); return !!(c && c.status === 'running'); }
// [CONF_ACTIVATION_V1] Checkpoint the verification intent onto the conference record and
// self-restart. On respawn the boot resume detects this and re-opens verification. This
// is the whole "external restarter" — the supervisor (ccbmon) IS the external actor; the
// bridge merely exits, exactly as the memory-recycle guard already does.
function confRequestActivation(S, opts) {
  const c = S.conf; if (!c) throw new Error('no conference on session');
  opts = opts || {};
  const gen = ((c.activation && c.activation.resumeGeneration) || 0) + 1;
  c.activation = {
    state: 'requested',
    expectBuildId: opts.expectBuildId || CONF_BUILD_ID,
    oldPid: process.pid,
    requestedAt: Date.now(),
    resumeGeneration: gen,
    resumeDone: (c.activation && c.activation.resumeDone) || 0,
    stageAtRequest: c.stage,
  };
  // Visible, ordered breadcrumb in the authoritative log.
  c.log = c.log || [];
  c.log.push({ turnId: 'activation-req-' + Date.now().toString(36), engine: c.leadEngine, role: 'system',
               stage: c.stage, subphase: c.subphase, round: c.round,
               text: '⏻ Activation requested — restarting host to load build `' + c.activation.expectBuildId +
                     '`. Verification will auto-resume against the live code on respawn.',
               verdict: null, verdictStage: null, ts: Date.now() });
  // Pause so nothing dispatches during the exit window; boot resume re-opens it.
  c.status = 'paused'; c.pausedReason = 'awaiting activation restart'; c.activeTurnId = null;
  try { confSave(S); } catch (e) { console.log('[Bridge] [CONF_ACTIVATION_V1] checkpoint save failed:', e.message); }
  try { confMirrorToChat(S.key, c); } catch {}
  console.log('[Bridge] [CONF_ACTIVATION_V1] activation requested for', S.key, '-> restarting (pid', process.pid + ')');
  // Kill every child proc so none is orphaned, then exit for the supervisor relaunch.
  try { for (const s of clientSessions.values()) { try { s.currentProc && s.currentProc.kill('SIGKILL'); } catch {} } } catch {}
  setTimeout(() => process.exit(0), 250);
}

// [CONF_ACTIVATION_V1] Boot resume: called once, after the server is listening. Scans every
// conference with a pending activation; if the host is genuinely new (pid changed) and this
// build matches what the conference asked for, idempotently re-opens verification so the
// engines produce the real verdict. resumeDone===resumeGeneration guarantees exactly-once
// (single-threaded boot; no lock needed). Reaching 'restarted' proves ACTIVATION only — it
// never fabricates the conference's verification verdict.
function confResumeActivations() {
  let files = [];
  try { files = fs.existsSync(CONF_DIR) ? fs.readdirSync(CONF_DIR).filter(f => f.endsWith('.json')) : []; } catch { return; }
  for (const f of files) {
    let c;
    try { c = JSON.parse(fs.readFileSync(path.join(CONF_DIR, f), 'utf8')); } catch { continue; }
    const a = c && c.activation;
    if (!a || a.state !== 'requested') continue;
    if (a.resumeDone && a.resumeDone === a.resumeGeneration) continue;   // idempotent: already done
    // Liveness gate (Codex's point: prove by new PID + behaviour, never mtime).
    const pidChanged = process.pid !== a.oldPid;
    const buildOk = CONF_BUILD_ID === a.expectBuildId;
    if (!pidChanged || !buildOk) {
      console.log('[Bridge] [CONF_ACTIVATION_V1] liveness NOT satisfied for', f,
                  '(pidChanged=' + pidChanged + ', buildOk=' + buildOk + ') — leaving pending');
      continue;
    }
    const key = f.replace(/.json$/, '');
    try {
      let S = clientSessions.get(key);
      if (!S) { S = makeSession(key); restoreRoom(S); clientSessions.set(key, S); }
      S.conf = c;
      a.state = 'restarted';
      a.newPid = process.pid;
      a.restartedAt = Date.now();
      a.resumeDone = a.resumeGeneration;   // exactly-once marker
      c.log = c.log || [];
      c.log.push({ turnId: 'activation-live-' + Date.now().toString(36), engine: c.leadEngine, role: 'system',
                   stage: c.stage, subphase: c.subphase, round: c.round,
                   text: '✅ Host restarted (pid ' + a.oldPid + '→' + process.pid + '); build `' + CONF_BUILD_ID +
                         '` is live. Re-opening verification — the engines will now record the verdict against the live code.',
                   verdict: null, verdictStage: null, ts: Date.now() });
      // Re-open verification: fresh turn (drop any truncated activeTurnId), back to running.
      c.status = 'running'; c.pausedReason = null; c.activeTurnId = null; c._afterTurn = null;
      S._confRecovered = true;   // we drive the dispatch ourselves; don't double-fire on attach
      confSave(S);
      confMirrorToChat(S.key, c);
      console.log('[Bridge] [CONF_ACTIVATION_V1] verification re-opened for', key, '— dispatching');
      // Autonomous, no-client resume. If dispatch throws, disk stays status=running so the
      // on-attach confRecover path resumes it when the room is next opened (belt-and-braces).
      try { confDispatch(S); }
      catch (e) { S._confRecovered = false; console.log('[Bridge] [CONF_ACTIVATION_V1] autonomous dispatch failed (will resume on attach):', e.message); }
    } catch (e) {
      console.log('[Bridge] [CONF_ACTIVATION_V1] resume failed for', key, '-', e.message);
    }
  }
}
function confActive(S) { return !!(S && S.conf && S.conf.status === 'running'); }

function _confNewTurnId() { return 'ct-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

function confSendStatus(S) {
  if (!S || !S.conf) return;
  const c = S.conf;
  S.send({ type: 'conf_status', task: c.task || null, startReqId: c.startReqId || null, status: c.status, stage: c.stage, stageLabel: confStageLabel(c.stage), subphase: c.subphase,
           round: c.round, maxRounds: c.maxRounds, restriction: confRestrictionMode(c),
           leadEngine: c.leadEngine, reviewEngine: c.reviewEngine, nextEngine: c.nextEngine, reason: c.pausedReason || null });
}

// ── [CONFERENCE_V2] Staged, consensus-first orchestration ─────────────────────
// Stages run in a fixed order; discussion stages (diagnosis, solution_design)
// require BOTH engines to approve before advancing, and are hard read-only.
const CONF_STAGES = ['diagnosis', 'solution_design', 'implementation', 'verification', 'final'];
function confStageLabel(st) {
  return ({ diagnosis: 'Diagnosis', solution_design: 'Solution design', implementation: 'Implementation',
            verification: 'Verification', final: 'Final synthesis' })[st] || String(st || '');
}
// [CONFERENCE_HISTORY_V1] The authoritative, ordered, both-engine record for a
// conference room. Each log entry (including a role:'conclusion' entry) maps to one
// assistant bubble carrying divider metadata (engine/role/stage/round/turnId) so the
// client renders a stable, chronological transcript instead of the divergent raw
// stream. This is the single source of truth for GET /history of a conference room.
function confLogToMessages(c) {
  const out = [];
  // [CONF_BRIEF_V1] Lead with the user's original brief as a user bubble so the
  // reopened / synced conference view shows the original message. The brief lives in
  // c.brief (never in c.log); test emptiness on a trimmed copy but render it verbatim.
  const _brief = (c && typeof c.brief === 'string') ? c.brief : '';
  if (_brief.trim()) out.push({ type: 'user', text: _brief });
  for (const e of ((c && c.log) || [])) {
    out.push({ type: 'assistant', engine: e.engine || null, role: e.role || null,
               stage: e.stage || null, stageLabel: confStageLabel(e.stage), round: e.round || null,
               turnId: e.turnId || null, text: e.text || '' });
  }
  return out;
}
// [CONFERENCE_V2 FSMFIX] An engine turn that is actually a usage/rate-limit or transient
// error banner (not real work). Used to stop an errored/limited implementation turn from
// being handed to the reviewer as if the lead had produced something to verify.
const _CONF_JUNK_RE = /(hit your (session|usage) limit|session limit|usage limit|rate limit|resets?\s*\d|try again (later|in)|temporarily unavailable|overloaded|service unavailable|api error|context.{0,20}exceeded)/i;
// Restriction mode per stage. Only 'write' (implementation) permits mutations
// (edits, deploys, browser navigation/clicks/etc). Everything else is read-only.
// Consumed by spawnProc (Claude flags), _runCodexTurn (Codex sandbox) and the shim.
function confRestrictionMode(c) {
  if (!c || (c.status !== 'running' && c.status !== 'paused')) return null;
  if (c.stage === 'implementation') return 'write';
  if (c.stage === 'verification') return 'verify';   // read-only fallback (+ report proof gap)
  return 'readonly';                                  // diagnosis, solution_design, final
}

// Per-turn denial ledger written by the shim when it blocks a disallowed mutation.
function confDenyFile(key) { return path.join(CONF_DIR, String(key).replace(/[^A-Za-z0-9_-]/g, '_') + '.deny.jsonl'); }
function confClearDenials(key) { try { fs.unlinkSync(confDenyFile(key)); } catch {} }
function confReadDenials(key) {
  try { return fs.readFileSync(confDenyFile(key), 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}

function confVerdictSpec(stage) {
  return '\n\n---\nWhen you finish, append a machine-readable verdict as the LAST thing in your reply, ' +
    'on its own lines, EXACTLY in this form (nothing after it):\n' +
    '<<<CONFERENCE_VERDICT\n{"stage":"' + stage + '","verdict":"approve","remainingIssues":[]}\nCONFERENCE_VERDICT>>>\n' +
    'The "stage" value MUST be exactly "' + stage + '". ' +
    'Set "verdict" to "approve" ONLY when THIS stage\'s goal is fully met and you have no substantive ' +
    'remaining concerns; "revise" if more work is needed; "blocked" only if you genuinely cannot proceed ' +
    'without the user. List concrete open items in "remainingIssues".';
}

function confRolePreamble(S, engine) {
  const c = S.conf;
  const isLead = (engine === c.leadEngine);
  const partner = (engine === 'claude') ? 'Codex' : 'Claude';
  const stage = c.stage;
  let s = 'You are collaborating with ' + partner + ' in a shared, STAGED "conference" to solve ONE objective. ' +
    'You share the same workspace and browser and take strict turns (never simultaneously). ' +
    'The conference proceeds through fixed stages: diagnosis -> solution_design -> implementation -> verification -> final. ' +
    'You are in the "' + stage + '" stage (' + confStageLabel(stage) + '), round ' + c.round + ' of up to ' + c.maxRounds + '. ' +
    'Continue directly; do not re-introduce yourself or restate the whole objective.\n\n';

  const readOnly = 'HARD RULE for this stage: you are in READ-ONLY mode. Do NOT edit files, run mutating shell commands, ' +
    'deploy, restart services, or mutate the browser (navigate/click/type/press/upload/eval/close). The bridge ENFORCES ' +
    'this: those tools are disabled and any attempt is blocked and PAUSES the conference for the user. Investigate only by ' +
    'read-only means (read files, search, read logs, read-only browser snapshots/screenshots) and reason carefully. ';

  if (stage === 'diagnosis') {
    s += readOnly + '\n\nGoal of THIS stage: reach CONSENSUS on the ROOT CAUSE only — propose no fixes yet. ';
    s += isLead ? 'As LEAD, present an evidence-based root-cause analysis for the reviewer to check.'
                : 'As REVIEWER, independently verify the LEAD\'s root-cause analysis and challenge anything weak or unproven.';
  } else if (stage === 'solution_design') {
    s += readOnly + '\n\nGoal of THIS stage: reach CONSENSUS on the SOLUTION DESIGN/plan only — do NOT implement anything yet. ';
    s += isLead ? 'As LEAD, propose a concrete plan (steps, files, tests) to fix the agreed root cause.'
                : 'As REVIEWER, scrutinise the plan for gaps, risks and bypasses; approve only if it is sound and complete.';
  } else if (stage === 'implementation') {
    s += 'You now have CONSENSUS on the root cause AND the plan. This stage is WRITE-ENABLED. ' +
      'As LEAD, implement the agreed plan concretely (make the changes, run what you need). Stay within the agreed plan; ' +
      'if you find the plan is wrong, set verdict "blocked" and explain rather than improvising a different design.';
  } else if (stage === 'verification') {
    s += 'This stage is INDEPENDENT VERIFICATION by the reviewer, in READ-ONLY mode (no edits/deploys/browser mutation). ' +
      'A disposable write-sandbox is NOT available here, so run only static and read-only checks; wherever a check would ' +
      'REQUIRE execution or mutation you cannot perform, explicitly REPORT THE PROOF GAP rather than assuming success. ' +
      'As REVIEWER, verify the LEAD\'s implementation against the agreed plan and root cause. Approve only if genuinely ' +
      'satisfied; otherwise set "revise" with concrete findings for the LEAD to fix.';
  } else if (stage === 'final') {
    s += 'Consensus was reached and the implementation verified. Produce the polished, user-facing synthesis that resolves ' +
      'the objective, incorporating the collaboration. You are in READ-ONLY mode. Do NOT append a verdict block.';
  }
  return s;
}

// Parse + strip the hidden verdict block. Missing/malformed OR wrong-stage => 'revise'
// (never crash, never terminate). 'blocked' always halts regardless of stage tag.
function confExtractVerdict(text, expectedStage) {
  const re = /<<<CONFERENCE_VERDICT\s*([\s\S]*?)\s*CONFERENCE_VERDICT>>>/;
  const m = String(text || '').match(re);
  let verdict = { verdict: 'revise', stage: null, remainingIssues: [] };
  if (m) {
    try {
      const j = JSON.parse(m[1].trim());
      let v = (j && (j.verdict === 'approve' || j.verdict === 'blocked' || j.verdict === 'revise')) ? j.verdict : 'revise';
      const stg = (j && typeof j.stage === 'string') ? j.stage : null;
      if (expectedStage && stg !== expectedStage && v !== 'blocked') v = 'revise';   // stale/wrong-stage => revise
      verdict = { verdict: v, stage: stg, remainingIssues: (j && Array.isArray(j.remainingIssues)) ? j.remainingIssues.slice(0, 20) : [] };
    } catch { verdict = { verdict: 'revise', stage: null, remainingIssues: [] }; }
  }
  const visible = String(text || '').replace(re, '').trim();
  return { verdict, visible };
}

function confBuildPrompt(S, engine) {
  const c = S.conf;
  const parts = [];
  parts.push(confRolePreamble(S, engine));
  parts.push('\n\nSHARED OBJECTIVE:\n' + c.brief);
  const partnerEngine = (engine === 'claude') ? 'codex' : 'claude';
  const lastPartner = c.lastByEngine && c.lastByEngine[partnerEngine];
  if (lastPartner) {
    parts.push('\n\nYour collaborator (' + (partnerEngine === 'codex' ? 'Codex' : 'Claude') +
      ') just said:\n"""\n' + lastPartner + '\n"""');
  }
  if (Array.isArray(c.pendingInterject) && c.pendingInterject.length) {
    const live = c.pendingInterject.filter(x => x && x.ttl > 0);
    if (live.length) parts.push('\n\nThe user interjected (address this):\n"""\n' +
      live.map(x => x.text).join('\n---\n') + '\n"""');
  }
  if (c.stage === 'final') {
    parts.push('\n\nThis is the FINAL turn. Produce the polished, user-facing result. Do NOT append a verdict block.');
  } else {
    parts.push(confVerdictSpec(c.stage));
  }
  return parts.join('');
}

function _confConsumeInterjections(S) {
  const c = S.conf;
  if (!Array.isArray(c.pendingInterject) || !c.pendingInterject.length) return;
  c.pendingInterject = c.pendingInterject.map(x => ({ text: x.text, ttl: (x.ttl || 0) - 1 })).filter(x => x.ttl > 0);
}

// Dispatch the next (or, on recovery, the same) conference turn.
function confDispatch(S, reuseTurnId, opts) {
  opts = opts || {};
  const c = S.conf;
  if (!c || c.status !== 'running') return;
  const engine = c.nextEngine;
  // [CONFERENCE_V2] Ensure the engine process carries THIS stage's restriction mode.
  // Claude is a persistent proc whose flags are fixed at spawn, so drop an idle proc
  // spawned under a different mode; spawnProc re-reads the stage and applies flags.
  if (engine === 'claude') {
    const need = confRestrictionMode(c);
    if (S.currentProc && S.procEngine === 'claude' && !S.processing && (S._spawnedConfMode !== need || S.pendingCredentialRefresh)) {
      try { S.currentProc.kill('SIGKILL'); } catch {}
      S.currentProc = null; S.procEngine = null; S.pendingCredentialRefresh = false;   // [CONF_ACCT_SWITCH_V1] retire the idle worker so this turn respawns under the new account
    }
  }
  const turnId = reuseTurnId || _confNewTurnId();
  c.activeTurnId = turnId;
  S._confTurnId = turnId;
  c._acc = ''; c._accParts = '';
  const prompt = confBuildPrompt(S, engine);
  if (!opts.isRetry) _confConsumeInterjections(S);
  confClearDenials(S.key);   // fresh denial window for this turn
  confSave(S);
  S.send({ type: 'conf_turn', engine, role: (engine === c.leadEngine ? 'lead' : 'reviewer'),
           stage: c.stage, stageLabel: confStageLabel(c.stage), subphase: c.subphase, round: c.round,
           turnId, restriction: confRestrictionMode(c) });
  confSendStatus(S);
  try { S.sendToEngine(engine, prompt); }
  catch (e) { console.log('[Bridge] [CONFERENCE_V2] dispatch failed:', e.message); c.status = 'paused'; c.pausedReason = 'dispatch-error'; confSave(S); confSendStatus(S); }
}

// ── [CONF_CRED_RETRY_V1] Credential-issuance failure handling ────────────────
// Deterministic classification of a steward issuance failure. Reads exit status /
// STEWARD_ERR token / node exec error INTERNALLY only — never surfaced to the user.
function classifyIssueError(e) {
  const status = e && typeof e.status === 'number' ? e.status : null;
  const stderr = String((e && e.stderr) || '');
  const m = stderr.match(/STEWARD_ERR\s+([a-z_]+)/);
  const kind = m ? m[1] : '';
  if (status === 75) return 'transient';                                   // flock -E 75: lock not acquired
  if (e && e.code === 'ETIMEDOUT') return 'transient';                     // 45s exec timeout (authoritative on Node 20: code=ETIMEDOUT, signal=SIGTERM). A bare SIGTERM WITHOUT ETIMEDOUT (maxBuffer/resource kill/cancel) is NOT inferred transient — falls through to unknown (fail-safe pause).
  if (kind === 'reauth') return 'reauth';
  if (kind === 'refresh_transient' || kind === 'lock' || kind === 'timeout') return 'transient';
  return 'unknown';                                                        // never inferred transient
}
// Safe, allowlisted user-facing text. NEVER interpolate raw stderr/exception/paths.
function confCredMessage(cat, ctx) {
  ctx = ctx || {}; const eng = ctx.engineLabel || 'Claude';
  if (cat === 'reauth') return 'The ' + eng + ' account for this room needs re-authentication. Re-authenticate, then Resume.';
  if (cat === 'retry') return 'Temporarily could not obtain ' + eng + ' credentials — retrying (attempt ' + ctx.attempt + ' of ' + (CONF_CRED_MAX_ATTEMPTS - 1) + ')…';
  if (cat === 'exhausted') return 'Could not obtain ' + eng + ' credentials after ' + CONF_CRED_MAX_ATTEMPTS + ' attempts. Resume to try again.';
  if (cat === 'runtime') return 'The ' + eng + ' engine exited before completing its turn. Resume to retry.';
  return eng + ' credential setup failed. Resume to try again.';
}
// Write/increment the durable credential-attempt lease BEFORE an issuance attempt.
// Only for a live conference turn on a fresh credential-backed spawn.
function confLeaseBeginAttempt(S, engine) {
  const c = S && S.conf;
  if (!c || c.status !== 'running' || !c.activeTurnId) return;
  const attempt = (c.spawnRetries || 0) + 1;
  c.spawnRetries = attempt;
  c.pendingRetry = { turnId: c.activeTurnId, engine: engine, attempt: attempt, state: 'dispatching',
                     owner: { pid: process.pid, gen: c.retryGen || 0 }, leaseExpiresAt: Date.now() + CONF_CRED_LEASE_MS };
  try { confSave(S); } catch (e) {}
}
// Commit: a credential-backed process actually started — clear the lease.
function confLeaseCommit(S, turnId) {
  const c = S && S.conf;
  if (!c || !c.pendingRetry || !turnId) return;
  if (c.pendingRetry.state === 'dispatching' && c.pendingRetry.turnId === turnId) {
    c.pendingRetry = null;
    try { confSave(S); } catch (e) {}
  }
}
// A conference turn's fresh credential-backed spawn failed before/at issuance.
// Decide retry vs pause; emit exactly ONE allowlisted message; never strand the FSM.
function confSpawnFailed(S, err) {
  const c = S && S.conf;
  if (!c || c.status !== 'running' || !c.activeTurnId) return;
  err = err || {};
  const engineLabel = err.engine === 'codex' ? 'Codex' : 'Claude';
  const cat = err.cat || 'unknown';
  const attempt = c.spawnRetries || 1;   // already incremented by confLeaseBeginAttempt
  c.retryGen = (c.retryGen || 0) + 1;     // invalidate any stale retry timers
  if (cat === 'transient' && attempt < CONF_CRED_MAX_ATTEMPTS) {
    const backoff = _confJitter(CONF_CRED_BACKOFF_MS[Math.min(attempt - 1, CONF_CRED_BACKOFF_MS.length - 1)]);
    c.status = 'paused';
    c.pausedReason = confCredMessage('retry', { engineLabel: engineLabel, attempt: attempt });
    c.pendingRetry = { turnId: c.activeTurnId, engine: err.engine || 'claude', attempt: attempt, state: 'scheduled',
                       nextRetryAt: Date.now() + backoff, owner: null };
    const myGen = c.retryGen, myTurn = c.activeTurnId;
    try { confSave(S); } catch (e) {}
    confSendStatus(S);
    S.send({ type: 'status', text: c.pausedReason });
    S.send({ type: 'done', code: 0 });
    setTimeout(function () { try { confRetryFire(S, myTurn, myGen); } catch (e) { console.log('[Bridge] [CONF_CRED_RETRY_V1] retry fire failed:', e.message); } }, backoff);
    return;
  }
  const finalCat = (cat === 'reauth') ? 'reauth' : (cat === 'transient' ? 'exhausted' : (cat === 'runtime' ? 'runtime' : 'unknown'));
  c.status = 'paused';
  c.pausedReason = confCredMessage(finalCat, { engineLabel: engineLabel });
  c.pendingRetry = null;   // keep activeTurnId so a manual Resume redispatches this turn
  try { confSave(S); } catch (e) {}
  confPushConclusion(S, c.pausedReason);
  confSendStatus(S);
  S.send({ type: 'done', code: 0 });
}
// Fire a scheduled retry (from timer or boot reconciler). CAS-claims the lease so a
// timer and a reconciler can never both dispatch the same turn.
function confRetryFire(S, turnId, gen) {
  const c = S && S.conf; if (!c) return;
  const pr = c.pendingRetry;
  if (!pr || pr.state !== 'scheduled' || pr.turnId !== turnId) return;
  if (typeof gen === 'number' && (c.retryGen || 0) !== gen) return;   // stale timer
  if (Date.now() < (pr.nextRetryAt || 0)) return;
  if (S.currentProc || S.processing) return;
  const claimId = process.pid + ':' + (c.retryGen || 0) + ':' + turnId + ':' + Date.now();
  pr.state = 'claiming'; pr.owner = { pid: process.pid, gen: c.retryGen || 0, claimId: claimId }; pr.leaseExpiresAt = Date.now() + CONF_CRED_LEASE_MS;
  try { confSave(S); } catch (e) {}
  const disk = confLoad(S.key);   // authoritative re-read
  if (!disk || !disk.pendingRetry || disk.pendingRetry.state !== 'claiming' || !disk.pendingRetry.owner || disk.pendingRetry.owner.claimId !== claimId) return;
  c.status = 'running'; c.pausedReason = null;
  try { confSave(S); } catch (e) {}
  confSendStatus(S);
  confDispatch(S, turnId, { isRetry: true });   // fresh spawn re-writes the dispatching lease
}
// Reclaim one conference's pending retry lease (boot + on-attach), restart-safe.
function confReclaimRetry(S) {
  const c = S && S.conf; if (!c || !c.pendingRetry) return;
  if (S.currentProc || S.processing) return;
  const pr = c.pendingRetry;
  if (pr.state === 'scheduled') {
    const delay = Math.max(0, (pr.nextRetryAt || 0) - Date.now());
    c.retryGen = (c.retryGen || 0) + 1; const myGen = c.retryGen, myTurn = pr.turnId;
    try { confSave(S); } catch (e) {}
    setTimeout(function () { try { confRetryFire(S, myTurn, myGen); } catch (e) {} }, delay);
  } else if (pr.state === 'dispatching' || pr.state === 'claiming') {
    if ((pr.leaseExpiresAt || 0) > Date.now() && pr.owner && pr.owner.pid === process.pid) return;   // our own live attempt
    c.spawnRetries = pr.attempt || c.spawnRetries || 1;   // attempt was persisted pre-issuance
    if (c.status !== 'running') { c.status = 'running'; }
    confSpawnFailed(S, { engine: pr.engine || 'claude', cat: 'transient' });
  }
}
// [CONF_CRED_RETRY_V1] Boot reclamation sweep for pending credential-retry leases.
function confResumeRetries() {
  let files = [];
  try { files = fs.existsSync(CONF_DIR) ? fs.readdirSync(CONF_DIR).filter(function (f) { return f.endsWith('.json'); }) : []; } catch (e) { return; }
  for (const f of files) {
    let c; try { c = JSON.parse(fs.readFileSync(path.join(CONF_DIR, f), 'utf8')); } catch (e) { continue; }
    if (!c || c.status === 'superseded' || !c.pendingRetry) continue;
    const key = f.replace(/\.json$/, '');
    try {
      let S = clientSessions.get(key);
      if (!S) { S = makeSession(key); S.conf = c; restoreRoom(S); clientSessions.set(key, S); }
      else if (!S.conf) S.conf = c;
      confReclaimRetry(S);
    } catch (e) { console.log('[Bridge] [CONF_CRED_RETRY_V1] resume-retry failed for', key, '-', e.message); }
  }
}

function confStart(S, brief, opts) {
  opts = opts || {};
  const lead = (opts.leadEngine === 'codex') ? 'codex'
             : (opts.leadEngine === 'claude') ? 'claude'
             : ((S.engineOverride === 'codex' || S.engineOverride === 'claude') ? S.engineOverride : currentEngine());
  const review = lead === 'claude' ? 'codex' : 'claude';
  let maxRounds = parseInt(opts.maxRounds, 10);
  if (!(maxRounds >= 1 && maxRounds <= CONF_HARD_ROUND_CAP)) maxRounds = CONF_MAX_ROUNDS_DEFAULT;
  S.conf = {
    version: 2, status: 'running',
    stage: 'diagnosis', subphase: 'lead', round: 1, maxRounds,
    leadEngine: lead, reviewEngine: review, nextEngine: lead,
    brief: String(brief || '').slice(0, 20000),
    task: (opts.task || null), startReqId: (typeof opts.reqId === 'string' ? opts.reqId : null),
    activeTurnId: null, log: [], stageVerdicts: {}, lastByEngine: {}, pendingInterject: [],
    spawnRetries: 0, pendingRetry: null, retryGen: 0,   // [CONF_CRED_RETRY_V1]
    createdAt: Date.now(),
  };
  S._confRecovered = true;
  confClearDenials(S.key);
  confSave(S);
  confMirrorToChat(S.key, S.conf);   // [CONF_CONTAINED_V1]
  console.log('[Bridge] [CONFERENCE_V2] start room', S.key, 'lead=' + lead, 'rounds=' + maxRounds);
  S.send({ type: 'conf_started', reqId: S.conf.startReqId || null, task: S.conf.task || null, leadEngine: lead, reviewEngine: review, maxRounds, brief: S.conf.brief,
           stage: 'diagnosis', stageLabel: confStageLabel('diagnosis') });
  confDispatch(S);
}

function confValidReqId(r) { return typeof r === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(r); }

// [CONF_TASK_ASSOC_V1] Canonicalize a task decision server-side. Never trusts client
// title/metadata: for a linked task it re-reads the task file and returns the
// server's own {id,file,title}. Returns {status:'none'|'linked'|'invalid'}.
function confCanonicalTask(decision, task) {
  if (decision === 'none') return { status: 'none', task: null };
  if (decision === 'linked') {
    const file = (task && typeof task.file === 'string') ? task.file : '';
    if (!/^task-[a-z0-9-]+\.md$/.test(file)) return { status: 'invalid' };
    try {
      const full = path.join(TASKS_DIR, file);
      if (!fs.existsSync(full)) return { status: 'invalid' };
      const t = parseTaskFile(full);
      if (!t) return { status: 'invalid' };
      return { status: 'linked', task: { id: String(t.id || '').slice(0, 16), file: file, title: String(t.title || '').slice(0, 200) } };
    } catch { return { status: 'invalid' }; }
  }
  return { status: 'invalid' };
}

// [CONF_TASK_ASSOC_V1] Single entry for a conference chat/conf_start message.
// Order is critical: (1) idempotent replay of an already-accepted start BEFORE the
// interjection fork, so a retried first message never becomes a double interjection;
// (2) active conference -> interjection (unchanged); (3) fresh start requires a valid
// reqId AND a valid taskDecision, else fail closed with conf_need_task.
function confTryStart(S, brief, msg) {
  const c = S.conf;
  const reqId = msg && msg.reqId;
  if (c && c.startReqId && confValidReqId(reqId) && reqId === c.startReqId) {
    confSendStatus(S);
    if (Array.isArray(c.log) && c.log.length) {
      S.send({ type: 'conf_sync', task: c.task || null, startReqId: c.startReqId || null, messages: confLogToMessages(c),
               status: c.status, stage: c.stage, stageLabel: confStageLabel(c.stage), subphase: c.subphase,
               round: c.round, maxRounds: c.maxRounds, restriction: confRestrictionMode(c),
               leadEngine: c.leadEngine, reviewEngine: c.reviewEngine });
    } else {
      S.send({ type: 'conf_started', reqId: c.startReqId || null, task: c.task || null, leadEngine: c.leadEngine,
               reviewEngine: c.reviewEngine, maxRounds: c.maxRounds, brief: c.brief,
               stage: c.stage, stageLabel: confStageLabel(c.stage) });
    }
    return;
  }
  if (c && (c.status === 'running' || c.status === 'paused')) {
    confInterject(S, brief); if (c.status === 'paused') confResume(S);
    return;
  }
  if (!confValidReqId(reqId)) { S.send({ type: 'conf_need_task', reason: 'reqid', reqId: (typeof reqId === 'string' ? reqId : null) }); return; }
  const dec = confCanonicalTask(msg && msg.taskDecision, msg && msg.task);
  if (dec.status === 'invalid') { S.send({ type: 'conf_need_task', reason: 'task', reqId: reqId }); return; }
  confStart(S, brief, { leadEngine: msg && msg.leadEngine, maxRounds: msg && msg.maxRounds, task: dec.task, reqId: reqId });
}

function confInterject(S, text) {
  const c = S.conf; if (!c) return;
  c.pendingInterject = c.pendingInterject || [];
  c.pendingInterject.push({ text: String(text || '').slice(0, 8000), ttl: 2 });
  confSave(S);
  if (c.status === 'paused') { S.send({ type: 'status', text: 'Interjection saved — resume the conference to deliver it.' }); }
  else S.send({ type: 'status', text: 'Interjection queued — it will reach both engines on the next turn.' });
}

function confPause(S) {
  const c = S.conf; if (!c || (c.status !== 'running')) return;
  c.retryGen = (c.retryGen || 0) + 1;   // [CONF_CRED_RETRY_V1] kill any pending retry timer
  if (c.activeTurnId) { c._afterTurn = 'pause'; confSave(S); S.send({ type: 'status', text: 'Pausing after the current turn finishes…' }); }
  else { c.status = 'paused'; confSave(S); confSendStatus(S); }
}
function confResume(S) {
  const c = S.conf; if (!c || c.status !== 'paused') return;
  // [CONF_CRED_RETRY_V1] A deliberate resume grants a fresh credential-attempt budget and
  // re-dispatches the SAME stranded turn (never mints a new one / double-consumes interjections).
  if (c.activeTurnId && (c.pendingRetry || (c.spawnRetries || 0) > 0)) {
    c.spawnRetries = 0; c.pendingRetry = null; c.retryGen = (c.retryGen || 0) + 1;
    c.status = 'running'; c.pausedReason = null; c._afterTurn = null;
    if (c.concluded && Array.isArray(c.log) && c.log.length && c.log[c.log.length - 1].role === 'conclusion') { c.log.pop(); c.concluded = false; }
    confSave(S); confMirrorToChat(S.key, c); confSendStatus(S);
    confDispatch(S, c.activeTurnId, { isRetry: true });
    return;
  }
  // [CONFERENCE_CONCLUDE_V1] Resuming retracts any interim auto-conclusion appended at
  // the pause, so a continued conference doesn't leave a stale summary mid-transcript.
  // A fresh conclusion is produced at the next terminal state (c.concluded reset).
  if (c.concluded && Array.isArray(c.log) && c.log.length && c.log[c.log.length - 1].role === 'conclusion') {
    c.log.pop();
    c.concluded = false;
    c.status = 'running'; c.pausedReason = null; c._afterTurn = null; confSave(S);
    confMirrorToChat(S.key, c);   // [CONF_CONTAINED_V1]
    // Repaint the authoritative log so the retracted conclusion disappears everywhere.
    if (Array.isArray(c.log) && c.log.length) {
      S.send({ type: 'conf_sync', task: c.task || null, startReqId: c.startReqId || null, messages: confLogToMessages(c), status: c.status, stage: c.stage, stageLabel: confStageLabel(c.stage),
               subphase: c.subphase, round: c.round, maxRounds: c.maxRounds, restriction: confRestrictionMode(c),
               leadEngine: c.leadEngine, reviewEngine: c.reviewEngine });
    }
    confSendStatus(S);
    confDispatch(S);
    return;
  }
  c.status = 'running'; c.pausedReason = null; c._afterTurn = null; confSave(S);
  confSendStatus(S);
  confDispatch(S);
}
function confStop(S) {
  const c = S.conf; if (!c) return;
  if (c.status === 'running' && c.activeTurnId) { c._afterTurn = 'stop'; confSave(S); S.send({ type: 'status', text: 'Stopping after the current turn finishes…' }); return; }
  c.status = 'stopped'; c.activeTurnId = null; c.pendingRetry = null; c.retryGen = (c.retryGen || 0) + 1; confSave(S); confSendStatus(S); S.send({ type: 'done', code: 0 });
}

// A disallowed mutation was blocked by the shim during a discussion turn: pause the
// whole conference with a visible policy event instead of silently continuing.
function confPolicyPause(S, detail) {
  const c = S.conf; if (!c) return;
  c.status = 'paused';
  c.pausedReason = 'Policy: a disallowed action was blocked during ' + confStageLabel(c.stage) +
    (detail ? ' (' + detail + ')' : '') + '. The conference was paused for your review.';
  c.activeTurnId = null; S._confTurnId = null; c.pendingRetry = null; c.retryGen = (c.retryGen || 0) + 1;
  confSave(S); confPushConclusion(S, c.pausedReason); confSendStatus(S);
  S.send({ type: 'conf_policy', stage: c.stage, detail: detail || null, reason: c.pausedReason });
  S.send({ type: 'done', code: 0 });
}

// [CONFERENCE_CONCLUDE_V1] Deterministic, engine-free closing summary. Used ONLY on
// terminal paths that lack a usable final-stage synthesis (paused / stopped / blocked /
// policy-pause / empty-or-junk final), so the chat always ends with a visible outcome
// even when the engines never converged (e.g. the reviewer could not run verification).
function confComposeConclusion(c, reason) {
  const stagesSeen = [];
  for (const e of ((c && c.log) || [])) { const st = e.stage; if (st && e.role !== 'conclusion' && !stagesSeen.includes(st)) stagesSeen.push(st); }
  const parts = [];
  parts.push('## 🏁 Conference concluded (automatic summary)');
  parts.push(reason || c.pausedReason || 'The conference ended before a verified final synthesis.');
  if (stagesSeen.length) parts.push('**Progress:** ' + stagesSeen.map(confStageLabel).join(' → ') + ' · reached **' + confStageLabel(c.stage) + '**.');
  parts.push('_No verified Final synthesis was produced, so this is a deterministic summary. The full turn-by-turn discussion is above; resume the conference to continue, adjust the brief, or stop._');
  return parts.join('\n\n');
}
// Push the summary into the authoritative log EXACTLY ONCE (guarded by c.concluded),
// persist it, and broadcast it as a normal conference message so it renders in order.
function confPushConclusion(S, reason) {
  const c = S.conf;
  if (!c || c.concluded) return;
  c.concluded = true;
  c.log = c.log || [];
  const text = confComposeConclusion(c, reason);
  const turnId = 'conclusion-' + Date.now().toString(36);
  c.log.push({ turnId, engine: c.leadEngine, role: 'conclusion', stage: c.stage, subphase: c.subphase,
               round: c.round, text, verdict: null, verdictStage: null, ts: Date.now() });
  confSave(S);
  S.send({ type: 'conf_msg', turnId, engine: c.leadEngine, role: 'conclusion', stage: c.stage,
           stageLabel: confStageLabel(c.stage), subphase: c.subphase, round: c.round, text,
           verdict: null, remainingIssues: [] });
}

function confComplete(S, finalStatus) {
  const c = S.conf;
  c.status = finalStatus || 'done'; c.finishedAt = Date.now(); c.activeTurnId = null;
  // [CONFERENCE_CONCLUDE_V1] A GOOD final-stage turn IS the conclusion (no mechanical
  // recap that would duplicate/dilute it). Only fall back to the deterministic summary
  // when there is no usable final response (stopped early, or final produced empty/junk).
  if (c.stage === 'final' && c.status === 'done') {
    const lastFinal = ((c.log || []).slice().reverse()).find(e => e.stage === 'final' && e.role !== 'conclusion');
    const good = lastFinal && String(lastFinal.text || '').trim().length > 0 && !_CONF_JUNK_RE.test(lastFinal.text || '');
    if (good) c.concluded = true;
    else confPushConclusion(S, 'The final synthesis did not produce usable output; summarising automatically.');
  } else {
    confPushConclusion(S, c.pausedReason || 'The conference was stopped before a verified final synthesis.');
  }
  confClearDenials(S.key);
  confSave(S);
  confMirrorToChat(S.key, c);   // [CONF_CONTAINED_V1]
  confSendStatus(S);
  S.send({ type: 'done', code: 0 });
  console.log('[Bridge] [CONFERENCE_V2] conference', c.status, 'room', S.key, 'stage', c.stage);
  return true;
}

// Staged state machine, called after a turn's response is durably recorded.
function confAdvance(S, engine, verdict, meta) {
  const c = S.conf;
  meta = meta || {};
  if (verdict === 'blocked') {
    c.status = 'paused'; c.activeTurnId = null;
    c.pausedReason = 'An engine reported it is blocked during ' + confStageLabel(c.stage) + ' and needs your input.';
    confSave(S); confPushConclusion(S, c.pausedReason); confSendStatus(S); S.send({ type: 'done', code: 0 });
    return true;
  }
  const enterStage = (next) => { c.stage = next; c.round = 1; c.subphase = 'lead'; c.nextEngine = c.leadEngine; c.stageVerdicts = {}; c.spawnRetries = 0; c.pendingRetry = null; c.retryGen = (c.retryGen || 0) + 1; };
  const pauseNoConsensus = (why) => { c.status = 'paused'; c.pausedReason = why; c.activeTurnId = null; confSave(S); confPushConclusion(S, why); confSendStatus(S); S.send({ type: 'done', code: 0 }); };
  // [CONFERENCE_V2 FSMFIX] Absolute safety valve: past the hard round cap the conference
  // STOPS (terminal) rather than pausing — a paused/resumed loop must never be unbounded.
  const hardCapStop = () => { c.stage = 'implementation'; c.subphase = 'lead'; c.nextEngine = c.leadEngine; c.stageVerdicts = {}; return confComplete(S, 'stopped'); };

  if (c.stage === 'diagnosis' || c.stage === 'solution_design') {
    if (c.subphase === 'lead') {
      c.subphase = 'review'; c.nextEngine = c.reviewEngine;
    } else {
      const both = c.stageVerdicts[c.leadEngine] === 'approve' && c.stageVerdicts[c.reviewEngine] === 'approve';
      if (both) {
        enterStage(c.stage === 'diagnosis' ? 'solution_design' : 'implementation');
      } else {
        c.round++;
        if (c.round > CONF_HARD_ROUND_CAP) { c.pausedReason = 'Hard round cap reached in ' + confStageLabel(c.stage) + '.'; return hardCapStop(); }
        // Return to the LEAD so a resume makes forward progress (not re-run the reviewer).
        c.subphase = 'lead'; c.nextEngine = c.leadEngine; c.stageVerdicts = {};
        if (c.round > c.maxRounds) {
          pauseNoConsensus('No consensus reached in ' + confStageLabel(c.stage) + ' within ' + c.maxRounds +
            ' rounds. Resume to let the lead try again, adjust the brief, or stop.');
          return true;
        }
      }
    }
  } else if (c.stage === 'implementation') {
    // [CONFERENCE_V2 FSMFIX] Only hand to the reviewer when the LEAD actually produced a
    // complete, well-formed implementation turn. Incomplete / malformed / errored /
    // usage-limited / self-declared-not-done turns must NOT advance to verification —
    // otherwise the reviewer keeps rejecting "no new evidence" and rounds burn out.
    const junk = _CONF_JUNK_RE.test(String(meta.visible || ''));
    const okImpl = (engine === c.leadEngine) && verdict === 'approve' && meta.verdictStage === 'implementation' && !junk;
    if (okImpl) {
      c.stage = 'verification'; c.subphase = 'review'; c.nextEngine = c.reviewEngine; c.stageVerdicts = {};
    } else {
      // Stay on implementation/lead so a resume retries the lead (e.g. after usage resets).
      c.subphase = 'lead'; c.nextEngine = c.leadEngine; c.stageVerdicts = {};
      const why = junk
        ? 'The lead could not complete implementation (engine usage/rate limit or a transient error). Resume once ' + (c.leadEngine === 'claude' ? 'Claude' : 'Codex') + ' is available again.'
        : ((verdict === 'revise' && meta.verdictStage === 'implementation')
            ? 'The lead reports implementation is not yet complete. Resume to let the lead continue the work.'
            : 'The implementation turn was incomplete or malformed (no valid implementation-stage verdict). Resume to let the lead complete it.');
      pauseNoConsensus(why);
      return true;
    }
  } else if (c.stage === 'verification') {
    if (c.stageVerdicts[c.reviewEngine] === 'approve') {
      c.stage = 'final'; c.subphase = 'final'; c.nextEngine = c.leadEngine; c.stageVerdicts = {};
    } else {
      c.round++;
      if (c.round > CONF_HARD_ROUND_CAP) { c.pausedReason = 'Hard round cap reached in Verification.'; return hardCapStop(); }
      // [CONFERENCE_V2 FSMFIX] Always return to the implementation LEAD for forward progress
      // (never leave the paused state pointed at the reviewer, which can only re-reject).
      c.stage = 'implementation'; c.subphase = 'lead'; c.nextEngine = c.leadEngine; c.stageVerdicts = {};
      if (c.round > c.maxRounds) {
        pauseNoConsensus('Verification did not pass within ' + c.maxRounds + ' rounds. Resume to let ' +
          (c.leadEngine === 'claude' ? 'Claude' : 'Codex') + ' (lead) continue implementation, adjust, or stop.');
        return true;
      }
    }
  } else if (c.stage === 'final') {
    return confComplete(S, 'done');
  }

  if (c._afterTurn === 'stop') { c._afterTurn = null; return confComplete(S, 'stopped'); }
  if (c._afterTurn === 'pause') { c._afterTurn = null; c.status = 'paused'; c.activeTurnId = null; confSave(S); confSendStatus(S); S.send({ type: 'done', code: 0 }); return true; }
  confSave(S);
  setTimeout(() => { try { if (confActive(S)) confDispatch(S); } catch (e) { console.log('[Bridge] [CONFERENCE_V2] advance-dispatch failed:', e.message); } }, 400);
  return true;
}

// A conference turn completed on 'engine'. Record it (server-authoritative) BEFORE
// advancing. Idempotent: a completion that doesn't match the active turn is ignored.
function confFinishTurn(S, engine) {
  const c = S.conf;
  if (!c || (c.status !== 'running' && c.status !== 'stopping')) return false;
  if (!S._confTurnId || S._confTurnId !== c.activeTurnId) { console.log('[Bridge] [CONFERENCE_V2] stale/duplicate finish ignored', S.key); return false; }
  const raw = String(c._acc || c._accParts || '').trim();
  const isFinal = (c.stage === 'final');
  const parsed = isFinal ? { verdict: { verdict: 'approve', stage: 'final', remainingIssues: [] }, visible: raw }
                         : confExtractVerdict(raw, c.stage);
  const turnId = c.activeTurnId;
  const role = (engine === c.leadEngine) ? 'lead' : 'reviewer';
  c.log = c.log || [];
  c.log.push({ turnId, engine, role, stage: c.stage, subphase: c.subphase, round: c.round,
               text: parsed.visible, verdict: parsed.verdict.verdict, verdictStage: parsed.verdict.stage || null, ts: Date.now() });
  c.lastByEngine = c.lastByEngine || {}; c.lastByEngine[engine] = parsed.visible;
  c.stageVerdicts = c.stageVerdicts || {}; c.stageVerdicts[engine] = parsed.verdict.verdict;
  c.activeTurnId = null; S._confTurnId = null; c._acc = ''; c._accParts = '';
  c.spawnRetries = 0; c.pendingRetry = null; c.retryGen = (c.retryGen || 0) + 1;   // [CONF_CRED_RETRY_V1]
  confSave(S);   // persist response + cleared active turn BEFORE advancing
  confMirrorToChat(S.key, c);   // [CONF_CONTAINED_V1]
  S.send({ type: 'conf_msg', turnId, engine, role, stage: c.stage, stageLabel: confStageLabel(c.stage),
           subphase: c.subphase, round: c.round, text: parsed.visible, verdict: parsed.verdict.verdict, remainingIssues: parsed.verdict.remainingIssues });
  // [CONFERENCE_V2] If the shim blocked a disallowed mutation during this turn, pause (fail-closed, visible).
  const denials = confReadDenials(S.key);
  if (denials.length) { const d = denials[denials.length - 1]; confPolicyPause(S, (d && d.tool) ? d.tool : null); return true; }
  return confAdvance(S, engine, parsed.verdict.verdict, { verdictStage: parsed.verdict.stage, visible: parsed.visible });
}

// Re-derive server state on attach / after a restart. Single-owner recovery:
// coordinates with the pending-turn journal so only one mechanism resumes a turn.
// A fresh spawn re-reads the persisted stage, so Claude/Codex come back with the
// correct restriction flags before any turn replays.
function confRecover(S) {
  const disk = confLoad(S.key);
  if (!disk) return;
  if (disk.status === 'superseded') return;   // inert tombstone from an atomic rekey
  if (!S.conf) S.conf = disk;
  const c = S.conf;
  confSendStatus(S);
  if (Array.isArray(c.log) && c.log.length) {
    S.send({ type: 'conf_sync', task: c.task || null, startReqId: c.startReqId || null, messages: confLogToMessages(c), status: c.status, stage: c.stage, stageLabel: confStageLabel(c.stage),
             subphase: c.subphase, round: c.round, maxRounds: c.maxRounds, restriction: confRestrictionMode(c),
             leadEngine: c.leadEngine, reviewEngine: c.reviewEngine });
  }
  confMirrorToChat(S.key, c);   // [CONF_CONTAINED_V1]
  if (S._confRecovered) return;
  S._confRecovered = true;
  if (c.pendingRetry) { try { confReclaimRetry(S); } catch (e) {} return; }   // [CONF_CRED_RETRY_V1]
  if (c.status !== 'running') return;
  if (S.processing) return;   // a live turn is already running in this process
  let journaled = false;
  try { const j = JSON.parse(fs.readFileSync(pendingFile(S.key), 'utf8')); journaled = !!(j && Array.isArray(j.turns) && j.turns.length); } catch {}
  if (c.activeTurnId) {
    if (RESUME_TURNS && !journaled) {
      console.log('[Bridge] [CONFERENCE_V2] state/journal disagreement — pausing for recovery', S.key);
      c.status = 'paused'; c.pausedReason = 'Recovery: turn state was uncertain after a restart. Resume to continue.';
      confSave(S); confSendStatus(S);
      return;
    }
    console.log('[Bridge] [CONFERENCE_V2] recovering interrupted turn', c.activeTurnId, 'room', S.key);
    clearPending(S.key);
    confDispatch(S, c.activeTurnId);
  } else {
    console.log('[Bridge] [CONFERENCE_V2] resuming between-turns', S.key);
    confDispatch(S);
  }
}
const clientSessions = new Map();   // clientId -> session state (survives reconnects)

// --- Blip recovery journal (gated on RESUME_TURNS) ----------------------------
// Only the bridge process dying (a blip) leaves a journal behind: every in-process
// turn end (success, failure, kill) clears it, so a journal present at startup
// means the turn was interrupted by the restart. Replay re-injects the USER
// prompt (safer than blindly "continuing") against the resumed session, capped to
// avoid loops. All three helpers are no-ops when RESUME_TURNS is unset.
const PENDING_DIR = path.join(process.env.HOME || os.homedir(), '.claude', 'bridge-pending');
function pendingFile(key) { return path.join(PENDING_DIR, String(key).replace(/[^A-Za-z0-9_-]/g, '_') + '.json'); }
function journalPending(S) {
  if (!RESUME_TURNS) return;
  try {
    if (S.inFlight && S.inFlight.length) {
      fs.mkdirSync(PENDING_DIR, { recursive: true });
      let _attempts = 0;   // [CODEX_DURABLE_V5] carry the replay-attempt count forward so rewrites don't reset the ceiling
      try { const _p = JSON.parse(fs.readFileSync(pendingFile(S.key), 'utf8')); if (_p && _p.attempts) _attempts = _p.attempts; } catch {}
      fs.writeFileSync(pendingFile(S.key), JSON.stringify({ key: S.key, sessionId: S.sessionId || null, threadId: S.threadId || null, engine: S.pendingEngine || S.procEngine || S.engineOverride || null, attempts: _attempts, turns: S.inFlight.slice(), ts: Date.now() }));
    } else {
      try { fs.unlinkSync(pendingFile(S.key)); } catch {}
    }
  } catch (e) { console.log('[Bridge] journalPending failed:', e.message); }
}
function clearPending(key) {
  if (!RESUME_TURNS) return;
  try { fs.unlinkSync(pendingFile(key)); } catch {}
}
function replayPending() {
  if (!RESUME_TURNS) return;
  let files = [];
  try { files = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    const fp = path.join(PENDING_DIR, f);
    let j; try { j = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { try { fs.unlinkSync(fp); } catch {} continue; }
    if (!j || !Array.isArray(j.turns) || !j.turns.length) { try { fs.unlinkSync(fp); } catch {} continue; }
    j.attempts = (j.attempts || 0) + 1;
    if (j.attempts > 2) { try { fs.unlinkSync(fp); } catch {} console.log('[Bridge] blip-replay: giving up on', j.key); continue; }
    try { fs.writeFileSync(fp, JSON.stringify(j)); } catch {}
    const key = j.key;   // [CODEX_DURABLE_V3] stable room key; never split a named room onto its session id
    if (confExistsRunning(key)) { console.log('[Bridge] [CONFERENCE_V1] blip-replay skipping conference room', key); continue; }
    let S = clientSessions.get(key);
    if (!S) { S = makeSession(key); if (j.sessionId && sessionFileExists(j.sessionId)) S.sessionId = j.sessionId; restoreRoom(S); if (!S.threadId && j.threadId && codexRolloutExists(j.threadId)) S.threadId = j.threadId; clientSessions.set(key, S); }   // [CODEX_DURABLE_V3] do NOT clobber the room's saved engineOverride
    if (S.processing) continue;   // already live (a reconnecting client beat us to it)
    const turns = j.turns.slice();
    console.log(`[Bridge] blip-replay: re-injecting ${turns.length} dropped turn(s) into ${key} (attempt ${j.attempts})`);
    setTimeout(() => { try { turns.forEach(t => S.sendToEngine(j.engine === 'codex' ? 'codex' : 'claude', t)); } catch (e) { console.log('[Bridge] blip-replay failed:', e.message); } }, 800);   // [CODEX_DURABLE_V4] explicit engine routing, no override change
  }
}

function makeSession(key) {
  const S = {
    key, clientId: key, sockets: new Set(), sessionId: null, processing: false, currentProc: null,
    watchdogTimer: null, pendingTurns: 0, inFlight: [], retried: false,
    graceTimer: null, buffer: [], evictWhenIdle: false, lastActiveAt: Date.now(),
    ctxPct: null, ctxTokens: null, compacting: false, lastCompactAt: 0,
    engineOverride: null,   // per-room engine override: null=follow global (~/.claude/engine), else 'claude'|'codex'
    lastEngine: null,       // [XENGINE_TRANSPLANT_V1] engine that last actually ran a turn in this room
    threadId: null,         // [CODEX_DURABLE_V2] Codex resume handle (persisted in bridge-rooms.json)
    conf: null,             // [CONFERENCE_V1] live conference orchestration state (mirrored to disk)
    credentialClaudeAccount: null, credentialCodexAccount: null,
    credentialRuntimeDir: null, credentialTimer: null,
    pendingCredentialRefresh: false,   // [CONF_ACCT_SWITCH_V1] a live BUSY Claude worker awaits retirement so its next turn re-issues under the newly-selected account
  };

  S.engineState = (error = '') => { const _r = resolveRoomEngine(S); return { type: 'room_engine', roomId: S.key,
    mode: _r.mode, engine: _r.engine, rev: _r.rev,
    processing: !!S.processing, error }; };

  // Broadcast to all connected sockets. Buffer when nobody is connected so a
  // reconnecting client still receives in-flight output.
  S.send = (data) => {
    S.lastActiveAt = Date.now();
    const json = JSON.stringify(data);
    let sent = false;
    for (const sock of S.sockets) {
      if (sock.readyState === WebSocket.OPEN) { sock.send(json); sent = true; }
    }
    if (!sent) {
      S.buffer.push(data);
      if (S.buffer.length > MAX_BUFFER) S.buffer.shift();
    }
  };

  S.clearWatch = () => { if (S.watchdogTimer) { clearTimeout(S.watchdogTimer); S.watchdogTimer = null; } };
  S.armWatch = (ms, msg) => {
    S.clearWatch();
    S.watchdogTimer = setTimeout(() => { S.send({ type: 'error', text: msg }); S.killCurrentProc('watchdog timeout'); }, ms);
  };

  S.killCurrentProc = (reason) => {
    S.clearWatch();
    if (S.credentialTimer) { clearTimeout(S.credentialTimer); S.credentialTimer = null; }
    if (S.currentProc) { try { S.currentProc.kill('SIGKILL'); } catch {} S.currentProc = null; }
    const wasProcessing = S.processing;
    S.processing = false; S.pendingTurns = 0; S.inFlight = []; S.codexQueue = [];   // [CODEX_DURABLE_V4] also clear the Codex queue on kill/cancel/watchdog
    clearPending(S.key);   // in-process end — UI is unblocked, so no blip-replay
    // [CONF_CRED_RETRY_V1] A kill while a credential-attempt lease is still OPEN (the process
    // never reached its start event) is a FAILED in-flight attempt — route to retry/exhaust,
    // NOT the generic administrative pause (which would strand a running active turn).
    if (S.conf && S.conf.status === 'running' && S.conf.activeTurnId && S.conf.pendingRetry &&
        S.conf.pendingRetry.state === 'dispatching' && S.conf.pendingRetry.turnId === S.conf.activeTurnId) {
      const _eng = S.conf.pendingRetry.engine || 'claude';
      try { confSpawnFailed(S, { engine: _eng, cat: 'transient' }); } catch (e) { console.log('[Bridge] [CONF_CRED_RETRY_V1] kill->confSpawnFailed failed:', e.message); }
      if (reason) console.log('[Bridge] Killed proc (in-flight cred attempt):', reason);
      return;
    }
    if (S.conf && S.conf.status === 'running') { S.conf.status = 'paused'; S.conf.pausedReason = 'The active turn was interrupted (' + (reason || 'stopped') + '). Resume to continue.'; S.conf.activeTurnId = S.conf.activeTurnId || null; S.conf.pendingRetry = null; S.conf.retryGen = (S.conf.retryGen || 0) + 1; confSave(S); confSendStatus(S); }   // [CONFERENCE_V1] never silently advance on error
    if (wasProcessing) S.send({ type: 'done', code: -1 });
    if (reason) console.log('[Bridge] Killed Claude proc:', reason);
  };

  // A room whose grace period expired *while a turn was running* is kept alive so
  // the turn finishes in the background. This closes it down once it goes idle —
  // called at every point the session returns to idle.
  S.evictIfReady = () => {
    if (!S.evictWhenIdle) return;
    if (S.conf && S.conf.status === 'running') return;   // [CONFERENCE_V1] keep orchestrating even with no devices attached
    if (S.sockets.size > 0) { S.evictWhenIdle = false; return; }  // a device rejoined
    if (S.processing || S.pendingTurns > 0) return;               // still working — wait
    S.evictWhenIdle = false;
    S.killCurrentProc('evict: background turn finished, room empty');
    clientSessions.delete(S.key);
    console.log('[Bridge] Background turn finished — room closed:', S.key);
  };

  // Spawn the persistent streaming Claude process. With --input-format stream-json
  // its stdin stays open across turns, so follow-up messages queue into the live
  // process and steer it. Spawned lazily; killed on reset / cancel / timeout /
  // grace-expiry.
  S.spawnProc = () => {
    S.pendingCredentialRefresh = false;   // [CONF_ACCT_SWITCH_V1] a fresh spawn re-reads the active account, satisfying any pending retirement
    // Drop a stale session id before spawning so we never --resume a missing file.
    if (S.sessionId && !sessionFileExists(S.sessionId)) {
      console.log('[Bridge] Stale session (no transcript), starting fresh:', S.sessionId);
      S.sessionId = null;
    }
    const triedResume = !!S.sessionId;
    let resumeMissing = false;

    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--model', CLAUDE_MODEL, '--append-system-prompt', GENERAL_ASSISTANT_PROMPT];
    // [CONFERENCE_V2] Discussion/verification/final stages run Claude READ-ONLY:
    // plan mode + deny mutation-capable built-ins. Browser mutation is blocked centrally
    // at the shim. Implementation stage keeps full tools. Recorded so confDispatch can
    // respawn the persistent proc when the stage (mode) changes.
    let _confMode = null;
    try { if (S.conf && (S.conf.status === 'running' || S.conf.status === 'paused')) _confMode = confRestrictionMode(S.conf); } catch (e) {}
    if (_confMode && _confMode !== 'write') {
      args.push('--permission-mode', 'plan', '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,Task');
    }
    S._spawnedConfMode = _confMode;
    // Point Claude at this room's browser MCP. Preferred: the room's OWN isolated
    // Playwright MCP (per-room browsers). It must already be listening — sendToClaude
    // awaits roomStack.ensureRoom(S.key) before the fresh spawn, so portsFor() is set.
    // Fallback: the shared-Chrome shim tab (SHIM_PORT). Neither => global settings MCP.
    let _roomMcpPort = null;
    if (roomStack) { const _rp = roomStack.portsFor(S.key); if (_rp && _rp.mcp) _roomMcpPort = _rp.mcp; }
    if (_roomMcpPort) {
      const roomUrl = `http://localhost:${_roomMcpPort}/mcp`;
      const mcpFile = path.join(os.tmpdir(), `mcp-room-${S.key.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
      try {
        fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { playwright: { type: 'http', url: roomUrl } } }));
        args.push('--mcp-config', mcpFile, '--strict-mcp-config');
      } catch (e) { console.log('[Bridge] room mcp-config write failed:', e.message); }
    } else if (SHIM_PORT) {
      const roomUrl = `http://localhost:${SHIM_PORT}/mcp/${encodeURIComponent(S.key)}`;
      S.shimMountKey = S.key;   // /mcp/<key> is baked into this claude process; alias target = this key
      const mcpFile = path.join(os.tmpdir(), `mcp-room-${S.key.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
      try {
        fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { playwright: { type: 'http', url: roomUrl } } }));
        args.push('--mcp-config', mcpFile, '--strict-mcp-config');
      } catch (e) { console.log('[Bridge] shim mcp-config write failed:', e.message); }
    }
    if (S.sessionId) args.push('--resume', S.sessionId);

    const claudeEnv = { ...process.env };
    // Ensure critical env vars are present for Claude to find settings.json and MCP servers
    if (!claudeEnv.HOME) claudeEnv.HOME = process.env.HOME || '/root';
    if (!claudeEnv.PATH) claudeEnv.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    if (CREDENTIAL_STEWARD_ENABLED) {
      const _confTurn = !!(S.conf && S.conf.status === 'running' && S.conf.activeTurnId);   // [CONF_CRED_RETRY_V1]
      if (_confTurn) confLeaseBeginAttempt(S, 'claude');   // durable pre-issuance attempt lease
      try {
        if (!S.credentialClaudeAccount) S.credentialClaudeAccount = stewardText(['active-claude']);
        const safeRoom = S.key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
        S.credentialRuntimeDir = path.join(CREDENTIAL_STATE_DIR, 'runtime', 'claude', S.credentialClaudeAccount, safeRoom);
        const issued = JSON.parse(stewardText(['issue-claude', S.credentialClaudeAccount, S.credentialRuntimeDir]));
        claudeEnv.CLAUDE_CONFIG_DIR = S.credentialRuntimeDir;
        // Persistent Claude workers are retired before their access-only token expires;
        // the next turn resumes the transcript with a newly issued generation.
        const retireIn = Math.max(60000, Number(issued.expiresAt || 0) - Date.now() - 10 * 60000);
        if (S.credentialTimer) clearTimeout(S.credentialTimer);
        S.credentialTimer = setTimeout(() => S.killCurrentProc('credential generation retirement'), retireIn);
      } catch (e) {
        console.error('[Bridge] credential steward Claude issuance failed:', e.message);   // raw detail: LOG ONLY
        const cat = classifyIssueError(e);
        if (_confTurn) { confSpawnFailed(S, { engine: 'claude', cat: cat }); return { ok: false, err: { engine: 'claude', cat: cat } }; }
        S.send({ type: 'error', text: confCredMessage(cat === 'reauth' ? 'reauth' : (cat === 'transient' ? 'exhausted' : 'unknown'), { engineLabel: 'Claude' }) });
        return { ok: false, err: { engine: 'claude', cat: cat } };
      }
    }
    // Per-user self-service auth: if the user re-authenticated via the
    // settings menu, a long-lived OAuth token sits in ~/.claude/bridge-oauth-token.
    try {
      const _tokPath = path.join(claudeEnv.HOME || os.homedir(), '.claude', 'bridge-oauth-token');
      const _tok = fs.readFileSync(_tokPath, 'utf8').trim();
      if (_tok) claudeEnv.CLAUDE_CODE_OAUTH_TOKEN = _tok;
    } catch {}
    // Throttled: run this turn in debug so the API response headers (carrying the
    // official 5h/7d utilization) print to stdout, where scrapeRateLimits() reads
    // them. The extra debug lines are dropped, not shown to the user.
    if (shouldCaptureRates()) claudeEnv.ANTHROPIC_LOG = 'debug';

    touchBrowserWanted();
    // (Re)assert the shim's draft->session alias with a short retry ladder so a shim
    // that is flapping at this exact instant cannot permanently orphan the live viewer.
    // The shim persists the alias to disk once it lands, so a single success is durable.
    const assertRoomAlias = (mountKey, sessionId) => {
      const delays = [0, 2000, 8000];
      const tryOnce = (i) => {
        fetch(`http://127.0.0.1:${SHIM_PORT}/admin/rekey/${encodeURIComponent(mountKey)}/${encodeURIComponent(sessionId)}`, { method: 'POST' })
          .then((r) => { if (!r.ok && i + 1 < delays.length) setTimeout(() => tryOnce(i + 1), delays[i + 1]); })
          .catch(() => { if (i + 1 < delays.length) setTimeout(() => tryOnce(i + 1), delays[i + 1]); });
      };
      tryOnce(0);
    };
    const proc = spawn('claude', args, { cwd: CLAUDE_CWD, env: claudeEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    S.currentProc = proc;
    S.procEngine = 'claude';
    S.lastEngine = 'claude';
    // Startup watchdog: must produce first output within 2 min (catches MCP init hangs).
    S.armWatch(CLAUDE_STARTUP_TIMEOUT, '⏱ Claude failed to start (MCP/init timeout) — session reset.');

    let buf = '';
    proc.stdout.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        scrapeRateLimits(line);                  // pull rate-limit headers (debug mode); cheap no-op otherwise
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }   // drop non-JSON debug noise
        if (!ev || typeof ev !== 'object' || !ev.type) continue;   // ignore stray fragments

        if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
          S.sessionId = ev.session_id;
          confLeaseCommit(S, S.conf ? S.conf.activeTurnId : null);   // [CONF_CRED_RETRY_V1] process started
          // Durable viewer alias: (re)assert shim mount->session on EVERY init, so a
          // promotion whose one-shot POST was lost to a shim flap (or the collision
          // path) still links the pane. Retries a transient shim-down. [ALIAS_REASSERT_V1]
          if (ROOMVIEW_PORT && SHIM_PORT && S.shimMountKey && S.shimMountKey !== ev.session_id) assertRoomAlias(S.shimMountKey, ev.session_id);
          // Re-key a brand-new room from its draft id to the real Claude session id
          // so a second device opening this conversation joins the *live* room.
          if (S.key && S.key !== ev.session_id && !sessionFileExists(S.key) && String(S.key).startsWith('draft-')) {
            const _oldKey = S.key;
            const _existing = clientSessions.get(ev.session_id);
            if (_existing && _existing !== S) {
              // Real id already owns a live room (user navigated to it while this
              // draft was promoting). Don't overwrite it — keep this draft on its own
              // key to avoid splitting room identity across two room objects.
              console.log('[Bridge] Draft-promote collision — keeping draft key', _oldKey, 'wanted', ev.session_id);
            } else {
            clientSessions.delete(S.key);
            S.key = ev.session_id;
            clientSessions.set(S.key, S);
            // [CONFERENCE_V2] Atomic conference state migration: persist under the
            // canonical (session) key FIRST, then leave an inert tombstone at the draft
            // key so a stale alias/gate can never enforce the wrong phase. Fail-closed:
            // on any state conflict, pause rather than guess.
            if (S.conf) {
              try {
                const _canonFile = confFile(ev.session_id);
                let _conflict = false;
                try { const _ex = JSON.parse(fs.readFileSync(_canonFile, 'utf8'));
                  if (_ex && (_ex.status === 'running' || _ex.status === 'paused') &&
                      (Array.isArray(_ex.log) ? _ex.log.length : 0) !== (Array.isArray(S.conf.log) ? S.conf.log.length : 0)) _conflict = true; } catch (e) {}
                if (_conflict) {
                  console.log('[Bridge] [CONFERENCE_V2] rekey conflict — pausing', _oldKey, '->', ev.session_id);
                  S.conf.status = 'paused'; S.conf.activeTurnId = null;
                  S.conf.pausedReason = 'Recovery: conflicting conference state during room promotion. Resume to continue.';
                }
                fs.mkdirSync(CONF_DIR, { recursive: true });
                fs.writeFileSync(_canonFile, JSON.stringify(S.conf));   // canonical first
                fs.writeFileSync(confFile(_oldKey), JSON.stringify({ status: 'superseded', supersededBy: ev.session_id, ts: Date.now() }));   // inert tombstone
                confClearDenials(_oldKey);
              } catch (e) { console.log('[Bridge] [CONFERENCE_V2] conf migrate failed:', e.message); }
            }
            // [CONF_CONTAINED_V1] Move the room's own content store onto the canonical key too.
            try { if (chatData[_oldKey]) { chatData[ev.session_id] = chatData[_oldKey]; delete chatData[_oldKey]; saveChatData(); } } catch (_) {}
            // Move this room's browser stack onto the real key too, so later MCP/noVNC
            // lookups by S.key (and by the client's promoted room id) find the SAME
            // running stack instead of spawning a second one under the new key.
            if (roomStack) { try { roomStack.rekey(_oldKey, ev.session_id); } catch {} }
            // Live viewer (task 190): tell the shim the promoted id aliases the draft
            // room, so the pane (keyed on the promoted id) follows Claude's tab. Gated
            // on ROOMVIEW_PORT => a no-op (never fired) when the viewer is off.
            if (ROOMVIEW_PORT && SHIM_PORT) { try { fetch(`http://127.0.0.1:${SHIM_PORT}/admin/rekey/${encodeURIComponent(_oldKey)}/${encodeURIComponent(ev.session_id)}`, { method: 'POST' }).catch(() => {}); } catch {} }
            clearPending(_oldKey);   // drop the draft-keyed journal; re-journal under the real id below
            }
          }
          S.send({ type: 'session_id', id: S.sessionId });
          journalPending(S);   // upgrade the journal now that we have the real session id
          persistRoom(S);   // [CODEX_DURABLE_V2]
        }

        if (S.conf && S.conf.status === 'running' && S.conf.activeTurnId) {   // [CONFERENCE_V1] capture this turn's text server-side
          if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
            for (const b of ev.message.content) { if (b && b.type === 'text' && b.text) S.conf._accParts = (S.conf._accParts || '') + b.text + '\n'; }
          } else if (ev.type === 'result' && typeof ev.result === 'string' && ev.result) { S.conf._acc = ev.result; }
        }
        // [CONFERENCE_HISTORY_V1] Tag conference stream chunks with the active turn id
        // so the client can reconcile the live preview bubble by stable identity.
        S.send({ type: 'stream', data: ev, confTurnId: (S.conf && S.conf.status === 'running') ? (S.conf.activeTurnId || null) : null });

        if (ev.type === 'result') {
          proc._ok = true;   // [CONF_CRED_RETRY_V1] terminal success reached — close is a clean exit
          // One turn finished. More turns follow if the user queued messages.
          const ctx = updateCtxFromResult(ev);
          if (ctx != null) { S.ctxPct = ctx.pct; S.ctxTokens = ctx.tokens; }
          S.retried = false;
          if (S.inFlight.length) S.inFlight.shift();
          S.pendingTurns = Math.max(0, S.pendingTurns - 1);
          journalPending(S);   // record remaining queued turns, or clear when none left
          if (S.pendingTurns > 0) {
            S.armWatch(CLAUDE_TIMEOUT_MS, WATCH_RUN);   // a queued turn is still coming
          } else {
            S.processing = false;
            S.clearWatch();
            S.send({ type: 'done', code: 0 });
            if (S.conf && S.conf.status === 'running' && S.conf.activeTurnId) { try { confFinishTurn(S, 'claude'); } catch (e) { console.log('[Bridge] [CONFERENCE_V1] finish(claude) failed:', e.message); } }
            try { autoNameRoom(S); } catch (e) {}
            S.maybeAutoCompact();
            S.evictIfReady();
          }
        } else {
          S.armWatch(CLAUDE_TIMEOUT_MS, WATCH_RUN);     // keep alive while output flows
        }
      }
    });

    proc.stderr.on('data', chunk => {
      const txt = chunk.toString().trim();
      if (txt) console.log('[claude stderr]', txt.slice(0, 300));
      if (/No conversation found with session ID/i.test(txt)) resumeMissing = true;
    });

    proc.on('close', code => {
      if (S.currentProc !== proc) return;
      S.clearWatch();
      S.currentProc = null;   // detach before any routing
      const wasProcessing = S.processing;
      S.processing = false;

      // [CONF_CRED_RETRY_V1] Pre-success exit during a live conference turn → shared FSM
      // failure path; never strand running+activeTurnId with no proc, never advance on
      // partial output. An open attempt lease ⇒ transient (credential/startup, retry);
      // a committed process that then crashed ⇒ runtime (pause, resumable). Skipped for
      // clean turns (proc._ok) and for all non-conference rooms.
      if (S.conf && S.conf.status === 'running' && S.conf.activeTurnId && !proc._ok) {
        // Claude credential issuance is fully SYNCHRONOUS in spawnProc; once a proc exists,
        // issuance already succeeded. A spawned-then-exited-before-`result` Claude is therefore
        // a runtime failure, never credential/transient — pause honestly (no futile retry).
        S.pendingTurns = 0; S.inFlight = []; clearPending(S.key);
        // confSpawnFailed is the sole messaging site (emits its own done/status).
        try { confSpawnFailed(S, { engine: 'claude', cat: 'runtime' }); }
        catch (e) { console.log('[Bridge] [CONF_CRED_RETRY_V1] claude conf-fail route failed:', e.message); }
        return;
      }

      // Self-heal a stale --resume (orphaned session id after an account swap):
      // drop the dead id, respawn fresh, and resend whatever was still in flight.
      if (resumeMissing && triedResume && !S.retried) {
        S.retried = true;
        S.sessionId = null;
        persistRoom(S);   // [CODEX_DURABLE_V3] drop the stale session id from the durable record
        const resend = S.inFlight.slice();
        S.inFlight = []; S.pendingTurns = 0;
        S.send({ type: 'status', text: 'Previous session expired — starting a fresh conversation.' });
        setTimeout(() => resend.forEach(t => S.sendToClaude(t)), 150);
        return;
      }

      clearPending(S.key);   // in-process close (claude exited/crashed) — UI got done, so no blip-replay
      S.pendingTurns = 0; S.inFlight = [];
      if (wasProcessing) { S.send({ type: 'done', code }); try { autoNameRoom(S); } catch (e) {} }   /* AUTONAME_CLOSE_V1: title even if the turn was killed */
      S.evictIfReady();
    });

    proc.on('error', err => {
      if (S.currentProc !== proc) return;
      S.clearWatch();
      S.currentProc = null;   // detach before routing
      S.processing = false; S.pendingTurns = 0; S.inFlight = [];
      console.error('[Bridge] spawn error:', err.message);
      // [CONF_CRED_RETRY_V1] pre-success proc error on a live conference turn → FSM path.
      if (S.conf && S.conf.status === 'running' && S.conf.activeTurnId && !proc._ok) {
        // Synchronous issuance (see close handler): an async proc error is runtime, not credential.
        clearPending(S.key);
        try { confSpawnFailed(S, { engine: 'claude', cat: 'runtime' }); }
        catch (e) { console.log('[Bridge] [CONF_CRED_RETRY_V1] claude err route failed:', e.message); }
        return;
      }
      S.send({ type: 'error', text: `Failed to start Claude: ${err.message}` });
    });
    return { ok: true };   // [CONF_CRED_RETRY_V1]
  };

  // Send one user turn. If the streaming process is already live, the message is
  // written straight into its stdin — queuing/steering the running session.
  // Otherwise a fresh process is spawned (resuming the session id when we have one).
  S._sendNow = (text) => {
    S.pendingEngine = 'claude';   // [CODEX_DURABLE_V4] journal tag
    const _seed = maybeSeed(S, 'claude', text);
    // [XENGINE_RESUME_V1] Cross INTO Claude: if this room already has a resumable
    // Claude session, RESUME it (append this seeded turn) rather than nulling the id
    // and forking a brand-new transcript = a duplicate room. The seed preamble still
    // carries the other engine's turns. Only start fresh when there is nothing to resume.
    if (_seed.crossed) { text = _seed.text; if (!S.sessionId || !sessionFileExists(S.sessionId)) S.sessionId = null; }
    // If an idle Codex proc still holds the slot, drop it so Claude spawns fresh.
    if (S.currentProc && S.procEngine === 'codex' && !S.processing) {
      try { S.currentProc.kill('SIGKILL'); } catch {}
      S.currentProc = null; S.procEngine = null;
    }
    // [CONF_ACCT_SWITCH_V1] A global account switch flagged this live idle Claude worker
    // for retirement; drop it so the turn below spawns fresh under the new account.
    if (S.pendingCredentialRefresh && S.currentProc && S.procEngine === 'claude' && !S.processing) {
      try { S.currentProc.kill('SIGKILL'); } catch {}
      S.currentProc = null; S.procEngine = null; S.pendingCredentialRefresh = false;
    }
    const fresh = !S.currentProc;
    const wasProcessing = S.processing;
    if (fresh) { const _r = S.spawnProc(); if (_r && _r.ok === false) return; }   // [CONF_CRED_RETRY_V1]
    if (!S.currentProc) return;
    S.inFlight.push(text);
    S.pendingTurns++;
    S.processing = true;
    journalPending(S);   // persist this turn so a bridge blip can re-inject it
    if (!wasProcessing) S.send({ type: 'thinking' });   // only show the spinner when starting from idle
    try { S.currentProc.stdin.write(userMsgJSON(text)); }
    catch (e) { console.error('[Bridge] stdin write failed:', e.message); }
    if (!fresh) S.armWatch(CLAUDE_TIMEOUT_MS, WATCH_RUN);
  };

  // Send one user turn. If the streaming process is already live, the message is
  // written straight into its stdin — queuing/steering the running session.
  // Otherwise a fresh process is spawned (resuming the session id when we have one).
  //
  // With per-room browsers on, a FRESH spawn must wait for this room's own browser
  // stack (its Playwright MCP) to be listening first, or Claude's MCP init would hang
  // and hit the 2-min startup watchdog. We show the spinner immediately, await
  // ensureRoom (fast when already warm / re-adopted), then spawn. ensureRoom failure
  // is non-fatal: _sendNow still runs and spawnProc falls back to shim/global MCP.
  // ── Codex engine (ENGINE=codex) ────────────────────────────────────
  // Codex has no persistent stdin like Claude's stream-json; each turn is its own
  // `codex exec` process, resumed via thread_id. Follow-ups queue and run after the
  // current turn. --dangerously-bypass-hook-trust is REQUIRED for the DB safety hook
  // in ~/.codex to run (untrusted hooks are silently skipped). Only reached when
  // ENGINE==='codex', so the Claude path is untouched.
  // Resolve THIS room's Playwright MCP URL for Codex, mirroring spawnProc's
  // ladder (per-room isolated browser -> shared-Chrome shim -> none). Codex gets
  // the same browser Claude does; null => Codex runs without browser tools.
  S._codexMcpUrl = () => {
    try {
      if (roomStack) { const rp = roomStack.portsFor(S.key); if (rp && rp.mcp) return `http://localhost:${rp.mcp}/mcp`; }
      if (SHIM_PORT) return `http://localhost:${SHIM_PORT}/mcp/${encodeURIComponent(S.key)}`;
    } catch {}
    return null;
  };
  S._runCodexTurn = (text) => {
    S.processing = true;
    S.send({ type: 'thinking' });
    const _seed = maybeSeed(S, 'codex', text);
    if (_seed.crossed) { text = _seed.text; S.threadId = null; }   // [XENGINE_TRANSPLANT_V1] fresh seeded rollout
    // [CONFERENCE_V2 ARGORDER] codex sandbox: discussion/verification/final => read-only.
    // ALL exec-level options (sandbox, approval config, --json, --skip-git-repo-check,
    // --dangerously-bypass-hook-trust) MUST precede the `resume` subcommand + thread id;
    // codex accepts -s/--sandbox ONLY at the exec level, never after `resume <id>`.
    let _cxConfMode = null;
    try { if (S.conf && (S.conf.status === 'running' || S.conf.status === 'paused')) _cxConfMode = confRestrictionMode(S.conf); } catch (e) {}
    const _cxReadOnly = _cxConfMode && _cxConfMode !== 'write';
    const _mcpUrl = _cxReadOnly ? null : S._codexMcpUrl();
    const args = ['exec'];
    if (_cxReadOnly) args.push('--sandbox', 'read-only', '-c', 'approval_policy="never"');
    args.push('--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust');
    if (S.threadId) args.push('resume', S.threadId, text);
    else args.push(text);
    const env = { ...process.env };
    if (!env.HOME) env.HOME = os.homedir();
    // Browser parity via shell `browser` CLI (MCP tools are deferred/stranded in
    // codex exec on gpt-5.6-sol). CLI proxies to this room's Playwright shim.
    if (_mcpUrl) { env.CODEX_BROWSER_MCP_URL = _mcpUrl; env.PATH = '/usr/local/bin:' + (env.PATH || ''); }
    let proc, codexAccount = null;
    touchBrowserWanted();
    const _cxConfTurn = !!(S.conf && S.conf.status === 'running' && S.conf.activeTurnId);   // [CONF_CRED_RETRY_V1]
    if (CREDENTIAL_STEWARD_ENABLED) {
      if (_cxConfTurn) confLeaseBeginAttempt(S, 'codex');
      try {
        if (!S.credentialCodexAccount) S.credentialCodexAccount = stewardText(['active-codex']);
        codexAccount = S.credentialCodexAccount;
        env.CODEX_HOME = stewardText(['prepare-codex', codexAccount]);
      } catch (e) {
        console.error('[Bridge] credential steward Codex issuance failed:', e.message);   // raw detail: LOG ONLY
        const cat = classifyIssueError(e);
        S.processing = false; S.inFlight = []; S.codexQueue = []; clearPending(S.key);
        if (_cxConfTurn) { confSpawnFailed(S, { engine: 'codex', cat: cat }); return; }
        S.send({ type: 'error', text: confCredMessage(cat === 'reauth' ? 'reauth' : (cat === 'transient' ? 'exhausted' : 'unknown'), { engineLabel: 'Codex' }) });
        S.send({ type: 'done', code: -1 }); return;
      }
    }
    try {
      if (CREDENTIAL_STEWARD_ENABLED) {
        const lock = path.join(CREDENTIAL_STATE_DIR, `codex-${codexAccount}.lock`);
        // [CONF_CRED_RETRY_V1] Durable lock-contention discriminator: the instant flock
        // holds the lock, the wrapper prints __LOCK_ACQUIRED__ to stderr. A nonzero exit
        // with NO sentinel seen ⇒ flock timed out before acquiring (retryable transient);
        // a nonzero exit AFTER the sentinel ⇒ Codex's own exit (runtime), regardless of
        // Codex's exit-code space. Sentinel is stripped from all user-visible output.
        proc = spawn('flock', ['-w', '30', lock, 'bash', '-c', 'printf "__LOCK_ACQUIRED__\\n" >&2; exec codex "$@"', 'flockwrap', ...args], { cwd: CLAUDE_CWD, env, stdio: ['ignore', 'pipe', 'pipe'] });
      } else {
        proc = spawn('codex', args, { cwd: CLAUDE_CWD, env, stdio: ['ignore', 'pipe', 'pipe'] });
      }
    }
    catch (e) { S.processing = false; S.inFlight = []; S.codexQueue = []; clearPending(S.key); if (_cxConfTurn) { confSpawnFailed(S, { engine: 'codex', cat: 'transient' }); return; } S.send({ type: 'error', text: 'Codex could not start. Resume to try again.' }); S.send({ type: 'done', code: -1 }); return; }   // [CONF_CRED_RETRY_V1]
    S.currentProc = proc;
    S.procEngine = 'codex';
    S.lastEngine = 'codex';
    S.armWatch(CLAUDE_STARTUP_TIMEOUT, '\u23F1 Codex failed to start \u2014 session reset.');
    let accountEmail = '';
    try { accountEmail = codexEmail(JSON.parse(fs.readFileSync(CODEX_AUTH, 'utf8'))); } catch {}
    const errors = createCodexErrorReporter(data => S.send(data), accountEmail);
    let buf = '';
    // [CONF_CRED_RETRY_V1] async-failure discriminators for the terminal handlers:
    // lockAcquired = flock sentinel seen (across chunk boundaries); sawFailure = Codex
    // reported turn.failed/error before exit (partial output must NOT advance the FSM).
    let lockAcquired = false, sawFailure = false, _stderrTail = '';
    proc.stdout.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (!ev || !ev.type) continue;
        if (ev.type === 'turn.failed' || ev.type === 'error') {
          sawFailure = true;   // [CONF_CRED_RETRY_V1] pre-exit failure signal
          errors.failed((ev.error && ev.error.message) || ev.message || '');
        }
        for (const m of parseCodexEvent(ev)) {
          if (m.kind === 'session') { S.threadId = m.id; persistRoom(S); confLeaseCommit(S, S.conf ? S.conf.activeTurnId : null); S.send({ type: 'session_id', id: m.id }); }  // [CODEX_DURABLE_V2]
          else if (m.kind === 'stream') { if (S.conf && S.conf.status === 'running' && S.conf.activeTurnId && m.data && m.data.type === 'assistant' && m.data.message) { for (const b of (m.data.message.content || [])) { if (b && b.type === 'text' && b.text) S.conf._accParts = (S.conf._accParts || '') + b.text + '\n'; } } S.send({ type: 'stream', data: m.data, confTurnId: (S.conf && S.conf.status === 'running') ? (S.conf.activeTurnId || null) : null }); }
          else if (m.kind === 'result' && m.usage) {
            // cached_input_tokens is a subset of input_tokens in Codex usage.
            S.codexCtxTokens = Number(m.usage.input_tokens || 0);
            S.send({ type: 'codex_usage', usage: m.usage, ctxTokens: S.codexCtxTokens });
          }
        }
        S.armWatch(CLAUDE_TIMEOUT_MS, WATCH_RUN);
      }
    });
    proc.stderr.on('data', d => {
      let s = d.toString();
      // [CONF_CRED_RETRY_V1] detect the flock sentinel across chunk boundaries, then
      // strip it so it never reaches logs or the user.
      if (!lockAcquired) {
        const combined = _stderrTail + s;
        if (combined.indexOf('__LOCK_ACQUIRED__') !== -1) lockAcquired = true;
        _stderrTail = combined.slice(-32);
      }
      s = s.replace(/__LOCK_ACQUIRED__\n?/g, '');
      if (s) { console.log('[codex stderr]', s.slice(0, 300)); errors.stderr(s); }
    });
    // [CONF_CRED_RETRY_V1] Route a pre-completion conference failure through the shared
    // FSM handler (transient=retry, runtime=pause) instead of stranding or advancing.
    // NON-conference rooms and clean successes are byte-identical to before.
    const _cxConfFail = (cat) => {
      S.inFlight = []; S.codexQueue = []; clearPending(S.key);
      try { confSpawnFailed(S, { engine: 'codex', cat: cat }); }
      catch (e) { console.log('[Bridge] [CONF_CRED_RETRY_V1] codex conf-fail route failed:', e.message); }
    };
    proc.on('error', e => {
      if (S.currentProc !== proc) return;
      S.currentProc = null; S.clearWatch(); S.processing = false;   // detach before routing
      console.log('[Bridge] codex proc error:', e.message);
      if (S.conf && S.conf.status === 'running' && S.conf.activeTurnId) return _cxConfFail('runtime');
    });
    proc.on('close', code => {
      if (S.currentProc !== proc) return;
      S.currentProc = null;   // [CONF_CRED_RETRY_V1] detach before any routing/scheduling
      if (CREDENTIAL_STEWARD_ENABLED && codexAccount) {
        try { stewardText(['finalize-codex', codexAccount]); }
        catch (e) { console.error('[Bridge] Codex credential reconciliation failed:', e.message); }
      }
      S.clearWatch(); S.processing = false;
      // [CONF_CRED_RETRY_V1] Pre-success exit during a live conference turn: a nonzero
      // exit or a reported failure must NOT run confFinishTurn (which would advance on
      // empty/partial output). Lock-timeout (no sentinel) or an open attempt lease ⇒
      // transient (retry); any other pre-success exit ⇒ runtime (pause, resumable).
      const _confActive = S.conf && S.conf.status === 'running' && S.conf.activeTurnId;
      if (_confActive && (code !== 0 || sawFailure)) {
        // Codex credential issuance (prepare/active-codex) is synchronous too; the ONLY async
        // credential/lock signal is flock never acquiring the lock (no sentinel). That alone is
        // lock-transient (retry). Any other nonzero exit — Codex ran (sentinel seen) then failed —
        // is runtime (pause). Never infer transient from the recovery lease being open.
        const _lockTimeout = CREDENTIAL_STEWARD_ENABLED && !lockAcquired;
        // confSpawnFailed is the sole messaging site (emits its own done/status).
        return _cxConfFail(_lockTimeout ? 'transient' : 'runtime');
      }
      S.send({ type: 'done', code: code || 0 });
      if (S.inFlight.length) S.inFlight.shift();   // [CODEX_DURABLE_V4] drop the completed prompt only
      const q = S.codexQueue || [];
      if (q.length) {
        journalPending(S);                          // [CODEX_DURABLE_V4] rewrite journal before the next queued turn
        const next = q.shift();
        setTimeout(() => S._runCodexTurn(next), 50);
      } else {
        clearPending(S.key);                        // [CODEX_DURABLE_V4] queue drained — clear recovery state
        try { autoNameRoom(S); } catch (e) {}       /* AUTONAME_CODEX_V1 */
        if (S.conf && S.conf.status === 'running' && S.conf.activeTurnId) { try { confFinishTurn(S, 'codex'); } catch (e) { console.log('[Bridge] [CONFERENCE_V1] finish(codex) failed:', e.message); } }
        if (S.evictIfReady) S.evictIfReady();
      }
    });
  };
  S._sendCodex = (text) => {
    S.codexQueue = S.codexQueue || [];
    S.pendingEngine = 'codex';        // [CODEX_DURABLE_V4] journal tag
    S.inFlight.push(text);            // [CODEX_DURABLE_V4] enter the durable queue exactly once (active or queued)
    journalPending(S);                // persist so a bridge blip can re-inject this Codex turn
    // An idle *Claude* persistent proc occupies the slot but isn't a Codex turn
    // in flight. Tear it down so Codex can run; Claude losslessly resumes from
    // its transcript (--resume <sessionId>) on its next turn.
    if (S.currentProc && S.procEngine === 'claude' && !S.processing) {
      try { S.currentProc.kill('SIGKILL'); } catch {}
      S.currentProc = null; S.procEngine = null;
    }
    if (S.processing || S.currentProc) { S.codexQueue.push(text); return; }
    // Warm this room's browser first so _codexMcpUrl() resolves the per-room
    // port (mirrors Claude's sendToClaude). Non-fatal: falls back to shim/none.
    if (roomStack) {
      S.processing = true; S.send({ type: 'thinking' });
      roomStack.ensureRoom(S.key)
        .catch(e => console.log('[Bridge] ensureRoom (codex) failed, using fallback MCP:', e.message))
        .then(() => { S.processing = false; S._runCodexTurn(text); });
      return;
    }
    S._runCodexTurn(text);
  };

  // [CODEX_DURABLE_V4] Dispatch to a SPECIFIC engine without touching the room's saved
  // engineOverride, preserving each engine's browser-warming. Used by normal dispatch
  // (via sendToClaude) and by blip-replay recovery.
  S.sendToEngine = (engine, text) => {
    if (engine === 'codex') return S._sendCodex(text);
    if (roomStack && !S.currentProc) {
      if (!S.processing) S.send({ type: 'thinking' });
      roomStack.ensureRoom(S.key)
        .catch(e => console.log('[Bridge] ensureRoom failed, using fallback MCP:', e.message))
        .then(() => S._sendNow(text));
      return;
    }
    S._sendNow(text);
  };
  S.sendToClaude = (text) => S.sendToEngine((S.engineOverride || currentEngine()), text);

  S.maybeAutoCompact = () => {
    if (S.conf && S.conf.status === 'running') return;   // [CONFERENCE_V1] never inject /compact during a conference
    const tokenBudget = AUTO_COMPACT_TOKENS > 0;
    if (!tokenBudget && AUTO_COMPACT_PCT <= 0) return;
    if (S.compacting) { S.compacting = false; return; }
    if (S.processing || S.pendingTurns > 0) return;
    const over = tokenBudget
      ? (S.ctxTokens != null && S.ctxTokens >= AUTO_COMPACT_TOKENS)
      : (S.ctxPct != null && S.ctxPct >= AUTO_COMPACT_PCT);
    if (!over) return;
    if (Date.now() - S.lastCompactAt < AUTO_COMPACT_COOLDOWN_MS) return;
    S.compacting = true;
    S.lastCompactAt = Date.now();
    const where = tokenBudget ? `${S.ctxTokens} tokens (threshold ${AUTO_COMPACT_TOKENS})` : `${S.ctxPct}% (threshold ${AUTO_COMPACT_PCT}%)`;
    const human = tokenBudget ? `~${Math.round(S.ctxTokens / 1000)}k tokens` : `${S.ctxPct}%`;
    console.log(`[Bridge] Auto-compacting session ${S.sessionId} at ${where}`);
    S.send({ type: 'status', text: `🗜 Context at ${human} — auto-compacting to free space…` });
    S.sendToClaude('/compact');
  };

  return S;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let S = null;   // the client session this socket is currently driving

  // Bind this socket to a (possibly pre-existing) client session. If that session
  // still has a live Claude process from a socket that just disconnected, we
  // reattach: cancel its grace timer and flush everything buffered while detached,
  // so an in-flight answer survives a refresh / blip.
  function attach(clientId, roomId) {
    // Room keyed by roomId: devices sharing a roomId share the room object and
    // mirror; a different roomId gets its own room + Claude process. Default
    // 'shared' preserves single-room behaviour for clients that send no roomId.
    const key = (typeof roomId === 'string' && roomId.slice(0, 80)) || 'shared';
    // [ROOMLINK_V1] Resolvability BEFORE makeSession (which would create an empty entry
    // that must NOT count). A room is resolvable only with meaningful durable state; a
    // draft-* id is never resolvable. Used to warn a device that opened an unresolvable
    // shared link instead of silently showing an empty/wrong room.
    const _rlRec = _loadRoomMap()[key];
    const _rlLive = clientSessions.get(key);
    const _rlResolvable = key !== 'shared'
      && !String(key).startsWith('draft-')
      && (sessionFileExists(key) || !!(_rlRec && (_rlRec.sessionId || _rlRec.threadId)) || !!chatData[key] || !!(_rlLive && (_rlLive.sessionId || _rlLive.threadId)));
    S = clientSessions.get(key);
    if (!S) {
      S = makeSession(key);
      // If the room key is an existing Claude transcript, resume it on next turn.
      if (sessionFileExists(key)) S.sessionId = key;
      restoreRoom(S);   // [CODEX_DURABLE_V2] re-derive threadId/lastEngine/engineOverride from disk
      clientSessions.set(key, S);
    }
    if (S.graceTimer) { clearTimeout(S.graceTimer); S.graceTimer = null; }
    S.evictWhenIdle = false;
    S.sockets.add(ws);
    S.lastActiveAt = Date.now();
    console.log('[Bridge] Client attached:', clientId, 'room', key, `(${S.sockets.size} socket(s))`, S.processing ? '(reattached mid-turn)' : '');
    // Send status/session/state directly to this socket only (others are already up to date).
    ws.send(JSON.stringify({ type: 'status', text: 'Connected to Claude Code bridge. Ready.' }));
    if (S.buffer.length) { const b = S.buffer; S.buffer = []; for (const d of b) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(d)); } }
    if (S.sessionId) {
      ws.send(JSON.stringify({ type: 'session_id', id: S.sessionId }));
      // Push saved history so a second device loads the same conversation.
      const hist = chatData[S.sessionId];
      if (hist && Array.isArray(hist.messages) && hist.messages.length) {
        ws.send(JSON.stringify({ type: 'history_sync', messages: hist.messages }));
      }
    }
    // [ROOMLINK_V1] The link named a room we cannot resolve to any real conversation: tell
    // the client so it can show an honest "not found" notice instead of silently sitting in
    // an empty/different room. Harmless for older clients (unknown message type is ignored).
    if (!_rlResolvable && key !== 'shared') {
      ws.send(JSON.stringify({ type: 'room_unresolved', roomId: key, kind: String(key).startsWith('draft-') ? 'draft' : 'unknown' }));
    }
    ws.send(JSON.stringify(S.engineState()));
    if (S.processing) ws.send(JSON.stringify({ type: 'thinking' }));
    try {
      const _cdisk = confLoad(S.key);   // [CONFERENCE_ROOMSWITCH_V1] load inside try so a read failure follows the intended error handling
      if (S.conf || (_cdisk && _cdisk.status !== 'superseded')) confRecover(S);
      else ws.send(JSON.stringify({ type: 'conf_status', status: 'idle' }));   // authoritative "no conference here"; FIFO-ordered after any stale old-room frames
    } catch (e) { console.log('[Bridge] [CONFERENCE_V1] confRecover failed:', e.message); }
  }

  // Remove a socket from its room; when the room empties, start the grace timer
  // and evict the room afterwards so the Map can't grow without bound.
  function detach(sock, sess) {
    if (!sess) return;
    sess.sockets.delete(sock);
    if (sess.sockets.size > 0) {
      console.log('[Bridge] Socket left room', sess.key, '—', sess.sockets.size, 'still connected');
      return;
    }
    sess.lastActiveAt = Date.now();
    // Session-backed rooms stay warm far longer so switching away from an idle
    // room doesn't tear it down; anon/draft rooms keep the short reconnect grace.
    // The warm-room cap bounds how many live idle procs we keep on the container.
    const graceMs = (sess.sessionId || sess.threadId) ? WARM_ROOM_TTL_MS : RECONNECT_GRACE_MS;   // [CODEX_DURABLE_V2]
    console.log('[Bridge] Room', sess.key, `empty — grace ${Math.round(graceMs / 1000)}s`);
    if (sess.sessionId || sess.threadId) enforceWarmCap(sess);   // [CODEX_DURABLE_V2]
    clearTimeout(sess.graceTimer);
    sess.graceTimer = setTimeout(() => {
      if (sess.conf && sess.conf.status === 'running') { sess.evictWhenIdle = true; console.log('[Bridge] [CONFERENCE_V1] grace expired but conference running — keeping room alive:', sess.key); return; }
      if (sess.processing || sess.pendingTurns > 0) {
        // A turn is still running with no devices attached. Don't kill it —
        // let it finish in the background; evict once it goes idle (evictIfReady).
        sess.evictWhenIdle = true;
        console.log('[Bridge] Grace expired but turn in flight — keeping room alive:', sess.key);
        return;
      }
      sess.killCurrentProc('grace expired');
      clientSessions.delete(sess.key);
      console.log('[Bridge] Grace expired — room closed:', sess.key);
    }, graceMs);
  }

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // The client announces its stable id first so we can reattach a live session.
    if (msg.type === 'hello') {
      const cid = (typeof msg.clientId === 'string' && msg.clientId.slice(0, 64)) || ('anon-' + Date.now());
      ws._clientId = cid;
      const room = (typeof msg.roomId === 'string' && msg.roomId.slice(0, 80)) || 'shared';
      attach(cid, room);
      return;
    }
    // Fallback for older/cached clients that don't send hello: shared room.
    if (!S) { ws._clientId = ws._clientId || ('anon-' + Math.random().toString(36).slice(2)); attach(ws._clientId, 'shared'); }

    if (msg.type === 'ping') {
      S.send({ type: 'pong', ts: Date.now() });
    } else if (msg.type === 'status_query') {
      // Client stall-watchdog liveness probe: report this room's real turn
      // state so the UI can self-recover a missed 'done' (permanent spinner).
      ws.send(JSON.stringify({ type: 'room_status', processing: !!S.processing, pendingTurns: S.pendingTurns || 0 }));
    } else if (msg.type === 'set_engine') {
      if (msg.roomId !== S.key || !['claude', 'codex', 'global'].includes(msg.mode)) return;
      if (S.processing || S.pendingTurns > 0 || confActive(S)) {
        ws.send(JSON.stringify(S.engineState('Engine unchanged: a turn or conference is still active. Wait for it to finish, or press Stop, then select the engine again.')));
        return;
      }
      S.engineOverride = msg.mode === 'global' ? null : msg.mode;
      persistRoom(S);
      S.send(S.engineState());
    } else if (msg.type === 'chat') {
      // Guard against socket drift: reconnect races can leave this socket bound to
      // a different room than the UI shows. Re-bind to the room the client says it
      // is in before dispatching, so a message never lands in the wrong room.
      if (typeof msg.roomId === 'string' && msg.roomId && S && S.key !== msg.roomId.slice(0, 80)) {
        const _want = msg.roomId.slice(0, 80);
        console.log('[Bridge] chat room drift: socket in', S.key, 'but client says', _want, '— re-binding');
        detach(ws, S);
        attach(ws._clientId, _want);
      }
      // Only accept attachment paths that the server itself created under
      // UPLOAD_DIR — never let a client point Claude at an arbitrary file.
      const atts = (Array.isArray(msg.attachments) ? msg.attachments : [])
        .filter(a => a && typeof a.path === 'string'
          && path.resolve(a.path).startsWith(UPLOAD_DIR + path.sep)
          && fs.existsSync(a.path));
      let prompt = (msg.text || '').trim();
      if (atts.length) {
        const list = atts.map(a => `- ${a.path}`).join('\n');
        prompt += `${prompt ? '\n\n' : ''}[The user attached ${atts.length} file(s). ` +
          `Use your Read tool to open ${atts.length > 1 ? 'each path' : 'the path'} below ` +
          `(images render visually) before responding:\n${list}\n]`;
      }
      if (!prompt.trim()) return;
      // Broadcast the user's text to all OTHER sockets so every device shows the prompt.
      const displayText = (msg.text || '').trim();
      const _confFreshStart = (msg.engineMode === 'conference' && typeof msg.reqId === 'string' && !!msg.reqId);   // [CONF_TASK_ASSOC_V1]
      if (!_confFreshStart) for (const sock of S.sockets) {
        if (sock !== ws && sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({ type: 'user_msg', text: displayText }));
        }
      }
      // [CONFERENCE_V1] Conference is its own orchestration flow — handle first, before the guard.
      if (msg.engineMode === 'conference' || confActive(S)) {
        confTryStart(S, prompt, msg);   // [CONF_TASK_ASSOC_V1] idempotency + task-association gate
        return;
      }
      // [CODEX_DURABLE_V6] Never switch engines mid-turn — it would interleave the two
      // engines' queue/journal state. Hold the room's current engine, notify, and require
      // the user to resend once the active turn drains. Does NOT mutate engineOverride.
      {
        const _req = (msg.engineMode === 'claude' || msg.engineMode === 'codex') ? msg.engineMode
                   : (msg.engineMode === 'global' ? currentEngine() : null);
        if (S.processing && _req && _req !== (S.procEngine || S.engineOverride || currentEngine())) {
          S.send(S.engineState('Message not sent: a turn is still running on the previous engine. Wait or press Stop, then select the engine and resend your message.'));
          return;
        }
      }
      // Per-room override rides on the chat msg: 'claude'/'codex' pins THIS room;
      // 'global' (or absent) clears the pin so the room follows the pane engine.
      if (msg.engineMode === 'claude' || msg.engineMode === 'codex') S.engineOverride = msg.engineMode;
      else if (msg.engineMode === 'global') S.engineOverride = null;
      persistRoom(S);   // [CODEX_DURABLE_V2]
      // [ENGINE_AUTHORITATIVE_V1] Capture-once dispatch guard. Resolve the engine ONCE,
      // synchronously (before any await/callback), and never run under an engine the user
      // was not shown. The captured value is then passed explicitly to sendToEngine, which
      // does NOT re-resolve, so a marker flip after this point cannot change the turn.
      {
        const _captured = resolveRoomEngine(S);
        const _shown = (msg.displayedEngine === 'claude' || msg.displayedEngine === 'codex') ? msg.displayedEngine : null;
        if (!_shown) {
          S.send({ type: 'client_upgrade_required', roomId: S.key, engine: _captured.engine, mode: _captured.mode, rev: _captured.rev,
                   text: prompt, reason: 'This tab is out of date and could not confirm which engine it is showing. Please reload the page, then resend your message.' });
          return;
        }
        if (_shown !== _captured.engine) {
          const _lbl = _captured.engine === 'codex' ? 'Codex' : 'Claude';
          S.send({ type: 'engine_resync', roomId: S.key, engine: _captured.engine, mode: _captured.mode, rev: _captured.rev,
                   text: prompt, reason: 'The engine changed to ' + _lbl + ' since this view loaded — your message was not sent. It now shows ' + _lbl + '; resend to run on it.' });
          S.send(S.engineState());
          return;
        }
        S.turnEngine = _captured.engine;
        S.send({ type: 'turn_engine', engine: _captured.engine });
        S.sendToEngine(_captured.engine, prompt);
      }
    } else if (msg.type === 'resume_session') {
      // Join the room for this conversation (idempotent if already there).
      const target = (typeof msg.id === 'string' && msg.id.slice(0, 80)) || null;
      if (target && (!S || S.key !== target)) { detach(ws, S); attach(ws._clientId, target); }
    } else if (msg.type === 'adopt_session') {
      // Attach a specific Claude session id to the CURRENT (named/pinned) room
      // WITHOUT re-rooming, so a pinned-room client resumes its conversation after
      // a reconnect/restart while keeping its stable room key. Gentle: never
      // clobbers a live turn or an already-set session.
      const id = (typeof msg.id === 'string' && msg.id.slice(0, 80)) || null;
      if (id && S && !S.processing && !S.sessionId && sessionFileExists(id)) {   // [CODEX_DURABLE_V5] adopt a REAL Claude transcript only — never a Codex thread id
        S.sessionId = id;
        persistRoom(S);   // [CODEX_DURABLE_V3] persist adopted Claude session
        S.send({ type: 'session_id', id });
      }
    } else if (msg.type === 'conf_start') {   // [CONFERENCE_V1]
      const brief = (msg.brief || '').toString().trim();
      if (!brief) return;
      confTryStart(S, brief, msg);   // [CONF_TASK_ASSOC_V1]
    } else if (msg.type === 'conf_pause') { confPause(S);
    } else if (msg.type === 'conf_resume') { confResume(S);
    } else if (msg.type === 'conf_stop') { confStop(S);
    } else if (msg.type === 'compact') {
      console.log('[Bridge] Compacting session:', S.sessionId);
      S.sendToClaude('/compact');
    } else if (msg.type === 'cancel') {
      S.killCurrentProc('user cancel');
      S.send({ type: 'status', text: 'Cancelled.' });
    } else if (msg.type === 'reset') {
      S.killCurrentProc('user reset');
      S.sessionId = null;
      S.threadId = null; S.lastEngine = null; clearRoom(S.key);   // [CODEX_DURABLE_V3] drop both handles + durable record
      if (S.conf) { S.conf = null; S._confRecovered = false; confClearFile(S.key); }   // [CONFERENCE_V1]
      S.send({ type: 'status', text: 'Session reset — next message starts a fresh Claude session.' });
    } else if (msg.type === 'switch_session') {
      // Move this socket to another room. The old room keeps running for any other
      // devices on it (grace-evicted if it empties) — we do NOT kill it here.
      const target = (typeof msg.id === 'string' && msg.id.slice(0, 80)) || 'shared';
      if (!S || S.key !== target) {
        detach(ws, S);
        attach(ws._clientId, target);
        console.log('[Bridge] Socket switched to room:', target);
      }
    } else if (msg.type === 'save_history') {
      if (msg.sessionId && Array.isArray(msg.messages)) {
        try {
          chatData[msg.sessionId] = { messages: msg.messages, updated_at: Date.now() };
          saveChatData();
        } catch (e) {
          console.error('[Bridge] History save error:', e.message);
        }
      }
    }
  });

  ws.on('close', () => {
    detach(ws, S);
  });

  ws.on('error', err => console.error('[Bridge] WS error:', err.message));
});

server.on('error', (err) => {
  // If the port is already held (e.g. an orphaned sibling), exit instead of
  // lingering as a zombie — the watchdog will free the port and relaunch cleanly.
  console.error(`[Bridge] Server error on port ${BRIDGE_PORT}: ${err.code || err.message}`);
  process.exit(1);
});

// [CONF_CONTAINED_V1] Boot reconciler: backfill every existing conference side-file's
// user-visible content into the room's own store (chatData), so already-existing rooms
// become self-contained without waiting for a new turn. Idempotent; never deletes the
// side-file (operational FSM state) — only mirrors display content.
try {
  const _files = fs.existsSync(CONF_DIR) ? fs.readdirSync(CONF_DIR).filter(f => f.endsWith('.json')) : [];
  let _bn = 0;
  for (const _f of _files) {
    try {
      const _c = JSON.parse(fs.readFileSync(path.join(CONF_DIR, _f), 'utf8'));
      if (!_c || _c.status === 'superseded' || !Array.isArray(_c.log) || !_c.log.length) continue;
      const _key = _f.replace(/\.json$/, '');
      const _msgs = confLogToMessages(_c);
      const _have = chatData[_key];
      if (_have && _have.conf && Array.isArray(_have.messages) && _have.messages.length >= _msgs.length) continue;
      chatData[_key] = { messages: _msgs, updated_at: Date.now(), conf: true };
      _bn++;
    } catch (_) {}
  }
  if (_bn) { saveChatData(); console.log('[Bridge] [CONF_CONTAINED_V1] backfilled', _bn, 'conference room(s) into chatData'); }
} catch (e) { console.log('[Bridge] [CONF_CONTAINED_V1] boot reconcile failed:', e.message); }

server.listen(BRIDGE_PORT, '0.0.0.0', () => {
  console.log(`\n✅ Claude Code Bridge running`);
  console.log(`   HTTP:      http://0.0.0.0:${BRIDGE_PORT}`);
  console.log(`   WebSocket: ws://0.0.0.0:${BRIDGE_PORT}/ws`);
  console.log(`   noVNC URL: ${NOVNC_URL}`);
  console.log(`   Claude CWD: ${CLAUDE_CWD}\n`);
  // Re-inject any turns that were in flight when a previous instance was killed
  // (a blip). No-op unless RESUME_TURNS is enabled.
  try { setInterval(pollEngineMarker, 3000); } catch (e) {}
  try { replayPending(); } catch (e) { console.log('[Bridge] replayPending failed:', e.message); }
  // [CONF_ACTIVATION_V1] After the server + engines are up, re-open any conference whose
  // host was restarted to activate a fix. Deferred so sendToEngine has a live server.
  setTimeout(() => { try { confResumeActivations(); } catch (e) { console.log('[Bridge] [CONF_ACTIVATION_V1] resume sweep failed:', e.message); } }, 1500);
  setTimeout(() => { try { confResumeRetries(); } catch (e) { console.log('[Bridge] [CONF_CRED_RETRY_V1] retry sweep failed:', e.message); } }, 1600);
});
