/* [ORCH_UI_V1] Master-room orchestration panel.
   Self-contained: appended to app.js, owns its DOM, and stays invisible unless the
   current room is a master. Reads the room id from the same localStorage keys app.js
   uses, so it needs no access to app.js internals. */
(function orchUI() {
  'use strict';
  if (window.__ORCH_UI) return;
  window.__ORCH_UI = true;

  const POLL_MS = 4000;
  let graphRev = null, masterId = null, busy = false;

  function roomId() {
    const pinned = new URLSearchParams(location.search).get('room');
    return pinned || localStorage.getItem('bridge_session_id::' + (pinned || '')) ||
           localStorage.getItem('bridge_session_id') || localStorage.getItem('bridge_room_id');
  }

  const el = document.createElement('div');
  el.id = 'orch-panel';
  el.style.cssText = 'display:none;position:fixed;right:12px;bottom:12px;width:360px;max-height:70vh;' +
    'overflow:auto;background:#12161c;color:#dfe6ee;border:1px solid #2a3340;border-radius:10px;' +
    'font:12px/1.45 ui-monospace,Menlo,monospace;padding:10px;z-index:9998;box-shadow:0 8px 28px rgba(0,0,0,.45)';
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(el));
  if (document.body) document.body.appendChild(el);

  const CHIP = {
    queued: '#6b7280', spawning: '#6b7280', running: '#2563eb', 'awaiting-instructions': '#d97706',
    reporting: '#7c3aed', integrating: '#7c3aed', done: '#16a34a', failed: '#dc2626',
    cancelled: '#6b7280', 'timed-out': '#dc2626', parked: '#475569', closed: '#475569',
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function api(method, url, body) {
    const opt = { method, headers: {} };
    if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    if (graphRev != null) opt.headers['If-Match'] = String(graphRev);
    const r = await fetch(url, opt);
    let j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  function render(g) {
    graphRev = g.graphRev;
    const rows = [];
    rows.push('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
      '<b>Orchestration</b><span style="opacity:.6">' + esc(g.targetRef || '') +
      ' · slots ' + g.slots.used + '/' + g.slots.max + ' · seats ' + g.seats + '</span></div>');

    // Plan awaiting approval — the FULL brief is editable before anything spawns.
    if (g.plan && !g.plan.approvedAt) {
      rows.push('<div style="border:1px solid #2a3340;border-radius:8px;padding:8px;margin-bottom:8px">' +
        '<div style="margin-bottom:6px"><b>Proposed plan</b> <span style="opacity:.6">rev ' + g.plan.planRev + '</span></div>' +
        '<textarea id="orch-plan-edit" style="width:100%;height:170px;background:#0b0e13;color:#dfe6ee;' +
        'border:1px solid #2a3340;border-radius:6px;padding:6px;font:11px/1.4 ui-monospace,monospace">' +
        esc(JSON.stringify(g.plan.subtasks, null, 2)) + '</textarea>' +
        '<div style="margin-top:6px;display:flex;gap:6px">' +
        '<button data-orch="save">Save edits</button>' +
        '<button data-orch="approve" style="background:#16a34a;color:#fff;border:0;border-radius:5px;padding:4px 10px">Approve &amp; spawn</button>' +
        '</div><div id="orch-err" style="color:#f87171;margin-top:4px"></div></div>');
    }

    if (!g.children.length) rows.push('<div style="opacity:.6">No children yet.</div>');
    for (const c of g.children) {
      const colour = CHIP[c.state] || '#6b7280';
      rows.push('<div style="border-top:1px solid #222a35;padding:6px 0">' +
        '<div><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + colour + ';margin-right:6px"></span>' +
        '<b>' + esc(c.title) + '</b> <span style="opacity:.55">' + esc(c.cid) + ' · ' + esc(c.mode) + '</span></div>' +
        '<div style="opacity:.7">' + esc(c.state) + (c.queueReason ? ' — ' + esc(c.queueReason) : '') +
        (c.conflict && c.conflict.length ? ' — conflict: ' + esc(c.conflict.join(', ')) : '') + '</div>' +
        (c.report ? '<div style="opacity:.7">“' + esc((c.report.summary || '').slice(0, 140)) + '”</div>' : '') +
        '<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">' +
        '<button data-orch="open" data-cid="' + esc(c.cid) + '">open room</button>' +
        (['done', 'failed', 'cancelled', 'timed-out', 'closed'].includes(c.state)
          ? '<button data-orch="reject" data-cid="' + esc(c.cid) + '">reject</button>'
          : '<button data-orch="cancel" data-cid="' + esc(c.cid) + '">cancel</button>' +
            '<button data-orch="park" data-cid="' + esc(c.cid) + '">park</button>') +
        (['parked', 'timed-out'].includes(c.state) ? '<button data-orch="resume" data-cid="' + esc(c.cid) + '">resume</button>' : '') +
        '</div></div>');
    }
    el.innerHTML = rows.join('');
    el.style.display = 'block';
  }

  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-orch]');
    if (!b || busy) return;
    const act = b.getAttribute('data-orch');
    const cid = b.getAttribute('data-cid');
    const err = el.querySelector('#orch-err');
    busy = true;
    try {
      if (act === 'open') { location.search = '?room=' + encodeURIComponent(cid ? (await currentGraph()).children.find(c => c.cid === cid).roomKey : ''); return; }
      if (act === 'save') {
        const subtasks = JSON.parse(el.querySelector('#orch-plan-edit').value);
        const g = await currentGraph();
        await api('PATCH', '/orch/v1/plans/' + masterId + '/' + g.plan.planId, { subtasks });
      } else if (act === 'approve') {
        const g = await currentGraph();
        await api('POST', '/orch/v1/plans/' + masterId + '/' + g.plan.planId + '/approve', { planRev: g.plan.planRev });
      } else {
        const text = act === 'reject' ? (prompt('Why is this report rejected?') || '') : '';
        if (act === 'reject' && !text) { busy = false; return; }
        await api('POST', '/orch/v1/children/' + masterId + '/' + cid + '/' + act, { text });
      }
      await poll();
    } catch (e) {
      if (err) err.textContent = e.message;
      else console.warn('[ORCH_UI_V1]', e.message);
    } finally { busy = false; }
  });

  let lastGraph = null;
  async function currentGraph() { return lastGraph || (lastGraph = (await api('GET', '/orch/v1/graph/' + masterId))); }

  async function poll() {
    const id = roomId();
    if (!id) { el.style.display = 'none'; return; }
    try {
      const r = await fetch('/orch/v1/room/' + encodeURIComponent(id));
      if (!r.ok) { el.style.display = 'none'; return; }      // route absent: stay invisible
      const j = await r.json();
      if (!j.masterId) { masterId = null; el.style.display = 'none'; return; }
      masterId = j.masterId; lastGraph = j.graph;
      render(j.graph);
    } catch (e) { el.style.display = 'none'; }
  }

  setInterval(poll, POLL_MS);
  setTimeout(poll, 800);
})();
