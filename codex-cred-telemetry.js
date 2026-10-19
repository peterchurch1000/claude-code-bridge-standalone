'use strict';
// ============================================================================
// codex-cred-telemetry.js  —  per-attempt instrumentation for the Codex
// credential-acquisition path in bridge-server.js _runCodexTurn.
//
// DELIVERABLE #2. Behavior-neutral: it only OBSERVES and LOGS. It does not
// change control flow, hold locks, or touch credentials beyond reading them.
//
// Emits one JSON record per phase to a per-PID JSONL file, serialized by a
// single in-process writer queue (per-PID + single writer is what guarantees
// non-interleaved records — NOT PIPE_BUF, which does not make regular-file
// appends atomic). Raw tokens NEVER appear in logs; only non-secret
// sha256 fingerprints and JWT exp. Raw forensic snapshots go to a 0700 dir
// as 0600 files with bounded retention, referenced by path only.
// ============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = process.env.HOME || os.homedir();
const STATE_DIR = path.join(HOME, '.credential-steward');
const LOG_FILE = path.join(STATE_DIR, `codex-attempts.${process.pid}.jsonl`);
const EVID_DIR = path.join(STATE_DIR, 'codex-evidence');   // 0700
const EVID_KEEP = Number(process.env.CODEX_EVID_KEEP || 200); // bounded retention

// ---- application-maintained lane registry (kernel flock can't attribute rooms)
// account -> { holderRoom, holderPid, startedAt, waiters:Set<roomKey> }
const lanes = new Map();
function laneSnapshot(account, roomKey, role) {
  const L = lanes.get(account) || { holderRoom: null, holderPid: null, startedAt: null, waiters: new Set() };
  let activeCodexTurns = 0; for (const v of lanes.values()) if (v.holderRoom) activeCodexTurns++;
  let queuedCodexTurns = 0; for (const v of lanes.values()) queuedCodexTurns += v.waiters.size;
  return {
    account, role,
    laneOccupied: !!L.holderRoom,
    holderRoom: L.holderRoom, holderPid: L.holderPid,
    holderHeldMs: L.startedAt ? (Date.now() - L.startedAt) : null,
    waiterCount: L.waiters.size,
    activeCodexTurns, queuedCodexTurns, laneCount: lanes.size,
  };
}
function laneEnterWaiter(account, roomKey) {
  const L = lanes.get(account) || { holderRoom: null, holderPid: null, startedAt: null, waiters: new Set() };
  L.waiters.add(roomKey); lanes.set(account, L);
}
function laneAcquire(account, roomKey, pid) {
  const L = lanes.get(account) || { holderRoom: null, holderPid: null, startedAt: null, waiters: new Set() };
  L.waiters.delete(roomKey); L.holderRoom = roomKey; L.holderPid = pid; L.startedAt = Date.now();
  lanes.set(account, L);
}
function laneRelease(account, roomKey) {
  const L = lanes.get(account); if (!L) return;
  if (L.holderRoom === roomKey) { L.holderRoom = null; L.holderPid = null; L.startedAt = null; }
  L.waiters.delete(roomKey);
  if (!L.holderRoom && L.waiters.size === 0) lanes.delete(account);
}

// ---- non-secret token introspection ---------------------------------------
function fp(s) { return s ? crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16) : null; }
function jwtExp(tok) {
  try { const p = String(tok).split('.')[1]; const j = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); return Number(j.exp) || null; }
  catch { return null; }
}
// Fingerprint the CANONICAL account snapshot (~/.codex/accounts/<n>.auth.json)
// — returns BOTH access and refresh fingerprints so rotationCommitted can be
// reported independently per token (the refresh token is the reuse-detection
// signal the objective specifically asks for).
function canonicalState(account) {
  try {
    const t = (JSON.parse(fs.readFileSync(path.join(HOME, '.codex', 'accounts', `${account}.auth.json`), 'utf8')).tokens) || {};
    return { accessFp: fp(t.access_token), refreshFp: fp(t.refresh_token) };
  } catch (e) { return { accessFp: null, refreshFp: null }; }
}

// Strip any bearer/JWT/API-key/refresh-token material before it can reach a
// JSONL record or the normal bridge log. Applied to the WHOLE serialized line.
const _REDACT = [
  /sk-ant-[A-Za-z0-9_\-]+/g, /sk-[A-Za-z0-9_\-]{16,}/g, /rt\.[A-Za-z0-9_.\-]+/g,
  /eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, /Bearer\s+[A-Za-z0-9._\-]+/gi,
  /"(?:access_token|refresh_token|id_token)":"[^"]*"/g,
];
function redact(s) { let o = String(s); for (const r of _REDACT) o = o.replace(r, '[REDACTED]'); return o; }
// Deep-redact every string VALUE before serialization (so a token embedded in a
// free-text field is scrubbed while its quotes are still unescaped), then a final
// defensive pass runs on the serialized line.
function redactDeep(v) {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = redactDeep(v[k]); return o; }
  return v;
}

// Classify a sanitized codex error string into an HTTP/OAuth category.
// Never receives raw tokens (callers pass event/stderr text only).
function errorCategory(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return null;
  if (/invalid_grant/.test(s)) return 'invalid_grant';
  if (/\b401\b|unauthorized|unauthenticated/.test(s)) return '401';
  if (/\b429\b|rate.?limit|too many requests/.test(s)) return '429';
  if (/\b5\d\d\b|server error|bad gateway|unavailable/.test(s)) return '5xx';
  if (/timeout|timed out|etimedout/.test(s)) return 'timeout';
  if (/no rollout found|thread\/resume/.test(s)) return 'no_rollout';
  return 'other';
}

// Read a codex auth.json and return ONLY non-secret metadata.
function tokenState(codexHome) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'));
    const t = raw.tokens || {};
    const now = Math.floor(Date.now() / 1000);
    const exp = jwtExp(t.access_token);
    return {
      accessFp: fp(t.access_token), refreshFp: fp(t.refresh_token),
      accessExp: exp, accessTtlSec: exp ? (exp - now) : null,
      lastRefresh: raw.last_refresh || null, accountId: t.account_id || null,
    };
  } catch (e) { return { error: 'unreadable', detail: String(e.message).slice(0, 80) }; }
}

// ---- forensic raw snapshot (restricted; path referenced in log, never bytes)
function evidenceSnapshot(codexHome, tag) {
  try {
    fs.mkdirSync(EVID_DIR, { recursive: true, mode: 0o700 });
    // Enforce 0700 even if the dir pre-existed with looser perms; refuse to
    // write secrets into a world/group-accessible directory.
    try { let st = fs.statSync(EVID_DIR); if (st.mode & 0o077) { fs.chmodSync(EVID_DIR, 0o700); st = fs.statSync(EVID_DIR); } if (st.mode & 0o077) return null; } catch (e) { return null; }
    const src = path.join(codexHome, 'auth.json');
    const dst = path.join(EVID_DIR, `auth.${process.pid}.${Date.now()}.${tag}.json`);
    const tmp = dst + '.tmp';
    fs.copyFileSync(src, tmp); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, dst); // atomic create
    // bounded retention
    const files = fs.readdirSync(EVID_DIR).filter(f => f.startsWith('auth.')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - EVID_KEEP))) { try { fs.unlinkSync(path.join(EVID_DIR, f)); } catch {} }
    return dst;
  } catch (e) { return null; }
}

// ---- classifier (pure; unit-testable without a live codex) -----------------
// Mirrors bridge-server.js: transient iff steward-enabled AND sentinel never
// seen (lock-wait timeout); a nonzero exit AFTER the sentinel is runtime.
function classifyClose({ credentialStewardEnabled, lockAcquired, code, sawFailure }) {
  if (code === 0 && !sawFailure) return 'success';
  if (credentialStewardEnabled && !lockAcquired) return 'transient'; // flock timed out pre-sentinel
  return 'runtime';
}

// ---- single-writer serialized JSONL append ---------------------------------
let _q = Promise.resolve();
function record(rec) {
  // Deep-redact string values first, then defensively redact the whole line.
  const line = redact(JSON.stringify(redactDeep({ ts: new Date().toISOString(), pid: process.pid, ...rec }))) + '\n';
  _q = _q.then(() => new Promise(res => {
    try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
    fs.appendFile(LOG_FILE, line, () => res()); // one <4KB line, single writer => no interleave
  }));
  // Also surface a compact line in the normal bridge log (redacted).
  try { console.log('[CODEX_CRED_ATTEMPT]', line.trim()); } catch {}
  return _q;
}

module.exports = {
  LOG_FILE, EVID_DIR,
  laneSnapshot, laneEnterWaiter, laneAcquire, laneRelease,
  tokenState, canonicalState, errorCategory, redact, fp, jwtExp, evidenceSnapshot, classifyClose, record,
};
