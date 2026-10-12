'use strict';

const { git, gitLines, gitTry } = require('./git');

/**
 * A thin, cache-friendly handle around a single Git working tree.
 * All commands run with the repository root as the working directory.
 */
class Repo {
  constructor(root) {
    this.root = root;
    this._cache = new Map();
    this._shortSha = new Map();
  }

  /**
   * Open the repository that contains `cwd`.
   * @param {string} [cwd]
   * @returns {Promise<Repo>}
   */
  static async open(cwd = process.cwd()) {
    const { ok, stdout } = await gitTry(['rev-parse', '--show-toplevel'], { cwd });
    if (!ok) {
      const err = new Error(
        'Not a git repository (or any of the parent directories): ' + cwd
      );
      err.code = 'ENOTREPO';
      throw err;
    }
    return new Repo(stdout.trim());
  }

  /** @returns {Promise<string>} */
  run(args, opts = {}) {
    return git(args, { cwd: this.root, ...opts });
  }

  /** @returns {Promise<string[]>} */
  lines(args, opts = {}) {
    return gitLines(args, { cwd: this.root, ...opts });
  }

  /** @returns {Promise<{ok:boolean,stdout:string,stderr:string,code:number}>} */
  try(args, opts = {}) {
    return gitTry(args, { cwd: this.root, ...opts });
  }

  /** Current branch name, or null when detached. */
  async currentBranch() {
    const { ok, stdout } = await this.try(['symbolic-ref', '--short', '-q', 'HEAD']);
    return ok ? stdout.trim() : null;
  }

  /**
   * Resolve a revision expression to a full commit hash.
   * @param {string} rev
   * @returns {Promise<string|null>}
   */
  async resolve(rev) {
    const { ok, stdout } = await this.try([
      'rev-parse',
      '--verify',
      '--quiet',
      `${rev}^{commit}`,
    ]);
    return ok ? stdout.trim() : null;
  }

  /**
   * Resolve a revision to a short hash (memoised).
   * @param {string} rev
   * @returns {Promise<string>}
   */
  async shortSha(rev) {
    if (this._shortSha.has(rev)) return this._shortSha.get(rev);
    const out = (await this.run(['rev-parse', '--short', rev])).trim();
    this._shortSha.set(rev, out);
    return out;
  }

  /**
   * Whether the object database is shallow.
   * @returns {Promise<boolean>}
   */
  async isShallow() {
    const { stdout } = await this.try(['rev-parse', '--is-shallow-repository']);
    return stdout.trim() === 'true';
  }

  /**
   * Simple promise cache to avoid repeating expensive read-only commands.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} producer
   * @returns {Promise<T>}
   */
  cached(key, producer) {
    if (!this._cache.has(key)) {
      this._cache.set(
        key,
        Promise.resolve()
          .then(producer)
          .catch((err) => {
            this._cache.delete(key);
            throw err;
          })
      );
    }
    return this._cache.get(key);
  }
}

module.exports = { Repo };
