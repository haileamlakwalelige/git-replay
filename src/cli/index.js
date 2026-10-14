'use strict';

const { Repo } = require('../core/repo');
const { c } = require('../utils/format');

const VALUE_FLAGS = new Set([
  'limit',
  'port',
  'since',
  'until',
  'max-candidates',
  'path',
]);

/**
 * Minimal argument parser. Supports `--flag`, `--flag=value`, `--flag value`
 * (for known value flags), and `--no-flag`.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      let key = token.slice(2);
      let value = true;
      const eq = key.indexOf('=');
      if (eq !== -1) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (VALUE_FLAGS.has(key)) {
        value = argv[i + 1];
        i += 1;
      } else if (key.startsWith('no-')) {
        flags[key.slice(3)] = false;
        continue;
      }
      flags[key] = value;
    } else if (token.startsWith('-') && token.length > 1) {
      const key = token.slice(1);
      if (VALUE_FLAGS.has(key)) {
        flags[key] = argv[i + 1];
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

const COMMANDS = {
  timeline: () => require('./commands/timeline'),
  file: () => require('./commands/file'),
  compare: () => require('./commands/compare'),
  explain: () => require('./commands/explain'),
  branches: () => require('./commands/branches'),
  regressions: () => require('./commands/regressions'),
  ask: () => require('./commands/ask'),
  serve: () => require('./commands/serve'),
  help: () => require('./commands/help'),
};

const ALIASES = {
  log: 'timeline',
  history: 'timeline',
  show: 'explain',
  diff: 'compare',
  'bug-introducing': 'regressions',
  blame: 'regressions',
};

/**
 * Run the CLI.
 * @param {string[]} argv  process.argv.slice(2)
 */
async function main(argv = process.argv.slice(2)) {
  let { positional, flags } = parseArgs(argv);
  let commandName = positional.shift();

  if (flags.help || flags.h || commandName === 'help') {
    commandName = 'help';
    positional = [];
  }
  if (flags.version || commandName === '--version') {
    // eslint-disable-next-line global-require
    const pkg = require('../../package.json');
    process.stdout.write(pkg.version + '\n');
    return 0;
  }

  if (!commandName) commandName = 'timeline';
  if (ALIASES[commandName]) commandName = ALIASES[commandName];

  if (!COMMANDS[commandName]) {
    process.stderr.write(c.red(`Unknown command: ${commandName}`) + '\n\n');
    await COMMANDS.help().run({ positional: [], flags: {} });
    return 2;
  }

  let repo = null;
  try {
    repo = await Repo.open(process.cwd());
  } catch (err) {
    // `serve` and `help` can run without a repository in some flows, but the
    // collector needs one. `serve` validates lazily per request.
    if (commandName !== 'help' && commandName !== 'serve') {
      process.stderr.write(c.red(err.message) + '\n');
      return 1;
    }
  }

  const ctx = {
    repo,
    positional,
    flags,
    stdout: process.stdout,
    stderr: process.stderr,
  };

  try {
    const mod = COMMANDS[commandName]();
    const code = await mod.run(ctx);
    return typeof code === 'number' ? code : 0;
  } catch (err) {
    process.stderr.write(c.red(`Error: ${err.message}`) + '\n');
    if (process.env.GIT_REPLAY_DEBUG) process.stderr.write(err.stack + '\n');
    return 1;
  }
}

module.exports = { main, parseArgs };
