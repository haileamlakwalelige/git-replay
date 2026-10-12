'use strict';

const { collectRefs } = require('../../core/collector');
const { c, truncate, shortDate } = require('../../utils/format');

async function branchActivity(repo, defaultBranch, branch) {
  if (!defaultBranch || branch.name === defaultBranch) return { ahead: 0, behind: 0 };
  const { ok, stdout } = await repo.try([
    'rev-list',
    '--left-right',
    '--count',
    `${defaultBranch}...${branch.name}`,
  ]);
  if (!ok) return { ahead: null, behind: null };
  const [behind, ahead] = stdout.trim().split(/\s+/).map(Number);
  return { behind, ahead };
}

async function run(ctx) {
  const { repo, flags } = ctx;
  const refs = await collectRefs(repo);

  const locals = refs.branches.filter((b) => b.kind === 'local');
  const remotes = refs.branches.filter((b) => b.kind === 'remote');

  const enriched = [];
  for (const branch of locals) {
    const activity = await branchActivity(repo, refs.defaultBranch, branch);
    enriched.push({ ...branch, ...activity });
  }

  if (flags.json) {
    ctx.stdout.write(
      JSON.stringify({ ...refs, branches: [...enriched, ...remotes] }, null, 2) + '\n'
    );
    return 0;
  }

  const out = ctx.stdout;
  out.write('\n' + c.bold('Branches') + c.dim(`  default: ${refs.defaultBranch || '?'}`) + '\n\n');
  for (const b of enriched) {
    const current = refs.head === b.name ? c.green('* ') : '  ';
    const ahead = b.ahead != null && b.ahead !== 0 ? c.green(`+${b.ahead}`) : '';
    const behind = b.behind != null && b.behind !== 0 ? c.red(`-${b.behind}`) : '';
    out.write(
      `${current}${c.bold(b.name.padEnd(28))} ${c.dim(b.sha.slice(0, 7))}  ` +
        `${c.dim(shortDate(b.date))}  ${ahead}${ahead && behind ? ' ' : ''}${behind}  ` +
        c.dim(truncate(b.subject, 45)) + '\n'
    );
  }

  if (remotes.length) {
    out.write('\n' + c.bold('Remotes') + '\n');
    for (const b of remotes) {
      out.write(`  ${b.name.padEnd(30)} ${c.dim(b.sha.slice(0, 7))}  ${c.dim(shortDate(b.date))}\n`);
    }
  }

  if (refs.tags.length) {
    out.write('\n' + c.bold('Tags') + '\n');
    for (const t of refs.tags) {
      out.write(`  ${c.yellow(t.name.padEnd(30))} ${c.dim(t.sha.slice(0, 7))}  ${c.dim(shortDate(t.date))}\n`);
    }
  }
  out.write('\n');
  return 0;
}

module.exports = { run, describe: 'List branches, remotes and tags with ahead/behind counts' };
