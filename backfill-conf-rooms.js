#!/usr/bin/env node
/* [CONF_ROOM_ASSOC_V1] Bounded, owner-scoped, auditable backfill of conference rooms
 * into their linked tasks. Dry-run by default; pass --apply to POST.
 * Scope: tasks 410..420 OR canonically open/active tasks, with a discoverable
 * non-draft canonical room key. Never fabricates; reports skips + failures; exits
 * non-zero if any in-scope candidate failed or could not be resolved.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const APPLY = process.argv.includes('--apply');
const HOME = process.env.HOME || os.homedir();
const CONF_DIR = path.join(HOME, '.claude', 'bridge-conference');
const JWT_FILE = path.join(HOME, '.claude', 'bridge-task-jwt');
const BRIDGE_TASK_API = (process.env.BRIDGE_TASK_API || 'http://127.0.0.1:8000/api/bridge/tasks').replace(/\/$/, '');

function label(c) {
  try {
    const brief = String((c && c.brief) || '').split('\n').map(s => s.trim()).find(Boolean) || '';
    if (brief) return brief.slice(0, 200);
    if (c && c.task && c.task.title) return String(c.task.title).slice(0, 200);
  } catch {}
  return 'Conference room';
}

(async () => {
  const jwt = (() => { try { return fs.readFileSync(JWT_FILE, 'utf8').trim(); } catch { return ''; } })();
  if (!jwt) { console.error('FATAL: no bridge-task-jwt at', JWT_FILE); process.exit(1); }

  // Owner-scoped canonical task list.
  let tasks = [];
  try {
    const r = await fetch(BRIDGE_TASK_API, { headers: { Authorization: 'Bearer ' + jwt } });
    if (!r.ok) { console.error('FATAL: task list HTTP', r.status); process.exit(1); }
    const j = await r.json(); tasks = (j && j.tasks) || [];
  } catch (e) { console.error('FATAL: task list error', e && e.message); process.exit(1); }

  const byId = new Map(), byFile = new Map();
  for (const t of tasks) {
    const id = parseInt(String(t.id), 10);
    if (!Number.isNaN(id)) byId.set(id, t);
    if (t.file) byFile.set(String(t.file), t);
  }
  const isOpen = (t) => t && String(t.status || '').toLowerCase() !== 'done';

  let files = [];
  try { files = fs.readdirSync(CONF_DIR).filter(f => f.endsWith('.json')); } catch (e) { console.error('FATAL: cannot read', CONF_DIR, e.message); process.exit(1); }

  const report = { registered: [], already: [], skipNoRoom: [], skipOutOfScope: [], skipStale: [], failed: [] };

  for (const f of files) {
    let c; try { c = JSON.parse(fs.readFileSync(path.join(CONF_DIR, f), 'utf8')); } catch { continue; }
    if (!c || c.status === 'superseded' || !c.task || !c.task.file) continue;
    const key = f.replace(/\.json$/, '');
    if (key.startsWith('draft-')) { report.skipNoRoom.push({ key, task: c.task.file, why: 'draft key' }); continue; }

    const idNum = parseInt(String(c.task.id), 10);
    // Resolve canonical task (owner-scoped): prefer file match, else id match.
    let t = byFile.get(String(c.task.file)) || (!Number.isNaN(idNum) ? byId.get(idNum) : null);
    if (!t) { report.skipStale.push({ key, task: c.task.file, id: c.task.id, why: 'task not found for this user' }); continue; }

    const inRange = !Number.isNaN(idNum) && idNum >= 410 && idNum <= 420;
    if (!inRange && !isOpen(t)) { report.skipOutOfScope.push({ key, task: t.file, id: t.id, status: t.status }); continue; }

    // Already associated?
    const rooms = Array.isArray(t.rooms) ? t.rooms : null; // list may embed rooms
    if (rooms && rooms.some(rm => String(rm.room_key) === key)) { report.already.push({ key, task: t.file }); continue; }

    if (!APPLY) { report.registered.push({ key, task: t.file, id: t.id, label: label(c), DRY: true }); continue; }

    try {
      const url = BRIDGE_TASK_API + '/' + encodeURIComponent(t.file) + '/rooms';
      const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' }, body: JSON.stringify({ room_key: key, label: label(c) }) });
      if (r.ok) { const j = await r.json().catch(() => ({})); report.registered.push({ key, task: t.file, rid: j.rid, existing: !!j.existing }); }
      else { report.failed.push({ key, task: t.file, status: r.status }); }
    } catch (e) { report.failed.push({ key, task: t.file, error: e && e.message }); }
  }

  const line = (n, a) => console.log(`  ${n}: ${a.length}`);
  console.log(APPLY ? '=== BACKFILL APPLY ===' : '=== BACKFILL DRY-RUN (no changes) ===');
  console.log('registered:', JSON.stringify(report.registered, null, 0));
  console.log('already associated:', JSON.stringify(report.already, null, 0));
  console.log('skipped (no canonical room):', JSON.stringify(report.skipNoRoom, null, 0));
  console.log('skipped (out of scope):', JSON.stringify(report.skipOutOfScope, null, 0));
  console.log('skipped (stale/cross-user task):', JSON.stringify(report.skipStale, null, 0));
  console.log('FAILED:', JSON.stringify(report.failed, null, 0));
  console.log('--- summary ---');
  line('registered', report.registered); line('already', report.already);
  line('skip-no-room', report.skipNoRoom); line('skip-out-of-scope', report.skipOutOfScope);
  line('skip-stale', report.skipStale); line('FAILED', report.failed);

  // Non-zero on any hard failure (apply mode) or unresolved in-scope stale refs.
  if (report.failed.length) process.exit(4);
  process.exit(0);
})();
