'use strict';
// [ORCH_V1] Runtime: master/child lifecycle, scheduler, durable inbox/outbox,
// integration under a serialized lock, and the /orch/v1 HTTP surface.
//
// attach(deps) is the ONLY entry point the bridge calls, so bridge-server.js needs
// just a handful of added lines. deps are injected (never imported) so the whole
// runtime is testable against stubs.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const O = require('./orch');

const CHILD_REPORT_CONTRACT = [
  'When — and only when — your brief is complete (or you must stop), end your reply with:',
  '<<<CHILD_REPORT',
  '{"status":"done|blocked|failed|awaiting-instructions","summary":"...","files_changed":[],"misses_and_fixes":[],"open_questions":[]}',
  'CHILD_REPORT>>>',
  'Nothing after that block.',
].join('\n');

function briefText(child, wtPath) {
  return [
    '# Sub-task: ' + child.title,
    '',
    '## Objective',
    child.brief,
    '',
    '## Definition of done',
    child.done_definition,
    '',
    '## Your workspace (work ONLY here, by absolute path)',
    wtPath,
    '',
    '## Declared file scope (anything outside is a scope violation)',
    (child.files || []).map(f => '- ' + f).join('\n'),
    '',
    '## Scope discipline — hard rule',
    'Work autonomously inside this brief. If you discover something OUT OF SCOPE, do not',
    'attempt to fix it: finish your in-scope work, list it under misses_and_fixes, and end.',
    'If you discover a CONFLICT that makes safe completion impossible, make no further',
    'writes, report status "awaiting-instructions" with the conflict, and stop.',
    'Never send email, change calendars, or take outward-facing actions. You have no browser.',
    '',
    '## Reporting',
    CHILD_REPORT_CONTRACT,
  ].join('\n');
}

function masterGuidance() {
  return [
    'You are a MASTER room. You do not do sub-task work yourself; you decompose and delegate.',
    'Propose work with a plan block (the user reviews and approves it before anything spawns):',
    '<<<ORCH_PLAN',
    '{"subtasks":[{"title":"...","brief":"...","done_definition":"...","mode":"solo|conference","files":["app/**"],"needs_browser":false}]}',
    'ORCH_PLAN>>>',
    'mode: "solo" for one aspect / one or two edits; "conference" when it touches more than one aspect.',
    'Scopes of subtasks that may run together MUST NOT overlap.',
    'Control running children with:',
    '<<<ORCH_CMD',
    '{"ops":[{"op":"message|cancel|reject|close|park|resume","cid":"...","text":"..."}]}',
    'ORCH_CMD>>>',
  ].join('\n');
}

function attach(deps) {
  const {
    app,                 // express app
    clientSessions,      // Map roomKey -> session
    makeSession,         // (key) => S
    restoreRoom,         // (S) => void
    confStart,           // (S, brief, opts) => void
    sendToEngine,        // (S, text) => void
    killRoom,            // (S, reason) => void
    taskApi,             // {create, setStatus, addProgress, addQuestion, linkRoom}
    log = () => {},
  } = deps;

  const timers = new Map();          // cid -> await timeout handle
  let integrationLock = Promise.resolve();   // serializes ALL integrations

  // ── record helpers ─────────────────────────────────────────────────────────
  function masterIdForRoom(roomKey) {
    const ix = O.loadIndex();
    return ix.rooms[roomKey] || null;
  }
  function bind(masterId, roomKey) {
    const ix = O.loadIndex();
    ix.masters[masterId] = roomKey;
    ix.rooms[roomKey] = masterId;
    O.saveIndex(ix);
  }
  function roomForMaster(masterId) {
    const ix = O.loadIndex();
    return ix.masters[masterId] || null;
  }
  function session(roomKey) {
    let S = clientSessions.get(roomKey);
    if (!S) { S = makeSession(roomKey); restoreRoom(S); clientSessions.set(roomKey, S); }
    return S;
  }

  // ── designation ────────────────────────────────────────────────────────────
  function designate(roomKey, repo) {
    const pre = O.preflight(repo);
    if (!pre.ok) return { ok: false, ...pre };       // hard stop: no repo / dirty tree
    let masterId = masterIdForRoom(roomKey);
    let rec = masterId ? O.loadRecord(masterId) : null;
    if (!rec) {
      masterId = 'm-' + crypto.randomBytes(8).toString('hex');
      rec = O.newRecord(masterId, roomKey, repo);
      O.saveRecord(rec);
      bind(masterId, roomKey);
    } else if (rec.roomKey !== roomKey) {            // room was rekeyed — rebind by masterId
      rec.roomKey = roomKey; O.saveRecord(rec); bind(masterId, roomKey);
    }
    return { ok: true, masterId, targetRef: pre.targetRef, graphRev: rec.graphRev };
  }

  // ── plan submit / edit / approve ───────────────────────────────────────────
  function submitPlan(masterId, planJson) {
    const rec = O.loadRecord(masterId);
    if (!rec) return { ok: false, error: 'unknown master' };
    const errs = O.validatePlan(planJson);
    if (errs.length) return { ok: false, error: 'invalid plan', details: errs };

    const subtasks = planJson.subtasks.map((s, i) => ({
      cid: 'c' + (i + 1), title: s.title, brief: s.brief, done_definition: s.done_definition,
      mode: s.mode, files: s.files, needs_browser: !!s.needs_browser,
      budget: Object.assign({}, O.DEFAULT_BUDGET, s.budget || {}),
    }));
    // Conservative overlap rejection: these may run together, so scopes must be disjoint.
    for (let i = 0; i < subtasks.length; i++) {
      for (let j = i + 1; j < subtasks.length; j++) {
        if (O.globsOverlap(subtasks[i].files, subtasks[j].files)) {
          return { ok: false, error: 'overlapping scopes',
            details: [subtasks[i].title + ' and ' + subtasks[j].title + ' share files'] };
        }
      }
    }
    rec.planRev = (rec.planRev || 0) + 1;
    rec.plan = { planId: 'p-' + crypto.randomBytes(6).toString('hex'), planRev: rec.planRev, subtasks, approvedAt: null };
    rec.status = 'planning';
    O.saveRecord(rec);
    return { ok: true, plan: rec.plan, graphRev: rec.graphRev };
  }

  function editPlan(masterId, planId, subtasks) {
    const rec = O.loadRecord(masterId);
    if (!rec || !rec.plan || rec.plan.planId !== planId) return { ok: false, error: 'unknown plan' };
    if (rec.plan.approvedAt) return { ok: false, error: 'plan already approved' };
    const errs = O.validatePlan({ subtasks });
    if (errs.length) return { ok: false, error: 'invalid plan', details: errs };
    rec.plan.subtasks = subtasks.map((s, i) => Object.assign({ cid: 'c' + (i + 1) }, s,
      { budget: Object.assign({}, O.DEFAULT_BUDGET, s.budget || {}) }));
    rec.planRev = (rec.planRev || 0) + 1;
    rec.plan.planRev = rec.planRev;
    O.saveRecord(rec);
    return { ok: true, plan: rec.plan, graphRev: rec.graphRev };
  }

  // Approval + clean-worktree check + spawn preparation happen in ONE synchronous
  // step, so nothing can dirty the tree between the check and the worktree creation.
  function approvePlan(masterId, planId, planRev) {
    const rec = O.loadRecord(masterId);
    if (!rec || !rec.plan || rec.plan.planId !== planId) return { ok: false, error: 'unknown plan' };
    if (rec.plan.approvedAt) return { ok: false, error: 'already approved' };
    if (Number(planRev) !== Number(rec.plan.planRev)) {
      return { ok: false, code: 'stale-plan-rev', error: 'plan revision is stale', expected: rec.plan.planRev };
    }
    const pre = O.preflight(rec.repo);
    if (!pre.ok) return { ok: false, ...pre };

    rec.targetRef = pre.targetRef;
    rec.baseCommit = pre.baseCommit;
    rec.plan.approvedAt = Date.now();
    rec.status = 'running';

    for (const s of rec.plan.subtasks) {
      const child = Object.assign({}, s, {
        state: 'queued', approvedAt: rec.plan.approvedAt, baseCommit: pre.baseCommit,
        branch: 'orch/' + rec.masterId + '/' + s.cid,
        worktree: path.join(O.WORKTREE_ROOT, rec.masterId, s.cid),
        roomKey: 'orch-' + rec.masterId.slice(2, 10) + '-' + s.cid,
        taskFile: null, report: null, integration: null, queueReason: null,
      });
      rec.children.push(child);
    }
    O.saveRecord(rec);
    pump(rec.masterId);
    return { ok: true, graphRev: O.loadRecord(masterId).graphRev };
  }

  // ── scheduler ──────────────────────────────────────────────────────────────
  function browserLeaseFree(rec, cid) {
    return !rec.browserLeaseCid || rec.browserLeaseCid === cid;
  }
  function globalBrowserHolder() {
    // Bridge-global: one process owns every master, so scanning records IS global.
    let holder = null;
    try {
      for (const f of fs.readdirSync(O.ORCH_DIR).filter(x => x.endsWith('.json') && x !== 'index.json')) {
        const r = JSON.parse(fs.readFileSync(path.join(O.ORCH_DIR, f), 'utf8'));
        if (r && r.browserLeaseCid) holder = { masterId: r.masterId, cid: r.browserLeaseCid };
      }
    } catch (e) {}
    return holder;
  }

  function pump(masterId) {
    const rec = O.loadRecord(masterId);
    if (!rec || rec.status === 'parked') return;
    let changed = false;
    for (const c of rec.children) {
      if (c.state !== 'queued') continue;
      if (O.countSlots(rec) >= (rec.concurrency || O.MAX_CHILD_SLOTS)) { c.queueReason = 'child slots full'; changed = true; continue; }
      if (c.needs_browser) {
        const holder = globalBrowserHolder();
        if (holder && holder.cid !== c.cid) { c.queueReason = 'waiting for the browser lease'; changed = true; continue; }
      }
      spawnChild(rec, c);
      changed = true;
    }
    if (changed) O.saveRecord(rec);
  }

  // ── child spawn ────────────────────────────────────────────────────────────
  // Idempotent: a re-spawn (recovery, reject/reopen) reuses the child's existing
  // branch instead of trying to create it again.
  function ensureWorktree(rec, c) {
    if (fs.existsSync(path.join(c.worktree, '.git'))) return true;
    const branchExists = (() => {
      try { O.git(rec.repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + c.branch]); return true; }
      catch (e) { return false; }
    })();
    try {
      if (branchExists) O.git(rec.repo, ['worktree', 'add', '--force', c.worktree, c.branch]);
      else O.worktreeAdd(rec.repo, c.worktree, c.branch, c.baseCommit);
      return true;
    } catch (e) {
      c.state = 'failed'; c.failure = 'worktree: ' + e.message;
      return false;
    }
  }

  function spawnChild(rec, c) {
    c.state = 'spawning';
    if (!ensureWorktree(rec, c)) return;
    if (!c.taskFile) {
      const t = taskApi.create({ title: c.title, description: c.done_definition + '\n\n' + c.brief });
      if (t && t.file) { c.taskFile = t.file; c.taskShortId = t.id || null; }
    }
    if (c.taskFile) { try { taskApi.linkRoom(c.taskFile, c.roomKey, c.title); } catch (e) {} }
    if (c.needs_browser) { rec.browserLeaseCid = c.cid; }

    const S = session(c.roomKey);
    S.orch = { role: 'child', masterId: rec.masterId, cid: c.cid };
    S.orchNoBrowser = !c.needs_browser;     // capability withheld at spawn
    const text = briefText(c, c.worktree);
    c.startedAt = Date.now();
    c.state = 'running';
    if (c.mode === 'conference') {
      const task = c.taskFile ? { id: c.taskShortId, file: c.taskFile, title: c.title } : null;
      confStart(S, text + '\n\n' + CHILD_REPORT_CONTRACT, { task });
    } else {
      sendToEngine(S, text);
    }
    log('[ORCH_V1] spawned child ' + c.cid + ' (' + c.mode + ') room=' + c.roomKey);
  }

  // ── turn end: parse blocks ────────────────────────────────────────────────
  function onTurnEnd(S, engine, text) {
    const o = S && S.orch;
    if (!o) return false;
    if (o.role === 'master') return onMasterTurn(S, text);
    if (o.role === 'child') return onChildTurn(S, text);
    return false;
  }

  function onMasterTurn(S, text) {
    const rec = O.loadRecord(S.orch.masterId);
    if (!rec) return false;
    const causal = (rec.outbox.find(e => e.state === 'dispatched') || {}).eventId || null;
    let acted = false;

    const plan = O.extractBlock(text, 'ORCH_PLAN');
    if (plan.found && plan.json) {
      const r = submitPlan(rec.masterId, plan.json);
      if (!r.ok) sendToEngine(S, 'ORCH: plan rejected (' + r.error + '): ' + (r.details || []).join('; ') + '\nRe-emit a corrected ORCH_PLAN.');
      acted = true;
    }
    const cmd = O.extractBlock(text, 'ORCH_CMD');
    if (cmd.found && cmd.json) {
      const errs = O.validateCmd(cmd.json);
      if (errs.length) { sendToEngine(S, 'ORCH: command rejected: ' + errs.join('; ')); return true; }
      applyOps(rec.masterId, cmd.json.ops, causal);
      acted = true;
    }
    if (causal) ackEvent(rec.masterId, causal);
    return acted;
  }

  // Server-side dedup: identical (causalEvent, planRev, payload) => identical opId =>
  // ledger hit => no second task, room or integration.
  function applyOps(masterId, ops, causalEventId) {
    const rec = O.loadRecord(masterId);
    if (!rec) return;
    for (const op of ops) {
      const opId = O.opIdFor(causalEventId, rec.planRev, op);
      if (rec.opLedger[opId]) continue;                     // replay → no-op
      const c = op.cid ? O.childById(rec, op.cid) : null;
      let result = 'ignored';
      if (op.op !== 'spawn' && !c) result = 'unknown cid';
      else {
        switch (op.op) {
          case 'message': if (!O.TERMINAL_STATES.includes(c.state)) { sendToEngine(session(c.roomKey), op.text); result = 'sent'; } break;
          case 'cancel':  result = cancelChild(rec, c, 'master cancel'); break;
          case 'park':    result = parkChild(rec, c); break;
          case 'resume':  result = resumeChild(rec, c); break;
          case 'reject':  result = rejectChild(rec, c, op.text); break;
          case 'close':   c.state = 'closed'; releaseResources(rec, c); result = 'closed'; break;
          default: result = 'unsupported';
        }
      }
      rec.opLedger[opId] = { op: op.op, cid: op.cid || null, result, ts: Date.now() };
    }
    O.saveRecord(rec);
    pump(masterId);
  }

  function ackEvent(masterId, eventId) {
    const rec = O.loadRecord(masterId);
    if (!rec) return;
    const ev = rec.outbox.find(e => e.eventId === eventId);
    if (ev) ev.state = 'acked';
    rec.processedEvents[eventId] = true;
    rec.outbox = rec.outbox.filter(e => e.state !== 'acked');
    O.saveRecord(rec);
  }

  // ── child turn / report ────────────────────────────────────────────────────
  function onChildTurn(S, text) {
    const { masterId, cid } = S.orch;
    const rec = O.loadRecord(masterId);
    if (!rec) return false;
    const c = O.childById(rec, cid);
    if (!c || O.TERMINAL_STATES.includes(c.state)) return false;

    const blk = O.extractBlock(text, 'CHILD_REPORT');
    if (!blk.found) {
      c.turns = (c.turns || 0) + 1;
      if (c.turns >= (c.budget.maxTurns || O.DEFAULT_BUDGET.maxTurns)) {
        c.state = 'failed'; c.failure = 'turn budget exhausted without a report';
        finishChild(rec, c, { status: 'failed', summary: c.failure });
      } else { O.saveRecord(rec); }
      return false;
    }
    if (blk.error || O.validateReport(blk.json).length) {
      c.reportRetries = (c.reportRetries || 0) + 1;
      O.saveRecord(rec);
      if (c.reportRetries <= 2) {
        sendToEngine(S, 'ORCH: your CHILD_REPORT was invalid (' + (blk.error || O.validateReport(blk.json).join('; ')) +
                        '). Re-emit ONLY a valid CHILD_REPORT block.');
        return true;
      }
      c.state = 'failed'; c.failure = 'no valid report after retries';
      finishChild(rec, c, { status: 'failed', summary: c.failure });
      return true;
    }
    const report = blk.json;
    report.reportId = report.reportId || ('r-' + crypto.randomBytes(6).toString('hex'));
    if (c.report && c.report.reportId) return true;          // exactly one canonical report
    c.report = report;
    c.state = 'reporting';
    O.saveRecord(rec);

    if (report.status === 'awaiting-instructions') { enterAwaiting(rec.masterId, c.cid, report); return true; }
    if (report.status !== 'done') { finishChild(rec, c, report); return true; }

    // done → scope check, then serialized integration
    integrationLock = integrationLock.then(() => doIntegrate(rec.masterId, c.cid)).catch(e => log('[ORCH_V1] integrate error ' + e.message));
    return true;
  }

  function doIntegrate(masterId, cid) {
    const rec = O.loadRecord(masterId);
    const c = O.childById(rec, cid);
    if (!c || c.state !== 'reporting') return;
    c.state = 'integrating'; O.saveRecord(rec);

    const violations = O.scopeViolations(c.worktree, c.baseCommit, c.files);
    if (violations.length) {
      // Mutate the SAME record instance that finishChild persists — never a second load.
      c.failure = 'scope violation: ' + violations.join(', ');
      return finishChild(rec, c, Object.assign({}, c.report, { status: 'failed', summary: c.failure }));
    }
    let res;
    try {
      res = O.integrate(rec.repo, c.worktree, {
        targetRef: rec.targetRef, baseCommit: c.baseCommit, globs: c.files,
        masterId, cid, reportId: c.report.reportId,
      });
    } catch (e) { res = { ok: false, error: e.message, conflict: [] }; }

    const rec2 = O.loadRecord(masterId);
    const c2 = O.childById(rec2, cid);
    if (!res.ok) {
      c2.state = 'awaiting-instructions';
      c2.conflict = res.conflict || [];
      c2.awaitingSince = Date.now();
      O.saveRecord(rec2);
      armAwaitTimer(masterId, cid);
      emit(masterId, 'child_conflict', { cid, conflict: c2.conflict, summary: c2.report.summary });
      return;
    }
    c2.integration = { commit: res.commit || null, empty: !!res.empty, at: Date.now() };
    finishChild(rec2, c2, c2.report);
  }

  function finishChild(rec, c, report) {
    const ok = report.status === 'done' && !c.failure;
    c.state = ok ? 'done' : (c.state === 'cancelled' ? 'cancelled' : 'failed');
    c.finishedAt = Date.now();
    releaseResources(rec, c);
    O.saveRecord(rec);
    if (c.taskFile) {
      try {
        taskApi.addProgress(c.taskFile, renderReport(c, report));
        if (ok) taskApi.setStatus(c.taskFile, 'done');
      } catch (e) { log('[ORCH_V1] task update failed: ' + e.message); }
    }
    writeMissesAndFixes(rec, c, report);
    try { O.worktreeRemove(rec.repo, c.worktree); } catch (e) {}
    emit(rec.masterId, 'child_report', { cid: c.cid, status: c.state, report });
  }

  function renderReport(c, report) {
    return ['[' + c.cid + '] ' + c.title + ' — ' + report.status, report.summary,
      (report.files_changed || []).length ? 'Files: ' + report.files_changed.join(', ') : '',
      (report.open_questions || []).length ? 'Questions: ' + report.open_questions.join(' | ') : '',
    ].filter(Boolean).join('\n');
  }

  // Only the orchestrator writes this file — children never append (no corruption,
  // no duplication).
  function writeMissesAndFixes(rec, c, report) {
    const items = report.misses_and_fixes || [];
    if (!items.length) return;
    const file = path.join(rec.repo, 'MISSES-AND-FIXES.md');
    const when = new Date(Date.now()).toISOString().slice(0, 10);
    const body = ['', '## ' + when + ' — ' + c.title + ' (' + c.cid + (c.taskShortId ? ', task ' + c.taskShortId : '') + ')',
      ...items.map(i => '- ' + (typeof i === 'string' ? i : JSON.stringify(i))), ''].join('\n');
    try { fs.appendFileSync(file, body); } catch (e) { log('[ORCH_V1] misses-and-fixes write failed: ' + e.message); }
  }

  function releaseResources(rec, c) {
    if (rec.browserLeaseCid === c.cid) rec.browserLeaseCid = null;   // every termination path
    const tm = timers.get(c.cid);
    if (tm) { clearTimeout(tm); timers.delete(c.cid); }
  }

  // ── awaiting-instructions + 15-min timeout ────────────────────────────────
  function enterAwaiting(masterId, cid, report) {
    const rec = O.loadRecord(masterId);
    const c = O.childById(rec, cid);
    c.state = 'awaiting-instructions';
    c.awaitingSince = Date.now();
    O.saveRecord(rec);
    armAwaitTimer(masterId, cid);
    emit(masterId, 'child_awaiting', { cid, summary: report.summary, questions: report.open_questions || [] });
  }

  function armAwaitTimer(masterId, cid) {
    const rec = O.loadRecord(masterId);
    const c = O.childById(rec, cid);
    if (!c) return;
    const waited = Date.now() - (c.awaitingSince || Date.now());
    const left = Math.max(0, (rec.awaitTimeoutMs || O.DEFAULT_AWAIT_TIMEOUT_MS) - waited);
    const old = timers.get(cid);
    if (old) clearTimeout(old);
    const h = setTimeout(() => onAwaitTimeout(masterId, cid), left);
    if (h.unref) h.unref();
    timers.set(cid, h);
  }

  function onAwaitTimeout(masterId, cid) {
    const rec = O.loadRecord(masterId);
    const c = O.childById(rec, cid);
    if (!c || c.state !== 'awaiting-instructions') return;
    c.state = 'timed-out';
    c.finishedAt = Date.now();
    releaseResources(rec, c);
    O.saveRecord(rec);
    try { killRoom(session(c.roomKey), 'orch await timeout'); } catch (e) {}
    if (c.taskFile) {
      try {
        taskApi.addQuestion(c.taskFile,
          'Sub-task "' + c.title + '" waited 15 minutes for direction and stopped. ' +
          (c.conflict && c.conflict.length ? 'Conflict on: ' + c.conflict.join(', ') + '. ' : '') +
          'How should it proceed?');
      } catch (e) {}
    }
    emit(masterId, 'child_timed_out', { cid, conflict: c.conflict || [] });
    pump(masterId);
  }

  // ── cancel / park / resume / reject ───────────────────────────────────────
  // Linearization: the integration ref-update is the single boundary. Observed
  // before it => cancelled, nothing landed. After it => already done.
  function cancelChild(rec, c, reason) {
    if (c.state === 'done' || c.integration) return 'integration already completed';
    if (O.TERMINAL_STATES.includes(c.state)) return 'already ' + c.state;
    c.state = 'cancelled';
    c.finishedAt = Date.now();
    releaseResources(rec, c);
    try { killRoom(session(c.roomKey), reason); } catch (e) {}
    try { O.worktreeRemove(rec.repo, c.worktree); } catch (e) {}
    return 'cancelled';
  }

  function parkChild(rec, c) {
    if (O.TERMINAL_STATES.includes(c.state)) return 'already ' + c.state;
    if (c.state === 'integrating') return 'integrating — not parked';
    c.state = 'parked';
    releaseResources(rec, c);                      // frees slot + browser lease
    try { killRoom(session(c.roomKey), 'orch park'); } catch (e) {}
    return 'parked';                               // branch + session preserved
  }

  function resumeChild(rec, c) {
    if (c.state !== 'parked' && c.state !== 'timed-out') return 'not parked';
    c.state = 'queued';
    c.queueReason = null;
    return 'queued';
  }

  function rejectChild(rec, c, feedback) {
    if (!['done', 'failed', 'reporting'].includes(c.state)) return 'not reportable';
    c.state = 'running';                            // SAME child reopens (user's choice B=a)
    c.report = null;
    c.rejections = (c.rejections || 0) + 1;
    if (c.taskFile) { try { taskApi.setStatus(c.taskFile, 'in-progress'); } catch (e) {} }
    ensureWorktree(rec, c);
    sendToEngine(session(c.roomKey), 'ORCH: your report was rejected. Feedback:\n' + feedback + '\n\n' + CHILD_REPORT_CONTRACT);
    return 'reopened';
  }

  function parkAll(masterId, reason) {
    const rec = O.loadRecord(masterId);
    if (!rec) return;
    for (const c of rec.children) if (!O.TERMINAL_STATES.includes(c.state) && c.state !== 'parked') parkChild(rec, c);
    rec.status = 'parked';
    O.saveRecord(rec);
    log('[ORCH_V1] parked all children of ' + masterId + ' (' + reason + ')');
  }

  // ── delivery to the master ────────────────────────────────────────────────
  function emit(masterId, kind, payload) {
    const rec = O.loadRecord(masterId);
    if (!rec) return;
    const ev = O.pushEvent(rec, kind, payload);
    O.saveRecord(rec);                               // persisted BEFORE dispatch
    deliver(masterId);
    return ev;
  }

  // A report never sits unread: pending events auto-schedule a master turn.
  function deliver(masterId) {
    const rec = O.loadRecord(masterId);
    if (!rec || rec.status === 'parked') return;
    const roomKey = roomForMaster(masterId);
    if (!roomKey) return;
    const S = session(roomKey);
    if (S.processing) return;                        // retried when the turn ends
    const pending = rec.outbox.filter(e => e.state === 'pending');
    if (!pending.length) return;
    for (const e of pending) e.state = 'dispatched';
    O.saveRecord(rec);
    const body = pending.map(e => '- [' + e.eventId + '] ' + e.kind + ': ' + JSON.stringify(e.payload)).join('\n');
    sendToEngine(S, 'ORCH updates from your children:\n' + body +
      '\n\nRespond with an ORCH_CMD block if action is needed, or acknowledge briefly.');
  }

  // ── recovery on boot ──────────────────────────────────────────────────────
  function recoverAll() {
    let files = [];
    try { files = fs.readdirSync(O.ORCH_DIR).filter(f => f.endsWith('.json') && f !== 'index.json'); } catch (e) { return; }
    for (const f of files) {
      const rec = O.loadRecord(f.replace(/\.json$/, ''));
      if (!rec) continue;
      let dirty = false;
      for (const c of rec.children) {
        if (c.state === 'spawning') { c.state = 'queued'; dirty = true; }             // re-prepare idempotently
        else if (c.state === 'integrating') {                                          // did it land?
          const commit = O.alreadyIntegrated(rec.repo, rec.targetRef, rec.masterId, c.cid, (c.report || {}).reportId || '');
          if (commit) { c.integration = { commit, at: Date.now() }; c.state = 'done'; }
          else c.state = 'reporting';
          dirty = true;
        } else if (c.state === 'running' && !clientSessions.get(c.roomKey)) { c.state = 'parked'; dirty = true; }
        else if (c.state === 'awaiting-instructions') armAwaitTimer(rec.masterId, c.cid);
      }
      if (dirty) O.saveRecord(rec);
      for (const c of rec.children) if (c.state === 'reporting') doIntegrate(rec.masterId, c.cid);
      deliver(rec.masterId);                                                           // redeliver pending
      pump(rec.masterId);
    }
  }

  // ── HTTP surface (/orch/v1) ───────────────────────────────────────────────
  function graph(masterId) {
    const rec = O.loadRecord(masterId);
    if (!rec) return null;
    return {
      masterId: rec.masterId, roomKey: rec.roomKey, repo: rec.repo, status: rec.status,
      graphRev: rec.graphRev, targetRef: rec.targetRef || null, planRev: rec.planRev,
      plan: rec.plan, browserLeaseCid: rec.browserLeaseCid,
      slots: { used: O.countSlots(rec), max: rec.concurrency }, seats: O.countSeats(rec),
      children: rec.children.map(c => ({
        cid: c.cid, title: c.title, mode: c.mode, state: c.state, files: c.files,
        roomKey: c.roomKey, taskFile: c.taskFile, queueReason: c.queueReason || null,
        conflict: c.conflict || [], report: c.report || null, integration: c.integration || null,
        startedAt: c.startedAt || null, finishedAt: c.finishedAt || null, awaitingSince: c.awaitingSince || null,
      })),
      pendingEvents: rec.outbox.filter(e => e.state !== 'acked').length,
    };
  }

  if (app) {
    const guard = (req, res, next) => {
      const rec = req.params.masterId ? O.loadRecord(req.params.masterId) : null;
      if (req.params.masterId && !rec) return res.status(404).json({ error: 'unknown master' });
      const want = req.get('If-Match');
      if (want && rec && String(rec.graphRev) !== String(want)) {
        return res.status(409).json({ error: 'stale graphRev', graphRev: rec.graphRev });
      }
      req.orchRec = rec; next();
    };

    app.post('/orch/v1/masters', (req, res) => {
      const { roomKey, repo } = req.body || {};
      if (!roomKey || !repo) return res.status(400).json({ error: 'roomKey and repo required' });
      const r = designate(String(roomKey), String(repo));
      if (!r.ok) return res.status(412).json(r);         // 412: precondition (git / clean)
      const S = session(String(roomKey));
      S.orch = { role: 'master', masterId: r.masterId };
      sendToEngine(S, masterGuidance());
      res.json(r);
    });

    app.get('/orch/v1/graph/:masterId', guard, (req, res) => {
      const g = graph(req.params.masterId);
      return g ? res.json(g) : res.status(404).json({ error: 'unknown master' });
    });

    // Lookup for the UI: which master (if any) owns this room?
    app.get('/orch/v1/room/:roomKey', (req, res) => {
      const masterId = masterIdForRoom(req.params.roomKey);
      if (!masterId) return res.json({ masterId: null });
      res.json({ masterId, graph: graph(masterId) });
    });

    app.post('/orch/v1/plans/:masterId', guard, (req, res) => {
      const r = submitPlan(req.params.masterId, req.body || {});
      res.status(r.ok ? 200 : 400).json(r);
    });

    app.patch('/orch/v1/plans/:masterId/:planId', guard, (req, res) => {
      const r = editPlan(req.params.masterId, req.params.planId, (req.body || {}).subtasks || []);
      res.status(r.ok ? 200 : 400).json(r);
    });

    app.post('/orch/v1/plans/:masterId/:planId/approve', guard, (req, res) => {
      const r = approvePlan(req.params.masterId, req.params.planId, (req.body || {}).planRev);
      res.status(r.ok ? 200 : (r.code === 'stale-plan-rev' ? 409 : 412)).json(r);
    });

    for (const op of ['cancel', 'park', 'resume', 'reject', 'message', 'close']) {
      app.post('/orch/v1/children/:masterId/:cid/' + op, guard, (req, res) => {
        applyOps(req.params.masterId, [{ op, cid: req.params.cid, text: (req.body || {}).text || '' }],
                 'ui-' + Date.now());
        res.json({ ok: true, graph: graph(req.params.masterId) });
      });
    }
  }

  return {
    designate, submitPlan, editPlan, approvePlan, applyOps, onTurnEnd, deliver, emit,
    graph, pump, parkAll, recoverAll, onAwaitTimeout, armAwaitTimer, doIntegrate,
    masterIdForRoom, roomForMaster, _timers: timers,
  };
}

module.exports = { attach, briefText, masterGuidance, CHILD_REPORT_CONTRACT };
