# Named PM/TL sessions and inboxes

## Boot and identity

On `/pm` or `/tl`, read this section before the boot report. Resolve the role
from the invoked skill. PM has no lane; TL resolves its lane from the
invocation or repo rules and asks the PO before registering if it is absent. A lane limits eligible
tickets; multiple sessions may share it. Never invent fixed subareas.

Run `agent-session boot --role pm` or `agent-session boot --role tl --lane <lane>` from the project checkout.
The executable is `<agent-skills>/tools/agent-session`; if absent from PATH, use
`bun <agent-skills>/tools/agent-session.mjs`. No shell exports are required:
Codex uses `CODEX_THREAD_ID`, Claude Code uses `CLAUDE_CODE_SESSION_ID`, and pi
uses `PI_SESSION_ID`. A harness without a stable ID must supply `--session-id`
and `--harness`; never use a shell PID or a new ID on resume.

Immediately announce `Name — PM` or `Name — TL, lane <lane>`. Save the returned session ID,
harness, generation, and paths in conversation state through compaction. Run
`current` on resume; repeated `boot` returns the same name and generation until
explicit `end`. Names come from Cedar, Maple, Willow, Birch, Aspen, Rowan,
Hazel, Olive and are unique among active PM/TL sessions in the shared state.
Harness is metadata, not a name partition. A full pool refuses the ninth boot.

Run `boot-report <role>` after named boot (`pm` or `tl-<lane>`). It resolves the
current registration and prints private paths. Read and write those returned
paths, including the rules-read stamp; another session's stamp is never proof
that this session read the rules. Existing sessions that have not adopted named
boot retain their role-only paths; never claim or drain their inboxes.

State resolves from `--state-dir`, then `AGENT_STATE_DIR`, then the parent of
`session_bus_dir` in the primary checkout's `.agent/orchestrate.local.md` found
through Git's common directory. Every checkout on the same Mac must point to
the same state directory for shared name and resource exclusion. No configured
state returns exit 3; establish the shared directory before named boot.

## Claims and handoffs

A **claim** is one atomic ownership record assigning a ticket and its complete
shared-resource set to one session generation.

Propose any Ready ticket within the lane. Wait for PO confirmation before
claiming, rechecking for dispatch, or sending workers. After confirmation,
atomically claim the ticket and its complete shared-resource set, then recheck
Ready status and current open work before dispatch. If that final recheck
fails, stop and release the claim with the recorded quiescence evidence.
Local claims do not replace tracker state.

Pass the accountable owner's session ID, harness, generation, ticket, resource
keys and confirmation reference in every worker prompt. A worker keeps its own
harness identity and uses the explicit assigned-owner flags for ownership
checks. One owner remains accountable for each ticket and associated PR.

Use `associate-pr` as soon as the PR exists; `check-owner` before owner actions.
An ownership conflict reports its actual owner and never overwrites any claim.
Before a normal handoff, stop the old workers and watchers, save their branch,
record quiescence evidence, and `release` the ticket. The next owner claims only
after PO confirmation. Never infer quiescence from idle time or a dead shell.

Wrap writes the returned notes path (state only, at most 40 lines). Explicit
`end` refuses outstanding claims and pending inbox work. No extra branch evidence is required after ownership has been released. History and inbox archives remain in
the old generation directory, so a reused name receives no old mail.

## Routing and consumption

Use `send --ticket <id>` for PM-to-ticket requests: it resolves the actual
owner. An unowned ticket returns exit 3 unless an explicit `--triage <name>` is
provided. Never broadcast actionable unowned work by default. Direct messages
use `--to <name>`; name resolution and durable delivery share the registry
mutex. `broadcast --lane <lane>` creates an independent copy for each active
peer in that lane, excluding the sender.

Messages contain `from/subject/refs` frontmatter and a self-contained body.
At boot and each watcher fire, act on each pending message, then call
`archive-message`. Never archive a registered message by moving it manually:
the durable registry is authoritative and will restore pending mail. External
gate events written directly into the resolved generation inbox are not peer
registry messages: after acting, move them into that same generation archive.
Do not register a daemon as PM/TL or give it a name. Legacy peer inboxes keep
their existing file-move consumption until named adoption. `end` checks both
registry-pending mail and actual inbox entries. Arm one
single-shot watcher on the returned inbox and owner event paths; re-arm only
after consuming and archiving the fired messages. Machine sleep may stop a
watcher; the boot sweep recovers pending work. Use explicit owner generation in
watcher arguments so a peer's watcher never satisfies this session's guard.

## CLI and JSON contract

All commands return JSON. Success is `{ok:true,...}`; failures go to stderr as
`{ok:false,code,error,...}`. Exit 2 = invalid arguments; 3 = absent registration,
name, or ownership; 4 = malformed/incomplete state or I/O failure; 5 = conflict,
stale generation, exhausted pool, or outstanding work; 6 = occupied registry mutex.
Only exit 3 permits a legacy fallback. Never fail open on other errors.

A session is `{name,role,lane,session_id,harness,generation,status,paths,claims}` plus
audit fields; PM `lane` is null. `paths` includes `inbox`, `archive`, `notes`, `rules_stamp`,
`cursors` (alias of `comment_cursor`), `comment_cursor`, `event_cursors`,
`watchlist`, `self_events`, and `merged_seen`. Paths include the generation
under `session-bus/<pm|tl-lane>/<name>/<generation>/`; consume returned paths,
never reconstruct them. Ownership is returned as `{session,claim}` where
`claim` includes `ticket,resources,confirmation,generation,prs`.

Common options: `--state-dir PATH --session-id ID --harness NAME`.
Every post-boot mutation and `check-owner` requires `--generation ID`
(`AGENT_SESSION_GENERATION`). Assigned workers instead pass
`--owner-session-id ID --owner-harness NAME --owner-generation ID`
(`AGENT_OWNER_SESSION_ID`, `AGENT_OWNER_HARNESS`, `AGENT_OWNER_GENERATION`).
These flags identify accountability; they are not authentication credentials.

| Command | Additional flags | Result |
| --- | --- | --- |
| `boot` | `--role pm` or `--role tl --lane NAME` | `session` |
| `current` | none | `session` |
| `list` | none | active `sessions` |
| `resolve` | `--name NAME` | `session` |
| `claim` | `--ticket ID --confirmation REF [--resource KEY ...]` | `session,claim` |
| `owner`, `check-owner` | exactly one of `--ticket ID`, `--pr ID` | `session,claim` |
| `associate-pr` | `--ticket ID --pr ID` | `session,claim` |
| `release` | `--ticket ID --quiescence REF --branch REF` | `session` |
| `end` | none | ended `session` |
| `send` | `--to NAME` or `--ticket ID [--triage NAME]`, `--subject TEXT --body-file PATH` | `messages` with recipient `session,id,path` |
| `broadcast` | `--lane NAME --subject TEXT --body-file PATH` | independent `messages` |
| `archive-message` | `--message ID` | `message` |

The **registry mutex** is the exclusive mkdir guard that serializes registry
reads and writes. The registry is committed by atomic replacement under that
mutex, with bounded acquisition and file and directory sync. Delivery is recorded before inbox
materialization; run `boot` to materialize recorded mail after an I/O failure. Inspect the
recipient inbox before sending again; repeating `send` creates a new message.
An occupied registry mutex or incomplete state requires owner inspection and restoration
from durable evidence before manual recovery. Never remove the registry mutex or reuse a
name because a process disappeared. The tool makes no tracker API calls.
