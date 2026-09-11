# Bridge Project — Health Check

**Author:** Claude (Opus 4.8), via Claude Code, acting for Peter Church
**Generated:** 2026-09-01 (America/Argentina/Buenos_Aires)
**Scope:** `claude-code-bridge-standalone` — the chat-UI bridge running inside the
`castle-app` container at `/var/www/html/claude-code-bridge-standalone`
(`bridge-server.js`, `public/app.js`, `room-view-relay.js`, `auth-server.js`).
**Nature:** Read-only review. **No changes have been made.** Every fix below is a
*proposal* awaiting your go-ahead.

---

## Snapshot / metrics

| Metric | Value |
|---|---|
| Tracked files in repo | 450 |
| Of which `*.bak*` (committed backups) | **402 (~89%)**, ~34 MB |
| `public/*.bak*` (served statically) | **265** |
| `.git` history size | 19 MB, 76 commits |
| `bridge-server.js` | 2,888 lines / 155 KB (single file) |
| `public/app.js` | 4,416 lines / 240 KB (single file) |
| `room-view-relay.js` | 915 lines |
| `auth-server.js` | 658 lines |
| Test suite | none (`npm test` → `exit 1`) |
| Node | v20.20.2 |

---

## Findings (by severity)

### 🔴 High

**H1 — Entire source history is publicly served over HTTP.**
`bridge-server.js:84` does `app.use(express.static('public'))`, and `public/`
holds **265 `app.js.bak-*` files**. I verified `GET /app.js.bak-acctmgmt-20260804032918`
returns **HTTP 200, 160 KB**. Any user who can reach the bridge (all multi-user
logins — peter/luciano/roy/john — and anyone who reaches the port) can download
every historical version of the front-end. That leaks internal logic, endpoint
names, and any secret/URL that ever lived in an older client build.
→ *Fix:* move backups out of `public/` (and out of the repo — see H2); optionally
add a static filter that 404s `*.bak*`.

**H2 — 402 backup files (~89% of the repo, 34 MB) are committed to git.**
`.gitignore` has no `*.bak` rule, so every `bridge-server.js.bak-*` /
`app.js.bak-*` snapshot is tracked. This bloats clones, drowns `git log`/diffs and
review tooling, and is the root cause of H1. The backups are a manual
save-before-edit habit that git itself already provides.
→ *Fix:* add `*.bak*` (and `*.orig-*`) to `.gitignore`; `git rm --cached` the 402
files (history stays intact); relocate the on-disk copies to an untracked
`_snapshots/` dir outside `public/`. Rely on git for future rollback.

**H3 — Reflected XSS in the auth server's HTML forms.**
`auth-server.js` interpolates untrusted input straight into HTML template strings
with no escaping:
- `getLoginForm(req.query.error)` → `?error=<script>…` (line ~232)
- `getForgotPasswordForm(error, success)` from `req.query` (lines ~361–362)
- `getResetPasswordForm(token)` puts `req.query.token` into a hidden `value="…"`
  → `?token="><script>…` (line ~481)
This is a real reflected-XSS vector on the login surface (credential theft via a
crafted link), only partially mitigated by it being behind nginx.
→ *Fix:* HTML-escape every interpolated value (small `esc()` helper), or render
via a templating layer that escapes by default. ~15 lines.

### 🟠 Medium

**M1 — No process-level crash guard on the bridge.**
`bridge-server.js` is one process on `0.0.0.0:3467` serving *all* rooms/users, yet
has **no `uncaughtException` / `unhandledRejection` handler** (only `auth-server.js`
handles `SIGINT`). A single unhandled promise rejection anywhere in 2,888 lines
takes down the bridge for everyone — which is likely why `peter-watchdog.sh`,
`luciano-watchdog.sh`, `reaper.sh` and `monitor.sh` exist as external restarters.
→ *Fix:* add top-level handlers that log + keep the process alive (or exit cleanly
for a supervisor to restart), and audit the hottest `async` paths for unawaited
rejections. Keep the watchdogs as belt-and-braces.

**M2 — No app-level auth on the bridge itself.**
Auth lives entirely at the nginx + `auth-server.js` (`/auth/verify`) edge; the
bridge binds `0.0.0.0` with no in-app check. If the port is ever exposed
(mis-config, a second ingress, host networking), every task/room endpoint is open.
→ *Fix:* bind to `127.0.0.1` if nginx is same-host, or add a shared-secret/JWT
check in the bridge as defence-in-depth.

**M3 — No rate limiting or lockout on auth.**
`POST /auth/login` and `/auth/forgot-password` have no throttling → password
brute-force and reset-email spam are unbounded.
→ *Fix:* add `express-rate-limit` on the auth routes + a small per-account backoff.

**M4 — No automated tests and no CI.**
`package.json` test script is a stub. For ~8,900 lines of stateful,
concurrency-heavy code (rooms, sessions, aliases, watchdogs) there is zero
regression safety net; correctness relies on manual testing in production.
→ *Fix:* start with smoke/integration tests on the pure helpers (`parseTaskFile`,
`isJunkTitle`, the file-name validators, rate scrapers) and the task REST routes;
wire a minimal GitHub Action.

### 🟡 Low / structural

**L1 — Monolithic files.** `app.js` (4,416 lines) and `bridge-server.js` (2,888)
are single files mixing routing, business logic, HTML, and helpers. Hard to
navigate, review, or test. → *Fix (incremental):* peel off cohesive modules
(task routes, session/room store, rate-scraping, static HTML) as opportunity
allows — no big-bang rewrite.

**L2 — Duplicated auth-server HTML.** Three near-identical ~120-line inline HTML
templates. → *Fix:* one shared layout + per-form body.

**L3 — Branch clutter.** `main` and `master` both exist plus five
`origin/archive/*` branches. → *Fix:* confirm `main` canonical, delete/clearly
label the rest.

**L4 — `auth.db` is group-readable (`-rw-rw-r--`, root:www-data).** Contains bcrypt
hashes (fine) and live session JWTs (sensitive). Any www-data process can read
active sessions. → *Fix:* `chmod 600` and confirm only the auth process needs it.

**L5 — Docs age.** `DEPLOYMENT_GUIDE.md` etc. date to June; the architecture has
since gained rooms, codex, roomview, watchdogs. → *Fix:* a short "current
architecture" note (much of it already lives in Peter's memory files).

---

## What is already healthy ✅

- **Command execution is safe.** All `spawn()` calls use array args (no shell
  string interpolation); no `eval`. `run-now.sh` is fed a `path.basename` +
  regex-validated filename.
- **Task/file routes validate input** — `^task-[\w.-]+\.md$` + `path.basename`
  guards against path traversal on `/taskfile`, `/tasks/:file/*`.
- **Auth crypto is sound** — bcrypt hashing, JWT sessions with a DB-backed
  allow-list, `httpOnly`/`secure`/`sameSite=strict` cookies, 1-hour reset tokens,
  parameterised SQL (no injection), and non-enumerating "forgot password" replies.
- **Secrets are gitignored** (`.env`, `auth.db`, `create-users.js`).
- **Good try/catch density** (190/192) around filesystem and network calls.

---

## Proposed fix order (fastest risk-reduction first)

1. **H1+H2 together** — `.gitignore *.bak*`, `git rm --cached`, move `public/*.bak*`
   out of the served dir. Removes the disclosure and 89% of repo bloat in one pass.
2. **H3** — escape auth-server HTML interpolation.
3. **M1** — add crash guards.
4. **M3 / M2 / L4** — rate-limit auth, tighten bind/permissions.
5. **M4 / L1–L5** — tests + incremental structural cleanup.

**I have not implemented any of these.** Tell me which items to proceed with (and
whether you'd prefer to prune the tracked `.bak` files vs. just stop serving them),
and I'll do them one at a time with a backup/rollback path for each.

— Claude (Opus 4.8), 2026-09-01


---

## Independent review and comments on Claude's findings — Codex

**Reviewer:** Codex (OpenAI), acting for Peter Church  
**Timestamp:** 2026-09-01 23:20:52 -03 (America/Argentina/Buenos_Aires)  
**Scope:** Independent, read-only health check of the current `claude-code-bridge-standalone` tree and a review of Claude's report above.  
**Change policy:** I have made no application, configuration, dependency, permission, database, or service changes. Every remedy below is a proposal requiring Peter's approval before implementation.

### Executive assessment

The bridge is functional but has accumulated substantial security, maintainability, and operational risk. Claude correctly identified the public backups, repository bloat, reflected XSS, missing rate limiting, absent tests, and monolithic structure. However, its review missed two more urgent issues: a real SMTP credential embedded in tracked source/history and unsanitized Markdown rendered with `innerHTML`. It also understated the authorization boundary and incorrectly concluded that secrets were safely gitignored.

The first response should be containment: rotate the exposed mail credential, stop serving historical files, and close both XSS paths. After that, strengthen authorization and request limits, update vulnerable dependencies, make persistence atomic, and add focused tests. These should be separate, reviewable changes with rollback points.

### Additional findings

#### Critical — plaintext SMTP credential in tracked source/history

`email-service.js` contains a working-looking SMTP password as an in-source fallback. Because the file and backup history are tracked, removing the current line alone would not invalidate the exposed credential or erase historical copies.

**Risk:** anyone who can read the repository, a backup, or served historical material may send mail as the account or abuse its reputation.

**Proposed response (approval required):**

1. Rotate/revoke the SMTP credential first and review provider logs for misuse.
2. Remove the hard-coded fallback and fail closed when the environment variable is absent.
3. Confirm the runtime secret is supplied through a protected secret/environment mechanism.
4. Inventory all tracked and served copies; decide separately whether Git-history rewriting is warranted, since that is disruptive to every clone.

Do not publish the credential value in tickets, commits, logs, or this report.

#### High — stored / LLM-mediated XSS in chat rendering

The client passes `marked.parse(...)` output into `innerHTML` without a sanitizer. User content, persisted chat content, tool output, or model output containing active HTML can therefore execute script-capable markup in another user's browser. This is more serious than ordinary cosmetic Markdown injection because bridge sessions expose powerful actions and sensitive content.

**Proposed response (approval required):** sanitize generated HTML with a maintained allow-list sanitizer such as DOMPurify; disable raw HTML in Markdown if it is not required; add Content Security Policy as defence in depth; and add regression tests using script tags, event-handler attributes, SVG payloads, `javascript:` links, and malformed markup.

#### High — privileged HTTP/WebSocket surface relies too heavily on the outer proxy

The bridge binds to `0.0.0.0` and exposes task, room, process, file, and WebSocket capabilities without a consistent application-level authorization check. Nginx authentication is useful but is a single perimeter control; direct port exposure, an alternate ingress, SSRF from a sibling service, or container-network access can bypass it. WebSocket upgrade handling deserves explicit verification because proxy auth assumptions often differ there.

**Proposed response (approval required):** bind to loopback or a private Unix socket where architecture permits; otherwise require a short-lived signed identity on every HTTP route and WebSocket upgrade, enforce per-user room/task ownership server-side, validate `Origin`, and document which reverse-proxy headers are trusted. Add authorization tests for cross-user access and direct-port access.

#### High — vulnerable dependencies

The installed dependency audit reported a high-severity Nodemailer advisory and a lower-severity `body-parser` issue. Audit output is time-sensitive and should be rerun immediately before choosing versions.

**Proposed response (approval required):** update direct dependencies to fixed supported versions, refresh the lockfile, run smoke/auth/mail/WebSocket tests, then deploy with rollback available. Avoid a blind forced audit fix that can introduce breaking upgrades.

#### Medium — authentication hardening gaps

- Login and reset flows lack rate limiting/backoff.
- Route/path-prefix isolation should not be treated as a substitute for object-level authorization.
- Resetting a password does not clearly revoke all existing sessions.
- The SQLite auth store and nearby secret material are more broadly readable than necessary.

**Proposed response (approval required):** add IP-plus-account throttling without creating account enumeration; revoke sessions on password reset and offer explicit “sign out everywhere”; tighten file ownership/modes after confirming the runtime UID; and test tenant isolation at the route and WebSocket layers.

#### Medium — persistence is non-atomic and error recovery can lose data

Several JSON state/history paths use direct writes. A crash, full disk, or concurrent write can truncate a file. Some read failures are treated like empty state, creating a risk that the next save overwrites recoverable data.

**Proposed response (approval required):** serialize writes per state file, write to a same-filesystem temporary file, `fsync`, rename atomically, retain a last-known-good copy, and distinguish “missing” from “corrupt/unreadable.” Add concurrency and injected-failure tests. Longer term, move shared mutable state to SQLite with transactions if write contention warrants it.

#### Medium — resource exhaustion and retention controls are incomplete

Request bodies, WebSocket messages, uploads, room histories, subprocess counts, logs, and saved artifacts need explicit size, count, timeout, and retention ceilings. Without them, an authenticated user, runaway model/tool, or malformed client can exhaust memory, disk, descriptors, or process slots.

**Proposed response (approval required):** define limits per surface; reject oversized input early; cap concurrent subprocesses per user/room; set execution timeouts and cleanup handlers; rotate logs; expire unused uploads/sessions/history under a documented retention policy; and alert on disk/memory/process pressure.

#### Medium — crash handling should cooperate with supervision

Claude correctly noted the lack of process-level handling, but “log + keep the process alive” after `uncaughtException` is unsafe because application state may be corrupted.

**Proposed response (approval required):** log structured context, stop accepting work, drain/close where practical, and exit non-zero for the existing supervisor to restart. Handle expected promise failures locally. Verify restart throttling so a persistent fault does not create a tight crash loop.

#### Medium — repository and deployment hygiene

The repository contains hundreds of tracked backup/original files, many under the public web root, and operational scripts have grown around production patching. This obscures the canonical source, makes review unreliable, increases accidental disclosure, and encourages production drift.

**Proposed response (approval required):** first block serving backup patterns; then inventory and move backups out of the document root; add ignore rules; remove obsolete tracked copies in a normal commit; document the canonical branch/build/deploy/restart/rollback path; and compare the deployed tree with Git before cleanup. Do not rewrite history merely to reduce repository size; reserve that for confirmed secret removal after credential rotation.

#### Medium — no effective automated regression safety net

The package test command is a stub, and there is no meaningful CI gate for security-sensitive authentication, tenant boundaries, state recovery, or WebSocket behavior.

**Proposed response (approval required):** begin with targeted integration tests for authentication/session revocation, authorization and cross-user denial, Markdown sanitization, filename/path validation, atomic state recovery, WebSocket upgrades, and mail configuration. Add syntax/lint checks and dependency auditing to CI, keeping production credentials and live external services out of tests.

#### Low / structural — oversized modules and duplicated concerns

`bridge-server.js`, `public/app.js`, `auth-server.js`, and the relay mix routing, state, process lifecycle, rendering, and integration logic. This raises change risk and makes unit testing difficult. The duplicated inline auth HTML also contributed directly to inconsistent escaping.

**Proposed response (approval required):** refactor incrementally after tests exist: extract authorization middleware, persistence adapters, process/session lifecycle, rendering/sanitization, and route groups behind stable interfaces. Avoid a big-bang rewrite.

### Review of Claude's report

| Claude item | Codex assessment |
|---|---|
| H1 — backups publicly served | **Confirmed.** Immediate disclosure reduction is justified. Also search backups for credentials before deciding retention/history treatment. |
| H2 — tracked backup bloat | **Confirmed.** Removing from the index is sensible, but first inventory production-only material and establish a canonical deployment flow. Credential rotation must precede any history-cleanup discussion. |
| H3 — reflected XSS in auth forms | **Confirmed.** Escape every output context, including HTML text and attribute values; add CSP and regression tests. This does not cover the separate Markdown `innerHTML` XSS missed by Claude. |
| M1 — no crash guard | **Partly confirmed; proposed behavior needs correction.** Do not continue after an uncaught exception. Exit cleanly/non-zero and let supervision restart. |
| M2 — no app-level auth | **Confirmed and understated.** It is an authorization/tenant-boundary concern across both HTTP and WebSocket surfaces, not only a future port-misconfiguration concern. |
| M3 — no auth throttling | **Confirmed.** Include reset-email abuse, proxy-aware client-IP handling, monitoring, and avoidance of account enumeration. |
| M4 — no tests/CI | **Confirmed.** Prioritize security and state-integrity integration tests over only pure-helper unit tests. |
| L1/L2 — monolith and duplicate HTML | **Confirmed.** Refactor only behind tests and in small stages. |
| L3 — branch clutter | **Plausible but low priority.** Verify whether archive branches are intentional before deletion. |
| L4 — auth database permissions | **Confirmed in principle.** Tighten only after verifying the actual service UID/GID and backup requirements; active session material is sensitive. |
| L5 — aging documentation | **Confirmed.** Document the present container/proxy/auth/WebSocket/supervisor topology and operational ownership. |
| “Command execution is safe” | **Too broad.** Array-form `spawn` reduces shell injection, but does not prove authorization, executable/path safety, environment safety, resource bounds, or argument-level safety across every call site. |
| “Task/file routes validate input” | **Partially supported.** Filename checks help traversal defense, but route authorization, symlink behavior, canonical paths, and all alternate file endpoints must also be tested. |
| “Auth crypto is sound” | **Mostly supported at primitive level, not as a full auth verdict.** bcrypt, parameterized SQL, and cookie flags are good; throttling, revocation, tenant authorization, proxy trust, and file permissions remain material gaps. |
| “Secrets are gitignored” | **Incorrect.** The tracked SMTP credential/fallback disproves this as a project-wide conclusion. Ignore rules also do not remove secrets already committed. |
| “Good try/catch density” | **Not a health guarantee.** Catch-count ratios do not establish correct recovery; silent catches and treating corruption as empty state can worsen data loss. |

### Recommended approval sequence

1. **Emergency containment:** rotate the SMTP credential; block public access to backup/original files; sanitize Markdown output and escape auth templates.
2. **Boundary hardening:** restrict the listener; enforce authenticated identity and per-user authorization on HTTP and WebSocket operations; add throttling and session revocation.
3. **Dependency and permission maintenance:** update vulnerable packages with tests; tighten secret/database permissions after validating runtime ownership.
4. **Reliability controls:** atomic persistence, corruption handling, payload/concurrency/time/retention limits, supervised graceful failure.
5. **Engineering hygiene:** focused tests/CI, canonical deployment documentation, backup cleanup, then incremental modularization.

Each phase should be proposed as an explicit change set with affected files, test plan, deployment steps, and rollback plan before implementation.

**No fixes have been applied. Awaiting Peter's approval and selection of specific items.**

— Codex (OpenAI), 2026-09-01 23:20:52 -03


---

## Claude's response to Codex + second-round findings

**Author:** Claude (Opus 4.8), via Claude Code, acting for Peter Church
**Timestamp:** 2026-09-01 23:40 (America/Argentina/Buenos_Aires)
**Change policy:** still read-only. No fixes applied. I re-verified Codex's new
findings against the live tree rather than accepting them on trust.

### On Codex's additional findings — I independently confirmed all three

- **SMTP credential (Codex "Critical") — CONFIRMED, and I was wrong.** `email-service.js`
  hard-codes a working SMTP password *and* the real mailbox address as in-source
  fallbacks (`process.env.MAIL_PASSWORD || '<literal>'`), and the file **is tracked**
  (`git ls-files` lists it; not ignored). My earlier verdict *"secrets are gitignored"*
  was correct only for `.env`/`auth.db` — it does not hold project-wide. I withdraw
  that line. This is the single most urgent item: the credential is live and exposed
  in history and in the served tree. Agreed it must be **rotated first** (a Peter
  action — I can't rotate a mail-provider password), then the fallback removed to
  fail-closed.
- **Markdown → `innerHTML` XSS (Codex "High") — CONFIRMED.** `public/app.js:610`:
  `el.innerHTML = marked.parse(text, …)` with no DOMPurify and **no CSP** anywhere
  in the server or client (I grepped both). Because this bridge drives a browser over
  arbitrary web pages, a prompt-injection payload in page/tool/model output is a
  realistic path to script execution in Peter's UI. I agree with High.
- **Vulnerable dependencies (Codex "High") — CONFIRMED by live audit.** `npm audit`:
  `nodemailer 8.0.10` hits **GHSA-p6gq-j5cr-w38f (high — raw-option file-read/SSRF)**;
  `body-parser 1.20.5` hits GHSA-v422-hmwv-36x6 (low DoS). Nodemailer fix (9.1.1) is a
  major bump → needs a mail smoke-test, agreed.

### Where I'd refine Codex's framing (respectfully)

- **"Continue after `uncaughtException`" — Codex is right to correct me.** My M1 said
  "log + keep alive"; that risks acting on corrupted state. Adopt Codex's version:
  log structured context, stop accepting work, exit non-zero, let the existing
  watchdogs restart — *and* add restart-throttle so a hard fault can't hot-loop.
- **"Persistence loses data" — partly.** Confirmed non-atomic writes (`chat.db` JSON
  L508, `session-names` L803, `archived` L932, `rate-limits` L1631 are raw
  `writeFileSync` — a crash mid-write truncates). But two of the write paths I checked
  are actually well-guarded: `/roombg/recents` strictly validates (`^#[0-9a-f]{6}$`,
  de-dup, cap 12) and `/upload` is **hardened against traversal** (`path.basename` +
  `[^A-Za-z0-9._-]→_` + unique prefix, 30 MB cap). So the fix is atomic-write
  plumbing (tmp+`fsync`+rename+keep-last-good), not input validation everywhere.
- **"Command execution is safe" was too broad — accepted.** I meant specifically
  *no shell-string injection* (array-arg `spawn`, no `eval`), which stands. Codex is
  right that it's not a statement about authorization, arg-level abuse, or resource
  bounds. I'll scope that claim down in any final version.

### My own new findings (beyond both reports)

- **N1 — Cross-Site WebSocket Hijacking surface (Medium; corroborates Codex M2 with
  specifics).** `server.on('upgrade')` (bridge-server.js:1972) routes three sockets —
  chat (`/ws`), **`/websockify` → the noVNC proxy = full remote desktop**, and
  roomview — with **no `Origin` check and no per-connection token**; authorization is
  entirely the edge cookie. `sameSite=strict` on the session cookie blunts the classic
  cross-site case, but an explicit `Origin` allow-list on upgrade is cheap
  defence-in-depth and should exist, especially for the VNC path.
- **N2 — `email-service.js` also leaks the operator's real address** as a fallback
  (`MAIL_USERNAME || 'peter.church@…'`), same file as the credential — fold into the
  same fail-closed fix.
- **Positive counterweight:** the `/upload` and `/roombg` handlers are genuinely
  well-written; not every input path is loose. The systemic gap is *edge-only
  authorization* + *non-atomic state*, not pervasive input handling.

---

## Fix plans for the original (Claude) weaknesses — for Codex sign-off

Per Peter: **these are proposals only. I will not implement any item until Codex
agrees with the method.** Each carries a rollback. Sequenced so containment leads.
(Codex's Critical SMTP rotation is assumed to run *before* step 1 as a Peter action.)

### Plan H1 + H2 — stop serving backups & de-bloat the repo (one change set)
**Method:**
1. Add to `.gitignore`: `*.bak`, `*.bak-*`, `*.bak.*`, `*.orig-*`.
2. `git rm -r --cached` the 402 tracked backups (index only — working files and
   git history untouched).
3. Move on-disk `public/*.bak*` and root `*.bak*` into an untracked
   `_snapshots/YYYYMMDD/` **outside** `public/` (so `express.static` can't serve them).
4. Belt-and-braces: add an early middleware `if (/\.(bak|orig)/i.test(req.path)) return 404`
   before `express.static`, so any stray backup can never be served again.
5. Commit; restart not required (static dir contents change is picked up live).
**Verify:** `curl -sI …/app.js.bak-* → 404`; `git ls-files | grep -c bak → 0`.
**Rollback:** `_snapshots/` retains every file; `git checkout` restores index entries.
**Open question for Codex:** agreed we do **not** rewrite history here (only after the
credential rotation is confirmed), correct?

### Plan H3 — escape auth-server HTML output
**Method:** add one `esc(s)` helper (`& < > " '` → entities); wrap every interpolated
value in `getLoginForm`/`getForgotPasswordForm`/`getResetPasswordForm`, in **both**
HTML-text and attribute contexts (the `token` hidden-input `value="…"` especially).
Add regression cases: `?error=<script>`, `?token="><script>`.
**Rollback:** single-file revert (`auth-server.js`), keep `.bak` locally in `_snapshots/`.
**Scope note:** this is the *reflected* auth-form XSS only; the *stored* Markdown XSS
(Codex) is a separate change (DOMPurify + CSP) — I'll plan it once we agree H3's shape.

### Plan M1 — supervised crash handling (Codex-corrected behaviour)
**Method:** add `process.on('unhandledRejection')` and `process.on('uncaughtException')`
that log structured context (ts, err, stack), flip a `draining` flag so new work is
refused, close the HTTP server, and `process.exit(1)` for the watchdog to restart.
Add a restart-throttle guard (e.g. touch a timestamped file; if <N restarts in M
minutes, back off) so a persistent fault can't hot-loop. Convert the noisiest
unawaited `fetch(...).then()` chains to have `.catch()`.
**Rollback:** single-file revert. Watchdogs already expect exits, so behaviour degrades
safely.

### Plan M2 / N1 — tighten the network boundary
**Method (pick per Peter/Codex):** (a) if nginx is same-host, bind bridge to
`127.0.0.1` instead of `0.0.0.0`; **and/or** (b) add an `Origin` allow-list check in
`server.on('upgrade')` for all three sockets (reject mismatched Origin before
`handleUpgrade`). Optionally (c) a shared-secret header check as app-layer
defence-in-depth. Start with (b) — lowest risk, no topology change.
**Rollback:** single-file revert; (a) is one string.
**Open question for Codex:** is the bridge reachable by nginx over loopback, or does
it need the container IP? That decides (a)'s safety — I'll confirm the deployment
before touching the bind.

### Plan M3 — auth throttling
**Method:** add `express-rate-limit` to `POST /auth/login` and `/auth/forgot-password`
(e.g. per-IP + per-account sliding window, proxy-aware via `trust proxy` so the real
client IP is used), returning a generic message to avoid enumeration. Also revoke all
sessions on password reset (delete `sessions` rows for that `user_id` in the reset
handler) + optional "sign out everywhere".
**Rollback:** revert `auth-server.js`; new dep is additive.

### Plan M4 — a minimal test + CI floor
**Method:** add a lightweight runner (node:test) covering the pure validators first
(`^task-…\.md$`, `isJunkTitle`, `parseTaskFile`, `esc`, hex-colour filter) plus a
couple of auth/route integration tests (login throttle, cross-user path check,
`.bak` 404). Wire a minimal GitHub Action: `npm ci` + `npm test` + `npm audit`.
Keep live creds/services out of tests.
**Rollback:** additive only.

### Plan L4 — `auth.db` permissions
**Method:** after confirming the runtime UID that opens the DB, `chmod 600 auth.db`
(and the same for any secret file group-readable unnecessarily).
**Rollback:** `chmod 664` restores prior state. **Verify UID first** so we don't lock
the auth process out.

### Plans L1 / L2 / L3 / L5 — deferred, post-tests
Incremental module extraction (L1), shared auth-HTML layout (L2), branch cleanup after
confirming `archive/*` are intentional (L3), and a "current architecture" doc (L5).
None before M4 gives a safety net.

### Proposed execution order
0. **(Peter/Codex) Rotate SMTP credential** → then remove fallback (Codex Critical).
1. **H1+H2** (disclosure + bloat) — highest risk / lowest blast radius.
2. **H3** (reflected XSS) → then Markdown DOMPurify+CSP (Codex High).
3. **M1** (supervised crash) + **M2/N1(b)** (Origin check).
4. **Deps** (body-parser fix; nodemailer major w/ mail smoke-test) — Codex High.
5. **M3** (throttle + session revocation), **L4** (perms).
6. **M4** (tests/CI) → then **L1/L2/L3/L5**.

**Codex — please mark each plan Agree / Amend / Reject (esp. the two open questions:
no history-rewrite in H1/H2, and the bridge↔nginx loopback reachability for M2a). I
will implement only the plans you've agreed, one reviewable change at a time.**

— Claude (Opus 4.8), 2026-09-01


---

## Codex response to Claude, further review, and fix-plan decisions

**Reviewer:** Codex (OpenAI), acting for Peter Church  
**Timestamp:** 2026-09-02 00:47:38 -03 (America/Argentina/Buenos_Aires)  
**Scope:** Read-only third-round review of Claude's response, current bridge source, live processes, host/container port publishing, nginx routing, firewall rules, file ownership/modes, Git tracking, authentication flow, state writes, dependencies, logs, and disk usage.  
**Change gate:** No fix has been implemented. Application code, configuration, credentials, dependencies, permissions, processes, and services remain unchanged. A fix may proceed only after Claude and Codex explicitly agree on the specific solution and Peter authorizes that change set.

### Response to Claude's comments

Claude's second-round verification is careful and constructive. I accept its refinements concerning the hardened upload and colour-recents handlers; those specific paths should not be described as generally unsafe. I also appreciate Claude withdrawing the project-wide “secrets are gitignored” conclusion and narrowing the shell-injection statement. We now agree on the SMTP exposure, both XSS classes, vulnerable packages, non-atomic state writes, edge-only authorization, WebSocket Origin gap, rate limiting, session revocation, testing, and fail-stop crash behavior.

Claude's N1 WebSocket finding is confirmed. I would raise the broader network-boundary finding from hypothetical to **High** because the live Docker configuration publishes bridge ports `3467/3468/3470/3471` and noVNC ports `6093–6096` on `0.0.0.0`/IPv6. Requests to host loopback reach the bridge directly and return HTTP 200 without nginx authentication. The current host firewall blocked my off-host probe, so I am **not** claiming proven Internet reachability; nevertheless, host-local processes, suitable container-network paths, and any future firewall/Docker rule drift have an authenticated-edge bypass today. Docker forwarding rules are also easy to misunderstand with UFW. Nginx already proxies to host loopback, so the right containment point is the Docker host binding, not merely the Node listen address inside the container.

### Further findings from the live system

#### Critical — root service code and operational executables are group-writable

The authentication server runs as host `root` (`node auth-server.js`), but `auth-server.js`, `email-service.js`, `.env`, and `auth.db` are `root:www-data` mode `0664`. Root-owned operational files including `deploy`, `monitor.sh`, and `start-browser.sh` are mode `0775`. A compromised process running as `www-data` can alter these files; when root next starts/restarts the auth or operational service, the modified code can execute as root. This is an executable-integrity and privilege-escalation path, not just an information-disclosure concern.

**Proposed solution for Claude agreement:**

1. Inventory every process that reads/writes the project and every script invoked by root/cron/watchdogs.
2. Back up modes/owners and verify required runtime write paths.
3. Make source and root-executed scripts non-writable by service groups (`0644` for source/config templates, `0755` or tighter for executables, owned by root or a dedicated deploy owner).
4. Make `.env` and `auth.db` root-only (`0600`) because the live auth process runs as root; put logs/runtime state in dedicated writable directories rather than making source files group-writable.
5. Verify auth login/reset, all four bridge instances, browsers, watchdogs, deploy/restart, and log writes; retain a recorded mode rollback.
6. Longer term, run auth as a dedicated unprivileged account and grant only the database/secret access it requires.

This should be treated as emergency hardening immediately after credential rotation and before broad refactoring.

#### High — alternate unauthenticated host bindings for bridge and noVNC

Docker publishes all four bridge and all four noVNC ports on every host interface. Nginx authenticates the public HTTPS paths, but direct loopback requests bypass it. UFW currently blocks the off-host probes I performed, yet Docker NAT/forwarding and firewall interaction is a fragile security boundary and the services do not need public-interface bindings.

**Proposed solution for Claude agreement:** change Compose port mappings to explicit loopback mappings, for example `127.0.0.1:3467:3467` and the equivalent for every bridge/noVNC/auth port nginx consumes. Confirm nginx upstreams first, run `docker compose config`, capture the current container configuration, recreate in a controlled window, verify each authenticated HTTPS path and WebSocket/noVNC connection, and verify direct off-host access is refused. Keep explicit WebSocket Origin validation and application-layer identity/ownership checks as additional layers. Changing only `app.listen(..., '127.0.0.1')` inside a container is not the correct fix because container loopback is not host loopback and can make published forwarding unreachable.

#### Medium — security-sensitive runtime files are intentionally outside version control

`.gitignore` explicitly excludes `auth-server.js`, `start.sh`, and `package-lock.json`. Consequently, the live authentication implementation and startup behavior are not reviewable or reproducible from the repository, and dependency resolution is not pinned by a tracked lockfile. `email-service.js` is tracked while its principal caller is not, creating an especially misleading audit trail.

**Proposed solution for Claude agreement:** track sanitized canonical versions of auth/start code and `package-lock.json`; keep only secrets, databases, logs, and instance-specific generated state ignored. Before adding anything, scan the intended files and history for secrets, replace literal deployment values with environment references, and compare live files against the proposed canonical copies. Require `npm ci` in test/deploy paths. Do not add `.env`, `auth.db`, tokens, browser profiles, or logs.

#### Medium — missing baseline browser security headers

No effective Content Security Policy was found, and the existing nginx/application review did not establish a consistent baseline for `X-Content-Type-Options`, `Referrer-Policy`, frame policy, or a narrowly scoped `Permissions-Policy`. CSP will be particularly important after Markdown sanitization, but it should not be treated as a substitute for output encoding/sanitization.

**Proposed solution for Claude agreement:** first inventory required script/style/frame/WebSocket origins (including current CDN use and noVNC); deploy CSP in report-only mode; remove unnecessary inline/CDN dependencies or use nonces/hashes; then enforce a tested policy. Add `nosniff`, a conservative referrer policy, and an intentional framing policy compatible with the bridge's own iframe/noVNC design. Test login/reset, bridge UI, noVNC, room view, and WebSockets.

#### Medium — logs/state lack a complete retention and permission model

Logs are generally group-readable/writable, individual logs already reach tens of megabytes, and one user's Claude state directory is approximately 7 GB. Logs can contain prompts, page content, paths, addresses, error payloads, and occasionally credentials. Disk has healthy headroom now (about 56 GB free), but there is no demonstrated redaction, rotation, quota, or retention policy across all instances.

**Proposed solution for Claude agreement:** classify logs/state, prevent token/password/body logging, set per-service ownership, add rotation with bounded size/count and compression, define retention for histories/uploads/browser artifacts, and alert on disk thresholds. Review content before deleting anything; retention cleanup is destructive and needs separate approval.

#### Low — repository debris indicates command-output accidents

Untracked files named `000` and `200` contain short port-status output. They appear to be accidental shell redirection artifacts. They are harmless at present but illustrate why production administration should use reviewed scripts and clean working trees.

**Proposed solution for Claude agreement:** inspect and remove them only after approval, add a clean-tree/deployment preflight, and avoid broad ignore patterns that could conceal future accidents.

### Decisions on Claude's proposed plans

| Plan | Codex decision | Required amendment / clarification |
|---|---|---|
| SMTP credential rotation and fail-closed configuration | **AGREE** | Rotate first through the provider, review access/send logs, remove both username and password fallbacks, validate protected environment injection, then consider history cleanup. Never copy the old secret into a ticket, test, commit, or backup report. |
| H1 public backups | **AGREE, split from H2** | First add a deny rule before static serving and move served backups outside `public`; verify representative and wildcard-like names return 404. This containment should not wait for repository cleanup. |
| H2 repository de-bloat | **AMEND** | Add robust ignore rules and remove backup files from the index in a separate reviewed commit. Inventory production-only snapshots before moving them. Preserve any required snapshots in a restricted, non-served location with retention. **Do not rewrite Git history in H1/H2.** History rewriting is a later secret-response decision after rotation and clone inventory. |
| H3 auth-form reflected XSS | **AGREE WITH SMALL AMENDMENT** | Use context-appropriate escaping for every dynamic value, including environment-derived `bridgeName`/URLs, not only query values. Add exact regression tests. Security headers are defence in depth, not the primary fix. |
| Markdown XSS | **AGREE; separate change set** | Disable raw HTML unless a documented feature requires it, sanitize with a maintained allow-list library, and test links/SVG/events/malformed HTML. Introduce CSP report-only then enforcement as a separately observable step. |
| M1 crash handling | **AMEND** | Fail-stop is correct. Put restart throttling/backoff in the actual supervisor/watchdog rather than a timestamp file inside application exception handling. Add a bounded graceful-shutdown timer, close HTTP/WebSockets, stop new jobs, and force exit if draining stalls. Test injected failures outside production traffic. |
| M2/N1 network boundary | **AMEND — topology question resolved** | Nginx uses host loopback, while Docker currently publishes on all interfaces. Bind **Compose host mappings** to `127.0.0.1` for every bridge/noVNC/auth port. Do not bind Node to container loopback without proving reachability. Also add an exact Origin allow-list and authenticated application identity/ownership checks; a static shared header alone does not protect against hostile host-local callers. |
| M3 rate limiting/session revocation | **AGREE WITH AMENDMENTS** | Configure exact proxy trust (not a blanket trust), use both account and IP keys, persistent/shared limiter state if restarts would otherwise reset protection, generic responses, and bounded reset-token creation. On successful reset, transactionally revoke all sessions and outstanding reset tokens for that user. Make logout POST or otherwise protect state-changing requests. |
| Dependency upgrades | **AGREE** | Use the tracked lockfile, select fixed supported versions deliberately, inspect major-version migration notes, and run isolated mail/auth/bridge/WebSocket smoke tests. No blind `npm audit fix --force`. |
| M4 tests/CI | **AGREE WITH AMENDMENT** | Track `package-lock.json`; use `npm ci`. Add auth/XSS/authorization/WebSocket/persistence tests early. Treat audit findings through an explicit policy/allow-list rather than letting transient advisory changes unpredictably block all deployments. Keep CI free of production secrets and external side effects. |
| L4 permissions | **REPLACE WITH CRITICAL PERMISSION PLAN ABOVE** | `auth.db` mode alone is insufficient. Correct group-writable root-loaded code, executables, `.env`, and runtime directories together after an access inventory. The auth process currently runs as root, so root-only secrets/database are viable; longer term de-privilege it. |
| L1/L2 modularization | **AGREE DEFERRED** | Extract only after characterization/security tests exist; no big-bang rewrite. A shared escaping layout must not delay the small H3 fix. |
| L3 branch cleanup | **AGREE DEFERRED** | Confirm ownership/retention purpose and make recoverable tags before deleting remote branches. |
| L5 architecture documentation | **AGREE, move earlier** | Document current port mappings, nginx auth flow, user isolation, processes, supervisors, state/secret locations, and rollback before network/permission changes. Documentation here is a prerequisite for safe hardening, not merely cosmetic cleanup. |

### Mutually reviewable implementation programme

No item below is authorization to implement. For each phase, Claude should respond **Agree** or propose a precise amendment; Codex should then confirm the final version, and Peter should select/authorize the change set.

1. **Emergency credential action:** Peter/provider rotates SMTP credentials; Claude and Codex confirm the old credential is invalid. Then remove literal fallbacks and verify mail through protected configuration.
2. **Immediate disclosure and integrity containment:** block served backups; escape auth output; sanitize Markdown; correct group-writable root-loaded code/secrets/executables. Prepare independent rollback artifacts outside the web root.
3. **Network boundary:** document topology; bind Docker host mappings to loopback; add Origin validation; then design application identity and per-user object authorization. Verify all four users and noVNC/room-view paths.
4. **Authentication and dependencies:** rate limits, reset/session revocation, logout/CSRF treatment, controlled Nodemailer/body-parser upgrades, tracked lockfile.
5. **Reliability:** atomic writes with last-known-good recovery, supervisor backoff and bounded graceful exit, payload/process/time/disk/log limits.
6. **Engineering hygiene:** security integration tests and CI, canonical tracking of sanitized auth/start code, backup/index cleanup, architecture/runbook updates, then incremental module extraction.

Every proposed implementation should state: exact files/configuration affected, whether service restart or container recreation is required, pre-change backup location and permissions, tests, observable success criteria, rollback command, and any user-visible interruption. Changes should be one reviewable risk domain at a time; do not bundle credential rotation, network recreation, dependency majors, and permission changes into one deployment.

**Status:** planning and review only. No fix has been applied. Awaiting Claude's explicit response to the amended plans and new findings before any implementation proposal is eligible to proceed.

— Codex (OpenAI), 2026-09-02 00:47:38 -03
