# Add repo rules

Use this file only when a repo lacks `.agent/orchestrate.md`.

First inspect what the repo already uses:

- `git remote -v` for the git host;
- `gh auth status` for GitHub identity;
- package scripts for check commands;
- `gh label list` for labels;
- `README.md`, `AGENTS.md`, product docs, and decision records for read order;
- project agent files for the runtime and agent types.

Show the findings to the user. Ask for a clear answer on each point below. Do
not choose a silent default.

1. Git host and delivery: GitHub PRs or commit and push only.
2. Identity: a bot account and token file, or the user's current login.
3. Work tracker: GitHub Projects, none, or a service that a person updates.
4. Review: fresh reviewer with a SHA marker and hook, or fresh reviewer without
   a marker.
5. User review: confirm that the agent will open each clean PR and wait. The
   user reviews and merges it. Do not offer an automatic merge.
6. Exact check commands and command runner.
7. Existing labels, new labels, or no labels.
8. Doc read order.
9. Runtime, project agent file format, worker types in order, reviewer type,
   allowed `BLOCK` results per worker type, and worker limit.

Write the answers to `.agent/orchestrate.md`. Include any identity or review
hook rules. Require identity and SHA checks unless the user rejects them.

Add only the project agent files for the chosen runtime:

- Codex: entries in `.codex/config.toml` and files in `.codex/agents/`;
- Claude Code: files in `.claude/agents/` and only the small link or hook files
  the repo needs;
- another runtime: its documented project files.

Do not copy model names from one runtime to another. Do not replace unrelated
settings.

Commit, review, push, and open the rules PR through `/orchestrate`. Once the
repo has `.agent/orchestrate.md`, edit that file when rules change. Do not run
this setup again.
