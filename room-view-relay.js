#!/usr/bin/env node
/*
 * room-view-relay.js — per-room live viewer over CDP, from ONE shared Chrome.
 *
 * Replaces per-room noVNC (which streams the whole X display / one foreground
 * tab) with a per-target stream: each bridge room gets its own <canvas> fed by
 * Page.startScreencast of ITS target, and mouse/keyboard from the canvas are
 * injected back via Input.dispatch* into that same target. No extra Chrome per
 * room ⇒ no OOM; cost scales with WATCHED rooms only.
 *
 * Login model = SHARED: room targets live in Chrome's DEFAULT browser context,
 * so all rooms share one cookie jar (log in once, all rooms inherit).
 *
 * One upstream WS to the browser-level endpoint, flatten sessions multiplex all
 * rooms. HTTP serves the canvas client. WS at /view/<roomId>[?target=<id>].
 *
 * Env: RELAY_PORT (default 8990), CDP_PORT (default 9234 = luciano idle stack).
 */
const http = require('http');
const WebSocket = require('/var/www/html/claude-code-bridge-standalone/node_modules/ws');
const { URL } = require('url');
const fs = require('fs');

// Which Chrome login profile the shared browser is running under. The launcher
// writes the active profile *directory* to active-chrome-profile; Local State
// maps that dir to a friendly name + signed-in email. Cached 5s (Local State is
// big) and re-read so an account switch is reflected without a relay restart.
const PROFILE_DIR_FILE = '/home/bridge-peter/.claude/active-chrome-profile';
const USER_DATA_DIR = '/home/bridge-peter/.claude/chromium-bridge-profile';
let _profCache = { at: 0, val: null };
function readActiveProfile() {
  const now = Date.now();
  if (_profCache.val && now - _profCache.at < 5000) return _profCache.val;
  let dir = 'Default';
  try { dir = (fs.readFileSync(PROFILE_DIR_FILE, 'utf8') || '').trim() || 'Default'; } catch {}
  let name = dir, email = '';
  try {
    const ls = JSON.parse(fs.readFileSync(USER_DATA_DIR + '/Local State', 'utf8'));
    const info = ((ls.profile || {}).info_cache || {})[dir] || {};
    name = info.name || dir;
    email = info.user_name || info.gaia_name || '';
  } catch {}
  const val = { dir, name, email };
  _profCache = { at: now, val };
  return val;
}

const RELAY_PORT = parseInt(process.env.RELAY_PORT || '8990', 10);
const CDP_PORT = parseInt(process.env.CDP_PORT || '9234', 10);
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
// SHIM_PORT: when set, the relay FOLLOWS Claude's automation — it asks the room
// shim (GET /rooms/<room>) which CDP target Claude is currently driving for that
// room and screencasts THAT tab, re-attaching automatically when Claude switches
// tabs or the tab is re-created (session reinit changes the targetId). Unset =>
// legacy self-created window per room (user-drivable, not coupled to Claude).
const SHIM_PORT = parseInt(process.env.SHIM_PORT || '0', 10);
const FOLLOW_MS = parseInt(process.env.FOLLOW_MS || '1000', 10);

// ---- upstream (Chrome browser-level) CDP client -------------------------
let up = null;              // upstream WebSocket
let upReady = false;
let msgId = 0;
const pending = new Map();  // id -> {resolve,reject}
const rooms = new Map();    // roomId -> {targetId, sessionId, viewers:Set, casting}
const sessionRoom = new Map(); // sessionId -> roomId (route screencast frames)

function cdpFetch(path) {
  return new Promise((res, rej) => {
    http.get(CDP_BASE + path, (r) => {
      let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(JSON.parse(b)));
    }).on('error', rej);
  });
}

// Ask the room shim which target Claude is currently driving for <roomId>.
// Returns the `current` targetId, or null (shim off / no such room / no tab yet).
function shimCurrentTarget(roomId) {
  if (!SHIM_PORT) return Promise.resolve(null);
  return new Promise((res) => {
    const req = http.get(`http://127.0.0.1:${SHIM_PORT}/rooms/${encodeURIComponent(roomId)}`, (r) => {
      let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => {
        try { res((JSON.parse(b) || {}).current || null); } catch { res(null); }
      });
    });
    req.on('error', () => res(null));
    req.setTimeout(800, () => { req.destroy(); res(null); });
  });
}

function shimRoom(roomId) {
  if (!SHIM_PORT) return Promise.resolve(null);
  return new Promise((res) => {
    const req = http.get(`http://127.0.0.1:${SHIM_PORT}/rooms/${encodeURIComponent(roomId)}`, (r) => {
      let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } });
    });
    req.on('error', () => res(null));
    req.setTimeout(800, () => { req.destroy(); res(null); });
  });
}

// Fetch the shim's full room map: { roomId: {current, tabs:[...], lastUrl} }.
function shimAllRooms() {
  if (!SHIM_PORT) return Promise.resolve({});
  return new Promise((res) => {
    const req = http.get(`http://127.0.0.1:${SHIM_PORT}/rooms`, (r) => {
      let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b) || {}); } catch { res({}); } });
    });
    req.on('error', () => res({}));
    req.setTimeout(800, () => { req.destroy(); res({}); });
  });
}

// Close a CDP target by id (best-effort; /json/close returns plain text).
function cdpClose(id) {
  return new Promise((res) => {
    const req = http.get(`${CDP_BASE}/json/close/${id}`, (r) => { r.on('data', () => {}); r.on('end', res); });
    req.on('error', () => res());
    req.setTimeout(1500, () => { req.destroy(); res(); });
  });
}

// Periodic guard: Chrome accumulates orphan about:blank tabs whenever the
// automation session drops/reconnects (each reconnect can strand the old tab).
// Under the container's tight RAM these pile up and crash renderers (blank/black
// panes). Sweep closes any about:blank target NOT owned by a room (shim
// current/tabs, or a relay-owned window) — but only if it was ALSO orphan in the
// previous sweep, so a tab mid-registration (just created, not yet mapped) is
// never killed.
let _prevOrphans = new Set();
async function sweepOrphanBlanks() {
  try {
    const [list, roomMap] = await Promise.all([cdpFetch('/json/list'), shimAllRooms()]);
    const owned = new Set();
    for (const r of Object.values(roomMap || {})) {
      if (r && r.current) owned.add(r.current);
      for (const t of (r && r.tabs) || []) owned.add(t);
    }
    for (const r of rooms.values()) if (r.targetId) owned.add(r.targetId); // relay-owned windows
    const nowOrphan = new Set();
    const toClose = [];
    for (const t of list) {
      if (t.type !== 'page' || t.url !== 'about:blank' || owned.has(t.id)) continue;
      nowOrphan.add(t.id);
      if (_prevOrphans.has(t.id)) toClose.push(t.id);
    }
    for (const id of toClose) { await cdpClose(id); nowOrphan.delete(id); }
    _prevOrphans = nowOrphan;
    if (toClose.length) log('sweep: closed', toClose.length, 'orphan about:blank');
  } catch (e) { log('sweep err', e.message); }
}

function send(method, params, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const m = { id, method, params: params || {} };
    if (sessionId) m.sessionId = sessionId;
    pending.set(id, { resolve, reject });
    up.send(JSON.stringify(m));
  });
}

async function connectUpstream() {
  // Chrome may be mid-restart (full browser-stack restart brings it down ~15s).
  // If /json/version or the WS isn't ready yet, DON'T let the async reject strand
  // the reconnect chain (the old bug: relay froze forever after a Chrome restart).
  // Retry every 2s until Chrome is back; the follow loop then re-attaches each room
  // to Claude's new target IDs and restarts the screencast automatically.
  let v;
  try {
    v = await cdpFetch('/json/version');
  } catch (e) {
    log('upstream version fetch failed (' + e.message + ') — retrying in 2s');
    return setTimeout(connectUpstream, 2000);
  }
  const wsUrl = v && v.webSocketDebuggerUrl;
  if (!wsUrl) { log('no webSocketDebuggerUrl yet — retrying in 2s'); return setTimeout(connectUpstream, 2000); }
  up = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
  up.on('open', () => {
    upReady = true; log('upstream CDP connected', wsUrl);
    // Discover all targets so we hear about popups opened by window.open() (e.g. a
    // Google / Microsoft OAuth sign-in popup). Without this the relay only knows the
    // tabs the shim tracks for Claude, so such a popup is invisible & undriveable.
    send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
  });
  up.on('message', onUpstreamMessage);
  up.on('close', () => {
    upReady = false; log('upstream closed — reconnecting in 2s');
    for (const r of rooms.values()) r.casting = false;
    setTimeout(connectUpstream, 2000);
  });
  up.on('error', (e) => log('upstream error', e.message));
}

function onUpstreamMessage(raw) {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.reject(new Error(m.method + ' ' + JSON.stringify(m.error)));
    else p.resolve(m.result);
    return;
  }
  if (m.method === 'Target.targetCreated') {
    const ti = m.params && m.params.targetInfo;
    if (ti && ti.type === 'page' && ti.openerId) onPopupCreated(ti);
    return;
  }
  if (m.method === 'Target.targetDestroyed') {
    onTargetDestroyed(m.params && m.params.targetId);
    return;
  }
  if (m.method === 'Page.screencastFrame') {
    const roomId = sessionRoom.get(m.sessionId);
    // ack immediately so Chrome keeps sending frames
    send('Page.screencastFrameAck', { sessionId: m.params.sessionId }, m.sessionId).catch(() => {});
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    // Screencast metadata reports deviceWidth/Height in DEVICE pixels (CSS * dpr), but the
    // client maps clicks into CDP's CSS-pixel space using those values. When a room's page
    // has devicePixelRatio !== 1 (seen: 0.5), deviceWidth is half the CSS width, so every
    // click is sent at half scale and misses its target. Rewrite the forwarded meta to the
    // page's true CSS viewport (innerWidth/innerHeight), cached and refreshed lazily.
    const now = Date.now();
    if (!room._cssAt || now - room._cssAt > 1500) {
      room._cssAt = now;
      send('Runtime.evaluate', { expression: '[innerWidth,innerHeight]', returnByValue: true }, m.sessionId)
        .then((r) => { const v = r && r.result && r.result.value; if (Array.isArray(v) && v[0]) { room.cssW = v[0]; room.cssH = v[1]; } })
        .catch(() => {});
    }
    const meta = m.params.metadata || {};
    if (room.cssW && room.cssH) { meta.deviceWidth = room.cssW; meta.deviceHeight = room.cssH; }
    const payload = JSON.stringify({ t: 'frame', data: m.params.data, meta });
    for (const vw of room.viewers) { if (vw.readyState === 1) vw.send(payload); }
  }
}

// ---- per-room target lifecycle -----------------------------------------
async function attachTarget(targetId) {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  // Make this page believe it is always focused. With one shared Chrome and a separate
  // window per room, only one window can hold real OS focus at a time, so a backgrounded
  // room's input field loses its caret and stops accepting keys. Focus emulation keeps
  // the renderer in a focused state per-target, so every room accepts typing regardless
  // of which window the OS foregrounds — no focus juggling needed.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
  return sessionId;
}

async function ensureRoom(roomId, explicitTarget) {
  let room = rooms.get(roomId);
  if (room && room.sessionId) return room;

  let targetId = explicitTarget;
  // FOLLOW mode: pin to whatever tab Claude is currently driving for this room.
  if (!targetId && SHIM_PORT) targetId = await shimCurrentTarget(roomId);
  if (!targetId && SHIM_PORT) {
    // Follow mode, but Claude has not opened this room's tab yet. Do NOT spawn a
    // throwaway about:blank window: several empty rooms each conjure their own
    // window, they all composite in the one shared Chrome, and the panes collide
    // onto whichever window is fronted (the "all rooms show the same tab" bug).
    // Keep the room in a WAITING state with no target; the follow loop promotes it
    // the instant Claude opens a tab, and viewers see an honest placeholder.
    room = { targetId: null, sessionId: null, viewers: new Set(), casting: false, owned: false, followId: roomId, waiting: true };
  } else if (!targetId) {
    // Legacy (shim off): give the room its OWN top-level window so the pane paints
    // something the user can drive. newWindow:true so it composites.
    const r = await send('Target.createTarget', { url: 'about:blank', newWindow: true });
    targetId = r.targetId;
    room = { targetId, sessionId: await attachTarget(targetId), viewers: new Set(), casting: false, owned: true, followId: roomId };
  } else {
    room = { targetId, sessionId: await attachTarget(targetId), viewers: new Set(), casting: false, owned: false, followId: roomId };
  }
  rooms.set(roomId, room);
  if (room.sessionId) sessionRoom.set(room.sessionId, roomId);
  log('room ready', roomId, room.waiting ? '(waiting for Claude tab)' : 'target ' + String(targetId).slice(0, 12) + (room.owned ? ' (own window)' : ' (following Claude)'));
  return room;
}

// Re-point a room at a different target (Claude switched tabs / tab re-created).
async function reattachRoom(roomId, room, newTargetId) {
  await stopCast(room);
  sessionRoom.delete(room.sessionId);
  try { await send('Target.detachFromTarget', { sessionId: room.sessionId }); } catch {}
  // If we had auto-created a throwaway window, close it now that Claude has a real tab.
  if (room.owned) { try { await send('Target.closeTarget', { targetId: room.targetId }); } catch {} }
  room.owned = false;
  room.waiting = false;   // promoted out of the waiting placeholder onto a real tab
  room.targetId = newTargetId;
  room.seenRealUrl = false;   // new tab: don't blank-recover until it shows a real page
  room.blankSince = 0;
  room.sessionId = await attachTarget(newTargetId);
  sessionRoom.set(room.sessionId, roomId);
  log('room', roomId, 'followed Claude -> target', newTargetId.slice(0, 12));
  for (const vw of room.viewers) if (vw.readyState === 1) vw.send(JSON.stringify({ t: 'hello', roomId, targetId: newTargetId }));
  if (room.viewers.size > 0) await startCast(room);
}

// ---- popup adoption (window.open OAuth sign-in etc.) --------------------
// A page can spawn a child popup via window.open() — Google / Microsoft OAuth do
// exactly this. That popup is a NEW CDP target the shim never tracks (Claude did
// not create it), so the follow loop can't see it and the pane can neither show
// nor drive the sign-in. When a popup's opener is a room's currently-viewed tab,
// temporarily switch that room's view to the popup (pinned, so the follow loop
// won't yank it back), then revert to Claude's tab when the popup closes.
async function onPopupCreated(ti) {
  for (const [roomId, room] of rooms) {
    if (room.viewers.size === 0) continue;
    if (ti.openerId !== room.targetId && ti.openerId !== room.returnTo) continue;
    // Latch onto the first popup; ignore sibling popups until it closes. OAuth
    // flows can briefly have two live popups (account chooser + consent); adopting
    // both each follow-tick makes the view and its CDP input session thrash, so the
    // human's clicks land on an already-detached session ("Session with given id
    // not found") and the sign-in never registers.
    if (room.popupId) return;
    try {
      log('room', roomId, 'adopting popup', ti.targetId.slice(0, 12), ti.url ? '(' + ti.url.slice(0, 40) + ')' : '');
      if (!room.returnTo) room.returnTo = room.targetId; // tab to return to when popup closes
      room.popupId = ti.targetId;
      room.pinned = true; // freeze follow loop while the human completes sign-in
      await reattachRoom(roomId, room, ti.targetId);
    } catch (e) { log('popup adopt err', e.message); }
    return;
  }
}

async function onTargetDestroyed(targetId) {
  if (!targetId) return;
  for (const [roomId, room] of rooms) {
    if (room.popupId !== targetId) continue;
    const back = room.returnTo;
    room.popupId = null; room.returnTo = null; room.pinned = false;
    let tgt = null;
    try { tgt = await shimCurrentTarget(roomId); } catch {}
    if (!tgt) tgt = back;
    if (tgt && tgt !== room.targetId) {
      try { await reattachRoom(roomId, room, tgt); } catch (e) { log('popup revert err', e.message); }
    }
    log('room', roomId, 'popup closed — back to', tgt ? tgt.slice(0, 12) : 'follow');
    return;
  }
}

// Follow loop: while a followed room has viewers, poll the shim for Claude's
// current target and re-attach if it moved. Cheap (one localhost GET/sec/room).
let followTimer = null;
let rrCounter = 0;
function startFollowLoop() {
  if (followTimer || !SHIM_PORT) return;
  followTimer = setInterval(async () => {
    // One CDP list per tick enriches every room's targetIds with title+url.
    let list = [];
    try { list = await cdpFetch('/json/list'); } catch {}
    // Adopt any popup (window.open) whose opener is a viewed room's tab, even one
    // that predated the viewer so no live Target.targetCreated fired. /json/list
    // omits openerId, so use Target.getTargets which includes it. onPopupCreated
    // self-guards (viewers only, opener match, no re-adopt), so this is cheap.
    try {
      const tg = await send('Target.getTargets');
      for (const ti of (tg && tg.targetInfos) || []) {
        if (ti.type === 'page' && ti.openerId) await onPopupCreated(ti);
      }
    } catch {}
    const meta = new Map();
    for (const t of list) if (t.type === 'page') meta.set(t.id, { title: t.title || '', url: t.url || '' });
    const profile = readActiveProfile();
    // Fetched at most once per tick, and only if a room needs the fallback below.
    let _allShimP;
    const allShimRooms = () => (_allShimP || (_allShimP = shimAllRooms()));
    for (const [roomId, room] of rooms) {
      if (room.viewers.size === 0) continue;
      let info = null;
      try { info = await shimRoom(roomId); } catch {}
      // [RELAY_FOLLOW_AUTHORITATIVE_V1] The tab to FOLLOW must come ONLY from this
      // room's own shim room. The by-targetId fallback below can resolve `info` to a
      // SIBLING room when room.targetId is momentarily stale (just after a popup
      // adopt/close); using that sibling's `current` would re-point this pane onto the
      // sibling's tab and cross-wire screencast frames. Capture claudeCur here, before
      // the fallback runs. Safe now that the persisted alias ([SHIM_ALIAS_PERSIST_V1])
      // makes shimRoom(roomId) resolve reliably even for unrekeyed/resumed rooms. Any
      // residual mis-lock self-heals next tick: each room recomputes its OWN current.
      const claudeCur = info && info.current ? info.current : null;
      // Robustness: the viewer's roomId may not match the shim's room key (an
      // owned-fallback window, or a session not yet rekeyed draft->session), so
      // shimRoom returns nothing and the tab strip would collapse to the single
      // followed tab. Resolve the OWNING shim room by which tab set contains the
      // target we're actually following, so ALL sibling tabs show above the header.
      if (!info || !(Array.isArray(info.tabs) && info.tabs.includes(room.targetId))) {
        try {
          const all = await allShimRooms();
          for (const e of Object.values(all)) {
            if (e && Array.isArray(e.tabs) && e.tabs.includes(room.targetId)) { info = e; break; }
          }
        } catch {}
      }
      // Follow Claude unless the viewer has pinned a tab to peek at.
      if (!room.pinned && claudeCur && claudeCur !== room.targetId) {
        try { await reattachRoom(roomId, room, claudeCur); } catch (e) { log('reattach err', e.message); }
      }
      // Still no tab for this room (Claude has not driven it yet): keep showing the
      // honest waiting placeholder and skip the frame/cast machinery that assumes a
      // target. reattachRoom (above) clears `waiting` the moment a tab appears.
      if (room.waiting) {
        for (const vw of room.viewers) if (vw.readyState === 1) vw.send(JSON.stringify({ t: 'waiting', roomId }));
        continue;
      }
      // Blank-tab recovery: a site-driven redirect or auth handoff (e.g. MYOB /
      // Auth0 universal-login opening sign-in in a noopener tab) can leave a
      // room's OWN followed tab at about:blank while the shim still records a
      // real lastUrl for it. The relay would then faithfully screencast a
      // genuinely blank page (the "white browser"). If our viewed tab is blank
      // but the shim knows a real http(s) lastUrl, restore it in place.
      // Loop-guarded: only after it stays blank ~2 polls, and at most once per
      // 30s per room, so we never fight a legitimately-blanking site.
      const recViewedUrl = ((meta.get(room.targetId) || {}).url) || '';
      const recLastUrl = (info && info.lastUrl) ? info.lastUrl : '';
      const recNow = Date.now();
      // Only "recover" a tab that has ALREADY shown a real page and then regressed
      // to blank (auth redirect / noopener handoff). A freshly-opened tab is blank
      // from birth and Claude is about to navigate it itself — force-navigating it
      // to the room's lastUrl would hijack it. Track per-target (reset on reattach).
      if (/^https?:/i.test(recViewedUrl)) room.seenRealUrl = true;
      if (!room.pinned && room.casting && room.sessionId && room.seenRealUrl &&
          (!recViewedUrl || recViewedUrl === 'about:blank') && /^https?:/i.test(recLastUrl)) {
        if (!room.blankSince) room.blankSince = recNow;
        else if (recNow - room.blankSince > 1500 && recNow - (room.lastRecoverAt || 0) > 30000) {
          room.lastRecoverAt = recNow;
          try { await send('Page.navigate', { url: recLastUrl }, room.sessionId); log('recovered blank followed tab', roomId, '->', recLastUrl); }
          catch (e) { log('blank recover err', e.message); }
        }
      } else {
        room.blankSince = 0;
      }
      // Show EXACTLY this room's own tabs. It's one shared Chrome (=> shared
      // logins) with every room's tabs physically in one window, but the shim
      // tracks a room-local tab set (info.tabs), so a room never sees another
      // room's tabs. Enrich each targetId with title/url from the CDP list.
      const ids = (info && Array.isArray(info.tabs) && info.tabs.length) ? info.tabs.slice() : [room.targetId];
      if (!ids.includes(room.targetId)) ids.push(room.targetId);
      const tabs = ids.map((id) => { const mv = meta.get(id) || {}; return { targetId: id, title: mv.title || '', url: mv.url || '' }; });
      // Keep tabs in a stable slot: remember first-seen order per room so a tab
      // never jumps position when you click/activate it; new tabs append at the end.
      room.tabOrder = (room.tabOrder || []).filter((id) => tabs.some((t) => t.targetId === id));
      for (const t of tabs) if (!room.tabOrder.includes(t.targetId)) room.tabOrder.push(t.targetId);
      const byId = new Map(tabs.map((t) => [t.targetId, t]));
      const ordered = room.tabOrder.map((id) => byId.get(id)).filter(Boolean);
      const payload = JSON.stringify({ t: 'meta', tabs: ordered, claudeCurrent: claudeCur, viewing: room.targetId, pinned: !!room.pinned, profile });
      for (const vw of room.viewers) if (vw.readyState === 1) vw.send(payload);
    }
    // Keep viewed rooms live: all rooms' tabs share ONE Chrome window, and only a
    // window's FOREGROUND tab composites, so a background room's canvas freezes on
    // its last frame. Re-activate viewed rooms round-robin (one per tick); with a
    // single viewer that tab stays foreground and streams continuously.
    const viewed = [...rooms.values()].filter((r) => r.viewers.size > 0 && r.casting);
    // ONLY grab foreground for a room a human is ACTIVELY driving (input in the last
    // few seconds) so its focused input field keeps the caret. Each room lives in its
    // OWN Chrome window that keeps painting while backgrounded (anti-occlusion flags),
    // so there is no need to cycle foreground to keep panes live — and doing so stole
    // focus back from whatever window the user was typing in, killing the caret ~1s
    // after every click. So: no periodic round-robin; touch foreground on input only.
    // Hold foreground for the viewed room the user most recently interacted with, with
    // NO expiry. A focused input field loses its caret the instant its window drops to
    // the background; with a fixed timeout some other Chrome window grabbed OS focus and
    // killed the caret ~5s after the last keystroke. So keep the actively-viewed room
    // foreground continuously and only yield when the user drives a DIFFERENT room.
    let hold = viewed
      .filter((r) => r.lastInputAt)
      .sort((a, b) => b.lastInputAt - a.lastInputAt)[0];
    if (!hold && viewed.length === 1) hold = viewed[0];
    if (hold) {
      await send('Target.activateTarget', { targetId: hold.targetId }).catch(() => {});
    }
  }, FOLLOW_MS);
}

async function startCast(room) {
  if (room.casting) return;
  room.casting = true;
  // Bring this room's window to the foreground so it composites (background
  // windows don't paint under Xvfb => stale/black canvas). Screencast frames
  // are change-driven, so this yields the initial full paint too.
  await send('Target.activateTarget', { targetId: room.targetId }).catch(() => {});
  await send('Page.startScreencast',
    { format: 'jpeg', quality: 55, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 },
    room.sessionId);
}
async function stopCast(room) {
  if (!room.casting) return;
  room.casting = false;
  await send('Page.stopScreencast', {}, room.sessionId).catch(() => {});
}

// ---- input injection ----------------------------------------------------
async function handleInput(room, ev) {
  const sid = room.sessionId;
  try {
    // A human is driving THIS room. Bring its tab to the foreground before the
    // event lands: a background/hidden page won't accept an input caret, so clicks
    // wouldn't focus a field and keystrokes would go nowhere. Stamp the time so the
    // round-robin below won't steal foreground back while they're still typing.
    // (Skip mouseMoved — it fires constantly and would spam activateTarget.)
    if (ev.k === 'key' || ev.k === 'text' || ev.k === 'wheel' ||
        (ev.k === 'mouse' && ev.type !== 'mouseMoved')) {
      room.lastInputAt = Date.now();
      await send('Target.activateTarget', { targetId: room.targetId }).catch(() => {});
    }
    if (ev.k === 'mouse') {
      await send('Input.dispatchMouseEvent', {
        type: ev.type, x: ev.x, y: ev.y,
        button: ev.button || 'none', clickCount: ev.clickCount || 0,
        modifiers: ev.modifiers || 0,
      }, sid);
    } else if (ev.k === 'wheel') {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: ev.x, y: ev.y, deltaX: ev.dx || 0, deltaY: ev.dy || 0,
      }, sid);
    } else if (ev.k === 'key') {
      await send('Input.dispatchKeyEvent', {
        type: ev.type, // keyDown | keyUp | char
        text: ev.text, key: ev.key, code: ev.code,
        windowsVirtualKeyCode: ev.vk, modifiers: ev.modifiers || 0,
      }, sid);
    } else if (ev.k === 'text') {
      await send('Input.insertText', { text: ev.text }, sid);
    } else if (ev.k === 'nav') {
      await send('Page.navigate', { url: ev.url }, sid);
    } else if (ev.k === 'reload') {
      await send('Page.reload', {}, sid);
    } else if (ev.k === 'back' || ev.k === 'forward') {
      const h = await send('Page.getNavigationHistory', {}, sid);
      const ni = h.currentIndex + (ev.k === 'forward' ? 1 : -1);
      if (h.entries && h.entries[ni]) await send('Page.navigateToHistoryEntry', { entryId: h.entries[ni].id }, sid);
    } else if (ev.k === 'view-tab') {
      room.pinned = true;
      if (ev.targetId && ev.targetId !== room.targetId) await reattachRoom(room.followId, room, ev.targetId);
    } else if (ev.k === 'follow') {
      room.pinned = false;
    } else if (ev.k === 'close-tab') {
      if (ev.targetId) { try { await send('Target.closeTarget', { targetId: ev.targetId }); } catch {} }
    } else if (ev.k === 'new-tab') {
      // Open in THIS room's window: focus the room's tab first so createTarget
      // (newWindow:false) lands in that same window, then view the new tab.
      try { await send('Target.activateTarget', { targetId: room.targetId }); } catch {}
      const nt = await send('Target.createTarget', { url: 'about:blank', newWindow: false });
      room.pinned = true;
      try { await reattachRoom(room.followId, room, nt.targetId); } catch (e) { log('new-tab err', e.message); }
    }
  } catch (e) { log('input err', e.message); }
}

// ---- HTTP + WS server ---------------------------------------------------
const CLIENT_HTML = (() => { const fs = require('fs');
  for (const c of [__dirname + '/public/room-view-client.html', __dirname + '/room-view-client.html']) {
    try { return fs.readFileSync(c, 'utf8'); } catch (e) {}
  }
  return '<!doctype html><title>room viewer</title>client not found';
})();
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/room')) {
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(CLIENT_HTML); return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ upReady, rooms: [...rooms.keys()], cdp: CDP_PORT }));
    return;
  }
  res.writeHead(404); res.end('not found');
});

// Tear a room down after its last viewer leaves (grace-delayed so quick room
// switching does not thrash). Closes the follow-window ONLY if it is a relay-
// owned throwaway (draft rooms Claude never opened a real tab for leaked one
// about:blank window each); a followed tab belongs to Claude and is left alone.
async function reapRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.viewers.size > 0) return;
  try { await stopCast(room); } catch {}
  if (room.owned) { try { await send('Target.closeTarget', { targetId: room.targetId }); } catch {} }
  try { await send('Target.detachFromTarget', { sessionId: room.sessionId }); } catch {}
  sessionRoom.delete(room.sessionId);
  rooms.delete(roomId);
  log('room reaped', roomId, room.owned ? '(closed own window)' : '(detached follow)');
}

// Push an immediate one-shot frame to a single viewer. Page.startScreencast emits
// its initial keyframe only to whoever is connected at start time, and thereafter
// frames are change-driven — so a viewer that joins an ALREADY-casting room, or one
// watching a static page that never repaints, would otherwise sit on a black canvas
// forever. captureScreenshot paints even a backgrounded tab, so this delivers the
// current screen instantly without stealing OS focus from another pane.
async function sendKeyframe(room, vw) {
  if (!room || !room.sessionId || vw.readyState !== 1) return;
  try {
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 55 }, room.sessionId);
    if (!shot || !shot.data || vw.readyState !== 1) return;
    const meta = {};
    if (room.cssW && room.cssH) { meta.deviceWidth = room.cssW; meta.deviceHeight = room.cssH; }
    vw.send(JSON.stringify({ t: 'frame', data: shot.data, meta }));
  } catch {}
}

// [KEYFRAME_BURST_V1] A single join keyframe can lose the race with a slow client
// canvas (iframe still laying out) or an idle/static page that emits no further
// screencast frames. Fire several cheap captureScreenshot keyframes over ~2s so
// the viewer is guaranteed a paint; each is guarded by readyState so a closed
// viewer costs nothing.
function keyframeBurst(room, vw) {
  sendKeyframe(room, vw);
  [250, 700, 1500, 2500].forEach(ms => setTimeout(() => {
    if (vw.readyState === 1 && room.viewers.has(vw)) sendKeyframe(room, vw);
  }, ms));
}

const wss = new WebSocket.Server({ server, path: undefined });
wss.on('connection', async (vw, req) => {
  const u = new URL(req.url, 'http://x');
  const mView = u.pathname.match(/^\/view\/([^/]+)$/);
  if (!mView) { vw.close(); return; }
  const roomId = decodeURIComponent(mView[1]);
  const explicitTarget = u.searchParams.get('target') || null;

  if (!upReady) { vw.send(JSON.stringify({ t: 'error', msg: 'chrome not connected' })); }
  let room;
  try { room = await ensureRoom(roomId, explicitTarget); }
  catch (e) { vw.send(JSON.stringify({ t: 'error', msg: e.message })); vw.close(); return; }

  if (room.reapTimer) { clearTimeout(room.reapTimer); room.reapTimer = null; }
  room.viewers.add(vw);
  if (room.waiting) {
    // No tab yet — show the honest placeholder instead of casting a null target.
    vw.send(JSON.stringify({ t: 'waiting', roomId }));
    startFollowLoop();
    log('viewer joined', roomId, '(waiting for Claude tab) total', room.viewers.size);
  } else {
    vw.send(JSON.stringify({ t: 'hello', roomId, targetId: room.targetId }));
    await startCast(room);
    // Guarantee this viewer sees the current screen immediately, even if the room was
    // already casting (its startScreencast keyframe went to an earlier viewer) or the
    // page is static and won't emit another frame on its own.
    keyframeBurst(room, vw);
    startFollowLoop();
    log('viewer joined', roomId, 'total', room.viewers.size);
  }

  vw.on('message', (raw) => {
    let ev; try { ev = JSON.parse(raw); } catch { return; }
    if (ev.req === 'keyframe') { if (!room.waiting) sendKeyframe(room, vw); return; }
    if (ev.k) handleInput(room, ev);
  });
  vw.on('close', () => {
    room.viewers.delete(vw);
    log('viewer left', roomId, 'remaining', room.viewers.size);
    if (room.viewers.size === 0) { stopCast(room); room.reapTimer = setTimeout(() => reapRoom(roomId), 5000); }
  });
});

function log(...a) { console.log(new Date().toISOString(), '[relay]', ...a); }

connectUpstream();
server.listen(RELAY_PORT, '127.0.0.1', () => log(`listening on 127.0.0.1:${RELAY_PORT} -> CDP ${CDP_PORT}`));
if (SHIM_PORT) setInterval(sweepOrphanBlanks, 60000);
