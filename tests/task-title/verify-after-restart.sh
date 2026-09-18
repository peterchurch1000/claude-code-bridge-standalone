#!/bin/bash
# TASK_TITLE_HAIKU_V1 — post-restart acceptance checks (server half, automated).
# Read-only by default. The task-store check mutates the Organiser, so it is
# opt-in: pass --create-task to run it.
set -u
B=http://127.0.0.1:3467
pass=0; fail=0
ok(){ if [ "$2" = 1 ]; then pass=$((pass+1)); echo "  ✓ $1"; else fail=$((fail+1)); echo "  ✗ $1 ${3:-}"; fi; }

echo "=== 0. the running process loaded the patched server ==="
# blank text returns immediately without spawning a model -> pure liveness probe
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -X POST $B/task-title \
  -H 'Content-Type: application/json' -d '{"text":""}')
[ "$code" = "200" ] && ok "POST /task-title -> 200 (patched code is live)" 1 \
  || { ok "POST /task-title -> $code (expected 200)" 0; echo; echo "STOP: bridge not restarted yet."; exit 1; }

echo
echo "=== 1. Haiku title: 5-7 words, full Description preserved ==="
TXT='There are two little errors with the pop-up that associates a conference room with a task when I set up a new conference room. The title field is prefilled with the text I just entered, and the whole popup runs twice.'
BODY=$(TXT="$TXT" node -e 'process.stdout.write(JSON.stringify({text:process.env.TXT}))')
R=$(curl -s --max-time 40 -X POST $B/task-title -H 'Content-Type: application/json' -d "$BODY")
jget(){ R="$R" node -e 'try{process.stdout.write(String((JSON.parse(process.env.R)||{})["'"$1"'"]??""))}catch(e){}'; }
TITLE=$(jget title); SRC=$(jget source)
echo "  title:  $TITLE"
WC=$(echo "$TITLE" | wc -w)
[ -n "$TITLE" ] && ok "a title was generated" 1 || ok "a title was generated" 0
{ [ "$WC" -ge 5 ] && [ "$WC" -le 7 ]; } && ok "title is 5-7 words (got $WC)" 1 || ok "title is 5-7 words (got $WC)" 0
[ "$TITLE" != "$TXT" ] && ok "title is NOT the raw typed text (defect #1)" 1 || ok "title is NOT the raw typed text" 0
[ "$SRC" = "$(echo "$TXT" | tr -s ' ')" ] && ok "Description source preserved in full (${#SRC} chars)" 1 \
  || ok "Description source preserved in full" 0 "(got ${#SRC} vs ${#TXT})"

echo
echo "=== 2. fallback behaviour ==="
R2=$(curl -s --max-time 10 -X POST $B/task-title -H 'Content-Type: application/json' -d '{"text":"   "}')
[ "$(R="$R2" node -e 'try{process.stdout.write(String(JSON.parse(process.env.R).title||""))}catch(e){}')" = "" ] && ok "blank input -> empty title, no hang" 1 || ok "blank input -> empty title" 0
[ "$(R="$R2" node -e 'try{process.stdout.write(String(JSON.parse(process.env.R).ok))}catch(e){}')" = "true" ] && ok "  still a well-formed 200 response" 1 || ok "  well-formed response" 0

echo
echo "=== 3. task store: the condition defect #2 depends on ==="
if [ "${1:-}" = "--create-task" ]; then
  NEW=$(curl -s --max-time 15 -X POST $B/tasks -H 'Content-Type: application/json' \
        -d '{"title":"TASK_TITLE_HAIKU_V1 verification probe","description":"Delete me."}')
  F=$(R="$NEW" node -e 'try{process.stdout.write(String(JSON.parse(process.env.R).file||""))}catch(e){}'); echo "  created: $F"
  [ -n "$F" ] && [ "$F" != "null" ] && ok "task created in the store" 1 || ok "task created" 0
  MD="$HOME/workspace/tasks/$F"
  [ ! -f "$MD" ] && ok ".md NOT written yet (the old code would have rejected this)" 1 \
                 || ok ".md already present — daemon won the race; re-run to observe the gap" 1
  if curl -s --max-time 10 $B/tasks | F="$F" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.exit((JSON.parse(d).tasks||[]).some(t=>t&&t.file===process.env.F)?0:1)}catch(e){process.exit(1)}})'; then
    ok "task IS visible via the API -> confCanonicalTask now resolves it" 1
  else ok "task visible via the API" 0; fi
  echo "  NOTE: remove the probe task from the Tasks panel when done."
else
  echo "  skipped (read-only). Pass --create-task to exercise it."
fi

echo
echo "$( [ $fail -gt 0 ] && echo '✗' || echo '✓' ) $pass passed, $fail failed"
echo
echo "Remaining, browser-only (verification stage):"
echo "  - hard-reload the client (Ctrl-Shift-R)"
echo "  - start a conference -> 'Create a new task': placeholder appears, then ONE populated form"
echo "  - confirm the association flow runs ONCE and exactly one task is created"
echo "  - repeat via the 🗂 'Create task & link' form"
exit $fail
