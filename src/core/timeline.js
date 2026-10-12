'use strict';

const {
  collectCommits,
  collectChangedFiles,
  collectRefs,
  buildDecorationMap,
} = require('./collector');
const { layout } = require('./lanes');
const {
  detectRevert,
  detectMergeInfo,
  buildRevertIndex,
  detectReintroductions,
  isManifest,
} = require('./analyzer');

/**
 * Classify a commit into zero or more timeline event kinds.
 * @param {object} commit
 * @param {object} ctx
 */
function classify(commit, ctx) {
  const kinds = [];
  const { revertIndex, reintroduced, revertedBy, filesBySha } = ctx;

  if (commit.isMerge) kinds.push('merge');

  if (revertIndex.has(commit.sha)) {
    kinds.push('revert');
  }

  if (revertedBy.has(commit.sha)) {
    kinds.push('reverted');
  }

  if (reintroduced.has(commit.sha)) {
    kinds.push('reintroduced');
  }

  const files = filesBySha.get(commit.sha) || [];
  if (files.some(isManifest)) kinds.push('dependency');

  if (commit.parents.length === 0) kinds.push('root');

  return kinds;
}

/**
 * Build a fully-annotated, render-ready timeline for a repository.
 *
 * @param {import('./repo').Repo} repo
 * @param {object} [opts]
 * @param {string} [opts.rev]
 * @param {boolean} [opts.all]
 * @param {number} [opts.limit]
 * @returns {Promise<object>}
 */
async function buildTimeline(repo, opts = {}) {
  const selection = {
    rev: opts.rev || 'HEAD',
    all: opts.all !== false,
    limit: opts.limit,
    path: opts.path,
    firstParent: opts.firstParent,
  };

  const [commits, refs, filesBySha] = await Promise.all([
    collectCommits(repo, selection),
    collectRefs(repo),
    collectChangedFiles(repo, selection),
  ]);

  const decorations = buildDecorationMap(refs);
  const { commits: laid, edges, maxLane } = layout(commits);

  const oldestFirst = [...commits].reverse();
  const { revertedBy, reverts } = buildRevertIndex(commits);
  const reintroductions = detectReintroductions(oldestFirst, revertedBy);

  const revertIndex = new Map(reverts.map((r) => [r.revert.sha, r]));
  const reintroduced = new Map();
  const reintroducedOriginal = new Map();
  for (const r of reintroductions) {
    reintroduced.set(r.reintroduction.sha, r);
    reintroducedOriginal.set(r.original.sha, r);
  }

  const ctx = { revertIndex, reintroduced, reintroducedOriginal, revertedBy, filesBySha };

  const annotated = laid.map((commit) => {
    const kinds = classify(commit, ctx);
    const revertInfo = revertIndex.get(commit.sha);
    const reintro = reintroduced.get(commit.sha);
    return {
      ...commit,
      kinds,
      refs: decorations.get(commit.sha) || [],
      changedFiles: (filesBySha.get(commit.sha) || []).length,
      revertOf: revertInfo
        ? revertInfo.original
          ? revertInfo.original.short
          : revertInfo.confidence
        : null,
      reintroduces: reintro ? reintro.original.short : null,
    };
  });

  const events = buildEvents(annotated, {
    reverts,
    reintroductions,
    refs,
  });

  return {
    repository: {
      root: repo.root,
      branch: refs.head,
      defaultBranch: refs.defaultBranch,
      headSha: refs.headSha,
    },
    commits: annotated,
    edges,
    maxLane,
    refs,
    events,
    stats: buildStats(annotated),
  };
}

/**
 * Produce the human-readable "story" events from annotated commits.
 * @param {object[]} commits newest-first
 */
function buildEvents(commits, ctx) {
  const events = [];

  for (const commit of commits) {
    if (commit.kinds.includes('root')) {
      events.push({
        type: 'root',
        date: commit.committerDate,
        sha: commit.sha,
        short: commit.short,
        title: 'Repository created',
        detail: `Root commit by ${commit.authorName}`,
      });
    }

    if (commit.kinds.includes('reintroduced')) {
      const r = ctx.reintroductions.find((x) => x.reintroduction.sha === commit.sha);
      events.push({
        type: 'reintroduced',
        date: commit.committerDate,
        sha: commit.sha,
        short: commit.short,
        title: 'Feature reintroduced',
        detail: `Restores changes from ${r.original.short} after they were reverted in ${r.revert.short}.`,
      });
    }

    if (commit.kinds.includes('merge')) {
      const info = detectMergeInfo(commit);
      events.push({
        type: 'merge',
        date: commit.committerDate,
        sha: commit.sha,
        short: commit.short,
        title: info.branch ? `Merged branch '${info.branch}'` : 'Merge',
        detail: `${commit.parents.length} parents${info.pullRequest ? ` · PR #${info.pullRequest}` : ''}`,
        branch: info.branch,
      });
    }

    if (commit.kinds.includes('revert')) {
      const r = ctx.reverts.find((x) => x.revert.sha === commit.sha);
      events.push({
        type: 'revert',
        date: commit.committerDate,
        sha: commit.sha,
        short: commit.short,
        title: 'Changes reverted',
        detail: r && r.original
          ? `Reverts ${r.original.short}: "${r.original.subject}"`
          : 'Revert commit (original could not be linked automatically).',
      });
    }

    if (commit.kinds.includes('dependency') && !commit.isMerge) {
      const files = [];
      // changedFiles count is stored, path list is on the commit if provided
      events.push({
        type: 'dependency',
        date: commit.committerDate,
        sha: commit.sha,
        short: commit.short,
        title: 'Dependency manifest changed',
        detail: commit.subject,
      });
    }
  }

  for (const tag of ctx.refs.tags) {
    events.push({
      type: 'tag',
      date: tag.date,
      sha: tag.sha,
      short: tag.sha.slice(0, 7),
      title: `Tag ${tag.name}`,
      detail: tag.subject || '',
    });
  }

  return events.sort((a, b) => new Date(b.date) - new Date(a.date));
}

function buildStats(commits) {
  const authors = new Map();
  let merges = 0;
  let reverts = 0;
  for (const c of commits) {
    authors.set(c.authorEmail, (authors.get(c.authorEmail) || 0) + 1);
    if (c.isMerge) merges += 1;
    if (c.kinds.includes('revert')) reverts += 1;
  }
  const dates = commits
    .map((c) => Date.parse(c.committerDate))
    .filter((n) => Number.isFinite(n));
  return {
    totalCommits: commits.length,
    merges,
    reverts,
    authors: authors.size,
    firstDate: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
    lastDate: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
  };
}

module.exports = { buildTimeline, buildEvents, classify };
