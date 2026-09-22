'use strict';
// [ORCH_V1] Unit + integration tests for the orchestration core. No engines, no bridge.
// Run: node orch-test.cjs

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const O = require('./orch.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.message)); fail++; }
}
function section(s) { console.log('\n' + s); }

// ── glob overlap (conservative) ───────────────────────────────────────────────
section('glob overlap');
t('identical scopes overlap', () => assert.strictEqual(O.globsOverlap(['app/a.js'], ['app/a.js']), true));
t('disjoint dirs do not overlap', () => assert.strictEqual(O.globsOverlap(['app/**'], ['docs/**']), false));
t('subtree contains file', () => assert.strictEqual(O.globsOverlap(['app/**'], ['app/Http/x.php']), true));
t('sibling prefixes are not overlapping', () => assert.strictEqual(O.globsOverlap(['app/**'], ['apple/**']), false));
t('repo-root glob overlaps everything', () => assert.strictEqual(O.globsOverlap(['**'], ['docs/x.md']), true));
t('wildcard filename in same dir is conservative', () => assert.strictEqual(O.globsOverlap(['app/*.js'], ['app/b.js']), true));
t('distinct files in same dir do not overlap', () => assert.strictEqual(O.globsOverlap(['app/a.js'], ['app/b.js']), false));

section('pathInScope');
t('exact file in scope', () => assert.strictEqual(O.pathInScope('app/a.js', ['app/a.js']), true));
t('file under subtree in scope', () => assert.strictEqual(O.pathInScope('app/x/y.js', ['app/**']), true));
t('file outside scope rejected', () => assert.strictEqual(O.pathInScope('docs/z.md', ['app/**']), false));
t('sibling-prefix file rejected', () => assert.strictEqual(O.pathInScope('apple/z.js', ['app/**']), false));

// ── opId derivation / idempotency ────────────────────────────────────────────
section('opId derivation');
t('same input -> same opId', () => {
  const op = { op: 'spawn', cid: 'c1', text: 'x' };
  assert.strictEqual(O.opIdFor('e1', 3, op), O.opIdFor('e1', 3, { text: 'x', cid: 'c1', op: 'spawn' }));
});
t('different causal event -> different opId', () => {
  const op = { op: 'spawn', cid: 'c1' };
  assert.notStrictEqual(O.opIdFor('e1', 1, op), O.opIdFor('e2', 1, op));
});
t('different planRev -> different opId', () => {
  const op = { op: 'spawn', cid: 'c1' };
  assert.notStrictEqual(O.opIdFor('e1', 1, op), O.opIdFor('e1', 2, op));
});

// ── block protocol + schemas ─────────────────────────────────────────────────
section('block protocol');
t('extracts a well-formed block', () => {
  const r = O.extractBlock('blah\n<<<ORCH_CMD\n{"ops":[{"op":"cancel","cid":"c1"}]}\nORCH_CMD>>>', 'ORCH_CMD');
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.json.ops[0].op, 'cancel');
  assert.strictEqual(r.visible, 'blah');
});
t('absent block reports not found', () => assert.strictEqual(O.extractBlock('nothing', 'ORCH_CMD').found, false));
t('malformed JSON reports an error, not a throw', () => {
  const r = O.extractBlock('<<<ORCH_CMD\n{nope}\nORCH_CMD>>>', 'ORCH_CMD');
  assert.strictEqual(r.found, true); assert.ok(r.error);
});

section('schemas');
t('valid plan passes', () => {
  assert.deepStrictEqual(O.validatePlan({ subtasks: [{ title: 'a', brief: 'b', done_definition: 'd', mode: 'solo', files: ['app/a.js'] }] }), []);
});
t('plan without scope fails', () => {
  assert.ok(O.validatePlan({ subtasks: [{ title: 'a', brief: 'b', done_definition: 'd', mode: 'solo', files: [] }] }).length);
});
t('plan with bad mode fails', () => {
  assert.ok(O.validatePlan({ subtasks: [{ title: 'a', brief: 'b', done_definition: 'd', mode: 'pair', files: ['x'] }] }).length);
});
t('cmd requires cid for non-spawn ops', () => assert.ok(O.validateCmd({ ops: [{ op: 'cancel' }] }).length));
t('valid report passes', () => assert.deepStrictEqual(O.validateReport({ status: 'done', summary: 's' }), []));
t('report with bad status fails', () => assert.ok(O.validateReport({ status: 'finished', summary: 's' }).length));

// ── resource accounting ──────────────────────────────────────────────────────
section('resource accounting');
t('queued and parked consume no slot or seat', () => {
  const rec = O.newRecord('m1', 'room', '/tmp/repo');
  rec.children = [
    { cid: 'a', state: 'running' }, { cid: 'b', state: 'awaiting-instructions' },
    { cid: 'c', state: 'queued' }, { cid: 'd', state: 'parked' }, { cid: 'e', state: 'done' },
  ];
  assert.strictEqual(O.countSlots(rec), 2);
  assert.strictEqual(O.countSeats(rec), 1);   // awaiting holds a slot but no engine seat
});

// ── git: preflight, isolation, scope, integration ────────────────────────────
section('git lifecycle');

function mkrepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-repo-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'trunk');
  g('config', 'user.email', 'test@test');
  g('config', 'user.name', 'test');
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'a.js'), 'let rounds = 1;\n');
  fs.writeFileSync(path.join(dir, 'docs', 'r.md'), '# readme\n');
  g('add', '-A'); g('commit', '-qm', 'init');
  return dir;
}

const repos = [];
function repo() { const r = mkrepo(); repos.push(r); return r; }

t('preflight rejects a non-repo', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-plain-'));
  const p = O.preflight(d);
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.code, 'not-a-git-repo');
});

t('preflight rejects a dirty worktree', () => {
  const d = repo();
  fs.writeFileSync(path.join(d, 'app', 'a.js'), 'dirty\n');
  const p = O.preflight(d);
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.code, 'dirty-worktree');
});

t('preflight rejects untracked files too', () => {
  const d = repo();
  fs.writeFileSync(path.join(d, 'stray.txt'), 'x\n');
  assert.strictEqual(O.preflight(d).code, 'dirty-worktree');
});

t('preflight on a clean repo returns real targetRef (not assumed main)', () => {
  const d = repo();
  const p = O.preflight(d);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.targetRef, 'trunk');
  assert.ok(/^[0-9a-f]{40}$/.test(p.baseCommit));
});

t('two children work in isolation and both integrate cleanly', () => {
  const d = repo();
  const p = O.preflight(d);
  const w1 = path.join(O.WORKTREE_ROOT, 'test-c1-' + process.pid);
  const w2 = path.join(O.WORKTREE_ROOT, 'test-c2-' + process.pid);
  O.worktreeAdd(d, w1, 'orch/t/c1-' + process.pid, p.baseCommit);
  O.worktreeAdd(d, w2, 'orch/t/c2-' + process.pid, p.baseCommit);
  try {
    fs.writeFileSync(path.join(w1, 'app', 'a.js'), 'let rounds = 2;\n');
    fs.writeFileSync(path.join(w2, 'docs', 'r.md'), '# readme v2\n');
    const r1 = O.integrate(d, w1, { targetRef: p.targetRef, baseCommit: p.baseCommit, globs: ['app/**'], masterId: 'm', cid: 'c1', reportId: 'r1' });
    const r2 = O.integrate(d, w2, { targetRef: p.targetRef, baseCommit: p.baseCommit, globs: ['docs/**'], masterId: 'm', cid: 'c2', reportId: 'r2' });
    assert.strictEqual(r1.ok, true, 'c1 integrates');
    assert.strictEqual(r2.ok, true, 'c2 integrates');
    assert.strictEqual(fs.readFileSync(path.join(d, 'app', 'a.js'), 'utf8'), 'let rounds = 2;\n');
    assert.strictEqual(fs.readFileSync(path.join(d, 'docs', 'r.md'), 'utf8'), '# readme v2\n');
  } finally { O.worktreeRemove(d, w1); O.worktreeRemove(d, w2); }
});

t('scope violation is detected from the resulting diff (incl. new files)', () => {
  const d = repo();
  const p = O.preflight(d);
  const w = path.join(O.WORKTREE_ROOT, 'test-c3-' + process.pid);
  O.worktreeAdd(d, w, 'orch/t/c3-' + process.pid, p.baseCommit);
  try {
    fs.writeFileSync(path.join(w, 'app', 'a.js'), 'let rounds = 2;\n');   // in scope
    fs.writeFileSync(path.join(w, 'docs', 'new.md'), 'sneaky\n');          // out of scope, untracked
    const v = O.scopeViolations(w, p.baseCommit, ['app/**']);
    assert.deepStrictEqual(v, ['docs/new.md']);
  } finally { O.worktreeRemove(d, w); }
});

t('integration is idempotent via the durable commit trailer', () => {
  const d = repo();
  const p = O.preflight(d);
  const w = path.join(O.WORKTREE_ROOT, 'test-c4-' + process.pid);
  O.worktreeAdd(d, w, 'orch/t/c4-' + process.pid, p.baseCommit);
  try {
    fs.writeFileSync(path.join(w, 'app', 'a.js'), 'let rounds = 3;\n');
    const first = O.integrate(d, w, { targetRef: p.targetRef, baseCommit: p.baseCommit, globs: ['app/**'], masterId: 'm', cid: 'c4', reportId: 'r4' });
    assert.strictEqual(first.ok, true);
    const before = O.git(d, ['rev-list', '--count', p.targetRef]);
    const second = O.integrate(d, w, { targetRef: p.targetRef, baseCommit: p.baseCommit, globs: ['app/**'], masterId: 'm', cid: 'c4', reportId: 'r4' });
    const after = O.git(d, ['rev-list', '--count', p.targetRef]);
    assert.strictEqual(second.alreadyIntegrated, true, 'replay detected');
    assert.strictEqual(before, after, 'no duplicate commit');
  } finally { O.worktreeRemove(d, w); }
});

t('conflicting concurrent edits abort integration and land nothing', () => {
  const d = repo();
  const p = O.preflight(d);
  const w1 = path.join(O.WORKTREE_ROOT, 'test-c5-' + process.pid);
  const w2 = path.join(O.WORKTREE_ROOT, 'test-c6-' + process.pid);
  O.worktreeAdd(d, w1, 'orch/t/c5-' + process.pid, p.baseCommit);
  O.worktreeAdd(d, w2, 'orch/t/c6-' + process.pid, p.baseCommit);
  try {
    fs.writeFileSync(path.join(w1, 'app', 'a.js'), 'let rounds = 2;\n');
    fs.writeFileSync(path.join(w2, 'app', 'a.js'), 'let rounds = 99;\n');
    const r1 = O.integrate(d, w1, { targetRef: p.targetRef, baseCommit: p.baseCommit, globs: ['app/**'], masterId: 'm', cid: 'c5', reportId: 'r5' });
    assert.strictEqual(r1.ok, true);
    const headBefore = O.git(d, ['rev-parse', p.targetRef]);
    const r2 = O.integrate(d, w2, { targetRef: p.targetRef, baseCommit: p.baseCommit, globs: ['app/**'], masterId: 'm', cid: 'c6', reportId: 'r6' });
    assert.strictEqual(r2.ok, false, 'second child conflicts');
    assert.ok(r2.conflict.includes('app/a.js'));
    assert.strictEqual(O.git(d, ['rev-parse', p.targetRef]), headBefore, 'nothing landed on conflict');
    assert.strictEqual(fs.readFileSync(path.join(d, 'app', 'a.js'), 'utf8'), 'let rounds = 2;\n', 'working tree untouched');
  } finally { O.worktreeRemove(d, w1); O.worktreeRemove(d, w2); }
});

t('unrelated user changes outside scope are never absorbed', () => {
  const d = repo();
  const p = O.preflight(d);
  const w = path.join(O.WORKTREE_ROOT, 'test-c7-' + process.pid);
  O.worktreeAdd(d, w, 'orch/t/c7-' + process.pid, p.baseCommit);
  try {
    fs.writeFileSync(path.join(w, 'app', 'a.js'), 'let rounds = 7;\n');
    // user edits an out-of-scope file after approval
    fs.writeFileSync(path.join(d, 'docs', 'r.md'), '# user edit\n');
    const r = O.integrate(d, w, { targetRef: p.targetRef, baseCommit: p.baseCommit, globs: ['app/**'], masterId: 'm', cid: 'c7', reportId: 'r7' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(d, 'docs', 'r.md'), 'utf8'), '# user edit\n', 'user edit preserved');
    assert.ok(!O.git(d, ['show', '--name-only', '--format=', p.targetRef]).includes('docs/r.md'), 'user edit not committed');
  } finally { O.worktreeRemove(d, w); }
});

// ── persistence ──────────────────────────────────────────────────────────────
section('persistence');
t('record round-trips and bumps graphRev', () => {
  const rec = O.newRecord('test-m-' + process.pid, 'room-x', '/tmp/repo');
  O.saveRecord(rec);
  const back = O.loadRecord(rec.masterId);
  assert.strictEqual(back.masterId, rec.masterId);
  assert.strictEqual(back.graphRev, 1);
  O.saveRecord(back);
  assert.strictEqual(O.loadRecord(rec.masterId).graphRev, 2);
  fs.unlinkSync(O.recordFile(rec.masterId));
});

t('outbox events carry stable ids', () => {
  const rec = O.newRecord('m2', 'room', '/tmp/repo');
  const ev = O.pushEvent(rec, 'child_report', { cid: 'c1' });
  assert.ok(ev.eventId && ev.state === 'pending');
  assert.strictEqual(rec.outbox.length, 1);
  assert.strictEqual(rec.log.length, 1);
});

for (const r of repos) { try { fs.rmSync(r, { recursive: true, force: true }); } catch (e) {} }
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
