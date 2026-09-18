#!/usr/bin/env node
/* TASK_TITLE_HAIKU_V1 — client patcher (idempotent).
 * Two-phase popup: a "Generating title…" placeholder with NO data-entry or submit
 * control stays up until Haiku returns, then it is REPLACED by the create form,
 * already populated. No field is ever written after the form exists (no race).
 */
const fs = require('fs');
const { execFileSync } = require('child_process');

const FILE = '/var/www/html/claude-code-bridge-standalone/public/app.js';
const BEGIN = '// >>> TASK_TITLE_HAIKU_V1_BEGIN';
const END = '// <<< TASK_TITLE_HAIKU_V1_END';

function check(f) { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }

let src = fs.readFileSync(FILE, 'utf8');
check(FILE);
const changes = [];

const BTN = 'cursor:pointer;padding:6px 12px;border-radius:6px;border:1px solid #4b5563;background:#374151;color:#e5e7eb';
const BACK = 'cursor:pointer;padding:4px 8px;border-radius:6px;border:1px solid #4b5563;background:#374151;color:#e5e7eb';

/* ── 1. shared generation machinery + both "Generating…" views ───────────── */
const BLOCK = '  ' + BEGIN + `
  // A monotonic token. Every teardown or navigation bumps it, so a generation
  // result that arrives late can tell it has been superseded and stays inert.
  let _ttGen = 0;
  function _ttInvalidate() { _ttGen++; }
  function _ttFallback(s) { return String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 120); }
  function _ttFetch(body) {
    const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    let timer = null;
    if (ctl) timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, 15000);
    const done = function (v) { if (timer) { clearTimeout(timer); timer = null; } return v; };
    return fetch(API_BASE + '/task-title', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined
    })
      .then(function (r) { if (!r.ok) throw new Error('http'); return r.json(); })
      .then(function (d) { return done(d || {}); })
      .catch(function () { return done({}); });
  }
  function _ttGenBody(label) {
    return '<div style="display:flex;align-items:center;gap:10px;padding:18px 4px 22px">' +
      '<div style="font-size:20px">\\u2728</div>' +
      '<div><div style="font-size:14px;font-weight:600">Generating title\\u2026</div>' +
      '<div style="font-size:12px;opacity:.65;margin-top:2px">' + label + '</div></div></div>';
  }
  // Phase 1 for the conference task-association popup. Deliberately renders NO
  // input, textarea or create button — the form only exists once the data is in.
  function _confModalGeneratingView() {
    _ttInvalidate();
    const myGen = _ttGen;
    const p = _confPanel(); if (!p) return;
    const srcText = (pendingConfStart && pendingConfStart.text) ? String(pendingConfStart.text) : '';
    p.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><button id="conf-t-gback" style="${BACK}">\\u2190</button><div style="font-size:15px;font-weight:600">Create a new task</div></div>' +
      _ttGenBody('Summarising your objective in a few words.') +
      '<div style="text-align:right"><button id="conf-t-gcancel" style="${BTN}">Cancel</button></div>';
    p.querySelector('#conf-t-gback').onclick = function () { _ttInvalidate(); _confModalRootView(); };
    p.querySelector('#conf-t-gcancel').onclick = function () { closeConfTaskModal(true); };
    _ttFetch({ text: srcText }).then(function (d) {
      if (myGen !== _ttGen) return;        // superseded by a teardown / navigation
      if (!_confPanel()) return;           // modal is gone
      _confModalCreateView({
        title: (d.title || d.fallback || _ttFallback(srcText)),
        description: (d.source || srcText)
      });
    });
  }
  // Phase 1 for the room -> task "Create task & link" form. The source text is the
  // room's full first user instruction, which only the server can read.
  function _rtGeneratingView() {
    _ttInvalidate();
    const myGen = _ttGen;
    const p = _rtPanelEl(); if (!p) return;
    p.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><button id="rt-gback" style="${BACK}">\\u2190</button><div style="font-size:15px;font-weight:600">Create task &amp; link this room</div></div>' +
      _ttGenBody('Summarising this room\\u2019s objective in a few words.') +
      '<div style="text-align:right"><button id="rt-gcancel" style="${BTN}">Cancel</button></div>';
    p.querySelector('#rt-gback').onclick = function () { _ttInvalidate(); _rtPaint(''); };
    p.querySelector('#rt-gcancel').onclick = _rtClose;
    _ttFetch({ roomId: String(currentRoomId || '') }).then(function (d) {
      if (myGen !== _ttGen) return;
      if (!_rtPanelEl()) return;
      _rtCreateView({ title: (d.title || d.fallback || ''), description: (d.source || '') });
    });
  }
  // An Event (a raw onclick handler arg) is not a seed.
  function _ttSeed(s) { return (s && typeof s === 'object' && typeof s.title === 'string') ? s : null; }
  ` + END + '\n';

const ANCHOR = "  function _confPanel() { return document.getElementById('conf-task-panel'); }";
if (src.indexOf(BEGIN) === -1) {
  if (src.indexOf(ANCHOR) === -1) { console.error('FAIL: _confPanel anchor not found'); process.exit(1); }
  src = src.replace(ANCHOR, BLOCK + ANCHOR);
  changes.push('generation machinery + both Generating views');
} else { changes.push('machinery: already present (no-op)'); }

/* ── 2. teardown invalidates in-flight generations (single chokepoint) ───── */
const OLD_CLOSEUI = `  function closeConfTaskModalUI() {
    const m = document.getElementById('conf-task-modal'); if (m) m.remove();
    document.removeEventListener('keydown', _confModalEsc, true);
  }`;
const NEW_CLOSEUI = `  function closeConfTaskModalUI() {
    _ttInvalidate();   // TASK_TITLE_HAIKU_V1: covers Escape, backdrop and Cancel
    const m = document.getElementById('conf-task-modal'); if (m) m.remove();
    document.removeEventListener('keydown', _confModalEsc, true);
  }`;
if (src.indexOf(NEW_CLOSEUI) !== -1) { changes.push('closeConfTaskModalUI: already guarded (no-op)'); }
else if (src.indexOf(OLD_CLOSEUI) !== -1) { src = src.replace(OLD_CLOSEUI, NEW_CLOSEUI); changes.push('closeConfTaskModalUI -> _ttInvalidate'); }
else { console.error('FAIL: closeConfTaskModalUI body did not match'); process.exit(1); }

const OLD_RTCLOSE = "  function _rtClose() { const m = document.getElementById('roomtask-modal'); if (m) m.remove(); document.removeEventListener('keydown', _rtEsc, true); }";
const NEW_RTCLOSE = "  function _rtClose() { _ttInvalidate(); const m = document.getElementById('roomtask-modal'); if (m) m.remove(); document.removeEventListener('keydown', _rtEsc, true); }";
if (src.indexOf(NEW_RTCLOSE) !== -1) { changes.push('_rtClose: already guarded (no-op)'); }
else if (src.indexOf(OLD_RTCLOSE) !== -1) { src = src.replace(OLD_RTCLOSE, NEW_RTCLOSE); changes.push('_rtClose -> _ttInvalidate'); }
else { console.error('FAIL: _rtClose did not match'); process.exit(1); }

/* ── 3. "Create a new task" now opens phase 1, not the form ─────────────── */
const SWAPS = [
  ["    p.querySelector('#conf-t-new').onclick = _confModalCreateView;",
   "    p.querySelector('#conf-t-new').onclick = _confModalGeneratingView;   // TASK_TITLE_HAIKU_V1"],
  ["    p.querySelector('#rt-new').onclick = _rtCreateView;",
   "    p.querySelector('#rt-new').onclick = _rtGeneratingView;   // TASK_TITLE_HAIKU_V1"],
];
for (const [o, n] of SWAPS) {
  if (src.indexOf(n) !== -1) { changes.push('entry point: already swapped (no-op)'); continue; }
  if (src.indexOf(o) === -1) { console.error('FAIL: entry point not found:\n' + o); process.exit(1); }
  src = src.replace(o, n);
  changes.push('entry point -> Generating view');
}

/* ── 4. the create forms are seeded, never typed into after the fact ─────── */
const OLD_CONF_SIG = `  function _confModalCreateView() {
    const p = _confPanel(); if (!p) return;
    const prefill = (pendingConfStart && pendingConfStart.text ? pendingConfStart.text : '').replace(/\\s+/g, ' ').trim().slice(0, 120);`;
const NEW_CONF_SIG = `  function _confModalCreateView(seed) {
    const p = _confPanel(); if (!p) return;
    // TASK_TITLE_HAIKU_V1: the Haiku 5-7 word title, not the raw typed text.
    seed = _ttSeed(seed);
    const prefill = String((seed && seed.title) || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    const prefillDesc = String((seed && seed.description) || '');`;
if (src.indexOf(NEW_CONF_SIG) !== -1) { changes.push('_confModalCreateView: already seeded (no-op)'); }
else if (src.indexOf(OLD_CONF_SIG) !== -1) { src = src.replace(OLD_CONF_SIG, NEW_CONF_SIG); changes.push('_confModalCreateView -> seeded'); }
else { console.error('FAIL: _confModalCreateView head did not match'); process.exit(1); }

const OLD_CONF_SET = `    const titleEl = p.querySelector('#conf-t-title'); titleEl.value = prefill;
    const descEl = p.querySelector('#conf-t-desc');`;
const NEW_CONF_SET = `    const titleEl = p.querySelector('#conf-t-title'); titleEl.value = prefill;
    const descEl = p.querySelector('#conf-t-desc'); descEl.value = prefillDesc;   // TASK_TITLE_HAIKU_V1`;
if (src.indexOf(NEW_CONF_SET) !== -1) { changes.push('conf desc: already seeded (no-op)'); }
else if (src.indexOf(OLD_CONF_SET) !== -1) { src = src.replace(OLD_CONF_SET, NEW_CONF_SET); changes.push('conf Description <- full source text'); }
else { console.error('FAIL: conf title/desc assignment did not match'); process.exit(1); }

const OLD_RT_SIG = `  function _rtCreateView() {
    const p = _rtPanelEl(); if (!p) return;`;
const NEW_RT_SIG = `  function _rtCreateView(seed) {
    const p = _rtPanelEl(); if (!p) return;
    seed = _ttSeed(seed);   // TASK_TITLE_HAIKU_V1`;
if (src.indexOf(NEW_RT_SIG) !== -1) { changes.push('_rtCreateView: already seeded (no-op)'); }
else if (src.indexOf(OLD_RT_SIG) !== -1) { src = src.replace(OLD_RT_SIG, NEW_RT_SIG); changes.push('_rtCreateView -> seeded'); }
else { console.error('FAIL: _rtCreateView head did not match'); process.exit(1); }

const OLD_RT_SET = "    const titleEl = p.querySelector('#rt-title'), descEl = p.querySelector('#rt-desc'), cb = p.querySelector('#rt-create'), errEl = p.querySelector('#rt-err');";
const NEW_RT_SET = OLD_RT_SET + `
    titleEl.value = String((seed && seed.title) || '').replace(/\\s+/g, ' ').trim().slice(0, 120);   // TASK_TITLE_HAIKU_V1
    descEl.value = String((seed && seed.description) || '');`;
if (src.indexOf(NEW_RT_SET) !== -1) { changes.push('rt fields: already seeded (no-op)'); }
else if (src.indexOf(OLD_RT_SET) !== -1) { src = src.replace(OLD_RT_SET, NEW_RT_SET); changes.push('rt Title/Description <- seed'); }
else { console.error('FAIL: rt field lookup line did not match'); process.exit(1); }

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
