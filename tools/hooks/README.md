# Hooks

Two small Claude Code hooks. Both are silent and fail open. Register each in
`~/.claude/settings.json` or a repo's `.claude/settings.local.json`, replacing
`<path-to>` with this repo's absolute path.

## Session-role marker (UserPromptSubmit)

`session-role-marker.sh` records which role skill a session runs (`/pm`,
`/tl`, `/tl <lane>`) as `/tmp/cc-session-roles/<session_id>`, so a statusline
can label parallel role sessions and `bgh` can derive its self-event log.

    "UserPromptSubmit": [
      { "hooks": [ { "type": "command",
        "command": "bash <path-to>/tools/hooks/session-role-marker.sh",
        "timeout": 5, "statusMessage": "role marker" } ] }
    ]

## Watch-guard (Stop)

`watch-guard.sh` refuses to end a turn in a repo that ships
`scripts/watch-lane.sh` while no watcher process for this session's role or
generation is alive: a standing watcher must be re-armed after every fire.
Other repos exit clean. Repo opt-out: `- watch_guard: off` under
`## Hook settings` in `.agent/orchestrate.md`.

    "Stop": [
      { "hooks": [ { "type": "command",
        "command": "bash <path-to>/tools/hooks/watch-guard.sh",
        "timeout": 5, "statusMessage": "watch-guard" } ] }
    ]
