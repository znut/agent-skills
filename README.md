# agent-skills

These skills help one person run product and engineering work through
subagents. Workers use separate git worktrees and own each task through checks,
review, and push. Repos that use PRs get one small PR per task.

The skills contain no project facts or model choices. Each repo keeps its rules
in `.agent/orchestrate.md` and its agent definitions in the active runtime's
project files. Claude Code and Codex can read the same repo rules while each
uses its own agent file format.

## Skills

| Skill         | Work                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `orchestrate` | Splits work, sends workers, requires fresh review, and checks each PR. Pair it with `/pm` or `/tl`. |
| `pm`          | Settles product choices, updates product docs, creates tickets, and gives ready work to the TL.     |
| `tl`          | Checks ready tickets, sends engineering tasks, checks PRs, and owns engineering decision records.   |
| `review-gate` | Scans the diff and runs a fresh review before PR creation. It can write a SHA-bound PASS marker.    |

## Install

Clone this repo. Link each skill folder into the skill folder for the runtime
you use:

- Claude Code: `~/.claude/skills/`
- Codex: `~/.codex/skills/`

Link `orchestrate`, `pm`, `tl`, and `review-gate`. A link lets a pull in this
repo update the installed skill at once.

## Set up a repo

Run `/orchestrate` when a repo has neither `.agent/orchestrate.md` nor a full
legacy `.claude/orchestrate.md`. It reads `orchestrate/bootstrap.md`, checks
what the repo already uses, and asks the user for each missing choice. It then
adds:

- `.agent/orchestrate.md` with project rules;
- Codex, Claude Code, or other project agent files for the chosen runtime;
- review hooks or marker tools that the user chose.

You may also start from `templates/orchestrate.md`. Do not copy model names
between runtimes.

Setup happens once. Normal runs read `.agent/orchestrate.md` from the remote
default branch and do not read the setup file or template. A full legacy
`.claude/orchestrate.md` may supply rules until the user moves them to the main
file.

## Repo rules

The repo file states:

- remote, default branch, identity, and package tool;
- work areas, worktree rules, and doc read order;
- logical worker types in order, reviewer type, and worker limit;
- check commands and known limits;
- review checklist, marker, and hook rules;
- PR labels, title, body, issue links, state, and artifacts;
- ticket, TL, PM, and session-start rules.

Provider project files choose the model and effort for each logical agent type.
The shared skills do not choose or map models.

The shared skills own the worker and review process. Repo files supply values
and exceptions; they do not copy that process. A skill update therefore changes
every repo that links these skills.

## Work rules

- The user owns the main checkout. Agents use separate worktrees.
- First work may use either default tip when they match. A remote tip ahead of
  local wins. A local tip ahead of remote, or split refs, stops the work.
  Commit dates do not decide the base.
- The repo's first worker type starts each task.
- A fresh reviewer uses the paused worker's clean worktree and checks its exact
  committed tip without changing files.
- The same worker fixes the first and second `BLOCK`; a fresh reviewer checks
  each new clean commit.
- After the third `BLOCK`, a new worker of the next type continues from the
  pushed task branch.
- A reviewer error does not count as a `BLOCK`.
- All delivery needs green checks, a fresh `PASS`, no open `BLOCK`, and a pushed
  branch. PR delivery also needs an open PR. Push-only delivery reports the
  reviewed branch and stops.
- The user reviews and merges each PR. Agents never merge.

## Tools

`tools/` contains optional local programs for PR status, board summaries,
post-merge commands, bot identity, default-branch checks, and worktree paths.
Each program documents its own setup in `tools/README.md`.
