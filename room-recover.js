// room-recover.js — [ROOM_RECOVER_V1]
// Authoritative transcript projection + non-blocking incremental cache + insert-only
// merge, for recovering a room pane's dropped tail from the append-only transcript.
// Pure/standalone so it can be unit-tested off the bridge event loop. Wired into
// bridge-server.js attach() history_sync, request_resync, and GET /history (non-conf).
'use strict';
const fs = require('fs');
const fsp = fs.promises;

// ---- plumbing strip (mirror of bridge-server.js stripPlumbing / tx-read.js) ----
function stripPlumbing(t) {
  return String(t || '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .trim();
}
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b && b.type === 'text').map(b => b.text).join('');
  return '';
}
const COMPACT_GLYPH = '\u{1F5DC}';   // 🗜 — the post-compaction summary marker, never a chat bubble
const TOOL_MID = id => 'tx:tool:' + id;

// Event-level exclusions, IDENTICAL to the proven recovery reader (tx-read.js):
// these rows exist in the transcript but were never rendered as chat, so projecting
// them would INVENT content rather than restore what the room showed.
function _excludedEvent(ev) {
  return !ev
    || ev.isCompactSummary === true
    || ev.isVisibleInTranscriptOnly === true
    || ev.isMeta === true
    || ev.isApiErrorMessage === true
    || ev.isSidechain === true;          // sub-agent internals
}

// ---- Projection: ordered transcript events -> UI-compatible rows ----
// Client row schemas (confirmed against app.js):
//   text: { type:'user'|'assistant', text, ts, mid }   (mid is advisory — see rowKey)
//   tool: { type:'tool', toolName, args, result:null|string(<=600), id, ts, mid }
// Segmentation mirrors the live client exactly: within an assistant event accumulate
// consecutive text blocks, flush a text bubble before each tool_use, emit ONE tool row,
// then start a fresh text bubble. A later user-event tool_result updates the matching
// tool row's `result`. Every row carries a STABLE `mid` derived from the event uuid
// (same identity model tx-read.js uses: uuid + ordinal) so recovered user/assistant
// rows — not just tool rows — have a durable id for client keying. `mid` is advisory:
// rowKey() aligns text by normalised content, NOT by mid, so a client bubble (no mid)
// and its projected twin (with mid) still match and never duplicate.
// `state` carries `pendingTool` (toolUseId -> row ref) so a tool_result arriving in a
// LATER increment still correlates into a tool row emitted earlier, and `version` which
// bumps on every append OR correlated mutation (so cache consumers detect changes).
// `seq` backstops row identity when an event has no uuid (append-only ⇒ stable ordinal).
function newProjectionState() { return { rows: [], pendingTool: Object.create(null), version: 0, seq: 0 }; }

function _textMid(ev, state, kind, seg) {
  const base = ev && ev.uuid ? ('tx:' + kind + ':' + ev.uuid) : ('tx:' + kind + ':#' + (state.seq++));
  return seg > 0 ? base + ':' + seg : base;
}

function projectEvents(events, state) {
  state = state || newProjectionState();
  const rows = state.rows, pendingTool = state.pendingTool;
  for (const ev of events) {
    if (_excludedEvent(ev)) continue;
    const tsN = Date.parse(ev && ev.timestamp);
    const ts = Number.isFinite(tsN) ? tsN : undefined;
    const msg = ev.message;
    if (ev.type === 'user' && msg && msg.role === 'user') {
      const c = msg.content;
      let correlated = false, hasText = false;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b && b.type === 'tool_result' && b.tool_use_id && pendingTool[b.tool_use_id]) {
            let out = b.content;
            if (Array.isArray(out)) out = out.filter(x => x && x.type === 'text').map(x => x.text).join('');
            pendingTool[b.tool_use_id].result = String(out == null ? '' : out).slice(0, 600);
            delete pendingTool[b.tool_use_id];
            state.version++;                       // correlated mutation of an existing row
            correlated = true;
          } else if (b && b.type === 'text' && b.text) hasText = true;
        }
      }
      if (correlated && !hasText) continue;         // pure tool_result turn -> no user bubble
      const t = stripPlumbing(extractText(c));
      if (t) { rows.push({ type: 'user', text: t, ts, mid: _textMid(ev, state, 'u', 0) }); state.version++; }
    } else if (ev.type === 'assistant' && msg && Array.isArray(msg.content)) {
      let cur = '', seg = 0;
      for (const b of msg.content) {
        if (b && b.type === 'text') cur += (b.text || '');
        else if (b && b.type === 'tool_use') {
          if (cur.trim() && !cur.includes(COMPACT_GLYPH)) { rows.push({ type: 'assistant', text: cur, ts, mid: _textMid(ev, state, 'a', seg++) }); state.version++; }
          cur = '';
          const row = { type: 'tool', toolName: b.name, args: b.input, result: null, id: b.id, ts, mid: TOOL_MID(b.id) };
          rows.push(row); pendingTool[b.id] = row; state.version++;
        }
      }
      if (cur.trim() && !cur.includes(COMPACT_GLYPH)) { rows.push({ type: 'assistant', text: cur, ts, mid: _textMid(ev, state, 'a', seg++) }); state.version++; }
    }
  }
  return state;
}

function parseJsonl(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const s = line.trim(); if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* drop partial/garbage */ }
  }
  return out;
}

// ---- Non-blocking incremental projection cache ----
// Keyed by path. Entry: {ino,size,partial(Buffer),state,inflight,mtimeMs}. Append-only
// fast path reads ONLY the newly-appended bytes; cold/truncation/replacement rebuilds via
// a chunked stream BOUNDED to the statted size (never the live EOF); concurrent callers
// coalesce behind one in-flight promise. Line-splitting is done on raw BYTES (newline
// 0x0A) with the incomplete trailing line kept as a Buffer, so a multibyte char split at a
// read boundary is never corrupted and a partial JSON line is never parsed twice.
const _projCache = new Map();

function _emptyEntry(ino, mtimeMs) {
  return { ino, size: 0, partial: Buffer.alloc(0), state: newProjectionState(), mtimeMs, inflight: null };
}
// Append `buf` (raw bytes) to the entry, project every COMPLETE line, keep the remainder.
function _consume(entry, buf) {
  let data = entry.partial.length ? Buffer.concat([entry.partial, buf]) : buf;
  let start = 0; const evs = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0A) {
      const s = data.slice(start, i).toString('utf8').trim();
      start = i + 1;
      if (s) { try { evs.push(JSON.parse(s)); } catch { /* skip */ } }
    }
  }
  entry.partial = start < data.length ? data.slice(start) : Buffer.alloc(0);
  if (evs.length) projectEvents(evs, entry.state);
}
// Stream raw bytes [start,end) in chunks (bounded — never past `end`) and consume them.
async function _streamRange(filePath, start, end, entry) {
  if (end <= start) return;
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(filePath, { start, end: end - 1, highWaterMark: 1 << 20 }); // Buffer chunks; end inclusive
    rs.on('data', c => { try { _consume(entry, c); } catch (e) { rs.destroy(e); } });
    rs.on('end', resolve);
    rs.on('error', reject);
  });
}

// Returns a shallow copy of the projected rows (so callers/merge never mutate the cache).
async function getProjection(filePath) {
  let st; try { st = await fsp.stat(filePath); } catch { return { rows: [], version: 0 }; }
  let e = _projCache.get(filePath);
  const replaced = e && (e.ino !== st.ino || st.size < e.size);   // truncation or file swap
  if (!e || replaced) {
    const entry = _emptyEntry(st.ino, st.mtimeMs);
    const bound = st.size;                                        // BIND the cold read to the statted size…
    entry.inflight = (async () => { await _streamRange(filePath, 0, bound, entry); entry.size = bound; entry.mtimeMs = st.mtimeMs; })();
    _projCache.set(filePath, entry); e = entry;                   // …so entry.size == exactly the bytes consumed (growth-during-stream is picked up as a later delta, never re-parsed)
    try { await e.inflight; } finally { e.inflight = null; }
  } else if (st.size > e.size) {                                  // append-only fast path: delta bytes only
    if (e.inflight) await e.inflight;
    const from = e.size, to = st.size;
    e.inflight = (async () => { await _streamRange(filePath, from, to, e); e.size = to; e.mtimeMs = st.mtimeMs; })();
    try { await e.inflight; } finally { e.inflight = null; }
  } else if (e.inflight) { await e.inflight; }                   // size unchanged but a rebuild is mid-flight
  return { rows: e.state.rows.map(r => Object.assign({}, r)), version: e.state.version };
}

// ---- Insert-only, order-aware merge (base = client chatData rows, auth = projection) ----
// Keeps EVERY base row (optimistic/client-only bubbles, already-rendered tool cards) and
// INSERTS auth rows absent from base at their correct sequence position (incl. interior gaps
// and before later-surviving rows). Prefix/suffix trim makes the common "base is a prefix of
// auth" case O(n); an exact LCS DP resolves the divergent MIDDLE. The DP is BOUNDED: if the
// middle is pathologically large (middleB × middleA > dpCap) we fall back to a linear,
// lossless insert-only pass (all base rows kept in order, every auth-only row appended) and
// LOG it — no silent truncation, and memory/time stay bounded regardless of history size.
// Text matching uses the SAME normalisation the server's proven conf-heal recovery uses
// (whitespace-fold + trailing-verdict strip); tool rows align by stable id/mid.
const DEFAULT_DP_CAP = 4000000;    // cells (~16MB Int32 + ~4M ops) — exact DP path for any realistic room
const DEFAULT_CPU_CAP = 20000000;  // ops ceiling: Hirschberg is linear-MEMORY but still O(|B|×|A|) CPU, so
                                   // above this we drop to an O(|B|+|A|) merge — a pathological divergent
                                   // middle can then never block the bridge event loop (worst case is linear
                                   // in row count, sub-ms even for a 100k-row transcript).
let _normMatch = null;
try { _normMatch = require('./conf-heal.js').normaliseForMatch; } catch (e) { _normMatch = null; }
function _norm(t) { return _normMatch ? _normMatch(t) : String(t || '').replace(/\s+/g, ' ').trim(); }
function rowKey(r) {
  if (!r || typeof r !== 'object') return 'x';
  if (r.type === 'tool') return 'T\0' + (r.id != null ? r.id : (r.mid || ''));
  return (r.type || '?') + '\0' + _norm(r.text);   // mid is advisory; align text by content
}
// When a row is in both, keep the base (richer client fields) — EXCEPT a tool row whose
// result the client never received (null) but the transcript has: prefer the auth row then.
function _pickCommon(b, a) {
  if (b && a && b.type === 'tool' && a.type === 'tool' && (b.result == null || b.result === '') && a.result != null && a.result !== '')
    return a;
  return b;
}
// Linear-MEMORY LCS alignment (Hirschberg). Returns matched [i,j] index pairs in
// increasing order — the SAME anchors the full DP backtrack chooses — so the insert-only
// merge places every auth-only row at its correct sequence position while using
// O(min(|B|,|A|)) memory instead of the O(|B|×|A|) matrix. This REPLACES the earlier
// `base.concat(authOnly)` fallback, which was content-lossless but moved interior auth
// rows to the end (violating the "correct sequence position" invariant). Used for
// pathologically large divergent middles; the exact DP handles everything within dpCap,
// and a property test asserts both paths keep base AND auth as subsequences of the merge.
function _lcsPairsHirschberg(B, A) {
  const bk = B.map(rowKey), ak = A.map(rowKey);
  const pairs = [];
  // forward: F[k] = LCS(B[iLo..iHi), A[jLo..jLo+k))
  function llF(iLo, iHi, jLo, jHi) {
    const w = jHi - jLo; let prev = new Int32Array(w + 1), curr = new Int32Array(w + 1);
    for (let i = iLo; i < iHi; i++) {
      curr[0] = 0;
      for (let j = jLo; j < jHi; j++) { const k = j - jLo + 1; curr[k] = (bk[i] === ak[j]) ? prev[k - 1] + 1 : (prev[k] > curr[k - 1] ? prev[k] : curr[k - 1]); }
      const t = prev; prev = curr; curr = t;
    }
    return prev;
  }
  // backward: G[k] = LCS(B[iLo..iHi), A[jHi-k..jHi))
  function llB(iLo, iHi, jLo, jHi) {
    const w = jHi - jLo; let prev = new Int32Array(w + 1), curr = new Int32Array(w + 1);
    for (let i = iHi - 1; i >= iLo; i--) {
      curr[0] = 0;
      for (let j = jHi - 1; j >= jLo; j--) { const k = jHi - j; curr[k] = (bk[i] === ak[j]) ? prev[k - 1] + 1 : (prev[k] > curr[k - 1] ? prev[k] : curr[k - 1]); }
      const t = prev; prev = curr; curr = t;
    }
    return prev;
  }
  function rec(iLo, iHi, jLo, jHi) {
    if (iLo >= iHi || jLo >= jHi) return;
    if (iHi - iLo === 1) {                                   // single base row: first matching auth
      for (let j = jLo; j < jHi; j++) { if (bk[iLo] === ak[j]) { pairs.push([iLo, j]); return; } }
      return;
    }
    const iMid = (iLo + iHi) >> 1;
    let F = llF(iLo, iMid, jLo, jHi), G = llB(iMid, iHi, jLo, jHi);
    const w = jHi - jLo; let best = -1, split = jLo;
    for (let k = 0; k <= w; k++) { const s = F[k] + G[w - k]; if (s > best) { best = s; split = jLo + k; } }
    F = null; G = null;                                      // free before recursing (keeps peak memory linear)
    rec(iLo, iMid, jLo, split);
    rec(iMid, iHi, split, jHi);
  }
  rec(0, B.length, 0, A.length);
  return pairs;
}
// Emit an insert-only merge from the LCS anchor pairs: base-only rows then auth-only rows
// (inserted at their correct position) before each anchor, then the anchor (with _pickCommon),
// then any trailing base-only + auth-only rows. Preserves both base and auth order exactly.
function _mergeFromPairs(B, A, pairs, out) {
  let i = 0, j = 0;
  for (let p = 0; p < pairs.length; p++) {
    const mi = pairs[p][0], mj = pairs[p][1];
    while (i < mi) out.push(B[i++]);
    while (j < mj) out.push(A[j++]);
    out.push(_pickCommon(B[mi], A[mj])); i = mi + 1; j = mj + 1;
  }
  while (i < B.length) out.push(B[i++]);
  while (j < A.length) out.push(A[j++]);
}
// CPU-bounded O(|B|+|A|) merge for a pathologically large divergent middle (> cpuCap ops),
// so the event loop can never be blocked by the O(|B|×|A|) exact alignment. Greedy
// earliest-match via per-key sorted auth indices + monotonic cursors. Order-preserving and
// lossless (both base and auth remain subsequences of the output) though not guaranteed
// LCS-minimal — a deliberate, logged trade of minimality for a linear worst-case ceiling.
function _linearSupersequence(B, A, out) {
  const idx = new Map();
  for (let j = 0; j < A.length; j++) { const k = rowKey(A[j]); let a = idx.get(k); if (!a) { a = []; idx.set(k, a); } a.push(j); }
  const cur = new Map();
  let j = 0;
  for (let i = 0; i < B.length; i++) {
    const k = rowKey(B[i]); const arr = idx.get(k); let c = cur.get(k) || 0;
    if (arr) { while (c < arr.length && arr[c] < j) c++; }      // skip auth indices already consumed
    if (arr && c < arr.length) {
      const jj = arr[c]; cur.set(k, c + 1);
      while (j < jj) out.push(A[j++]);                          // auth-only rows before the match (inserted in place)
      out.push(_pickCommon(B[i], A[jj])); j = jj + 1;
    } else { if (arr) cur.set(k, c); out.push(B[i]); }          // client-only row (no matching auth at/after j)
  }
  while (j < A.length) out.push(A[j++]);                        // trailing auth-only rows (the dropped tail)
}
function mergeInsertOnly(base, auth, opts) {
  base = Array.isArray(base) ? base : [];
  auth = Array.isArray(auth) ? auth : [];
  if (!base.length) return auth.slice();
  const dpCap = (opts && Number.isFinite(opts.dpCap)) ? opts.dpCap : DEFAULT_DP_CAP;
  const cpuCap = (opts && Number.isFinite(opts.cpuCap)) ? opts.cpuCap : DEFAULT_CPU_CAP;
  // common prefix
  let p = 0; const n = base.length, m = auth.length;
  while (p < n && p < m && rowKey(base[p]) === rowKey(auth[p])) p++;
  // common suffix
  let sb = n, sa = m;
  while (sb > p && sa > p && rowKey(base[sb - 1]) === rowKey(auth[sa - 1])) { sb--; sa--; }
  const B = base.slice(p, sb), A = auth.slice(p, sa);
  const out = [];
  for (let k = 0; k < p; k++) out.push(_pickCommon(base[k], auth[k]));   // matched prefix (apply pick)
  if (!A.length) { for (let i = 0; i < B.length; i++) out.push(B[i]); }
  else if (!B.length) { for (let j = 0; j < A.length; j++) out.push(A[j]); } // insert the whole gap
  else {
    const prod = B.length * A.length;
    if (prod <= dpCap) {                                        // exact DP — fast + simple (realistic path)
      const bi = B.length, aj = A.length;
      // Precompute keys: rowKey normalises full message text (regex), so calling it per DP
      // cell made a near-dpCap middle block the event loop for minutes ([DPKEYS_V1]).
      const bk = B.map(rowKey), ak = A.map(rowKey);
      const dp = Array.from({ length: bi + 1 }, () => new Int32Array(aj + 1));
      for (let i = bi - 1; i >= 0; i--) for (let j = aj - 1; j >= 0; j--)
        dp[i][j] = (bk[i] === ak[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      let i = 0, j = 0;
      while (i < bi && j < aj) {
        if (bk[i] === ak[j]) { out.push(_pickCommon(B[i], A[j])); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(B[i]); i++; }   // base-only row: keep
        else { out.push(A[j]); j++; }                                     // auth-only row: insert
      }
      while (i < bi) out.push(B[i++]);
      while (j < aj) out.push(A[j++]);
    } else if (prod <= cpuCap) {                                // large middle — Hirschberg: same order-preserving alignment, O(min) MEMORY
      if (typeof console !== 'undefined') console.log('[Bridge] [ROOM_RECOVER_V1] merge: middle ' + B.length + '×' + A.length + ' > dpCap ' + dpCap + ' — Hirschberg linear-memory alignment');
      _mergeFromPairs(B, A, _lcsPairsHirschberg(B, A), out);
    } else {                                                    // pathological — O(|B|+|A|) merge: bounds CPU so the event loop can't block
      if (typeof console !== 'undefined') console.log('[Bridge] [ROOM_RECOVER_V1] merge: middle ' + B.length + '×' + A.length + ' > cpuCap ' + cpuCap + ' — O(|B|+|A|) order-preserving merge (non-minimal, responsive)');
      _linearSupersequence(B, A, out);
    }
  }
  const suffixLen = n - sb;                                 // === m - sa
  for (let x = 0; x < suffixLen; x++) out.push(_pickCommon(base[sb + x], auth[sa + x]));   // matched suffix (apply pick)
  return out;
}

// Resolve a room's authoritative history by merging its stored UI copy (base, under
// historyKey) with the projection of its transcript (transcriptId). historyKey and
// transcriptId are DISTINCT parameters so the chatData entry and the .jsonl file are
// never conflated — the caller controls each independently.
async function resolveRoomHistory(historyKey, transcriptId, chatData, transcriptsDir, opts) {
  opts = opts || {};
  const base = (chatData[historyKey] && Array.isArray(chatData[historyKey].messages)) ? chatData[historyKey].messages : [];
  const filePath = (opts.path) || (transcriptsDir + '/' + transcriptId + '.jsonl');
  let proj; try { proj = await getProjection(filePath); } catch { proj = { rows: [] }; }
  return mergeInsertOnly(base, proj.rows, opts);
}

module.exports = {
  projectEvents, newProjectionState, parseJsonl, getProjection,
  mergeInsertOnly, resolveRoomHistory, rowKey, TOOL_MID, _projCache,
};
