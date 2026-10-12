'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Repo } = require('../src/core/repo');
const { findBugIntroducingCommits, isFixCommit } = require('../src/core/analyzer');
const { initRepo } = require('./helpers');

test('findBugIntroducingCommits blames the commit that introduced a line', async (t) => {
  const repo = initRepo();
  t.after(() => repo.cleanup());

  repo.commit('Add config', { 'config.js': 'const timeout = 100;\n' });
  const bug = repo.commit('Tweak timeout', { 'config.js': 'const timeout = 5000;\n' });
  const fix = repo.commit('Fix: reduce timeout to avoid startup hang', {
    'config.js': 'const timeout = 100;\n',
  });

  const handle = await Repo.open(repo.root);
  const result = await findBugIntroducingCommits(handle, fix, { maxCandidates: 5 });

  assert.strictEqual(result.fix.sha, fix);
  assert.ok(result.candidates.length >= 1, 'expected at least one candidate');
  assert.strictEqual(result.candidates[0].sha, bug);
  assert.strictEqual(result.candidates[0].lines, 1);

  const detail = { subject: 'Fix: reduce timeout to avoid startup hang', body: '' };
  assert.strictEqual(isFixCommit(detail), true);
});

test('findBugIntroducingCommits handles a root commit (no parent)', async (t) => {
  const repo = initRepo();
  t.after(() => repo.cleanup());
  const root = repo.commit('Initial', { 'a.txt': 'hello\n' });

  const handle = await Repo.open(repo.root);
  const result = await findBugIntroducingCommits(handle, root);
  assert.strictEqual(result.candidates.length, 0);
});
