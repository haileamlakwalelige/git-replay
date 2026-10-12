'use strict';

const path = require('node:path');
const express = require('express');

const { buildTimeline } = require('../core/timeline');
const { collectRefs } = require('../core/collector');
const {
  gatherCommitEvidence,
  gatherFileEvidence,
  gatherCompareEvidence,
  answerQuestion,
} = require('../core/evidence');
const { collectCommits } = require('../core/collector');
const {
  isFixCommit,
  findBugIntroducingCommits,
} = require('../core/analyzer');
const ai = require('../core/ai');

/**
 * Build the Express application serving the API and web UI for one repository.
 * @param {{repo: import('../core/repo').Repo, root: string}} opts
 */
function createServer({ repo, root }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const asyncRoute = (handler) => (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      const status = err.code === 'EBADREV' ? 404 : err.code === 'ENOTREPO' ? 400 : 500;
      res.status(status).json({ error: err.message });
    });
  };

  const api = express.Router();

  api.get('/repo', asyncRoute(async (req, res) => {
    const refs = await collectRefs(repo);
    res.json({
      root,
      name: path.basename(root),
      branch: refs.head,
      defaultBranch: refs.defaultBranch,
      headSha: refs.headSha,
      branchCount: refs.branches.length,
      tagCount: refs.tags.length,
      ai: ai.status(),
    });
  }));

  api.get('/timeline', asyncRoute(async (req, res) => {
    const timeline = await buildTimeline(repo, {
      rev: req.query.rev || 'HEAD',
      all: req.query.all !== 'false',
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      firstParent: req.query.firstParent === 'true',
      path: req.query.path,
    });
    res.json(timeline);
  }));

  api.get('/branches', asyncRoute(async (req, res) => {
    res.json(await collectRefs(repo));
  }));

  api.get('/commit/:sha', asyncRoute(async (req, res) => {
    res.json(await gatherCommitEvidence(repo, req.params.sha));
  }));

  api.get('/file', asyncRoute(async (req, res) => {
    if (!req.query.path) return res.status(400).json({ error: 'path query required' });
    res.json(await gatherFileEvidence(repo, req.query.path, {
      limit: req.query.limit ? Number(req.query.limit) : 200,
    }));
  }));

  api.get('/compare', asyncRoute(async (req, res) => {
    if (!req.query.range) return res.status(400).json({ error: 'range query required' });
    res.json(await gatherCompareEvidence(repo, req.query.range));
  }));

  api.get('/regressions', asyncRoute(async (req, res) => {
    const commits = await collectCommits(repo, {
      rev: req.query.since || 'HEAD',
      limit: req.query.limit ? Number(req.query.limit) : 60,
    });
    const fixes = commits.filter(isFixCommit).slice(0, Number(req.query.fixes) || 8);
    const findings = [];
    const tally = new Map();
    for (const fix of fixes) {
      const result = await findBugIntroducingCommits(repo, fix.sha, {
        maxCandidates: Number(req.query.maxCandidates) || 3,
      });
      if (!result.candidates.length) continue;
      findings.push({
        fix: { sha: fix.sha, short: fix.short, subject: fix.subject, date: fix.committerDate },
        candidates: result.candidates,
      });
      for (const cand of result.candidates) {
        const entry = tally.get(cand.sha) || { ...cand, hits: 0 };
        entry.hits += 1;
        tally.set(cand.sha, entry);
      }
    }
    res.json({
      scanned: commits.length,
      fixes: fixes.length,
      findings,
      ranked: [...tally.values()].sort((a, b) => b.hits - a.hits || b.lines - a.lines),
    });
  }));

  api.get('/ask', asyncRoute(async (req, res) => {
    if (!req.query.q) return res.status(400).json({ error: 'q query required' });
    res.json(await answerQuestion(repo, req.query.q));
  }));

  api.post('/ask', asyncRoute(async (req, res) => {
    const question = req.body && req.body.question;
    if (!question) return res.status(400).json({ error: 'question required' });
    res.json(await answerQuestion(repo, question));
  }));

  api.get('/ai/status', (req, res) => res.json(ai.status()));

  api.post('/ai/ask', asyncRoute(async (req, res) => {
    const { question } = req.body || {};
    if (!question) return res.status(400).json({ error: 'question required' });
    const result = await answerQuestion(repo, question);
    const aiResult = await ai.explain(result, question);
    res.json({ ...result, aiText: aiResult.text });
  }));

  api.post('/ai/explain', asyncRoute(async (req, res) => {
    const { sha, question } = req.body || {};
    if (!sha) return res.status(400).json({ error: 'sha required' });
    const evidence = await gatherCommitEvidence(repo, sha);
    const payload = {
      sha: evidence.sha,
      subject: evidence.commit.subject,
      body: evidence.commit.body,
      author: evidence.commit.authorName,
      date: evidence.commit.authorDate,
      files: evidence.commit.files,
      classification: evidence.classification,
      dependency: evidence.dependency,
      related: evidence.related,
    };
    const result = await ai.explain(payload, question);
    res.json(result);
  }));

  app.use('/api', api);

  app.use(express.static(path.join(__dirname, 'public')));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err.message });
  });

  return app;
}

module.exports = { createServer };
