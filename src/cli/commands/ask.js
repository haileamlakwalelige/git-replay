'use strict';

const { answerQuestion } = require('../../core/evidence');
const { c } = require('../../utils/format');

async function run(ctx) {
  const { repo, flags, positional } = ctx;
  const question = flags.question ? String(flags.question) : positional.join(' ').trim();

  if (!question) {
    ctx.stderr.write(
      c.red('Usage: git-replay ask "why was src/auth.ts deleted?"') + '\n'
    );
    return 2;
  }

  const result = await answerQuestion(repo, question);

  if (flags.json) {
    ctx.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  }

  const out = ctx.stdout;
  out.write('\n' + c.bold('Q: ') + question + '\n\n');
  out.write(result.answer + '\n');

  if (result.evidence && result.evidence.length) {
    out.write('\n' + c.bold('Evidence') + '\n');
    for (const e of result.evidence) {
      if (typeof e === 'string') out.write(c.dim('  ' + e) + '\n');
      else
        out.write(
          `  ${c.green(e.sha || e.short)}  ${c.dim(e.date || '')}  ${e.subject || ''}\n`
        );
    }
  }
  out.write(c.dim(`\nconfidence: ${result.confidence}`) + '\n');
  out.write('\n');
  return 0;
}

module.exports = { run, describe: 'Ask a natural-language question grounded in Git evidence' };
