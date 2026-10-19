'use strict';
// Minimal WS client: opens a codex-led conference on the isolated bridge and
// records the messages (including the exhausted pause). Run from the bridge dir
// so require('ws') resolves. argv: <port> <room> <waitMs>
const WebSocket = require('ws');
const [, , port, room, waitMs] = process.argv;
const ws = new WebSocket('ws://localhost:' + port + '/ws');
const msgs = [];
const PAUSE = 'Could not obtain Codex credentials after 3 attempts';
let sawPause = false;
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', clientId: 'e2e', roomId: room }));
  setTimeout(() => ws.send(JSON.stringify({
    type: 'conf_start', brief: 'e2e lock-starvation reproduction (isolated)',
    leadEngine: 'codex', taskType: 'fix', maxRounds: 3,
    reqId: 'e2e-repro-000001', taskDecision: 'none',
  })), 600);
});
ws.on('message', d => {
  const raw = d.toString();
  if (raw.indexOf(PAUSE) !== -1) sawPause = true;   // scan the FULL frame, no truncation
  try { const m = JSON.parse(d);
    let s = m.type;
    if (m.text) s += ':' + String(m.text).slice(0, 90);
    if (m.pausedReason) s += ':' + String(m.pausedReason).slice(0, 90);
    if (m.stage) s += '(' + m.stage + ')';
    msgs.push(s);
  } catch (e) {}
});
ws.on('error', e => { msgs.push('WS_ERROR:' + e.message); });
setTimeout(() => {
  console.log('MSGS: ' + msgs.join(' | '));
  console.log('WS_PAUSE_SEEN: ' + (sawPause ? 'yes' : 'no'));
  try { ws.close(); } catch (e) {}
  process.exit(sawPause ? 0 : 2);   // FAIL if the exact user-facing pause never arrived on the socket
}, Number(waitMs) || 112000);
