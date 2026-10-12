'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * Run a git command in a fixture repo, returning trimmed stdout.
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string,string>} [env]
 */
function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

/**
 * A clock that hands out increasing, deterministic timestamps.
 */
function makeClock(start = Date.UTC(2021, 2, 1, 9, 0, 0), stepMinutes = 60) {
  let t = start;
  return () => {
    const iso = new Date(t).toISOString();
    t += stepMinutes * 60000;
    return iso;
  };
}

/**
 * Create a temp repo and return handles plus a commit helper.
 */
function initRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-replay-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Test Author']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.autocrlf', 'false']);

  const clock = makeClock();

  const dated = (args) => {
    const date = clock();
    return git(root, args, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  };

  const commit = (message, files) => {
    for (const [rel, content] of Object.entries(files || {})) write(root, rel, content);
    git(root, ['add', '-A']);
    dated(['commit', '-m', message, '--no-gpg-sign']);
    return git(root, ['rev-parse', 'HEAD']);
  };

  return {
    root,
    git: (args, env) => git(root, args, env),
    dated,
    commit,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Build the canonical scenario used across the tests: a feature branch,
 * a merge, a dependency bump, a revert and a reintroduction.
 */
function buildScenario() {
  const repo = initRepo();
  const sha = {};

  sha.a = repo.commit('Initial commit', { 'README.md': '# demo\n' });
  sha.b = repo.commit('Add app entry', { 'src/app.js': 'console.log("app");\n' });

  repo.git(['checkout', '-b', 'feature/payment']);
  sha.c = repo.commit('Start payment feature', { 'src/payment.js': 'module.exports = function pay() { return 1; };\n' });
  sha.d = repo.commit('Support refunds in payment', { 'src/payment.js': 'module.exports = function pay(x) { return x; };\n' });

  repo.git(['checkout', 'main']);
  sha.e = repo.commit('Add util helper', { 'src/util.js': 'module.exports = () => 42;\n' });
  repo.dated(['merge', '--no-ff', 'feature/payment', '-m', "Merge branch 'feature/payment'"]);
  sha.merge = repo.git(['rev-parse', 'HEAD']);

  sha.f = repo.commit('Add package manifest', {
    'package.json': JSON.stringify({ name: 'demo', dependencies: { lodash: '4.17.20' } }, null, 2) + '\n',
  });
  sha.g = repo.commit('Bump lodash', {
    'package.json': JSON.stringify({ name: 'demo', dependencies: { lodash: '4.17.21' } }, null, 2) + '\n',
  });

  repo.dated(['revert', '--no-edit', sha.d]);
  sha.revert = repo.git(['rev-parse', 'HEAD']);

  sha.reapply = repo.commit('Support refunds in payment', {
    'src/payment.js': 'module.exports = function pay(x) { return x; };\n',
  });

  repo.git(['tag', 'v1.0', sha.b]);

  return { ...repo, sha };
}

module.exports = { git, write, initRepo, buildScenario, makeClock };
