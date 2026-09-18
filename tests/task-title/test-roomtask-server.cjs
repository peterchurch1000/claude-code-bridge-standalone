/* ROOMTASK_HAIKU_V3 — server matrix. Runs against the PATCHED copy in /tmp/ttlive.
 * Proves the rules agreed with Codex + Peter's correction:
 *   R1  generation is anchored on the MOST RECENT user comment
 *   R2  the two prior user comments are context, in chronological order
 *   R3  assistant / tool output never reaches the prompt, the response or a fallback
 *   R4  a Codex room (chatData only, no .jsonl) resolves like a Claude room
 *   R5  title and description fall back INDEPENDENTLY, never to a blank field
 *   R6  a room with no user turns reports hasContent:false
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const SRC = fs.readFileSync('/tmp/ttlive/bridge-server.js', 'utf8');
let pass = 0, fail = 0;
function ok(n, c, x) { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  ' + x : '')); } }
function eq(n, a, b) { ok(n, a === b, '(got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + ')'); }

const block = SRC.split('// >>> TASK_TITLE_HAIKU_V1_BEGIN')[1].split('// <<< TASK_TITLE_HAIKU_V1_END')[0]
  .replace(/app\.post\('\/task-title'[\s\S]*$/, '');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rtv3-'));
const TRANSCRIPTS = path.join(TMP, 'tr'); fs.mkdirSync(TRANSCRIPTS);

const HIST = {};   // roomKey -> messages, standing in for chatData ∪ transcript
const env = {
  fs, path, require,
  spawn: () => { throw new Error('no spawn stub installed'); },
  extractText: (c) => (typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join('') : '')),
  transcriptsDir: () => TRANSCRIPTS,
  clientSessions: new Map(),
  sessionFileExists: (id) => fs.existsSync(path.join(TRANSCRIPTS, id + '.jsonl')),
  roomHistoryMessages: (key) => HIST[key] || [],
  AUTONAME_SCRATCH: TMP,
  purgeAutonameScratch: () => {},
};
const names = Object.keys(env);
const api = new Function(...names, block +
  '\nreturn {_recentUserTurns,_renderRecentTurns,_roomSourceText,_parseTitleSummary,_ttClip,' +
  'heuristicTaskTitle,looksLikeTaskTitle,handleTaskTitle,TT_SUMMARY_CHARS};')(...names.map(n => env[n]));

/* ── 1. recency ───────────────────────────────────────────────────────────── */
console.log('\n[1] _recentUserTurns — latest + the two before it');
{
  const msgs = [
    { type: 'user', text: 'one' }, { type: 'assistant', text: 'A1' },
    { type: 'user', text: 'two' }, { type: 'assistant', text: 'A2' },
    { type: 'user', text: 'three' },
    { type: 'user', text: 'four' },
    { type: 'user', text: 'five' },
  ];
  const r = api._recentUserTurns(msgs, 3);
  eq('exactly three turns', r.length, 3);
  eq('oldest first', r[0], 'three');
  eq('newest last', r[2], 'five');
  ok('the FIRST comment is not used', r.indexOf('one') === -1);
  ok('no assistant text', r.every(t => t.indexOf('A1') === -1 && t.indexOf('A2') === -1));
}
{
  const r = api._recentUserTurns([{ type: 'user', text: 'only' }], 3);
  eq('short room -> what exists', r.join('|'), 'only');
}
{
  const r = api._recentUserTurns([{ type: 'assistant', text: 'A' }, { role: 'assistant', text: 'B' }], 3);
  eq('assistant-only room -> nothing', r.length, 0);
}

console.log('\n[2] _renderRecentTurns — recency is stated, not implied');
{
  const s = api._renderRecentTurns(['old', 'older', 'newest']);
  ok('names the most recent request', /MOST RECENT REQUEST:\nnewest/.test(s));
  ok('labels the rest as background', /EARLIER CONTEXT/.test(s));
  ok('most-recent block precedes the background', s.indexOf('MOST RECENT') < s.indexOf('EARLIER CONTEXT'));
}

/* ── 3. engine-neutral resolution ─────────────────────────────────────────── */
console.log('\n[3] _roomSourceText — Codex rooms have no .jsonl and must still work');
{
  HIST['codex-room'] = [
    { type: 'user', text: 'first ask' },
    { type: 'assistant', text: 'ASSISTANT SECRET' },
    { type: 'user', text: 'second ask' },
    { type: 'user', text: 'latest ask about the room task popup' },
  ];
  const r = api._roomSourceText('codex-room');
  ok('hasContent', r.hasContent === true);
  eq('latestInstruction is the most recent user comment', r.latestInstruction, 'latest ask about the room task popup');
  ok('prompt carries the two prior comments', /first ask|second ask/.test(r.source));
  ok('no assistant text in the prompt', r.source.indexOf('ASSISTANT SECRET') === -1);
  ok('no assistant text in the fallback', r.latestInstruction.indexOf('ASSISTANT SECRET') === -1);
  ok('no transcript file was needed', !fs.existsSync(path.join(TRANSCRIPTS, 'codex-room.jsonl')));
}
{
  eq('unknown room -> no content', api._roomSourceText('nope').hasContent, false);
  eq('path traversal rejected', api._roomSourceText('../../etc/passwd').hasContent, false);
  eq('empty id rejected', api._roomSourceText('').hasContent, false);
}

/* ── 4. parsing ───────────────────────────────────────────────────────────── */
console.log('\n[4] _parseTitleSummary');
{
  const p = api._parseTitleSummary('TITLE: Fix Room Task Title Generation\nSUMMARY: The room to task popup opens with empty fields. Generate both from the latest comment.');
  eq('title', p.title, 'Fix Room Task Title Generation');
  ok('summary captured', /empty fields/.test(p.summary));
}
{
  const p = api._parseTitleSummary('TITLE: Fix Room Task Title Generation\nSUMMARY: A wrapped summary\nthat the model split\nacross three lines.');
  eq('multiline SUMMARY collapses to one line', p.summary, 'A wrapped summary that the model split across three lines.');
}
{
  const p = api._parseTitleSummary('TITLE: Too Short\nSUMMARY: nope');
  eq('4-word title rejected', p.title, '');
  eq('stub summary rejected', p.summary, '');
}
{
  const p = api._parseTitleSummary('Sorry, I cannot help with that.');
  eq('refusal -> no title', p.title, '');
  eq('refusal -> no summary', p.summary, '');
}
{
  const p = api._parseTitleSummary('TITLE: Fix Room Task Title Generation');
  eq('title survives a missing SUMMARY', p.title, 'Fix Room Task Title Generation');
  eq('missing SUMMARY -> empty, not garbage', p.summary, '');
}
{
  const long = 'x'.repeat(30) + '. ' + 'y'.repeat(600);
  const p = api._parseTitleSummary('TITLE: Fix Room Task Title Generation\nSUMMARY: ' + long);
  ok('summary capped', p.summary.length <= api.TT_SUMMARY_CHARS, '(len ' + p.summary.length + ')');
}

/* ── 5. handleTaskTitle end to end ────────────────────────────────────────── */
function fakeRes() {
  const r = new EventEmitter();
  r.destroyed = false; r.writableEnded = false; r.body = null; r.calls = 0;
  r.json = (v) => { r.calls++; r.body = v; r.writableEnded = true; };
  return r;
}
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.kill = () => {};
  return c;
}
function run(body) {
  const res = fakeRes();
  let child = null, args = null;
  api.handleTaskTitle({ body }, res, { spawn: (...a) => { args = a; child = fakeChild(); return child; } });
  return { res, child: () => child, args: () => args };
}

console.log('\n[5] handleTaskTitle — describe path');
{
  HIST['room-a'] = [
    { type: 'user', text: 'the very first thing I ever asked' },
    { type: 'assistant', text: 'ASSISTANT SECRET' },
    { type: 'user', text: 'a middle comment' },
    { type: 'user', text: 'make the link-to-task popup generate a title' },
  ];
  const t = run({ roomId: 'room-a', describe: true });
  const prompt = t.args()[1][1];
  ok('prompt asks for TITLE + SUMMARY', /TITLE:/.test(prompt) && /SUMMARY:/.test(prompt));
  ok('prompt anchors on the most recent comment', /MOST RECENT REQUEST:\nmake the link-to-task popup generate a title/.test(prompt));
  ok('prompt contains no assistant text', prompt.indexOf('ASSISTANT SECRET') === -1);
  t.child().stdout.emit('data', Buffer.from('TITLE: Generate Room Task Title And Summary\nSUMMARY: The popup must fill both fields from the latest comment.\n'));
  t.child().emit('close', 0);
  eq('title returned', t.res.body.title, 'Generate Room Task Title And Summary');
  ok('description returned', /both fields/.test(t.res.body.description));
  eq('responds exactly once', t.res.calls, 1);
  eq('source is the latest comment only', t.res.body.source, 'make the link-to-task popup generate a title');
  ok('source is not the first comment', t.res.body.source.indexOf('very first thing') === -1);
}
{
  const t = run({ roomId: 'room-a', describe: true });
  t.child().stdout.emit('data', Buffer.from('I am sorry, I cannot do that.\n'));
  t.child().emit('close', 0);
  eq('malformed output -> no model title', t.res.body.title, '');
  eq('malformed output -> no model description', t.res.body.description, '');
  ok('fallback title is a label, not a sentence', t.res.body.fallbackTitle.split(' ').length <= 7 && t.res.body.fallbackTitle.length > 0);
  eq('fallback description IS the latest user comment', t.res.body.fallbackDescription, 'make the link-to-task popup generate a title');
  ok('fallback description carries no assistant text', t.res.body.fallbackDescription.indexOf('ASSISTANT SECRET') === -1);
  ok('fallback description is not the first comment', t.res.body.fallbackDescription.indexOf('very first thing') === -1);
  eq('hasContent true', t.res.body.hasContent, true);
}
{
  HIST['room-empty'] = [{ type: 'assistant', text: 'only the assistant spoke' }];
  const t = run({ roomId: 'room-empty', describe: true });
  eq('empty room -> hasContent false', t.res.body.hasContent, false);
  eq('  no title', t.res.body.title, '');
  eq('  no description', t.res.body.description, '');
  eq('  no fallback description', t.res.body.fallbackDescription, '');
  ok('  no model was spawned', t.child() === null);
}

console.log('\n[6] handleTaskTitle — conference path is untouched');
{
  const t = run({ text: 'Make the conference popup stop running twice' });
  const prompt = t.args()[1][1];
  ok('legacy single-field prompt', /5 to 7 word Title Case label/.test(prompt) && !/SUMMARY:/.test(prompt));
  t.child().stdout.emit('data', Buffer.from('Fix Conference Task Popup Duplication\n'));
  t.child().emit('close', 0);
  eq('title', t.res.body.title, 'Fix Conference Task Popup Duplication');
  eq('source still echoes the typed text', t.res.body.source, 'Make the conference popup stop running twice');
  eq('no description on the legacy path', t.res.body.description, '');
}

console.log('\n' + (fail ? '  FAILED ' + fail + ' / ' + (pass + fail) : '  ALL ' + pass + ' PASSED'));
process.exit(fail ? 1 : 0);
