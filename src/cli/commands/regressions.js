'use strict';

const { collectCommits } = require('../../core/collector');
const {
  isFixCommit,
  findBugIntroducingCommits,
} = require('../../core/analyzer');
const { c, truncate, shortDate } = require('../../utils/format');

async function run(ctx) {
  const { repo, flags, positional } = ctx;
  const range = positional[0] || flags.since || null;
  const scanLimit = flags.limit ? Number(flags.limit) : 60;
  const maxFixes = flags.fixes ? Number(flags.fixes) : 8;
  const maxCandidates = flags['max-candidates'] ? Number(flags['max-candidates']) : 3;

  const commits = await collectCommits(repo, { rev: range || 'HEAD', limit: scanLimit });
  const fixes = commits.filter(isFixCommit).slice(0, maxFixes);

  const tally = new Map();
  const findings = [];

  for (const fix of fixes) {
    const result = await findBugIntroducingCommits(repo, fix.sha, { maxCandidates });
    if (!result.candidates.length) continue;
    findings.push({
      fix: { sha: fix.sha, short: fix.short, subject: fix.subject, date: fix.committerDate },
      candidates: result.candidates,
    });
    for (const cand of result.candidates) {
      const entry = tally.get(cand.sha) || { ...cand, hits: 0 };
      entry.hits += 1;
      tally.set(cand.sha, entry);
    }
  }

  const ranked = [...tally.values()].sort(
    (a, b) => b.hits - a.hits || b.lines - a.lines
  );

  if (flags.json) {
    ctx.stdout.write(JSON.stringify({ scanned: commits.length, fixes: fixes.length, findings, ranked }, null, 2) + '\n');
    return 0;
  }

  const out = ctx.stdout;
  out.write('\n' + c.bold('Likely bug-introducing commits') + c.dim(' (SZZ heuristic)') + '\n');
  out.write(
    c.dim(
      `scanned ${commits.length} commit(s), analysed ${fixes.length} fix-shaped commit(s)\n\n`
    )
  );

  if (!ranked.length) {
    out.write(c.yellow('No candidates identified.') + c.dim(' This is a heuristic and can miss cases.\n\n'));
    return 0;
  }

  out.write(c.bold('Candidates') + '\n');
  for (const cand of ranked.slice(0, 15)) {
    out.write(
      `  ${c.green(cand.short)}  ${c.dim(shortDate(cand.authorDate))}  ` +
        `${c.yellow('hit ' + cand.hits)}  ${truncate(cand.subject, 50)}  ${c.dim(cand.authorName)}\n`
    );
  }

  out.write('\n' + c.bold('Evidence') + '\n');
  for (const finding of findings.slice(0, maxFixes)) {
    out.write(
      `  fix ${c.green(finding.fix.short)} "${truncate(finding.fix.subject, 45)}"\n`
    );
    for (const cand of finding.candidates) {
      out.write(
        c.dim(`    ← ${cand.short} (${cand.lines} line${cand.lines === 1 ? '' : 's'}): ${truncate(cand.subject, 55)}`) + '\n'
      );
    }
  }
  out.write(c.dim('\n  Heuristic only. Blame of lines a fix removed; verify each candidate.\n\n'));
  return 0;
}

module.exports = { run, describe: 'Scan fix commits for likely bug-introducing commits' };
