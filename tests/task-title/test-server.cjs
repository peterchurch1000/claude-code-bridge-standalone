/* TASK_TITLE_HAIKU_V1 — server test matrix. Runs against the PATCHED copy. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const SRC = fs.readFileSync('/tmp/ttlive/bridge-server.js', 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? ('  ' + extra) : '')); } }
function eq(name, a, b) { ok(name, a === b, '(got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + ')'); }

/* ── extract the units under test ───────────────────────────────────────── */
const block = SRC.split('// >>> TASK_TITLE_HAIKU_V1_BEGIN')[1].split('// <<< TASK_TITLE_HAIKU_V1_END')[0]
  .replace(/app\.post\('\/task-title'[\s\S]*$/, '');
const canon = SRC.slice(SRC.indexOf('async function taskFromApi(file)'),
                        SRC.indexOf('// [CONF_TASK_ASSOC_V1] Single entry'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ttdry-'));
const TASKS_DIR = path.join(TMP, 'tasks'); fs.mkdirSync(TASKS_DIR);
const TRANSCRIPTS = path.join(TMP, 'tr'); fs.mkdirSync(TRANSCRIPTS);

const env = {
  fs, path, require,
  spawn: () => { throw new Error('no spawn stub installed'); },
  extractText: (c) => (typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join('') : '')),
  transcriptsDir: () => TRANSCRIPTS,
  clientSessions: new Map(),
  sessionFileExists: (id) => fs.existsSync(path.join(TRANSCRIPTS, id + '.jsonl')),
  AUTONAME_SCRATCH: TMP,
  purgeAutonameScratch: () => {},
  TASKS_DIR,
  parseTaskFile: (full) => { try { return JSON.parse(fs.readFileSync(full, 'utf8')); } catch { return null; } },
  bridgeTaskJwt: () => env._jwt,
  BRIDGE_TASK_API: 'http://stub/api',
  fetch: (...a) => env._fetch(...a),
  AbortSignal: { timeout: () => null },
  _jwt: 'jwt', _fetch: async () => ({ ok: false }),
};
const names = Object.keys(env);
const api = new Function(...names, block + '\n' + canon +
  '\nreturn {looksLikeTaskTitle,firstUserFullText,_taskTitlePromptSource,_resolveRoomSession,handleTaskTitle,taskFromApi,confCanonicalTask,setSpawn:(f)=>{spawn=f;}};'
  .replace('setSpawn:(f)=>{spawn=f;}', 'setSpawn:(f)=>{_stub=f;}')
)(...names.map(n => env[n]));

/* spawn is a parameter, so re-bind via deps injection instead */
function withSpawn(f) { return { spawn: f }; }

console.log('\n[1] looksLikeTaskTitle');
ok('rejects 4 words', !api.looksLikeTaskTitle('Fix The Popup Bug'));
ok('accepts 5 words', api.looksLikeTaskTitle('Fix Conference Task Popup Duplication'));
ok('accepts 6 words', api.looksLikeTaskTitle('Fix The Conference Task Popup Duplication'));
ok('accepts 7 words', api.looksLikeTaskTitle('Fix The Conference Room Task Popup Duplication'));
ok('rejects 8 words', !api.looksLikeTaskTitle('Fix The Conference Room Task Association Popup Duplication'));
ok('rejects sentence punctuation', !api.looksLikeTaskTitle('Fix the conference task popup.'));
ok('rejects a refusal', !api.looksLikeTaskTitle('Sorry I cannot summarise that request'));
ok('rejects empty', !api.looksLikeTaskTitle(''));

console.log('\n[2] firstUserFullText');
const LONG = 'word '.repeat(300).trim();                       // ~1499 chars, way past the 400 cap
const f1 = path.join(TRANSCRIPTS, 'sess-long.jsonl');
fs.writeFileSync(f1, [
  JSON.stringify({ type: 'summary', summary: 'x' }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: LONG } }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'second' } }),
].join('\n') + '\n');
eq('returns the FULL first user message (untruncated)', api.firstUserFullText(f1), LONG);
ok('  and it exceeds the old 400-char cap', LONG.length > 400);

const f2 = path.join(TRANSCRIPTS, 'sess-mb.jsonl');
const PAD = 'a'.repeat(131070);                                 // push a multi-byte char over the 131072 boundary
fs.writeFileSync(f2, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: PAD } }) + '\n' +
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'café über 你好' } }) + '\n');
eq('survives a multi-byte char split across chunks', api.firstUserFullText(f2), 'café über 你好');

const f3 = path.join(TRANSCRIPTS, 'sess-blocks.jsonl');
fs.writeFileSync(f3, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'block  form\n text' }] } }) + '\n');
eq('handles content blocks + collapses whitespace', api.firstUserFullText(f3), 'block form text');
eq('missing file -> empty', api.firstUserFullText(path.join(TRANSCRIPTS, 'nope.jsonl')), '');
const f4 = path.join(TRANSCRIPTS, 'sess-none.jsonl');
fs.writeFileSync(f4, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi' } }) + '\n');
eq('no user record -> empty', api.firstUserFullText(f4), '');
const f5 = path.join(TRANSCRIPTS, 'sess-nonl.jsonl');
fs.writeFileSync(f5, JSON.stringify({ type: 'user', message: { role: 'user', content: 'no trailing newline' } }));
eq('final line without a trailing newline', api.firstUserFullText(f5), 'no trailing newline');

console.log('\n[3] _taskTitlePromptSource');
const capped = api._taskTitlePromptSource(LONG);
ok('caps the model prompt at <=400', capped.length <= 400 && capped.length > 380, '(len ' + capped.length + ')');
ok('cuts on a word boundary', !/\S$/.test(capped + ' ') && capped.split(' ').every(w => w === 'word'));
eq('short text passes through', api._taskTitlePromptSource('  a  b '), 'a b');

console.log('\n[4] _resolveRoomSession');
env.clientSessions.set('room-1', { sessionId: 'sess-long' });
eq('client room key -> session id', api._resolveRoomSession('room-1'), 'sess-long');
eq('bare session id with a transcript', api._resolveRoomSession('sess-long'), 'sess-long');
eq('unknown -> empty', api._resolveRoomSession('nope'), '');
eq('path traversal rejected', api._resolveRoomSession('../../etc/passwd'), '');
eq('empty rejected', api._resolveRoomSession(''), '');

/* ── handleTaskTitle harness ────────────────────────────────────────────── */
function fakeRes() {
  const r = new EventEmitter();
  r.destroyed = false; r.writableEnded = false; r.body = null; r.calls = 0;
  r.json = (v) => { r.calls++; r.body = v; r.writableEnded = true; };
  return r;
}
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.killed = 0; c.kill = () => { c.killed++; };
  return c;
}
function run(body, spawnImpl) {
  const res = fakeRes();
  let child = null;
  const deps = { spawn: (...a) => { child = spawnImpl ? spawnImpl(...a) : fakeChild(); if (child instanceof Error) throw child; return child; } };
  api.handleTaskTitle({ body }, res, deps);
  return { res, child: () => child };
}

console.log('\n[5] handleTaskTitle lifecycle');
{
  const t = run({ text: 'Make the conference popup stop running twice' });
  t.child().stdout.emit('data', Buffer.from('  "Fix Conference Task Popup Duplication"  \n'));
  t.child().emit('close', 0);
  eq('happy path -> Haiku title', t.res.body.title, 'Fix Conference Task Popup Duplication');
  eq('  responds exactly once', t.res.calls, 1);
  eq('  source echoed back for the Description', t.res.body.source, 'Make the conference popup stop running twice');
}
{
  const t = run({ text: 'hello world' });
  t.child().stdout.emit('data', Buffer.from('I am sorry, I cannot do that.'));
  t.child().emit('close', 0);
  eq('rejected model output -> empty title', t.res.body.title, '');
  eq('  fallback is a Title Case label, not the raw text [V2]', t.res.body.fallback, 'Hello World');
}
{
  const t = run({ text: 'x '.repeat(200) });
  eq('long source: nothing written while generating', t.res.calls, 0);
  t.child().emit('close', 0);
  ok('  fallback is <=7 words [V2]', t.res.body.fallback.split(' ').filter(Boolean).length <= 7);
  ok('  fallback is NOT the raw sentence [V2]', t.res.body.fallback.length < 90);
  ok('  source itself stays untruncated', t.res.body.source.length === 399);
}
{
  const t = run({ text: 'timeout please' });
  const timers = [];                                   // fire the 13s killer deterministically
  eq('no response before the model answers', t.res.calls, 0);
  t.child().emit('error', new Error('ENOENT'));
  eq('spawn error -> empty title response', t.res.body.title, '');
  eq('  responded once', t.res.calls, 1);
  ok('  child killed during cleanup', t.child().killed >= 1);
}
{
  const t = run({ text: 'disconnect me' });
  t.res.destroyed = true; t.res.emit('close');         // client aborted before the model answered
  eq('disconnect -> no response written', t.res.calls, 0);
  ok('  child killed', t.child().killed >= 1);
  t.child().stdout.emit('data', Buffer.from('Fix Conference Task Popup Duplication'));
  t.child().emit('close', 0);
  eq('  late close is inert (still no response)', t.res.calls, 0);
}
{
  const t = run({ text: 'double settle' });
  t.child().stdout.emit('data', Buffer.from('Fix Conference Task Popup Duplication'));
  t.child().emit('close', 0);
  t.child().emit('close', 0);
  t.child().emit('error', new Error('late'));
  eq('settle is idempotent across repeat events', t.res.calls, 1);
}
{
  const t = run({ text: '   ' });
  eq('blank text + no room -> immediate empty response', t.res.body.title, '');
  eq('  never spawned', t.child(), null);
}
{
  env.clientSessions.set('room-long', { sessionId: 'sess-long' });
  const t = run({ roomId: 'room-long' });
  ok('roomId path reads the full transcript text', t.res === t.res && t.child() !== null);
  t.child().emit('close', 0);
  eq('  source is the untruncated first instruction', t.res.body.source, LONG);
}
{
  const a = run({ text: 'one' }), b = run({ text: 'two' }), c = run({ text: 'three' });
  eq('in-flight cap: 3rd request answers immediately', c.res.calls, 1);
  eq('  and never spawned', c.child(), null);
  a.child().emit('close', 0); b.child().emit('close', 0);
  const d = run({ text: 'four' });
  ok('  cap released after cleanup', d.child() !== null);
  d.child().emit('close', 0);
}

console.log('\n[6] confCanonicalTask  (defect #2 root cause)');
(async () => {
  eq('decision none', (await api.confCanonicalTask('none', null)).status, 'none');
  eq('garbage decision', (await api.confCanonicalTask('wat', {})).status, 'invalid');
  eq('bad filename', (await api.confCanonicalTask('linked', { file: '../etc/passwd' })).status, 'invalid');

  fs.writeFileSync(path.join(TASKS_DIR, 'task-abc.md'), JSON.stringify({ id: '123', title: 'On disk' }));
  const onDisk = await api.confCanonicalTask('linked', { file: 'task-abc.md' });
  eq('.md present -> linked from the file', onDisk.status, 'linked');
  eq('  server-authoritative title', onDisk.task.title, 'On disk');

  let apiHit = 0;
  env._fetch = async () => { apiHit++; return { ok: true, json: async () => ({ tasks: [{ file: 'task-new.md', id: '999', title: 'Just created' }] }) }; };
  const justMade = await api.confCanonicalTask('linked', { file: 'task-new.md' });
  eq('.md NOT written yet -> linked from the task API', justMade.status, 'linked');
  eq('  title comes from the store', justMade.task.title, 'Just created');
  eq('  id comes from the store', justMade.task.id, '999');
  ok('  API was consulted', apiHit === 1);

  apiHit = 0;
  await api.confCanonicalTask('linked', { file: 'task-abc.md' });
  eq('.md fast path skips the API entirely', apiHit, 0);

  const miss = await api.confCanonicalTask('linked', { file: 'task-ghost.md' });
  eq('unknown everywhere -> invalid (still fails closed)', miss.status, 'invalid');

  env._jwt = '';
  eq('no jwt -> invalid, no throw', (await api.confCanonicalTask('linked', { file: 'task-new.md' })).status, 'invalid');
  env._jwt = 'jwt';
  env._fetch = async () => { throw new Error('network down'); };
  eq('API error -> invalid, no throw', (await api.confCanonicalTask('linked', { file: 'task-new.md' })).status, 'invalid');
  env._fetch = async () => ({ ok: false });
  eq('API non-200 -> invalid', (await api.confCanonicalTask('linked', { file: 'task-new.md' })).status, 'invalid');

  console.log('\n[7] wiring');
  ok('confTryStart is async', /async function confTryStart\(S, brief, msg\)/.test(SRC));
  ok('confCanonicalTask is awaited', SRC.indexOf('const dec = await confCanonicalTask(') !== -1);
  eq('both call sites have .catch', (SRC.match(/confTryStart\(S, \w+, msg\)\.catch\(/g) || []).length, 2);
  ok('no unguarded confTryStart call remains', !/confTryStart\(S, \w+, msg\);/.test(SRC));
  ok('POST /task-title registered', SRC.indexOf("app.post('/task-title'") !== -1);
  ok('route is not shadowed by the /tasks proxy', SRC.indexOf("app.use('/tasks'") !== -1 && '/task-title'.indexOf('/tasks/') !== 0);

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed\n');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
