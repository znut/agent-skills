---
name: orchestrate
description: >
  Run repo work through subagents. Split work into small tasks, give each worker
  an isolated git worktree, and require the worker to commit, pass a fresh
  review, and deliver through the repo's delivery mode. Read project rules
  from the repo. Pair this skill with /tl for engineering work or /pm for
  product work. Trigger: "orchestrate", "fan out agents", "dispatch subagents",
  "parallel agents", "multi-agent", or "/orchestrate".
---

# Orchestrate

This skill is the delivery engine: how a task becomes a reviewed, pushed
branch or a ready PR. `/tl` and `/pm` decide which work; `/review-gate` is the
reviewer's procedure. The user's instructions win over the repo rules, and the
repo rules win over this skill.

## Read the repo rules

Run `git fetch origin -q`. If the role's boot report says the rules tree
(`.agent/`) is UNCHANGED since this role last read it, skip the read and grep
one section from the remote tip when a rule is in doubt. Otherwise read
`.agent/orchestrate.md` and each file it names from the remote default branch
with `git show origin/<default>:<path>`, then write the stamp the report
prints. If the file does not exist, run setup from [bootstrap.md](bootstrap.md)
once.

Load `/comm` for anything you write to a person. Tell each worker to load it
at the PR step, before it writes the PR body, comments, or ticket text.

## Roles

The manager talks with the user, settles open choices, splits work, sends
tasks, and checks each PR. It never edits a worker's change: a failed check
goes back to a worker with the exact findings.

The worker owns a task from first edit through checks, review, push, and the
open PR. It starts only the review's fresh reviewer. A reviewer starts no agent.

The manager owns every wait on an external system. When a worker returns
`awaiting_external`, watch the outcome with the harness's watch mechanism,
then resume the same worker with the result while its transcript lives. Stop
its stray background tasks first, and start a fresh worker from the saved
state only when the resume fails.

The same rules apply when the manager changes repo files itself: a worktree,
checks, a fresh review, and the repo's delivery mode.

## Choose the base

Fetch, then start from whichever of local `<default>` and `origin/<default>`
contains the other. Ask the user only when they have split. A PR cut from an
unpushed local tip carries those commits; say so in the report. Record the
base SHA. A replacement worker continues from the pushed `origin/<branch>`
tip, not from the default branch.

## Before dispatch

- Named PM/TL sessions follow [claims and handoffs](session-bus.md#claims-and-handoffs):
  confirm with the user, claim the ticket and its shared resources, then
  recheck for existing work.
- Search open PRs and remote branches for the ticket and feature terms. Stop
  and ask if the work already exists.
- Settle choices that change scope or behavior. Never guess a product or
  business choice.
- Run independent tasks in parallel when that saves time; run tasks that share
  files in order. Stay within the repo and harness worker limits.
- For a change that could harm security, auth, stored data, schema, or money,
  run two workers on the same task in separate worktrees and keep the
  better result.
- Send location questions to a read-only search agent when the harness has one.

## Worker prompt

Give each worker the ticket, the worktree path, the base SHA, the paths it
owns, the repo's code rules copied word for word, and the owner session
fields from the claim. Then the contract:

- Read the repo rules and review checklist from `origin/<default>`, then the
  repo docs in the stated order.
- Work only in the named worktree and paths. Never touch the main checkout,
  another worktree, or agent settings.
- Make one small change that satisfies the ticket. Test project logic, edge
  cases, and known bugs; do not test the framework. Comment only where the
  code cannot state the reason itself.
- Branch as `feat/<slug>`, `fix/<slug>`, or `chore/<slug>`. Run the repo's
  checks for the changed paths; fix or report each failure. Stage only task
  files. Commit before review.
- **External waits.** A long command of your own (a gate, a test suite, a
  build) runs in the foreground under the foreground cap. If the harness
  backgrounds it, or you started it in the background, wait on its output
  file with a foreground until-loop, each wait under the cap, repeated until
  it ends; never end your turn while your own task runs — nobody is
  notified when it finishes. A wait on an EXTERNAL system (a CI run, a deploy,
  a remote queue) is a return point: run the checks for the work so far,
  commit, push, and return `awaiting_external` with the pushed tip, the
  review state, the external id or URL, one exact check command, and the
  ordered remaining work. The manager watches and resumes you with the result.
- **Review.** Fetch; if new `origin/<default>` commits touch the same files,
  merge them and rerun the checks. Push. When the repo uses draft-first PRs,
  open the draft now through the repo's gh identity, with `Resolves #N` for
  each ticket the merge closes and each required artifact; a repo that opens
  ready PRs opens after `PASS` instead. Then pause and start one fresh
  reviewer of the repo's reviewer type on your worktree, or the panel the repo
  derives from the diff, started concurrently. Each follows `/review-gate`
  with the reviewed SHA, base SHA, frozen default-branch SHA, task, acceptance
  rules, checklist, and changed paths. Do not name the model that wrote the
  change.
  - `PASS` from every reviewer: stop editing and report.
  - `BLOCK`: fix every finding, rerun the checks, commit, push, and start a
    fresh reviewer with the last reviewed SHA and the open findings; it
    reviews the delta since that SHA. After the third `BLOCK`, push what you
    have, open no further PR, and return every finding; the manager sends
    the branch to the next worker type.
  - `ERROR`: start another reviewer. An error uses no attempt.
- Remove your worktree with plain `git worktree remove <path>` from outside it
  once the task is delivered; report `harness-locked` when the harness holds
  it.
- Never merge.

Return:

```yaml
status: pass | blocked | awaiting_external
branch: <branch>
reviewed_sha: <sha>
pr_url: <url or n/a>
review: <rounds, final verdict, where it is recorded, open findings>
open_questions: [<question and owner>]
worktree: removed | harness-locked
awaiting: <external id or URL, one exact check command, ordered remaining work; only with awaiting_external>
```

Put each open question in the PR body.

## Worker types

The repo rules name logical worker types in order and a reviewer type.
Provider agent files choose their models and effort; this skill never names a
model. Start with the first type. After a third `BLOCK`, a new worker of the
next type continues from the pushed branch with every finding. If the last
type also gets a third `BLOCK`, stop and report the commits, checks, and
findings.

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
merges; agents never merge. After the merge, fetch and start work that waited
on it.

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
