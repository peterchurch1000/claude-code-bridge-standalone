// Per-room tab shim for the bridge's Playwright MCP.
//
// One public MCP endpoint multiplexed by URL path /mcp/<roomId>. All rooms share
// ONE upstream Playwright MCP (one Chrome, one CDP, one port). Each room is pinned
// to its own browser tab; a room's tool calls always run against that tab, so rooms
// browse independently while sharing the one logged-in browser context (cookies).
//
// Tab identity is tracked by CDP targetId (stable across navigation and robust to
// the human opening/closing tabs in the visible noVNC view) — NOT by list index,
// which shifts. A raw CDP WebSocket mirrors Chrome's page-target attach order, which
// is the same order the MCP's browser_tabs uses, so we translate targetId -> index
// only at select time.
//
// Env: SHIM_PORT (listen), UPSTREAM (MCP url), CDP_URL (http://host:port).
const http = require('http');
const WebSocket = require('ws');

const UPSTREAM  = process.env.UPSTREAM  || 'http://localhost:8951/mcp';
const CDP_URL   = process.env.CDP_URL   || 'http://127.0.0.1:9241';
const PORT      = parseInt(process.env.SHIM_PORT || '8961');

let upstreamSid = null, toolsCache = null;
const rooms = new Map();               // roomId -> { targetId }
const roomAlias = new Map();           // viewer key (promoted session id) -> canonical (draft) roomId
const evictedTabs = new Set();         // targetIds detached by LRU eviction; reaper CDP-closes any whose Playwright close failed
// Persist roomAlias across shim restarts/flaps. The bridge POSTs the draft->session
// alias only once (at promotion), so an in-memory-only map is silently lost on every
// respawn — breaking the live viewer until manually re-aliased. Reload it on boot and
// rewrite the file on every change so a flap self-heals. [SHIM_ALIAS_PERSIST_V1]
const ALIAS_FILE = process.env.SHIM_ALIAS_FILE || require('path').join(process.env.HOME || '/home/bridge-peter', '.claude', 'shim-room-aliases.json');
function saveAliases() {
  try { require('fs').writeFileSync(ALIAS_FILE, JSON.stringify([...roomAlias]), 'utf8'); } catch (e) {}
}
try {
  for (const [a, c] of JSON.parse(require('fs').readFileSync(ALIAS_FILE, 'utf8'))) if (a && c) roomAlias.set(a, c);
} catch (e) {}
let chain = Promise.resolve();
// The room whose tool call currently holds the floor (set on each tools/call).
// A page-spawned tab (no opener) is almost always a side-effect of THIS room's
// action, so we attribute otherwise-ownerless new tabs to it. expectingNewTab
// suppresses that attribution while an EXPLICIT browser_tabs 'new' is in flight
// (that path adds the tab itself — attributing too would double-add).
let activeRoom = null;
let expectingNewTab = false;
// [SHIM_ATTRIB_RECENCY_V1] Max age of activeRoom's last MCP call for it to still
// "own" an openerless new tab. Beyond this the room is idle and the tab is almost
// certainly foreign (e.g. an autonomy CDP drainer's ctx.newPage()), so leave it ORPHAN.
const ATTRIB_WINDOW_MS = Number(process.env.SHIM_ATTRIB_WINDOW_MS) || 15000;
// Global mutex: every tab create / select / forwarded call is serialised so the
// upstream MCP's single "active tab" pointer can't be raced between rooms.
const lock = (fn) => { const r = chain.then(fn, fn); chain = r.then(() => {}, () => {}); return r; };
const log = (...a) => console.log('[shim]', ...a);

/* ---------- CDP target tracking (page-target order == MCP tab index order) ---------- */
let pageTargets = [];                   // ordered targetIds of type 'page'
const targetUrl = new Map();            // targetId -> last known url (for order resync)
// Set true whenever the page-target set changes (tab open/close, relay own-window,
// session reinit). selectCurrent lazily re-syncs pageTargets -> MCP index order ONCE
// per change (amortised), so index translation self-corrects after the churn that
// causes drift WITHOUT paying an upstream round-trip on every forwarded call.
let orderDirty = true;
let cdpWs = null, cdpReady = null, cdpId = 0;
const cdpPending = new Map();

function cdpSend(method, params) {
  const id = ++cdpId;
  cdpWs.send(JSON.stringify({ id, method, params: params || {} }));
  return new Promise((res, rej) => cdpPending.set(id, { res, rej }));
}
async function connectCDP() {
  const r = await fetch(`${CDP_URL}/json/version`);
  const wsUrl = (await r.json()).webSocketDebuggerUrl;
  await new Promise((resolve, reject) => {
    cdpWs = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    cdpWs.on('open', resolve);
    cdpWs.on('error', reject);
    cdpWs.on('message', (data) => {
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.id && cdpPending.has(m.id)) { const p = cdpPending.get(m.id); cdpPending.delete(m.id); return m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
      if (m.method === 'Target.targetCreated')     addTarget(m.params.targetInfo);
      else if (m.method === 'Target.targetInfoChanged') addTarget(m.params.targetInfo);
      else if (m.method === 'Target.targetDestroyed')   removeTarget(m.params.targetId);
      else if (m.method === 'Target.targetCrashed')      onTargetCrashed(m.params.targetId);
    });
    cdpWs.on('close', () => { log('CDP socket closed — reconnecting'); cdpReady = null; pageTargets = []; setTimeout(ensureCDP, 1000); });
  });
  // setDiscoverTargets replays targetCreated for all existing targets (seeds order).
  await cdpSend('Target.setDiscoverTargets', { discover: true });
  log('CDP connected;', pageTargets.length, 'page target(s)');
}
function addTarget(ti) {
  if (ti.type !== 'page') { removeTarget(ti.targetId); return; }
  const isNew = !pageTargets.includes(ti.targetId);
  if (isNew) { pageTargets.push(ti.targetId); orderDirty = true; }
  if (ti.url != null) targetUrl.set(ti.targetId, ti.url);
  // Page-initiated popup (window.open / target=_blank / OAuth-SSO login window):
  // attribute it to the room that owns its opener so it appears in that room's tab
  // strip AND the live view follows it. Only on first sight, only when it has an
  // opener we recognise as a room tab, and only if not already owned. An explicit
  // browser_tabs 'new' tab has no openerId, so this never double-adds with handleTabs.
  if (isNew) attributeNewTab(ti);
}
// Resolve ownership of a freshly-seen page target, best signal first:
//  (a) opener match  -> the room owning ti.openerId adopts it (true popup/window.open);
//  (b) active room    -> the room currently holding the mutex spawned it (covers
//      rel=noopener links, Gmail compose-in-window, OAuth redirects — NO openerId);
//  (c) neither        -> genuine ORPHAN (logged, left for the monitor/reaper).
// Skipped while an explicit browser_tabs 'new' is in flight (that path owns the tab).
/* ---------- [SHIM_OWNERSHIP_PERSIST_V1] room->tab-URL ownership persistence ----------
   The in-memory `rooms` map (tab ownership) is lost on every shim respawn, so after a
   restart every pre-existing tab is seen as new and falls to ORPHAN — then the first
   active room claims it, STEALING a concurrent room's tab and blanking its live view.
   Persist each room's tab URLs; on boot re-bind orphan tabs to their original room by
   URL (during a short adoption window) so no tab is lost or hijacked. */
const OWNERSHIP_FILE = process.env.SHIM_OWNERSHIP_FILE || require('path').join(process.env.HOME || '/home/bridge-peter', '.claude', 'shim-room-ownership.json');
const REBIND_WINDOW_MS = parseInt(process.env.SHIM_REBIND_WINDOW_MS || '60000', 10);
const _ownBootTs = Date.now();
const persistedOwnerByUrl = new Map();   // url -> roomId (only URLs with a single prior owner)
const persistedCurByRoom  = new Map();   // roomId -> its current tab's url
try {
  const raw = JSON.parse(require('fs').readFileSync(OWNERSHIP_FILE, 'utf8'));
  const owners = new Map();               // url -> Set(roomId)
  for (const [rid, o] of raw) {
    if (o && o.cur) persistedCurByRoom.set(rid, o.cur);
    for (const u of (o && o.urls) || []) { if (!u || u === 'about:blank') continue; if (!owners.has(u)) owners.set(u, new Set()); owners.get(u).add(rid); }
  }
  for (const [u, set] of owners) if (set.size === 1) persistedOwnerByUrl.set(u, [...set][0]);
  if (persistedOwnerByUrl.size) log('loaded', persistedOwnerByUrl.size, 'persisted tab-ownership URL(s) for post-restart re-bind');
} catch (e) {}
function saveOwnership() {
  try {
    const out = [];
    for (const [rid, rt] of rooms) {
      if (!rt.tabs || !rt.tabs.length) continue;
      const urls = rt.tabs.map(t => targetUrl.get(t)).filter(u => u && u !== 'about:blank');
      if (!urls.length) continue;
      out.push([rid, { urls, cur: (rt.current && targetUrl.get(rt.current)) || null }]);
    }
    require('fs').writeFileSync(OWNERSHIP_FILE, JSON.stringify(out), 'utf8');
  } catch (e) {}
}
const _ownTimer = setInterval(saveOwnership, 5000); if (_ownTimer.unref) _ownTimer.unref();
function ownedByAny(tid) { for (const [, rt] of rooms) if (rt.tabs && rt.tabs.includes(tid)) return true; return false; }
// [SHIM_STICKY_DOMAINS_V1] Authenticated / session-bearing tabs (webmail, OAuth, WhatsApp)
// must never be silently LRU-evicted or re-attributed to another room — losing one drops a
// live login and forces a re-auth. Configurable via SHIM_STICKY_DOMAINS (comma list).
const STICKY_DOMAINS = (process.env.SHIM_STICKY_DOMAINS ||
  'mail.google.com,accounts.google.com,outlook.cloud.microsoft,outlook.office.com,outlook.office365.com,login.microsoftonline.com,web.whatsapp.com')
  .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
function stickyDomainOf(u) { if (!u) return null; u = String(u).toLowerCase(); return STICKY_DOMAINS.find(d => u.includes(d)) || null; }
function isStickyUrl(u) { return !!stickyDomainOf(u); }
function sameStickyDomain(a, b) { const x = stickyDomainOf(a); return !!x && x === stickyDomainOf(b); }
function tabIsSticky(rt, tid) { return isStickyUrl(targetUrl.get(tid) || (rt && rt.current === tid ? rt.lastUrl : null)); }
function roomIsSticky(rt) {
  if (!rt || !rt.tabs) return false;
  if (isStickyUrl(rt.lastUrl)) return true;
  for (const t of rt.tabs) if (isStickyUrl(targetUrl.get(t))) return true;
  return false;
}
function attributeNewTab(ti) {
  if (ownedByAny(ti.targetId)) return;
  // (a) opener match
  if (ti.openerId) {
    for (const [room, rt] of rooms) {
      if (rt.tabs && rt.tabs.includes(ti.openerId)) {
        rt.tabs.push(ti.targetId); rt.current = ti.targetId;
        log('room', room, 'adopted popup', ti.targetId, 'from opener', ti.openerId, '(now', rt.tabs.length, 'tabs)');
        return;
      }
    }
  }
  // [SHIM_OWNERSHIP_PERSIST_V1] Re-bind by URL to the room that owned this tab before a
  // restart — takes priority over active-room attribution so a resuming room can't steal
  // a concurrent room's tab. Only within the post-boot adoption window, only for an
  // unambiguous single-owner URL, never mid explicit 'new'. Consume the URL (re-bind one).
  if (!expectingNewTab && (Date.now() - _ownBootTs) < REBIND_WINDOW_MS && ti.url && persistedOwnerByUrl.has(ti.url)) {
    const rid = persistedOwnerByUrl.get(ti.url);
    let rt = rooms.get(rid);
    if (!rt) { rt = { tabs: [], current: null, lastUrl: null, lastUsed: 0 }; rooms.set(rid, rt); }
    rt.tabs.push(ti.targetId);
    if (persistedCurByRoom.get(rid) === ti.url || !rt.current) rt.current = ti.targetId;
    rt.lastUrl = ti.url;
    persistedOwnerByUrl.delete(ti.url);
    log('re-bound orphan tab', ti.targetId, 'url', (ti.url || '').slice(0, 60), '-> room', rid, '(post-restart ownership)');
    return;
  }
  // (b) active-room attribution (skip while an explicit 'new' is being added by its handler)
  if (!expectingNewTab && activeRoom) {
    const rt = rooms.get(activeRoom);
    // [SHIM_STICKY_DOMAINS_V1] A tab that arrives already on a session/auth domain must not
    // be glued onto whatever room held the floor. Hand it to the room already on that same
    // domain; if none (and the floor-holder isn't on it either) leave it ORPHAN, never mis-own.
    if (isStickyUrl(ti.url)) {
      for (const [room2, r2] of rooms) {
        if (r2 !== rt && sameStickyDomain(r2.lastUrl, ti.url)) {
          r2.tabs.push(ti.targetId); r2.current = ti.targetId; r2.lastUrl = ti.url;
          log('room', room2, 'claimed sticky tab', ti.targetId, 'url', ti.url, '(domain match)');
          return;
        }
      }
      if (!(rt && sameStickyDomain(rt.lastUrl, ti.url))) {
        log('ORPHAN sticky tab', ti.targetId, 'url', ti.url, '- floor-holder', activeRoom, 'not on this domain; not gluing');
        return;
      }
    }
    // [SHIM_ATTRIB_RECENCY_V1] Only adopt an openerless tab if this room is genuinely
    // MID-ACTION. The deterministic CDP drainers (autonomy-*-drain.js) open tabs via
    // ctx.newPage() straight over CDP, bypassing the shim mount, so they never refresh
    // any room's lastUsed. Without this gate their tabs get glued onto whichever room
    // last held the floor, hijacking its `current` and cross-contaminating its live pane.
    if (rt && rt.current && rt.lastUsed && (Date.now() - rt.lastUsed) < ATTRIB_WINDOW_MS) {
      rt.tabs.push(ti.targetId); rt.current = ti.targetId;
      log('room', activeRoom, 'attributed new tab', ti.targetId, '(no opener) url', ti.url || '(none)', '- now', rt.tabs.length, 'tabs');
      return;
    }
  }
  // (c) orphan
  log('ORPHAN new tab', ti.targetId, 'opener', ti.openerId || '(none)', 'url', ti.url || '(none)', '- no room owns it');
}
function removeTarget(id) {
  const i = pageTargets.indexOf(id); if (i >= 0) { pageTargets.splice(i, 1); orderDirty = true; }
  targetUrl.delete(id);
  for (const [room, rt] of rooms) {
    if (rt.tabs && rt.tabs.includes(id)) {
      rt.tabs = rt.tabs.filter(t => t !== id);
      if (rt.current === id) rt.current = rt.tabs[rt.tabs.length - 1] || null;
      // Keep the room entry (do NOT delete) so its lastUrl survives: a session
      // 404 -> reinit can make Playwright close the room's page out from under
      // us; on next use ensureRoomTab re-creates the tab and restores lastUrl.
      // Only admin/close removes a room for good.
      if (rt.tabs.length === 0) log('room', room, 'lost its tab externally — will re-create' + (rt.lastUrl ? ' + restore ' + rt.lastUrl : ''));
      else log('room', room, 'a tab closed externally');
    }
  }
}
function ensureCDP() { if (!cdpReady) cdpReady = connectCDP().catch(e => { cdpReady = null; log('CDP connect failed:', e.message); }); return cdpReady; }

// CDP-close a page target directly over the DevTools HTTP endpoint. This works even
// while Playwright's browser_tabs is wedged on a poisoned tab, so it's the lever for
// evicting a bad tab WITHOUT restarting the whole browser stack.
async function cdpCloseTarget(id) {
  try { await fetch(`${CDP_URL}/json/close/${id}`); return true; } catch { return false; }
}
// [SHIM_CRASH_AUTOCLOSE_V1] A crashed renderer is NOT destroyed — Chrome keeps the
// page target alive as a zombie, so Playwright's browser_tabs re-attaches to it and
// blocks for its full 30s timeout on EVERY call (the poisoned-tab wedge). CDP
// /json/close still reaps it, so close it the instant we see the crash — before it can
// wedge browser_tabs — then drop our tracking. Never close the last remaining page
// (that would kill the window); the watchdog's renderer sweep is the backstop for that
// rare case. See [[wedge-poisoned-duplicate-tab]].
function onTargetCrashed(id) {
  if (pageTargets.length > 1) {
    log('target crashed', id, '- CDP-closing zombie tab before it wedges browser_tabs');
    cdpCloseTarget(id).catch(() => {});
  } else {
    log('target crashed', id, '- last page, leaving for watchdog sweep');
  }
  removeTarget(id);
}

// Add-only reconcile of pageTargets against Chrome's authoritative /json list.
// The CDP websocket can drop a Target.targetCreated during churn, leaving a real
// page untracked; this HTTP snapshot re-seeds it. Never removes (pruning stays
// with removeTarget), so it can't disturb another room mid-op.
async function refreshTargetsHTTP() {
  try {
    const r = await fetch(`${CDP_URL}/json`);
    for (const t of await r.json()) {
      if (t.type !== 'page') continue;
      const isNew = !pageTargets.includes(t.id);
      if (isNew) { pageTargets.push(t.id); orderDirty = true; log('HTTP re-fetch recovered untracked target', t.id); }
      if (t.url != null) targetUrl.set(t.id, t.url);
      if (isNew) attributeNewTab({ targetId: t.id, openerId: t.openerId || null, url: t.url });
    }
  } catch (e) { log('refreshTargetsHTTP failed:', String(e && e.message || e)); }
}

/* ---------- upstream MCP (Streamable HTTP / SSE) ---------- */
function parseSSE(t) { let o = null; for (const l of t.split('\n')) { const m = l.match(/^data: (.*)$/); if (m) { try { o = JSON.parse(m[1]); } catch {} } } return o; }
async function up(body) {
  const h = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  if (upstreamSid) h['Mcp-Session-Id'] = upstreamSid;
  const r = await fetch(UPSTREAM, { method: 'POST', headers: h, body: JSON.stringify(body) });
  if (r.status !== 200 && process.env.SHIM_DEBUG) log('up() status', r.status, 'for', body.method || (body.params && body.params.name));
  if (r.status === 404 && upstreamSid) { closeUpStream(); upstreamSid = null; throw new Error('upstream session expired'); }
  const sid = r.headers.get('mcp-session-id'); if (sid) upstreamSid = sid;
  return parseSSE(await r.text());
}
function closeUpStream() {}
async function ensureUpstream() {
  if (upstreamSid) return;
  await up({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'shim', version: '1' } } });
  await up({ jsonrpc: '2.0', method: 'notifications/initialized' });
  log('upstream MCP session initialised');
}
const tool = (name, args) => up({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args || {} } });

// A poisoned upstream session (404) or a Playwright "page closed" error is
// recoverable: drop the session, re-initialise, and re-run the operation once.
// Handles the human closing (in the visible noVNC view) the very tab the MCP is
// bound to. Catches both thrown errors and JSON-RPC error results.
const isTransient = (s) => /session expired|has been closed|Target page|Session closed|browser has disconnected|not found|Invalid session/i.test(s || '');
// After a reinit the fresh session's browser_tabs index order is authoritative but
// may not equal our creation-ordered pageTargets (external tab-close + session
// churn can diverge them). Rebuild pageTargets to match the MCP list by URL, so
// index translation in selectCurrent stays correct. Order-independent, self-healing.
async function resyncOrder() {
  try {
    const r = await up({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_tabs', arguments: { action: 'list' } } });
    const text = ((r && r.result && r.result.content) || []).map(x => x.text).join('\n');
    const urls = [];
    for (const l of text.split('\n')) { const m = l.match(/^\s*-\s*\d+:.*\(([^)]*)\)\s*$/); if (m) urls.push(m[1]); }
    if (!urls.length) { log('resyncOrder: empty MCP list — keeping current order'); return false; }
    // Recover any page target the CDP websocket missed, so the match below can
    // account for every url the MCP lists (LOCAL /json, not an upstream call).
    await refreshTargetsHTTP();
    // Rebuild pageTargets to Playwright's browser_tabs order by matching url in
    // list order. Same-url tabs (e.g. multiple about:blank) resolve to the first
    // remaining pool entry — creation order, which Playwright's context.pages()
    // also preserves, so duplicates stay aligned.
    const pool = pageTargets.slice(), ordered = [];
    for (const u of urls) {
      const idx = pool.findIndex(t => (targetUrl.get(t) || '') === u);
      // A listed url we can't map would shift every later index vs Playwright's,
      // making it WORSE than not reordering. Bail (keep order, stay dirty, retry
      // later) — strictly non-regressive relative to the old count-mismatch skip.
      if (idx < 0) { log('resyncOrder: unmatched listed url — keeping current order'); return false; }
      ordered.push(pool.splice(idx, 1)[0]);
    }
    // Leftover targets are ones Playwright did NOT list (e.g. relay own-windows it
    // never adopted); they hold no MCP index, so append them (preserving relative
    // order) past the last addressable index. This handles the count mismatch the
    // old code bailed on, without disturbing the matched indices.
    for (const t of pool) ordered.push(t);
    pageTargets = ordered;
    orderDirty = false;
    log('resynced tab order to MCP list', `(${urls.length} listed, ${pageTargets.length} tracked)`);
    return true;
  } catch (e) { log('resyncOrder failed:', String(e && e.message || e)); return false; }
}
// ── REINIT STORM self-heal ───────────────────────────────────────────────
// A Chrome OOM-restart flaps the upstream MCP; up() then 404s -> 'session expired'
// -> reinit(), which can become a fast doom loop that keeps wiping per-room tab
// tracking (relay shows a blank pane). The watchdog only catches HANGS, not this
// fast-error storm, so it used to spin for hours until a manual shim restart.
// Detect the storm and exit(0); the supervisor respawns a clean shim in ~5s that
// gets a fresh MCP session and reloads persisted aliases — ending the loop itself.
const REINIT_STORM_MAX    = parseInt(process.env.SHIM_REINIT_STORM_MAX || '8', 10);
const REINIT_STORM_WINDOW = parseInt(process.env.SHIM_REINIT_STORM_WINDOW_MS || '120000', 10);
const _shimBootTs = Date.now();
let _reinitTs = [];
function _noteReinit() {
  const now = Date.now();
  if (now - _shimBootTs < 30000) return;                 // ignore startup churn
  _reinitTs = _reinitTs.filter(t => now - t <= REINIT_STORM_WINDOW);
  _reinitTs.push(now);
  if (_reinitTs.length >= REINIT_STORM_MAX) {
    log(`REINIT STORM: ${_reinitTs.length} upstream re-inits within ${Math.round(REINIT_STORM_WINDOW/1000)}s — session-expired doom loop; exiting for a clean supervisor respawn`);
    setTimeout(() => process.exit(0), 200);              // let the log flush
  }
}
async function reinit() { _noteReinit(); closeUpStream(); upstreamSid = null; toolsCache = null; orderDirty = true; await ensureUpstream(); await resyncOrder(); }
async function withRetry(fn) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let r;
    try { r = await fn(); }
    catch (e) { if (attempt === 0 && isTransient(String(e && e.message || e))) { log('recovering upstream (thrown):', String(e.message || e)); await reinit(); continue; } throw e; }
    if (r && r.error && attempt === 0 && isTransient(JSON.stringify(r.error))) { log('recovering upstream (result-error)'); await reinit(); continue; }
    return r;
  }
}
// Idempotent liveness check: ensure the upstream session is alive, exercising it
// with a harmless browser_tabs list. A stale session makes up() throw 'session
// expired' (404), which withRetry catches -> reinit. Safe to run any number of
// times (no side effects), so it absorbs the common "session went stale between
// turns" 404 BEFORE any non-idempotent tab mutation runs.
async function ensureSession() {
  await ensureUpstream();
  const r = await tool('browser_tabs', { action: 'list' });
  if (r && r.error && isTransient(JSON.stringify(r.error))) throw new Error('session probe: ' + JSON.stringify(r.error));
  return r;
}

/* ---------- room <-> tabs ----------
   A room owns a list of tabs (targetIds); `current` is its active tab. Every
   browser_tabs op is intercepted and re-scoped to the room-local tab set, so a
   room can neither see nor select another room's tabs (no cross-room leak). */
function pruneRoom(rt) {
  rt.tabs = rt.tabs.filter(t => pageTargets.includes(t));
  if (!rt.tabs.includes(rt.current)) rt.current = rt.tabs[rt.tabs.length - 1] || null;
}
async function newTab() {
  const before = new Set(pageTargets);
  expectingNewTab = true;
  try {
  await tool('browser_tabs', { action: 'new' });
  // Wait for the freshly-created page target to register in CDP. NEVER fall back
  // to an existing tab — that would alias another room onto this room's tab
  // (two rooms sharing one targetId => cross-room clobber + spurious "freed").
  for (let i = 0; i < 200; i++) {                // up to ~10s
    const added = pageTargets.filter(t => !before.has(t));
    if (added.length) return added[added.length - 1];
    // Every ~1s, reconcile against Chrome's /json in case the websocket dropped
    // the Target.targetCreated event for this new page.
    if (i > 0 && i % 20 === 0) await refreshTargetsHTTP();
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('new tab did not register in CDP');
  } finally { expectingNewTab = false; }
}
// Bounded tab pool: cap total live tabs across ALL rooms so hundreds of task rooms
// can't each hold a Chrome tab. When a room needs a tab and we're at the cap, evict
// the least-recently-used IDLE room's tab (never the requester, never the room
// holding the floor). ensureRoomTab restores the evicted room's lastUrl on its next
// use, so eviction is transparent. Tunable via SHIM_MAX_TABS or ~/.claude/shim-max-tabs;
// 0 disables the cap.
function readMaxTabs() {
  let v = process.env.SHIM_MAX_TABS;
  if (v == null || v === '') { try { v = require('fs').readFileSync(require('path').join(process.env.HOME || '', '.claude', 'shim-max-tabs'), 'utf8').trim(); } catch { v = ''; } }
  const n = parseInt(v || '8'); return Number.isFinite(n) ? n : 8;
}
const MAX_ROOM_TABS = readMaxTabs();
// [SHIM_STICKY_DOMAINS_V1] Sticky (logged-in) tabs are exempt from the cap: a handful of
// webmail/WhatsApp sessions must not push transient task tabs into forced eviction.
function liveTabCount() { let n = 0; for (const rt of rooms.values()) if (rt.tabs) for (const t of rt.tabs) if (!tabIsSticky(rt, t)) n++; return n; }
async function evictIfNeeded(keepRoom) {
  if (MAX_ROOM_TABS <= 0) return;
  let guard = 0;
  while (liveTabCount() >= MAX_ROOM_TABS && guard++ < 64) {
    let vkey = null, victim = null, oldest = Infinity;
    for (const [rk, rt] of rooms) {
      if (rk === keepRoom || rk === activeRoom) continue;        // never evict requester / floor-holder
      if (roomIsSticky(rt)) continue;                            // [SHIM_STICKY_DOMAINS_V1] never evict a live login/webmail tab
      if (!rt.tabs || !rt.tabs.length) continue;
      const lu = rt.lastUsed || 0;
      if (lu < oldest) { oldest = lu; victim = rt; vkey = rk; }
    }
    if (!victim) break;   // nothing idle to evict -> allow briefly over cap rather than deadlock
    for (const tid of victim.tabs.slice()) {
      const g = pageTargets.indexOf(tid);
      if (g >= 0) { try { await tool('browser_tabs', { action: 'select', index: g }); await tool('browser_tabs', { action: 'close' }); } catch {} }
      evictedTabs.add(tid);   // if the Playwright close above silently failed (browser slow/wedged),
                              // the reaper CDP-closes it later so evicted tabs can't leak + accumulate
    }
    victim.tabs = []; victim.current = null; orderDirty = true;
    log('evicted idle room', vkey, '(LRU) to stay within', MAX_ROOM_TABS, 'tabs; restores', victim.lastUrl || 'about:blank', 'on next use');
  }
}
async function ensureRoomTab(room) {
  await ensureUpstream();
  await ensureCDP();
  let rt = rooms.get(room);
  if (rt) { pruneRoom(rt); rt.lastUsed = Date.now(); if (rt.current) return rt; }
  else { rt = { tabs: [], current: null, lastUrl: null, lastUsed: Date.now() }; rooms.set(room, rt); }
  await evictIfNeeded(room);           // stay within the tab budget before opening a new tab
  const tid = await newTab();
  rt.tabs.push(tid); rt.current = tid;
  await selectCurrent(rt);
  // Restore the room's last page if its tab was lost to a reinit; else blank.
  const restore = rt.lastUrl || 'about:blank';
  await tool('browser_navigate', { url: restore });
  log('room', room, '-> tab', tid, '(index', pageTargets.indexOf(tid) + ')', rt.lastUrl ? 'restored ' + restore : '');
  return rt;
}
async function selectCurrent(rt) {
  // Re-sync index order ONLY when the target set changed since the last select
  // (orderDirty). Steady-state navigate/click on an unchanged tab set pays no
  // upstream round-trip here — the drift fix without the per-call cost that
  // regressed the earlier attempt.
  if (orderDirty) await resyncOrder();
  const idx = pageTargets.indexOf(rt.current);
  if (idx < 0) throw new Error('room tab vanished');
  await tool('browser_tabs', { action: 'select', index: idx });
}

// Intercept browser_tabs and present a room-local view (indices 0..n within the
// room only). list/select/new/close all operate on the room's own tabs.
function parseTabList(text) {
  const map = new Map();   // global index -> label ("Title - URL")
  for (const l of (text || '').split('\n')) {
    const m = l.match(/^\s*-\s*(\d+):\s*(?:\(current\)\s*)?(.*)$/);
    if (m) map.set(parseInt(m[1]), m[2].trim());
  }
  return map;
}
async function roomTabList(rt) {
  // Read the upstream tab list through withRetry: a first-call-after-idle stale
  // session makes this raw read 404 ('session expired') and return empty, which
  // would silently render a live room as having NO tabs. Retry heals it (a list
  // read is idempotent, so re-running after reinit is safe).
  const listRes = await withRetry(() => tool('browser_tabs', { action: 'list' }));
  const full = ((listRes && listRes.result) || {}).content || [];
  const map = parseTabList(full.map(x => x.text).join('\n'));
  const lines = rt.tabs.map((tid, i) => `- ${i}:${tid === rt.current ? ' (current)' : ''} ${map.get(pageTargets.indexOf(tid)) || '(tab)'}`);
  return { content: [{ type: 'text', text: lines.join('\n') || '- (no tabs)' }] };
}
async function handleTabs(room, rt, args) {
  const action = args && args.action;
  if (action === 'select') {
    const i = args.index;
    if (i == null || i < 0 || i >= rt.tabs.length) return { content: [{ type: 'text', text: `Error: this room has no tab ${i}` }], isError: true };
    rt.current = rt.tabs[i]; await selectCurrent(rt);
    return roomTabList(rt);
  }
  if (action === 'new') {
    await evictIfNeeded(room);
    const tid = await newTab(); rt.tabs.push(tid); rt.current = tid;
    await selectCurrent(rt); await tool('browser_navigate', { url: 'about:blank' });
    log('room', room, 'opened tab', tid, '(now', rt.tabs.length, 'tabs)');
    return roomTabList(rt);
  }
  if (action === 'close') {
    const i = (args.index == null) ? rt.tabs.indexOf(rt.current) : args.index;
    const tid = rt.tabs[i];
    if (tid == null) return { content: [{ type: 'text', text: `Error: this room has no tab ${i}` }], isError: true };
    const g = pageTargets.indexOf(tid);
    if (g >= 0) { await tool('browser_tabs', { action: 'select', index: g }); await tool('browser_tabs', { action: 'close' }); }
    rt.tabs = rt.tabs.filter(t => t !== tid);
    if (rt.current === tid) rt.current = rt.tabs[rt.tabs.length - 1] || null;
    if (rt.tabs.length === 0) { const n = await newTab(); rt.tabs.push(n); rt.current = n; }
    await selectCurrent(rt);
    return roomTabList(rt);
  }
  // list / anything else: return the room-local list.
  return roomTabList(rt);
}

/* ---------- HTTP / MCP surface ---------- */
function sse(res, sid, obj) {
  const h = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' };
  if (sid) h['Mcp-Session-Id'] = sid;
  res.writeHead(200, h);
  if (obj !== undefined) res.write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);
  res.end();
}
const server = http.createServer((req, res) => {
  const url = req.url || '';
  if (process.env.SHIM_DEBUG) log('REQ', req.method, url);
  // Read-only room->target map for the live viewer (task 190): GET /rooms returns
  // every room's current CDP targetId + tab list; GET /rooms/<room> returns one.
  // The relay (follow mode) uses `current` to pin the screencast to the exact page
  // Claude's automation is driving, so the pane shows what Claude sees. Promotion
  // aliases (draft id -> real session id) are resolved so a viewer keyed on the
  // promoted id still finds the room the MCP created under the draft key.
  if (req.method === 'GET') {
    if (url === '/rooms' || url.startsWith('/rooms?')) {
      const out = {};
      for (const [r, rt] of rooms) out[r] = { current: rt.current || null, tabs: rt.tabs || [], lastUrl: rt.lastUrl || null };
      for (const [alias, canon] of roomAlias) { const rt = rooms.get(canon); if (rt && !out[alias]) out[alias] = { current: rt.current || null, tabs: rt.tabs || [], lastUrl: rt.lastUrl || null }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    const rm = url.match(/^\/rooms\/([^/?]+)$/);
    if (rm) {
      const rk = decodeURIComponent(rm[1]);
      const rt = rooms.get(rk) || rooms.get(roomAlias.get(rk));
      res.writeHead(rt ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(rt ? { current: rt.current || null, tabs: rt.tabs || [], lastUrl: rt.lastUrl || null } : { error: 'no such room' }));
    }
  }
  // Promotion alias (draft id -> real session id): POST /admin/rekey/<old>/<new>.
  // The MCP keeps hitting /mcp/<old>; the viewer switches to <new>; this makes
  // /rooms/<new> resolve to the room still stored under <old>. Read-only for the
  // MCP path (rooms map is untouched), so tab isolation is unaffected.
  const rkm = url.match(/^\/admin\/rekey\/([^/?]+)\/([^/?]+)$/);
  if (rkm && req.method === 'POST') {
    roomAlias.set(decodeURIComponent(rkm[2]), decodeURIComponent(rkm[1]));
    saveAliases();
    log('alias', decodeURIComponent(rkm[2]), '->', decodeURIComponent(rkm[1]));
    res.writeHead(200); return res.end('ok');
  }
  // Admin room-close (bridge calls this on room teardown): POST /admin/close/<room>.
  // Frees the room mapping and closes its tab.
  const adm = url.match(/^\/admin\/close\/([^/?]+)$/);
  if (adm) {
    const room = decodeURIComponent(adm[1]);
    lock(async () => {
      const rt = rooms.get(room); rooms.delete(room);
      { let _ac = false; for (const [a, c] of roomAlias) if (c === room || a === room) { roomAlias.delete(a); _ac = true; } if (_ac) saveAliases(); }
      if (rt && rt.tabs) for (const tid of rt.tabs) {
        const g = pageTargets.indexOf(tid);
        if (g >= 0) { try { await tool('browser_tabs', { action: 'select', index: g }); await tool('browser_tabs', { action: 'close' }); } catch {} }
      }
      log('room', room, 'closed (admin)');
    });
    res.writeHead(200); return res.end('closed');
  }
  const mm = url.match(/^\/mcp\/([^/?]+)/);
  if (!mm) { res.writeHead(404); return res.end('no room'); }
  const room = decodeURIComponent(mm[1]);
  // MCP session terminate (client shutdown): keep the room's tab — the browser
  // persists between Claude invocations, so the next turn reuses the same tab.
  if (req.method === 'DELETE') { res.writeHead(200); return res.end('ok'); }
  // GET opens the server->client SSE channel. The MCP http client marks the
  // server "connected" once this stream is established, so we hold it open with
  // periodic keepalives (we never push server-initiated messages, but the channel
  // must exist). Matches the real Playwright MCP's behaviour.
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(': ok\n\n');
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
    req.on('close', () => clearInterval(ping));
    return;
  }
  let body = ''; req.on('data', c => body += c); req.on('end', async () => {
    let msg = {}; try { msg = JSON.parse(body || '{}'); } catch {}
    const id = msg.id, method = msg.method;
    try {
      if (method === 'initialize') {
        // LAZY TAB: do NOT open a browser tab at the MCP handshake. Most task rooms
        // never browse; provisioning a tab here is what piled up hundreds of idle
        // about:blank tabs (one per per-task room). A tab is created on demand by
        // the first real browser tools/call (-> ensureRoomTab). Register only the
        // room shell so /rooms + the live viewer know it exists.
        if (!rooms.has(room)) rooms.set(room, { tabs: [], current: null, lastUrl: null, lastUsed: Date.now() });
        const pv = (msg.params && msg.params.protocolVersion) || '2025-06-18';   // echo client's version
        return sse(res, `shim-${room}`, { jsonrpc: '2.0', id, result: { protocolVersion: pv, capabilities: { tools: {} }, serverInfo: { name: 'shim-per-room', version: '1' } } });
      }
      // Notifications / responses expect no reply: 202 Accepted (per MCP spec).
      if (method && method.startsWith('notifications/')) { res.writeHead(202); return res.end(); }
      if (method === 'tools/list') {
        if (!toolsCache) { await ensureUpstream(); toolsCache = await up({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }); }
        return sse(res, `shim-${room}`, { jsonrpc: '2.0', id, result: toolsCache.result });
      }
      if (method === 'tools/call') {
        const nm = msg.params.name, a = msg.params.arguments || {};
        const out = await lock(async () => {
          activeRoom = room;   // this room now holds the floor (for tab attribution)
          // Recovery is REACTIVE only (no pre-emptive session probe): sessions
          // survive idle fine, so an extra probe would just add its own 404 risk
          // -> reinit -> tab-index drift. ensureRoomTab (idempotent) is retried;
          // browser_tabs new/close are NOT idempotent (a retry would create/close
          // an extra tab), so they run exactly ONCE, never wrapped in withRetry.
          const rt = await withRetry(() => ensureRoomTab(room));
          rt.lastUsed = Date.now();   // mark recency for LRU eviction
          if (nm === 'browser_tabs') return handleTabs(room, rt, a);   // room-scoped, runs once
          // Remember the room's target page so a lost tab can be restored there.
          if (nm === 'browser_navigate' && a && a.url) rt.lastUrl = a.url;
          // Plain forwarded calls (navigate/click/evaluate/...) are safe to re-run,
          // so retry just the select+forward if the session dies mid-call.
          return withRetry(async () => { await selectCurrent(rt); return tool(nm, a); });
        });
        // Pass upstream result OR error straight through (don't swallow tool errors).
        if (out && out.error) return sse(res, `shim-${room}`, { jsonrpc: '2.0', id, error: out.error });
        // tool() returns a full JSON-RPC envelope (.result); handleTabs returns a bare result.
        return sse(res, `shim-${room}`, { jsonrpc: '2.0', id, result: (out && out.result) || out || {} });
      }
      return sse(res, `shim-${room}`, { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not handled: ' + method } });
    } catch (e) { return sse(res, `shim-${room}`, { jsonrpc: '2.0', id, error: { code: -32000, message: String(e && e.message || e) } }); }
  });
});
ensureCDP();
// NOTE: no proactive keepalive. Idle sessions survive fine (measured: 5s+), so a
// periodic probe only adds its own 404 risk -> reinit -> tab-index drift. Recovery
// is purely reactive via withRetry on real calls. Opt back in with SHIM_KEEPALIVE_MS.
const KEEPALIVE_MS = parseInt(process.env.SHIM_KEEPALIVE_MS || '0');
if (KEEPALIVE_MS > 0) setInterval(() => {
  if (rooms.size === 0 || !upstreamSid) return;
  lock(() => withRetry(ensureSession).catch(e => log('keepalive:', String(e && e.message || e))));
}, KEEPALIVE_MS);
/* ---------- upstream MCP watchdog ----------
   A wedged Playwright op HANGS rather than errors, freezing the mutex + every
   room. Probe the upstream with a bounded-timeout browser_tabs list OUTSIDE the
   mutex; on consecutive hangs kill the MCP by its pid file — start-browser.sh's
   monitor (MCP is CRITICAL) then restarts the whole stack automatically. */
const WATCHDOG_MS      = parseInt(process.env.SHIM_WATCHDOG_MS || '30000');
const WATCHDOG_TIMEOUT = parseInt(process.env.SHIM_WATCHDOG_TIMEOUT_MS || '20000');
const WATCHDOG_FAILS   = parseInt(process.env.SHIM_WATCHDOG_FAILS || '2');
const WATCHDOG_WINDOW  = parseInt(process.env.SHIM_WATCHDOG_WINDOW_MS || '180000'); // hangs count within this window, need NOT be consecutive
const POISON_PROBE_MS  = parseInt(process.env.SHIM_POISON_PROBE_MS || '4000');      // per-tab renderer-health probe timeout (crashed renderers never answer)
const MCP_PIDFILE      = process.env.MCP_PIDFILE || `${process.env.HOME}/.claude/bridge-mcp.pid`;
let wdHangs = [], wdBusy = false;
// The wedge signature is a browser op that HANGS (times out), not a fast HTTP error.
// A fast 404/session error means the MCP process is alive but proves NOTHING about the
// browser — treating it as "healthy" (old bug) reset the fail counter and masked wedges.
// Returns 'ok' (a real result came back), 'hang' (timed out = wedge), 'other' (neutral).
async function probeUpstream() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), WATCHDOG_TIMEOUT);
  try {
    const h = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    if (upstreamSid) h['Mcp-Session-Id'] = upstreamSid;
    const r = await fetch(UPSTREAM, { method: 'POST', signal: ctrl.signal, headers: h,
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'browser_tabs', arguments: { action: 'list' } } }) });
    const body = await r.text();
    return /"result"\s*:/.test(body) ? 'ok' : 'other';
  } catch (e) {
    return (e && e.name === 'AbortError') ? 'hang' : 'other';
  } finally { clearTimeout(t); }
}
// A wedge is often ONE poisoned orphan tab (LRU-evicted or dead-room leftover) whose
// crashed renderer blocks browser_tabs for the full Playwright timeout. CDP /json/close
// works even while Playwright hangs, so clear orphans first — cheaper + more targeted
// than nuking the MCP, which just re-attaches to the same bad tabs.
async function reapAllOrphans() {
  try { const r = await fetch(`${CDP_URL}/json`); const pages = (await r.json()).filter(t => t.type === 'page');
    let remaining = pages.length;
    for (const t of pages) { if (remaining <= 1) break; if (ownedByAny(t.id)) continue;
      try { await fetch(`${CDP_URL}/json/close/${t.id}`); remaining--; log('WATCHDOG reaped orphan tab', t.id, (t.url||'').slice(0,60)); } catch {} }
  } catch {}
}
// [SHIM_POISON_SWEEP_V1] Probe ONE page target's renderer over its OWN CDP websocket
// with a short timeout. A live renderer answers Runtime.evaluate near-instantly; a
// crashed/stuck one never does. Returns true = healthy, false = poisoned (timed out or
// errored). Uses the page's dedicated debugger ws so it does NOT touch the wedged
// Playwright<->browser session.
function probeRenderer(wsUrl, timeoutMs) {
  return new Promise((resolve) => {
    let done = false, ws;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(t); try { ws && ws.close(); } catch {} resolve(ok); };
    const t = setTimeout(() => finish(false), timeoutMs);
    try {
      ws = new WebSocket(wsUrl, { perMessageDeflate: false });
      ws.on('open', () => { try { ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '0', returnByValue: true } })); } catch { finish(false); } });
      ws.on('message', () => finish(true));
      ws.on('error', () => finish(false));
    } catch { finish(false); }
  });
}
// On a watchdog hang the cause is usually ONE poisoned tab whose crashed renderer
// blocks browser_tabs for the full Playwright timeout. Find it by probing every page
// target's renderer directly over CDP (works while the Playwright layer is wedged) and
// CDP-close the unresponsive ones — recovering WITHOUT a full-stack restart. Never
// closes the last remaining page. Returns how many tabs were closed.
async function reapPoisonedTabs() {
  let pages; try { pages = (await (await fetch(`${CDP_URL}/json`)).json()).filter(t => t.type === 'page'); } catch { return 0; }
  let remaining = pages.length, closed = 0;
  for (const p of pages) {
    if (remaining <= 1) break;                       // never close the last page
    if (!p.webSocketDebuggerUrl) continue;
    if (await probeRenderer(p.webSocketDebuggerUrl, POISON_PROBE_MS)) continue;   // healthy, keep
    if (await cdpCloseTarget(p.id)) {
      remaining--; closed++;
      removeTarget(p.id);                            // drop tracking + detach from its room (re-creates on next use)
      log('WATCHDOG closed poisoned tab', p.id, (p.url||'').slice(0,60));
    }
  }
  return closed;
}
function restartUpstream() {
  reapAllOrphans().catch(() => {});
  try { const pid = parseInt(require('fs').readFileSync(MCP_PIDFILE, 'utf8').trim());
    if (pid > 0) { process.kill(pid, 'SIGKILL'); log('WATCHDOG killed wedged MCP pid', pid, '— monitor restarts stack'); }
  } catch (e) { log('WATCHDOG cannot kill MCP:', String(e && e.message || e)); }
}
if (WATCHDOG_MS > 0) setInterval(async () => {
  if (wdBusy || rooms.size === 0 || !upstreamSid) return;
  wdBusy = true;
  try {
    const s = await probeUpstream();
    if (s === 'ok') { wdHangs = []; }
    else if (s === 'hang') {
      const now = Date.now();
      wdHangs = wdHangs.filter(ts => now - ts <= WATCHDOG_WINDOW); wdHangs.push(now);
      log(`WATCHDOG browser op hung (${wdHangs.length}/${WATCHDOG_FAILS} within ${Math.round(WATCHDOG_WINDOW/1000)}s)`);
      // Targeted recovery FIRST: a hang is almost always one poisoned tab. Close it
      // directly via CDP (no stack restart, goal of task-327). If that clears a bad
      // tab, reset the counter and re-probe next tick before considering an MCP kill.
      const closed = await reapPoisonedTabs();
      if (closed) { log('WATCHDOG poisoned-tab sweep closed', closed, 'tab(s) — no MCP restart, re-probing next tick'); wdHangs = []; }
      else if (wdHangs.length >= WATCHDOG_FAILS) { restartUpstream(); wdHangs = []; }
    }
    // 'other' = fast session/HTTP error: neutral, neither health nor a hang.
  } finally { wdBusy = false; }
}, WATCHDOG_MS);

/* ---------- orphan blank-tab reaper ----------
   noopener redirects / the live viewer can leave about:blank page targets owned by
   NO room (attributeNewTab case (c)). Room teardown never closes them, so they
   slowly accumulate. Periodically close blank tabs that no room owns. Owned tabs
   and any non-blank page are always left alone, and the last remaining page is
   never closed (that would kill the window). Runs inside the mutex so it can't race
   tab creation; skipped while a 'new' tab is being born. */
const REAPER_MS = parseInt(process.env.SHIM_REAPER_MS || '90000');
// Two orphan sources, handled differently so we NEVER close a pre-existing / user tab:
//  (a) about:blank ownerless tabs (noopener redirects, live viewer) — safe to close on sight.
//  (b) tabs THIS shim evicted (evictedTabs) whose Playwright close silently failed because the
//      browser was slow/wedged — CDP-close them directly (works even while Playwright hangs).
// Tabs the shim never owned (pre-existing on restart, the calendar draft, etc.) are left alone.
async function reapOrphans() {
  let list; try { const r = await fetch(`${CDP_URL}/json`); list = await r.json(); } catch { return; }
  const pages = list.filter(t => t.type === 'page');
  const present = new Set(pages.map(t => t.id));
  for (const id of [...evictedTabs]) if (!present.has(id) || ownedByAny(id)) evictedTabs.delete(id);
  let remaining = pages.length;
  for (const t of pages) {
    if (remaining <= 1) break;                 // never close the last page
    if (ownedByAny(t.id)) continue;            // owned by a room -> keep
    const blank = t.url === 'about:blank' || !t.url;
    if (blank || evictedTabs.has(t.id)) {
      try { await fetch(`${CDP_URL}/json/close/${t.id}`); remaining--; evictedTabs.delete(t.id);
        log('reaped orphan', blank ? 'blank' : 'evicted', 'tab', t.id, (t.url||'').slice(0,60)); } catch {}
    }
  }
}
if (REAPER_MS > 0) setInterval(() => {
  if (expectingNewTab) return;
  lock(() => reapOrphans().catch(e => log('reaper:', String(e && e.message || e))));
}, REAPER_MS);
/* ---------- dead room-entry reaper ----------
   A room entry is deliberately KEPT after it loses its tabs so its lastUrl
   survives a session reinit (ensureRoomTab restores it on next use). But rooms
   that were opened, lost every tab, AND have no lastUrl to restore are genuinely
   dead: they just accumulate in the map and give the live viewer more empty rooms
   to mishandle. Drop them once idle a while. A fresh lastUsed protects a room
   mid-creation; a real lastUrl marks a restorable/dormant room we must keep. */
const DEAD_ROOM_MS = parseInt(process.env.SHIM_DEAD_ROOM_MS || '900000'); // 15 min
if (DEAD_ROOM_MS > 0) setInterval(() => {
  const now = Date.now();
  for (const [key, rt] of rooms) {
    const noTabs = !rt.tabs || rt.tabs.length === 0;
    if (noTabs && !rt.current && !rt.lastUrl && now - (rt.lastUsed || 0) > DEAD_ROOM_MS) {
      rooms.delete(key);
      log('reaped dead room entry', key, '(no tabs / no lastUrl, idle', Math.round((now - (rt.lastUsed || 0)) / 1000) + 's)');
    }
  }
}, Math.min(DEAD_ROOM_MS, 300000)); // check at least every 5 min

server.listen(PORT, '127.0.0.1', () => log(`listening ${PORT}, upstream ${UPSTREAM}, cdp ${CDP_URL}, maxTabs ${MAX_ROOM_TABS}, reaper ${REAPER_MS}ms`));
