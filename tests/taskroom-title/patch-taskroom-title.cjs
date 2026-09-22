#!/usr/bin/env node
/* [TASKROOM_TITLE_V1] — name a room after the task it was just linked to.
 *
 *   room title := "<task id> - <task title>"   (<=60 chars, ellipsis at 60)
 *
 * Applies at all FOUR task-association entry points (conference: create + find;
 * normal room: create + link an existing task). A room that already carries a
 * name — including one the server auto-namer produced — is never renamed without
 * asking, and linking an EXISTING task always asks. A declined or failed rename
 * can never abort task creation, room linking, or the conference start.
 *
 * Client-only: POST /sessions/:id/name already clamps at 80 chars and
 * autoNameRoom() skips a session that already has a name, so bridge-server.js
 * needs no change. No bridge restart — reload the page.
 */
const fs = require('fs');
const { execFileSync } = require('child_process');
const check = f => execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });

const C_FILE = process.env.TR_TARGET || '/var/www/html/claude-code-bridge-standalone/public/app.js';
const changes = [];
let c = fs.readFileSync(C_FILE, 'utf8');
check(C_FILE);

function sub(label, from, to, alreadyProbe) {
  if (alreadyProbe && c.indexOf(alreadyProbe) !== -1) { changes.push(label + ': already patched (no-op)'); return; }
  const i = c.indexOf(from);
  if (i === -1) { console.error('FAIL: anchor missing for ' + label + '\n  ' + from.slice(0, 120)); process.exit(1); }
  if (c.indexOf(from, i + 1) !== -1) { console.error('FAIL: anchor not unique for ' + label); process.exit(1); }
  c = c.slice(0, i) + to + c.slice(i + from.length);
  changes.push(label);
}

/* ── 1. the helper block ──────────────────────────────────────────────────── */
const HELPER = `  // ── [TASKROOM_TITLE_V1] Room title derived from the task just associated ────
  // "<task id> - <task title>". The confirmed title is reused EXACTLY: the create
  // forms already collapse whitespace before POST /tasks and an existing task's
  // title comes from the server, so only the join and the length cap happen here.
  const TR_MAX = 60;
  function _trTitle(taskId, taskTitle) {
    const id = String(taskId == null ? '' : taskId).trim();
    const t = String(taskTitle == null ? '' : taskTitle).trim();
    if (!id || !t) return '';
    const s = id + ' - ' + t;
    return s.length <= TR_MAX ? s : (s.slice(0, TR_MAX - 1) + '\\u2026');
  }
  // Bounded, name-aware guard against the server auto-namer (bridge-server.js
  // autoNameRoom) repainting over a name we just wrote. Only a CONFLICTING
  // session_named for that id inside the window is ignored, so a legitimate
  // rename from another client still lands.
  const _trExpect = new Map();   // sessionId -> { name, until }
  const TR_EXPECT_MS = 30000;
  function _trExpectName(sessionId, name) {
    if (sessionId && name) _trExpect.set(String(sessionId), { name: name, until: Date.now() + TR_EXPECT_MS });
  }
  function _trAcceptNamed(id, name) {
    const e = _trExpect.get(String(id));
    if (!e) return true;
    if (Date.now() > e.until) { _trExpect.delete(String(id)); return true; }
    if (name === e.name) { _trExpect.delete(String(id)); return true; }
    return false;
  }
  function _trDraftName(roomKey) {
    try { return localStorage.getItem('bridge_pending_name::' + roomKey) || ''; } catch (e) { return ''; }
  }
  // Apply the derived title to an EXPLICIT target — never infers the room from
  // currentRoomId/currentSessionId, so a room switch mid-flow cannot rename the
  // wrong room. Returns true only when applied; never throws.
  async function _trApply(o) {
    try {
      o = o || {};
      const name = _trTitle(o.taskId, o.taskTitle);
      if (!name) return false;
      const sid = o.sessionId ? String(o.sessionId) : '';
      const roomKey = String(o.roomKey || '');
      const cur = sid ? (sessionNameById[sid] || '') : _trDraftName(roomKey);
      if (cur || o.existingTask) {
        const q = cur
          ? ('Rename this room from \\u201C' + cur + '\\u201D to \\u201C' + name + '\\u201D?')
          : ('Name this room \\u201C' + name + '\\u201D?');
        if (!await confirmDialog(q, 'Rename')) return false;
      }
      if (sid) {
        const r = await fetch(API_BASE + '/sessions/' + encodeURIComponent(sid) + '/name', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) });
        if (!r || !r.ok) return false;
        sessionNameById[sid] = name;
        _trExpectName(sid, name);
        if (currentSessionId === sid) updateTitlebar();
        if (typeof loadSessions === 'function') loadSessions();
      } else {
        if (!roomKey) return false;
        try { localStorage.setItem('bridge_pending_name::' + roomKey, name); } catch (e) {}
        if (roomKey === currentRoomId) { pendingRoomName = name; updateTitlebar(); }
      }
      return true;
    } catch (e) { return false; }
  }
  function _confModalCreateView(seed) {`;
sub('helper block', '  function _confModalCreateView(seed) {', HELPER, '[TASKROOM_TITLE_V1]');

/* ── 2. confirmDialog gains a caller-supplied confirm label ───────────────── */
sub('confirmDialog(message, okLabel)',
  `  function confirmDialog(message) {`,
  `  function confirmDialog(message, okLabel) {`,
  `function confirmDialog(message, okLabel)`);
sub('confirmDialog ok label',
  `      const ok = document.createElement('button'); ok.className = 'tc-ok'; ok.textContent = 'Delete';`,
  `      const ok = document.createElement('button'); ok.className = 'tc-ok'; ok.textContent = okLabel || 'Delete';`,
  `ok.textContent = okLabel || 'Delete';`);

/* ── 3. session_named: ignore only a conflicting auto-name in the window ──── */
sub('session_named guard',
  `        /* AUTONAME_ROOM_V1: server derived a title for a still-unnamed room */
        if (msg.id && msg.name) {`,
  `        /* AUTONAME_ROOM_V1: server derived a title for a still-unnamed room */
        if (msg.id && msg.name && _trAcceptNamed(msg.id, msg.name)) {   // [TASKROOM_TITLE_V1]`,
  `_trAcceptNamed(msg.id, msg.name)`);

/* ── 4. draft -> session flush also registers the expectation ─────────────── */
sub('draft-name flush expectation',
  `            const _pn = pendingRoomName;
            sessionNameById[msg.id] = _pn;`,
  `            const _pn = pendingRoomName;
            sessionNameById[msg.id] = _pn;
            _trExpectName(msg.id, _pn);   // [TASKROOM_TITLE_V1]`,
  `_trExpectName(msg.id, _pn);`);

/* ── 5. conference · create a new task ────────────────────────────────────── */
sub('conference create site',
  `        .then(function (res) { if (!res.ok || !res.j || !res.j.file) throw new Error((res.j && res.j.error) || 'error'); _noteTaskDefaults(_area, _project); submitConfStart('linked', { id: String(res.j.id || ''), file: String(res.j.file || ''), title: String(res.j.title || title) }); })`,
  `        .then(function (res) {
          if (!res.ok || !res.j || !res.j.file) throw new Error((res.j && res.j.error) || 'error');
          _noteTaskDefaults(_area, _project);
          const _t = { id: String(res.j.id || ''), file: String(res.j.file || ''), title: String(res.j.title || title) };
          // [TASKROOM_TITLE_V1] Stage the room title BEFORE the start: submitConfStart is
          // what starts the conference AND performs the server-side link. The confirm
          // (z-index 200) must not sit under this modal (9999), so close the UI first —
          // closeConfTaskModalUI keeps pendingConfStart intact. A declined or failed
          // rename must never stop the start.
          closeConfTaskModalUI();
          return _trApply({ taskId: _t.id, taskTitle: _t.title, roomKey: currentRoomId, sessionId: currentSessionId || null, existingTask: false })
            .catch(function () { return false; })
            .then(function () { try { submitConfStart('linked', _t); } catch (e) {} });
        })`,
  `[TASKROOM_TITLE_V1] Stage the room title BEFORE the start`);

/* ── 6. conference · link an existing task ────────────────────────────────── */
sub('conference find site',
  `        row.onclick = function () { submitConfStart('linked', { id: String(t.id || ''), file: String(t.file || ''), title: String(t.title || '') }); };`,
  `        row.onclick = function () {   // [TASKROOM_TITLE_V1] existing task -> always ask
          const _t = { id: String(t.id || ''), file: String(t.file || ''), title: String(t.title || '') };
          closeConfTaskModalUI();
          _trApply({ taskId: _t.id, taskTitle: _t.title, roomKey: currentRoomId, sessionId: currentSessionId || null, existingTask: true })
            .catch(function () { return false; })
            .then(function () { try { submitConfStart('linked', _t); } catch (e) {} });
        };`,
  `[TASKROOM_TITLE_V1] existing task -> always ask`);

/* ── 7. normal room · create a new task ───────────────────────────────────── */
sub('room create site',
  `        .then(res => { if (!res.ok || !res.j || !res.j.file) throw new Error('create'); _noteTaskDefaults(_area, _project); return _rtPost(res.j.file, rid).then(ok => { if (!ok) throw new Error('link'); showToast('Task created and room linked', 'success'); _rtClose(); _rtSyncChip(); }); })`,
  `        .then(res => { if (!res.ok || !res.j || !res.j.file) throw new Error('create'); _noteTaskDefaults(_area, _project); return _rtPost(res.j.file, rid).then(async ok => { if (!ok) throw new Error('link'); showToast('Task created and room linked', 'success'); _rtClose();
          // [TASKROOM_TITLE_V1] after the link, and after the modal is gone so the confirm is not buried under it
          try { await _trApply({ taskId: String(res.j.id || ''), taskTitle: String(res.j.title || title), roomKey: rid, sessionId: rid, existingTask: false }); } catch (e) {}
          _rtSyncChip(); }); })`,
  `try { await _trApply({ taskId: String(res.j.id || '')`);

/* ── 8. normal room · link an existing task ───────────────────────────────── */
sub('room link site',
  `      b.onclick = () => { b.disabled = true; _rtPost(t.file, rid).then(ok => { if (ok) { showToast('Room linked to task-' + (t.id || ''), 'success'); _rtReload(); } else { b.disabled = false; showToast('Could not link (invalid key)', 'error'); } }); };`,
  `      b.onclick = () => { b.disabled = true; _rtPost(t.file, rid).then(async ok => { if (ok) { showToast('Room linked to task-' + (t.id || ''), 'success');
        // [TASKROOM_TITLE_V1] existing task -> always ask; close first (confirm z-index 200 < modal 9999)
        _rtClose();
        try { await _trApply({ taskId: String(t.id || ''), taskTitle: String(t.title || ''), roomKey: rid, sessionId: rid, existingTask: true }); } catch (e) {}
        _rtReload(); } else { b.disabled = false; showToast('Could not link (invalid key)', 'error'); } }); };`,
  `[TASKROOM_TITLE_V1] existing task -> always ask; close first`);

/* ── 9. the room-name box must accept the agreed 60 ───────────────────────── */
sub('rename maxLength 40 -> 60',
  `    inp.value = cur; inp.maxLength = 40;`,
  `    inp.value = cur; inp.maxLength = 60;   // [TASKROOM_TITLE_V1] task-derived names are up to 60`,
  `inp.maxLength = 60;   // [TASKROOM_TITLE_V1]`);

/* ── write ───────────────────────────────────────────────────────────────── */
if (c === fs.readFileSync(C_FILE, 'utf8')) { console.log('NO-OP (already patched)'); console.log(changes.map(x => '  - ' + x).join('\n')); process.exit(0); }
const tmp = C_FILE + '.trtitle-new.js';
fs.writeFileSync(tmp, c);
try { check(tmp); } catch (e) { fs.unlinkSync(tmp); console.error('FAIL: node --check\n' + (e.stderr || e).toString()); process.exit(1); }
fs.copyFileSync(C_FILE, C_FILE + '.bak-taskroomtitle-' + Date.now());
fs.renameSync(tmp, C_FILE);
try { fs.chmodSync(C_FILE, 0o644); } catch {}
console.log('PATCHED ' + C_FILE);
console.log(changes.map(x => '  - ' + x).join('\n'));
