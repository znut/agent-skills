# Add repo rules

Use this setup only when a repo has no `.agent/orchestrate.md`.

First inspect what the repo already uses:

- `git remote -v` for the git host;
- `gh auth status` for GitHub identity;
- package scripts for check commands;
- `gh label list` for labels;
- `README.md`, `AGENTS.md`, product docs, and decision records for read order;
- project agent files for the harness and agent types.

Show the findings to the user. Ask for a clear answer on each point in the list. Do
not choose a silent default.

1. Git host and delivery: GitHub PRs or commit and push only.
2. Identity: a bot account and token file, or the user's current login.
3. Work tracker: GitHub Projects, none, or a service that a person updates.
4. Proof of checks: CI, or a local gate and where its result lives.
5. Where the reviewer records its verdict: a PR review, or the return block.
6. PR delivery: draft first with the manager marking ready, or ready PRs.
   For push-only delivery, the agent stops after it reports the pushed
   branch. Do not offer an automatic merge.
7. Exact check commands and command runner.
8. Existing labels, new labels, or no labels.
9. Doc read order.
10. Harness, project agent file format, worker types in order, reviewer type,
    and worker limit.
11. Model and effort for each type. Put these values only in the chosen
    harness's project agent files.

Write answers 1 through 10 to `.agent/orchestrate.md`, starting from
`templates/orchestrate.md` in this repo. Add only the project agent files for
the chosen harness:

- Codex: entries in `.codex/config.toml` and files in `.codex/agents/`;
- Claude Code: files in `.claude/agents/` and the small link files the repo
  needs;
- another harness: its documented project files.

Do not copy model names from one harness to another. Do not replace unrelated
settings.

## Deliver the first rules

The normal worker process cannot read rules that have not reached the default
branch, so the setup agent delivers the first rules itself:

1. Choose the base and create a separate worktree as `/orchestrate` directs.
2. Add only `.agent/orchestrate.md` and the chosen harness's project agent
   files.
3. Run the checks found in the interview. Parse each config file with its
   normal parser and format each doc.
4. Commit, then start the declared reviewer type on that worktree with the
   reviewed SHA, the approved answers, the changed paths, and generic checks,
   because the remote default branch has no rules yet. The review ladder is
   `/orchestrate`'s.
5. After `PASS`, push and deliver through the chosen mode. Never merge.

Once the user merges the rules, normal runs read `.agent/orchestrate.md`.
Edit that file when rules change. Do not run this setup again.
