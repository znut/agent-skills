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

## 1. Confirm the reviewed tip

Use the paused worker's worktree. Do not create another worktree. The task must
give the worktree path, reviewed SHA, and frozen default-branch SHA.

Run `git rev-parse HEAD` and confirm that it matches the named review commit.
Run `git status --porcelain` and require no output. Return `ERROR` if the commit
does not match or the worktree is not clean. Do not edit source or doc files.

## 2. Read current rules

Use the frozen default-branch SHA supplied by the worker. Do not fetch, update a
ref, or run any other Git write. Read `.agent/orchestrate.md` with
`git show <frozen-default-sha>:.agent/orchestrate.md`. Read the review checklist
path, script, marker, hook, and default branch from that file.

If the main file does not exist, read `.claude/orchestrate.md`. Follow its link
when it points to the main file. A full legacy `.claude/orchestrate.md` may
supply the rules for this run. Note that the repo should move those rules to
`.agent/orchestrate.md`.

Read the named checklist from the same frozen commit. If no repo rules or
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

From the worker worktree, run:

```sh
git diff <frozen-default-sha>...HEAD
git diff --name-status <frozen-default-sha>...HEAD
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
not change meaning. The project checklist decides which severities block a
`PASS` and how to handle nonblocking findings. List a new checklist candidate
only when the same mistake could recur.

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

Run `git rev-parse HEAD` and `git status --porcelain` again after review. Return
`ERROR` if the SHA moved or status is not clean. Return `BLOCK` when `blockers`
has an item. Return `PASS` only after the full scan and review with no blocker.
A `PASS` may include nonblocking findings when project rules define them.
Return `ERROR` when a tool, runtime, dirty worktree, changed SHA, or missing
input stops the full review. `ERROR` does not use a review attempt.

## 7. After `BLOCK`

After the first or second `BLOCK`, the same running worker fixes every finding,
runs checks, commits, confirms a clean worktree, and starts a fresh reviewer on
the new tip in the same worktree.

After the third `BLOCK`, the worker confirms a clean committed tip, pushes its
task branch, and opens no PR. The manager sends the branch and all findings to
the next worker type. The last worker type stops and reports to the user after
its third `BLOCK`.

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

The marker is the only file that a reviewer may write. It must not change
`HEAD`, the index, tracked files, or untracked files in the worker worktree.
