'use strict';

const { c } = require('../../utils/format');

const HELP = `
${c.bold('git-replay')} — understand the story behind your code

${c.bold('USAGE')}
  git-replay [command] [options]

${c.dim('Note: Git 2.42+ ships an experimental builtin named `git replay`, so use the')}
${c.dim('`git-replay` executable directly. On older Git, `git replay` also works.')}

${c.bold('COMMANDS')}
  timeline [rev]            Chronological timeline, story events and graph lanes
  file <path>               Trace a file's history (renames followed)
  compare <a>..<b>          Summarise the diff between two revisions
  explain <rev>             Explain a commit from grounded Git evidence
  regressions [range]       Scan fix commits for likely bug-introducing commits
  ask "<question>"          Answer a question using collected Git evidence
  branches                  List branches, remotes and tags
  serve                     Start the local interactive web UI
  help                      Show this help

${c.bold('OPTIONS')}
  --all                     Include all refs (default for timeline)
  --first-parent            Follow only the first parent
  --limit <n>               Limit commits / rows
  --path <p>                Restrict to a path
  --json                    Machine-readable output
  --no-color                Disable ANSI colours

${c.bold('EXPLAIN / ASK')}
  --regressions             Also run the heuristic regression scan
  --ai                      Ask the configured AI provider (opt-in)
  --max-candidates <n>      Candidate cap for the regression scan

${c.bold('SERVE')}
  --port <n>                Port (default 4173)
  --host <addr>             Bind address (default 127.0.0.1)
  --no-open                 Do not open a browser

${c.bold('AI (optional, disabled by default)')}
  Set ${c.cyan('GIT_REPLAY_AI=ollama')} to enable. Uses ${c.cyan('OLLAMA_HOST')} (default
  http://127.0.0.1:11434) and ${c.cyan('OLLAMA_MODEL')} (default llama3.1). The timeline and
  file history work fully offline; AI is an enhancement, never a requirement.

${c.bold('EXAMPLES')}
  git-replay
  git-replay timeline --limit 50
  git-replay file src/auth.js
  git-replay compare HEAD~10..HEAD
  git-replay explain HEAD
  git-replay ask "why was the payment module removed?"
  git-replay serve --port 4173
`;

async function run(ctx) {
  ctx.stdout.write(HELP + '\n');
  return 0;
}

module.exports = { run, describe: 'Show help' };
