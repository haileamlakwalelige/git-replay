'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Repo } = require('../src/core/repo');
const { buildTimeline } = require('../src/core/timeline');
const { buildScenario } = require('./helpers');

test('buildTimeline annotates commits and produces story events', async (t) => {
  const scenario = buildScenario();
  t.after(() => scenario.cleanup());
  const repo = await Repo.open(scenario.root);

  const tl = await buildTimeline(repo, { all: true });

  assert.strictEqual(tl.repository.defaultBranch, 'main');
  assert.ok(tl.commits.length >= 9);
  assert.ok(tl.stats.merges >= 1);
  assert.ok(tl.stats.reverts >= 1);

  const merge = tl.commits.find((c) => c.sha === scenario.sha.merge);
  assert.ok(merge.kinds.includes('merge'));

  const revert = tl.commits.find((c) => c.sha === scenario.sha.revert);
  assert.ok(revert.kinds.includes('revert'));
  assert.strictEqual(revert.revertOf.slice(0, 7), scenario.sha.d.slice(0, 7));

  const original = tl.commits.find((c) => c.sha === scenario.sha.d);
  assert.ok(original.kinds.includes('reverted'));

  const reapply = tl.commits.find((c) => c.sha === scenario.sha.reapply);
  assert.ok(reapply.kinds.includes('reintroduced'));
  assert.strictEqual(reapply.reintroduces.slice(0, 7), scenario.sha.d.slice(0, 7));

  const dep = tl.commits.find((c) => c.sha === scenario.sha.g);
  assert.ok(dep.kinds.includes('dependency'));

  const eventTypes = new Set(tl.events.map((e) => e.type));
  assert.ok(eventTypes.has('merge'));
  assert.ok(eventTypes.has('revert'));
  assert.ok(eventTypes.has('reintroduced'));
  assert.ok(eventTypes.has('tag'));
});

test('buildTimeline respects a commit limit', async (t) => {
  const scenario = buildScenario();
  t.after(() => scenario.cleanup());
  const repo = await Repo.open(scenario.root);

  const tl = await buildTimeline(repo, { rev: 'HEAD', all: false, limit: 3 });
  assert.strictEqual(tl.commits.length, 3);
});
