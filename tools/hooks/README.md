# Optional PR gate

`review-gate.js` checks Bash commands before they run. It works with Claude
Code and Codex.

It has four guards:

1. A GitHub write must pass `GH_TOKEN=` on the same `gh` command.
2. With `draft_first: required`, `gh pr create` must pass `--draft`.
3. `gh pr create` needs a review marker for the branch tip.
4. `gh pr create` needs a check marker for the branch tip.

The hook lets reads such as `gh pr view` run without a token prefix.

## Repo settings

The hook keeps all guards on by default. A person may turn off a guard in the
`## Hook settings` section of `.agent/orchestrate.md`:

```markdown
## Hook settings

- bot_identity: off
- review_marker: off
- verify_marker: off
- draft_first: required
```

The first three settings are on unless set to `off`. `draft_first` is off
unless it is exactly `required`; a missing setting does not require drafts.
`/orchestrate` asks the user for these values. An agent must not choose them.

The hook reads `.agent/orchestrate.md` first. If that file has no settings
section, it checks the old `## Enforcement policy` section in
`.claude/orchestrate.md`.

## Install the shared script

Keep one copy of `review-gate.js`. Use its full path in each runtime's hook
file. Do not copy it into a provider folder; one update should reach both
runtimes.

Replace `/absolute/path/to/agent-skills` in the examples below.

### Claude Code

Add this entry to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/absolute/path/to/agent-skills/tools/hooks/review-gate.js\"",
            "timeout": 5,
            "statusMessage": "review-gate"
          }
        ]
      }
    ]
  }
}
```

### Codex

Add this entry to `~/.codex/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/absolute/path/to/agent-skills/tools/hooks/review-gate.js\"",
            "timeout": 5,
            "statusMessage": "review-gate"
          }
        ]
      }
    ]
  }
}
```

Run `/hooks` in Codex and trust the hook after you add or change it.

## Limits

- The hook allows a command when it cannot read or parse its input. A broken
  global hook must not block every repo.
- A quoted shell string that contains a GitHub write may cause a false block.
  Reword the string or use `--body-file`.
