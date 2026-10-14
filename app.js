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
  branchesLoaded: false,
  laneColors: new Map(),
};

const KIND_GLYPH = {
  merge: '◆', revert: '↩', reverted: '✕', reintroduced: '↻', dependency: '⬡', root: '⚑', tag: '✦',
};
const KIND_COLOR = {
  merge: '#a78bfa', revert: '#fbbf24', reverted: '#fb7185', reintroduced: '#34d399',
  dependency: '#22d3ee', root: '#22d3ee', tag: '#e879f9',
};

/* Lane ramp constrained to the cyan -> blue -> violet -> fuchsia family
   (hues ~160-330). Lanes past the set wrap and shift lightness so branch
   identity stays distinct without drifting off-palette. */
const LANE_HUES = [187, 258, 292, 217, 270, 330, 160, 239];
const LANE_LIGHTS = [62, 70, 54];

function laneColor(lane) {
  if (!state.laneColors.has(lane)) {
    const hue = LANE_HUES[lane % LANE_HUES.length];
    const light = LANE_LIGHTS[Math.floor(lane / LANE_HUES.length) % LANE_LIGHTS.length];
    state.laneColors.set(lane, `hsl(${hue}, 88%, ${light}%)`);
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

/* ---------------- copy buttons ---------------- */

function wireCopy() {
  const btns = $$('[data-copy]');
  btns.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.getAttribute('data-copy') || '';
      let ok = true;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          ok = false;
        }
      } catch (err) {
        ok = false;
      }
      if (!ok) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) { /* ignore */ }
        document.body.removeChild(ta);
      }
      const prev = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = prev;
        btn.classList.remove('copied');
      }, 1600);
    });
  });
}

/* ---------------- bootstrap ---------------- */

async function init() {
  wireNav();
  wireNavFade();
  wireScrollProgress();
  wireDrawer();
  wireTimelineControls();
  wireFile();
  wireCompare();
  wireRegressions();
  wireAsk();
  wireCopy();

  try {
    state.repo = await api('/api/repo');
  } catch (err) {
    if (window.GIT_REPLAY_DEMO) {
      state.static = true;
      state.repo = window.GIT_REPLAY_DEMO.repo;
      state.demo = window.GIT_REPLAY_DEMO;
    } else {
      $('#repo-name').textContent = 'no backend / no demo data';
      return;
    }
  }

  $('#repo-name').textContent = state.repo.name || 'Git Replay';
  renderHeroMeta();
  renderStatTiles();
  if (state.static) {
    $('#tl-all').disabled = true;
    $('#tl-first-parent').disabled = true;
    $('#tl-limit').disabled = true;
    $('#tl-filter').placeholder = 'Filter the embedded demo timeline…';
    const eyebrow = $('#hero-eyebrow');
    if (eyebrow) eyebrow.textContent = 'Git Replay · live demo';
  }

  await loadTimeline();
}

function renderHeroMeta() {
  const el = $('#hero-meta');
  const r = state.repo;
  if (!el || !r) return;
  const bits = [];
  if (r.branch) bits.push(r.branch);
  if (r.headSha) bits.push('@' + r.headSha.slice(0, 7));
  if (!bits.length) return;
  el.textContent = bits.join('  ·  ');
  el.hidden = false;
}

function spanLabel(a, b) {
  if (!a || !b) return null;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (!isFinite(ms) || ms < 0) return null;
  const hours = Math.round(ms / 3.6e6);
  if (hours < 48) return hours + 'h';
  return Math.round(hours / 24) + 'd';
}

function renderStatTiles() {
  const el = $('#stat-tiles');
  if (!el) return;
  const r = state.repo || {};
  const t = state.timeline || (state.demo && state.demo.timeline) || {};
  const stats = t.stats || {};

  const tiles = [];
  const commits = stats.totalCommits != null
    ? stats.totalCommits
    : (t.commits ? t.commits.length : null);
  if (commits != null) tiles.push(['Commits', commits]);
  if (r.branchCount != null) tiles.push(['Branches', r.branchCount]);
  if (r.tagCount != null) tiles.push(['Tags', r.tagCount]);
  if (stats.authors != null) tiles.push(['Contributors', stats.authors]);
  const span = spanLabel(stats.firstDate, stats.lastDate);
  if (span) tiles.push(['Span', span]);
  if (r.headSha) tiles.push(['HEAD', r.headSha.slice(0, 7), 'wide']);

  el.innerHTML = tiles.map(([label, value, mod]) =>
    `<div class="stat-tile${mod ? ' stat-tile--' + mod : ''}">
      <span class="stat-value">${esc(value)}</span>
      <span class="stat-label">${esc(label)}</span>
    </div>`
  ).join('');
}

/* ---------------- navigation / scroll-spy ---------------- */

function wireNav() {
  const navEl = $('#section-nav');
  const links = $$('#section-nav a');
  const byId = new Map(links.map((a) => [a.dataset.nav, a]));
  const sections = links
    .map((a) => document.getElementById(a.dataset.nav))
    .filter(Boolean);
  let current = 'overview';

  const setActive = (id) => {
    if (!byId.has(id) || id === current) return;
    current = id;
    links.forEach((a) => {
      const on = a.dataset.nav === id;
      a.classList.toggle('active', on);
      if (on) {
        a.setAttribute('aria-current', 'true');
        revealNavLink(navEl, a);
      } else {
        a.removeAttribute('aria-current');
      }
    });
    if (id === 'branches' && !state.branchesLoaded) loadBranches();
  };

  links.forEach((a) => a.addEventListener('click', () => setActive(a.dataset.nav)));

  if ('IntersectionObserver' in window) {
    const visible = new Set();
    const order = sections.map((s) => s.id);
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) visible.add(e.target.id);
        else visible.delete(e.target.id);
      });
      const active = order.find((id) => visible.has(id));
      if (active) setActive(active);
    }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 });
    sections.forEach((s) => obs.observe(s));
  }
}

function revealNavLink(nav, link) {
  if (!nav || nav.scrollWidth <= nav.clientWidth + 1) return;
  const target = link.offsetLeft - (nav.clientWidth - link.offsetWidth) / 2;
  const left = Math.max(0, Math.min(target, nav.scrollWidth - nav.clientWidth));
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  nav.scrollTo({ left, behavior: reduce ? 'auto' : 'smooth' });
}

function wireNavFade() {
  const nav = $('#section-nav');
  if (!nav) return;
  const update = () => {
    const canScroll = nav.scrollWidth > nav.clientWidth + 1;
    const atStart = nav.scrollLeft <= 1;
    const atEnd = nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 1;
    nav.classList.toggle('nav-fade-left', canScroll && !atStart);
    nav.classList.toggle('nav-fade-right', canScroll && !atEnd);
  };
  nav.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(update);
  update();
  setTimeout(update, 400);
}

function wireScrollProgress() {
  const bar = $('#scroll-progress');
  const update = () => {
    const doc = document.documentElement;
    const max = doc.scrollHeight - doc.clientHeight;
    const p = max > 0 ? doc.scrollTop / max : 0;
    if (bar) bar.style.transform = `scaleX(${Math.min(1, Math.max(0, p))})`;
  };
  document.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
}

/* ---------------- inspector drawer ---------------- */

const DRAWER_BG = ['.site-header', '.page', '.site-footer'];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let lastFocused = null;

function setBackgroundInert(on) {
  for (const sel of DRAWER_BG) {
    const el = $(sel);
    if (!el) continue;
    if (on) {
      el.setAttribute('inert', '');
      el.setAttribute('aria-hidden', 'true');
    } else {
      el.removeAttribute('inert');
      el.removeAttribute('aria-hidden');
    }
  }
}

function drawerFocusables() {
  const inspector = $('#inspector');
  const close = $('#insp-close');
  const nodes = inspector ? $$(FOCUSABLE, inspector) : [];
  if (close) nodes.push(close);
  return nodes.filter((el) => el === close || el.offsetParent !== null);
}

function openDrawer() {
  if (document.body.classList.contains('drawer-open')) return;
  lastFocused = document.activeElement;
  document.body.classList.add('drawer-open');
  setBackgroundInert(true);
  const close = $('#insp-close');
  if (close) close.focus({ preventScroll: true });
}

function closeDrawer() {
  if (!document.body.classList.contains('drawer-open')) return;
  document.body.classList.remove('drawer-open');
  setBackgroundInert(false);
  const back = lastFocused;
  lastFocused = null;
  if (back && typeof back.focus === 'function' && document.contains(back)) {
    back.focus({ preventScroll: true });
  }
}

function wireDrawer() {
  const close = $('#insp-close');
  const scrim = $('#insp-scrim');
  if (close) close.addEventListener('click', closeDrawer);
  if (scrim) scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (!document.body.classList.contains('drawer-open')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
    if (e.key !== 'Tab') return;
    const nodes = drawerFocusables();
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    const inside = nodes.includes(active);
    if (e.shiftKey) {
      if (!inside || active === first) { e.preventDefault(); last.focus(); }
    } else if (!inside || active === last) {
      e.preventDefault(); first.focus();
    }
  });
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
  renderStatTiles();
}

function renderStory() {
  const events = ((state.timeline && state.timeline.events) || []).slice(0, 14);
  const feed = $('#story-strip');
  if (!feed) return;
  if (!events.length) { feed.innerHTML = ''; return; }
  feed.innerHTML = events.map((e, i) => {
    const color = KIND_COLOR[e.type] || '#94a3b8';
    const glyph = KIND_GLYPH[e.type] || '•';
    return `<article class="story-card" data-sha="${esc(e.sha)}" role="button" tabindex="0" style="--i:${i}">
      <span class="sc-node" style="color:${color}" aria-hidden="true">${glyph}</span>
      <div class="sc-body">
        <div class="sc-top">
          <span class="sc-kind kind-${esc(e.type)}">${esc(e.type)}</span>
          <span class="sc-sha">${esc(e.short || '')}</span>
          <span class="sc-date">${esc((e.date || '').slice(0, 10))}</span>
        </div>
        <h3 class="sc-title">${esc(e.title)}</h3>
        <p class="sc-detail">${esc(e.detail || '')}</p>
      </div>
    </article>`;
  }).join('');
  $$('.story-card', feed).forEach((card) => {
    const go = () => selectCommit(card.dataset.sha);
    card.addEventListener('click', go);
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); }
    });
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
  if (!container) return;
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
  const svg = $('#history-graph');
  if (!svg) return;
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
    const fill = c.isMerge ? '#0a0a1a' : color;
    nodes += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${color}" stroke-width="2"/>`;
    if (c.sha === state.selected) {
      nodes += `<circle cx="${cx}" cy="${cy}" r="${r + 4}" fill="none" stroke="#00d4ff" stroke-width="2" stroke-opacity="0.9"/>`;
    }
  }

  svg.innerHTML = edges + nodes;
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
  openDrawer();

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
  if (!document.body.classList.contains('drawer-open')) openDrawer();

  const regBtn = $('#btn-reg');
  if (regBtn) regBtn.addEventListener('click', () => runRegressionFor(commit.sha));
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
  $('#reg-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadRegressions(e.target.value.trim()); });
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
    $('.a', msg).innerHTML = html;
  } catch (err) {
    $('.a', msg).innerHTML = `<span class="muted">${esc(err.message)}</span>`;
  }
  log.scrollTop = log.scrollHeight;
}

init();
