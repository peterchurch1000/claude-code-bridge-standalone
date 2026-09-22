#!/usr/bin/env node
/* [CRED_401_HEAL_V3] End-to-end tests against a REAL bridge-server.js process.
 *
 * Proves the asynchronous sequence that predicate tests cannot:
 *   detect 401 -> suppress the synthetic bubble -> wait for a CHANGED credential ->
 *   respawn -> replay exactly once -> complete normally.
 *
 * Isolation: the bridge runs with HOME=<fixture>, a mock credential-steward and a mock
 * `claude` on PATH. No shared Procyss credential is read or written.
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const { spawn } = require('child_process');

const REPO = process.env.REPO || '/var/www/html/claude-code-bridge-standalone';
const TESTS = __dirname;
const PORT = Number(process.env.E2E_PORT || 3999);
const WS = require(path.join(REPO, 'node_modules', 'ws'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('    ok   ' + n); } else { fail++; console.log('    FAIL ' + n + (x ? '  -> ' + x : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture(token) {
  const H = fs.mkdtempSync(path.join(os.tmpdir(), 'credfix-'));
  fs.mkdirSync(path.join(H, '.claude', 'accounts'), { recursive: true });
  fs.mkdirSync(path.join(H, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(H, '.claude', 'accounts', 'Fixture.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'rt.fixture', expiresAt: Date.now() + 8 * 3600e3, scopes: [] } }));
  fs.copyFileSync(path.join(TESTS, 'mock-steward.js'), path.join(H, 'credential-steward.js'));
  const mock = path.join(H, 'bin', 'claude');
  fs.writeFileSync(mock, '#!/bin/sh\nexec ' + process.execPath + ' ' + path.join(TESTS, 'mock-claude.js') + ' "$@"\n');
  fs.chmodSync(mock, 0o755);
  return H;
}
const snapPath = (H) => path.join(H, '.claude', 'accounts', 'Fixture.credentials.json');
function rotate(H, newTok) {
  const p = snapPath(H), c = JSON.parse(fs.readFileSync(p, 'utf8'));
  (c.claudeAiOauth || c).accessToken = newTok;
  fs.writeFileSync(p, JSON.stringify(c));
}

function waitPort(port, ms) {
  const end = Date.now() + ms;
  return new Promise((res, rej) => {
    const tryIt = () => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(); });
      s.on('error', () => { s.destroy(); Date.now() > end ? rej(new Error('port ' + port + ' never opened')) : setTimeout(tryIt, 150); });
    };
    tryIt();
  });
}

async function run(name, { scenario, waitMs, rotateAfterMs, newToken, conference, runMs }) {
  console.log('\n  [' + name + ']');
  const H = fixture('TOKEN-A');
  const state = path.join(H, 'mock-state.json');
  fs.writeFileSync(state, JSON.stringify({ spawns: 0, prompts: [], tokens: [] }));
  const log = [];
  const child = spawn(process.execPath, ['bridge-server.js'], {
    cwd: REPO,
    env: Object.assign({}, process.env, {
      HOME: H, BRIDGE_PORT: String(PORT), CHAT_DB: path.join(H, 'chat.json'),
      CLAUDE_CWD: H, CLAUDE_MODEL: 'mock-model', BASE_PATH: '',
      PATH: path.join(H, 'bin') + ':' + process.env.PATH,
      RESUME_TURNS: '1',
      CRED_REVOKED_WAIT_MS: String(waitMs),
      MOCK_CLAUDE_STATE: state, MOCK_CLAUDE_SCENARIO: scenario,
      NOVNC_PORT: '6199', MCP_PORT: '8999',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => log.push(d.toString()));
  child.stderr.on('data', (d) => log.push(d.toString()));

  const msgs = [];
  try {
    await waitPort(PORT, 15000);
    const room = 'e2e-' + name;
    const ws = new WS('ws://127.0.0.1:' + PORT + '/ws');
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    ws.on('message', (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch {} });
    ws.send(JSON.stringify({ type: 'hello', clientId: 'e2e-client', roomId: room }));
    await sleep(300);
    const chat = { type: 'chat', roomId: room, text: 'ORIGINAL-PROMPT', displayedEngine: 'claude' };
    if (conference) Object.assign(chat, { engineMode: 'conference', reqId: 'e2etestreq1', taskDecision: 'none', maxRounds: 2 });
    ws.send(JSON.stringify(chat));
    if (rotateAfterMs) { await sleep(rotateAfterMs); rotate(H, newToken); }
    await sleep(runMs);
    ws.close();
  } finally {
    child.kill('SIGKILL');
    await sleep(300);
  }
  const st = JSON.parse(fs.readFileSync(state, 'utf8'));
  let conf = null;
  try {
    const d = path.join(H, '.claude', 'bridge-conference');
    const f = fs.readdirSync(d).filter((x) => x.endsWith('.json'))[0];
    if (f) conf = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
  } catch {}
  return { H, st, msgs, conf, log: log.join(''),
           statuses: msgs.filter((m) => m.type === 'status').map((m) => m.text),
           errors: msgs.filter((m) => m.type === 'error').map((m) => m.text),
           dones: msgs.filter((m) => m.type === 'done').map((m) => m.code),
           streamText: msgs.filter((m) => m.type === 'stream').map((m) => JSON.stringify(m.data)).join('\n') };
}

(async () => {
  // 1 ── the headline case: 401, wait for the owner's push, respawn, replay once.
  {
    const r = await run('heal', { scenario: 'heal', waitMs: 30000, rotateAfterMs: 4000, newToken: 'TOKEN-B', runMs: 9000 });
    ok('status said "Credentials rotating - reconnecting"', r.statuses.some((s) => /Credentials rotating/.test(s)), JSON.stringify(r.statuses));
    ok('never told the user to re-authenticate', !r.statuses.concat(r.errors).some((s) => /re-?authenticat/i.test(s)));
    ok('respawned exactly once (2 spawns total)', r.st.spawns === 2, 'spawns=' + r.st.spawns);
    ok('replay ran on the NEW token', (r.st.tokens[1] || {}).token === 'TOKEN-B', JSON.stringify(r.st.tokens));
    ok('first worker held the OLD token', (r.st.tokens[0] || {}).token === 'TOKEN-A', JSON.stringify(r.st.tokens));
    ok('the original prompt was replayed verbatim, once per spawn',
       r.st.prompts.length === 2 && r.st.prompts.every((p) => p.text.indexOf('ORIGINAL-PROMPT') !== -1), JSON.stringify(r.st.prompts));
    ok('the recovered answer reached the client', r.streamText.indexOf('RECOVERED-ANSWER') !== -1);
    ok('neither the synthetic bubble nor the 401 result was shown', r.streamText.indexOf('has been revoked') === -1 && r.streamText.indexOf('api_error_status') === -1);
    ok('turn finished cleanly (done 0)', r.dones.indexOf(0) !== -1, JSON.stringify(r.dones));
    ok('no error surfaced to the user', r.errors.length === 0, JSON.stringify(r.errors));
  }

  // 2 ── replay safety: a tool already ran this turn, so never auto-replay.
  {
    const r = await run('partial', { scenario: 'partial', waitMs: 30000, rotateAfterMs: 2000, newToken: 'TOKEN-B', runMs: 7000 });
    ok('did NOT respawn', r.st.spawns === 1, 'spawns=' + r.st.spawns);
    ok('did NOT replay the prompt', r.st.prompts.length === 1, JSON.stringify(r.st.prompts));
    ok('failed closed with a partial-work message', r.errors.some((e) => /interrupted after partial work/.test(e)), JSON.stringify(r.errors));
    ok('the tool_use the model already ran was still shown', r.streamText.indexOf('tool_use') !== -1);
  }

  // 3 ── rotation never lands: fail closed, do not replay onto a dead credential.
  {
    const r = await run('timeout', { scenario: 'timeout', waitMs: 5000, runMs: 11000 });
    ok('announced the rotation wait', r.statuses.some((s) => /Credentials rotating/.test(s)), JSON.stringify(r.statuses));
    ok('did NOT respawn/replay', r.st.spawns === 1, 'spawns=' + r.st.spawns);
    ok('failed closed with "resend shortly"', r.errors.some((e) => /still rotating .* resend shortly/i.test(e)), JSON.stringify(r.errors));
    ok('never told the user to re-authenticate', !r.errors.some((e) => /re-?authenticat/i.test(e)));
    ok('journal retained for the unreplayed turn', fs.existsSync(path.join(r.H, '.claude', 'bridge-pending')) &&
       fs.readdirSync(path.join(r.H, '.claude', 'bridge-pending')).length > 0);
  }

  // 4 ── control: a clean turn is untouched by any of this.
  {
    const r = await run('clean', { scenario: 'clean', waitMs: 30000, runMs: 5000 });
    ok('single spawn', r.st.spawns === 1, 'spawns=' + r.st.spawns);
    ok('answer delivered', r.streamText.indexOf('PLAIN-ANSWER') !== -1);
    ok('no rotation status', !r.statuses.some((s) => /Credentials rotating/.test(s)), JSON.stringify(r.statuses));
    ok('done 0', r.dones.indexOf(0) !== -1);
  }

  // 5 ── a 429 must not be mistaken for an auth failure.
  {
    const r = await run('rate', { scenario: 'rate', waitMs: 30000, runMs: 5000 });
    ok('did not respawn on 429', r.st.spawns === 1, 'spawns=' + r.st.spawns);
    ok('no rotation status on 429', !r.statuses.some((s) => /Credentials rotating/.test(s)), JSON.stringify(r.statuses));
  }

  // 6 ── conference: a 401 turn must never be recorded as a verdict or advance a stage.
  {
    const r = await run('conf', { scenario: 'conf', waitMs: 30000, rotateAfterMs: 4000, newToken: 'TOKEN-B', conference: true, runMs: 14000 });
    const logged = r.conf && Array.isArray(r.conf.log) ? r.conf.log.filter((e) => e.role !== 'user') : [];
    ok('conference record exists', !!r.conf, 'no conf file');
    ok('the 401 turn was NOT recorded as a verdict',
       !logged.some((e) => /revoked|authentication_failed/i.test(String(e.text || ''))), JSON.stringify(logged.map((e) => (e.text || '').slice(0, 60))));
    ok('still at the diagnosis stage (no stage advance on a dead turn)',
       !r.conf || r.conf.stage === 'diagnosis', r.conf && r.conf.stage);
    ok('recovery respawned the worker', r.st.spawns >= 2, 'spawns=' + r.st.spawns);
    ok('the retry ran on the NEW token', r.st.tokens.slice(1).some((t) => t.token === 'TOKEN-B'), JSON.stringify(r.st.tokens));
    ok('conference route logged', /CRED_401_HEAL_V3\] 401 on CONFERENCE room/.test(r.log), 'not in bridge log');
    ok('no raw access token in the bridge log', !/TOKEN-[AB]/.test(r.log));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(9); });
