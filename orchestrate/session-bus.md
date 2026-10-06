# Role sessions and the session bus

Role sessions (PM, one TL per lane) run as separate processes and cannot message each other directly. A **session bus** — one inbox directory of small marker files per role — bridges them. No `state_dir` declared ([§State directory](#state-directory)): skip silently.

## State directory

Machine-local paths live in `<main checkout>/.agent/local.env`, read through Git's common directory so every worktree of the clone agrees: one `key=value` per line, `#` comments, the value everything after the first `=`, a leading `~/` read as `$HOME`. Keys: `state_dir`, `worktrees_dir`, `references_dir`. NEVER add override keys or a fallback file: each reader (`boot-report`, the asks hook, the `agent-ui` plugin) takes this one source, and a missing file or key skips the state-scoped work.

`<state>` is `state_dir`. Its entries are fixed names: `gh-status/`, `board-snapshot.md`, `session-bus/`, `self-events/`, `comment-cursor/`, `warm-snapshot/`, `gate/`, `asks/`, `main-ci/`, `chains/`, `notes/`, `rules-read/`. What a role keeps between sessions is keyed by role (`pm`, `tl-<lane>`), never by session: the inbox `<state>/session-bus/<role>-inbox/` with an `archive/` subdirectory, the handoff note `<state>/notes/<role>.md`, the rules-read stamp `<state>/rules-read/<role>.stamp`, and the comment cursor `<state>/comment-cursor/<role>.json`. `boot-report <role>` prints the paths a boot needs, such as a missing inbox or cursor and the stamp command; use those, never a guessed path.

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
4. Empty the [pinned-asks](SKILL.md#pinned-asks) file and delete its `<session-id>.d/` context directory.
5. Save the day's lessons to memory, one index line each.
