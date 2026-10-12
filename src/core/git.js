'use strict';

const { execFile } = require('node:child_process');

const MAX_BUFFER = 512 * 1024 * 1024;

/**
 * Run a git command and resolve with stdout as a utf8 string.
 * Rejects with an Error that carries `stderr`, `code` and `args`.
 *
 * @param {string[]} args
 * @param {{cwd?: string, input?: string}} [opts]
 * @returns {Promise<string>}
 */
function git(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd: opts.cwd,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = (stderr || '').trim();
          err.args = args;
          return reject(err);
        }
        resolve(stdout);
      }
    );
    if (opts.input != null) {
      child.stdin.end(opts.input);
    }
  });
}

/**
 * Run a git command, splitting stdout into trimmed, non-empty lines.
 * @returns {Promise<string[]>}
 */
async function gitLines(args, opts = {}) {
  const out = await git(args, opts);
  return out
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0);
}

/**
 * Run a git command and capture exit status instead of throwing.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: number}>}
 */
async function gitTry(args, opts = {}) {
  try {
    const stdout = await git(args, opts);
    return { ok: true, stdout, stderr: '', code: 0 };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || '',
      code: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

module.exports = { git, gitLines, gitTry, MAX_BUFFER };
