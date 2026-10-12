'use strict';

const { parseUnifiedDiff } = require('./diff');

const MANIFEST_PATTERNS = [
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)go\.mod$/,
  /(^|\/)go\.sum$/,
  /(^|\/)Cargo\.toml$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)requirements\.txt$/,
  /(^|\/)Pipfile$/,
  /(^|\/)Gemfile(\.lock)?$/,
  /(^|\/)composer\.json$/,
  /(^|\/)pom\.xml$/,
  /(^|\/)build\.gradle(\.kts)?$/,
  /(^|\/)\.csproj$/,
  /(^|\/)pubspec\.yaml$/,
];

/** @param {string} path */
function isManifest(path) {
  return MANIFEST_PATTERNS.some((re) => re.test(path));
}

/** Detect a dependency-manifest change from the path alone. */
function manifestKind(path) {
  if (/(^|\/)package\.json$/.test(path)) return 'npm';
  if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(path)) return 'npm-lock';
  if (/(^|\/)go\.(mod|sum)$/.test(path)) return 'go';
  if (/(^|\/)Cargo\.(toml|lock)$/.test(path)) return 'cargo';
  if (/(^|\/)(requirements\.txt|Pipfile)$/.test(path)) return 'pip';
  if (/(^|\/)Gemfile(\.lock)?$/.test(path)) return 'ruby';
  if (/(^|\/)composer\.json$/.test(path)) return 'composer';
  if (/(^|\/)pom\.xml$/.test(path)) return 'maven';
  if (/(^|\/)build\.gradle(\.kts)?$/.test(path)) return 'gradle';
  if (/(^|\/)\.csproj$/.test(path)) return 'nuget';
  if (/(^|\/)pubspec\.yaml$/.test(path)) return 'pub';
  return null;
}

/**
 * Detect whether a commit is a revert of an earlier commit.
 * Uses git's conventional revert message and body.
 *
 * @param {{subject: string, body: string}} commit
 * @returns {{isRevert: boolean, revertedSha: string|null, confidence: 'high'|'medium'|'low'}}
 */
function detectRevert(commit) {
  const subject = commit.subject || '';
  const body = commit.body || '';
  const looksLikeRevert = /^revert\b/i.test(subject) || /^revert\b/i.test(body);

  const bodyMatch = body.match(/This reverts commit ([0-9a-f]{7,40})/i);
  if (bodyMatch) {
    return { isRevert: true, revertedSha: bodyMatch[1].toLowerCase(), confidence: 'high' };
  }

  const subjectMatch = subject.match(/revert[^"]*"(.+)"\s*$/i);
  if (looksLikeRevert) {
    return {
      isRevert: true,
      revertedSha: null,
      revertedSubject: subjectMatch ? subjectMatch[1] : null,
      confidence: 'medium',
    };
  }

  return { isRevert: false, revertedSha: null, confidence: 'low' };
}

/**
 * Extract merge metadata (merged branch name / pull request number).
 * @param {object} commit
 */
function detectMergeInfo(commit) {
  if (!commit.isMerge) return { isMerge: false };
  const subject = commit.subject || '';
  let branch = null;
  let pullRequest = null;

  const pr = subject.match(/Merge pull request #(\d+)/i);
  if (pr) pullRequest = Number(pr[1]);

  const branchMatch =
    subject.match(/Merge branch '([^']+)'/) ||
    subject.match(/Merge remote-tracking branch '[^/]+\/([^']+)'/) ||
    subject.match(/into ([^\s]+)/);
  if (branchMatch) branch = branchMatch[1];

  return {
    isMerge: true,
    branch,
    pullRequest,
    parentCount: commit.parents.length,
  };
}

/**
 * Build an index over a commit list mapping reverts to the commits they undo.
 * @param {object[]} commits
 */
function buildRevertIndex(commits) {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const revertedBy = new Map(); // originalSha -> revertCommit
  const reverts = []; // {revert, original}

  for (const commit of commits) {
    const info = detectRevert(commit);
    if (!info.isRevert) continue;
    let original = null;
    if (info.revertedSha) {
      original =
        bySha.get(info.revertedSha) ||
        commits.find((c) => c.sha.startsWith(info.revertedSha)) ||
        null;
    } else if (info.revertedSubject) {
      original =
        commits.find(
          (c) => c.sha !== commit.sha && c.subject === info.revertedSubject
        ) || null;
    }
    reverts.push({ revert: commit, original, confidence: info.confidence });
    if (original) revertedBy.set(original.sha, commit);
  }

  return { revertedBy, reverts };
}

/**
 * Detect features that were reverted and later reintroduced.
 * A reintroduction is a commit that appears after a revert and either restores
 * the original subject or explicitly re-applies the original commit.
 *
 * @param {object[]} commits oldest-first
 * @param {Map<string, object>} revertedBy originalSha -> revert commit
 */
function detectReintroductions(commits, revertedBy) {
  const out = [];
  for (let i = 0; i < commits.length; i += 1) {
    const commit = commits[i];
    if (revertedBy.has(commit.sha)) {
      const revert = revertedBy.get(commit.sha);
      const norm = normalizeSubject(commit.subject);
      // `commits` is oldest-first, so anything after the revert's position in
      // the array is a candidate reintroduction. We rely on ordering rather
      // than committer dates, which can be skewed across merged branches.
      const revertPos = commits.indexOf(revert);
      for (let j = Math.max(i + 1, revertPos + 1); j < commits.length; j += 1) {
        const later = commits[j];
        if (later.sha === revert.sha) continue;
        if (normalizeSubject(later.subject) === norm) {
          out.push({ original: commit, revert, reintroduction: later });
          break;
        }
      }
    }
  }
  return out;
}

function normalizeSubject(subject) {
  return String(subject || '')
    .toLowerCase()
    .replace(/^revert\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read a blob at a revision (path within the repo), returning '' when absent.
 * @param {import('./repo').Repo} repo
 * @param {string} rev
 * @param {string} path
 */
async function readBlob(repo, rev, path) {
  const { ok, stdout } = await repo.try(['show', `${rev}:${path}`]);
  return ok ? stdout : null;
}

/**
 * Analyze dependency changes in a commit.
 * Handles package.json structurally, other manifests line-by-line.
 *
 * @param {import('./repo').Repo} repo
 * @param {object} commit
 * @param {{files?: object[]}} [detail]
 */
async function analyzeDependencyChange(repo, commit, detail) {
  const files = detail && detail.files
    ? detail.files
    : (await repo.lines([
        'show',
        '--name-only',
        '--format=',
        '-M',
        commit.sha,
      ])).map((p) => ({ status: 'M', path: p }));

  const manifests = files
    .map((f) => f.path)
    .filter((p) => p && isManifest(p));
  if (manifests.length === 0) return null;

  const parent = commit.parents[0] || null;
  const results = [];

  for (const path of manifests) {
    if (/(^|\/)package\.json$/.test(path)) {
      const structured = await diffPackageJson(repo, parent, commit.sha, path);
      if (structured) results.push({ path, kind: 'npm', changes: structured });
    } else {
      const patch = await repo.run([
        'show',
        '--format=',
        '--no-color',
        '-M',
        '-U0',
        commit.sha,
        '--',
        path,
      ]);
      const parsed = parseUnifiedDiff(patch)[0];
      if (parsed) {
        results.push({
          path,
          kind: manifestKind(path),
          changes: [
            {
              type: 'lines',
              added: parsed.added.length,
              removed: parsed.removed.length,
              sampleAdded: parsed.added.slice(0, 8),
              sampleRemoved: parsed.removed.slice(0, 8),
            },
          ],
        });
      }
    }
  }

  return results.length ? { manifests: results } : null;
}

async function diffPackageJson(repo, parent, sha, path) {
  if (!parent) return null;
  const before = await readBlob(repo, parent, path);
  const after = await readBlob(repo, sha, path);
  if (before == null || after == null) return null;

  let a;
  let b;
  try {
    a = JSON.parse(before);
    b = JSON.parse(after);
  } catch {
    return null;
  }

  const groups = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];
  const changes = [];
  for (const group of groups) {
    const ga = a[group] || {};
    const gb = b[group] || {};
    const names = new Set([...Object.keys(ga), ...Object.keys(gb)]);
    for (const name of names) {
      if (!(name in ga)) changes.push({ group, name, from: null, to: gb[name], type: 'added' });
      else if (!(name in gb)) changes.push({ group, name, from: ga[name], to: null, type: 'removed' });
      else if (ga[name] !== gb[name]) changes.push({ group, name, from: ga[name], to: gb[name], type: 'changed' });
    }
  }
  return changes.length ? changes : null;
}

/**
 * SZZ-style heuristic: given a "fix" commit, blame the lines it removed in its
 * parent to surface candidate bug-introducing commits.
 *
 * @param {import('./repo').Repo} repo
 * @param {string} sha
 * @param {{maxCandidates?: number}} [opts]
 * @returns {Promise<{fix: object, candidates: object[], method: string}>}
 */
async function findBugIntroducingCommits(repo, sha, opts = {}) {
  const meta = (await repo.run([
    'show',
    '--no-patch',
    '--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%b',
    sha,
  ])).split('\x1f');
  const commit = {
    sha: meta[0],
    short: meta[1],
    parents: meta[2] ? meta[2].split(' ').filter(Boolean) : [],
    authorName: meta[3],
    authorDate: meta[4],
    subject: meta[5],
    body: (meta[6] || '').trim(),
  };
  const parent = commit.parents[0];
  if (!parent) {
    return { fix: commit, candidates: [], method: 'szz', note: 'root commit has no parent' };
  }

  const patch = await repo.run([
    'show',
    '--format=',
    '--no-color',
    '-M',
    '-U0',
    commit.sha,
  ]);
  const files = parseUnifiedDiff(patch);
  const tally = new Map();

  for (const file of files) {
    if (!file.path) continue;
    for (const hunk of file.hunks) {
      if (!hunk.oldLines) continue;
      const range = `${hunk.oldStart},+${hunk.oldLines}`;
      const blame = await repo.try([
        'blame',
        '--line-porcelain',
        '-L',
        range,
        parent,
        '--',
        file.path,
      ]);
      if (!blame.ok) continue;
      for (const line of blame.stdout.split('\n')) {
        const m = line.match(/^([0-9a-f]{40})\s+\d+\s+\d+/);
        if (!m) continue;
        const introduceSha = m[1];
        // `parent` is a valid candidate: it is the commit that last touched the
        // line the fix removed. Only the fix commit itself is irrelevant.
        if (introduceSha === commit.sha) continue;
        if (!tally.has(introduceSha)) {
          tally.set(introduceSha, { sha: introduceSha, lines: 0, files: new Set() });
        }
        const entry = tally.get(introduceSha);
        entry.lines += 1;
        entry.files.add(file.path);
      }
    }
  }

  const candidates = [...tally.values()]
    .sort((a, b) => b.lines - a.lines)
    .slice(0, opts.maxCandidates || 10);

  // Enrich candidates with subject/author from the log.
  for (const candidate of candidates) {
    const info = (await repo.run([
      'show',
      '--no-patch',
      '--pretty=format:%h%x1f%an%x1f%aI%x1f%s',
      candidate.sha,
    ])).split('\x1f');
    candidate.short = info[0];
    candidate.authorName = info[1];
    candidate.authorDate = info[2];
    candidate.subject = info[3];
    candidate.files = [...candidate.files];
  }

  return { fix: commit, candidates, method: 'szz-blame' };
}

/**
 * Decide whether a commit "looks like" a fix (used to seed regression scans).
 * @param {object} commit
 */
function isFixCommit(commit) {
  const text = `${commit.subject}\n${commit.body || ''}`;
  return /\b(fix(e[sd])?|bug|issue|regress|resolve[sd]?|patch|hotfix|closes?|fixes)\b/i.test(
    text
  );
}

module.exports = {
  isManifest,
  manifestKind,
  detectRevert,
  detectMergeInfo,
  buildRevertIndex,
  detectReintroductions,
  analyzeDependencyChange,
  diffPackageJson,
  findBugIntroducingCommits,
  isFixCommit,
  normalizeSubject,
};
