# Hooks

Watch-guard is a silent, fail-open Claude Code hook. Register it in
`~/.claude/settings.json` or a repo's `.claude/settings.local.json`, replacing
`<path-to>` with this repo's absolute path.

## Watch-guard (Stop)

`watch-guard.sh` refuses to end a turn in a repo that ships
`scripts/watch-lane.sh` while no watcher process for this session's role is
alive: a standing watcher must be re-armed after every fire.
Other repos exit clean. The session's role comes from the marker that
`boot-report` writes at every PM and TL boot.
A `/tmp/cc-session-roles/<session_id>.wrapped` marker, touched at
[wrap](../../orchestrate/session-bus.md#wrap), allows the stop for that session.
Repo opt-out:
`- watch_guard: off` under `## Hook settings` in `.agent/orchestrate.md`.

    "Stop": [
      { "hooks": [ { "type": "command",
        "command": "bash <path-to>/tools/hooks/watch-guard.sh",
        "timeout": 5, "statusMessage": "watch-guard" } ] }
    ]
