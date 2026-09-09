// [SHIM_SELECT_VERIFY_V4] Extracted so unit tests import the PRODUCTION parser (no dup).
// Parses a browser_tabs list/select result into [{index,current,title,url}]. Robust to
// URLs containing parentheses (URL is the markdown-link tail) and to a literal
// "(current)" inside a title (the marker is structurally anchored before the [title]).
function parseTabsFull(sel) {
  const text = ((sel && sel.result && sel.result.content) || []).map(x => x.text).join('\n');
  const rows = [];
  for (const l of text.split('\n')) {
    const m = l.match(/^\s*-\s*(\d+):\s*(\(current\)\s*)?\[(.*)\]\(([^]*?)\)\s*$/);
    if (!m) continue;
    rows.push({ index: parseInt(m[1]), current: !!m[2], title: m[3], url: m[4] });
  }
  return rows;
}
module.exports = { parseTabsFull };
