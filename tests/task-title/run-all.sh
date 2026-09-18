#!/bin/bash
# TASK_TITLE_HAIKU_V1 — one-command proof. Copies the CURRENT live files and runs
# every matrix against them. Re-runnable by anyone, any time, read-only w.r.t. the app.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
LIVE=/var/www/html/claude-code-bridge-standalone
WORK="$(mktemp -d)"; mkdir -p "$WORK/public"
trap 'rm -rf "$WORK"' EXIT

cp "$LIVE/bridge-server.js" "$WORK/" || exit 1
cp "$LIVE/public/app.js"    "$WORK/public/" || exit 1

echo "=== files under test ==="
md5sum "$LIVE/bridge-server.js" "$LIVE/public/app.js"

echo
echo "=== syntax ==="
cp "$WORK/bridge-server.js" "$WORK/s.js"; node --check "$WORK/s.js" && echo "  OK bridge-server.js"
cp "$WORK/public/app.js"    "$WORK/c.js"; node --check "$WORK/c.js" && echo "  OK app.js"

rc=0
for t in test-server test-client test-mixed-version test-roomtask-server test-roomtask-form; do
  [ -f "$HERE/$t.cjs" ] || continue
  sed "s#/tmp/ttlive#$WORK#g" "$HERE/$t.cjs" > "$WORK/$t.cjs"
  echo; echo "=== $t ==="
  node "$WORK/$t.cjs" || rc=1
done

echo
echo "=== live process state ==="
if curl -s -o /dev/null -w '' --max-time 3 http://127.0.0.1:3467/ping 2>/dev/null; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -X POST \
    http://127.0.0.1:3467/task-title -H 'Content-Type: application/json' -d '{"text":""}')
  if [ "$code" = "404" ]; then
    echo "  POST /task-title -> 404  ==> running process still holds PRE-PATCH code (restart pending)"
  else
    echo "  POST /task-title -> $code  ==> patched server is LIVE"
  fi
else
  echo "  bridge not reachable on :3467"
fi
exit $rc
