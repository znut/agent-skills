# Role sessions and the session bus

Role sessions (PM, one TL per lane) run as separate processes and cannot message each other directly. A repo-declared **session bus** — one inbox directory of small marker files per role — bridges them. No bus declared: skip silently.

## State directory

`<state>` is the parent of `session_bus_dir` in the repo's `.agent/orchestrate.local.md` (found through Git's common directory, so every worktree of the clone agrees); `boot-report` uses the same rule. Everything a role keeps between sessions lives under it, keyed by role (`pm`, `tl-<lane>`), never by session: the inbox `<session_bus_dir>/<role>-inbox/` with an `archive/` subdirectory, the handoff note `<state>/notes/<role>.md`, the rules-read stamp `<state>/rules-read/<role>.stamp`, the comment cursor `<comment_cursor_dir>/<role>.json`. `boot-report <role>` prints each path; consume the printed paths.

## Inbox

- (a) At boot, sweep your OWN inbox: act on each message, then move it to `archive/`.
- (b) Arm a watcher on your inbox so a peer's ping wakes you mid-session: one standing watch running a SINGLE-SHOT blocking wait (prefer the runtime's monitor facility where background shells are reaped). Re-arm only AFTER each fired message is acted on and archived: bus fires are file-PRESENCE-based, so an auto-re-arm that precedes the sweep re-fires instantly on the unarchived file and floods until the watcher is killed.
- (c) Route cross-lane handoffs (lock requests, unblock notices, decision-landed pings, review handbacks) through the PEER's inbox, never relayed through the user.
- (d) Every message is self-contained: frontmatter `from/subject/refs` plus a body; the reader shares none of your conversation context.
- (e) The bus is NOT chat: only handoffs that would otherwise need the user to copy-paste between sessions.
- (f) Gate and poller events written straight into an inbox are not peer messages: after acting, move them to the same `archive/`.
- Watchers die with machine sleep; the boot sweep is the safety net.

## Wrap

When the user says wrap, run these in order and report each result:

1. Stop every worker and watcher this session started; name a worker still running and wait for it.
2. Sweep the inbox: act on or forward each pending message, then move it to `archive/`.
3. Overwrite the handoff note (`<state>/notes/<role>.md`) with the state the next boot needs: at most 40 lines, no history.
4. Empty the [pinned-asks](SKILL.md#pinned-asks) file.
5. Save the day's lessons to memory, one index line each.
