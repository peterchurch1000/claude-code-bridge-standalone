#!/usr/bin/env node
/* TASK_TITLE_HAIKU_V2 — fallback must never regress to the raw typed sentence.
 * When the Haiku call fails (e.g. the CLI's OAuth token is revoked, as it is now)
 * the old fallback was source.slice(0,120) — i.e. exactly defect #1 reappearing.
 * Replace it with a deterministic 5-7 word Title Case label on BOTH sides.
 */
const fs = require('fs');
const { execFileSync } = require('child_process');
const check = f => execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });

const S_FILE = '/var/www/html/claude-code-bridge-standalone/bridge-server.js';
const C_FILE = '/var/www/html/claude-code-bridge-standalone/public/app.js';
const changes = [];

const STOPWORDS = "a an the of to in on at for and or but if so then than that this those these it its is are was were be been being am do does did done can could would should will shall may might must i we you he she they them us our your my his her their me him not no yes just really very quite some any all with as from by about into over under out up down want wants wanted need needs needed like likes liked make makes made get gets got go goes went let lets please kind sort way ways thing things able new";

/* ── server ──────────────────────────────────────────────────────────────── */
let s = fs.readFileSync(S_FILE, 'utf8'); check(S_FILE);

const HEUR = `// [TASK_TITLE_HAIKU_V2] Deterministic 5-7 word label, used when the model call
// fails. Falling back to the raw sentence would be defect #1 all over again.
const _TT_STOP = new Set(('${STOPWORDS}').split(' '));
function heuristicTaskTitle(text) {
  const raw = String(text || '').replace(/https?:\\/\\/\\S+/g, ' ').replace(/[^A-Za-z0-9\\s-]/g, ' ').split(/\\s+/).filter(Boolean);
  if (!raw.length) return '';
  const content = raw.filter(w => !_TT_STOP.has(w.toLowerCase()));
  // Never pad with filler: a short honest label beats "Fix Login Bug The".
  const picked = (content.length ? content : raw).slice(0, 7);
  return picked.map(w => { w = w.toLowerCase(); return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ').slice(0, 80);
}
`;
if (s.indexOf('function heuristicTaskTitle(') !== -1) { changes.push('server heuristic: already present (no-op)'); }
else {
  const a = '// True only for something that reads like a 5-7 word label, not a sentence/refusal.';
  if (s.indexOf(a) === -1) { console.error('FAIL: looksLikeTaskTitle anchor missing'); process.exit(1); }
  s = s.replace(a, HEUR + a);
  changes.push('server: + heuristicTaskTitle()');
}

const OLD_FB = "  const fallback = source.replace(/\\s+/g, ' ').trim().slice(0, 120);";
const NEW_FB = "  const fallback = heuristicTaskTitle(source) || source.replace(/\\s+/g, ' ').trim().slice(0, 120);   // [TASK_TITLE_HAIKU_V2]";
if (s.indexOf(NEW_FB) !== -1) { changes.push('server fallback: already heuristic (no-op)'); }
else if (s.indexOf(OLD_FB) !== -1) { s = s.replace(OLD_FB, NEW_FB); changes.push('server: fallback -> heuristic label'); }
else { console.error('FAIL: server fallback line not found'); process.exit(1); }

/* ── client ──────────────────────────────────────────────────────────────── */
let c = fs.readFileSync(C_FILE, 'utf8'); check(C_FILE);

const OLD_TTF = "  function _ttFallback(s) { return String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 120); }";
const NEW_TTF = `  // [TASK_TITLE_HAIKU_V2] Last resort when the server is unreachable. Mirrors the
  // server heuristic so the Title is never the raw typed sentence (defect #1).
  const _TT_STOP = new Set(('${STOPWORDS}').split(' '));
  function _ttFallback(s) {
    const raw = String(s || '').replace(/https?:\\/\\/\\S+/g, ' ').replace(/[^A-Za-z0-9\\s-]/g, ' ').split(/\\s+/).filter(Boolean);
    if (!raw.length) return '';
    const content = raw.filter(w => !_TT_STOP.has(w.toLowerCase()));
    const picked = (content.length ? content : raw).slice(0, 7);
    return picked.map(function (w) { w = w.toLowerCase(); return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ').slice(0, 80);
  }`;
if (c.indexOf('const _TT_STOP') !== -1) { changes.push('client fallback: already heuristic (no-op)'); }
else if (c.indexOf(OLD_TTF) !== -1) { c = c.replace(OLD_TTF, NEW_TTF); changes.push('client: _ttFallback -> heuristic label'); }
else { console.error('FAIL: client _ttFallback not found'); process.exit(1); }

/* ── write ───────────────────────────────────────────────────────────────── */
let wrote = 0;
for (const [file, out] of [[S_FILE, s], [C_FILE, c]]) {
  if (out === fs.readFileSync(file, 'utf8')) continue;
  const tmp = file + '.v2-new.js';
  fs.writeFileSync(tmp, out);
  try { check(tmp); } catch (e) { fs.unlinkSync(tmp); console.error('FAIL: node --check ' + file + '\n' + (e.stderr || e).toString()); process.exit(1); }
  fs.copyFileSync(file, file + '.bak-tasktitle2-' + Date.now());
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o644); } catch {}
  console.log('PATCHED ' + file);
  wrote++;
}
if (!wrote) console.log('NO-OP (already patched)');
console.log(changes.map(x => '  - ' + x).join('\n'));
