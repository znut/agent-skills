# agent-skills

These skills help one person run product and engineering work through
subagents. Workers use separate git worktrees and own each task through checks,
review, and push. Repos that use PRs get one small PR per task.

The skills contain no project facts or model choices. Each repo keeps its rules
in `.agent/orchestrate.md` and its agent definitions in the active harness's
project files. Claude Code and Codex can read the same repo rules while each
uses its own agent file format.

## Skills

Independent, invoked by the user:

| Skill         | Work                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `comm`        | Writing registers and rules for everything an agent writes to a person.                             |
| `orchestrate` | Why the manager delegates; base, worktree, worker procedure, review, PR, and the final check.       |
| `tech-debt`   | Weekly debt revisit: gathers friction signals, settles candidates with the user, and cuts tickets.  |
| `intake`      | Stakeholder interview on the stakeholder's own machine, filed as issues. See `intake/INSTALL.md`.   |

Composed on top of `comm` and `orchestrate`:

| Skill | Work                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------- |
| `pm`  | Settles product choices, updates product docs, creates tickets, and gives ready work to the TL.   |
| `tl`  | Holds the engineering bar (YAGNI, DRY, performance, OWASP), sends tasks, checks PRs, owns ADRs.  |

Loaded by a fresh reviewer that a worker starts, not typed by the user:

| Skill         | Work                                                                                   |
| ------------- | -------------------------------------------------------------------------------------- |
| `review-gate` | The reviewer's procedure: scan, review the exact commit, return PASS, BLOCK, or ERROR. |

## Install

Clone this repo. Link each skill folder into the skill folder for the harness
you use:

- Claude Code: `~/.claude/skills/`
- Codex: `~/.codex/skills/`

A link lets a pull in this repo update the installed skill at once.

## Set up a repo

Run `/orchestrate` when a repo has no `.agent/orchestrate.md`. It reads
`orchestrate/bootstrap.md`, checks what the repo already uses, asks the user
for each missing choice, and adds `.agent/orchestrate.md` plus the project
agent files for the chosen harness. `templates/orchestrate.md` lists every
value a repo file states; `templates/writing-rules.md` seeds the repo's
writing overlay. Do not copy model names between runtimes.

Setup happens once. Normal runs read `.agent/orchestrate.md` from the remote
default branch and do not read the setup file or template.

Repo files supply values and exceptions. The shared skills own the worker and
review process, so a skill update changes every repo that links these skills.

## Tools

`tools/` contains optional local programs: a PR status poller that turns
GitHub into local files, a board snapshot, a post-merge CI driver with merge
previews, a per-clone gh identity wrapper, a session boot report,
a worktree hook, and Claude Code hooks (watch-guard, asks). Each
documents its own setup in `tools/README.md` or its folder.

## Plugins

`plugins/` holds Claude Code plugins. `plugins/agent-ui` adds `/workers`, a
pane of the session's child runs (GPT, Claude, Claude review panels) with each
run's live tail on click and main-ci's verdict line, which expands to a chart of
recent main-ci runs (its line is the 1-minute load average when each run started;
chips switch the bars between stacked job wall time, stacked job cpu time, and
one bar at the run's peak memory; hover a bar for its slowest jobs), opens itself at start in
PM and TL sessions, and pins
the session's asks ([orchestrate §Pinned asks](orchestrate/SKILL.md#pinned-asks))
above the prompt (an ask whose `#N` ticket is done is hidden), each expanding to its recorded context on click; a right-click on an ask drops it from the file (under the asks hook's lock), on the surfaces that draw a `Client`. Above its
child runs it draws the session's dispatch chains
([orchestrate §Dispatch chains](orchestrate/SKILL.md#dispatch-chains)), one line each,
`#4545 → #4549 → #4552`: the newest issue Done on the board ticked green (older Done ones
dropped), an issue a running row's label names in the accent colour, each `#N` linked to its
issue with its board title shown on hover. Load it for one session with
`claude --plugin-dir <clone>/plugins/agent-ui`, or for every session by adding
that path to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
`~/.claude/settings.json`. Its paths are `userConfig` options in `/config`;
each option's description in its `plugin.json` says what an empty value does.
Set `childrenDir` to the folder of child run out-dirs: empty, the pane lists no
child runs from disk and says to set it. The pane lists only runs whose
`owner-session` file holds this session's id, and reads each run's kind from
its `provider` file alone. Review panels come from the clone's git common
directory (`.review-panel/`), the asks, gh-status, board and main-ci state from
`state_dir` in the main checkout's `.agent/local.env`
([session-bus.md §State directory](orchestrate/session-bus.md#state-directory)), and
ticket links from the GitHub repository of the session clone's `origin` remote
(no GitHub remote, no link). The avatars and the main-ci chart draw as terminal
pictures, which kitty and Ghostty show.
Check it with `claude plugin validate`, `claude plugin test` and `tsc -p` on
that folder.

A repo adds its own panels below the main-ci chart by listing them in
`.agent/pane-panels.json` at the main checkout's root (no file, no panels):
`[{ "id": "acme", "title": "Acme", "cmd": ["bun", "scripts/pane/acme.mjs"], "refresh_s": 60 }]`.
The pane runs `cmd` as an argv (no shell) in that root, stdin closed, 10 s
limit: at most once per `refresh_s` (default 60, at least 5), collapsed or
expanded, so the collapsed summary stays fresh too; never two runs at once. The
command prints one JSON object on stdout and exits 0; anything else shows
`panel error: <first stderr line>` and keeps the last good rows. The pane runs
the listed commands without asking, with the user's environment: list only
commands you trust, as with a repo hook. The output:

```json
{
  "summary": "north  alpha 78%",
  "tab": "north",
  "tabs": [{
    "id": "north", "label": "north",
    "columns": [
      { "key": "name", "label": "cell", "width": 11 },
      { "key": "n", "label": "n", "width": 3, "align": "right" },
      { "key": "pass", "label": "pass", "width": 10, "kind": "bar" }
    ],
    "rows": [{
      "id": "alpha", "dim": false,
      "cells": { "name": "alpha@med", "n": "9", "pass": { "frac": 0.78, "text": "78%", "tone": "good" } },
      "hover": ["alpha@med · north", "pass 7 / fail 2"]
    }],
    "note": "dim = few runs"
  }]
}
```

`summary` follows the title while collapsed; `tab` is the default tab, and the
user's pick persists per panel id. Cells are strings, or for a `bar` column
`{ frac 0..1, text, tone }`: a bar the column wide in `good`, `mid`, `bad` or
`dim` over a dark track, its text right-aligned inside it. A `dim` row draws
dimmed; `hover` (up to 6 lines) is the row's hover card, as on a main-ci bar.
Only `tabs[].id`, `columns` and `rows` are required; a row is cut to the pane
width, never wrapped. Keep cells to narrow single-width text: a wide glyph (CJK, emoji) can
wrap a row. A panel draws at most 12 tabs, 12 columns up to 200 wide, and 100
rows; control characters in any text draw as spaces.

Contract v1.2 adds three optional column keys. `maxWidth` (at least `width`):
after the columns are laid out at their `width` with one space between, the
cells left in the pane width go left to right to columns with a `maxWidth`, each
up to it; `width` stays the minimum. `"keep": "right"` keeps an over-long
value's right end (cut from the left); the default keeps the left end. `{w}` in
a `label` becomes the column's laid-out width: `{ "key": "trend", "label":
"{w}d", "width": 7, "maxWidth": 14, "keep": "right" }` draws its header
as `9d` with 2 spare cells, and the header and rows use that one width.
A header label longer than the column is cut at its right like any cell.

An optional `filters` list replaces the tab chips with one chip row per filter;
together the picks name the tab, whose `id` is the picked option ids joined by
`/` in filter order (`worker/docs`):

```json
"filters": [
  { "id": "role", "options": [{ "id": "worker", "label": "worker" }, { "id": "reviewer", "label": "reviewer" }], "default": "worker" },
  { "id": "class", "options": [{ "id": "all", "label": "all" }, { "id": "docs", "label": "docs" }] }
]
```

Each filter's pick persists per panel and filter; an unset pick, or one the
output no longer offers, falls back to `default`, else the first option. A
combination with no tab draws the columns header and `no data`. With filters a
panel takes at most 3 filters of 12 options and 48 tabs; without them, the tab
chips and `tab` work as above.
