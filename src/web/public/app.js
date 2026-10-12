'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const RH = 48;
const LANE_W = 22;
const PAD = 16;

const state = {
  repo: null,
  timeline: null,
  selected: null,
  filter: '',
  static: false,
  demo: null,
  laneColors: new Map(),
};

const KIND_GLYPH = {
  merge: '◆', revert: '↩', reverted: '✕', reintroduced: '↻', dependency: '⬡', root: '⚑',
};
const KIND_COLOR = {
  merge: '#bc8cff', revert: '#e3b341', reverted: '#ff7b72', reintroduced: '#56d364',
  dependency: '#79c0ff', root: '#79c0ff', tag: '#e3b341',
};

function laneColor(lane) {
  if (!state.laneColors.has(lane)) {
    const hue = (lane * 47 + 168) % 360;
    state.laneColors.set(lane, `hsl(${hue}, 62%, 62%)`);
  }
  return state.laneColors.get(lane);
}

function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function staticNotice(feature) {
  return `<div class="muted small">${feature} needs the live Git Replay server — run <code>git-replay serve</code> in any repository, or read the <a href="https://github.com/haileamlakwalelige/git-replay" target="_blank" rel="noreferrer">README</a>.</div>`;
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

async function apiPost(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

/* ---------------- bootstrap ---------------- */

async function init() {
  wireTabs();
  wireTimelineControls();
  wireFile();
  wireCompare();
  wireRegressions();
  wireAsk();

  try {
    state.repo = await api('/api/repo');
  } catch (err) {
    if (window.GIT_REPLAY_DEMO) {
      state.static = true;
      state.repo = window.GIT_REPLAY_DEMO.repo;
      state.demo = window.GIT_REPLAY_DEMO;
    } else {
      $('#repo-name').textContent = 'no backend / no demo data';
      $('#ai-badge').textContent = 'offline';
      return;
    }
  }

  $('#repo-name').textContent = `${state.repo.name} · ${state.repo.branch || 'detached'}`;
  renderStatPills();
  renderAiBadge(state.repo.ai);
  if (state.static) {
    $('#tl-all').disabled = true;
    $('#tl-first-parent').disabled = true;
    $('#tl-limit').disabled = true;
    $('#tl-filter').placeholder = 'Filter the embedded demo timeline…';
  }

  await loadTimeline();
}

function renderStatPills() {
  const r = state.repo;
  const pills = [
    ['branches', r.branchCount],
    ['tags', r.tagCount],
  ];
  $('#stat-pills').innerHTML = pills
    .map(([k, v]) => `<span class="pill">${k} <b>${v}</b></span>`)
    .join('');
}

function renderAiBadge(ai) {
  const badge = $('#ai-badge');
  if (ai && ai.enabled) {
    badge.textContent = `AI: ${ai.provider}`;
    badge.classList.add('on');
  } else {
    badge.textContent = 'AI off';
  }
}

/* ---------------- timeline ---------------- */

async function loadTimeline() {
  if (state.static) {
    const demo = state.demo.timeline;
    const limit = Number($('#tl-limit').value) || demo.commits.length;
    state.timeline = { ...demo, commits: demo.commits.slice(0, limit) };
    state.selected = null;
    state.laneColors.clear();
    renderTimeline();
    return;
  }

  const limit = $('#tl-limit').value;
  const all = $('#tl-all').checked;
  const firstParent = $('#tl-first-parent').checked;
  const params = new URLSearchParams({ limit, all: String(all) });
  if (firstParent) params.set('firstParent', 'true');
  state.timeline = await api('/api/timeline?' + params.toString());
  state.selected = null;
  state.laneColors.clear();
  renderTimeline();
}

function visibleCommits() {
  if (!state.timeline) return [];
  const q = state.filter.trim().toLowerCase();
  if (!q) return state.timeline.commits;
  return state.timeline.commits.filter((c) =>
    c.subject.toLowerCase().includes(q) ||
    c.authorName.toLowerCase().includes(q) ||
    c.short.includes(q) ||
    c.sha.startsWith(q)
  );
}

function renderTimeline() {
  renderStory();
  renderCommitList();
  renderGraph();
}

function renderStory() {
  const events = (state.timeline.events || []).slice(0, 14);
  const strip = $('#story-strip');
  if (!events.length) { strip.innerHTML = ''; return; }
  strip.innerHTML = events.map((e) => {
    const color = KIND_COLOR[e.type] || '#8b98ac';
    const glyph = KIND_GLYPH[e.type] || '•';
    return `<div class="story-card" data-sha="${esc(e.sha)}">
      <div class="sc-top">
        <span class="sc-glyph" style="color:${color}">${glyph}</span>
        <span class="sc-title">${esc(e.title)}</span>
        <span class="sc-date">${esc((e.date || '').slice(0, 10))}</span>
      </div>
      <div class="sc-detail">${esc(e.detail || '')}</div>
      <div class="sc-sha">${esc(e.short || '')}</div>
    </div>`;
  }).join('');
  $$('.story-card', strip).forEach((card) => {
    card.addEventListener('click', () => selectCommit(card.dataset.sha));
  });
}

function kindChips(commit) {
  const order = ['reintroduced', 'revert', 'reverted', 'merge', 'dependency', 'root'];
  return order
    .filter((k) => commit.kinds.includes(k))
    .map((k) => `<span class="kind-chip kind-${k}">${k}</span>`)
    .join('');
}

function renderCommitList() {
  const commits = visibleCommits();
  const graphWidth = graphWidthFor();
  const container = $('#commit-list');
  container.style.paddingLeft = graphWidth + 'px';
  container.innerHTML = commits.map((c) => {
    const refs = (c.refs || []).map((r) => `<span class="ref-chip">${esc(r)}</span>`).join('');
    const selected = c.sha === state.selected ? ' selected' : '';
    return `<div class="commit-row${selected}" data-sha="${esc(c.sha)}" style="height:${RH}px">
      <div class="commit-meta">
        <span class="sha">${esc(c.short)}</span>
        ${kindChips(c)}
        <span class="subject">${esc(c.subject)}</span>
        ${refs}
      </div>
      <span class="who">${esc(c.authorName)}</span>
      <span class="when">${esc((c.committerDate || '').slice(0, 10))}</span>
    </div>`;
  }).join('');
}

function graphWidthFor() {
  const lanes = (state.timeline && state.timeline.maxLane != null ? state.timeline.maxLane : 0) + 1;
  return PAD * 2 + Math.max(1, lanes) * LANE_W;
}

function renderGraph() {
  const commits = visibleCommits();
  const svg = $('#graph');
  const rowIndex = new Map(commits.map((c, i) => [c.sha, i]));
  const width = graphWidthFor();
  const height = Math.max(commits.length * RH, 10);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const x = (lane) => PAD + lane * LANE_W;
  const y = (row) => row * RH + RH / 2;

  let edges = '';
  for (const edge of state.timeline.edges || []) {
    if (!rowIndex.has(edge.fromSha) || !rowIndex.has(edge.toSha)) continue;
    const x1 = x(edge.fromLane);
    const y1 = y(rowIndex.get(edge.fromSha));
    const x2 = x(edge.toLane);
    const y2 = y(rowIndex.get(edge.toSha));
    const color = laneColor(edge.fromLane);
    let d;
    if (x1 === x2) {
      d = `M ${x1} ${y1} L ${x2} ${y2}`;
    } else {
      const dy = Math.min(46, Math.abs(y2 - y1) / 2) || 12;
      d = `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
    }
    edges += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-opacity="0.85"/>`;
  }

  let nodes = '';
  for (const c of commits) {
    const row = rowIndex.get(c.sha);
    const cx = x(c.lane);
    const cy = y(row);
    const color = laneColor(c.lane);
    const r = c.isMerge ? 5.5 : 4.5;
    const fill = c.isMerge ? '#0b0e14' : color;
    nodes += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${color}" stroke-width="2"/>`;
    if (c.sha === state.selected) {
      nodes += `<circle cx="${cx}" cy="${cy}" r="${r + 4}" fill="none" stroke="#2dd4bf" stroke-width="2" stroke-opacity="0.9"/>`;
    }
  }

  svg.innerHTML = edges + nodes;
}

function wireTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const name = tab.dataset.tab;
      $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
      if (name === 'branches' && !state.branchesLoaded) loadBranches();
    });
  });
}

function wireTimelineControls() {
  $('#tl-filter').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderCommitList();
    renderGraph();
  });
  $('#tl-all').addEventListener('change', loadTimeline);
  $('#tl-first-parent').addEventListener('change', loadTimeline);
  $('#tl-limit').addEventListener('change', loadTimeline);
  $('#commit-list').addEventListener('click', (e) => {
    const row = e.target.closest('.commit-row');
    if (row) selectCommit(row.dataset.sha);
  });
}

/* ---------------- inspector ---------------- */

async function selectCommit(sha) {
  state.selected = sha;
  renderCommitList();
  renderGraph();

  const inspector = $('#inspector');
  inspector.innerHTML = `<div class="empty-state"><span class="spinner"></span> Loading commit…</div>`;

  if (state.static) {
    const ev = state.demo && state.demo.commits[sha];
    if (ev) {
      renderInspector(ev);
    } else {
      inspector.innerHTML = `<div class="empty-state">No embedded detail for this commit.</div>`;
    }
    return;
  }

  try {
    const ev = await api('/api/commit/' + encodeURIComponent(sha));
    renderInspector(ev);
  } catch (err) {
    inspector.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

function renderInspector(ev) {
  const { commit, classification } = ev;
  const chips = [];
  if (classification.isMerge) chips.push('<span class="kind-chip kind-merge">merge</span>');
  if (classification.isRevert) chips.push('<span class="kind-chip kind-revert">revert</span>');

  let html = `
    <div class="insp-head">
      <div style="display:flex;align-items:center;gap:8px">
        <span class="sha">${esc(commit.short)}</span>
        ${chips.join('')}
      </div>
      <div class="insp-subject">${esc(commit.subject)}</div>
      <div class="insp-meta">
        <span>${esc(commit.authorName)}</span>
        <span>${esc((commit.authorDate || '').slice(0, 16).replace('T', ' '))}</span>
        <span>${commit.files.length} file(s)</span>
      </div>
    </div>`;

  html += `<div class="btn-row">
    <button class="btn" id="btn-reg">Find origin (SZZ)</button>
    <button class="btn" id="btn-ai" ${state.repo && state.repo.ai && state.repo.ai.enabled ? '' : 'disabled'}>AI explain</button>
  </div>`;

  if (commit.body) html += `<div class="insp-body">${esc(commit.body)}</div>`;

  if (commit.files && commit.files.length) {
    html += `<div class="insp-section"><h4>Files changed</h4>` +
      commit.files.slice(0, 80).map((f) => {
        const label = f.from ? `${esc(f.from)} → ${esc(f.path)}` : esc(f.path);
        return `<div class="file-row"><span class="st st-${esc(f.status)}">${esc(f.status)}</span><span class="p">${label}</span></div>`;
      }).join('') + `</div>`;
  }

  if (ev.dependency) {
    html += `<div class="insp-section"><h4>Dependency changes</h4>`;
    for (const manifest of ev.dependency.manifests) {
      html += `<div class="muted small" style="margin-bottom:6px">${esc(manifest.path)}</div>`;
      for (const change of manifest.changes.slice(0, 40)) {
        if (change.type === 'lines') {
          html += `<div class="dep-row">+${change.added} / -${change.removed} lines</div>`;
          change.sampleAdded.forEach((l) => { html += `<div class="dep-row"><span class="add">+ ${esc(l)}</span></div>`; });
          change.sampleRemoved.forEach((l) => { html += `<div class="dep-row"><span class="del">- ${esc(l)}</span></div>`; });
        } else {
          const cls = change.type === 'added' ? 'add' : change.type === 'removed' ? 'del' : 'chg';
          const v = change.from && change.to ? `${change.from} → ${change.to}` : (change.from || change.to);
          html += `<div class="dep-row"><span class="${cls}">${change.type}</span> ${esc(change.name)} <span class="muted">${esc(v)}</span></div>`;
        }
      }
    }
    html += `</div>`;
  }

  if (ev.related.reverts) {
    html += `<div class="insp-section"><h4>Reverts</h4><div class="muted small">This commit undoes <span class="c-sha">${esc(ev.related.reverts.short)}</span> — ${esc(ev.related.reverts.subject)}</div></div>`;
  }
  if (ev.related.revertedBy) {
    html += `<div class="insp-section"><h4>Later reverted by</h4>` +
      ev.related.revertedBy.map((r) => `<div class="muted small"><span class="c-sha">${esc(r.short)}</span> ${esc(r.subject)}</div>`).join('') +
      `</div>`;
  }
  if (ev.related.broughtIn) {
    html += `<div class="insp-section"><h4>Merge brought in ${ev.related.broughtIn.count} commit(s)</h4>` +
      ev.related.broughtIn.sample.map((l) => `<div class="muted small" style="font-family:var(--mono)">${esc(l)}</div>`).join('') +
      `</div>`;
  }

  if (commit.diff) {
    html += `<div class="insp-section"><h4>Diff</h4><div class="diff">${renderDiff(commit.diff)}</div></div>`;
  }

  const inspector = $('#inspector');
  inspector.innerHTML = html;

  const regBtn = $('#btn-reg');
  if (regBtn) regBtn.addEventListener('click', () => runRegressionFor(commit.sha));
  const aiBtn = $('#btn-ai');
  if (aiBtn && !aiBtn.disabled) aiBtn.addEventListener('click', () => runAiExplain(commit.sha));
}

function renderDiff(diff) {
  const lines = diff.split('\n');
  let out = '';
  let shown = 0;
  for (const line of lines) {
    if (shown > 1500) { out += `<span class="meta">… diff truncated …</span>`; break; }
    if (line.startsWith('@@')) out += `<span class="hunk">${esc(line)}</span>`;
    else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) out += `<span class="meta">${esc(line)}</span>`;
    else if (line.startsWith('+')) out += `<span class="add">${esc(line)}</span>`;
    else if (line.startsWith('-')) out += `<span class="del">${esc(line)}</span>`;
    else out += `<span>${esc(line)}</span>`;
    shown += 1;
  }
  return out;
}

async function runRegressionFor(sha) {
  const section = document.createElement('div');
  section.className = 'insp-section';
  section.innerHTML = `<h4>Likely bug-introducing commits (SZZ)</h4><span class="spinner"></span>`;
  $('#inspector').appendChild(section);
  if (state.static) {
    section.innerHTML = `<h4>Likely bug-introducing commits (SZZ)</h4><div class="muted small">Available in the live server — run <code>git-replay serve</code>.</div>`;
    return;
  }
  try {
    const data = await api('/api/regressions?since=' + encodeURIComponent(sha + '~1') + '&limit=1&fixes=1&maxCandidates=6');
    const candidates = (data.findings[0] && data.findings[0].candidates) || [];
    if (!candidates.length) {
      section.innerHTML = `<h4>Likely bug-introducing commits (SZZ)</h4><div class="muted small">No candidates found via blame of the removed lines.</div>`;
      return;
    }
    section.innerHTML = `<h4>Likely bug-introducing commits (SZZ)</h4><ul class="candidates">` +
      candidates.map((c) => `<li><span class="c-sha">${esc(c.short)}</span> ${esc(c.subject)}<div class="muted small">${c.lines} line(s) · ${esc(c.authorName)}</div></li>`).join('') +
      `</ul><div class="muted small">Heuristic only. Verify before trusting.</div>`;
  } catch (err) {
    section.innerHTML = `<h4>Likely bug-introducing commits</h4><div class="muted small">${esc(err.message)}</div>`;
  }
}

async function runAiExplain(sha) {
  const section = document.createElement('div');
  section.className = 'insp-section';
  section.innerHTML = `<h4>AI explanation</h4><span class="spinner"></span>`;
  $('#inspector').appendChild(section);
  try {
    const result = await apiPost('/api/ai/explain', { sha });
    section.innerHTML = `<h4>AI explanation</h4><div class="ai">${esc(result.text)}</div>`;
  } catch (err) {
    section.innerHTML = `<h4>AI explanation</h4><div class="muted small">${esc(err.message)}</div>`;
  }
}

/* ---------------- branches ---------------- */

async function loadBranches() {
  const body = $('#branches-body');
  body.innerHTML = `<span class="spinner"></span>`;

  let refs;
  if (state.static) {
    refs = state.demo.timeline.refs;
    state.branchesLoaded = true;
  } else {
    try {
      refs = await api('/api/branches');
      state.branchesLoaded = true;
    } catch (err) {
      body.innerHTML = `<div class="muted">${esc(err.message)}</div>`;
      return;
    }
  }

  const locals = refs.branches.filter((b) => b.kind === 'local');
  const remotes = refs.branches.filter((b) => b.kind === 'remote');
  let html = `<h3 class="sec-title">Local branches · default ${esc(refs.defaultBranch || '?')}</h3>`;
  html += `<table class="ref-table"><thead><tr><th>branch</th><th>sha</th><th>date</th><th>subject</th></tr></thead><tbody>`;
  for (const b of locals) {
    html += `<tr><td class="bname">${esc(b.name)}${refs.head === b.name ? ' <span class="ahead">*</span>' : ''}</td><td>${esc(b.sha.slice(0, 8))}</td><td>${esc((b.date || '').slice(0, 10))}</td><td>${esc(b.subject)}</td></tr>`;
  }
  html += `</tbody></table>`;
  if (remotes.length) {
    html += `<h3 class="sec-title">Remotes</h3><table class="ref-table"><tbody>`;
    for (const b of remotes) html += `<tr><td class="bname">${esc(b.name)}</td><td>${esc(b.sha.slice(0, 8))}</td><td>${esc((b.date || '').slice(0, 10))}</td><td>${esc(b.subject)}</td></tr>`;
    html += `</tbody></table>`;
  }
  if (refs.tags.length) {
    html += `<h3 class="sec-title">Tags</h3><table class="ref-table"><tbody>`;
    for (const t of refs.tags) html += `<tr><td class="bname">${esc(t.name)}</td><td>${esc(t.sha.slice(0, 8))}</td><td>${esc((t.date || '').slice(0, 10))}</td><td>${esc(t.subject)}</td></tr>`;
    html += `</tbody></table>`;
  }
  body.innerHTML = html;
}

/* ---------------- file ---------------- */

function wireFile() {
  const go = () => {
    const p = $('#file-input').value.trim();
    if (p) loadFile(p);
  };
  $('#file-go').addEventListener('click', go);
  $('#file-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

async function loadFile(path) {
  const body = $('#file-body');
  if (state.static) {
    body.innerHTML = staticNotice('File history');
    return;
  }
  body.innerHTML = `<span class="spinner"></span>`;
  try {
    const ev = await api('/api/file?path=' + encodeURIComponent(path));
    if (!ev.history.length) {
      body.innerHTML = `<div class="muted">No history found for <code>${esc(path)}</code>.</div>`;
      return;
    }
    let html = `<div class="pill" style="display:inline-block;margin-bottom:14px">${ev.exists ? 'exists at HEAD' : 'deleted'} · ${ev.history.length} commit(s) · ${ev.authors.length} author(s)</div>`;
    html += `<table class="ref-table"><thead><tr><th>sha</th><th>date</th><th>status</th><th>subject</th><th>author</th></tr></thead><tbody>`;
    for (const h of ev.history.slice(0, 200)) {
      const st = (h.statuses && h.statuses[0] && h.statuses[0].status) || '';
      html += `<tr><td>${esc(h.short)}</td><td>${esc((h.committerDate || '').slice(0, 10))}</td><td class="st-${esc(st)}">${esc(st)}</td><td>${esc(h.subject)}</td><td>${esc(h.authorName)}</td></tr>`;
    }
    html += `</tbody></table>`;
    body.innerHTML = html;
  } catch (err) {
    body.innerHTML = `<div class="muted">${esc(err.message)}</div>`;
  }
}

/* ---------------- compare ---------------- */

function wireCompare() {
  const go = () => {
    const r = $('#compare-input').value.trim();
    if (r) loadCompare(r);
  };
  $('#compare-go').addEventListener('click', go);
  $('#compare-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

async function loadCompare(range) {
  const body = $('#compare-body');
  if (state.static) {
    body.innerHTML = staticNotice('Compare');
    return;
  }
  body.innerHTML = `<span class="spinner"></span>`;
  try {
    const ev = await api('/api/compare?range=' + encodeURIComponent(range));
    let html = `<div class="pill" style="display:inline-block;margin-bottom:14px">${ev.summary.files} file(s) · +${ev.summary.insertions} / -${ev.summary.deletions}</div>`;
    html += `<table class="ref-table"><thead><tr><th>+</th><th>-</th><th>path</th></tr></thead><tbody>`;
    for (const f of ev.files) {
      html += `<tr><td class="ahead">${f.binary ? 'bin' : '+' + f.added}</td><td class="behind">${f.binary ? '' : '-' + f.removed}</td><td>${esc(f.path)}</td></tr>`;
    }
    html += `</tbody></table>`;
    if (ev.fixCommits.length) {
      html += `<h3 class="sec-title">Fix-shaped commits</h3>`;
      for (const l of ev.fixCommits) html += `<div class="muted small" style="font-family:var(--mono)">${esc(l)}</div>`;
    }
    body.innerHTML = html;
  } catch (err) {
    body.innerHTML = `<div class="muted">${esc(err.message)}</div>`;
  }
}

/* ---------------- regressions ---------------- */

function wireRegressions() {
  $('#reg-go').addEventListener('click', () => loadRegressions($('#reg-input').value.trim()));
}

async function loadRegressions(range) {
  const body = $('#reg-body');
  if (state.static) {
    body.innerHTML = staticNotice('Regression (SZZ) analysis');
    return;
  }
  body.innerHTML = `<span class="spinner"></span> Scanning fix commits and blaming removed lines…`;
  try {
    const params = new URLSearchParams({ limit: '80', fixes: '10', maxCandidates: '4' });
    if (range) params.set('since', range);
    const data = await api('/api/regressions?' + params.toString());
    if (!data.ranked.length) {
      body.innerHTML = `<div class="muted">No candidates identified. This heuristic can miss cases.</div>`;
      return;
    }
    let html = `<div class="pill" style="display:inline-block;margin-bottom:14px">scanned ${data.scanned} · analysed ${data.fixes} fix commits</div>`;
    html += `<table class="ref-table"><thead><tr><th>sha</th><th>hits</th><th>date</th><th>subject</th><th>author</th></tr></thead><tbody>`;
    for (const c of data.ranked) {
      html += `<tr><td class="ahead">${esc(c.short)}</td><td>${c.hits}</td><td>${esc((c.authorDate || '').slice(0, 10))}</td><td>${esc(c.subject)}</td><td>${esc(c.authorName)}</td></tr>`;
    }
    html += `</tbody></table>`;
    html += `<h3 class="sec-title">Evidence</h3>`;
    for (const f of data.findings) {
      html += `<div class="muted small" style="margin-top:8px">fix <span class="c-sha">${esc(f.fix.short)}</span> ${esc(f.fix.subject)}</div>`;
      for (const c of f.candidates) {
        html += `<div class="muted small" style="font-family:var(--mono);padding-left:14px">← ${esc(c.short)} (${c.lines} line${c.lines === 1 ? '' : 's'}): ${esc(c.subject)}</div>`;
      }
    }
    html += `<p class="muted small" style="margin-top:14px">Heuristic only. Blame of the lines a fix removed; verify each candidate.</p>`;
    body.innerHTML = html;
  } catch (err) {
    body.innerHTML = `<div class="muted">${esc(err.message)}</div>`;
  }
}

/* ---------------- ask ---------------- */

function wireAsk() {
  $('#ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#ask-input').value.trim();
    if (q) ask(q);
  });
  $$('.chip').forEach((chip) => {
    chip.addEventListener('click', () => ask(chip.dataset.q));
  });
}

async function ask(question) {
  const log = $('#ask-log');

  if (state.static) {
    const note = document.createElement('div');
    note.className = 'msg';
    note.innerHTML = `<div class="q">${esc(question)}</div><div class="a muted small">Static demo mode — Ask needs the live server. Run <code>git-replay serve</code> locally to use it.</div>`;
    log.appendChild(note);
    log.scrollTop = log.scrollHeight;
    $('#ask-input').value = '';
    return;
  }

  const hint = $('.ask-hint', log);
  if (hint) hint.remove();

  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.innerHTML = `<div class="q">${esc(question)}</div><div class="a"><span class="spinner"></span></div>`;
  log.appendChild(msg);
  log.scrollTop = log.scrollHeight;
  $('#ask-input').value = '';

  try {
    const result = await api('/api/ask?q=' + encodeURIComponent(question));
    let html = `<div>${esc(result.answer)}</div>`;
    if (result.evidence && result.evidence.length) {
      html += `<div class="evidence">` + result.evidence.map((e) => {
        if (typeof e === 'string') return `<div class="ev">${esc(e)}</div>`;
        return `<div class="ev"><b>${esc(e.sha || e.short || '')}</b> ${esc(e.subject || '')}</div>`;
      }).join('') + `</div>`;
    }
    html += `<span class="confidence">confidence: ${esc(result.confidence)}</span>`;

    if ($('#ask-ai').checked && state.repo && state.repo.ai && state.repo.ai.enabled) {
      html += `<div class="ai"><span class="spinner"></span></div>`;
    }
    $('.a', msg).innerHTML = html;

    if ($('#ask-ai').checked && state.repo && state.repo.ai && state.repo.ai.enabled) {
      try {
        const aiResult = await apiPost('/api/ai/ask', { question });
        $('.ai', msg).textContent = aiResult.aiText;
      } catch (err) {
        $('.ai', msg).textContent = 'AI error: ' + err.message;
      }
    }
  } catch (err) {
    $('.a', msg).innerHTML = `<span class="muted">${esc(err.message)}</span>`;
  }
  log.scrollTop = log.scrollHeight;
}

init();
