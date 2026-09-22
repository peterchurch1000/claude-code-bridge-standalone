'use strict';
/* [CONF_HEAL_V1] Mirror of bridge-server.js transcriptToMessages(), plus the
 * event uuid and its line ordinal (identity for recovered rows). Kept separate so
 * both the dry run and the inspection tools read the transcript exactly as the
 * server will. The server keeps its own copy of this logic - this module exists so
 * offline tooling cannot drift from it silently; any change must be made in both
 * and test 5 (raw-vs-stripped conference turn) guards the shared behaviour.
 */
const fs = require('fs');
const path = require('path');

function stripPlumbing(t) {
  return String(t || '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .trim();
}
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((x) => x.type === 'text').map((x) => x.text).join('');
  return '';
}
// dir: the transcripts directory; id: session/room id
function readTranscript(dir, id) {
  const file = path.join(dir, id + '.jsonl');
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { rows: [], file, missing: true }; }
  const rows = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
    if (ev.isCompactSummary === true) continue;
    // [CONF_HEAL_V1] Recovery restores what the ROOM SHOWED. These three classes are
    // in the transcript but were never rendered as chat, so writing them into the room
    // would invent content rather than restore it. (transcriptToMessages() in
    // bridge-server.js does not filter them because its existing callers only READ.)
    if (ev.isVisibleInTranscriptOnly === true) continue;
    if (ev.isMeta === true) continue;
    if (ev.isApiErrorMessage === true) continue;
    if (ev.isSidechain === true) continue;            // sub-agent internals
    // [CONF_HEAL_V1] ts carries the event clock so recovery can be SCOPED to the
    // content lost after a given moment (Peter's choice: restore the recent loss
    // only). null when the event has no parseable timestamp - a scoped run then
    // excludes it rather than guessing it is in range.
    const ts = Date.parse(ev.timestamp || '') || null;
    if (ev.type === 'user' && ev.message && ev.message.role === 'user') {
      const t = stripPlumbing(extractText(ev.message.content));
      if (t) rows.push({ type: 'user', text: t, uuid: ev.uuid, ordinal: i, ts });
    } else if (ev.type === 'assistant' && ev.message && ev.message.content) {
      const t = extractText(ev.message.content);
      if (t.trim() && !t.includes('\u{1F5DC}')) rows.push({ type: 'assistant', text: t, uuid: ev.uuid, ordinal: i, ts });
    }
  }
  return { rows, file, missing: false };
}
module.exports = { readTranscript, stripPlumbing, extractText };
