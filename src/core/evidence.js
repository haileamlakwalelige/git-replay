'use strict';

const {
  parseLog,
  LOG_FORMAT,
  LOG_FORMAT_PREFIXED,
  collectCommitDetail,
} = require('./collector');
const {
  detectRevert,
  detectMergeInfo,
  analyzeDependencyChange,
  findBugIntroducingCommits,
  buildRevertIndex,
  isManifest,
} = require('./analyzer');

/**
 * Gather all grounded evidence we have about a single commit.
 * @param {import('./repo').Repo} repo
 * @param {string} rev
 * @returns {Promise<object>}
 */
async function gatherCommitEvidence(repo, rev) {
  const sha = await repo.resolve(rev);
  if (!sha) {
    const err = new Error(`Unknown revision: ${rev}`);
    err.code = 'EBADREV';
    throw err;
  }

  const detail = await collectCommitDetail(repo, sha, { diff: true });
  const revert = detectRevert(detail);
  const merge = detectMergeInfo(detail);
  const dependency = await analyzeDependencyChange(repo, detail, detail);

  const related = {};

  // If this is a revert, link the original. If it *was* reverted, link that too.
  if (revert.isRevert) {
    if (revert.revertedSha) {
      const { ok, stdout } = await repo.try([
        'show',
        '--no-patch',
        `--pretty=format:${LOG_FORMAT}`,
        revert.revertedSha,
      ]);
      if (ok && stdout.trim()) {
        const original = parseLog(stdout)[0];
        if (original) related.reverts = original;
      }
    }
  }

  // Commits whose message explicitly reverts this sha (search reachable log).
  const revertSearch = await repo.try([
    'log',
    '--all',
    '--grep',
    `This reverts commit ${sha}`,
    '--fixed-strings',
    '--format=%H%x1f%h%x1f%aI%x1f%s',
  ]);
  if (revertSearch.ok && revertSearch.stdout.trim()) {
    related.revertedBy = revertSearch.stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [s, short, date, subject] = line.split('\x1f');
        return { sha: s, short, date, subject };
      });
  }

  if (merge.isMerge && detail.parents.length > 1) {
    const { ok, stdout } = await repo.try([
      'log',
      '--oneline',
      '--no-color',
      `${detail.parents[0]}..${sha}`,
    ]);
    if (ok) {
      const lines = stdout.trim().split('\n').filter(Boolean);
      related.broughtIn = { count: lines.length, sample: lines.slice(0, 15) };
    }
  }

  return {
    sha,
    commit: detail,
    classification: {
      isMerge: merge.isMerge,
      isRevert: revert.isRevert,
      merge,
      revert,
    },
    dependency,
    related,
  };
}

/**
 * Gather file-history evidence for a path.
 * @param {import('./repo').Repo} repo
 * @param {string} path
 * @param {{limit?: number}} [opts]
 */
async function gatherFileEvidence(repo, path, opts = {}) {
  const args = [
    'log',
    '--follow',
    '--name-status',
    '--date-order',
    `--pretty=format:${LOG_FORMAT_PREFIXED}`,
  ];
  if (opts.limit) args.push(`--max-count=${opts.limit}`);
  args.push('--', path);

  const { ok, stdout } = await repo.try(args);
  if (!ok || !stdout.trim()) {
    return { path, exists: false, history: [] };
  }

  const entries = [];
  for (const record of stdout.split('\x1e')) {
    const trimmed = record.replace(/^\n/, '');
    if (!trimmed) continue;
    const nl = trimmed.indexOf('\n');
    const metaLine = nl === -1 ? trimmed : trimmed.slice(0, nl);
    const statusBlock = nl === -1 ? '' : trimmed.slice(nl + 1);

    const commit = parseLog(metaLine + '\x1e')[0];
    if (!commit) continue;

    const statuses = statusBlock
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^([A-Z])(\d*)\t(.+)$/);
        if (!m) return null;
        const status = m[1];
        const rest = m[3].split('\t');
        return status === 'R' || status === 'C'
          ? { status, score: Number(m[2]), from: rest[0], to: rest[1] }
          : { status, path: rest[0] };
      })
      .filter(Boolean);

    entries.push({ ...commit, statuses });
  }

  const exists = (await repo.try(['cat-file', '-e', `HEAD:${path}`])).ok;
  const created = entries.length ? entries[entries.length - 1] : null;
  const last = entries.length ? entries[0] : null;
  const deletion = entries.find((e) =>
    e.statuses.some((s) => s.status === 'D' && (s.path === path || s.to === path))
  );

  const authors = new Map();
  for (const e of entries) {
    authors.set(e.authorEmail, (authors.get(e.authorEmail) || 0) + 1);
  }

  return {
    path,
    exists,
    history: entries,
    created: created ? { sha: created.sha, short: created.short, date: created.committerDate, subject: created.subject } : null,
    lastChange: last ? { sha: last.sha, short: last.short, date: last.committerDate, subject: last.subject } : null,
    deletion: deletion
      ? { sha: deletion.sha, short: deletion.short, date: deletion.committerDate, subject: deletion.subject }
      : null,
    authors: [...authors.entries()]
      .map(([email, count]) => ({ email, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * Compare two revisions and summarise the delta.
 * @param {import('./repo').Repo} repo
 * @param {string} range  e.g. "HEAD~10..HEAD"
 */
async function gatherCompareEvidence(repo, range) {
  const stat = await repo.run(['diff', '--stat=200', '--no-color', range]);
  const numstat = await repo.lines(['diff', '--numstat', range]);
  const files = numstat
    .map((line) => {
      const [add, del, ...rest] = line.split('\t');
      return {
        added: add === '-' ? null : Number(add),
        removed: del === '-' ? null : Number(del),
        path: rest.join('\t'),
        binary: add === '-',
      };
    })
    .filter((f) => f.path);

  const summary = files.reduce(
    (acc, f) => {
      acc.insertions += f.added || 0;
      acc.deletions += f.removed || 0;
      return acc;
    },
    { insertions: 0, deletions: 0 }
  );

  const fixes = await repo.try([
    'log',
    '--oneline',
    '--no-color',
    '--grep',
    'fix',
    '-i',
    '--max-count=20',
    range,
  ]);

  return {
    range,
    stat,
    files,
    summary: { files: files.length, ...summary },
    fixCommits: fixes.ok ? fixes.stdout.trim().split('\n').filter(Boolean) : [],
  };
}

/**
 * Answer a natural-language question using only collected Git evidence.
 * Returns a structured, cited answer. It never invents commit content.
 *
 * @param {import('./repo').Repo} repo
 * @param {string} question
 * @returns {Promise<object>}
 */
async function answerQuestion(repo, question) {
  const q = question.trim();
  const lower = q.toLowerCase();

  const quotedPath = q.match(/["'`]([^"'`]+)["'`]/);
  const pathLike = q.match(/([\w./-]+\.\w{1,8})\b/);
  const filePath = quotedPath ? quotedPath[1] : pathLike ? pathLike[1] : null;

  if (/\b(delet|remov|gone|why.*gone)/.test(lower) && filePath) {
    return answerDeletion(repo, filePath, question);
  }

  if (/\b(dependency|dependencie|version|upgrade|bump|package|manifest)\b/.test(lower)) {
    return answerDependency(repo, question);
  }

  if (/\b(who|which commit|when).*\b(introduc|add|chang|bug|wrote)/.test(lower) || /\bwho\b/.test(lower)) {
    return answerWhoIntroduced(repo, filePath, question);
  }

  if (/\b(since|last|recent|between)\b/.test(lower)) {
    return answerRecent(repo, question);
  }

  return {
    question,
    answer:
      'I could not map this question to a specific Git evidence query. Try naming a file ' +
      '(e.g. "why was src/auth.ts deleted?") or a theme such as dependencies, who introduced ' +
      'a line, or what changed recently.',
    evidence: [],
    confidence: 'low',
  };
}

async function answerDeletion(repo, path, question) {
  const evidence = await gatherFileEvidence(repo, path);
  if (!evidence.history.length) {
    return {
      question,
      answer: `No history found for \`${path}\`. It may never have existed in the reachable history, or the path differs.`,
      evidence: [],
      confidence: 'low',
    };
  }
  if (evidence.exists) {
    return {
      question,
      answer: `\`${path}\` still exists at HEAD. It was last changed in ${evidence.lastChange.short} ("${evidence.lastChange.subject}", ${evidence.lastChange.date}). If you meant a specific block of code, try \`git-replay file ${path}\` and inspect the removal commits.`,
      evidence: [evidence.lastChange],
      confidence: 'medium',
    };
  }
  const d = evidence.deletion || evidence.lastChange;
  return {
    question,
    answer: d
      ? `\`${path}\` was removed in ${d.short} — "${d.subject}" (${d.date}). Inspect \`git-replay explain ${d.short}\` for the diff and message. ${
          looksExplanatory(d.subject)
            ? 'The commit message provides a stated reason.'
            : 'The available history does not state a reason, so the why is not provable from Git alone.'
        }`
      : `\`${path}\` does not exist at HEAD and no removal commit was found.`,
    evidence: d ? [d] : [],
    confidence: d ? 'high' : 'low',
  };
}

async function answerWhoIntroduced(repo, path, question) {
  if (!path) {
    return {
      question,
      answer: 'Name a file (and optionally a line) to trace, e.g. "who introduced processPayment in src/payments.ts".',
      evidence: [],
      confidence: 'low',
    };
  }
  const evidence = await gatherFileEvidence(repo, path, { limit: 50 });
  if (!evidence.created) {
    return {
      question: question,
      answer: `No history found for \`${path}\`.`,
      evidence: [],
      confidence: 'low',
    };
  }
  return {
    question,
    answer: `\`${path}\` was first introduced by ${evidence.created.sha ? evidence.created.short : '?'} — "${evidence.created.subject}" (${evidence.created.date}). It has been changed in ${evidence.history.length} commit(s) by ${evidence.authors.length} author(s).`,
    evidence: evidence.history.slice(0, 10).map((h) => ({
      sha: h.short,
      date: h.committerDate,
      subject: h.subject,
      author: h.authorName,
    })),
    confidence: 'high',
  };
}

async function answerDependency(repo, question) {
  const commits = await repo.lines([
    'log',
    '--all',
    '-i',
    '--grep',
    'package.json',
    '--oneline',
    '--no-color',
    '--max-count=20',
  ]);
  const manifestCommits = await repo.try([
    'log',
    '--all',
    '--oneline',
    '--no-color',
    '--max-count=20',
    '--',
    'package.json',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'go.mod',
    'Cargo.toml',
    'requirements.txt',
  ]);

  const lines = manifestCommits.ok ? manifestCommits.stdout.trim().split('\n').filter(Boolean) : [];
  return {
    question,
    answer: lines.length
      ? `Found ${lines.length} recent commit(s) touching dependency manifests. Use \`git-replay explain <sha>\` on any of them to see the exact version changes.`
      : 'No dependency manifest changes were found in the reachable history.',
    evidence: lines.slice(0, 15),
    searchHint: commits,
    confidence: lines.length ? 'medium' : 'low',
  };
}

async function answerRecent(repo, question) {
  const range = (question.match(/(HEAD~?\d*\.\.\S+|[\w-]+\s+days?\s+ago)/i) || [])[0] || 'HEAD~20..HEAD';
  const evidence = await repo.try(['log', '--oneline', '--no-color', '--max-count=20', range]);
  const lines = evidence.ok ? evidence.stdout.trim().split('\n').filter(Boolean) : [];
  return {
    question,
    answer: lines.length
      ? `Recent changes (${range}): ${lines.length} commit(s).`
      : `No commits found for range \`${range}\`.`,
    evidence: lines,
    confidence: lines.length ? 'medium' : 'low',
  };
}

function looksExplanatory(subject) {
  return /\b(because|since|to |refactor|deprecat|security|perf|breaking|no longer|migrat)\b/i.test(
    subject || ''
  );
}

module.exports = {
  gatherCommitEvidence,
  gatherFileEvidence,
  gatherCompareEvidence,
  answerQuestion,
};
