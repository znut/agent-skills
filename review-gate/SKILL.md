---
name: review-gate
description: >
  Check a finished branch before PR creation. Read the repo's current review
  rules, scan added lines, review the exact committed diff, and return PASS,
  BLOCK, or ERROR. On PASS, write a marker bound to the reviewed commit.
  Trigger: "/review-gate", "review gate", "pre-PR review", or a review request
  from /orchestrate.
---

# Review gate

Run this skill once for each committed tip before a PR opens. Run it again
after any fix commit.

The diff author must start a fresh reviewer of the type named in the repo
rules. Provider agent files choose its model and effort. This skill does not
choose them.

## 1. Confirm the reviewer worktree

The reviewer must work in its own detached git worktree at the commit under
review. It must not use the author's worktree. The task must give both paths so
the reviewer can confirm that they differ.

Run `git rev-parse HEAD` and confirm that it matches the named review commit.
Return `ERROR` if the worktree or commit does not match. Do not edit source or
doc files.

## 2. Read current rules

Run `git fetch origin -q`. Read `.agent/orchestrate.md` from the remote default
branch with `git show origin/<default>:.agent/orchestrate.md`. Read the review
checklist path, script, marker, hook, and default branch from that file.

If the main file does not exist, read `.claude/orchestrate.md`. Follow its link
when it points to the main file. A full legacy `.claude/orchestrate.md` may
supply the rules for this run. Note that the repo should move those rules to
`.agent/orchestrate.md`.

Read the named checklist from the same remote default tip. If no repo rules or
checklist exist, use this list and tell the parent:

- correctness;
- auth and access control;
- injection, secrets, and unsafe data use;
- dead code;
- test quality;
- extra code or process that the task does not need.

During the first rules PR, the task supplies the user's approved setup facts
and generic checks because the remote default branch has no rules yet.

## 3. Resolve the diff

From the reviewer worktree, run:

```sh
git diff origin/<default>...HEAD
git diff --name-status origin/<default>...HEAD
```

Check only that diff and the task's acceptance rules. Do not add scope.

## 4. Scan added lines

If the repo rules name a review script, run it once with the base and branch or
commit that its help text requires.

If the checklist gives a table instead, scan only added diff lines for each
pattern. Keep each hit at the stated severity. When a rule names an exception,
decide from the diff whether it applies. Do not drop the hit without checking.

## 5. Apply the right sections

Match changed paths to the checklist's path tags. Apply only matching sections
and every section marked `always`. Run each extra skill that the checklist maps
to a changed file type.

Review the diff yourself. Start no agent. The author must not review its own
work.

Each finding uses one line:

```text
path:line: <severity>: <rule> — <problem>. <fix>.
```

Report real flaws. Do not praise, widen scope, or report style points that do
not change meaning. List a new checklist candidate only when the same mistake
could recur.

## 6. Return a result

Use this form:

```yaml
verdict: PASS | BLOCK | ERROR
blockers:
  - path:line: <place>
    rule: <rule>
    problem: <problem>
    fix: <fix>
should_fix:
  - path:line: <place>
    rule: <rule>
    problem: <problem>
    fix: <fix>
checklist_candidates: [<candidate>]
error: <why review could not finish, or null>
```

Return `BLOCK` when `blockers` has an item. Return `PASS` only after the full
scan and review with no blocker. Return `ERROR` when a tool, runtime, missing
worktree, or missing required input stops the full review. `ERROR` does not use
a review attempt.

## 7. After `BLOCK`

The same running author fixes findings while its count remains below the repo
limit. It runs checks, commits, and starts a new reviewer in a new detached
worktree. The new reviewer repeats this skill for the new commit.

At the limit, the author pushes its task branch and opens no PR. The manager
sends the branch and all findings to the next worker type. The last worker type
stops and reports to the user when it reaches the same limit.

## 8. Write the PASS marker

Only after `PASS`, bind the marker to the reviewed branch tip.

Use the marker command from the repo rules when one exists:

```sh
bash <marker-script> <branch>
```

Otherwise run these commands one at a time. Do not join them with command
substitution.

```sh
git rev-parse --git-common-dir
mkdir -p "<common-dir>/.review-gate"
git rev-parse "refs/heads/<branch>" > "<common-dir>/.review-gate/<branch with / replaced by __>"
```

The marker must equal the branch tip. A later commit voids it and requires a
new review. Always pass `--head <branch>` to `gh pr create` so the hook checks
the right marker.

The marker is the only file that a reviewer may write. After the result and
marker, the parent removes the reviewer worktree with plain
`git worktree remove <path>`. It never uses `--force`.
