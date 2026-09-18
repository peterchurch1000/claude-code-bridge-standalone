/* TASK_TITLE_HAIKU_V2 — the fallback must be a 5-7 word label, never the raw sentence. */
const fs = require('fs');
const S = fs.readFileSync(process.env.SDIR + '/bridge-server.js', 'utf8');
const C = fs.readFileSync(process.env.SDIR + '/public/app.js', 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  ' + x : '')); } };

const sBlock = S.split('// >>> TASK_TITLE_HAIKU_V1_BEGIN')[1].split('// <<< TASK_TITLE_HAIKU_V1_END')[0]
  .replace(/app\.post\('\/task-title'[\s\S]*$/, '');
const srvHeur = new Function('return (' + sBlock.match(/function heuristicTaskTitle\(text\)[\s\S]*?\n\}/)[0].replace('function heuristicTaskTitle', 'function') + ')')
  .call(null);
// the server heuristic closes over _TT_STOP, so rebuild it standalone
const stopLine = S.match(/const _TT_STOP = new Set\(\('[^']*'\)\.split\(' '\)\);/)[0];
const srv = new Function(stopLine + '\n' + S.match(/function heuristicTaskTitle\(text\)[\s\S]*?\n\}/)[0] + '\nreturn heuristicTaskTitle;')();
const cli = new Function(C.match(/const _TT_STOP = new Set\(\('[^']*'\)\.split\(' '\)\);/)[0] + '\n' +
  C.match(/function _ttFallback\(s\) \{[\s\S]*?\n  \}/)[0] + '\nreturn _ttFallback;')();

const CASES = [
  ['i want to test the way that the task system saves emails', 5, 7],
  ['There are two little errors with the pop-up that associates a conference room with a task when I set up a new conference room.', 5, 7],
  ['Please can you make the dashboard show DIFOT by month for the operations team', 5, 7],
  ['Build a daily Pipedrive prospecting adds email for Adlux that sends at 8am NZ time', 5, 7],
];
console.log('\n[server heuristic]');
for (const [txt, lo, hi] of CASES) {
  const t = srv(txt), w = t.split(' ').filter(Boolean).length;
  ok(`${w}w  "${t}"`, w >= lo && w <= hi);
  ok('   is not the raw sentence', t !== txt && t.length < txt.length);
}
ok('short input degrades honestly (no filler padding)', srv('fix the login bug') === 'Fix Login Bug');
ok('empty -> empty', srv('') === '');
ok('punctuation/urls stripped', !/[\/:]/.test(srv('see https://x.com/y please fix the broken invoice export now')));

console.log('\n[client heuristic mirrors the server]');
for (const [txt] of CASES) ok('same label as server: "' + cli(txt) + '"', cli(txt) === srv(txt));
ok('client empty -> empty', cli('') === '');

console.log('\n[wiring]');
ok('server fallback uses the heuristic', /const fallbackTitle = heuristicTaskTitle\(latestInstruction\) \|\|/.test(S));   // [ROOMTASK_HAIKU_V3]
ok('client no longer slices the raw text to 120', !/_ttFallback\(s\) \{ return String\(s \|\| ''\)\.replace\(\/\\s\+\/g, ' '\)\.trim\(\)\.slice\(0, 120\); \}/.test(C));
ok('the raw-sentence path is gone from the client fallback', C.indexOf("function _ttFallback(s) { return String(s || '')") === -1);

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
