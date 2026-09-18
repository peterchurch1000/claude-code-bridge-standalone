#!/usr/bin/env node
/* TASK_TITLE_HAIKU_V1 — server patcher (idempotent).
 * 1. Adds a Haiku-backed POST /task-title endpoint (5-7 word task titles).
 * 2. Makes confCanonicalTask fall back to the authoritative MariaDB task store
 *    when the .md has not been written yet (root cause of the double popup).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE = '/var/www/html/claude-code-bridge-standalone/bridge-server.js';
const BEGIN = '// >>> TASK_TITLE_HAIKU_V1_BEGIN';
const END = '// <<< TASK_TITLE_HAIKU_V1_END';

function check(f) { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }

let src = fs.readFileSync(FILE, 'utf8');
check(FILE);

const changes = [];

/* ── 1. helpers + endpoint ──────────────────────────────────────────────── */
const HELPERS = BEGIN + `
// Haiku-generated 5-7 word task titles for the conference task-association popup
// and the room->task "Create task & link" form. Mirrors autoNameRoom's spawn
// pattern (claude -p --model haiku, isolated scratch cwd) but is request/response.

// True only for something that reads like a 5-7 word label, not a sentence/refusal.
function looksLikeTaskTitle(str) {
  if (!str) return false;
  const words = String(str).split(' ').filter(Boolean);
  if (words.length < 5 || words.length > 7) return false;
  if (/[.?!:;]/.test(str)) return false;
  if (/\\b(instruction|provide|incomplete|sorry|cannot|unable|please|summar|the user|it seems|appears)\\b/i.test(str)) return false;
  return true;
}
function _firstUserLineText(line) {
  if (!line || line.indexOf('"role":"user"') === -1) return '';
  try {
    const ev = JSON.parse(line);
    if (ev.type === 'user' && ev.message && ev.message.role === 'user') {
      const t = extractText(ev.message.content);
      if (t) return t.replace(/\\s+/g, ' ').trim();
    }
  } catch {}
  return '';
}
// Unlike firstUserInstruction (400-char cap) this returns the WHOLE first user
// message — the popup's Description is the full instruction, untruncated.
// Reads in chunks and returns at the first complete user record, so it never
// walks a large transcript.
function firstUserFullText(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const { StringDecoder } = require('string_decoder');
    const dec = new StringDecoder('utf8');
    const buf = Buffer.alloc(131072);
    let carry = '';
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      carry += dec.write(buf.slice(0, n));       // decoder holds split multi-byte chars
      let nl;
      while ((nl = carry.indexOf('\\n')) !== -1) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        const t = _firstUserLineText(line);
        if (t) return t;
      }
    }
    carry += dec.end();
    if (carry) { const t = _firstUserLineText(carry); if (t) return t; }
  } catch {}
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
  return '';
}
// The model only needs the head of the request to summarise it.
function _taskTitlePromptSource(full) {
  let t = String(full || '').replace(/\\s+/g, ' ').trim();
  if (t.length > 400) { const cut = t.slice(0, 400); t = cut.slice(0, cut.lastIndexOf(' ') + 1).trim() || cut; }
  return t;
}
// A room id may be a client room key (draft) or a Claude session id.
function _resolveRoomSession(roomId) {
  if (!roomId || typeof roomId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(roomId)) return '';
  try { const S = clientSessions.get(roomId); if (S && S.sessionId) return S.sessionId; } catch {}
  try { if (sessionFileExists(roomId)) return roomId; } catch {}
  return '';
}
const TASK_TITLE_MAX_INFLIGHT = 2;
let _taskTitleInFlight = 0;
// deps is injectable so the test harness can drive the lifecycle without a real child.
function handleTaskTitle(req, res, deps) {
  deps = deps || {};
  const _spawn = deps.spawn || spawn;
  const body = (req && req.body) || {};
  let source = String(body.text == null ? '' : body.text).replace(/\\s+/g, ' ').trim();
  if (!source) {
    const sid = _resolveRoomSession(String(body.roomId || ''));
    if (sid) { try { source = firstUserFullText(path.join(transcriptsDir(), sid + '.jsonl')); } catch { source = ''; } }
  }
  const fallback = source.replace(/\\s+/g, ' ').trim().slice(0, 120);
  if (!source) { res.json({ ok: true, title: '', source: '', fallback: '' }); return; }
  if (_taskTitleInFlight >= TASK_TITLE_MAX_INFLIGHT) { res.json({ ok: true, title: '', source: source, fallback: fallback }); return; }

  let state = 'pending';      // 'pending' | 'responded' | 'cancelled'
  let cleaned = false, child = null, killer = null, out = '';
  _taskTitleInFlight++;
  function cleanup() {
    if (cleaned) return; cleaned = true;
    if (killer) { clearTimeout(killer); killer = null; }
    if (child) { try { child.kill('SIGKILL'); } catch {} }
    try { purgeAutonameScratch(); } catch {}
    _taskTitleInFlight = Math.max(0, _taskTitleInFlight - 1);
  }
  function settle(title) {
    if (state !== 'pending') return;
    if (res.destroyed || res.writableEnded) { state = 'cancelled'; return; }
    state = 'responded';
    res.json({ ok: true, title: title || '', source: source, fallback: fallback });
  }
  function cancel() { if (state === 'pending') state = 'cancelled'; cleanup(); }
  res.on('close', function () { if (!res.writableEnded) cancel(); });

  const prompt = 'Summarise the objective of this request as a 5 to 7 word Title Case label. '
    + 'Output ONLY the label — no punctuation, quotes, or explanation. '
    + 'If the request is cut off, infer the objective from what is present.\\n\\nRequest: '
    + _taskTitlePromptSource(source);
  try {
    child = _spawn('claude', ['-p', prompt, '--model', 'claude-haiku-4-5-20251001'],
      { cwd: AUTONAME_SCRATCH, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { settle(''); cleanup(); return; }
  try { child.stdout.on('data', c => { out += c.toString(); }); } catch {}
  try { child.stderr.on('data', () => {}); } catch {}
  killer = setTimeout(function () { cleanup(); settle(''); }, 13000);
  child.on('error', function () { settle(''); cleanup(); });
  child.on('close', function () {
    let name = (out || '').replace(/\\s+/g, ' ').trim().replace(/^["'\\s]+|["'\\s]+$/g, '').replace(/[.]+$/, '');
    if (!looksLikeTaskTitle(name)) name = '';
    settle(name); cleanup();
  });
}
app.post('/task-title', (req, res) => handleTaskTitle(req, res));
` + END + '\n';

if (src.indexOf(BEGIN) === -1) {
  const anchor = '\nfunction autoNameRoom(S) {';
  if (src.indexOf(anchor) === -1) { console.error('FAIL: autoNameRoom anchor not found'); process.exit(1); }
  src = src.replace(anchor, '\n' + HELPERS + anchor);
  changes.push('helpers + POST /task-title');
} else { changes.push('helpers: already present (no-op)'); }

/* ── 2. confCanonicalTask: MariaDB fallback when the .md is not written yet ── */
const OLD_CANON = `function confCanonicalTask(decision, task) {
  if (decision === 'none') return { status: 'none', task: null };
  if (decision === 'linked') {
    const file = (task && typeof task.file === 'string') ? task.file : '';
    if (!/^task-[a-z0-9-]+\\.md$/.test(file)) return { status: 'invalid' };
    try {
      const full = path.join(TASKS_DIR, file);
      if (!fs.existsSync(full)) return { status: 'invalid' };
      const t = parseTaskFile(full);
      if (!t) return { status: 'invalid' };
      return { status: 'linked', task: { id: String(t.id || '').slice(0, 16), file: file, title: String(t.title || '').slice(0, 200) } };
    } catch { return { status: 'invalid' }; }
  }
  return { status: 'invalid' };
}`;
const NEW_CANON = `// [CONF_TASK_STORE_V1] The authoritative task store is MariaDB; the .md file is
// written asynchronously by org_bridge_syncd. A task created seconds ago has no
// .md yet, so the file-only check below used to reject it and the client replayed
// the whole task-association popup — the "runs twice" defect. Fall back to the
// task API (same JWT => same user) when the file is not there yet.
async function taskFromApi(file) {
  const jwt = bridgeTaskJwt(); if (!jwt) return null;
  try {
    const r = await fetch(BRIDGE_TASK_API, { headers: { Authorization: 'Bearer ' + jwt }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const d = await r.json();
    const list = (d && Array.isArray(d.tasks)) ? d.tasks : [];
    for (const t of list) {
      if (t && String(t.file) === file) {
        return { id: String(t.id || '').slice(0, 16), file: file, title: String(t.title || '').slice(0, 200) };
      }
    }
  } catch {}
  return null;
}
async function confCanonicalTask(decision, task) {
  if (decision === 'none') return { status: 'none', task: null };
  if (decision === 'linked') {
    const file = (task && typeof task.file === 'string') ? task.file : '';
    if (!/^task-[a-z0-9-]+\\.md$/.test(file)) return { status: 'invalid' };
    try {
      const full = path.join(TASKS_DIR, file);
      if (fs.existsSync(full)) {
        const t = parseTaskFile(full);
        if (t) return { status: 'linked', task: { id: String(t.id || '').slice(0, 16), file: file, title: String(t.title || '').slice(0, 200) } };
      }
    } catch {}
    const api = await taskFromApi(file);   // [CONF_TASK_STORE_V1]
    if (api) return { status: 'linked', task: api };
    return { status: 'invalid' };
  }
  return { status: 'invalid' };
}`;
if (src.indexOf(NEW_CANON) !== -1) { changes.push('confCanonicalTask: already async (no-op)'); }
else if (src.indexOf(OLD_CANON) !== -1) { src = src.replace(OLD_CANON, NEW_CANON); changes.push('confCanonicalTask -> async + API fallback'); }
else { console.error('FAIL: confCanonicalTask body did not match'); process.exit(1); }

/* ── 3. confTryStart becomes async ──────────────────────────────────────── */
if (src.indexOf('async function confTryStart(S, brief, msg) {') !== -1) {
  changes.push('confTryStart: already async (no-op)');
} else if (src.indexOf('function confTryStart(S, brief, msg) {') !== -1) {
  src = src.replace('function confTryStart(S, brief, msg) {', 'async function confTryStart(S, brief, msg) {');
  changes.push('confTryStart -> async');
} else { console.error('FAIL: confTryStart signature not found'); process.exit(1); }

const OLD_DEC = '  const dec = confCanonicalTask(msg && msg.taskDecision, msg && msg.task);';
const NEW_DEC = '  const dec = await confCanonicalTask(msg && msg.taskDecision, msg && msg.task);';
if (src.indexOf(NEW_DEC) !== -1) { changes.push('await confCanonicalTask: already present (no-op)'); }
else if (src.indexOf(OLD_DEC) !== -1) { src = src.replace(OLD_DEC, NEW_DEC); changes.push('confCanonicalTask call -> await'); }
else { console.error('FAIL: confCanonicalTask call site not found'); process.exit(1); }

/* ── 4. call sites must not float an unhandled rejection ─────────────────── */
const SITES = [
  ["        confTryStart(S, prompt, msg);   // [CONF_TASK_ASSOC_V1] idempotency + task-association gate",
   "        confTryStart(S, prompt, msg).catch(e => console.error('[CONF_TASK_ASSOC_V1] start failed', e && e.message));   // idempotency + task-association gate"],
  ["      confTryStart(S, brief, msg);   // [CONF_TASK_ASSOC_V1]",
   "      confTryStart(S, brief, msg).catch(e => console.error('[CONF_TASK_ASSOC_V1] start failed', e && e.message));"],
];
for (const [oldS, newS] of SITES) {
  if (src.indexOf(newS) !== -1) { changes.push('call site: already guarded (no-op)'); continue; }
  if (src.indexOf(oldS) === -1) { console.error('FAIL: call site not found:\n' + oldS); process.exit(1); }
  src = src.replace(oldS, newS);
  changes.push('call site -> .catch()');
}

/* ── write ──────────────────────────────────────────────────────────────── */
const tmp = FILE + '.tt-new.js';
fs.writeFileSync(tmp, src);
try { check(tmp); } catch (e) { fs.unlinkSync(tmp); console.error('FAIL: node --check on patched output\n' + (e.stderr || e).toString()); process.exit(1); }
if (src === fs.readFileSync(FILE, 'utf8')) { fs.unlinkSync(tmp); console.log('NO-OP (already patched)'); console.log(changes.map(c => '  - ' + c).join('\n')); process.exit(0); }
const bak = FILE + '.bak-tasktitle-' + Date.now();
fs.copyFileSync(FILE, bak);
fs.renameSync(tmp, FILE);
try { fs.chmodSync(FILE, 0o644); } catch {}
console.log('PATCHED ' + FILE);
console.log('backup ' + bak);
console.log(changes.map(c => '  - ' + c).join('\n'));
