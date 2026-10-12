'use strict';

const { gatherCompareEvidence } = require('../../core/evidence');
const { c, truncate } = require('../../utils/format');

function normalizeRange(input) {
  if (!input) return null;
  if (input.includes('..')) return input;
  return input;
}

async function run(ctx) {
  const { repo, flags, positional } = ctx;
  let range = positional[0] || flags.range;
  if (!range) {
    range = 'HEAD~10..HEAD';
  }
  range = normalizeRange(range);

  const evidence = await gatherCompareEvidence(repo, range);

  if (flags.json) {
    ctx.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
    return 0;
  }

  const out = ctx.stdout;
  out.write('\n' + c.bold('Compare') + c.dim(`  ${range}`) + '\n');
  out.write(
    c.dim(
      `${evidence.summary.files} file(s) · +${evidence.summary.insertions} / -${evidence.summary.deletions}\n\n`
    )
  );

  const rows = [...evidence.files].sort(
    (a, b) => (b.added || 0) + (b.removed || 0) - ((a.added || 0) + (a.removed || 0))
  );
  for (const f of rows.slice(0, flags.limit ? Number(flags.limit) : 50)) {
    const added = f.binary ? 'bin' : `+${f.added}`;
    const removed = f.binary ? '' : `-${f.removed}`;
    out.write(
      `${c.green(added.padStart(6))} ${c.red(removed.padStart(6))}  ${truncate(f.path, 80)}\n`
    );
  }

  if (evidence.fixCommits.length) {
    out.write('\n' + c.bold('Fix-shaped commits in range') + '\n');
    for (const line of evidence.fixCommits.slice(0, 10)) {
      out.write(c.dim('  ' + line) + '\n');
    }
  }
  out.write('\n');
  return 0;
}

module.exports = { run, describe: 'Compare two revisions (e.g. HEAD~10..HEAD)' };
