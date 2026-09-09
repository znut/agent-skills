# Hooks

One Claude Code hook, silent and fail-open. Register it in
`~/.claude/settings.json` or a repo's `.claude/settings.local.json`, replacing
`<path-to>` with this repo's absolute path.

## Watch-guard (Stop)

`watch-guard.sh` refuses to end a turn in a repo that ships
`scripts/watch-lane.sh` while no watcher process for this session's role or
generation is alive: a standing watcher must be re-armed after every fire.
Other repos exit clean. The session's role comes from the marker that
`boot-report` writes at every PM and TL boot. Repo opt-out:
`- watch_guard: off` under `## Hook settings` in `.agent/orchestrate.md`.

    "Stop": [
      { "hooks": [ { "type": "command",
        "command": "bash <path-to>/tools/hooks/watch-guard.sh",
        "timeout": 5, "statusMessage": "watch-guard" } ] }
    ]
