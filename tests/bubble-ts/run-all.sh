#!/bin/bash
# [BUBBLE_TS_V1] One-command proof. Copies the CURRENT live files and runs every
# matrix against them. Re-runnable by anyone, any time, read-only w.r.t. the app.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
LIVE=${LIVE:-/var/www/html/claude-code-bridge-standalone}
WORK="$(mktemp -d)"; mkdir -p "$WORK/public"
trap 'rm -rf "$WORK"' EXIT
cp "$LIVE/bridge-server.js" "$WORK/" || exit 1
cp "$LIVE/public/app.js" "$LIVE/public/style.css" "$LIVE/public/index.html" "$WORK/public/" || exit 1

echo "=== files under test ==="; md5sum "$LIVE/bridge-server.js" "$LIVE/public/app.js"
echo; echo "=== syntax ==="
node --check "$WORK/bridge-server.js" && echo "  OK bridge-server.js"
cp "$WORK/public/app.js" "$WORK/c.js"; node --check "$WORK/c.js" && echo "  OK app.js"

rc=0
for t in test-client test-server; do
  sed "s#__WORK__#$WORK#g" "$HERE/$t.cjs" > "$WORK/$t.cjs"
  echo; echo "=== $t ==="; node "$WORK/$t.cjs" || rc=1
done
echo; echo "=== timezone independence (AC6/AC8) ==="
for TZV in UTC Pacific/Auckland Asia/Tokyo America/Argentina/Buenos_Aires; do
  printf "  TZ=%-34s %s\n" "$TZV" "$(TZ=$TZV node "$WORK/test-client.cjs" 2>&1 | tail -1)"
done
echo; echo "=== CSS contract ==="
grep -q 'data-ts\]::after' "$WORK/public/style.css" && echo "  OK ::after stamp rule present"
grep -q 'user-select: none' "$WORK/public/style.css" && echo "  OK non-selectable"
grep -qE 'app\.js\?v=bubblets' "$WORK/public/index.html" && echo "  OK cache-bust bumped"
exit $rc
