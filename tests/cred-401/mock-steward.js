#!/usr/bin/env node
// Mock credential-steward for the [CRED_401_HEAL_V3] e2e fixture. Same CLI surface the
// bridge uses (active-claude / issue-claude) and the same layer2 -> layer3 copy with the
// refresh token stripped. Entirely inside the fixture HOME: no shared Procyss credential
// is read or written by these tests.
'use strict';
const fs = require('fs'), path = require('path');
const H = process.env.HOME;
const ACCT = 'Fixture';
const snap = path.join(H, '.claude', 'accounts', ACCT + '.credentials.json');
const [cmd, a, b] = process.argv.slice(2);

if (cmd === 'active-claude') { process.stdout.write(ACCT); process.exit(0); }
if (cmd === 'issue-claude') {
  const dir = b || a;
  const raw = JSON.parse(fs.readFileSync(snap, 'utf8'));
  const o = raw.claudeAiOauth || raw;
  delete o.refreshToken;                       // layer 3 is fail-closed, exactly as in prod
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify(raw));
  process.stdout.write(JSON.stringify({ ok: true, name: ACCT, expiresAt: Number(o.expiresAt || 0) }));
  process.exit(0);
}
process.stderr.write('STEWARD_ERR unknown\n');
process.exit(1);
