# Git Replay

**Understand the story behind your code.**

Git Replay turns a repository's Git history into a readable timeline, an interactive
graph, and evidence-grounded explanations. It helps you answer questions like *"Why was
this deleted?"*, *"Who introduced this bug?"* and *"When did this dependency change?"*
without spending hours clicking through branches and commits.

Everything deterministic works **offline** against your local Git data.

```
Git Replay  my-project
branch main · 1,284 commits · 214 merges · 7 reverts · 32 authors
2021-02-01 → 2024-11-30

Story  (most recent first)
↻ a1b2c3d  2024-10-02  Feature reintroduced     Restores changes from 8f3a21 after …
↩ c72d10a  2024-09-28  Changes reverted         Reverts 8f3a21: "Add payment retries"
⬡ 91be002  2024-09-15  Dependency manifest changed  Bump lodash
◆ b17c92f  2024-08-30  Merged branch 'feature/payment'  2 parents · PR #482
⚑ 0a11c40  2014-05-01  Repository created
```

## Install

Install the CLI globally from npm:

```bash
npm install -g git-replay-cli
```

This exposes the **`git-replay`** executable (and a `git-replay-cli` alias) on your PATH.
Run it from inside any repository:

```bash
cd /path/to/some/repo
git-replay timeline
```

Or run it without installing:

```bash
npx git-replay-cli timeline
```

<details>
<summary>Install from source</summary>

```bash
git clone https://github.com/haileamlakwalelige/git-replay.git
cd git-replay
npm install
npm link        # exposes the `git-replay` executable on your PATH
```
</details>

> **Naming note.** Git 2.42+ ships an *experimental builtin* called `git replay`, and Git
> always prefers its own builtins over an external `git-<name>` executable. Use the
> **`git-replay`** executable directly. On Git older than 2.42, `git replay` will also
> resolve to this tool.

## Commands

| Command | Description |
| --- | --- |
| `git-replay` / `git-replay timeline [rev]` | Chronological timeline, story events and graph lanes |
| `git-replay file <path>` | Trace a file's history, following renames |
| `git-replay compare <a>..<b>` | Summarise the diff between two revisions |
| `git-replay explain <rev>` | Explain a commit from grounded Git evidence |
| `git-replay regressions [range]` | Scan fix commits for likely bug-introducing commits |
| `git-replay ask "<question>"` | Answer a question using collected Git evidence |
| `git-replay branches` | List branches, remotes and tags with ahead/behind |
| `git-replay serve` | Start the local interactive web UI |
| `git-replay help` | Show help |

### Options

```
--all                include all refs (default for timeline)
--first-parent       follow only the first parent
--limit <n>          limit commits / rows
--path <p>           restrict to a path
--json               machine-readable output
--no-color           disable ANSI colours
```

`explain` / `ask` add: `--regressions` (run the SZZ scan) and `--max-candidates <n>`.
`serve` adds: `--port <n>` (default 4173), `--host <addr>` (default 127.0.0.1), `--no-open`.

### Examples

```bash
git-replay timeline --limit 50
git-replay timeline --first-parent
git-replay file src/auth.ts
git-replay compare HEAD~10..HEAD
git-replay explain HEAD
git-replay explain HEAD --regressions
git-replay regressions --since HEAD~100..HEAD
git-replay ask "why was the payment module removed?"
git-replay ask "when did a dependency change?"
git-replay serve --port 4173
```

## Web UI

```bash
git-replay serve
```

Opens a local, read-only interface (bound to `127.0.0.1`) with:

- **Timeline** — the commit graph (SVG lanes), a story strip of notable events, and a
  filterable commit list.
- **Inspector** — click any commit to see its diff, files, dependency changes, revert
  links, and merge contents.
- **Branches / File / Compare / Regressions / Ask** tabs mirror the CLI.

The server exposes a JSON API under `/api` (`/api/timeline`, `/api/commit/:sha`,
`/api/file?path=`, `/api/compare?range=`, `/api/regressions`, `/api/ask?q=`).

### Static demo

A backend-free demo of the UI (an embedded sample timeline, no server required) is served
from GitHub Pages: **https://haileamlakwalelige.github.io/git-replay/**. In this mode the
Timeline, story strip, inspector and Branches tab are fully interactive; File, Compare,
Regressions and Ask show a notice because they need the local server (`git-replay serve`).

## How it works

Git Replay is built in three layers:

1. **Git history collector** (`src/core/collector.js`) — commits, parents, refs, diffs and
   file history, read through the `git` CLI.
2. **Analysis engine** (`src/core/analyzer.js`) — detects merges, reverts, reintroductions,
   dependency-manifest changes and, via an SZZ-style blame heuristic, likely
   bug-introducing commits.
3. **Timeline & graph** (`src/core/timeline.js`, `src/core/lanes.js`) — lays commits out
   into lanes and produces the story events.

Natural-language questions are answered deterministically in `src/core/evidence.js`, using
only the collected evidence.

| Feature | Status |
| --- | --- |
| Chronological commit timeline | ✅ |
| Branch and merge visualization | ✅ |
| Inspect file history | ✅ |
| Compare two revisions | ✅ |
| Identify revert commits | ✅ (where detectable) |
| Investigate likely bug-introducing commits | ✅ (basic SZZ heuristic) |
| Natural-language questions | ✅ (deterministic, evidence-grounded) |
| Pull request / issue context | ⏳ planned |

### Honesty about "why"

Git can establish **what** changed and **when**. It cannot prove **why** a developer made a
change unless the reason is recorded in commit messages, PRs, or issues. Git Replay only
reports reasons that are actually present in the evidence, and says so when it cannot.

## Development

```bash
npm test        # runs the node:test suite against generated fixture repositories
```

The tests build real throwaway Git repositories (features, merges, a revert and a
reintroduction, a dependency bump, and a bug/fix pair) and assert against them.

## License

MIT
