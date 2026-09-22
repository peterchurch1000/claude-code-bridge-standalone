#!/usr/bin/env node
'use strict';
// [ORCH_UI_V1] Idempotent: append the orchestration panel to public/app.js.
// Usage: node patch-orch-ui.cjs <path-to-app.js> <path-to-orch-ui.js> [--write]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const [target, uiSrc] = process.argv.slice(2);
const doWrite = process.argv.includes('--write');
if (!target || !uiSrc) { console.error('usage: patch-orch-ui.cjs <app.js> <orch-ui.js> [--write]'); process.exit(2); }

let src = fs.readFileSync(target, 'utf8');
const ui = fs.readFileSync(uiSrc, 'utf8');

if (src.includes('[ORCH_UI_V1]')) { console.log('skipped: panel already present'); process.exit(0); }

src = src.replace(/\s*$/, '\n') + '\n' + ui;

const tmp = path.join(os.tmpdir(), 'orch-appjs-' + process.pid + '.js');
fs.writeFileSync(tmp, src);
try { execFileSync('node', ['--check', tmp], { stdio: 'pipe' }); }
catch (e) { console.error('SYNTAX CHECK FAILED — not writing.\n' + (e.stderr || '').toString()); process.exit(1); }
fs.unlinkSync(tmp);

console.log('applied: orch panel (' + ui.split('\n').length + ' lines)');
if (doWrite) {
  const bak = target + '.bak-orchui-' + Date.now();
  fs.copyFileSync(target, bak);
  fs.writeFileSync(target, src);
  console.log('written (backup: ' + bak + ')');
} else {
  console.log('dry run OK — pass --write to apply');
}
