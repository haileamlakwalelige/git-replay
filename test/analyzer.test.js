'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Repo } = require('../src/core/repo');
const { collectCommits, collectCommitDetail } = require('../src/core/collector');
const {
  detectRevert,
  detectMergeInfo,
  buildRevertIndex,
  detectReintroductions,
  analyzeDependencyChange,
  isFixCommit,
  isManifest,
  manifestKind,
} = require('../src/core/analyzer');
const { assignLanes } = require('../src/core/lanes');
const { buildScenario } = require('./helpers');

test('detectRevert links a git revert to its original commit', async (t) => {
  const scenario = buildScenario();
  t.after(() => scenario.cleanup());
  const repo = await Repo.open(scenario.root);

  const detail = await collectCommitDetail(repo, scenario.sha.revert);
  const info = detectRevert(detail);
  assert.strictEqual(info.isRevert, true);
  assert.strictEqual(info.confidence, 'high');
  assert.strictEqual(info.revertedSha, scenario.sha.d);
});

test('detectMergeInfo reads the merged branch name', async (t) => {
  const scenario = buildScenario();
  t.after(() => scenario.cleanup());
  const repo = await Repo.open(scenario.root);

  const detail = await collectCommitDetail(repo, scenario.sha.merge);
  const info = detectMergeInfo(detail);
  assert.strictEqual(info.isMerge, true);
  assert.strictEqual(info.branch, 'feature/payment');
});

test('buildRevertIndex and detectReintroductions find a reverted+reapplied feature', async (t) => {
  const scenario = buildScenario();
  t.after(() => scenario.cleanup());
  const repo = await Repo.open(scenario.root);

  const commits = await collectCommits(repo, { all: true });
  const oldestFirst = [...commits].reverse();
  const { revertedBy } = buildRevertIndex(commits);

  assert.ok(revertedBy.has(scenario.sha.d), 'original commit should be marked reverted');
  assert.strictEqual(revertedBy.get(scenario.sha.d).sha, scenario.sha.revert);

  const reintros = detectReintroductions(oldestFirst, revertedBy);
  assert.strictEqual(reintros.length, 1);
  assert.strictEqual(reintros[0].reintroduction.sha, scenario.sha.reapply);
  assert.strictEqual(reintros[0].original.sha, scenario.sha.d);
});

test('analyzeDependencyChange detects a package.json version bump', async (t) => {
  const scenario = buildScenario();
  t.after(() => scenario.cleanup());
  const repo = await Repo.open(scenario.root);

  const detail = await collectCommitDetail(repo, scenario.sha.g);
  const result = await analyzeDependencyChange(repo, detail, detail);
  assert.ok(result, 'expected dependency analysis');
  const npm = result.manifests.find((m) => m.kind === 'npm');
  assert.ok(npm);
  const lodash = npm.changes.find((c) => c.name === 'lodash');
  assert.ok(lodash);
  assert.strictEqual(lodash.from, '4.17.20');
  assert.strictEqual(lodash.to, '4.17.21');
  assert.strictEqual(lodash.type, 'changed');
});

test('manifest helpers classify known files', () => {
  assert.ok(isManifest('package.json'));
  assert.ok(isManifest('sub/dir/go.mod'));
  assert.ok(!isManifest('src/app.js'));
  assert.strictEqual(manifestKind('Cargo.toml'), 'cargo');
  assert.strictEqual(manifestKind('requirements.txt'), 'pip');
});

test('isFixCommit recognises fix-shaped messages', () => {
  assert.ok(isFixCommit({ subject: 'Fix crash on startup', body: '' }));
  assert.ok(isFixCommit({ subject: 'Resolve regression in auth', body: '' }));
  assert.ok(!isFixCommit({ subject: 'Add new dashboard', body: '' }));
});

test('assignLanes places a merge and its parents in distinct lanes', async (t) => {
  const scenario = buildScenario();
  t.after(() => scenario.cleanup());
  const repo = await Repo.open(scenario.root);

  const commits = await collectCommits(repo, { all: true });
  const { lanes, edges, maxLane } = assignLanes(commits);

  assert.ok(maxLane >= 1, 'a branched history needs at least two lanes');
  assert.ok(lanes.has(scenario.sha.merge));
  // The merge has edges to both its parents.
  const mergeEdges = edges.filter((e) => e.fromSha === scenario.sha.merge);
  assert.strictEqual(mergeEdges.length, 2);
  assert.ok(edges.every((e) => lanes.has(e.toSha)));
});
