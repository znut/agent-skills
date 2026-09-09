# agent-skills

These skills help one person run product and engineering work through
subagents. Workers use separate git worktrees and own each task through checks,
review, and push. Repos that use PRs get one small PR per task.

The skills contain no project facts or model choices. Each repo keeps its rules
in `.agent/orchestrate.md` and its agent definitions in the active runtime's
project files. Claude Code and Codex can read the same repo rules while each
uses its own agent file format.

## Skills

Independent, invoked by the user:

| Skill         | Work                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `comm`        | Writing registers and rules for everything an agent writes to a person.                             |
| `orchestrate` | The delivery engine: base, worktree, worker, fresh review, push, PR, and the final check.           |
| `tech-debt`   | Weekly debt revisit: gathers friction signals, settles candidates with the user, and cuts tickets.  |
| `intake`      | Stakeholder interview on the stakeholder's own machine, filed as issues. See `intake/INSTALL.md`.   |

Composed on top of `comm` and `orchestrate`:

| Skill | Work                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------- |
| `pm`  | Settles product choices, updates product docs, creates tickets, and gives ready work to the TL.   |
| `tl`  | Checks ready tickets, sends engineering tasks, checks PRs, and owns engineering decision records. |

Loaded by a fresh reviewer that a worker starts, not typed by the user:

| Skill         | Work                                                                                   |
| ------------- | -------------------------------------------------------------------------------------- |
| `review-gate` | The reviewer's procedure: scan, review the exact commit, return PASS, BLOCK, or ERROR. |

## Install

Clone this repo. Link each skill folder into the skill folder for the runtime
you use:

- Claude Code: `~/.claude/skills/`
- Codex: `~/.codex/skills/`

A link lets a pull in this repo update the installed skill at once.

## Set up a repo

Run `/orchestrate` when a repo has no `.agent/orchestrate.md`. It reads
`orchestrate/bootstrap.md`, checks what the repo already uses, asks the user
for each missing choice, and adds `.agent/orchestrate.md` plus the project
agent files for the chosen runtime. `templates/orchestrate.md` lists every
value a repo file states; `templates/writing-rules.md` seeds the repo's
writing overlay. Do not copy model names between runtimes.

Setup happens once. Normal runs read `.agent/orchestrate.md` from the remote
default branch and do not read the setup file or template.

Repo files supply values and exceptions. The shared skills own the worker and
review process, so a skill update changes every repo that links these skills.

## Tools

`tools/` contains optional local programs: a PR status poller that turns
GitHub into local files, a board snapshot, a post-merge step runner, a local
main-health suite, a per-clone gh identity wrapper, a session boot report,
named PM/TL sessions, a worktree hook, and a Claude Code stop hook. Each
documents its own setup in `tools/README.md` or its folder.
