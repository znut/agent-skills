---
name: orchestrate
description: >
  Run repo work through subagents so the manager stays free for the user.
  Split work into small tasks, give each worker an isolated git worktree, and
  require the worker to commit, pass a fresh review, and deliver through the
  repo's delivery mode. Read project rules from the repo. Trigger:
  "orchestrate", "fan out agents", "dispatch subagents", "parallel agents",
  "multi-agent", or "/orchestrate".
---

# Orchestrate

This skill is the delivery engine: how a task becomes a reviewed, pushed
branch or a ready PR. The manager decides which work and holds the bar for
it; [worker.md](worker.md) is the worker's contract; `/review-gate` is the
reviewer's procedure. The user's instructions win over the repo rules, and the
repo rules win over these skills.

## Why delegate

The manager is the session the user talks to. Its first job is to stay
available, so it hands work off instead of doing it:

- Send a worker any task that saves the user's time, improves the result, or
  lets other work proceed: anything longer than a few tool calls, anything
  that can run while you talk, and anything a fresh context does better. Send
  location questions to the harness's read-only search agent.
- Run independent tasks in parallel; run tasks that share files in order.
  Stay within the repo and harness worker limits.
- Never block your own turn. A wait longer than one command goes to a
  background watcher, and a worker reports back through the harness. After
  dispatch, return to the user; do not poll a worker or ask it for progress.
- Delegation keeps the bar. Every change goes through a worktree, the
  checks, a fresh review, and the repo's delivery mode. The manager edits a
  file itself only when the work is too small to brief, such as a few words
  in a decision record, and then follows [worker.md](worker.md) for that
  change.

## Read the repo rules

Run `git fetch origin -q`. Read `.agent/orchestrate.md` and each file it names
from the remote default branch with `git show origin/<default>:<path>`. Skip
the read only when a boot report says the rules tree (`.agent/`) is UNCHANGED
and the rules are still in this context; after a compaction, read again. If
the file does not exist, run setup from [bootstrap.md](bootstrap.md) once.

Load `/comm` for anything you write to a person.

## Roles

The manager is the session the user talks to. It settles open choices,
splits work, sends tasks, and checks each delivery. It never edits a worker's change: a
failed check goes back to a worker with the exact findings.

The worker owns a task from first edit through checks, review, push, and the
open PR, as [worker.md](worker.md) states. It starts only the review's fresh
reviewer. A reviewer starts no agent.

The manager owns every wait on an external system. When a worker returns
`awaiting_external`, watch the outcome with the harness's background watch
mechanism, then resume the same worker with the result while its transcript
lives. Stop its stray background tasks first, and start a fresh worker from
the saved state only when the resume fails.

## Choose the base

Fetch, then start from whichever of local `<default>` and `origin/<default>`
contains the other. Ask the user only when they have split. A PR cut from an
unpushed local tip carries those commits; say so in the report. Record the
base SHA. A replacement worker continues from the pushed `origin/<branch>`
tip, not from the default branch.

## Before dispatch

- A named session claims the ticket first, as [claims and handoffs](session-bus.md#claims-and-handoffs)
  states. One confirmation covers every task the user named; do not ask again
  per claim.
- Search open PRs and remote branches for the ticket and feature terms. Stop
  and ask if the work already exists.
- Settle choices that change scope or behavior. Never guess a product or
  business choice.
- A change that could harm security, auth, stored data, schema, or money may
  get two workers on the same task in separate worktrees, keeping the better
  result, when the manager judges the comparison worth twice the cost. Say so
  in the dispatch note.

## Worker prompt

Give each worker: the ticket, the absolute worktree path, the base SHA, the
paths it owns, the delivery mode, the owner session fields from the claim
when a named session runs, and the absolute path of [worker.md](worker.md). Add what this task needs and
the rules do not say: the sibling file or idiom to mirror, the trust boundary
or performance budget the reviewer must judge, and each settled choice. Do
not paste the repo rules or the worker contract; the worker reads the rules
from `origin/<default>` and the contract from its file.

## Worker types

The repo rules name logical worker types in order and a reviewer type.
Provider agent files choose their models and effort; this skill never names a
model. Start with the first type. A worker gets one fold: after its second
`BLOCK`, a new worker of the next type continues from the pushed branch with
every finding. If the last type also gets a second `BLOCK`, stop and report
the commits, checks, and findings.

## Check the PR before it is ready

The manager checks and never fixes:

1. The PR head equals the remote branch tip and the reviewed SHA.
2. The repo's proof of checks is green for that SHA: CI, or the local gate
   result the repo names.
3. The final verdict names that SHA, came from a fresh reviewer (the full
   panel where the repo derives one), and holds no open `BLOCK`.
4. Labels, text, and required artifacts are present; open one artifact.
5. Scope, decision records, secrets, `.env` files, and lockfile changes are
   what the ticket asked for.

Then mark the PR ready and report the URL. A repo may enforce these through
its gh wrapper's ready check; a refusal names what is missing, and the
manager gets that done before trying again. A push after ready voids the
check: flip the PR back to draft, recheck, and re-ready. The poller's
`ready-stale` event flags a push that slipped through. The user reviews and
merges; a merge notice is not approval, and agents never merge. After the
merge, fetch and start work that waited on it.

With push-only delivery, the same checks apply to the pushed branch and the
report ends there.

## Worktree rules

- One new worktree per worker. A reviewer may read the paused worker's
  worktree and writes nothing in it.
- `git fetch origin` is the only git write allowed in the main checkout.
- If a harness worktree holds the branch, start detached at
  `origin/<branch>` and push with `git push origin HEAD:refs/heads/<branch>`.
- Remove a stopped worker's worktree only after its useful work reached the
  remote.
