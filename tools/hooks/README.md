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

Identity, review, and verify are on by default. A person may turn off one in
the `## Hook settings` section of `.agent/orchestrate.md`:

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

## Bare-gh contract

The gate recognizes exactly `[VAR=val …] gh …` as a gh invocation — it unwraps
nothing. `env`, `command`, `nohup`, `sh -c`, `xargs`, and quoted command
strings (`env -S "gh …"`) all BLOCK with a rewrite-as-bare message instead of
passing unseen. Wrapper behavior differs by platform (GNU and BSD `env -S`
split differently; `-C` is GNU-only), and each accepted wrapper is one more
way for a new model's habit to slip past the gate. A loud refusal teaches the
agent to rewrite, and it works the same everywhere.

A repo whose conventions route gh through a token-injecting wrapper declares
it once per clone:

    git config agent.gh-wrapper bgh

A wrapper call needs no token prefix — injecting the token is the wrapper's
job — and still gets draft-first and marker checks.
Without the config, the wrapper name is just an unknown command — declare it
or the gate cannot see those PRs.

The gate guards against an honest agent that drifts, not an attacker. It
turns drift into loud blocks; no hook can stop deliberate evasion.

## Limits

- The hook allows a command when it cannot read or parse its input. A broken
  global hook must not block every repo.
- An UNQUOTED shell fragment that mentions a GitHub write (`echo run gh pr
  create later`) trips the bare-gh backstop — a false block, in the closed
  direction. Quote the text or use `--body-file`. Quoted prose never trips.
- Subshell-parenthesized or `if`-guarded gh mutations (`(gh pr comment …)`)
  read as unparsed constructs and block — rewrite bare.

## Ready-push gate

A push to a branch whose OPEN PR is READY (not draft) blocks: new commits
void the manager's ready vouch while the user still reads "ready" as
merge-safe. Flip the PR to draft, push, re-check, re-ready. The gate reads
the local PR status snapshots — declare once per clone:

    git config agent.pr-status-dir <the repo's gh-status dir, e.g. ~/.config/agent-tools/var/<name>/gh-status>

Fail-open without the config or on pre-upgrade snapshots (no `isDraft`).
Override for a deliberate case: `READY_PUSH_OK=1 git push …`. Repo opt-out:
`- ready_push_gate: off` under `## Hook settings`. The gh-status poller's
`ready-stale` event is the alarm for pushes the hook never saw.
