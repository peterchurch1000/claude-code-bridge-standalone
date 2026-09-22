'use strict';
const fs = require('fs'), path = require('path');
const { JSDOM } = require(process.env.JSDOM || '/tmp/bts/node_modules/jsdom');
const SB = '__WORK__';

const html = fs.readFileSync(path.join(SB, 'public/index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'https://example.test/?room=draft-test', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;

// ── minimal environment the app expects ──
w.__CCB_TEST__ = 1;
w.marked = { parse: (t) => String(t == null ? '' : t) };
w.fetch = () => new Promise(() => {});            // never resolves: no network in tests
w.WebSocket = function () { this.readyState = 0; this.send = () => {}; this.close = () => {}; };
w.WebSocket.OPEN = 1; w.WebSocket.CLOSED = 3;
w.scrollTo = () => {};
w.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
w.cancelAnimationFrame = (id) => clearTimeout(id);
if (!w.crypto) w.crypto = {};
w.crypto.randomUUID = () => 'u-' + Math.random().toString(36).slice(2, 12);
w.HTMLCanvasElement.prototype.getContext = () => null;
w.alert = () => {}; w.confirm = () => true;

const code = fs.readFileSync(path.join(SB, 'public/app.js'), 'utf8');
try { w.eval(code); } catch (e) { console.error('app.js threw on load:', e.message); process.exit(1); }

const H = w.__ccbHooks;
if (!H) { console.error('FAIL: __ccbHooks not exposed'); process.exit(1); }

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); } };
const eq = (name, got, want) => ok(name, got === want, 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
const clear = () => { H.messagesEl.innerHTML = ''; H.storedMsgData.length = 0; };

// 21 Nov 2026 14:32 Buenos Aires  == 17:32 UTC
const T_2111_1432 = Date.UTC(2026, 10, 21, 17, 32, 0);
// 22 Nov 2026 00:00 Buenos Aires  == 03:00 UTC  (midnight must be 00:00, never 24:00)
const T_2211_0000 = Date.UTC(2026, 10, 22, 3, 0, 0);

console.log('\nT1/T2 formatter');
eq('T1 golden 21/11 14:32', H.fmtBaStamp(T_2111_1432), '21/11 14:32');
eq('T2 midnight is 00:00 not 24:00', H.fmtBaStamp(T_2211_0000), '22/11 00:00');
eq('T1b single-digit day/month zero-padded', H.fmtBaStamp(Date.UTC(2026, 0, 5, 12, 5, 0)), '05/01 09:05');
eq('T1c non-finite -> empty', H.fmtBaStamp(undefined), '');

console.log('\nT3 live row mints + stamps');
clear();
const el3 = H.appendMsg('user', 'hi');
const row3 = H.storedMsgData[H.storedMsgData.length - 1];
ok('T3 data-ts present + well formed', /^\d{2}\/\d{2} \d{2}:\d{2}$/.test(el3.dataset.ts || ''), el3.dataset.ts);
ok('T3 stored row carries finite ts', Number.isFinite(row3.ts));
eq('T3 rendered == formatted stored ts', el3.dataset.ts, H.fmtBaStamp(row3.ts));

console.log('\nT4 replay round-trip preserves the ORIGINAL instant');
clear();
H.renderOneStored({ type: 'user', text: 'hi', mid: 'cli:x', ts: T_2111_1432 });
const el4 = H.messagesEl.querySelector('.msg-user');
eq('T4 replayed stamp', el4.dataset.ts, '21/11 14:32');
eq('T4 replayed row keeps ts', H.storedMsgData[H.storedMsgData.length - 1].ts, T_2111_1432);

console.log('\nT5/T8 legacy absence is PERMANENT on every replay path');
clear();
H.renderOneStored({ type: 'user', text: 'old', mid: 'cli:y' });
const el5 = H.messagesEl.querySelector('.msg-user');
ok('T5 no data-ts attribute', !el5.hasAttribute('data-ts'), el5.getAttribute('data-ts'));
ok('T5 stored row has NO ts', H.storedMsgData[H.storedMsgData.length - 1].ts === undefined);
clear();
H.renderOneStored({ type: 'tool', toolName: 'Read', args: { a: 1 }, result: 'x', mid: 'cli:t' });
const el5t = H.messagesEl.querySelector('.msg-tool');
ok('T5 tool row: no data-ts', !el5t.hasAttribute('data-ts'));
clear();
H.confDivider('claude', 'lead', 2, 'Requirements');
ok('T5 divider without ts: no data-ts', !H.messagesEl.querySelector('.conf-divider').hasAttribute('data-ts'));

console.log('\nT8 conf_sync replay of stamp-less rows mints nothing');
clear();
H.activeConf = false;
H.renderConfSync({ type: 'conf_sync', roomId: 'r', status: 'paused', stage: 'diagnosis', messages: [
  { type: 'user', text: 'brief', mid: 'conf:brief' },
  { type: 'assistant', text: 'turn', mid: 'conf:ct-old', role: 'lead', round: 1, stageLabel: 'Requirements', turnId: 'ct-old' },
] });
ok('T8 no element gained data-ts', H.messagesEl.querySelectorAll('[data-ts]').length === 0,
   'stamped=' + H.messagesEl.querySelectorAll('[data-ts]').length);
ok('T8 no stored row gained ts', H.storedMsgData.every(r => r.ts === undefined),
   JSON.stringify(H.storedMsgData.map(r => r.ts)));

console.log('\nT7 conf_sync WITH rowCreatedAt stamps divider + bubble identically');
clear();
H.renderConfSync({ type: 'conf_sync', roomId: 'r', status: 'paused', stage: 'diagnosis', messages: [
  { type: 'assistant', text: 'turn', mid: 'conf:ct-1', role: 'lead', round: 1, stageLabel: 'Requirements', turnId: 'ct-1', ts: T_2111_1432 },
] });
eq('T7 bubble stamp', H.messagesEl.querySelector('.msg-assistant').dataset.ts, '21/11 14:32');
eq('T7 divider stamp == bubble stamp', H.messagesEl.querySelector('.conf-divider').dataset.ts, '21/11 14:32');

console.log('\nT9 two devices, same frame, minute boundary -> identical');
clear();
const A = H.appendMsg('user', 'x', { mid: 'cli:same', ts: T_2111_1432 });
clear();
const B = H.appendMsg('user', 'x', { mid: 'cli:same', ts: T_2111_1432 });
eq('T9 identical rendering from one canonical instant', A.dataset.ts, B.dataset.ts);
eq('T9 value', A.dataset.ts, '21/11 14:32');

console.log('\nT6 search / textContent / copy safety');
clear();
H.appendMsg('user', 'hello world', { ts: T_2111_1432 });
const txt = H.messagesEl.textContent || '';
ok('T6 stamp absent from textContent', txt.indexOf('21/11') === -1, JSON.stringify(txt));
let textNodes = '';
const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3) textNodes += c.nodeValue; else walk(c); } };
walk(H.messagesEl);
ok('T6 stamp absent from all text nodes (chat search walks these)', textNodes.indexOf('21/11') === -1);

console.log('\nT10 old server (frame without ts) degrades safely');
clear();
const el10 = H.appendMsg('assistant', 'reply', { ts: undefined });
ok('T10 still renders, mints locally', /^\d{2}\/\d{2} \d{2}:\d{2}$/.test(el10.dataset.ts || ''), el10.dataset.ts);

console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' : 'ALL PASS ') + (pass + fail) + ' assertions');
process.exit(fail ? 1 : 0);
