// Patch: (1) move Sign Out from room dropdown into settings dropdown,
// (2) pin the "Task rooms" button to the bottom of the room dropdown.
// Idempotent: aborts if already applied.
const fs = require('fs');
const DIR = '/var/www/html/claude-code-bridge-standalone/public';
const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);

function patch(file, edits, guardStr) {
  const p = DIR + '/' + file;
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes(guardStr)) { console.log(file + ': already patched, skip'); return; }
  fs.writeFileSync(p + '.bak-footer-' + ts, s);
  for (const [from, to] of edits) {
    if (!s.includes(from)) { console.error(file + ': ANCHOR NOT FOUND ->\n' + from); process.exit(2); }
    s = s.replace(from, to);
  }
  fs.writeFileSync(p, s);
  console.log(file + ': patched OK (backup .bak-footer-' + ts + ')');
}

// ---------- index.html ----------
patch('index.html', [
  [
`            <div id="session-list"></div>
            <button id="btn-logout" class="sess-logout">Sign Out</button>`,
`            <div id="session-list"></div>
            <div id="session-footer"></div>`
  ],
  [
`            <button id="btn-switch-account" title="Switch Claude account">👤 Accounts</button>`,
`            <button id="btn-switch-account" title="Switch Claude account">👤 Accounts</button>
            <button id="btn-logout" title="Sign out">🚪 Sign Out</button>`
  ],
], 'id="session-footer"');

// ---------- style.css ----------
patch('style.css', [
  [
`#session-dropdown {
  position: fixed;
  background: var(--bg-header); border: 1px solid var(--border);
  border-radius: 6px; min-width: 230px; max-width: calc(100vw - 8px); max-height: 320px; box-sizing: border-box;
  overflow-y: auto; z-index: 9999;
  box-shadow: 0 6px 20px rgba(0,0,0,0.5);
}`,
`#session-dropdown {
  position: fixed;
  background: var(--bg-header); border: 1px solid var(--border);
  border-radius: 6px; min-width: 230px; max-width: calc(100vw - 8px); max-height: 320px; box-sizing: border-box;
  display: flex; flex-direction: column; overflow: hidden; z-index: 9999;
  box-shadow: 0 6px 20px rgba(0,0,0,0.5);
}
#session-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
#session-list::-webkit-scrollbar { width: 4px; }
#session-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
#session-footer { flex: 0 0 auto; }
#session-footer .sess-new { border-bottom: none; border-top: 1px solid var(--border); }
#task-rooms-box { max-height: 200px; overflow-y: auto; }
#settings-dropdown #btn-logout { color: var(--red); }`
  ],
], '#session-footer {');

// ---------- app.js ----------
patch('app.js', [
  [
`  async function loadSessions() {
    sessionList.innerHTML = '';`,
`  async function loadSessions() {
    sessionList.innerHTML = '';
    const sessionFooter = document.getElementById('session-footer');
    if (sessionFooter) sessionFooter.innerHTML = '';`
  ],
  [
`      for (const s of normal) sessionList.appendChild(makeRow(s));
      if (taskRooms.length) {
        const toggle = document.createElement('button');
        toggle.className = 'sess-new';
        toggle.style.opacity = '0.85';
        const box = document.createElement('div');
        box.style.display = 'none';
        let built = false;
        const setLabel = (open) => { toggle.textContent = \`\${open ? '▾' : '▸'} Task rooms (\${taskRooms.length})\`; };
        setLabel(false);
        toggle.onclick = () => {
          const open = box.style.display === 'none';
          box.style.display = open ? 'block' : 'none';
          setLabel(open);
          if (open && !built) { for (const s of taskRooms) box.appendChild(makeRow(s)); built = true; }
        };
        sessionList.appendChild(toggle);
        sessionList.appendChild(box);
      }`,
`      for (const s of normal) sessionList.appendChild(makeRow(s));
      if (taskRooms.length && sessionFooter) {
        const toggle = document.createElement('button');
        toggle.className = 'sess-new';
        toggle.style.opacity = '0.85';
        const box = document.createElement('div');
        box.id = 'task-rooms-box';
        box.style.display = 'none';
        let built = false;
        const setLabel = (open) => { toggle.textContent = \`\${open ? '▾' : '▸'} Task rooms (\${taskRooms.length})\`; };
        setLabel(false);
        toggle.onclick = () => {
          const open = box.style.display === 'none';
          box.style.display = open ? 'block' : 'none';
          setLabel(open);
          if (open && !built) { for (const s of taskRooms) box.appendChild(makeRow(s)); built = true; }
        };
        sessionFooter.appendChild(toggle);
        sessionFooter.appendChild(box);
      }`
  ],
], "getElementById('session-footer')");

console.log('ALL DONE');
