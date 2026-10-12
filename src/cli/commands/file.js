'use strict';

const { gatherFileEvidence } = require('../../core/evidence');
const { c, truncate, shortDate } = require('../../utils/format');

const STATUS_LABEL = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
};

function statusFor(entry, pathArg) {
  const relevant =
    entry.statuses.find((s) => s.path === pathArg) ||
    entry.statuses.find((s) => s.to === pathArg) ||
    entry.statuses[0];
  if (!relevant) return '';
  const label = STATUS_LABEL[relevant.status] || relevant.status;
  if (relevant.status === 'R') {
    return `${label} ← ${relevant.from}`;
  }
  return label;
}

async function run(ctx) {
  const { repo, flags, positional } = ctx;
  const filePath = positional[0] || flags.path;
  if (!filePath) {
    ctx.stderr.write(c.red('Usage: git-replay file <path>') + '\n');
    return 2;
  }

  const evidence = await gatherFileEvidence(repo, filePath, {
    limit: flags.limit ? Number(flags.limit) : 100,
  });

  if (flags.json) {
    ctx.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
    return 0;
  }

  const out = ctx.stdout;
  out.write('\n' + c.bold('File history') + c.dim(`  ${filePath}`) + '\n');
  if (!evidence.history.length) {
    out.write(c.yellow('No history found for this path in reachable commits.') + '\n\n');
    return 0;
  }

  out.write(
    c.dim(
      `${evidence.history.length} commit(s) · ${evidence.authors.length} author(s) · ` +
        (evidence.exists ? 'exists at HEAD' : c.red('does not exist at HEAD'))
    ) + '\n\n'
  );

  if (evidence.created) {
    out.write(
      `${c.blue('⚑ created')} ${c.green(evidence.created.short)}  ` +
        `${c.dim(shortDate(evidence.created.date))}  ${evidence.created.subject}\n`
    );
  }
  if (evidence.deletion) {
    out.write(
      `${c.red('✕ deleted')} ${c.green(evidence.deletion.short)}  ` +
        `${c.dim(shortDate(evidence.deletion.date))}  ${evidence.deletion.subject}\n`
    );
  }
  out.write('\n');

  for (const entry of evidence.history) {
    const status = statusFor(entry, filePath);
    out.write(
      `${c.dim('│')} ${c.green(entry.short)}  ${c.dim(shortDate(entry.committerDate))}  ` +
        `${c.cyan(truncate(status, 18).padEnd(18))}  ${truncate(entry.subject, 60)}  ` +
        c.dim(entry.authorName) + '\n'
    );
  }
  out.write('\n' + c.dim('next: ') + c.cyan(`git-replay explain <sha>`) + '\n\n');
  return 0;
}

module.exports = { run, describe: 'Trace the history of a file (with rename following)' };
