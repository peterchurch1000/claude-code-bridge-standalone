#!/usr/bin/env node
// [CRED_401_HEAL_V3] Predicate tests. These bind to the SHIPPED text: each guard is
// extracted verbatim from bridge-server.js and evaluated, so a future edit that changes
// a condition breaks the test rather than silently passing.
'use strict';
const fs = require('fs');
const SRC = fs.readFileSync(process.argv[2] || '/var/www/html/claude-code-bridge-standalone/bridge-server.js', 'utf8');

function extract(start, end, what) {
  const a = SRC.indexOf(start); if (a === -1) throw new Error('guard not found: ' + what);
  const b = SRC.indexOf(end, a); if (b === -1) throw new Error('guard end not found: ' + what);
  return SRC.slice(a, b).trim();
}
const gDetect = extract("CREDENTIAL_STEWARD_ENABLED && CRED_401_HEAL && !S.credRetried && ev.is_error", ") {", 'detect');
const gConf   = extract("!!(S.conf && S.conf.status === 'running' && S.conf.activeTurnId)", ";", 'confTurnLive');
const gOut    = extract("_ob && ((_ob.type === 'text'", ") { S._turnSawOutput", 'output');
const gSupp   = extract("CREDENTIAL_STEWARD_ENABLED && CRED_401_HEAL && !S.credRetried &&\n", "api_error_status) === 401));", 'suppress') + "api_error_status) === 401))";

const detect = new Function('CREDENTIAL_STEWARD_ENABLED', 'CRED_401_HEAL', 'S', 'ev', 'return !!(' + gDetect + ');');
const confLive = new Function('S', 'return ' + gConf + ';');
const isOut = new Function('_ob', 'return !!(' + gOut + ');');
const suppress = new Function('CREDENTIAL_STEWARD_ENABLED', 'CRED_401_HEAL', 'S', 'ev', 'return !!(' + gSupp + ');');

// Mirror of the branch order in the shipped handler.
function route(S, ev, opts) {
  opts = opts || {};
  const stewardOn = opts.steward !== false, healOn = opts.heal !== false;
  if (!detect(stewardOn, healOn, S, ev)) return 'none';
  if (confLive(S)) return S._turnSawOutput ? 'conf-pause' : 'conf-retry';
  return S._turnSawOutput ? 'fail-closed' : 'replay';
}

const room = (o) => Object.assign({ key: 'r', credRetried: false, _turnSawOutput: false, conf: null }, o);
const confRoom = (o) => room(Object.assign({ conf: { status: 'running', activeTurnId: 't1' } }, o));
const r401 = { type: 'result', is_error: true, api_error_status: 401, subtype: 'success' };

let pass = 0, fail = 0;
const t = (name, got, want) => {
  if (got === want) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  got=' + got + ' want=' + want); }
};

console.log('routing:');
t('401 ordinary, no output -> replay', route(room(), r401), 'replay');
t('401 ordinary, text emitted -> fail closed', route(room({ _turnSawOutput: true }), r401), 'fail-closed');
t('401 conference, no output -> FSM retry', route(confRoom(), r401), 'conf-retry');
t('401 conference, tool ran -> pause', route(confRoom({ _turnSawOutput: true }), r401), 'conf-pause');
t('401 but one-shot spent -> none', route(room({ credRetried: true }), r401), 'none');
t('401 with heal gate off -> none', route(room(), r401, { heal: false }), 'none');
t('401 with steward off -> none', route(room(), r401, { steward: false }), 'none');
t('429 -> none', route(room(), { type: 'result', is_error: true, api_error_status: 429 }), 'none');
t('500 -> none', route(room(), { type: 'result', is_error: true, api_error_status: 500 }), 'none');
t('401 but not is_error -> none', route(room(), { type: 'result', is_error: false, api_error_status: 401 }), 'none');
t('clean result -> none', route(room(), { type: 'result', is_error: false, subtype: 'success' }), 'none');
t('paused conference treated as ordinary', route(room({ conf: { status: 'paused', activeTurnId: 't1' } }), r401), 'replay');
t('conference with no active turn -> ordinary', route(room({ conf: { status: 'running', activeTurnId: null } }), r401), 'replay');

console.log('replay gate (what counts as real output):');
t('non-empty text counts', isOut({ type: 'text', text: 'hi' }), true);
t('whitespace-only text does not', isOut({ type: 'text', text: '   ' }), false);
t('empty text does not', isOut({ type: 'text', text: '' }), false);
t('tool_use counts', isOut({ type: 'tool_use', name: 'Bash' }), true);
t('thinking block does not', isOut({ type: 'thinking', thinking: 'x' }), false);
t('null block does not', isOut(null), false);

console.log('synthetic auth bubble suppression:');
t('synthetic auth error suppressed', suppress(true, true, room(), { type: 'assistant', is_api_error_message: true, error: 'authentication_failed' }), true);
t('suppressed in conference too', suppress(true, true, confRoom(), { type: 'assistant', is_api_error_message: true, error: 'authentication_failed' }), true);
t('real assistant text not suppressed', suppress(true, true, room(), { type: 'assistant', message: { content: [{ type: 'text', text: 'got a 401 earlier' }] } }), false);
t('other api error not suppressed', suppress(true, true, room(), { type: 'assistant', is_api_error_message: true, error: 'overloaded_error' }), false);
t('the 401 result event is suppressed too', suppress(true, true, room(), { type: 'result', is_error: true, api_error_status: 401 }), true);
t('a 429 result is not suppressed', suppress(true, true, room(), { type: 'result', is_error: true, api_error_status: 429 }), false);
t('a clean result is not suppressed', suppress(true, true, room(), { type: 'result', is_error: false }), false);
t('not suppressed once one-shot spent', suppress(true, true, room({ credRetried: true }), { type: 'assistant', is_api_error_message: true, error: 'authentication_failed' }), false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
