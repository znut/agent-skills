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
9. Runtime, project agent file format, worker types in order, model and effort
   for each type, reviewer type, allowed `BLOCK` results per worker type, and
   worker limit.

Write the answers to `.agent/orchestrate.md`. Include any identity or review
hook rules. Require identity and SHA checks unless the user rejects them.

Add only the project agent files for the chosen runtime:

- Codex: entries in `.codex/config.toml` and files in `.codex/agents/`;
- Claude Code: files in `.claude/agents/` and only the small link or hook files
  the repo needs;
- another runtime: its documented project files.

Do not copy model names from one runtime to another. Do not replace unrelated
settings.

## Deliver the first rules

The normal worker process cannot read rules that have not reached the default
branch. Use this setup process only for the first rules PR:

1. Follow `/orchestrate` to choose the default-branch base and create a separate
   worktree. The current setup agent owns this change.
2. Add only `.agent/orchestrate.md`, the chosen runtime's project agent files,
   and the hook files that the user approved.
3. Run the checks found in the interview. Parse each config file with its
   normal parser and format each doc.
4. Commit, then start the declared reviewer type in its own detached worktree
   at that commit. Give it the approved answers, changed paths, and generic
   checks because the remote default branch has no repo rules yet. Let the
   provider agent file choose the model and effort.
5. A reviewer crash, timeout, or tool fault returns `ERROR` and does not use a
   review attempt. Start a new reviewer of the same type.
6. After each `BLOCK` below the approved count, the same setup agent fixes all
   findings, runs checks, commits, and asks a new reviewer. At the limit, push
   the branch, open no PR, and send the branch and findings to the next worker
   type. Only the last worker type may stop and report the saved work.
7. After `PASS`, make no source or doc change. Write the SHA marker if the new
   hook needs one, push, open the setup PR, report its URL, and wait for the
   user. Never merge.

Do not send the first setup through the normal worker sequence. Once the user
merges the rules, normal runs read `.agent/orchestrate.md`. Edit that file when
rules change. Do not run this setup again.
