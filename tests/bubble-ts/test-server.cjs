'use strict';
const fs = require('fs');
const src = fs.readFileSync('__WORK__/bridge-server.js', 'utf8');

// Extract the two pure functions under test by brace-matching, so we exercise the
// REAL patched source rather than a copy that could drift.
function extract(name, sig) {
  const i = src.indexOf(sig);
  if (i === -1) throw new Error('not found: ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced: ' + name);
}
const body = [
  'function confStageLabel(st, tt){ return st === "diagnosis" && tt === "feature" ? "Requirements" : String(st||""); }',
  'const ROW_TS_SKEW_MS = 5 * 60 * 1000;',
  extract('confValidRowTs', 'function confValidRowTs(v)'),
  extract('confLogToMessages', 'function confLogToMessages(c)'),
  'module.exports = { confLogToMessages, confValidRowTs };',
].join('\n');
const m = new (require('module'))();
m._compile(body, '/tmp/bts/_srvfns.js');
const { confLogToMessages, confValidRowTs } = m.exports;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };
const eq = (n, g, w) => ok(n, g === w, 'got ' + JSON.stringify(g) + ' want ' + JSON.stringify(w));

const T = Date.UTC(2026, 10, 21, 17, 32, 0);

console.log('\nS2 PRE-DEPLOY conference fixture: every row must stay unstamped');
const legacy = {
  brief: 'the brief', createdAt: 1000, taskType: 'feature',
  log: [
    { turnId: 'ct-1', engine: 'claude', role: 'lead',       stage: 'diagnosis', round: 1, text: 'a', ts: 2000 },
    { turnId: 'in-1', engine: null,     role: 'user',       stage: 'diagnosis', round: 1, text: 'b', ts: 3000 },
    { turnId: 'cc-1', engine: 'claude', role: 'conclusion', stage: 'diagnosis', round: 1, text: 'c', ts: 4000 },
    { turnId: 'av-1', engine: 'claude', role: 'system',     stage: 'diagnosis', round: 1, text: 'd', ts: 5000 },
  ],
};
const outL = confLogToMessages(legacy);
eq('S2 row count', outL.length, 5);
ok('S2 NO row carries ts', outL.every(r => r.ts === undefined), JSON.stringify(outL.map(r => r.ts)));
ok('S2 brief unstamped (createdAt is NOT a display time)', outL[0].ts === undefined);
ok('S2 rev still derived from e.ts (revision metadata intact)', outL[1].rev === 2000 && outL[0].rev === 1000,
   JSON.stringify(outL.map(r => r.rev)));

console.log('\nS1 POST-DEPLOY rows project ts from the dedicated creation fields only');
const fresh = {
  brief: 'the brief', createdAt: 1000, briefCreatedAt: T, taskType: 'feature',
  log: [
    { turnId: 'ct-9', engine: 'claude', role: 'lead', stage: 'diagnosis', round: 1, text: 'a', ts: 999999, rowCreatedAt: T },
    { turnId: 'in-9', engine: null, role: 'user', stage: 'diagnosis', round: 1, text: 'b', ts: 999999, rowCreatedAt: T + 60000 },
  ],
};
const outF = confLogToMessages(fresh);
eq('S1 brief ts == briefCreatedAt', outF[0].ts, T);
eq('S1 engine turn ts == rowCreatedAt (turn START, not e.ts)', outF[1].ts, T);
eq('S1 interjection ts == rowCreatedAt', outF[2].ts, T + 60000);
eq('S1 rev still e.ts, NOT the display time', outF[1].rev, 999999);

console.log('\nS1b mixed conference (live across the deploy)');
const mixed = { brief: 'b', createdAt: 1000, taskType: 'feature', log: [
  { turnId: 'old', engine: 'claude', role: 'lead', stage: 'diagnosis', round: 1, text: 'a', ts: 2000 },
  { turnId: 'new', engine: 'codex',  role: 'reviewer', stage: 'diagnosis', round: 1, text: 'b', ts: 3000, rowCreatedAt: T },
]};
const outM = confLogToMessages(mixed);
ok('S1b old row bare, new row stamped', outM[1].ts === undefined && outM[2].ts === T,
   JSON.stringify([outM[1].ts, outM[2].ts]));

console.log('\nS3 confValidRowTs ratification');
const now = Date.now();
eq('S3 in-window value preserved', confValidRowTs(now - 1000), now - 1000);
ok('S3 far-future replaced', confValidRowTs(now + 99 * 60000) !== now + 99 * 60000);
ok('S3 far-past replaced', confValidRowTs(1) !== 1);
ok('S3 non-integer replaced', Number.isInteger(confValidRowTs('abc')) && confValidRowTs('abc') > now - 5000);
ok('S3 undefined replaced with server now', Math.abs(confValidRowTs(undefined) - Date.now()) < 5000);

console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' : 'ALL PASS ') + (pass + fail) + ' assertions');
process.exit(fail ? 1 : 0);
