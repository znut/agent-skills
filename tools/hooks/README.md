# Hooks

Two Claude Code hooks, silent and fail-open. Register it in
`~/.claude/settings.json` or a repo's `.claude/settings.local.json`, replacing
`<path-to>` with this repo's absolute path.

## Watch-guard (Stop)

`watch-guard.sh` refuses to end a turn in a repo that ships
`scripts/watch-lane.sh` while no watcher process for this session's role is
alive: a standing watcher must be re-armed after every fire.
Other repos exit clean. The session's role comes from the marker that
`boot-report` writes at every PM and TL boot. Repo opt-out:
`- watch_guard: off` under `## Hook settings` in `.agent/orchestrate.md`.

    "Stop": [
      { "hooks": [ { "type": "command",
        "command": "bash <path-to>/tools/hooks/watch-guard.sh",
        "timeout": 5, "statusMessage": "watch-guard" } ] }
    ]

## Asks hook (Stop and UserPromptSubmit)

`asks-hook.sh` is one script for both events. Scope: sessions with a role
marker naming pm, tl-product or tl-platform. It needs `jq`, `curl` and a
TypeSafe token in `~/.config/typesafe.token`.

- **Stop (capture).** The candidate is the last line of the final assistant
  message that ends in `?`; no `?`, no call. Its first `#N` becomes the
  `link:` line. One Jev request asks whether it is a decision the user must
  make (yes at 0.6 or above pins it), and picks up to three earlier lines as
  Problem, Options and Rec context (`<n>.md`).
- **UserPromptSubmit (clear).** With exactly one open ask, a reply of `go`,
  `yes`, `no` and the like clears it with no call. Otherwise one yes/no per
  open ask, "does this message answer it?"; 0.6 or above clears, and later
  asks renumber ([orchestrate §Pinned asks](../../orchestrate/SKILL.md#pinned-asks)).
- **Failure.** Each Jev call has a 3 s cap. Any failure pins and clears nothing.
- **Shadow log.** `<state>/asks/jev-log.jsonl`: one line per decision with the
  candidate line and the scores, never the user's message.

Dry run: `ASKS_DRY_RUN=1` judges and prints the decision, writing no ask.
`ASKS_STATE_DIR`, `ASKS_ROLE_DIR` and `ASKS_TOKEN_FILE` override the paths.

    "Stop": [
      { "hooks": [
        { "type": "command", "command": "bash <path-to>/tools/hooks/watch-guard.sh",
          "timeout": 5, "statusMessage": "watch-guard" },
        { "type": "command", "command": "bash <path-to>/tools/hooks/asks-hook.sh",
          "timeout": 8, "statusMessage": "asks" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command",
        "command": "bash <path-to>/tools/hooks/asks-hook.sh",
        "timeout": 8, "statusMessage": "asks" } ] }
    ]
