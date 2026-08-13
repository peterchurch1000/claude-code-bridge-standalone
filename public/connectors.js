(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const listEl = $('conn-list');

  // ── Toast ──
  function toast(msg, kind) {
    const t = document.createElement('div');
    t.className = 'msg'; t.textContent = msg;
    t.style.cssText = 'background:var(--bg-msg);border:1px solid var(--border);border-left:3px solid ' +
      (kind === 'error' ? 'var(--red)' : kind === 'success' ? 'var(--green)' : 'var(--accent)') +
      ';color:var(--text);padding:8px 12px;border-radius:6px;font-size:12px;max-width:320px;';
    $('toast-container').appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  // ── Provider presets ──
  const PRESETS = {
    'generic-http':  { transport: 'http',  url: '', provider: 'generic', name: '' },
    'generic-sse':   { transport: 'sse',   url: '', provider: 'generic', name: '' },
    'generic-stdio': { transport: 'stdio', url: '', provider: 'generic', name: '' },
    'gmail':  { transport: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1',    provider: 'google',  name: 'gmail-' },
    'gcal':   { transport: 'http', url: 'https://calendarmcp.googleapis.com/mcp/v1', provider: 'google',  name: 'gcal-'  },
    'gdrive': { transport: 'http', url: 'https://drivemcp.googleapis.com/mcp/v1',    provider: 'google',  name: 'gdrive-' },
    'msgraph':{ transport: 'http', url: '',                                          provider: 'msgraph', name: 'msgraph-' },
  };
  const NOTES = {
    'msgraph': 'Microsoft Graph needs an Azure AD app + OAuth (Phase 3). Paste your tenant MCP URL, or leave blank to set up later.',
    'gmail': 'Google connectors authenticate via OAuth (Phase 3). Add now; authenticate once the auth flow lands.',
    'gcal': 'Authenticates via OAuth (Phase 3).',
    'gdrive': 'Authenticates via OAuth (Phase 3).',
  };

  function applyPreset() {
    const p = PRESETS[$('f-preset').value] || PRESETS['generic-http'];
    const stdio = p.transport === 'stdio';
    $('wrap-url').classList.toggle('hidden', stdio);
    $('wrap-cmd').classList.toggle('hidden', !stdio);
    $('f-url').value = p.url || '';
    if (!$('f-name').value || /^(gmail|gcal|gdrive|msgraph)-$/.test($('f-name').value)) $('f-name').value = p.name || '';
    $('wrap-headers').querySelector('label').textContent = stdio
      ? 'Environment variables (optional) — key + value'
      : 'Auth headers (optional) — e.g. Authorization / Bearer token';
    $('add-note').textContent = NOTES[$('f-preset').value] || '';
  }
  $('f-preset').addEventListener('change', applyPreset);

  // ── Header/env rows ──
  function addHdrRow(k, v) {
    const row = document.createElement('div');
    row.className = 'hdr-row';
    const ik = document.createElement('input'); ik.placeholder = 'Authorization'; ik.value = k || '';
    const iv = document.createElement('input'); iv.placeholder = 'Bearer …';       iv.value = v || '';
    const rm = document.createElement('button'); rm.className = 'act'; rm.textContent = '×'; rm.type = 'button';
    rm.onclick = () => row.remove();
    row.append(ik, iv, rm);
    $('hdr-rows').appendChild(row);
  }
  $('btn-add-hdr').addEventListener('click', () => addHdrRow());

  function collectHeaders() {
    const out = {};
    for (const row of $('hdr-rows').children) {
      const [ik, iv] = row.querySelectorAll('input');
      if (ik.value.trim()) out[ik.value.trim()] = iv.value;
    }
    return out;
  }

  // ── Add ──
  $('btn-add').addEventListener('click', async () => {
    const preset = PRESETS[$('f-preset').value] || PRESETS['generic-http'];
    const name = $('f-name').value.trim();
    if (!name) { toast('Give the connector a name', 'error'); return; }
    const body = { name, transport: preset.transport, provider: preset.provider };
    if (preset.transport === 'stdio') {
      const parts = $('f-cmd').value.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) { toast('Enter a command for stdio', 'error'); return; }
      body.command = parts[0]; body.args = parts.slice(1); body.env = collectHeaders();
    } else {
      body.url = $('f-url').value.trim();
      if (!/^https?:\/\//i.test(body.url)) { toast('Enter a valid http(s) URL', 'error'); return; }
      body.headers = collectHeaders();
    }
    try {
      const res = await fetch('/connectors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json();
      if (res.ok && d.ok) {
        toast(`Connector "${name}" added`, 'success');
        $('f-name').value = ''; $('f-url').value = ''; $('f-cmd').value = ''; $('hdr-rows').innerHTML = '';
        load();
      } else { toast('Add failed: ' + (d.error || res.status), 'error'); }
    } catch (e) { toast('Add failed: ' + e.message, 'error'); }
  });

  // ── List / render ──
  async function load() {
    try {
      const res = await fetch('/connectors', { cache: 'no-store' });
      const d = await res.json();
      render(d.connectors || []);
    } catch (e) { listEl.innerHTML = '<div class="empty">Could not load connectors: ' + e.message + '</div>'; }
  }

  function render(connectors) {
    if (!connectors.length) { listEl.innerHTML = '<div class="empty">No connectors yet.</div>'; return; }
    listEl.innerHTML = '';
    for (const c of connectors) {
      const card = document.createElement('div');
      card.className = 'conn-card h-' + c.health;

      const row1 = document.createElement('div'); row1.className = 'conn-row1';
      const nm = document.createElement('span'); nm.className = 'conn-name'; nm.textContent = c.name;
      const badge = document.createElement('span');
      badge.className = 'conn-badge b-' + c.health;
      badge.textContent = c.health === 'connected' ? 'connected' : c.health === 'needs-auth' ? 'needs auth' : 'error';
      const prov = document.createElement('span'); prov.className = 'conn-prov'; prov.textContent = c.provider + (c.transport ? ' · ' + c.transport : '');
      const meta = document.createElement('span'); meta.className = 'conn-meta';
      const del = document.createElement('button'); del.className = 'act danger'; del.textContent = 'Remove';
      del.onclick = () => removeConn(c.name);
      meta.appendChild(del);
      row1.append(nm, badge, prov, meta);

      const tgt = document.createElement('div'); tgt.className = 'conn-target'; tgt.textContent = c.target || '';

      const ctl = document.createElement('div'); ctl.className = 'conn-ctl';

      // Account connectors are managed by claude.ai; we don't expose remove/policy edit the same way.
      if (c.account) {
        del.classList.add('hidden');
        const note = document.createElement('div'); note.className = 'restr-hint';
        note.textContent = 'Managed by your claude.ai account (single Google account). For multiple accounts, add named Google connectors above.';
        ctl.appendChild(note);
      } else {
        // Loop toggle
        const loopLine = document.createElement('div'); loopLine.className = 'conn-line';
        const sw = document.createElement('label'); sw.className = 'switch';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = c.loopEnabled !== false;
        const sl = document.createElement('span'); sl.className = 'slider';
        sw.append(cb, sl);
        const loopLbl = document.createElement('label'); loopLbl.textContent = 'Autonomous loop may use this connector';
        cb.onchange = () => savePolicy(c.name, { loopEnabled: cb.checked });
        loopLine.append(sw, loopLbl);
        ctl.appendChild(loopLine);

        // Restricted actions
        const rb = document.createElement('div'); rb.className = 'restr-box';
        const rl = document.createElement('div'); rl.className = 'conn-line';
        const rlab = document.createElement('label'); rlab.textContent = 'Restricted actions (loop must NOT do these — one tool name per line):';
        rl.appendChild(rlab);
        const ta = document.createElement('textarea'); ta.rows = 2; ta.value = (c.restricted || []).join('\n');
        ta.placeholder = `mcp__${c.name}__send_email\nmcp__${c.name}__create_event`;
        const sv = document.createElement('button'); sv.className = 'act save'; sv.textContent = 'Save restrictions'; sv.style.marginTop = '5px';
        sv.onclick = () => savePolicy(c.name, { restricted: ta.value.split('\n').map(s => s.trim()).filter(Boolean) });
        const hint = document.createElement('div'); hint.className = 'restr-hint';
        hint.textContent = 'These become a hard --disallowedTools block for the loop (deny always wins over read access). The chat is unrestricted — you act manually. Mail/calendar/drive connectors also start with the loop toggle OFF and known send/delete actions pre-filled, so nothing external can happen until you opt in.';
        rb.append(rl, ta, sv, hint);
        ctl.appendChild(rb);
      }

      card.append(row1, tgt, ctl);
      listEl.appendChild(card);
    }
  }

  async function savePolicy(name, patch) {
    try {
      const res = await fetch('/connectors/' + encodeURIComponent(name) + '/policy',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      const d = await res.json();
      if (res.ok && d.ok) toast('Saved', 'success');
      else toast('Save failed: ' + (d.error || res.status), 'error');
    } catch (e) { toast('Save failed: ' + e.message, 'error'); }
  }

  async function removeConn(name) {
    if (!confirm('Remove connector "' + name + '"?')) return;
    try {
      const res = await fetch('/connectors/' + encodeURIComponent(name), { method: 'DELETE' });
      const d = await res.json();
      if (res.ok && d.ok) { toast('Removed "' + name + '"', 'success'); load(); }
      else toast('Remove failed: ' + (d.error || res.status), 'error');
    } catch (e) { toast('Remove failed: ' + e.message, 'error'); }
  }

  applyPreset();
  load();
})();
