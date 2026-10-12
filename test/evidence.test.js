'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Repo } = require('../src/core/repo');
const {
  gatherCommitEvidence,
  gatherFileEvidence,
  gatherCompareEvidence,
  answerQuestion,
} = require('../src/core/evidence');
const { buildScenario } = require('./helpers');

test('gatherCommitEvidence links a revert to its original', async (t) => {
  const scenario = buildScenario();
  t.after(() => scenario.cleanup());
  const repo = await Repo.open(scenario.root);

  const ev = await gatherCommitEvidence(repo, scenario.sha.revert);
  assert.strictEqual(ev.classification.isRevert, true);
  assert.ok(ev.related.reverts);
  assert.strictEqual(ev.related.reverts.sha, scenario.sha.d);
});

test('gatherCommitEvidence finds reverts that reference a commit', async (t) => {
  const scenario = buildScenario();
  t.after(() => scenario.cleanup());
  const repo = await Repo.open(scenario.root);

  const ev = await gatherCommitEvidence(repo, scenario.sha.d);
  assert.ok(ev.related.revertedBy && ev.related.revertedBy.length >= 1);
  assert.strictEqual(ev.related.revertedBy[0].sha, scenario.sha.revert);
});

test('gatherCommitEvidence summarises a merge', async (t) => {
  const scenario = buildScenario();
  t.after(() => scenario.cleanup());
  const repo = await Repo.open(scenario.root);

  const ev = await gatherCommitEvidence(repo, scenario.sha.merge);
  assert.strictEqual(ev.classification.isMerge, true);
  assert.ok(ev.related.broughtIn);
  assert.ok(ev.related.broughtIn.count >= 2);
});

test('gatherFileEvidence traces creation and changes with --follow', async (t) => {
  const scenario = buildScenario();
  t.after(() => scenario.cleanup());
  const repo = await Repo.open(scenario.root);

  const ev = await gatherFileEvidence(repo, 'src/payment.js');
  assert.ok(ev.exists);
  assert.ok(ev.history.length >= 3);
  assert.ok(ev.created);
  assert.ok(ev.authors.length >= 1);
});

test('gatherFileEvidence reports a deleted path', async (t) => {
  const scenario = buildScenario();
  t.after(() => scenario.cleanup());
  const repo = await Repo.open(scenario.root);

  const ev = await gatherFileEvidence(repo, 'src/does-not-exist.js');
  assert.strictEqual(ev.exists, false);
  assert.strictEqual(ev.history.length, 0);
});

test('gatherCompareEvidence summarises a range', async (t) => {
  const scenario = buildScenario();
  t.after(() => scenario.cleanup());
  const repo = await Repo.open(scenario.root);

  const ev = await gatherCompareEvidence(repo, `${scenario.sha.f}..${scenario.sha.g}`);
  assert.strictEqual(ev.files.length, 1);
  assert.strictEqual(ev.files[0].path, 'package.json');
  assert.ok(ev.summary.insertions >= 1);
});

test('answerQuestion routes "why was X deleted" to file history', async (t) => {
  const scenario = buildScenario();
  t.after(() => scenario.cleanup());
  const repo = await Repo.open(scenario.root);

  const res = await answerQuestion(repo, 'why was "src/payment.js" deleted?');
  assert.ok(res.answer.includes('src/payment.js'));
  // The file still exists, so the grounded answer should say so.
  assert.match(res.answer, /still exists|not.*deleted/i);
});

test('answerQuestion handles an unknown path honestly', async (t) => {
  const scenario = buildScenario();
  t.after(() => scenario.cleanup());
  const repo = await Repo.open(scenario.root);

  const res = await answerQuestion(repo, 'why was "nope/missing.js" deleted?');
  assert.ok(res.answer.length > 0);
  assert.strictEqual(res.confidence, 'low');
});
