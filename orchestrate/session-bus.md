# Peer-session bus (when the conventions define one)

Role sessions (PM, TLs) run as separate processes and cannot message each other directly; a conventions-defined **session bus** — per-role inbox directories of small marker files — bridges them.

- (a) At boot, sweep your OWN inbox: act on each message, move it to the archive subdir.
- (b) Arm a background watcher on your inbox so a peer's ping wakes you mid-session; re-arm after each firing.
- (c) Route cross-lane handoffs (lock requests, unblock notices, decision/ADR-landed pings, review handbacks) through the PEER's inbox instead of relaying through the user.
- (d) Every message is self-contained (frontmatter `from/subject/refs` + body) — the reader shares none of your conversation context.
- (e) The bus is NOT chat: only handoffs that would otherwise need the user to copy-paste between sessions; lane-scope rules still apply to content.
- Watchers die with machine sleep — the boot sweep is the safety net. No bus declared → skip silently.
