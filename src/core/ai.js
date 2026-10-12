'use strict';

/**
 * Optional, opt-in AI layer. Disabled unless GIT_REPLAY_AI is set.
 * Only ever sends the already-collected Git evidence, never the working tree.
 */

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1';

function provider() {
  const value = (process.env.GIT_REPLAY_AI || '').toLowerCase();
  if (value === 'ollama') return 'ollama';
  return null;
}

function isEnabled() {
  return provider() !== null;
}

function status() {
  return {
    enabled: isEnabled(),
    provider: provider(),
    model: provider() === 'ollama' ? OLLAMA_MODEL : null,
    host: provider() === 'ollama' ? OLLAMA_HOST : null,
  };
}

const SYSTEM_PROMPT =
  'You are Git Replay, a git-history explainer. You must ONLY use the supplied ' +
  'Git evidence. Never invent commits, files, authors, or reasons. If the evidence ' +
  'does not contain an explanation for why a change was made, say so explicitly and ' +
  'distinguish what changed from why it changed. Cite commits by their short sha. ' +
  'Be concise and factual.';

/**
 * Ask the local model to summarise a bundle of evidence.
 * @param {object} payload  structured evidence
 * @param {string} [question]
 * @returns {Promise<{text: string, provider: string, model: string}>}
 */
async function explain(payload, question) {
  const p = provider();
  if (!p) {
    const err = new Error('AI is disabled. Set GIT_REPLAY_AI=ollama to enable.');
    err.code = 'EAIDISABLED';
    throw err;
  }
  if (p === 'ollama') return ollamaExplain(payload, question);
  throw new Error(`Unknown AI provider: ${p}`);
}

async function ollamaExplain(payload, question) {
  const prompt = [
    question ? `Question: ${question}` : 'Explain the following change.',
    '',
    'Git evidence (JSON):',
    JSON.stringify(payload, null, 2),
  ].join('\n');

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      system: SYSTEM_PROMPT,
      prompt,
      stream: false,
      options: { temperature: 0.2 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return { text: (data.response || '').trim(), provider: 'ollama', model: OLLAMA_MODEL };
}

module.exports = { isEnabled, status, explain, provider };
