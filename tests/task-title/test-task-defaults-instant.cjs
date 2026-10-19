/* [TASK_DEFAULTS_INSTANT_V1] Area/Project are present at FIRST PAINT of both create-task
 * modals, sourced synchronously from a per-pane localStorage cache — no post-open async.
 *   I1  conference create view: cached pair is selected in the SAME tick (assert BEFORE await)
 *   I2  room create-and-link view: identical, same tick
 *   I3  a cached value absent from the /tasks list survives the later refresh (stays selected)
 *   I4  creating a task writes the chosen pair back to the cache (persists across reload)
 *   I5  the cache key is scoped by API_BASE — another pane's pair is never read
 *   I6  malformed cache storage is rejected safely (both fields blank, no throw)
 *
 * Mirrors test-task-defaults.cjs: the REAL client functions are sliced out of the live
 * app.js and run against a faithful <select> stub. The only additions here are a
 * localStorage stub and synchronous (pre-await) assertions that prove first-paint timing.
 */
const fs = require('fs');
const SRC = fs.readFileSync(process.env.TD_APP || '/tmp/ttlive/public/app.js', 'utf8');
let pass = 0, fail = 0;
function ok(n, c, x) { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  ' + x : '')); } }
function eq(n, a, b) { ok(n, a === b, '(got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + ')'); }

if (SRC.indexOf('TASK_DEFAULTS_INSTANT_V1') === -1) {
  console.error('FAIL: app.js under test is not patched (no TASK_DEFAULTS_INSTANT_V1 marker)');
  process.exit(1);
}

/* ── units under test, sliced out of the live client ────────────────────── */
function slice(from, to) {
  const i = SRC.indexOf(from), j = SRC.indexOf(to);
  if (i === -1 || j === -1 || j <= i) { console.error('FAIL: cannot slice ' + from); process.exit(1); }
  return SRC.slice(i, j);
}
const pickers = slice('function _confDistinctValues(', 'function _confModalCreateView(');
const confCreate = slice('function _confModalCreateView(seed) {', 'function effectiveEngine(');
const rtCreate = slice('function _rtCreateView(seed) {', '(function wireLinkTaskBtn()');

/* ── a DOM just rich enough for the views under test (faithful <select>) ── */
let created = [];
function el(tag) {
  const e = {
    tagName: tag, _children: [], style: { cssText: '', display: '' }, textContent: '',
    id: '', type: '', placeholder: '', htmlFor: '', disabled: false, isConnected: true,
    _value: '',
    get value() { return this._value; },
    set value(v) {
      if (this.tagName !== 'select') { this._value = String(v); return; }
      this._value = this._children.some(o => o.value === String(v)) ? String(v) : '';
    },
    appendChild(c) { this._children.push(c); return c; },
    insertBefore(c, ref) { const i = this._children.indexOf(ref); if (i < 0) this._children.push(c); else this._children.splice(i, 0, c); return c; },
    get options() { return this._children; },
    get lastChild() { return this._children.length ? this._children[this._children.length - 1] : null; },
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
  '_confPanel', '_ttSeed', 'submitConfStart', 'closeConfTaskModal', '_confModalRootView',
  '_rtPanelEl', 'currentRoomId', '_rtPaint', '_rtClose', 'showToast', '_rtPost', '_rtSyncChip',
  'localStorage'];
function build() {
  const vals = [
    { createElement: el }, Option, H.apiBase,
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
    H.localStorage,
  ];
  return new Function(...names,
    pickers + '\n' + confCreate + '\n' + rtCreate + '\nreturn {_confModalCreateView,_rtCreateView};')(...vals);
}
function makeLS(entries) {
  const m = new Map(Object.entries(entries || {}));
  return {
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    _map: m,
  };
}
const FULL = [{ area: 'Bridge', project: 'Organiser' }, { area: 'Adlux', project: 'Skylights' }];
// opts.cache      : {area, project} to pre-seed under THIS pane's key
// opts.rawCache   : raw string to store under this pane's key (malformed-data test)
// opts.cacheKey   : store the cache under this explicit key instead (scoping test)
// opts.apiBase    : API_BASE for this pane (default '')
// opts.seed/list/defaults/slow : as in test-task-defaults.cjs
function reset(opts) {
  opts = opts || {};
  H.apiBase = opts.apiBase || '';
  const KEY = 'bridge.taskDefaults.v1::' + H.apiBase;
  const store = {};
  if (opts.cache) store[opts.cacheKey || KEY] = JSON.stringify(opts.cache);
  if (typeof opts.rawCache === 'string') store[opts.cacheKey || KEY] = opts.rawCache;
  H.localStorage = makeLS(store);
  H._KEY = KEY;

  const defaults = opts.defaults === undefined ? null : opts.defaults;
  created = [];
  H.panel = panel(); H.paintCalls = 0; H.closeCalls = 0; H.syncCalls = 0; H.rootViews = 0;
  H.toasts = []; H.linked = []; H.posts = []; H.started = [];
  H.tasks = opts.list || FULL;
  H.seed = opts.seed || FULL;
  let release = null;
  const gate = opts.slow ? new Promise(r => { release = r; }) : Promise.resolve();
  H.releaseDefaults = () => { if (release) release(); };
  H.fetch = (url, opts2) => {
    if (String(url).indexOf('/tasks/task-defaults') !== -1) {
      if (defaults === null) return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      return gate.then(() => ({ ok: true, json: () => Promise.resolve({ defaults: defaults }) }));
    }
    if (opts2 && opts2.method === 'POST') {
      H.posts.push(JSON.parse(opts2.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: '99', file: 'task-99-x.md', title: 'T' }) });
    }
    return gate.then(() => ({ ok: true, json: () => Promise.resolve({ tasks: H.tasks }) }));
  };
  return build();
}
const tick = () => new Promise(r => setImmediate(() => setImmediate(() => setImmediate(() => setImmediate(r)))));
const sel = (id) => created.find(e => e.id === id);
const seed = { title: 'Prefill Area And Project From Last Task', description: 'body' };

(async () => {
console.log('\n[1] I1 — conference create view: cached pair present at FIRST PAINT (no await, network stalled)');
{
  const a = reset({ cache: { area: 'Adlux', project: 'Skylights' }, seed: [], slow: true });
  a._confModalCreateView(seed);
  // Intentionally assert BEFORE any await/tick — proves the value is there in the same
  // synchronous turn the modal DOM was built, with both fetches still pending.
  eq('area at first paint', sel('conf-t-area-sel').value, 'Adlux');
  eq('project at first paint', sel('conf-t-project-sel').value, 'Skylights');
}

console.log('\n[2] I2 — room create-and-link view: identical, same tick');
{
  const a = reset({ cache: { area: 'Adlux', project: 'Skylights' }, seed: [], slow: true });
  a._rtCreateView(seed);
  eq('area at first paint', sel('rt-area-sel').value, 'Adlux');
  eq('project at first paint', sel('rt-project-sel').value, 'Skylights');
}

console.log('\n[3] I3 — a cached value absent from the /tasks list survives the refresh');
{
  // 'Zeta' is nowhere in FULL; the synchronous cache apply must insert+select it, and the
  // later /tasks repopulate (FULL) must NOT blank it.
  const a = reset({ cache: { area: 'Zeta', project: 'Skylights' }, seed: [], list: FULL });
  a._rtCreateView(seed);
  eq('area at first paint (inserted)', sel('rt-area-sel').value, 'Zeta');
  await tick();
  eq('area survives /tasks refresh', sel('rt-area-sel').value, 'Zeta');
  eq('project still selected', sel('rt-project-sel').value, 'Skylights');
}

console.log('\n[4] I4 — creating a task writes the chosen pair back to the cache');
{
  const a = reset({ cache: null, defaults: { area: 'Bridge', project: 'Organiser' } });
  a._confModalCreateView(seed);
  await tick();
  H.panel.querySelector('#conf-t-create').onclick();
  await tick();
  const written = JSON.parse(H.localStorage.getItem(H._KEY) || '{}');
  eq('cache area written', written.area, 'Bridge');
  eq('cache project written', written.project, 'Organiser');
}

console.log('\n[5] I5 — the cache key is scoped by API_BASE (no cross-pane read)');
{
  // Seed a pair under a DIFFERENT pane's key; this pane (apiBase /u/alice) must not read it.
  const a = reset({
    apiBase: '/u/alice', defaults: null,
    cache: { area: 'Adlux', project: 'Skylights' },
    cacheKey: 'bridge.taskDefaults.v1::/u/bob',
  });
  a._rtCreateView(seed);
  eq('area not read from other pane', sel('rt-area-sel').value, '');
  eq('project not read from other pane', sel('rt-project-sel').value, '');
}

console.log('\n[6] I6 — malformed cache storage is rejected safely');
{
  const a = reset({ rawCache: 'not-json{{', defaults: null, seed: FULL });
  let threw = false;
  try { a._rtCreateView(seed); } catch (e) { threw = true; }
  ok('no throw on malformed cache', !threw);
  eq('area blank', sel('rt-area-sel').value, '');
  eq('project blank', sel('rt-project-sel').value, '');
}

console.log('\n' + (fail ? '  FAILED ' + fail + ' / ' + (pass + fail) : '  ALL ' + pass + ' PASSED'));
process.exit(fail ? 1 : 0);
})();
