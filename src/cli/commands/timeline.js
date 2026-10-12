'use strict';

const path = require('node:path');
const { buildTimeline } = require('../../core/timeline');
const { c, padRight, truncate, shortDate, relativeTime, stripAnsi } = require('../../utils/format');

const KIND_GLYPH = {
  merge: '◆',
  revert: '↩',
  reverted: '✕',
  reintroduced: '↻',
  dependency: '⬡',
  root: '⚑',
  normal: '●',
};

const KIND_COLOR = {
  merge: c.magenta,
  revert: c.yellow,
  reverted: c.yellow,
  reintroduced: c.green,
  dependency: c.cyan,
  root: c.blue,
  normal: c.gray,
};

function glyphFor(commit) {
  const order = ['reintroduced', 'revert', 'reverted', 'merge', 'dependency', 'root'];
  for (const kind of order) {
    if (commit.kinds.includes(kind)) return { glyph: KIND_GLYPH[kind], color: KIND_COLOR[kind] };
  }
  return { glyph: KIND_GLYPH.normal, color: KIND_COLOR.normal };
}

function renderHeader(tl, out) {
  const name = path.basename(tl.repository.root);
  out.write('\n' + c.bold(`git-replay`) + c.dim(`  ${name}`) + '\n');
  out.write(
    c.dim(
      `branch ${tl.repository.branch || '(detached)'} · ` +
        `${tl.stats.totalCommits} commits · ${tl.stats.merges} merges · ` +
        `${tl.stats.reverts} reverts · ${tl.stats.authors} authors`
    ) + '\n'
  );
  if (tl.stats.firstDate) {
    out.write(
      c.dim(`${shortDate(tl.stats.firstDate)} → ${shortDate(tl.stats.lastDate)}`) + '\n'
    );
  }
  out.write('\n');
}

function renderEvents(tl, out, limit) {
  if (!tl.events.length) return;
  out.write(c.bold('Story') + c.dim('  (most recent first)') + '\n');
  const events = tl.events.slice(0, limit);
  for (const e of events) {
    const color = KIND_COLOR[e.type] || c.gray;
    const glyph = KIND_GLYPH[e.type] || '•';
    out.write(
      `${color(glyph)} ${c.green(e.short)}  ${padRight(c.dim(shortDate(e.date)), 12)}  ` +
        `${c.bold(truncate(e.title, 46))}  ${c.dim(truncate(e.detail, 60))}\n`
    );
  }
  out.write('\n');
}

function renderCommits(tl, out, limit) {
  out.write(c.bold('Commits') + c.dim(`  (showing ${Math.min(limit, tl.commits.length)} of ${tl.commits.length})`) + '\n');
  const commits = tl.commits.slice(0, limit);
  const laneWidth = Math.max(1, String(tl.maxLane + 1).length);
  for (const commit of commits) {
    const { glyph, color } = glyphFor(commit);
    const lane = String(commit.lane).padStart(laneWidth);
    const refs = commit.refs.length
      ? '  ' + c.yellow('[' + commit.refs.join(', ') + ']')
      : '';
    out.write(
      `${c.dim('lane ' + lane)} ${color(glyph)} ${c.green(commit.short)}  ` +
        `${padRight(c.dim(shortDate(commit.committerDate)), 12)}  ` +
        `${truncate(commit.subject, 72)}${refs}\n`
    );
  }
  out.write('\n');
  out.write(
    c.dim(
      'legend: ● commit  ◆ merge  ↩ revert  ↻ reintroduced  ✕ reverted  ⬡ dependency  ⚑ root\n'
    )
  );
  out.write(
    c.dim('next: ') +
      c.cyan('git-replay explain <sha>') +
      c.dim('  ·  ') +
      c.cyan('git-replay file <path>') +
      c.dim('  ·  ') +
      c.cyan('git-replay serve') +
      '\n\n'
  );
}

/**
 * @param {{repo: import('../../core/repo').Repo, flags: object, positional: string[]}} ctx
 */
async function run(ctx) {
  const { repo, flags, positional } = ctx;
  const tl = await buildTimeline(repo, {
    rev: positional[0] || flags.rev || 'HEAD',
    all: flags.all !== false,
    limit: flags.limit ? Number(flags.limit) : undefined,
    path: flags.path,
    firstParent: Boolean(flags['first-parent']),
  });

  if (flags.json) {
    ctx.stdout.write(JSON.stringify(tl, null, 2) + '\n');
    return 0;
  }

  const limit = flags.limit ? Number(flags.limit) : 30;
  renderHeader(tl, ctx.stdout);
  renderEvents(tl, ctx.stdout, flags.events ? Number(flags.events) : 12);
  renderCommits(tl, ctx.stdout, limit);
  return 0;
}

module.exports = { run, describe: 'Show a chronological timeline and story of the repository' };
