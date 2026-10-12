'use strict';

const { gatherCommitEvidence } = require('../../core/evidence');
const { findBugIntroducingCommits, isFixCommit } = require('../../core/analyzer');
const ai = require('../../core/ai');
const { c, truncate, shortDate } = require('../../utils/format');

function renderEvidence(ev, out) {
  const { commit, classification } = ev;
  out.write('\n' + c.bold('Explain commit') + ' ' + c.green(commit.short) + '\n');
  out.write(c.dim(commit.subject) + '\n\n');
  out.write(
    `${c.dim('author')}    ${commit.authorName} <${commit.authorEmail}>\n` +
      `${c.dim('date')}      ${commit.authorDate}\n` +
      `${c.dim('parents')}   ${commit.parents.map((p) => p.slice(0, 7)).join(', ') || '(root)'}\n`
  );

  const tags = [];
  if (classification.isMerge) tags.push(c.magenta('merge'));
  if (classification.isRevert) tags.push(c.yellow('revert'));
  if (isFixCommit(commit)) tags.push(c.cyan('fix-shaped'));
  if (tags.length) out.write(`${c.dim('kind')}      ${tags.join('  ')}\n`);

  if (commit.body) {
    out.write('\n' + c.dim(commit.body.split('\n').slice(0, 12).join('\n')) + '\n');
  }

  if (commit.files && commit.files.length) {
    out.write('\n' + c.bold('Files changed') + c.dim(` (${commit.files.length})`) + '\n');
    for (const f of commit.files.slice(0, 40)) {
      const label = f.from ? `${c.cyan(f.status)} ${f.from} → ${f.path}` : `${c.cyan(f.status)} ${f.path}`;
      out.write('  ' + label + '\n');
    }
  }

  if (ev.dependency) {
    out.write('\n' + c.bold('Dependency changes') + '\n');
    for (const manifest of ev.dependency.manifests) {
      out.write(`  ${c.cyan(manifest.path)}` + '\n');
      for (const change of manifest.changes.slice(0, 30)) {
        if (change.type === 'lines') {
          out.write(c.dim(`    +${change.added} / -${change.removed} lines`) + '\n');
          for (const line of change.sampleAdded) out.write('    ' + c.green('+ ' + truncate(line, 90)) + '\n');
          for (const line of change.sampleRemoved) out.write('    ' + c.red('- ' + truncate(line, 90)) + '\n');
        } else {
          const arrow = change.type === 'added' ? c.green('added') : change.type === 'removed' ? c.red('removed') : c.yellow('changed');
          const versions = change.from && change.to ? `${change.from} → ${change.to}` : change.from || change.to;
          out.write(`    ${arrow} ${change.name}  ${c.dim(versions)}  ${c.dim('(' + change.group + ')')}\n`);
        }
      }
    }
  }

  if (ev.related.reverts) {
    out.write('\n' + c.bold('This reverts') + '\n');
    out.write(`  ${c.green(ev.related.reverts.short)}  ${ev.related.reverts.subject}\n`);
  }
  if (ev.related.revertedBy && ev.related.related) {
    // placeholder, handled below
  }
  if (ev.related.revertedBy) {
    out.write('\n' + c.bold('Later reverted by') + '\n');
    for (const r of ev.related.revertedBy) {
      out.write(`  ${c.green(r.short)}  ${c.dim(shortDate(r.date))}  ${r.subject}\n`);
    }
  }
  if (ev.related.broughtIn) {
    out.write(
      '\n' + c.bold('Commits brought in by this merge') + c.dim(` (${ev.related.broughtIn.count})`) + '\n'
    );
    for (const line of ev.related.broughtIn.sample) out.write(c.dim('  ' + line) + '\n');
  }
}

async function run(ctx) {
  const { repo, flags, positional } = ctx;
  const rev = positional[0] || 'HEAD';

  const evidence = await gatherCommitEvidence(repo, rev);
  const payload = { ...evidence };

  if (flags.regressions || (flags.auto && isFixCommit(evidence.commit))) {
    payload.bugIntroducing = await findBugIntroducingCommits(repo, evidence.sha, {
      maxCandidates: flags['max-candidates'] ? Number(flags['max-candidates']) : 5,
    });
  }

  if (flags.json) {
    ctx.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return 0;
  }

  const out = ctx.stdout;
  renderEvidence(evidence, out);

  if (payload.bugIntroducing) {
    out.write('\n' + c.bold('Likely bug-introducing commits') + c.dim(' (SZZ heuristic)') + '\n');
    const { candidates } = payload.bugIntroducing;
    if (!candidates.length) {
      out.write(c.dim('  No candidates found via blame of the removed lines.') + '\n');
    }
    for (const cand of candidates) {
      out.write(
        `  ${c.green(cand.short)}  ${c.dim(shortDate(cand.authorDate))}  ` +
          `${c.yellow(cand.lines + ' line(s)')}  ${truncate(cand.subject, 55)}  ${c.dim(cand.authorName)}\n`
      );
    }
    out.write(c.dim('  Heuristic only: blame of lines this commit removed. Verify before trusting.\n'));
  }

  if (flags.ai) {
    if (!ai.isEnabled()) {
      out.write('\n' + c.yellow('AI is disabled.') + c.dim(' Enable with GIT_REPLAY_AI=ollama.') + '\n');
    } else {
      out.write('\n' + c.bold('AI explanation') + c.dim(' (' + ai.status().model + ')') + '\n');
      try {
        const result = await ai.explain(stripEvidenceForAi(payload), null);
        out.write(result.text + '\n');
      } catch (err) {
        out.write(c.red('  AI error: ' + err.message) + '\n');
      }
    }
  }

  out.write('\n');
  return 0;
}

function stripEvidenceForAi(evidence) {
  return {
    sha: evidence.sha,
    subject: evidence.commit.subject,
    body: evidence.commit.body,
    author: evidence.commit.authorName,
    date: evidence.commit.authorDate,
    parents: evidence.commit.parents,
    files: evidence.commit.files,
    classification: evidence.classification,
    dependency: evidence.dependency,
    related: evidence.related,
    bugIntroducing: evidence.bugIntroducing,
  };
}

module.exports = { run, describe: 'Explain a commit using grounded Git evidence' };
