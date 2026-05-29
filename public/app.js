/* Claude Code Bridge — Chat UI */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  const messagesEl = $('messages');
  const inputEl    = $('chat-input');
  const btnSend    = $('btn-send');
  const btnReset   = $('btn-reset');
  const statusBar  = $('status-bar');
  const statusDot  = $('status-dot');
  const vncFrame   = $('vnc-frame');
  const cdotWs     = $('cdot-ws');
  const cdotVnc    = $('cdot-vnc');
  const cdotMcp    = $('cdot-mcp');
  const cbtnVnc    = $('cbtn-vnc');
  const cbtnMcp    = $('cbtn-mcp');
  const connTime   = $('conn-time');

  // ── Status dot helpers ─────────────────────────────────────────────────────
  function _setDot(el, state) { if (el) el.className = `cdot cdot-${state}`; }
  function setWsDot(s) { _setDot(cdotWs, s); }
  function setVncDot(s) {
    _setDot(cdotVnc, s);
    if (!cbtnVnc) return;
    if (s === 'disconnected' || s === 'error') cbtnVnc.classList.remove('hidden');
    else cbtnVnc.classList.add('hidden');
  }
  function setMcpDot(s) {
    _setDot(cdotMcp, s);
    if (!cbtnMcp) return;
    if (s === 'disconnected' || s === 'error') cbtnMcp.classList.remove('hidden');
    else cbtnMcp.classList.add('hidden');
  }

  // Uptime clock in conn-bar
  let connectedAt = null;
  function startConnTime() { connectedAt = Date.now(); }
  function tickConnTime() {
    if (!connectedAt || !connTime) return;
    const s = Math.floor((Date.now() - connectedAt) / 1000);
    connTime.textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
  }
  setInterval(tickConnTime, 5000);

  // ── Set noVNC iframe src from server config ────────────────────────────────
  const novncBase = (window.BRIDGE_CONFIG?.novncUrl || '').replace(/\/$/, '');
  vncFrame.src = novncBase + '/vnc_clean.html';

  // ── State ──────────────────────────────────────────────────────────────────
  let ws = null;
  let wsReconnectAttempt = 0;
  let wsReconnectTimer   = null;
  let keepaliveInterval  = null;
  let busy = false;
  let currentAssistantEl   = null;
  let currentAssistantText = '';
  let lastToolEl = null;
  let hasConnectedBefore = false;
  let contextBanner = null;

  // ── Chat persistence (localStorage) ───────────────────────────────────────
  const STORAGE_KEY  = 'bridge_chat_v1';
  const SESSION_KEY  = 'bridge_session_id';
  let storedMsgData        = [];
  let lastAssistantDataIdx = -1;
  let lastToolDataIdx      = -1;
  let _restoring           = false;

  function saveToStorage() {
    if (_restoring) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(storedMsgData)); } catch {}
  }
  function loadFromStorage() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
  }

  // ── Markdown helper ────────────────────────────────────────────────────────
  function renderMd(el, text) {
    if (typeof marked !== 'undefined') {
      el.innerHTML = marked.parse(text, { breaks: true, gfm: true });
    } else {
      el.textContent = text;
    }
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  function showToast(msg, type = 'info') {
    const c = $('toast-container');
    if (!c) return;
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.textContent = msg;
    c.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 4000);
  }

  // ── Context warning banner ────────────────────────────────────────────────
  function showContextWarning(pct) {
    if (contextBanner) {
      contextBanner.querySelector('.ctx-pct').textContent = pct.toFixed(0) + '%';
      return;
    }
    contextBanner = document.createElement('div');
    contextBanner.className = 'ctx-warning';
    contextBanner.innerHTML =
      `<span>⚠ Context at <strong class="ctx-pct">${pct.toFixed(0)}%</strong> — compact to free space?</span>` +
      `<button class="ctx-btn-compact">Compact now</button>` +
      `<button class="ctx-btn-dismiss">✕</button>`;
    contextBanner.querySelector('.ctx-btn-compact').onclick = () => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'compact' }));
        showToast('Compacting conversation…', 'info');
        hideContextWarning();
      }
    };
    contextBanner.querySelector('.ctx-btn-dismiss').onclick = hideContextWarning;
    messagesEl.parentNode.insertBefore(contextBanner, messagesEl);
  }

  function hideContextWarning() {
    contextBanner?.remove();
    contextBanner = null;
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────
  function appendMsg(role, text) {
    removeThinking();
    const div = document.createElement('div');

    if (role === 'thinking') {
      div.className = 'msg msg-thinking';
      div.dataset.role = 'thinking';
      div.innerHTML = '<div class="spinner"></div><span>Claude is thinking…</span>';
      messagesEl.appendChild(div);
      scrollBottom();
      return null;
    }

    div.className = `msg msg-${role}`;

    if (role === 'assistant') {
      div.style.whiteSpace = 'normal';
      renderMd(div, text || '');
    } else {
      div.textContent = text || '';
    }

    messagesEl.appendChild(div);
    scrollBottom();

    if (!_restoring) {
      storedMsgData.push({ type: role, text: text || '' });
      if (role === 'assistant') lastAssistantDataIdx = storedMsgData.length - 1;
      saveToStorage();
    }

    return div;
  }

  function appendToolMsg(name, args) {
    removeThinking();

    const wrap = document.createElement('div');
    wrap.className = 'msg-tool';

    const header = document.createElement('div');
    header.className = 'tool-header';

    const icon  = document.createElement('span');
    icon.className = 'tool-icon';
    icon.textContent = '⚙';

    const nameEl = document.createElement('span');
    nameEl.className = 'tool-name-text';
    nameEl.textContent = name || 'tool';

    const caret = document.createElement('span');
    caret.className = 'tool-caret';
    caret.textContent = '›';

    header.appendChild(icon);
    header.appendChild(nameEl);
    header.appendChild(caret);

    const body = document.createElement('div');
    body.className = 'tool-body';

    const argsEl = document.createElement('pre');
    argsEl.className = 'tool-args';
    argsEl.textContent = args ? JSON.stringify(args, null, 2) : '';

    const resEl = document.createElement('pre');
    resEl.className = 'tool-result pending';
    resEl.textContent = '…running';
    resEl.dataset.role = 'tool-result';

    body.appendChild(argsEl);
    body.appendChild(resEl);

    let expanded = false;
    header.addEventListener('click', () => {
      expanded = !expanded;
      body.style.display  = expanded ? 'block' : 'none';
      caret.style.transform = expanded ? 'rotate(90deg)' : '';
    });

    wrap.appendChild(header);
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    scrollBottom();
    lastToolEl = wrap;

    if (!_restoring) {
      storedMsgData.push({ type: 'tool', toolName: name, args, result: null });
      lastToolDataIdx = storedMsgData.length - 1;
      saveToStorage();
    }
  }

  function updateLastToolResult(content) {
    if (!lastToolEl) return;
    const resEl = lastToolEl.querySelector('[data-role="tool-result"]');
    if (resEl) {
      resEl.classList.remove('pending');
      resEl.className = 'tool-result';
      const truncated = String(content).slice(0, 600);
      resEl.textContent = truncated + (String(content).length > 600 ? '…' : '');
    }
    if (!_restoring && lastToolDataIdx >= 0) {
      storedMsgData[lastToolDataIdx].result = String(content).slice(0, 600);
      saveToStorage();
    }
  }

  function removeThinking() {
    messagesEl.querySelector('[data-role="thinking"]')?.remove();
  }

  function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
  function setStatus(t)   { statusBar.textContent = t; }

  function setBusy(b) {
    busy = b;
    btnSend.disabled = b;
    inputEl.disabled = b;
  }

  // ── Server message handler ─────────────────────────────────────────────────
  function handleMsg(msg) {
    switch (msg.type) {

      case 'pong': break;

      case 'status':
        setStatus(msg.text || '');
        break;

      case 'thinking':
        currentAssistantEl   = null;
        currentAssistantText = '';
        lastToolEl = null;
        appendMsg('thinking', '');
        setBusy(true);
        break;

      case 'stream':
        handleStreamEvent(msg.data);
        break;

      case 'raw':
        // Unparseable line from claude — show as assistant text
        if (!currentAssistantEl) {
          currentAssistantText = '';
          currentAssistantEl   = appendMsg('assistant', '');
        }
        currentAssistantText += msg.text + '\n';
        renderMd(currentAssistantEl, currentAssistantText);
        scrollBottom();
        break;

      case 'done':
        removeThinking();
        setBusy(false);
        currentAssistantEl   = null;
        currentAssistantText = '';
        lastToolEl = null;
        break;

      case 'queued':
        setStatus(`Message queued (${msg.queueLength} waiting)…`);
        break;

      case 'session_id':
        localStorage.setItem(SESSION_KEY, msg.id);
        break;

      case 'error':
        removeThinking();
        setBusy(false);
        appendMsg('error', '⚠ ' + (msg.text || 'Unknown error'));
        break;
    }
  }

  // ── VNC iframe health polling ──────────────────────────────────────────────
  function pollVnc() {
    try {
      const doc = vncFrame.contentDocument || vncFrame.contentWindow?.document;
      if (!doc || doc.readyState === 'loading') { setVncDot('connecting'); return; }

      // vnc_clean.html exposes #vnc-status whose className = connection state
      const cleanStatus = doc.getElementById('vnc-status');
      if (cleanStatus) {
        const s = cleanStatus.className; // 'connecting' | 'connected' | 'disconnected' | 'error'
        setVncDot(s === 'connected' ? 'connected'
                : s === 'disconnected' ? 'disconnected'
                : s === 'error' ? 'error'
                : 'connecting');
        return;
      }

      // Fallback for legacy vnc_auto.html
      const bar  = doc.getElementById('noVNC_status_bar');
      const text = (doc.getElementById('noVNC_status')?.textContent || bar?.textContent || '').toLowerCase();
      if (text.includes('connect') && !text.includes('disconnect')) { setVncDot('connected'); }
      else if (text.includes('disconnect') || text.includes('closed') || text.includes('wrong')) { setVncDot('disconnected'); }
      else if (text.includes('connect')) { setVncDot('connecting'); }
      else { setVncDot('unknown'); }
    } catch { setVncDot('unknown'); }
  }
  setInterval(pollVnc, 3000);

  // ── MCP health polling ─────────────────────────────────────────────────────
  async function pollMcp() {
    try {
      const res = await fetch('/mcp-health', { cache: 'no-store' });
      const data = await res.json();
      if (data.ok) {
        // Only upgrade to connected if currently unknown/disconnected (don't override session-init detection)
        if (cdotMcp.className.includes('unknown') || cdotMcp.className.includes('disconnected')) {
          setMcpDot('connected');
        }
      } else {
        setMcpDot('disconnected');
      }
    } catch { setMcpDot('disconnected'); }
  }
  setInterval(pollMcp, 15000);

  // ── Usage section (5h / 7d / ctx + meta) ─────────────────────────────────
  const fill5h    = $('fill-5h');
  const pct5h     = $('pct-5h');
  const time5h    = $('time-5h');
  const fill7d    = $('fill-7d');
  const pct7d     = $('pct-7d');
  const time7d    = $('time-7d');
  const fillCtx   = $('fill-ctx');
  const pctCtx    = $('pct-ctx');
  const metaModel = $('meta-model');
  const metaEmail = $('meta-email');
  const metaSep   = $('meta-sep');

  function usageColor(p) {
    return p > 80 ? 'var(--red)' : p > 50 ? 'var(--orange)' : 'var(--green)';
  }

  function setBar(fill, pctEl, pct) {
    const p = Math.min(100, Math.max(0, pct || 0));
    fill.style.width = p + '%';
    fill.style.background = usageColor(p);
    pctEl.textContent = p.toFixed(0) + '%';
  }

  function formatResetTime(tsSec, includeDay) {
    if (!tsSec) return '';
    const remaining = tsSec * 1000 - Date.now();
    if (remaining <= 0) return 'reset now';
    const totalSecs = Math.floor(remaining / 1000);
    let timeLeft;
    if (includeDay) {
      const days = Math.floor(totalSecs / 86400);
      const hrs  = Math.floor((totalSecs % 86400) / 3600);
      timeLeft = days > 0 ? `${days}d${String(hrs).padStart(2, '0')}h` : `${hrs}h`;
    } else {
      const h = Math.floor(totalSecs / 3600);
      const m = Math.floor((totalSecs % 3600) / 60);
      timeLeft = h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
    }
    const d = new Date(tsSec * 1000);
    const opts = includeDay
      ? { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }
      : { hour: 'numeric', minute: '2-digit', hour12: true };
    const resetStr = d.toLocaleString('en', opts).toLowerCase().replace(',', '');
    return `${timeLeft} (${resetStr})`;
  }

  async function pollUsage() {
    try {
      const res  = await fetch('/usage', { cache: 'no-store' });
      const data = await res.json();
      if (!data.ok) return;

      const rl = data.rateLimits || {};
      const b  = data.block      || {};
      const w  = data.week       || {};

      // 5h bar
      const fivePct = rl.five_hour_pct != null ? rl.five_hour_pct : (b.pct || 0);
      setBar(fill5h, pct5h, fivePct);
      const fiveReset = rl.five_hour_resets_at || (b.resetsAtMs ? b.resetsAtMs / 1000 : null);
      if (time5h) time5h.textContent = formatResetTime(fiveReset, false);

      // 7d bar
      const sevenPct = rl.seven_day_pct != null ? rl.seven_day_pct : (w.pct || 0);
      setBar(fill7d, pct7d, sevenPct);
      if (time7d) time7d.textContent = formatResetTime(rl.seven_day_resets_at, true);

      // ctx bar — from rateLimits file (updated each Claude Code turn)
      if (rl.ctx_pct != null) setBar(fillCtx, pctCtx, rl.ctx_pct);

      // Model + email
      if (metaModel && rl.model) metaModel.textContent = rl.model;
      if (metaEmail && rl.email) metaEmail.textContent = rl.email;
      if (metaSep) metaSep.style.visibility = (rl.model && rl.email) ? 'visible' : 'hidden';

    } catch { /* silent */ }
  }

  pollUsage();
  setInterval(pollUsage, 30_000);

  // ── MCP reconnect button ───────────────────────────────────────────────────
  if (cbtnMcp) {
    cbtnMcp.onclick = () => {
      setMcpDot('connecting');
      // Reset Claude session so next message spawns a fresh process that reconnects to MCP
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'reset' }));
      showToast('MCP session reset — send a message to reconnect', 'info');
      setTimeout(pollMcp, 3000);
    };
  }

  // ── Browser (VNC) reconnect button ────────────────────────────────────────
  if (cbtnVnc) {
    cbtnVnc.onclick = () => {
      setVncDot('connecting');
      // Reload the noVNC iframe to force a fresh connection
      const src = vncFrame.src;
      vncFrame.src = '';
      setTimeout(() => { vncFrame.src = src; }, 300);
      showToast('Reconnecting browser display…', 'info');
    };
  }

  // ── Clipboard paste into VNC ───────────────────────────────────────────────
  async function pasteClipboardToVnc() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) { showToast('Clipboard is empty', 'warning'); return; }
      const res = await fetch('/type-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (data.ok) showToast('Pasted into browser', 'success');
      else showToast('Paste failed: ' + (data.error || 'unknown'), 'error');
    } catch (e) {
      showToast('Clipboard access denied — grant permission and try again', 'error');
    }
  }

  const btnVncPaste = $('btn-vnc-paste');
  if (btnVncPaste) btnVncPaste.onclick = pasteClipboardToVnc;

  // Ctrl+V when chat panel has focus (user typed in input, then wants to paste into browser)
  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'v' && document.activeElement !== inputEl) {
      e.preventDefault();
      pasteClipboardToVnc();
    }
  });

  // ── Parse Claude CLI stream-json events ────────────────────────────────────
  function handleStreamEvent(ev) {
    if (!ev?.type) return;

    if (ev.type === 'system' && ev.subtype === 'init') {
      // tools array contains plain strings or objects depending on CLI version
      const hasMcp = (ev.tools || []).some(t => {
        const name = typeof t === 'string' ? t : (t?.name || '');
        return name.startsWith('mcp__playwright__');
      });
      setMcpDot(hasMcp ? 'connected' : 'disconnected');
      setStatus('Claude Code session ready — tools loaded.');
      return;
    }

    if (ev.type === 'assistant') {
      // Complete assistant message (possibly with tool_use blocks)
      const content = ev.message?.content || [];
      currentAssistantEl   = null;
      currentAssistantText = '';
      lastToolEl = null;

      for (const block of content) {
        if (block.type === 'text') {
          if (!currentAssistantEl) {
            currentAssistantEl = appendMsg('assistant', '');
          }
          currentAssistantText += block.text;
          renderMd(currentAssistantEl, currentAssistantText);
          scrollBottom();
        } else if (block.type === 'tool_use') {
          appendToolMsg(block.name, block.input);
          currentAssistantEl   = null;
          currentAssistantText = '';
        }
      }
      return;
    }

    if (ev.type === 'tool_result') {
      // Tool execution result from Claude Code
      const content = ev.content?.[0]?.text || ev.result || '';
      updateLastToolResult(content);
      return;
    }

    if (ev.type === 'result') {
      const dur = ev.duration_ms ? ` in ${(ev.duration_ms / 1000).toFixed(1)}s` : '';
      const cost = ev.total_cost_usd ? ` · $${ev.total_cost_usd.toFixed(4)}` : '';
      setStatus(`Done${dur}${cost}`);
      removeThinking();
      setBusy(false);
      // Persist final accumulated assistant text
      if (lastAssistantDataIdx >= 0 && currentAssistantText) {
        storedMsgData[lastAssistantDataIdx].text = currentAssistantText;
        saveToStorage();
      }
      // Update ctx bar from live usage
      const inputTokens = ev.usage?.input_tokens || 0;
      if (inputTokens > 0) {
        const ctxPct = (inputTokens / 200_000) * 100;
        setBar(fillCtx, pctCtx, ctxPct);
        if (ctxPct >= 40) showContextWarning(ctxPct);
        else hideContextWarning();
      }
      return;
    }
  }

  // ── Restore saved chat from localStorage ───────────────────────────────────
  function renderStoredDisplay(msgs) {
    _restoring = true;
    messagesEl.innerHTML = '';
    storedMsgData        = [];
    lastAssistantDataIdx = -1;
    lastToolDataIdx      = -1;

    for (const m of msgs) {
      storedMsgData.push(m);
      if (m.type === 'tool') {
        appendToolMsg(m.toolName, m.args);
        lastToolDataIdx = storedMsgData.length - 1;
        // Restore completed result
        if (m.result !== null && lastToolEl) {
          const resEl = lastToolEl.querySelector('[data-role="tool-result"]');
          if (resEl) {
            resEl.classList.remove('pending');
            resEl.className = 'tool-result';
            resEl.textContent = m.result;
          }
        }
      } else {
        appendMsg(m.type, m.text || '');
        if (m.type === 'assistant') lastAssistantDataIdx = storedMsgData.length - 1;
      }
    }

    _restoring = false;
    scrollBottom();
  }

  // ── WebSocket connection ───────────────────────────────────────────────────
  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function startKeepalive() {
    stopKeepalive();
    keepaliveInterval = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 25_000);
  }
  function stopKeepalive() { clearInterval(keepaliveInterval); keepaliveInterval = null; }

  function scheduleReconnect() {
    const delay = Math.min(2000 * Math.pow(2, wsReconnectAttempt), 30_000);
    wsReconnectAttempt++;
    statusDot.className = 'dot connecting';
    setWsDot('reconnecting');
    setStatus(`Reconnecting in ${Math.ceil(delay / 1000)}s…`);
    wsReconnectTimer = setTimeout(connect, delay);
  }

  function connect() {
    clearTimeout(wsReconnectTimer);
    statusDot.className = 'dot connecting';
    setWsDot('connecting');
    setStatus('Connecting…');
    ws = new WebSocket(wsUrl());

    ws.onopen = () => {
      wsReconnectAttempt = 0;
      statusDot.className = 'dot connected';
      setWsDot('connected');
      startConnTime();
      btnSend.disabled = false;
      startKeepalive();
      const prevSessionId = localStorage.getItem(SESSION_KEY);
      if (prevSessionId) {
        ws.send(JSON.stringify({ type: 'resume_session', id: prevSessionId }));
        if (hasConnectedBefore) showToast('Reconnected — restoring context…', 'success');
      } else {
        if (hasConnectedBefore) showToast('Reconnected', 'success');
      }
      hasConnectedBefore = true;
    };

    ws.onclose = () => {
      stopKeepalive();
      setBusy(false);
      statusDot.className = 'dot disconnected';
      setWsDot('disconnected');
      if (hasConnectedBefore) showToast('Disconnected — reconnecting…', 'warning');
      scheduleReconnect();
    };

    ws.onerror = () => { statusDot.className = 'dot error'; setWsDot('error'); };

    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleMsg(msg);
    };
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;
    appendMsg('user', text);
    inputEl.value = '';
    inputEl.style.height = 'auto';
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'chat', text }));
    }
  }

  btnSend.onclick = sendMessage;
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  });

  btnReset.onclick = () => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'reset' }));
    messagesEl.innerHTML = '';
    currentAssistantEl   = null;
    currentAssistantText = '';
    lastToolEl = null;
    setBusy(false);
    hideContextWarning();
    setMcpDot('unknown');
    storedMsgData        = [];
    lastAssistantDataIdx = -1;
    lastToolDataIdx      = -1;
    saveToStorage();
    localStorage.removeItem(SESSION_KEY);
    showToast('Session reset', 'info');
  };

  // ── Resizable divider ─────────────────────────────────────────────────────
  const divider   = $('divider');
  const chatPanel = $('chat-panel');
  let dragging = false;

  divider.addEventListener('mousedown', e => { dragging = true; divider.classList.add('dragging'); e.preventDefault(); });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.max(200, Math.min(e.clientX, window.innerWidth * 0.6));
    chatPanel.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; divider.classList.remove('dragging'); });

  // ── Init ──────────────────────────────────────────────────────────────────
  const savedMsgs = loadFromStorage();
  if (savedMsgs.length > 0) renderStoredDisplay(savedMsgs);

  connect();
})();
