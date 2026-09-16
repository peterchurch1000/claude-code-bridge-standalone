# Conference room <-> task association [CONF_ROOM_ASSOC_V1]

When a conference room is linked to a task, the bridge now auto-registers the room\x27s
canonical (promoted) key into that task\x27s task_rooms list (the "Conference rooms"
section in the task panel), giving a working ?room= deep-link. Fixes the old one-way
link (conference stored its task but never wrote the room back).

Automatic: fires when the room promotes from draft- to a real session id (Claude AND
Codex lead). Canonical key only; idempotent; tracked per (task,room) tuple in conf
state (roomAssoc) so rekey/task-change re-registers but a manual delete stays deleted.
Durably reconciled (promotion, confRecover, boot sweep, 10-min interval; roomAssocPending).

Manual (already in the UI): open the task in the Tasks panel -> "Conference rooms"
section -> paste a room link/key + Link, or click "+ Link current room". Drafts are
rejected; delete with x.

Backfill (one-off, bounded): node backfill-conf-rooms.js [--apply] — tasks 410-420 or
open/active, owner-scoped, dry-run default, auditable, non-zero on failure. Ran
2026-09-15: registered tasks 418(x2), 419, 420.

Code: confRegisterRoom / promoteRoomKey / confReconcileRegistrations / confRoomLabel +
hooks (Claude init, Codex thread.started, confRecover, confStart tail, boot sweep).
Posts to {BRIDGE_TASK_API}/{taskfile}/rooms via bridgeTaskJwt().
