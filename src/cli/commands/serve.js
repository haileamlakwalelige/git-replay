'use strict';

const { createServer } = require('../../web/server');
const { Repo } = require('../../core/repo');
const { c } = require('../../utils/format');

async function run(ctx) {
  const { flags } = ctx;
  const port = flags.port ? Number(flags.port) : 4173;
  const host = flags.host ? String(flags.host) : '127.0.0.1';
  const rootPath = flags.path || process.cwd();

  let repo = ctx.repo;
  if (!repo) {
    try {
      repo = await Repo.open(rootPath);
    } catch (err) {
      ctx.stderr.write(c.red(err.message) + '\n');
      return 1;
    }
  }

  const app = createServer({ repo, root: repo.root });
  const server = app.listen(port, host, () => {
    const url = `http://${host}:${port}/`;
    ctx.stdout.write('\n' + c.bold('Git Replay web') + ' ' + c.cyan(url) + '\n');
    ctx.stdout.write(c.dim('repo: ' + repo.root) + '\n');
    ctx.stdout.write(c.dim('press Ctrl+C to stop') + '\n\n');
    if (flags.open !== false) openBrowser(url);
  });

  server.on('error', (err) => {
    ctx.stderr.write(c.red('Server error: ' + err.message) + '\n');
    process.exitCode = 1;
  });

  await new Promise((resolve) => {
    server.on('close', resolve);
    const shutdown = () => server.close(() => resolve());
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}

function openBrowser(url) {
  const { spawn } = require('node:child_process');
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // opening the browser is best-effort
  }
}

module.exports = { run, describe: 'Start the local interactive web UI' };
