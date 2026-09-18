/* ROOMTASK_HAIKU_V3 — client matrix for the room -> task create form.
 *   F1  the form carries Area + Project, built with the conference picker
 *   F2  Area + Project reach the task-creation payload
 *   F3  a generated title/description are prefilled and remain editable
 *   F4  an empty room shows an explicit note instead of two silent blank boxes
 */
const fs = require('fs');
const SRC = fs.readFileSync('/tmp/ttlive/public/app.js', 'utf8');
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
const rtCreate = slice('function _rtCreateView(seed) {', '(function wireLinkTaskBtn()');

/* ── a DOM just rich enough for the view under test ─────────────────────── */
const created = [];
function el(tag) {
  const e = {
    tagName: tag, _children: [], style: { cssText: '', display: '' }, value: '', textContent: '',
    id: '', type: '', placeholder: '', htmlFor: '', disabled: false, isConnected: true,
    appendChild(c) { this._children.push(c); return c; },
    addEventListener(ev, f) { this['on' + ev] = f; },
    focus() {}, setSelectionRange() {},
    querySelector() { return null; },
  };
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
function Option(text, value) { return { text: text, value: value === undefined ? text : value }; }

const H = {};
const names = ['document', 'Option', '_rtPanelEl', '_ttSeed', 'currentRoomId', 'API_BASE', 'fetch',
  '_rtPaint', '_rtClose', 'showToast', '_rtPost', '_rtSyncChip', 'setTimeout', 'lastTasks'];
function build() {
  const vals = [
    { createElement: el }, Option,
    () => H.panel,
    (s) => ((s && typeof s === 'object' && typeof s.title === 'string') ? s : null),
    'room-1', '',
    (...a) => H.fetch(...a),
    () => { H.paintCalls++; }, () => { H.closeCalls++; }, (m) => { H.toasts.push(m); },
    (file, rid) => { H.linked.push([file, rid]); return Promise.resolve(true); },
    () => { H.syncCalls++; }, (f) => f(), H.tasks,
  ];
  return new Function(...names, pickers + '\n' + rtCreate + '\nreturn {_rtCreateView};')(...vals);
}
function reset() {
  created.length = 0;
  H.panel = panel(); H.paintCalls = 0; H.closeCalls = 0; H.syncCalls = 0;
  H.toasts = []; H.linked = []; H.posts = [];
  H.tasks = [{ area: 'Bridge', project: 'Organiser' }, { area: 'Adlux', project: '' }];
  H.fetch = (url, opts) => {
    if (opts && opts.method === 'POST') {
      H.posts.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: '99', file: 'task-99-x.md' }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ tasks: H.tasks }) });
  };
  return build();
}
const tick = () => new Promise(r => setImmediate(() => setImmediate(() => setImmediate(r))));

(async () => {
console.log('\n[1] F1 — the form has Area + Project, like the conference one');
{
  const a = reset();
  a._rtCreateView({ title: 'Generate Room Task Title And Summary', description: 'Fill both fields from the latest comment.' });
  const h = H.panel.innerHTML;
  ok('has a fields row', h.indexOf('id="rt-fields"') !== -1);
  ok('has a note slot', h.indexOf('id="rt-note"') !== -1);
  ok('still has Title', h.indexOf('id="rt-title"') !== -1);
  ok('still has Description', h.indexOf('id="rt-desc"') !== -1);
  ok('still has the create button', h.indexOf('id="rt-create"') !== -1);
  const labels = created.filter(e => e.tagName === 'label').map(e => e.textContent);
  ok('an Area picker was built', labels.indexOf('Area') !== -1, JSON.stringify(labels));
  ok('a Project picker was built', labels.indexOf('Project') !== -1, JSON.stringify(labels));
  const sels = created.filter(e => e.id === 'rt-area-sel' || e.id === 'rt-project-sel');
  eq('  both are <select> fields', sels.length, 2);
  const areaOpts = (sels.find(s => s.id === 'rt-area-sel') || { _children: [] })._children.map(o => o.value);
  ok('  seeded with existing areas', areaOpts.indexOf('Bridge') !== -1 && areaOpts.indexOf('Adlux') !== -1, JSON.stringify(areaOpts));
  ok('  blank default first', areaOpts[0] === '');
  ok('  offers a New... escape hatch', areaOpts.some(v => typeof v === 'string' && v.indexOf('__new__') !== -1));
}

console.log('\n[2] F3 — generated text is prefilled and editable');
{
  const a = reset();
  a._rtCreateView({ title: 'Generate Room Task Title And Summary', description: 'Fill both fields from the latest comment.' });
  eq('title prefilled', H.panel.querySelector('#rt-title').value, 'Generate Room Task Title And Summary');
  eq('description prefilled', H.panel.querySelector('#rt-desc').value, 'Fill both fields from the latest comment.');
  // The note is emitted hidden (display:none in the markup) and is only ever
  // revealed by the empty-room branch, so "untouched" is what hidden means here.
  ok('note markup starts hidden', /id="rt-note"[^>]*display:none/.test(H.panel.innerHTML));
  eq('note left untouched when there is content', H.panel.querySelector('#rt-note').textContent, '');
}

console.log('\n[3] F4 — an empty room explains itself');
{
  const a = reset();
  a._rtCreateView({ title: '', description: '', empty: true });
  const note = H.panel.querySelector('#rt-note');
  ok('note is shown', note.style.display === '');
  ok('note names BOTH fields', /title and description/i.test(note.textContent), JSON.stringify(note.textContent));
  eq('fields stay editable (empty, not disabled)', H.panel.querySelector('#rt-title').disabled, false);
}

console.log('\n[4] F2 — Area + Project reach the payload');
{
  const a = reset();
  a._rtCreateView({ title: 'Generate Room Task Title And Summary', description: 'Fill both fields.' });
  await tick();
  const areaSel = created.find(e => e.id === 'rt-area-sel');
  const projSel = created.find(e => e.id === 'rt-project-sel');
  areaSel.value = 'Bridge'; projSel.value = 'Organiser';
  H.panel.querySelector('#rt-create').onclick();
  await tick();
  eq('one create POST', H.posts.length, 1);
  const body = H.posts[0] || {};
  eq('  title', body.title, 'Generate Room Task Title And Summary');
  eq('  description', body.description, 'Fill both fields.');
  eq('  area', body.area, 'Bridge');
  eq('  project', body.project, 'Organiser');
  eq('room linked after creation', H.linked.length, 1);
  eq('  linked to the created task', (H.linked[0] || [])[0], 'task-99-x.md');
}

console.log('\n[5] a blank Area/Project is sent as empty, never as a sentinel');
{
  const a = reset();
  a._rtCreateView({ title: 'Generate Room Task Title And Summary', description: 'x' });
  await tick();
  H.panel.querySelector('#rt-create').onclick();
  await tick();
  const body = H.posts[0] || {};
  eq('area empty', body.area, '');
  eq('project empty', body.project, '');
}

console.log('\n' + (fail ? '  FAILED ' + fail + ' / ' + (pass + fail) : '  ALL ' + pass + ' PASSED'));
process.exit(fail ? 1 : 0);
})();
