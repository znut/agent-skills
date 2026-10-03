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
marker naming pm, tl-product or tl-platform. It needs `jq`, `curl`, `perl` and a
TypeSafe token in `~/.config/typesafe.token`.

- **Stop (capture).** The candidate is the last line of the final assistant
  message that ends in `?`; no `?`, no call. Its first `#N` becomes the
  `link:` line. One Jev request asks whether it is a decision the user must
  make (yes at 0.6 or above pins it), and picks up to three earlier lines as
  Problem, Options and Rec context (`<n>.md`).
- **UserPromptSubmit (clear).** A reply on a fixed short-reply list
  (`SHORT_REPLIES` in the script, one per line: `go`, `go ahead`, `do it`,
  `yes`, `no`, `ok`, `ship`, `merge` and the like; matched whole,
  case-insensitive, edge punctuation ignored) clears the newest open ask only,
  inline, with no call. Ticket numbers (`1111` or `#1111`) in that reply name
  the asks to clear instead: `1111 go` clears only the ask with `#1111`,
  `4405 4407 go` clears both. The reply must be only ticket numbers plus one
  list entry, and every number must match an open ask's first `#N`; `1111 go,
  and what about 2222?` or `9999 go` goes to Jev. Any other message gets one
  yes/no per open ask, "does this message answer it?"; 0.6 or above clears, and
  later asks renumber
  ([orchestrate §Pinned asks](../../orchestrate/SKILL.md#pinned-asks)).
- **Never blocks.** Inline work is builtins plus one `jq` (about 40 ms): the
  no-`?` exit, the short-reply clear, the state-dir lookup (cached per session).
  Every Jev call and the write behind it run detached, and the hook exits 0 at
  once. Writers hold a kernel `flock` on `<sid>.lock` (taken through `perl`; the
  kernel drops it when the holder dies, so no stale lock is ever broken) and
  rewrite by temp file plus `mv`; a clear matches ask text, not line numbers.
  A prompt that lands while a capture is still judging cancels that pin.
  `bash tools/hooks/asks-hook.test.sh` checks the lock and the deterministic clear.
- **Failure.** Each Jev call has a 3 s cap; curl's exit status decides, and the
  body is parsed only after curl succeeded. A non-zero exit or HTTP error pins
  and clears nothing and logs `jev-failed`.
- **Data sent to Jev.** Capture: the candidate line and the at most 12 non-empty
  lines before it, each cut to 200 chars. Clear: the user's message, each open
  ask line and its `<n>.md`. Nothing else leaves the machine.
- **Shadow log.** `<state>/asks/jev-log.jsonl`: one line per decision with the
  candidate line and the scores, never the user's message.

Dry run: `ASKS_DRY_RUN=1` judges and prints the decision in the foreground, writing no ask. `ASKS_SYNC=1` runs the Jev part in the foreground and writes.
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
