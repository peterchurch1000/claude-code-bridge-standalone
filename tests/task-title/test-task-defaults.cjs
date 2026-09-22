/* TASK_DEFAULTS_PREFILL_V1 — Area/Project prefill in BOTH create-task modals.
 *   D1  the conference create view prefills both pickers from the server defaults
 *   D2  the room create-and-link view prefills identically (same helper, same result)
 *   D3  a value the seed list did not hold is applied after the full /tasks refresh
 *   D4  a field the user already changed is never overwritten by a late default
 *   D5  a remembered value that is no longer an option leaves the field blank
 *   D6  a failing/absent defaults endpoint leaves both fields blank (pre-feature behaviour)
 *   D7  both create POSTs carry rememberDefaults:true alongside the chosen values
 *   D8  a blank remembered value leaves that field blank while the other still prefills
 */
const fs = require('fs');
const SRC = fs.readFileSync(process.env.TD_APP || '/tmp/ttlive/public/app.js', 'utf8');
let pass = 0, fail = 0;
function ok(n, c, x) { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  ' + x : '')); } }
function eq(n, a, b) { ok(n, a === b, '(got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + ')'); }

/* ── units under test, sliced out of the live client ────────────────────── */
function slice(from, to) {
  const i = SRC.indexOf(from), j = SRC.indexOf(to);
  if (i === -1 || j === -1 || j <= i) { console.error('FAIL: cannot slice ' + from); process.exit(1); }
  return SRC.slice(i, j);
}
const pickers = slice('function _confDistinctValues(', 'function _confModalCreateView(');
const confCreate = slice('function _confModalCreateView(seed) {', 'function effectiveEngine(');
const rtCreate = slice('function _rtCreateView(seed) {', '(function wireLinkTaskBtn()');

/* ── a DOM just rich enough for the views under test ────────────────────── */
let created = [];
function el(tag) {
  const e = {
    tagName: tag, _children: [], style: { cssText: '', display: '' }, textContent: '',
    id: '', type: '', placeholder: '', htmlFor: '', disabled: false, isConnected: true,
    _value: '',
    get value() { return this._value; },
    set value(v) {
      // Real <select> semantics: a value with no matching <option> yields ''.
      if (this.tagName !== 'select') { this._value = String(v); return; }
      this._value = this._children.some(o => o.value === String(v)) ? String(v) : '';
    },
    appendChild(c) { this._children.push(c); return c; },
    addEventListener(ev, f) { (this['_on' + ev] = this['_on' + ev] || []).push(f); },
    fire(ev) { (this['_on' + ev] || []).forEach(f => f()); },
    focus() {}, setSelectionRange() {},
    querySelector() { return null; },
  };
  Object.defineProperty(e, 'textContent', {
    get() { return this._text || ''; },
    set(v) { this._text = String(v); if (v === '') this._children = []; },
  });
  created.push(e);
  return e;
}
function panel() {
  const reg = {};
  return {
    innerHTML: '', isConnected: true,
    querySelector(sel) { if (!reg[sel]) { reg[sel] = el('stub'); reg[sel].id = sel.replace('#', ''); } return reg[sel]; },
    _reg: reg,
  };
}
function Option(text, value) { return { text: text, value: value === undefined ? String(text) : String(value) }; }

const H = {};
const names = ['document', 'Option', 'API_BASE', 'fetch', 'lastTasks', 'setTimeout',
  // conference view deps
  '_confPanel', '_ttSeed', 'submitConfStart', 'closeConfTaskModal', '_confModalRootView',
  // room view deps
  '_rtPanelEl', 'currentRoomId', '_rtPaint', '_rtClose', 'showToast', '_rtPost', '_rtSyncChip'];
function build() {
  const vals = [
    { createElement: el }, Option, '',
    (...a) => H.fetch(...a),
    H.seed, (f) => f(),
    () => H.panel,
    (s) => ((s && typeof s === 'object' && typeof s.title === 'string') ? s : null),
    (kind, task) => { H.started.push([kind, task]); },
    () => { H.closeCalls++; }, () => { H.rootViews++; },
    () => H.panel, 'room-1',
    () => { H.paintCalls++; }, () => { H.closeCalls++; }, (m) => { H.toasts.push(m); },
    (file, rid) => { H.linked.push([file, rid]); return Promise.resolve(true); },
    () => { H.syncCalls++; },
  ];
  return new Function(...names,
    pickers + '\n' + confCreate + '\n' + rtCreate + '\nreturn {_confModalCreateView,_rtCreateView};')(...vals);
}
// opts.defaults : what GET /tasks/task-defaults answers (null = endpoint fails)
// opts.seed     : what the Tasks panel already holds (lastTasks), default = full list
// opts.list     : what GET /tasks answers,                        default = full list
// opts.slow     : hold the defaults response until release() is called
const FULL = [{ area: 'Bridge', project: 'Organiser' }, { area: 'Adlux', project: 'Skylights' }];
function reset(opts) {
  opts = opts || {};
  const defaults = opts.defaults;
  created = [];
  H.panel = panel(); H.paintCalls = 0; H.closeCalls = 0; H.syncCalls = 0; H.rootViews = 0;
  H.toasts = []; H.linked = []; H.posts = []; H.started = [];
  H.tasks = opts.list || FULL;
  H.seed = opts.seed || FULL;
  H.taskListCalls = 0;
  let release = null;
  const gate = opts.slow ? new Promise(r => { release = r; }) : Promise.resolve();
  H.releaseDefaults = () => { if (release) release(); };
  H.fetch = (url, opts2) => {
    if (String(url).indexOf('/tasks/task-defaults') !== -1) {
      if (defaults === null) return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      return gate.then(() => ({ ok: true, json: () => Promise.resolve({ defaults: defaults }) }));
    }
    const opts = opts2;
    if (opts && opts.method === 'POST') {
      H.posts.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: '99', file: 'task-99-x.md', title: 'T' }) });
    }
    H.taskListCalls++;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ tasks: H.tasks }) });
  };
  return build();
}
const tick = () => new Promise(r => setImmediate(() => setImmediate(() => setImmediate(() => setImmediate(r)))));
const sel = (id) => created.find(e => e.id === id);
const seed = { title: 'Prefill Area And Project From Last Task', description: 'body' };

(async () => {
console.log('\n[1] D1 — conference create view prefills from the server defaults');
{
  const a = reset({ defaults: { area: 'Bridge', project: 'Organiser' } });
  a._confModalCreateView(seed);
  await tick();
  eq('area prefilled', sel('conf-t-area-sel').value, 'Bridge');
  eq('project prefilled', sel('conf-t-project-sel').value, 'Organiser');
  ok('title still prefilled (unchanged behaviour)', H.panel.querySelector('#conf-t-title').value === seed.title);
}

console.log('\n[2] D2 — the room view behaves identically');
{
  const a = reset({ defaults: { area: 'Bridge', project: 'Organiser' } });
  a._rtCreateView(seed);
  await tick();
  eq('area prefilled', sel('rt-area-sel').value, 'Bridge');
  eq('project prefilled', sel('rt-project-sel').value, 'Organiser');
}

console.log('\n[3] D3 — a value missing from the seed arrives with the full list');
{
  // lastTasks is empty, so the synchronous seed populate has no options at all;
  // only the /tasks refresh can supply "Adlux".
  const a = reset({ defaults: { area: 'Adlux', project: 'Skylights' }, seed: [] });
  a._rtCreateView(seed);
  await tick();
  eq('area applied after refresh', sel('rt-area-sel').value, 'Adlux');
  eq('project applied after refresh', sel('rt-project-sel').value, 'Skylights');
}

console.log('\n[4] D4 — a field the user already changed is never overwritten');
{
  // The defaults response is held back, so the user gets to choose FIRST and the
  // default lands afterwards — exactly the race the touched flag exists for.
  const a = reset({ defaults: { area: 'Bridge', project: 'Organiser' }, slow: true });
  a._rtCreateView(seed);
  await tick();
  const s = sel('rt-area-sel');
  s.value = 'Adlux'; s.fire('change');
  H.releaseDefaults();
  await tick();
  eq('user choice survives', s.value, 'Adlux');
  eq('untouched field still prefilled', sel('rt-project-sel').value, 'Organiser');
}

console.log('\n[5] D5 — a remembered value that no longer exists leaves the field blank');
{
  const a = reset({ defaults: { area: 'Ghost area', project: 'Organiser' } });
  a._rtCreateView(seed);
  await tick();
  eq('unknown area -> blank', sel('rt-area-sel').value, '');
  eq('known project still prefilled', sel('rt-project-sel').value, 'Organiser');
}

console.log('\n[6] D6 — a failing defaults endpoint leaves both fields blank');
{
  const a = reset({ defaults: null });
  a._rtCreateView(seed);
  await tick();
  eq('area blank', sel('rt-area-sel').value, '');
  eq('project blank', sel('rt-project-sel').value, '');
}

console.log('\n[7] D8 — a blank remembered value only blanks its own field');
{
  const a = reset({ defaults: { area: '', project: 'Organiser' } });
  a._rtCreateView(seed);
  await tick();
  eq('area blank', sel('rt-area-sel').value, '');
  eq('project prefilled', sel('rt-project-sel').value, 'Organiser');
}

console.log('\n[8] D7 — both create POSTs carry rememberDefaults + the chosen values');
{
  const a = reset({ defaults: { area: 'Bridge', project: 'Organiser' } });
  a._rtCreateView(seed);
  await tick();
  H.panel.querySelector('#rt-create').onclick();
  await tick();
  eq('room: one POST', H.posts.length, 1);
  eq('room: rememberDefaults', H.posts[0].rememberDefaults, true);
  eq('room: area', H.posts[0].area, 'Bridge');
  eq('room: project', H.posts[0].project, 'Organiser');
  eq('room: linked after create', H.linked.length, 1);

  const b = reset({ defaults: { area: 'Bridge', project: 'Organiser' } });
  b._confModalCreateView(seed);
  await tick();
  H.panel.querySelector('#conf-t-create').onclick();
  await tick();
  eq('conference: one POST', H.posts.length, 1);
  eq('conference: rememberDefaults', H.posts[0].rememberDefaults, true);
  eq('conference: area', H.posts[0].area, 'Bridge');
  eq('conference: project', H.posts[0].project, 'Organiser');
  eq('conference: started linked', (H.started[0] || [])[0], 'linked');
}

console.log('\n' + (fail ? '  FAILED ' + fail + ' / ' + (pass + fail) : '  ALL ' + pass + ' PASSED'));
process.exit(fail ? 1 : 0);
})();
