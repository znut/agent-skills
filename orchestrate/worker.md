# Worker procedure

You own one task from first edit through checks, review, push, and the open
PR. The prompt gives the ticket, worktree, base SHA, owned paths, delivery
mode, and owner session fields; this file gives the procedure. The user's
instructions win over the repo rules, and the repo rules win over this file.

## Work

- Read `.agent/orchestrate.md` and each file it names from `origin/<default>`
  with `git show origin/<default>:<path>`, then the repo docs in the stated
  order.
- Work only in the named worktree and paths. Never touch the main checkout,
  another worktree, or agent settings. A tool call the harness denies is not
  retried in another form; report it in the return.
- Make one small change that satisfies the ticket. Test project logic, edge
  cases, and known bugs; do not test the framework. Comment only where the
  code cannot state the reason itself.
- Branch as `feat/<slug>`, `fix/<slug>`, or `chore/<slug>`. Run the repo's
  checks for the changed paths; fix or report each failure. Stage only task
  files. Commit before review.
- Load `/comm` before you write a PR body, a comment, or ticket text.

## Waits

A long command of your own (a gate, a test suite, a build) runs in the
foreground under the foreground cap. If the harness backgrounds it, or you
started it in the background, wait on its output file with a foreground
until-loop, each wait under the cap, repeated until it ends. Never end your
turn while your own task runs: nobody is notified when it finishes.

A wait on an external system (a CI run, a deploy, a remote queue) is a return
point: run the checks for the work so far, commit, push, and return
`awaiting_external` with the pushed tip, the review state, the external id or
URL, one exact check command, and the ordered remaining work. The manager
watches and resumes you with the result.

## Review and delivery

Fetch; if new `origin/<default>` commits touch the same files, merge them and
rerun the checks. Push. When the repo uses draft-first PRs, open the draft now
through the repo's gh identity, with `Resolves #N` for each ticket the merge
closes and each required artifact; a repo that opens ready PRs opens after
`PASS` instead. Then pause and start one fresh reviewer of the repo's reviewer
type on your worktree, or the panel the repo derives from the diff, started
concurrently. Each follows `/review-gate` with the reviewed SHA, the base
SHA, the frozen default-branch SHA (the `origin/<default>` tip you last
fetched), the task, its acceptance rules, the checklist, and the changed
paths. Do not name the model that wrote the change.

- `PASS` from every reviewer: stop editing and report.
- `BLOCK`: fix every finding, rerun the checks, commit, push, and start a
  fresh reviewer with the last reviewed SHA and the open findings; it reviews
  the delta since that SHA. One fold only: after a second `BLOCK`, push what
  you have, open no further PR, and return every finding; the manager sends
  the branch to the next worker type.
- `ERROR`: start another reviewer. An error uses no attempt.

Remove your worktree with plain `git worktree remove <path>` from outside it
once the task is delivered; report `harness-locked` when the harness holds it.
Never force-remove a dirty worktree. Never merge.

## Return

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
