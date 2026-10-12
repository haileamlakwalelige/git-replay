'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Repo } = require('../src/core/repo');
const {
  collectCommits,
  collectChangedFiles,
  collectRefs,
  collectCommitDetail,
} = require('../src/core/collector');
const { buildScenario } = require('./helpers');

test('collects commits, refs and file changes for a real repo', async (t) => {
  const scenario = buildScenario();
  t.after(() => scenario.cleanup());
  const repo = await Repo.open(scenario.root);

  const commits = await collectCommits(repo, { rev: 'HEAD' });
  assert.ok(commits.length >= 9, 'expected at least 9 commits');
  assert.ok(commits.every((c) => c.sha && c.short && c.subject));
  assert.ok(commits.some((c) => c.isMerge), 'expected a merge commit');

  const merge = commits.find((c) => c.isMerge);
  assert.strictEqual(merge.parents.length, 2);

  const refs = await collectRefs(repo);
  assert.ok(refs.branches.some((b) => b.name === 'feature/payment'));
  assert.ok(refs.tags.some((tg) => tg.name === 'v1.0'));
  assert.strictEqual(refs.defaultBranch, 'main');

  const files = await collectChangedFiles(repo, { rev: 'HEAD' });
  assert.ok(files.get(scenario.sha.g).includes('package.json'));

  const detail = await collectCommitDetail(repo, scenario.sha.g, { diff: true });
  assert.match(detail.subject, /lodash/i);
  assert.ok(detail.files.some((f) => f.path === 'package.json'));
  assert.match(detail.diff, /lodash/);
});

test('parses all-refs timeline including the feature branch', async (t) => {
  const scenario = buildScenario();
  t.after(() => scenario.cleanup());
  const repo = await Repo.open(scenario.root);

  const all = await collectCommits(repo, { all: true });
  const shas = new Set(all.map((c) => c.sha));
  assert.ok(shas.has(scenario.sha.c));
  assert.ok(shas.has(scenario.sha.d));
});
