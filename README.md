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
a worktree hook, and a Claude Code stop hook. Each
documents its own setup in `tools/README.md` or its folder.

## Plugins

`plugins/` holds Claude Code plugins. `plugins/agent-ui` adds `/workers`, a
pane of the session's child runs (GPT, Kimi, Claude review panels) with each
run's live tail on click, and pins the session's asks
([orchestrate §Pinned asks](orchestrate/SKILL.md#pinned-asks)) above the prompt,
each expanding to its recorded context on click. Load it for one session with
`claude --plugin-dir <clone>/plugins/agent-ui`, or for every session by adding
that path to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
`~/.claude/settings.json`. Its paths are `userConfig` options in `/config`;
each option's description in its `plugin.json` names the default an empty
value resolves to. Check it with
`claude plugin validate`, `claude plugin test` and `tsc -p` on that folder.
