# Stakeholder-comment cursor (when the conventions declare one)

Stakeholder comments on PRs and tickets arrive whether or not a session is running; watchers die with the session, so anything posted between sessions is silently missed unless reads anchor to a durable marker.

- (a) At boot, read your role's cursor file (`<role>.json`, field `last_seen`, ISO-8601 UTC) and fetch ALL stakeholder comments since that stamp with the tracker's repo-wide "since" queries — for GitHub, TWO calls total: `issues/comments?since=` AND `pulls/comments?since=` (review-thread comments are a separate endpoint the CLI's PR view misses); never a per-PR loop.
- (b) Filter to stakeholder (non-bot) authors on work in YOUR lane; every hit is an action item folded into the ready report; cross-lane hits are consumed silently or bus-forwarded per lane rules.
- (c) **Advance the cursor ONLY after every newer comment is acted on or folded into the ready report — never on read.** A session gap self-backfills at the next boot because the marker only moves when the work is done.
- (d) No cursor declared → fall back to a plain unanswered-comment sweep of open lane PRs, and say so.
- (e) Mid-session the cursor is blind between sweeps — if the conventions' PR-status service materializes comment events as files, arm a background watcher on those events too (sweep-on-fire, re-arm after).
- (f) Approval/review BODIES are a third comment surface the two since= endpoints miss — on an approved/merged event for a lane PR, also read that PR's reviews (`pulls/<n>/reviews`) for stakeholder notes inside the approval. Where the service emits a UNIFIED per-PR timeline log, prefer ONE watcher over that log (with a local actor filter) to per-event-type marker loops.
