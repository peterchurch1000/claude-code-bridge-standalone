#!/usr/bin/env node
'use strict';
// [ORCH_V1] Idempotent patcher: wires the orchestrator into bridge-server.js.
// Usage: node patch-orch.cjs <path-to-bridge-server.js> [--write]
// Without --write it reports what it would do and validates the result in memory.

const fs = require('fs');
const path = require('path');

const target = process.argv[2];
const doWrite = process.argv.includes('--write');
if (!target) { console.error('usage: patch-orch.cjs <bridge-server.js> [--write]'); process.exit(2); }

let src = fs.readFileSync(target, 'utf8');
const applied = [];
const skipped = [];

function patch(name, marker, find, replace) {
  if (src.includes(marker)) { skipped.push(name + ' (already present)'); return; }
  const idx = src.indexOf(find);
  if (idx === -1) throw new Error('anchor not found for ' + name);
  if (src.indexOf(find, idx + 1) !== -1) throw new Error('anchor is ambiguous for ' + name);
  src = src.slice(0, idx) + replace + src.slice(idx + find.length);
  applied.push(name);
}

// ── 1. Capture each turn's text for orchestrated rooms (Claude) ───────────────
patch('claude-accumulate', '[ORCH_V1] accumulate claude',
  `        if (S.conf && S.conf.status === 'running' && S.conf.activeTurnId) {   // [CONFERENCE_V1] capture this turn's text server-side`,
  `        if (S.orch) {   // [ORCH_V1] accumulate claude turn text for block parsing
          if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
            for (const b of ev.message.content) { if (b && b.type === 'text' && b.text) S._orchAcc = (S._orchAcc || '') + b.text + '\\n'; }
          } else if (ev.type === 'result' && typeof ev.result === 'string' && ev.result) { S._orchAcc = ev.result; }
        }
        if (S.conf && S.conf.status === 'running' && S.conf.activeTurnId) {   // [CONFERENCE_V1] capture this turn's text server-side`);

// ── 2. Claude turn end -> orchestrator ───────────────────────────────────────
patch('claude-turn-end', '[ORCH_V1] claude turn end',
  `            if (S.conf && S.conf.status === 'running' && S.conf.activeTurnId) { try { confFinishTurn(S, 'claude'); } catch (e) { console.log('[Bridge] [CONFERENCE_V1] finish(claude) failed:', e.message); } }`,
  `            if (S.conf && S.conf.status === 'running' && S.conf.activeTurnId) { try { confFinishTurn(S, 'claude'); } catch (e) { console.log('[Bridge] [CONFERENCE_V1] finish(claude) failed:', e.message); } }
            if (S.orch && global.__ORCH) { const _t = S._orchAcc || ''; S._orchAcc = ''; try { global.__ORCH.onTurnEnd(S, 'claude', _t); } catch (e) { console.log('[Bridge] [ORCH_V1] claude turn end failed:', e.message); } }`);

// ── 3. Codex stream accumulate + turn end ────────────────────────────────────
patch('codex-accumulate', '[ORCH_V1] accumulate codex',
  `          else if (m.kind === 'stream') { if (S.conf && S.conf.status === 'running' && S.conf.activeTurnId && m.data && m.data.type === 'assistant' && m.data.message) {`,
  `          else if (m.kind === 'stream') { if (S.orch && m.data && m.data.type === 'assistant' && m.data.message) { for (const b of (m.data.message.content || [])) { if (b && b.type === 'text' && b.text) S._orchAcc = (S._orchAcc || '') + b.text + '\\n'; } }   /* [ORCH_V1] accumulate codex */
            if (S.conf && S.conf.status === 'running' && S.conf.activeTurnId && m.data && m.data.type === 'assistant' && m.data.message) {`);

patch('codex-turn-end', '[ORCH_V1] codex turn end',
  `        if (S.conf && S.conf.status === 'running' && S.conf.activeTurnId) { try { confFinishTurn(S, 'codex'); } catch (e) { console.log('[Bridge] [CONFERENCE_V1] finish(codex) failed:', e.message); } }`,
  `        if (S.conf && S.conf.status === 'running' && S.conf.activeTurnId) { try { confFinishTurn(S, 'codex'); } catch (e) { console.log('[Bridge] [CONFERENCE_V1] finish(codex) failed:', e.message); } }
        if (S.orch && global.__ORCH) { const _t = S._orchAcc || ''; S._orchAcc = ''; try { global.__ORCH.onTurnEnd(S, 'codex', _t); } catch (e) { console.log('[Bridge] [ORCH_V1] codex turn end failed:', e.message); } }`);

// ── 4. Withhold the browser capability from children at spawn ────────────────
// Claude: skip the per-room playwright mcp-config entirely.
if (src.includes('[ORCH_V1 no-browser]')) {
  skipped.push('claude-no-browser (already present)');
} else {
  const before = src;
  src = src.replace(
    /(\n\s*)(try \{\n\s*fs\.writeFileSync\(mcpFile, JSON\.stringify\(\{ mcpServers: \{ playwright: \{ type: 'http', url: roomUrl \} \} \}\)\);)/g,
    (m, ws, body) => `${ws}/* [ORCH_V1 no-browser] children get no browser MCP */ if (!S.orchNoBrowser) ${body}`
  );
  if (src === before) throw new Error('anchor not found for claude-no-browser');
  applied.push('claude-no-browser');
}

patch('codex-no-browser', '[ORCH_V1] codex no-browser',
  `    if (_mcpUrl) { env.CODEX_BROWSER_MCP_URL = _mcpUrl; env.PATH = '/usr/local/bin:' + (env.PATH || ''); }`,
  `    if (_mcpUrl && !S.orchNoBrowser) { env.CODEX_BROWSER_MCP_URL = _mcpUrl; env.PATH = '/usr/local/bin:' + (env.PATH || ''); }   // [ORCH_V1] codex no-browser: capability withheld at spawn`);

// ── 5. Deleting a master room parks its children ─────────────────────────────
patch('park-on-delete', '[ORCH_V1] park on delete',
  `    if (room) { try { room.killCurrentProc('session deleted'); } catch {} clientSessions.delete(id); clearRoom(id); }   // [CODEX_DURABLE_V2]`,
  `    if (room) { try { room.killCurrentProc('session deleted'); } catch {} clientSessions.delete(id); clearRoom(id); }   // [CODEX_DURABLE_V2]
    try { if (global.__ORCH) { const _mid = global.__ORCH.masterIdForRoom(id); if (_mid) global.__ORCH.parkAll(_mid, 'master room deleted'); } } catch (e) { console.log('[Bridge] [ORCH_V1] park on delete failed:', e.message); }`);

// ── 6. Attach the runtime (end of file: every dep is defined by now) ─────────
const ATTACH = `
// ── [ORCH_V1] Master-room orchestration ───────────────────────────────────────
// Children run in isolated git worktrees, report through a validated block, and are
// integrated under a serialized lock. Requires a clean git workspace (hard stop).
try {
  const _orchRT = require('./orch-runtime');
  const _execFileSync = require('child_process').execFileSync;
  const _taskCall = (method, urlPath, body) => {
    const jwt = bridgeTaskJwt();
    if (!jwt) throw new Error('no bridge task jwt');
    const args = ['-s', '-X', method, BRIDGE_TASK_API + urlPath, '-H', 'Authorization: Bearer ' + jwt];
    if (body) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
    const out = _execFileSync('curl', args, { encoding: 'utf8', timeout: 15000 });
    try { return JSON.parse(out); } catch (e) { return {}; }
  };
  global.__ORCH = _orchRT.attach({
    app, clientSessions, makeSession, restoreRoom, confStart,
    sendToEngine: (S, text) => S.sendToClaude(text),
    killRoom: (S, reason) => { try { S.killCurrentProc(reason); } catch (e) {} },
    taskApi: {
      create: (t) => _taskCall('POST', '', { title: t.title, description: t.description }),
      setStatus: (file, status) => _taskCall('POST', '/' + file + '/status', { status }),
      addProgress: (file, text) => _taskCall('POST', '/' + file + '/progress', { text }),
      addQuestion: (file, question) => _taskCall('POST', '/' + file + '/questions', { question }),
      linkRoom: (file, roomKey, label) => _taskCall('POST', '/' + file + '/rooms', { room_key: roomKey, label }),
    },
    log: (m) => console.log('[Bridge] ' + m),
  });
  setTimeout(() => { try { global.__ORCH.recoverAll(); } catch (e) { console.log('[Bridge] [ORCH_V1] recovery failed:', e.message); } }, 1800);
  console.log('[Bridge] [ORCH_V1] orchestration attached');
} catch (e) {
  console.log('[Bridge] [ORCH_V1] attach failed (orchestration disabled):', e.message);
}
`;
if (!src.includes('[ORCH_V1] orchestration attached')) { src += ATTACH; applied.push('attach-runtime'); }
else skipped.push('attach-runtime (already present)');

// ── validate ─────────────────────────────────────────────────────────────────
const tmp = path.join(require('os').tmpdir(), 'orch-patched-' + process.pid + '.js');
fs.writeFileSync(tmp, src);
try {
  require('child_process').execFileSync('node', ['--check', tmp], { stdio: 'pipe' });
} catch (e) {
  console.error('SYNTAX CHECK FAILED — not writing.\n' + (e.stderr || '').toString());
  process.exit(1);
}
fs.unlinkSync(tmp);

console.log('applied: ' + (applied.join(', ') || 'none'));
console.log('skipped: ' + (skipped.join(', ') || 'none'));
if (doWrite) {
  const bak = target + '.bak-orch-' + Date.now();
  fs.copyFileSync(target, bak);
  fs.writeFileSync(target, src);
  console.log('written (backup: ' + bak + ')');
} else {
  console.log('dry run OK (syntax valid) — pass --write to apply');
}
