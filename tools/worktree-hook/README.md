# worktree-hook — agent worktrees outside the repo

`worktree-create.sh` is a Claude Code `WorktreeCreate` hook that puts every
harness-created worktree (`isolation: "worktree"`, `EnterWorktree`,
`--worktree`) in the sibling `<repo>-worktrees/` dir instead of the default
`<repo>/.claude/worktrees/`.

Why: repo-wide tooling (editors, linters, indexers, glob-based scripts) never
sweeps nested checkouts, and a worktree's relative paths (`../..`) can't land
inside the primary tree. Worktrees are created DETACHED at the fetched
default-branch tip — no stub branches; workers branch per their contract.

Install (per repo):
1. Commit the script as `scripts/worktree-create.sh`.
2. Register the hook in the repo's committed `.claude/settings.json`, running
   the script from the default-branch tip so hook fixes activate on merge
   without anyone pulling the primary checkout:

```json
{
	"hooks": {
		"WorktreeCreate": [
			{
				"hooks": [
					{
						"type": "command",
						"command": "bash -c 'script=$(git show origin/main:scripts/worktree-create.sh) || { echo \"worktree-create: cannot read script from origin/main\" >&2; exit 1; }; exec bash -c \"$script\"'",
						"timeout": 30
					}
				]
			}
		]
	}
}
```

Cleanup tooling must scan the sibling dir (see ez-opd's
`scripts/cleanup-worktrees.sh` for a dual-root transition example).
