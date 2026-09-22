'use strict';
// [ORCH_V1] Runtime lifecycle tests against a stubbed bridge (no engines, no HTTP).
// Run: node orch-runtime-test.cjs

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const O = require('./orch');
const RT = require('./orch-runtime');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); fail++; }
}
function section(s) { console.log('\n' + s); }

// ── stub bridge ───────────────────────────────────────────────────────────────
function harness() {
  const clientSessions = new Map();
  const sent = [];           // {roomKey, text}
  const killed = [];
  const tasks = {};          // file -> {status, progress[], questions[]}
  let taskSeq = 0;
  const confStarts = [];

  const deps = {
    app: null,
    clientSessions,
    makeSession: (key) => ({ key, orch: null, processing: false, send() {} }),
    restoreRoom: () => {},
    confStart: (S, brief, opts) => { confStarts.push({ key: S.key, brief, opts }); },
    sendToEngine: (S, text) => { sent.push({ roomKey: S.key, text }); },
    killRoom: (S, reason) => { killed.push({ roomKey: S.key, reason }); },
    taskApi: {
      create: ({ title }) => { const id = String(++taskSeq).padStart(3, '0'); const file = 'task-' + id + '-x.md';
        tasks[file] = { status: 'new', progress: [], questions: [], title }; return { file, id }; },
      setStatus: (file, status) => { tasks[file].status = status; },
      addProgress: (file, text) => { tasks[file].progress.push(text); },
      addQuestion: (file, text) => { tasks[file].questions.push(text); },
      linkRoom: () => {},
    },
    log: () => {},
  };
  const rt = RT.attach(deps);
  return { rt, deps, clientSessions, sent, killed, tasks, confStarts };
}

const repos = [];
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rt-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'trunk'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'app')); fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'app', 'a.js'), 'let rounds = 1;\n');
  fs.writeFileSync(path.join(dir, 'docs', 'r.md'), '# r\n');
  g('add', '-A'); g('commit', '-qm', 'init');
  repos.push(dir);
  return dir;
}

const madeMasters = [];
function designate(h, d, roomKey) {
  const r = h.rt.designate(roomKey || ('room-' + Math.random().toString(16).slice(2)), d);
  if (r.ok) madeMasters.push(r.masterId);
  return r;
}

function planOf(subtasks) { return { subtasks }; }
const ST = (over) => Object.assign({
  title: 'bump rounds', brief: 'change 1 to 2', done_definition: 'a.js says 2',
  mode: 'solo', files: ['app/**'],
}, over || {});

// child session helper: return the stub session for a child room
function childSession(h, cid, masterId) {
  const rec = O.loadRecord(masterId);
  const c = O.childById(rec, cid);
  return h.clientSessions.get(c.roomKey);
}

// ── tests ─────────────────────────────────────────────────────────────────────
section('designation + preconditions');

t('designation hard-stops on a non-git workspace', () => {
  const h = harness();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-plain-'));
  const r = designate(h, d);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'not-a-git-repo');
});

t('designation hard-stops on a dirty workspace', () => {
  const h = harness(); const d = repo();
  fs.writeFileSync(path.join(d, 'app', 'a.js'), 'dirty\n');
  const r = designate(h, d);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'dirty-worktree');
});

t('designation on a clean repo binds a master and briefs the room', () => {
  const h = harness(); const d = repo();
  const r = designate(h, d);
  assert.strictEqual(r.ok, true);
  assert.ok(r.masterId.startsWith('m-'));
  assert.strictEqual(h.rt.roomForMaster(r.masterId) != null, true);
});

section('planning');

t('overlapping scopes are rejected before anything spawns', () => {
  const h = harness(); const d = repo(); const m = designate(h, d).masterId;
  const r = h.rt.submitPlan(m, planOf([ST(), ST({ title: 'other', files: ['app/a.js'] })]));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'overlapping scopes');
});

t('plan without a declared scope is rejected', () => {
  const h = harness(); const d = repo(); const m = designate(h, d).masterId;
  assert.strictEqual(h.rt.submitPlan(m, planOf([ST({ files: [] })])).ok, false);
});

t('approving a stale planRev is refused', () => {
  const h = harness(); const d = repo(); const m = designate(h, d).masterId;
  const p = h.rt.submitPlan(m, planOf([ST()])).plan;
  h.rt.editPlan(m, p.planId, [ST({ title: 'edited' })]);       // bumps planRev
  const r = h.rt.approvePlan(m, p.planId, p.planRev);          // old rev
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'stale-plan-rev');
});

t('approval re-checks cleanliness at the moment of spawn', () => {
  const h = harness(); const d = repo(); const m = designate(h, d).masterId;
  const p = h.rt.submitPlan(m, planOf([ST()])).plan;
  fs.writeFileSync(path.join(d, 'stray.txt'), 'x\n');          // dirty AFTER designation
  const r = h.rt.approvePlan(m, p.planId, p.planRev);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'dirty-worktree');
  fs.unlinkSync(path.join(d, 'stray.txt'));
});

section('spawn + scheduling');

t('approval spawns children, creates tasks, and sends only the brief', () => {
  const h = harness(); const d = repo(); const m = designate(h, d).masterId;
  const p = h.rt.submitPlan(m, planOf([ST(), ST({ title: 'docs', files: ['docs/**'] })])).plan;
  assert.strictEqual(h.rt.approvePlan(m, p.planId, p.planRev).ok, true);
  const g = h.rt.graph(m);
  assert.strictEqual(g.children.length, 2);
  assert.ok(g.children.every(c => c.state === 'running'));
  assert.ok(g.children.every(c => c.taskFile));
  const briefs = h.sent.filter(s => s.roomKey.startsWith('orch-'));
  assert.strictEqual(briefs.length, 2);
  assert.ok(briefs[0].text.includes('Sub-task:'));
  assert.ok(!briefs[0].text.includes('ORCH updates'), 'child gets no master history');
  assert.ok(fs.existsSync(g.children[0].roomKey ? O.loadRecord(m).children[0].worktree : ''), 'worktree created');
});

t('the sixth child queues instead of consuming a slot', () => {
  const h = harness(); const d = repo(); const m = designate(h, d).masterId;
  const subs = ['a', 'b', 'c', 'd', 'e', 'f'].map(n => ST({ title: n, files: ['app/' + n + '/**'] }));
  const p = h.rt.submitPlan(m, planOf(subs)).plan;
  h.rt.approvePlan(m, p.planId, p.planRev);
  const g = h.rt.graph(m);
  assert.strictEqual(g.slots.used, 5);
  assert.strictEqual(g.children.filter(c => c.state === 'queued').length, 1);
  assert.ok(g.children.find(c => c.state === 'queued').queueReason.includes('slots'));
});

t('conference children go through confStart, solo children do not', () => {
  const h = harness(); const d = repo(); const m = designate(h, d).masterId;
  const p = h.rt.submitPlan(m, planOf([ST({ mode: 'conference' })])).plan;
  h.rt.approvePlan(m, p.planId, p.planRev);
  assert.strictEqual(h.confStarts.length, 1);
  assert.ok(h.confStarts[0].brief.includes('CHILD_REPORT'));
  assert.ok(h.confStarts[0].opts.task, 'conference child is task-linked');
});

section('reporting + integration');

function runOneChild(over) {
  const h = harness(); const d = repo(); const m = designate(h, d).masterId;
  const p = h.rt.submitPlan(m, planOf([ST(over)])).plan;
  h.rt.approvePlan(m, p.planId, p.planRev);
  const rec = O.loadRecord(m);
  const c = rec.children[0];
  return { h, d, m, c };
}

t('a done report integrates, completes the task and notifies the master', () => {
  const { h, d, m, c } = runOneChild();
  fs.writeFileSync(path.join(c.worktree, 'app', 'a.js'), 'let rounds = 2;\n');
  const S = h.clientSessions.get(c.roomKey);
  h.rt.onTurnEnd(S, 'claude', 'done\n<<<CHILD_REPORT\n{"status":"done","summary":"bumped","files_changed":["app/a.js"]}\nCHILD_REPORT>>>');
  return new Promise(r => r()).then(() => {});
});

// integration runs on a promise chain; drain it before asserting
function drain() { return new Promise(res => setImmediate(() => setImmediate(res))); }

(async () => {
  await (async function integrationTests() {
    section('reporting + integration (async)');

    await (async () => {
      const { h, d, m, c } = runOneChild();
      fs.writeFileSync(path.join(c.worktree, 'app', 'a.js'), 'let rounds = 2;\n');
      h.rt.onTurnEnd(h.clientSessions.get(c.roomKey), 'claude',
        '<<<CHILD_REPORT\n{"status":"done","summary":"bumped","files_changed":["app/a.js"],"misses_and_fixes":["docs/r.md is stale"]}\nCHILD_REPORT>>>');
      await drain();
      t('done report lands the change on the real branch', () => {
        assert.strictEqual(fs.readFileSync(path.join(d, 'app', 'a.js'), 'utf8'), 'let rounds = 2;\n');
      });
      t('child reaches done and its Organiser task is completed', () => {
        const g = h.rt.graph(m);
        assert.strictEqual(g.children[0].state, 'done');
        assert.strictEqual(h.tasks[g.children[0].taskFile].status, 'done');
      });
      t('misses-and-fixes is written by the orchestrator only', () => {
        const f = path.join(d, 'MISSES-AND-FIXES.md');
        assert.ok(fs.existsSync(f));
        assert.ok(fs.readFileSync(f, 'utf8').includes('docs/r.md is stale'));
      });
      t('the master is auto-dispatched a turn carrying the report', () => {
        const masterRoom = h.rt.roomForMaster(m);
        const msgs = h.sent.filter(s => s.roomKey === masterRoom && s.text.startsWith('ORCH updates'));
        assert.strictEqual(msgs.length, 1);
        assert.ok(msgs[0].text.includes('child_report'));
      });
      t('the worktree is cleaned up after integration', () => {
        assert.strictEqual(fs.existsSync(c.worktree), false);
      });
    })();

    await (async () => {
      const { h, d, m, c } = runOneChild();
      // user commits a conflicting change to the same file after approval
      fs.writeFileSync(path.join(d, 'app', 'a.js'), 'let rounds = 99;\n');
      execFileSync('git', ['commit', '-qam', 'user change'], { cwd: d });
      fs.writeFileSync(path.join(c.worktree, 'app', 'a.js'), 'let rounds = 2;\n');
      h.rt.onTurnEnd(h.clientSessions.get(c.roomKey), 'claude',
        '<<<CHILD_REPORT\n{"status":"done","summary":"bumped"}\nCHILD_REPORT>>>');
      await drain();
      t('a blocking conflict parks the child in awaiting-instructions, nothing landed', () => {
        const g = h.rt.graph(m);
        assert.strictEqual(g.children[0].state, 'awaiting-instructions');
        assert.strictEqual(fs.readFileSync(path.join(d, 'app', 'a.js'), 'utf8'), 'let rounds = 99;\n');
        assert.strictEqual(h.tasks[g.children[0].taskFile].status, 'new', 'task NOT completed');
      });
      t('awaiting holds a child slot but no engine seat', () => {
        const g = h.rt.graph(m);
        assert.strictEqual(g.slots.used, 1);
        assert.strictEqual(g.seats, 0);
      });
      t('the 15-minute timeout alerts Peter and frees the slot', () => {
        const g0 = h.rt.graph(m);
        h.rt.onAwaitTimeout(m, g0.children[0].cid);      // fire the timer directly
        const g = h.rt.graph(m);
        assert.strictEqual(g.children[0].state, 'timed-out');
        assert.strictEqual(g.slots.used, 0);
        assert.ok(h.tasks[g.children[0].taskFile].questions.length, 'Peter was asked');
      });
    })();

    await (async () => {
      const { h, d, m, c } = runOneChild();
      fs.writeFileSync(path.join(c.worktree, 'app', 'a.js'), 'ok\n');
      fs.writeFileSync(path.join(c.worktree, 'docs', 'sneak.md'), 'out of scope\n');
      h.rt.onTurnEnd(h.clientSessions.get(c.roomKey), 'claude',
        '<<<CHILD_REPORT\n{"status":"done","summary":"did extra"}\nCHILD_REPORT>>>');
      await drain();
      t('a scope violation fails the child and lands nothing', () => {
        const g = h.rt.graph(m);
        assert.strictEqual(g.children[0].state, 'failed');
        assert.strictEqual(fs.readFileSync(path.join(d, 'app', 'a.js'), 'utf8'), 'let rounds = 1;\n');
        assert.notStrictEqual(h.tasks[g.children[0].taskFile].status, 'done');
      });
    })();

    section('control ops');

    await (async () => {
      const { h, m, c } = runOneChild();
      const masterRoom = h.rt.roomForMaster(m);
      const S = h.clientSessions.get(masterRoom) || { key: masterRoom, orch: { role: 'master', masterId: m } };
      h.clientSessions.set(masterRoom, S); S.orch = { role: 'master', masterId: m };
      h.rt.onTurnEnd(S, 'claude', '<<<ORCH_CMD\n{"ops":[{"op":"cancel","cid":"' + c.cid + '"}]}\nORCH_CMD>>>');
      t('cancel before integration kills the child with nothing landed', () => {
        const g = h.rt.graph(m);
        assert.strictEqual(g.children[0].state, 'cancelled');
        assert.ok(h.killed.find(k => k.roomKey === c.roomKey));
        assert.strictEqual(g.slots.used, 0);
      });
      t('replaying the identical command is a server-side no-op', () => {
        const before = JSON.stringify(h.rt.graph(m).children[0]);
        h.rt.onTurnEnd(S, 'claude', '<<<ORCH_CMD\n{"ops":[{"op":"cancel","cid":"' + c.cid + '"}]}\nORCH_CMD>>>');
        assert.strictEqual(JSON.stringify(h.rt.graph(m).children[0]), before);
      });
    })();

    await (async () => {
      const { h, d, m, c } = runOneChild();
      fs.writeFileSync(path.join(c.worktree, 'app', 'a.js'), 'let rounds = 2;\n');
      h.rt.onTurnEnd(h.clientSessions.get(c.roomKey), 'claude',
        '<<<CHILD_REPORT\n{"status":"done","summary":"bumped"}\nCHILD_REPORT>>>');
      await drain();
      t('cancel after the ref update reports completion instead of cancelling', () => {
        h.rt.applyOps(m, [{ op: 'cancel', cid: c.cid }], 'ev-late');
        const rec = O.loadRecord(m);
        const led = Object.values(rec.opLedger).pop();
        assert.strictEqual(led.result, 'integration already completed');
        assert.strictEqual(h.rt.graph(m).children[0].state, 'done');
      });
      t('rejecting a report reopens the SAME child and un-completes the task', () => {
        h.rt.applyOps(m, [{ op: 'reject', cid: c.cid, text: 'not enough' }], 'ev-rej');
        const g = h.rt.graph(m);
        assert.strictEqual(g.children[0].state, 'running');
        assert.strictEqual(g.children.length, 1, 'no replacement task');
        assert.strictEqual(h.tasks[g.children[0].taskFile].status, 'in-progress');
        assert.ok(h.sent.some(s => s.roomKey === c.roomKey && s.text.includes('not enough')));
      });
    })();

    await (async () => {
      const { h, m, c } = runOneChild();
      h.rt.parkAll(m, 'master killed');
      t('killing the master parks children and frees their slots', () => {
        const g = h.rt.graph(m);
        assert.strictEqual(g.children[0].state, 'parked');
        assert.strictEqual(g.slots.used, 0);
        assert.strictEqual(g.status, 'parked');
      });
      t('parked children resume on demand', () => {
        const rec = O.loadRecord(m); rec.status = 'running'; O.saveRecord(rec);
        h.rt.applyOps(m, [{ op: 'resume', cid: c.cid }], 'ev-res');
        assert.strictEqual(h.rt.graph(m).children[0].state, 'running');
      });
    })();

    section('report validation');

    await (async () => {
      const { h, m, c } = runOneChild();
      const S = h.clientSessions.get(c.roomKey);
      h.rt.onTurnEnd(S, 'claude', '<<<CHILD_REPORT\n{"status":"finished"}\nCHILD_REPORT>>>');
      t('an invalid report triggers a retry, not acceptance', () => {
        assert.ok(h.sent.some(s => s.roomKey === c.roomKey && s.text.includes('invalid')));
        assert.strictEqual(h.rt.graph(m).children[0].state, 'running');
      });
      t('three invalid reports fail the child explicitly', () => {
        h.rt.onTurnEnd(S, 'claude', '<<<CHILD_REPORT\n{"status":"finished"}\nCHILD_REPORT>>>');
        h.rt.onTurnEnd(S, 'claude', '<<<CHILD_REPORT\n{"status":"finished"}\nCHILD_REPORT>>>');
        assert.strictEqual(h.rt.graph(m).children[0].state, 'failed');
      });
    })();

    // cleanup
    for (const mId of madeMasters) { try { fs.unlinkSync(O.recordFile(mId)); } catch (e) {} }
    try {
      const ix = O.loadIndex();
      for (const mId of madeMasters) { const rk = ix.masters[mId]; delete ix.masters[mId]; if (rk) delete ix.rooms[rk]; }
      O.saveIndex(ix);
    } catch (e) {}
    for (const r of repos) { try { fs.rmSync(r, { recursive: true, force: true }); } catch (e) {} }
    try { fs.rmSync(O.WORKTREE_ROOT, { recursive: true, force: true }); } catch (e) {}

    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  })();
})();
