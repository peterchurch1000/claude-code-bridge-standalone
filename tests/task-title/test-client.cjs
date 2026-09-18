/* TASK_TITLE_HAIKU_V1 — client test matrix. Runs against the PATCHED copy.
 * Proves the three normative rules agreed with Codex:
 *   T1  no data-entry or submit control exists while generation is in flight
 *   T2  once the form exists, no generator result writes into it
 *   T3  no generation result may build a view unless its token is still current
 */
const fs = require('fs');
const SRC = fs.readFileSync('/tmp/ttlive/public/app.js', 'utf8');
let pass = 0, fail = 0;
function ok(n, c, x) { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  ' + x : '')); } }
function eq(n, a, b) { ok(n, a === b, '(got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + ')'); }

const block = SRC.split('// >>> TASK_TITLE_HAIKU_V1_BEGIN')[1].split('// <<< TASK_TITLE_HAIKU_V1_END')[0];

/* ── a panel just rich enough for the views under test ──────────────────── */
function makePanel() {
  return {
    innerHTML: '',
    _live: true,
    querySelector(sel) { const self = this; return { set onclick(f) { self['on' + sel.slice(1)] = f; }, get onclick() { return self['on' + sel.slice(1)]; } }; },
  };
}
const H = {};   // harness state
const names = ['API_BASE', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout',
  '_confPanel', '_confModalRootView', '_confModalCreateView', 'closeConfTaskModal',
  '_rtPanelEl', '_rtPaint', '_rtCreateView', '_rtClose', 'pendingConfStart', 'currentRoomId'];
function build() {
  const vals = [
    '', (...a) => H.fetch(...a), AbortController, setTimeout, clearTimeout,
    () => H.confPanel, () => { H.rootViewCalls++; }, (s) => { H.createCalls.push(s); }, () => { H.closeCalls++; },
    () => H.rtPanel, () => { H.rtPaintCalls++; }, (s) => { H.rtCreateCalls.push(s); }, () => { H.rtCloseCalls++; },
    H.pending, H.roomId,
  ];
  return new Function(...names, block + '\nreturn {_ttInvalidate,_ttFetch,_ttFallback,_confModalGeneratingView,_rtGeneratingView,_ttSeed,gen:()=>_ttGen};')(...vals);
}
function reset(opts) {
  opts = opts || {};
  H.confPanel = makePanel(); H.rtPanel = makePanel();
  H.rootViewCalls = 0; H.closeCalls = 0; H.rtPaintCalls = 0; H.rtCloseCalls = 0;
  H.createCalls = []; H.rtCreateCalls = [];
  H.pending = { text: opts.text != null ? opts.text : 'Make the conference popup stop running twice' };
  H.roomId = 'room-1';
  H.fetch = () => new Promise(r => { H.resolve = (body) => r({ ok: true, json: async () => body }); H.reject = (e) => r(Promise.reject(e || new Error('x'))); });
  return build();
}
const tick = () => new Promise(r => setImmediate(() => setImmediate(() => setImmediate(r))));

(async () => {
console.log('\n[1] T1 — the Generating popup has NO data-entry or submit control');
{
  const a = reset(); a._confModalGeneratingView();
  const h = H.confPanel.innerHTML;
  ok('conference: no <input>', h.indexOf('<input') === -1);
  ok('conference: no <textarea>', h.indexOf('<textarea') === -1);
  ok('conference: no create button', h.indexOf('conf-t-create') === -1);
  ok('conference: says it is generating', /Generating title/.test(h));
  ok('conference: Back is present (dismissal exception)', h.indexOf('conf-t-gback') !== -1);
  ok('conference: Cancel is present (dismissal exception)', h.indexOf('conf-t-gcancel') !== -1);
  eq('conference: form NOT built yet', H.createCalls.length, 0);

  const b = reset(); b._rtGeneratingView();
  const r = H.rtPanel.innerHTML;
  ok('room->task: no <input>', r.indexOf('<input') === -1);
  ok('room->task: no <textarea>', r.indexOf('<textarea') === -1);
  ok('room->task: no create button', r.indexOf('rt-create"') === -1);
  eq('room->task: form NOT built yet', H.rtCreateCalls.length, 0);
}

console.log('\n[2] happy path — form appears already populated');
{
  const a = reset(); a._confModalGeneratingView();
  H.resolve({ ok: true, title: 'Fix Conference Task Popup Duplication', source: 'Make the conference popup stop running twice', fallback: 'Make the conference popup...' });
  await tick();
  eq('form built exactly once', H.createCalls.length, 1);
  eq('  Title = the Haiku 5-7 word summary', H.createCalls[0].title, 'Fix Conference Task Popup Duplication');
  eq('  Description = the full source text', H.createCalls[0].description, 'Make the conference popup stop running twice');
  ok('  Title is NOT the raw typed text (defect #1)', H.createCalls[0].title !== H.pending.text);
}
{
  // [ROOMTASK_HAIKU_V3] The room path now asks for a generated description too, and
  // seeds the form from description/fallbackDescription — never from `source`.
  const a = reset(); a._rtGeneratingView();
  H.resolve({ ok: true, hasContent: true, title: 'Summarise This Room Objective Well',
    description: 'Generate a title and a summary for the room task popup.',
    source: 'the latest room comment', fallbackTitle: 'Latest Room Comment Fallback Label',
    fallbackDescription: 'the latest room comment' });
  await tick();
  eq('room->task form built once', H.rtCreateCalls.length, 1);
  eq('  Title seeded', H.rtCreateCalls[0].title, 'Summarise This Room Objective Well');
  eq('  Description = the generated summary [V3]', H.rtCreateCalls[0].description, 'Generate a title and a summary for the room task popup.');
}
{
  const a = reset(); a._rtGeneratingView();   // [ROOMTASK_HAIKU_V3] model produced nothing usable
  H.resolve({ ok: true, hasContent: true, title: '', description: '',
    source: 'the latest room comment', fallbackTitle: 'Latest Room Comment Fallback Label',
    fallbackDescription: 'the latest room comment' });
  await tick();
  eq('  fallback Title is a label [V3]', H.rtCreateCalls[0].title, 'Latest Room Comment Fallback Label');
  eq('  fallback Description is the LATEST comment [V3]', H.rtCreateCalls[0].description, 'the latest room comment');
}
{
  const a = reset(); a._rtGeneratingView();   // [ROOMTASK_HAIKU_V3] room with nothing in it
  H.resolve({ ok: true, hasContent: false, title: '', description: '', source: '', fallbackTitle: '', fallbackDescription: '' });
  await tick();
  eq('  empty room still builds the form [V3]', H.rtCreateCalls.length, 1);
  ok('  and flags itself as empty [V3]', H.rtCreateCalls[0].empty === true);
}

console.log('\n[3] degradation — never blocks forever, never lands empty');
{
  const a = reset(); a._confModalGeneratingView();
  H.resolve({ ok: true, title: '', source: 'Make the conference popup stop running twice', fallback: 'Make the conference popup stop running twice' });
  await tick();
  eq('model rejected -> server fallback used', H.createCalls[0].title, 'Make the conference popup stop running twice');
}
{
  const a = reset(); a._confModalGeneratingView();
  H.fetchFailed = true; H.reject(new Error('network'));
  await tick();
  eq('fetch failed -> form still opens', H.createCalls.length, 1);
  eq('  local fallback is a 5-word label, NOT the raw text [V2]', H.createCalls[0].title, 'Conference Popup Stop Running Twice');
  ok('  and it is never the typed sentence (defect #1 cannot return)', H.createCalls[0].title !== H.pending.text);
  eq('  Description = the typed text', H.createCalls[0].description, 'Make the conference popup stop running twice');
}
{
  const a = reset({ text: '' }); a._confModalGeneratingView();
  H.resolve({ ok: true, title: '', source: '', fallback: '' });
  await tick();
  eq('empty source -> form opens with empty title', H.createCalls[0].title, '');
}

console.log('\n[4] T3 — a superseded result is inert');
{
  const a = reset(); a._confModalGeneratingView();
  a._ttInvalidate();                               // simulates Escape / backdrop / Cancel teardown
  H.resolve({ ok: true, title: 'Too Late To Build This Form', source: 's' });
  await tick();
  eq('token bumped -> form NOT built', H.createCalls.length, 0);
}
{
  const a = reset(); a._confModalGeneratingView();
  H.confPanel = null;                              // modal removed from the DOM
  H.resolve({ ok: true, title: 'Too Late To Build This Form', source: 's' });
  await tick();
  eq('panel gone -> form NOT built', H.createCalls.length, 0);
}
{
  const a = reset(); a._confModalGeneratingView();
  const first = H.resolve;
  a._confModalGeneratingView();                    // user went Back then in again
  const second = H.resolve;
  first({ ok: true, title: 'Stale Result From First Attempt', source: 's1' });
  second({ ok: true, title: 'Fresh Result From Second Attempt', source: 's2' });
  await tick();
  eq('two overlapping generations -> exactly one form', H.createCalls.length, 1);
  eq('  and it is the newest result', H.createCalls[0].title, 'Fresh Result From Second Attempt');
}
{
  const a = reset(); a._rtGeneratingView();
  H.rtPanel = null;
  H.resolve({ ok: true, title: 'Too Late For Room Task Form', source: 's' });
  await tick();
  eq('room->task: panel gone -> form NOT built', H.rtCreateCalls.length, 0);
}

console.log('\n[5] T2 — the form is built seeded, never written into afterwards');
{
  const _cs = SRC.indexOf('function _confModalCreateView(seed)');
  const conf = SRC.slice(_cs, _cs + 3000);
  ok('_confModalCreateView takes a seed', /function _confModalCreateView\(seed\)/.test(conf));
  ok('  title comes from the seed, not pendingConfStart', !/prefill\s*=\s*\(pendingConfStart/.test(conf));
  ok('  no _ttFetch inside the form view', conf.indexOf('_ttFetch') === -1);
  ok('  no deferred write to #conf-t-title', !/conf-t-title[\s\S]{0,400}\.then\(/.test(conf.replace(/titleEl\.value = prefill;/, '')));
  const rt = SRC.slice(SRC.indexOf('function _rtCreateView(seed)'), SRC.indexOf('wireLinkTaskBtn'));
  ok('_rtCreateView takes a seed', /function _rtCreateView\(seed\)/.test(rt));
  ok('  no _ttFetch inside the room->task form view', rt.indexOf('_ttFetch') === -1);
}

console.log('\n[6] wiring + teardown chokepoints');
{
  ok('"Create a new task" opens the Generating view', SRC.indexOf("#conf-t-new').onclick = _confModalGeneratingView") !== -1);
  ok('"+ New task" (room->task) opens the Generating view', SRC.indexOf("#rt-new').onclick = _rtGeneratingView") !== -1);
  ok('no direct create-view entry point remains', SRC.indexOf("onclick = _confModalCreateView;") === -1 && SRC.indexOf("onclick = _rtCreateView;") === -1);
  ok('closeConfTaskModalUI invalidates (Escape/backdrop/Cancel)', /function closeConfTaskModalUI\(\) \{\s*\n\s*_ttInvalidate\(\);/.test(SRC));
  ok('_rtClose invalidates', /function _rtClose\(\) \{ _ttInvalidate\(\);/.test(SRC));
  const a = reset();
  ok('an Event is not mistaken for a seed', a._ttSeed({ target: {}, type: 'click' }) === null);
  ok('a real seed is accepted', a._ttSeed({ title: 't', description: 'd' }) !== null);
  eq('_ttFallback returns <=7 words [V2]', a._ttFallback('y '.repeat(200)).split(' ').filter(Boolean).length, 7);
  ok('_ttFallback never returns the raw sentence [V2]', a._ttFallback('please fix the broken invoice export now') === 'Fix Broken Invoice Export Now');
}

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
})();
