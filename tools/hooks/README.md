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
marker naming a manager role, `pm` or any `tl-<lane>`. It needs `jq`, `curl`, `perl` and a
TypeSafe token in `~/.config/typesafe.token`.

- **Stop (capture).** The candidate is the last line of the final assistant
  message that ends in `?`, cut to its question sentence alone: the last full
  sentence of the line (the boundary is `.`, `!`, `?` or `:` plus a space, or
  the line start), so `Merged #123. Should I start #124?` pins `Should I
  start #124?`, keyed `#124`. A sentence over 110 chars keeps its start and is
  cut at a word with `…?`, never with a leading ellipsis. Its first `#N`
  becomes the `link:` line, an issue URL on the session repo's GitHub `origin`
  remote; any other remote, or no repo, gets no link.
  One Jev request asks whether it is a decision the user must make (yes at 0.6
  or above pins it), and picks up to three earlier lines as Problem, Options
  and Rec context (`<n>.md`). A leading `:`, `;`, `,`, dash or space is
  stripped from the candidate. There is one ask per ticket: a
  pin whose first `#N` matches an open ask's first `#N` replaces that ask (line
  and `<n>.md`, no Jev call) and goes last; asks with no `#N` dedupe by exact
  text. The same request also asks, per open ask, "is the new question the same
  decision as this ask?"; every open ask scored 0.6 or above is replaced the
  same way (a `#N` match skips these questions), so one decision reworded across
  turns stays one ask. Every write (pin or clear) also collapses duplicates
  already in the file, keeping the newest per `#N`.
- **Settled by the message.** On every Stop with an open ask, even when the
  message has no `?`, the same request asks per open ask: "does this message
  say the ask is settled, answered or no longer waiting on the user?" A score
  of 0.6 or above clears it in the same write; a statement that nothing is
  waiting on the user settles every ask. A Stop with no `?` and no open ask
  makes no call.
- **Done tickets.** Every write also drops an ask whose first `#N` is a ticket
  closed after the ask was pinned, never in the write that pins it: an ask
  about an already-closed ticket stays until answered. A PR file
  `<gh_status_dir>/status/pr-N.json` with a top-level `state` of `MERGED` or
  `CLOSED` (read with `jq`, so a nested object's `state` never counts) decides
  by its close time (`mergedAt`, else `closedAt`, else `updatedAt`) against the
  ask's pin stamp. Without one, a row in `board_snapshot_file` whose `Status`
  column (found by its header cell; `\|` inside a cell never splits it) reads
  `Done` drops the ask, unless the row was already `Done` at the pin (the
  `board-done` flag on the ask's `<sid>.meta` line). Both paths come from
  `.agent/orchestrate.local.md`, or sit beside `ASKS_STATE_DIR` in tests. Local
  files only, no network; a missing file, close time or snapshot means keep,
  and an ask with no `#N` is never dismissed. The `agent-ui` band hides such asks at render time from the
  same files, so a merge shows within one tick, before the next write.
- **UserPromptSubmit (clear).** A prompt that is not the user's own words
  (a `<task-notification>`, an "Another Claude session sent a message", "Stop
  hook feedback", or only `[Image #N]` markers) is skipped whole: no `.seen`
  touch, no call, no clear. A reply made only of entries from a fixed
  short-reply list (`SHORT_REPLIES` in the script, one per line: `go`, `go
  ahead`, `do it`, `yes`, `no`, `ok`, `ship`, `merge`, `เน` and the like;
  case-insensitive, punctuation as a word break, so `yes go` and `ok, go`
  match) clears the newest open ask only, inline, with no call. So does a bare
  option digit under 100 with no `#` (`1`). Ticket numbers (`1111` or
  `#1111`) in a short reply name the asks to clear instead: `1111 go` clears
  only the ask with `#1111`, `123 456 go` clears both; numbers that match no
  open ask's first `#N` (`999 go`, an option number) clear the newest ask.
  Extra words (`1111 go, and what about 2222?`) send the reply to Jev. Any
  other message gets one yes/no per open ask, "does this message answer it?";
  0.45 or above clears, and later asks renumber
  ([orchestrate §Pinned asks](../../orchestrate/SKILL.md#pinned-asks)).
- **Never blocks.** Inline work is builtins plus one `jq` (about 40 ms): the
  no-`?`-and-no-ask exit, the short-reply clear, the state-dir lookup (cached
  per session).
  Every Jev call and the write behind it run detached, and the hook exits 0 at
  once. Writers hold a kernel `flock` on `<sid>.lock` (taken through `perl`; the
  kernel drops it when the holder dies, so no stale lock is ever broken) and
  rewrite by temp file plus `mv`; a clear matches ask text, not line numbers.
  Each ask line carries a pinned-at stamp (microseconds) in the hook-private
  sidecar `<sid>.meta`, one line per ask (plus the `board-done` flag), which
  the plugin ignores. A judgment
  (clear, settled, replace) stamps the moment it read the asks and only removes
  an ask pinned at or before that moment, so an identical ask pinned while Jev
  ran stays; an ask with no stamp counts as old.
  A prompt that lands while a capture is still judging cancels that pin.
  `bash tools/hooks/asks-hook.test.sh` checks the lock, the deterministic clear and the fail-open paths.
- **Failure.** Each Jev call has a 3 s cap; curl's exit status decides, and the
  body is parsed only after curl succeeded. A non-zero exit or HTTP error pins
  and clears nothing and logs `jev-failed`. Every other failure (no role
  marker, empty or non-JSON stdin, missing `jq` or `perl`, an unwritable state
  dir) also exits 0 with no output; an exit trap enforces it.
- **Data sent to Jev.** Capture: the candidate line, the at most 12 non-empty
  lines before it, the message's last 12 non-empty lines (each cut to 200
  chars), and the open ask lines (no context).
  Clear: the user's message, each open ask line and its `<n>.md`. Nothing else
  leaves the machine.
- **Shadow log.** `<state>/asks/jev-log.jsonl`: one line per decision (`pin`,
  `replace`, `settled`, `clear`, `done-ticket`, `skip`, ...) with the candidate
  line and the scores, each open ask's same-decision and settled scores under
  `same` and `settled`; never the user's message. A `replace` line (Jev or the
  `#N` rule) lists the asks it removed under `replaced`, so every pin and every
  removal appears exactly once.

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
