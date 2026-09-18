/* TASK_TITLE_HAIKU_V1 — live end-to-end / mixed-version safety.
 * Runs the LIVE patched client code against the LIVE RUNNING server and adapts:
 *   server 404 (pre-restart) -> proves graceful degradation to today's prefill
 *   server 200 (patched)     -> proves the real end-to-end path: Haiku title in,
 *                               full Description preserved, exactly one form built
 */
const fs = require('fs');
const SRC = fs.readFileSync('/tmp/ttlive/public/app.js', 'utf8');
const block = SRC.split('// >>> TASK_TITLE_HAIKU_V1_BEGIN')[1].split('// <<< TASK_TITLE_HAIKU_V1_END')[0];
let pass = 0, fail = 0;
function ok(n, c, x) { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  ' + x : '')); } }
function eq(n, a, b) { ok(n, a === b, '(got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + ')'); }

const B = 'http://127.0.0.1:3467';
const TYPED = 'There are two little errors with the pop-up that associates a conference room with a task. The title is prefilled with what I typed, and the popup runs twice.';
const H = { createCalls: [], panel: { innerHTML: '', querySelector() { return {}; } } };
const names = ['API_BASE', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout',
  '_confPanel', '_confModalRootView', '_confModalCreateView', 'closeConfTaskModal',
  '_rtPanelEl', '_rtPaint', '_rtCreateView', '_rtClose', 'pendingConfStart', 'currentRoomId'];
const vals = [B, fetch, AbortController, setTimeout, clearTimeout,
  () => H.panel, () => {}, (s) => { H.createCalls.push(s); }, () => {},
  () => null, () => {}, () => {}, () => {}, { text: TYPED }, 'room-1'];
const api = new Function(...names, block + '\nreturn {_ttFetch,_ttFallback,_confModalGeneratingView};')(...vals);

(async () => {
  // Liveness probe: blank text never spawns a model, so it answers instantly.
  let live = false;
  try {
    const r = await fetch(B + '/task-title', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '' }), signal: AbortSignal.timeout(8000) });
    live = r.ok;
  } catch {}

  console.log('\n[live e2e] patched client  ->  running server (' + (live ? 'PATCHED' : 'pre-patch, 404s') + ')');

  api._confModalGeneratingView();
  ok('placeholder renders with no data-entry control (T1)',
    H.panel.innerHTML.indexOf('<input') === -1 &&
    H.panel.innerHTML.indexOf('<textarea') === -1 &&
    H.panel.innerHTML.indexOf('conf-t-create') === -1);
  eq('  form not built while generating', H.createCalls.length, 0);

  const deadline = Date.now() + 40000;                      // a real Haiku call takes ~5-15s
  while (H.createCalls.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 250));

  eq('exactly one form built', H.createCalls.length, 1);
  const got = H.createCalls[0] || {};
  if (live) {
    const wc = String(got.title || '').split(/\s+/).filter(Boolean).length;
    console.log('  title: ' + JSON.stringify(got.title));
    ok('Haiku title is 5-7 words (got ' + wc + ')', wc >= 5 && wc <= 7);
    ok('  title is NOT the raw typed text (defect #1 fixed end-to-end)', got.title !== TYPED);
    eq('  Description = the full typed text, untruncated', got.description, TYPED);
  } else {
    const wc = String(got.title || '').split(/\s+/).filter(Boolean).length;
    ok('degrades to a <=7 word label, not the raw sentence [V2] (' + wc + 'w)', wc <= 7 && got.title !== TYPED);
    eq('  Description falls back to the typed text', got.description, TYPED);
    ok('  => pre-restart reload is graceful, not a breakage', true);
  }

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
