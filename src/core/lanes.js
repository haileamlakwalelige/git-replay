'use strict';

/**
 * Assign each commit (already ordered newest-first, as `git log` returns)
 * to a "lane" and record the edges needed to draw a commit graph.
 *
 * The algorithm walks commits top-to-bottom keeping an array of active
 * lanes. Each lane holds the sha of the commit currently expected to
 * occupy it. When we emit a commit we continue its lane with its first
 * parent and open (or reuse) lanes for additional merge parents.
 *
 * @param {Array<{sha: string, parents: string[]}>} commits newest-first
 * @returns {{lanes: Map<string, number>, edges: object[], maxLane: number}}
 */
function assignLanes(commits) {
  const lane = new Map();          // sha -> lane index
  const edges = [];                // {fromSha, fromLane, toSha, toLane}
  const active = [];               // active[i] = sha | null

  const firstFree = () => {
    const idx = active.indexOf(null);
    return idx === -1 ? active.length : idx;
  };

  for (const commit of commits) {
    let mine = active.indexOf(commit.sha);

    // Collapse duplicate expectations of this commit into one lane.
    for (let i = 0; i < active.length; i += 1) {
      if (i !== mine && active[i] === commit.sha) active[i] = null;
    }

    if (mine === -1) {
      mine = firstFree();
      if (mine === active.length) active.push(commit.sha);
      else active[mine] = commit.sha;
    }

    lane.set(commit.sha, mine);

    const parents = commit.parents || [];
    // First parent continues in this lane.
    active[mine] = parents[0] || null;

    for (let p = 1; p < parents.length; p += 1) {
      const parent = parents[p];
      if (active.includes(parent)) continue;
      const slot = firstFree();
      if (slot === active.length) active.push(parent);
      else active[slot] = parent;
    }

    for (const parent of parents) {
      const parentLane = lane.get(parent);
      edges.push({
        fromSha: commit.sha,
        fromLane: mine,
        toSha: parent,
        toLane: parentLane == null ? mine : parentLane,
      });
    }

    while (active.length && active[active.length - 1] === null) active.pop();
  }

  // Fill in the lane of parents we saw later (newest-first ordering means a
  // parent always appears after its children, so this is a second pass).
  for (const edge of edges) {
    if (lane.has(edge.toSha)) edge.toLane = lane.get(edge.toSha);
  }

  const maxLane = lane.size ? Math.max(...lane.values()) : -1;
  return { lanes: lane, edges, maxLane };
}

/**
 * Convenience: annotate commits in-place with `lane` and return the graph.
 * @param {object[]} commits
 */
function layout(commits) {
  const { lanes, edges, maxLane } = assignLanes(commits);
  const commitsOut = commits.map((c) => ({ ...c, lane: lanes.get(c.sha) || 0 }));
  return { commits: commitsOut, edges, maxLane };
}

module.exports = { assignLanes, layout };
