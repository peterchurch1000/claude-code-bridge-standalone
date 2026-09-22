/* [TASKROOM_TITLE_V1] — client matrix for "room named after the task it links to".
 *   T1 "<id> - <title>", confirmed title reused verbatim, 60-char ellipsis cap
 *   T2 unnamed room + NEW task  -> renamed silently
 *   T3 named room   + NEW task  -> asks; Yes renames, No leaves it
 *   T4 EXISTING task on an unnamed room -> still asks
 *   T5 draft target -> staged in localStorage, no POST
 *   T6 rename POST rejects -> no throw, caller unaffected
 *   T7 conference ordering: title staged BEFORE submitConfStart, and the start
 *      still fires when the rename is declined or fails
 *   T8 targeting: renames the PASSED room, not the currently-open one
 *   T9 session_named guard: conflicting auto-name ignored in-window only
 */
const fs = require('fs');
const SRC = fs.readFileSync(process.env.TR_TARGET || '/tmp/trtitle/app.js', 'utf8');
let pass = 0, fail = 0;
function ok(n, c, x) { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  ' + x : '')); } }
function eq(n, a, b) { ok(n, a === b, '(got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + ')'); }

function slice(from, to) {
  const i = SRC.indexOf(from), j = SRC.indexOf(to, i + 1);
  if (i === -1 || j === -1 || j <= i) { console.error('FAIL: cannot slice ' + from); process.exit(1); }
  return SRC.slice(i, j);
}
const helper   = slice('  const TR_MAX = 60;', '  function _confModalCreateView(seed) {');
// stop before _noteTaskDefaults / _applyTaskDefaults / the helper block, so the
// conference-view test really exercises the stubs it is asserting on.
const pickers  = slice('function _confDistinctValues(', '  function _noteTaskDefaults(');
const confView = slice('  function _confModalCreateView(seed) {', '  function effectiveEngine(rid)');

/* ── stub DOM / storage ───────────────────────────────────────────────────── */
function el(tag) {
  return { tagName: tag, _children: [], style: { cssText: '', display: '' }, value: '', textContent: '',
    id: '', type: '', placeholder: '', htmlFor: '', disabled: false, isConnected: true,
    appendChild(c) { this._children.push(c); return c; }, addEventListener(e, f) { this['on' + e] = f; },
    focus() {}, setSelectionRange() {}, querySelector() { return null; } };
}
function panel() {
  const reg = {};
  return { innerHTML: '', isConnected: true,
    querySelector(sel) { if (!reg[sel]) { reg[sel] = el('stub'); reg[sel].id = sel.replace('#', ''); } return reg[sel]; } };
}
function Option(t, v) { return { text: t, value: v === undefined ? t : v }; }
function mkStore() {
  const m = {};
  return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; }, _m: m };
}

/* ── build the unit under test ────────────────────────────────────────────── */
const H = {};
function buildHelper(o) {
  o = o || {};
  const names = ['localStorage', 'confirmDialog', 'fetch', 'API_BASE', 'sessionNameById',
                 'currentSessionId', 'currentRoomId', 'updateTitlebar', 'loadSessions', 'pendingRoomName'];
  const vals = [H.store, (m, l) => { H.confirms.push([m, l]); return Promise.resolve(H.confirmAnswer); },
                (u, i) => { H.posts.push([u, JSON.parse(i.body)]); return Promise.resolve({ ok: H.nameOk }); },
                '', H.names, o.currentSessionId === undefined ? 'sess-1' : o.currentSessionId,
                o.currentRoomId === undefined ? 'sess-1' : o.currentRoomId,
                () => { H.titlebar++; }, () => { H.loadSessions++; }, ''];
  return new Function(...names,
    helper + '\nreturn { _trTitle, _trApply, _trAcceptNamed, _trExpectName, pending: () => pendingRoomName };')(...vals);
}
function reset(o) {
  H.store = mkStore(); H.names = {}; H.confirms = []; H.posts = [];
  H.confirmAnswer = true; H.nameOk = true; H.titlebar = 0; H.loadSessions = 0;
  return buildHelper(o);
}

(async () => {
console.log('\n[T1] derived title');
{
  const a = reset();
  eq('id + hyphen + title', a._trTitle('438', 'Prefill Conference Task Area And Project'),
     '438 - Prefill Conference Task Area And Project');
  eq('confirmed title reused verbatim', a._trTitle('7', 'Two  spaces\tkept'), '7 - Two  spaces\tkept');
  eq('missing id -> empty', a._trTitle('', 'Something'), '');
  eq('missing title -> empty', a._trTitle('438', '   '), '');
  const long = a._trTitle('438', 'A'.repeat(200));
  eq('capped at 60', long.length, 60);
  eq('  60th char is the ellipsis', long.slice(-1), '…');
  const exact = a._trTitle('438', 'B'.repeat(54));       // "438 - " = 6 + 54 = 60
  eq('exactly 60 is NOT truncated', exact.length, 60);
  ok('  and carries no ellipsis', exact.indexOf('…') === -1);
}

console.log('\n[T2] unnamed room + NEW task -> silent rename');
{
  const a = reset();
  const applied = await a._trApply({ taskId: '438', taskTitle: 'Prefill Conference Task', roomKey: 'sess-1', sessionId: 'sess-1', existingTask: false });
  ok('applied', applied === true);
  eq('no confirm shown', H.confirms.length, 0);
  eq('one name POST', H.posts.length, 1);
  eq('  to the session name endpoint', H.posts[0][0], '/sessions/sess-1/name');
  eq('  with the derived name', H.posts[0][1].name, '438 - Prefill Conference Task');
  eq('local cache updated', H.names['sess-1'], '438 - Prefill Conference Task');
  ok('titlebar + room list refreshed', H.titlebar === 1 && H.loadSessions === 1);
}

console.log('\n[T3] named room + NEW task -> asks');
{
  let a = reset(); H.names['sess-1'] = 'Existing Auto Name';
  H.confirmAnswer = true;
  ok('accepted -> renamed', await a._trApply({ taskId: '9', taskTitle: 'New Thing', roomKey: 'sess-1', sessionId: 'sess-1' }) === true);
  eq('  confirm was shown', H.confirms.length, 1);
  ok('  confirm names both titles', /Existing Auto Name/.test(H.confirms[0][0]) && /9 - New Thing/.test(H.confirms[0][0]), JSON.stringify(H.confirms[0][0]));
  eq('  confirm button reads Rename', H.confirms[0][1], 'Rename');
  eq('  POSTed', H.posts.length, 1);

  a = reset(); H.names['sess-1'] = 'Existing Auto Name'; H.confirmAnswer = false;
  ok('declined -> not renamed', await a._trApply({ taskId: '9', taskTitle: 'New Thing', roomKey: 'sess-1', sessionId: 'sess-1' }) === false);
  eq('  no POST', H.posts.length, 0);
  eq('  name untouched', H.names['sess-1'], 'Existing Auto Name');
}

console.log('\n[T4] EXISTING task always asks, even on an unnamed room');
{
  const a = reset();
  await a._trApply({ taskId: '12', taskTitle: 'Old Task', roomKey: 'sess-1', sessionId: 'sess-1', existingTask: true });
  eq('confirm shown', H.confirms.length, 1);
  eq('  POSTed after accept', H.posts.length, 1);
}

console.log('\n[T5] draft target -> staged locally, no POST');
{
  const a = reset({ currentSessionId: null, currentRoomId: 'draft-c-1' });
  const applied = await a._trApply({ taskId: '438', taskTitle: 'Conf Room Task', roomKey: 'draft-c-1', sessionId: null, existingTask: false });
  ok('applied', applied === true);
  eq('no POST', H.posts.length, 0);
  eq('staged under the room key', H.store.getItem('bridge_pending_name::draft-c-1'), '438 - Conf Room Task');
  eq('pendingRoomName set for the open room', a.pending(), '438 - Conf Room Task');
  const b = reset({ currentSessionId: null, currentRoomId: 'draft-c-1' });
  H.store.setItem('bridge_pending_name::draft-c-1', 'Hand Typed');
  H.confirmAnswer = false;
  ok('a staged draft name is treated as "already has a title"', await b._trApply({ taskId: '5', taskTitle: 'X Y', roomKey: 'draft-c-1', sessionId: null }) === false);
  eq('  confirm shown', H.confirms.length, 1);
  eq('  draft name untouched', H.store.getItem('bridge_pending_name::draft-c-1'), 'Hand Typed');
}

console.log('\n[T6] a failing rename is inert');
{
  const a = reset(); H.nameOk = false;
  let threw = false;
  let r; try { r = await a._trApply({ taskId: '438', taskTitle: 'Nope', roomKey: 'sess-1', sessionId: 'sess-1' }); } catch (e) { threw = true; }
  ok('never throws', !threw);
  eq('reports not-applied', r, false);
  ok('local cache not poisoned', H.names['sess-1'] === undefined);
}

console.log('\n[T8] renames the PASSED room, not the open one');
{
  const a = reset({ currentSessionId: 'other-room', currentRoomId: 'other-room' });
  await a._trApply({ taskId: '438', taskTitle: 'Target Room', roomKey: 'sess-1', sessionId: 'sess-1' });
  eq('POST went to the passed session', H.posts[0][0], '/sessions/sess-1/name');
  eq('the open room was not renamed', H.names['other-room'], undefined);
  eq('titlebar left alone (different room)', H.titlebar, 0);
  eq('room list still refreshed', H.loadSessions, 1);
}

console.log('\n[T9] session_named guard is bounded and name-aware');
{
  const a = reset();
  a._trExpectName('sess-1', '438 - Mine');
  ok('conflicting auto-name ignored in-window', a._trAcceptNamed('sess-1', 'Some Auto Title') === false);
  ok('unrelated room unaffected', a._trAcceptNamed('sess-9', 'Any Name') === true);
  ok('our own event accepted', a._trAcceptNamed('sess-1', '438 - Mine') === true);
  ok('and the entry is cleared', a._trAcceptNamed('sess-1', 'Later Rename') === true);
  a._trExpectName('sess-2', '1 - X');
  const real = Date.now; Date.now = () => real() + 31000;
  ok('a later rename lands once the window expires', a._trAcceptNamed('sess-2', 'From Another Client') === true);
  Date.now = real;
}

console.log('\n[T7] conference ordering');
async function confRun(opts) {
  opts = opts || {};
  const P = panel();
  const order = [], starts = [];
  const names = ['document', 'Option', '_confPanel', '_ttSeed', '_confModalRootView', 'closeConfTaskModal',
    'closeConfTaskModalUI', '_noteTaskDefaults', '_applyTaskDefaults', 'lastTasks', 'API_BASE', 'fetch',
    'currentRoomId', 'currentSessionId', '_trApply', 'submitConfStart', 'setTimeout'];
  const vals = [{ createElement: el }, Option, () => P, s => s, () => {}, () => {},
    () => { order.push('closeModalUI'); }, () => { order.push('noteDefaults'); }, () => {}, [], '',
    (u, i) => { if (i && i.method === 'POST') { order.push('createTask'); return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: '438', file: 'task-438-x.md', title: 'Prefill Conference Task' }) }); }
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ tasks: [] }) }); },
    'draft-c-1', null,
    (o) => { order.push('rename:' + o.taskId + ':' + o.roomKey + ':' + String(o.sessionId) + ':' + !!o.existingTask);
             return opts.renameRejects ? Promise.reject(new Error('boom')) : Promise.resolve(!opts.renameDeclined); },
    (d, t) => { order.push('start'); starts.push([d, t]); }, f => f()];
  const api = new Function(...names, pickers + '\n' + confView + '\nreturn { _confModalCreateView };')(...vals);
  api._confModalCreateView({ title: 'Prefill Conference Task', description: '' });
  P.querySelector('#conf-t-title').value = 'Prefill Conference Task';
  P.querySelector('#conf-t-create').onclick();
  for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r));
  return { order, starts };
}
{
  const r = await confRun();
  eq('happy path order', r.order.join(' > '),
     'createTask > noteDefaults > closeModalUI > rename:438:draft-c-1:null:false > start');
  eq('the conference still starts', r.starts.length, 1);
  eq('  linked', r.starts[0][0], 'linked');
  eq('  with the created task', r.starts[0][1].id, '438');

  const d = await confRun({ renameDeclined: true });
  ok('declined rename still starts the conference', d.order.indexOf('start') !== -1 && d.starts.length === 1, d.order.join(' > '));

  const f = await confRun({ renameRejects: true });
  ok('a THROWING rename must not strand the start', f.order.indexOf('start') !== -1 && f.starts.length === 1, f.order.join(' > '));
}

console.log('\n' + (fail ? '  FAILED ' + fail + ' / ' + (pass + fail) : '  ALL ' + pass + ' PASSED'));
process.exit(fail ? 1 : 0);
})();
