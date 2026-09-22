#!/usr/bin/env node
// Mock `claude` CLI for the [CRED_401_HEAL_V3] end-to-end tests.
// Reproduces the REAL revoked-token event shape, established by the earlier live run:
// a synthetic assistant message (is_api_error_message / authentication_failed) followed
// by {"type":"result","is_error":true,"api_error_status":401,"subtype":"success"} —
// note subtype "success" and an EMPTY stderr, which is why a stderr detector never fires.
'use strict';
const fs = require('fs');
const STATE = process.env.MOCK_CLAUDE_STATE;
const SCENARIO = process.env.MOCK_CLAUDE_SCENARIO || 'heal';

function load() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { spawns: 0, prompts: [], tokens: [] }; } }
function save(s) { fs.writeFileSync(STATE, JSON.stringify(s)); }

const st = load();
st.spawns = (st.spawns || 0) + 1;
const myIdx = st.spawns;
st.prompts = st.prompts || [];
st.tokens = st.tokens || [];
// Record which credential this worker was handed - proves the replay ran on a NEW token.
try {
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  const c = JSON.parse(fs.readFileSync(cfg + '/.credentials.json', 'utf8'));
  st.tokens.push({ spawn: myIdx, token: (c.claudeAiOauth || c).accessToken || null });
} catch (e) { st.tokens.push({ spawn: myIdx, token: null, err: e.message }); }
save(st);

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', session_id: 'mock-session-' + (process.env.MOCK_SESSION || '1') });

function fail401() {
  out({ type: 'assistant', is_api_error_message: true, error: 'authentication_failed',
        message: { model: '<synthetic>', content: [{ type: 'text', text: 'OAuth access token has been revoked' }] } });
  out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401,
        result: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked"}}' });
}
function answer(t) {
  out({ type: 'assistant', message: { model: 'mock', content: [{ type: 'text', text: t }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: t });
}
function toolUse() {
  out({ type: 'assistant', message: { model: 'mock', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'echo side-effect' } }] } });
}
function other(status) {
  out({ type: 'result', subtype: 'success', is_error: true, api_error_status: status, result: 'API Error: ' + status });
}

function handle() {
  switch (SCENARIO) {
    case 'heal':    return myIdx === 1 ? fail401() : answer('RECOVERED-ANSWER');
    case 'partial': if (myIdx === 1) { toolUse(); return fail401(); } return answer('MUST-NOT-REPLAY');
    case 'timeout': return myIdx === 1 ? fail401() : answer('MUST-NOT-REPLAY');
    case 'clean':   return answer('PLAIN-ANSWER');
    case 'rate':    return myIdx === 1 ? other(429) : answer('MUST-NOT-REPLAY');
    case 'conf':    return myIdx === 1 ? fail401() : answer('RECOVERED-ANSWER');
    default:        return answer('UNKNOWN-SCENARIO');
  }
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  const lines = buf.split('\n'); buf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    const text = (m && m.message && Array.isArray(m.message.content))
      ? m.message.content.map((c) => c.text || '').join('') : String((m && m.message && m.message.content) || '');
    const s = load(); s.prompts.push({ spawn: myIdx, text: text.slice(0, 400) }); save(s);
    handle();
  }
});
process.stdin.on('end', () => process.exit(0));
