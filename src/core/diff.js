'use strict';

/**
 * Strip the a/ b/ prefix (and any leading /dev/null) from a diff path.
 * @param {string} raw
 */
function stripPrefix(raw) {
  const p = raw.trim();
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

/**
 * Parse a unified diff into per-file hunks plus added/removed line content.
 * @param {string} raw
 * @returns {Array<{from: string|null, path: string|null, hunks: object[], added: string[], removed: string[]}>}
 */
function parseUnifiedDiff(raw) {
  const files = [];
  let cur = null;

  for (const line of raw.split('\n')) {
    const clean = line.replace(/\r$/, '');
    if (clean.startsWith('diff --git ')) {
      if (cur) files.push(cur);
      cur = { from: null, path: null, hunks: [], added: [], removed: [] };
      continue;
    }
    if (!cur) continue;

    if (clean.startsWith('--- ')) {
      cur.from = stripPrefix(clean.slice(4));
    } else if (clean.startsWith('+++ ')) {
      cur.path = stripPrefix(clean.slice(4));
    } else if (clean.startsWith('@@')) {
      const m = clean.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        cur.hunks.push({
          oldStart: Number(m[1]),
          oldLines: m[2] == null ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newLines: m[4] == null ? 1 : Number(m[4]),
        });
      }
    } else if (clean.startsWith('+++') || clean.startsWith('---')) {
      // headers already handled
    } else if (clean.startsWith('+')) {
      cur.added.push(clean.slice(1));
    } else if (clean.startsWith('-')) {
      cur.removed.push(clean.slice(1));
    }
  }
  if (cur) files.push(cur);
  return files;
}

module.exports = { parseUnifiedDiff, stripPrefix };
