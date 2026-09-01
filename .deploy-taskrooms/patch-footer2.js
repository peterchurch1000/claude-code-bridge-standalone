// Fix: preserve the "Task rooms" expanded state across loadSessions() re-renders
// (socket updates re-run loadSessions constantly on an active room, which was
// collapsing the list the instant it was opened). Persist state in a var outside
// loadSessions and restore it on every rebuild.
const fs = require('fs');
const p = '/var/www/html/claude-code-bridge-standalone/public/app.js';
const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
let s = fs.readFileSync(p, 'utf8');
if (s.includes('taskRoomsExpanded')) { console.log('already patched, skip'); process.exit(0); }
fs.writeFileSync(p + '.bak-footer2-' + ts, s);

const A1 = `  async function loadSessions() {
    sessionList.innerHTML = '';
    const sessionFooter = document.getElementById('session-footer');`;
const A1n = `  let taskRoomsExpanded = false;
  async function loadSessions() {
    sessionList.innerHTML = '';
    const sessionFooter = document.getElementById('session-footer');`;
if (!s.includes(A1)) { console.error('A1 anchor missing'); process.exit(2); }
s = s.replace(A1, A1n);

const A2 = `      for (const s of normal) sessionList.appendChild(makeRow(s));
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
      }`;
const A2n = `      for (const s of normal) sessionList.appendChild(makeRow(s));
      if (taskRooms.length && sessionFooter) {
        const toggle = document.createElement('button');
        toggle.className = 'sess-new';
        toggle.style.opacity = '0.85';
        const box = document.createElement('div');
        box.id = 'task-rooms-box';
        const setLabel = (open) => { toggle.textContent = \`\${open ? '▾' : '▸'} Task rooms (\${taskRooms.length})\`; };
        const render = (open) => {
          box.style.display = open ? 'block' : 'none';
          if (open && !box.childElementCount) { for (const s of taskRooms) box.appendChild(makeRow(s)); }
          setLabel(open);
        };
        render(taskRoomsExpanded);   // restore prior open/closed state after a re-render
        toggle.onclick = () => { taskRoomsExpanded = !taskRoomsExpanded; render(taskRoomsExpanded); };
        sessionFooter.appendChild(toggle);
        sessionFooter.appendChild(box);
      }`;
if (!s.includes(A2)) { console.error('A2 anchor missing'); process.exit(3); }
s = s.replace(A2, A2n);

fs.writeFileSync(p, s);
console.log('app.js task-rooms state-persistence patched OK (backup .bak-footer2-' + ts + ')');
