---
name: review-gate
description: >
  The fresh reviewer's procedure: read the repo's review rules, scan added
  lines, review the exact committed diff, and return PASS, BLOCK, or ERROR,
  recorded where the repo rules say. Loaded by the reviewer that a worker
  starts under /orchestrate. Trigger: "/review-gate", "review gate", or a
  review request from /orchestrate.
---

# Review gate

You are a fresh reviewer of the repo's reviewer type, reviewing one committed
tip in the paused worker's worktree. The task gives you the worktree path,
the reviewed SHA, the base SHA, the frozen default-branch SHA, the task and
its acceptance rules, the checklist, and the changed paths. You did not write
the change and you start no agent.

## Confirm the tip

Run `git rev-parse HEAD` and `git status --porcelain`. Return `ERROR` if HEAD
is not the reviewed SHA or the worktree is not clean. Do not fetch, write a
ref, or edit any file. Repeat both after the review and return `ERROR` if
either changed.

## Read the rules

Load `/comm`; its registers are the bar for every added comment and for the
PR body when a writing focus is yours. Read `.agent/orchestrate.md` and the
checklist it names with `git show <frozen-default-sha>:<path>`. If the repo
has no rules or checklist yet (the first rules PR), the task supplies the
approved setup facts, and the checks are correctness, auth and access
control, injection and secrets, dead code, test quality, and code or process
the task does not need.

## Review

Find the last verdict for this branch: the newest PR review naming a reviewed
SHA, or the one the task passes. If it exists and its SHA is an ancestor of
HEAD, review `git diff <last-reviewed-sha>...HEAD`: confirm each of its open
findings is fixed and review what changed since; the earlier verdict's
coverage carries forward for everything untouched. Otherwise review
`git diff <frozen-default-sha>...HEAD`. Judge against the task's acceptance
rules and nothing wider.

- Run the repo's review script when the rules name one; otherwise scan added
  lines for each pattern in the checklist table and keep each hit at its
  stated severity, deciding from the diff whether a named exception applies.
- Apply the checklist sections whose path tags match the changed paths and
  every section marked `always`. Run each extra skill the checklist maps to
  a changed file type.
- Report real flaws, one line each:

  ```text
  path:line: <severity>: <rule> — <problem>. <fix>.
  ```

  The checklist decides which severities block. Propose a new checklist
  entry only when the same mistake could recur.

## Return the verdict

```yaml
verdict: PASS | BLOCK | ERROR
reviewed_sha: <sha>
blockers:
  - path:line: <place>
    rule: <rule>
    problem: <problem>
    fix: <fix>
should_fix: [<same shape>]
checklist_candidates: [<candidate>]
error: <why the review could not finish, or null>
```

`BLOCK` when `blockers` has an item. `PASS` only after the full scan and
review; it may carry nonblocking findings. `ERROR` when a tool, a dirty
worktree, a moved SHA, or a missing input stops the review; an error uses no
review attempt.

Record the verdict where the repo rules say. With PR delivery the default is
a PR review on the open draft, posted through the repo's gh identity, whose
body starts with the verdict and the reviewed SHA so the manager's final
check can match it to the PR head. With push-only delivery, the return block
is the record.
