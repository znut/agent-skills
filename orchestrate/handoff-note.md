# Handoff note = a state table rewritten at checkpoints, never a log

The note is the state a same-role session needs at its next boot, not a
transcript of what happened this session.

- (a) **Purpose** — answers "what does the next boot of this role need to
  know", nothing else; history lives on tickets, PRs, and the fleet dataset.
- (b) **Shape** — one state table with these rows, only the non-empty ones
  present: live (worker/PR + next step) · queued (dispatch order) · ready for
  the PO · held (with the reason) · owed by the TL/PM · open PO answers.
  Below the table, at most five "facts learned" lines the next boot must not
  re-derive.
- (c) **Cadence** — overwrite the whole table at checkpoints only: a dispatch,
  a ready flip, a BLOCK/escalation, a lane change, wrap. Never on a watcher
  fire, a merge event, a monitor tick, or a bus read — those are not
  checkpoints.
- (d) **Size** — ≤ 40 lines total. A note that would exceed it drops history,
  not rows; if every row is still needed the note is too granular, not too
  short.
- (e) **Timestamps** — from `date`, never recalled from memory.
- (f) **Unresolved FAIL/BLOCK at wrap** — a row in `held` or `owed` naming its
  next action; this is the only trigger that survives from the old
  per-event "next-boot line" rule, and it fires once, at wrap, not per event.
