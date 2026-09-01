// Patch bridge-server.js: tag autonomy per-task/pool rooms in /sessions so the
// client can tuck them into a "Task rooms" sub-menu. Idempotent-ish (guards on marker).
const fs = require('fs');
const P = '/var/www/html/claude-code-bridge-standalone/bridge-server.js';
let s = fs.readFileSync(P, 'utf8');

if (s.includes('function readAutonomyRooms(')) {
  console.error('ALREADY PATCHED (readAutonomyRooms present) — aborting');
  process.exit(3);
}

// 1) Insert the helper just before the /sessions route.
const routeAnchor = "app.get('/sessions', (req, res) => {";
const ri = s.indexOf(routeAnchor);
if (ri < 0) { console.error('route anchor not found'); process.exit(1); }
const helper =
`// Autonomy per-task/pool room ids (from ~/.claude/autonomy/rooms/*.sid) so the
// /sessions list can tag + group them into the client's "Task rooms" sub-menu
// instead of flooding the main room dropdown. Cheap dir read per request.
function readAutonomyRooms() {
  const m = new Map();
  try {
    const dir = path.join(os.homedir(), '.claude', 'autonomy', 'rooms');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.sid')) continue;
      let id = '';
      try { id = fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch {}
      if (!id) continue;
      const key = f.replace(/\\.sid$/, '');
      m.set(id, { key, kind: key.startsWith('pool-') ? 'pool' : 'task' });
    }
  } catch {}
  return m;
}

`;
s = s.slice(0, ri) + helper + s.slice(ri);

// 2) Replace the sessions map/sort/slice block to add taskRoom + independent caps.
const mapAnchor =
`    const sessions = Object.entries(merged)
      .map(([id, v]) => {
        const room = clientSessions.get(id);   // a live room currently exists for this session id
        return { id, updatedAt: v.updatedAt, preview: v.preview, lastMessage: v.lastMessage || '', name: sessionNames[id] || '',
          active: !!room, busy: !!(room && room.processing), viewers: room ? room.sockets.size : 0 };
      })
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 50);
    res.json({ sessions });`;
const mapReplace =
`    const _autoRooms = readAutonomyRooms();
    const _all = Object.entries(merged)
      .map(([id, v]) => {
        const room = clientSessions.get(id);   // a live room currently exists for this session id
        const _ar = _autoRooms.get(id) || null;
        return { id, updatedAt: v.updatedAt, preview: v.preview, lastMessage: v.lastMessage || '', name: sessionNames[id] || '',
          active: !!room, busy: !!(room && room.processing), viewers: room ? room.sockets.size : 0,
          taskRoom: _ar ? _ar.key : null };
      })
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    // Keep autonomy task rooms from crowding normal rooms out of the top list:
    // cap the two groups independently (the client tucks task rooms into a sub-menu).
    const _normal = _all.filter(x => !x.taskRoom).slice(0, 50);
    const _task   = _all.filter(x => x.taskRoom).slice(0, 100);
    res.json({ sessions: [..._normal, ..._task] });`;
if (!s.includes(mapAnchor)) { console.error('map anchor not found'); process.exit(2); }
s = s.replace(mapAnchor, mapReplace);

fs.writeFileSync(P, s);
console.log('bridge-server.js patched OK');
