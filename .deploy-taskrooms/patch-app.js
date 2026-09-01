// Replace loadSessions() in app.js with the version that groups autonomy task
// rooms into a collapsible "Task rooms" sub-menu. New body read from arg file.
const fs = require('fs');
const P = '/var/www/html/claude-code-bridge-standalone/public/app.js';
const NEWFILE = process.argv[2];
let s = fs.readFileSync(P, 'utf8');
const NEW = fs.readFileSync(NEWFILE, 'utf8').replace(/\n$/, '');

if (s.includes('Task rooms (')) {
  console.error('ALREADY PATCHED (Task rooms present) — aborting');
  process.exit(3);
}

const startAnchor = '  async function loadSessions() {';
const endAnchor = "      empty.textContent = 'Failed to load rooms';\n      sessionList.appendChild(empty);\n    }\n  }";
const i = s.indexOf(startAnchor);
if (i < 0) { console.error('START anchor not found'); process.exit(1); }
const j = s.indexOf(endAnchor, i);
if (j < 0) { console.error('END anchor not found'); process.exit(2); }
const end = j + endAnchor.length;
s = s.slice(0, i) + NEW + s.slice(end);
fs.writeFileSync(P, s);
console.log('app.js loadSessions replaced OK');
