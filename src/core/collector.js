'use strict';

const FS = '\x1f';
const RS = '\x1e';

const LOG_TOKENS = [
  '%H',
  '%h',
  '%P',
  '%an',
  '%ae',
  '%aI',
  '%cn',
  '%ce',
  '%cI',
  '%ct',
  '%s',
  '%b',
];

const LOG_FORMAT = LOG_TOKENS.join('%x1f') + '%x1e';
// Same fields but prefixed with a record separator and without a trailing one,
// so any following `--name-status`/`--numstat` output stays with its commit.
const LOG_FORMAT_PREFIXED = '%x1e' + LOG_TOKENS.join('%x1f');

/** Field order for LOG_FORMAT, keeps parsing honest. */
const FIELDS = [
  'sha',
  'short',
  'parents',
  'authorName',
  'authorEmail',
  'authorDate',
  'committerName',
  'committerEmail',
  'committerDate',
  'committerTimestamp',
  'subject',
  'body',
];

/**
 * Parse a NUL/US-delimited `git log` output into commit objects.
 * @param {string} raw
 * @returns {object[]}
 */
function parseLog(raw) {
  const commits = [];
  for (const record of raw.split(RS)) {
    const trimmed = record.replace(/^\n/, '');
    if (!trimmed) continue;
    const parts = trimmed.split(FS);
    if (parts.length < FIELDS.length) continue;
    const commit = {};
    FIELDS.forEach((name, i) => {
      commit[name] = parts[i];
    });
    commit.parents = commit.parents
      ? commit.parents.split(' ').filter(Boolean)
      : [];
    commit.committerTimestamp = Number(commit.committerTimestamp) || 0;
    // The body field is last; rejoin in case a body contained the FS byte.
    if (parts.length > FIELDS.length) {
      commit.body = parts.slice(FIELDS.length - 1).join(FS);
    }
    commit.body = (commit.body || '').trim();
    commit.isMerge = commit.parents.length > 1;
    commits.push(commit);
  }
  return commits;
}

/**
 * Collect commits for a revision range.
 *
 * @param {import('./repo').Repo} repo
 * @param {object} [opts]
 * @param {string} [opts.rev='HEAD']
 * @param {boolean} [opts.all=false]  include all refs (full graph)
 * @param {number} [opts.limit]
 * @param {number} [opts.skip]
 * @param {string} [opts.path]  restrict to a path
 * @param {boolean} [opts.follow]
 * @param {boolean} [opts.firstParent]
 * @returns {Promise<object[]>}
 */
async function collectCommits(repo, opts = {}) {
  const args = ['log', `--pretty=format:${LOG_FORMAT}`, '--date-order'];

  if (opts.all) {
    args.push('--all');
  } else if (opts.rev) {
    args.push(opts.rev);
  } else {
    args.push('HEAD');
  }

  if (opts.firstParent) args.push('--first-parent');
  if (opts.follow && opts.path) args.push('--follow');
  if (opts.limit != null) args.push(`--max-count=${opts.limit}`);
  if (opts.skip) args.push(`--skip=${opts.skip}`);

  if (opts.path) {
    args.push('--');
    args.push(opts.path);
  }

  const raw = await repo.run(args);
  return parseLog(raw);
}

/**
 * Collect the changed file paths for every commit in one pass.
 * @param {import('./repo').Repo} repo
 * @param {object} [opts]  same selection options as collectCommits
 * @returns {Promise<Map<string, string[]>>} sha -> changed paths
 */
async function collectChangedFiles(repo, opts = {}) {
  const args = ['log', '--pretty=format:%x1e%H', '--name-only', '--date-order'];
  if (opts.all) args.push('--all');
  else args.push(opts.rev || 'HEAD');
  if (opts.firstParent) args.push('--first-parent');
  if (opts.limit != null) args.push(`--max-count=${opts.limit}`);
  if (opts.path) args.push('--', opts.path);

  const raw = await repo.run(args);
  const map = new Map();
  let cur = null;
  for (const line of raw.split('\n')) {
    const clean = line.replace(/\r$/, '');
    if (clean.startsWith(RS)) {
      cur = clean.slice(1).trim();
      map.set(cur, []);
      continue;
    }
    if (!clean) continue;
    if (cur) map.get(cur).push(clean);
  }
  return map;
}

/**
 * Collect all refs (branches, remotes, tags) with their target commits.
 * @param {import('./repo').Repo} repo
 * @returns {Promise<{branches: object[], tags: object[], head: string|null, defaultBranch: string|null}>}
 */
async function collectRefs(repo) {
  const raw = await repo.run([
    'for-each-ref',
    `--format=%(refname)${FS}%(objectname)${FS}%(objecttype)${FS}%(committerdate:iso8601)${FS}%(subject)`,
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ]);

  const branches = [];
  const tags = [];
  for (const line of raw.split('\n')) {
    const clean = line.replace(/\r$/, '');
    if (!clean) continue;
    const [refname, objectname, objecttype, date, subject] = clean.split(FS);
    if (refname.startsWith('refs/heads/')) {
      branches.push({
        kind: 'local',
        name: refname.slice('refs/heads/'.length),
        fullName: refname,
        sha: objectname,
        date,
        subject,
      });
    } else if (refname.startsWith('refs/remotes/')) {
      const name = refname.slice('refs/remotes/'.length);
      if (name.endsWith('/HEAD')) continue;
      branches.push({
        kind: 'remote',
        name,
        fullName: refname,
        sha: objectname,
        date,
        subject,
      });
    } else if (refname.startsWith('refs/tags/')) {
      tags.push({
        kind: 'tag',
        name: refname.slice('refs/tags/'.length),
        fullName: refname,
        objectType: objecttype,
        sha: objectname,
        date,
        subject,
      });
    }
  }

  const head = await repo.currentBranch();
  const headSha = (await repo.try(['rev-parse', 'HEAD'])).stdout.trim() || null;
  const defaultBranch = detectDefaultBranch(branches, head);

  return { branches, tags, head, headSha, defaultBranch };
}

function detectDefaultBranch(branches, head) {
  const locals = branches.filter((b) => b.kind === 'local').map((b) => b.name);
  if (locals.includes('main')) return 'main';
  if (locals.includes('master')) return 'master';
  if (locals.includes('develop')) return 'develop';
  if (head && locals.includes(head)) return head;
  return locals[0] || null;
}

/**
 * Map a commit sha -> refs pointing at it (for decorations).
 * @param {{branches: object[], tags: object[]}} refs
 * @returns {Map<string, string[]>}
 */
function buildDecorationMap(refs) {
  const map = new Map();
  const add = (sha, label) => {
    if (!sha) return;
    if (!map.has(sha)) map.set(sha, []);
    map.get(sha).push(label);
  };
  for (const b of refs.branches) {
    add(b.sha, b.kind === 'remote' ? `→ ${b.name}` : b.name);
  }
  for (const t of refs.tags) add(t.sha, `⌂ ${t.name}`);
  return map;
}

/**
 * Full detail for one commit: stat, file changes and the raw diff.
 * @param {import('./repo').Repo} repo
 * @param {string} sha
 * @param {{diff?: boolean}} [opts]
 * @returns {Promise<object>}
 */
async function collectCommitDetail(repo, sha, opts = {}) {
  const meta = parseLog(
    await repo.run([
      'show',
      '--no-patch',
      `--pretty=format:${LOG_FORMAT}`,
      sha,
    ])
  )[0] || null;

  const stat = await repo.run([
    'show',
    '--stat=200',
    '--stat-count=200',
    '--oneline',
    '--no-color',
    sha,
  ]);

  const nameStatus = await repo.lines([
    'show',
    '--name-status',
    '--format=',
    '--no-color',
    '-M',
    sha,
  ]);

  const files = nameStatus
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([A-Z])(\d*)\t(.+)$/);
      if (!match) return { status: '?', path: line };
      const status = match[1];
      const rest = match[3].split('\t');
      if (status === 'R' || status === 'C') {
        return { status, score: Number(match[2]), from: rest[0], path: rest[1] };
      }
      return { status, path: rest[0] };
    })
    .filter((f) => f.path);

  const result = { ...meta, stat, files };

  if (opts.diff) {
    result.diff = await repo.run([
      'show',
      '--format=',
      '--no-color',
      '-M',
      '--patch',
      sha,
    ]);
  }

  return result;
}

module.exports = {
  FS,
  RS,
  LOG_FORMAT,
  LOG_FORMAT_PREFIXED,
  LOG_TOKENS,
  FIELDS,
  parseLog,
  collectCommits,
  collectChangedFiles,
  collectRefs,
  buildDecorationMap,
  collectCommitDetail,
  detectDefaultBranch,
};
