---
name: orchestrate
description: >
  Run repo work through subagents. Split work into small tasks, give each worker
  an isolated git worktree, check the result, and require the worker to commit,
  push, and open one small PR. Read project rules from the repo. Pair this skill
  with /tl for engineering work or /pm for product work. Trigger: "orchestrate",
  "fan out agents", "dispatch subagents", "parallel agents", "multi-agent",
  or "/orchestrate".
---

# Orchestrate

This skill tells agents how to deliver work. It does not decide which work a
PM or TL owns.

## Read the repo rules

Run `git fetch origin -q`. Read `.agent/orchestrate.md` from the remote default
branch with `git show origin/<default>:.agent/orchestrate.md`. If that file does
not exist, read `.claude/orchestrate.md`. Follow its link when it points to the
main file. A full legacy `.claude/orchestrate.md` may supply the rules for that
run; ask the user whether to move it to `.agent/orchestrate.md`. If neither file
supplies rules, run setup. Read each named file from the same remote tip.

The repo rules must state:

- the remote and default branch;
- git and host identity;
- doc read order;
- check commands;
- the review check and checklist;
- PR labels, state, body, and issue links;
- artifact rules;
- code rules for workers;
- worker types in order, the reviewer type, allowed `BLOCK` results, and the
  worker limit.

If the repo has no rules, read [bootstrap.md](bootstrap.md), ask the user for
the missing facts, and add the files through this process. Do this once. Later
runs read the files and do not read `bootstrap.md`.

Load `/tl` for engineering work or `/pm` for product work. If the role remains
unclear, ask the user before you send work to an agent.

## Duties

The manager talks with the user, settles open choices, splits the work, sends
tasks to workers, and checks each open PR. The manager does not edit a worker's
change.

One worker owns one task from its first edit through checks, review, push, and
PR. A worker may start one fresh reviewer for each review. Give each reviewer
its own detached worktree at the commit under review. The worker may start no
other agent. A reviewer may start no agent.

The same rules apply when the manager changes repo files. Start from the right
default-branch tip, use a separate worktree, pass review with no open `BLOCK`,
push, open a PR, and wait for the user.

Unless the repo rules choose push-only delivery, only this result counts as
done:

- all checks pass;
- a fresh reviewer returns `PASS` for the final commit with no open `BLOCK`;
- the branch exists on the remote;
- a PR exists with all required labels, text, and artifacts;
- the agent reports the PR URL.

Then wait for the user's review and clear approval. Never merge.

With push-only delivery, require the same base, worktree, checks, commit, and
fresh `PASS`. Push the reviewed commit and report the branch. Skip PR, label,
and PR artifact steps.

## Choose the base

Before each first dispatch:

1. Run `git fetch origin` in the main checkout. Do not edit, switch branches,
   pull, commit, or merge there.
2. Compare local `<default>` with `origin/<default>` by ancestry.
3. If one points to an ancestor of the other, use the newer descendant. If
   both point to the same commit, use either. If they have split, stop and ask
   the user. Do not compare commit dates.
4. Create a new branch and worktree at that commit. Record the base SHA and
   confirm that `HEAD` matches it before any edit.

For a fix or a higher worker type, start a new worktree at the pushed
`origin/<branch>` tip. Do not restart from the default branch.

Before opening a PR, confirm that the recorded base belongs to
`origin/<default>`. If local `<default>` supplied a newer base that the remote
does not yet contain, stop. A PR at that point would include those extra
commits.

## Before dispatch

- Search open PRs and remote branches for the ticket number, feature terms,
  and planned branch name. Stop and ask the user if the work already exists.
- Settle choices that change scope or behavior.
- Give parallel workers separate files. Run work that shares files in order.
- Keep the number of live workers within both the repo and runtime limits.
- Use one worker for normal work. Use two separate workers only when a wrong
  choice could harm security, auth, stored data, schema changes, or money. Give
  them the same task in separate worktrees, compare the results, and keep one.
- Send read-only location questions to a read-only search agent when the
  runtime provides one.

## Worker prompt

Every worker prompt must state all of the following.

### Rules and scope

- First read the repo rules and review checklist from `origin/<default>` with
  `git show`. Then read the repo docs in the stated order.
- Work only in the named worktree and only on the named paths.
- Make one small change. Write only the code, tests, and comments the task
  needs. Test project logic, important edge cases, and known bugs. Do not test
  framework behavior. Add a comment only when the code cannot state the reason
  or rule on its own.
- Copy the repo's code rules into the prompt without changing their words.
- Never edit the main checkout, another worktree, or user agent settings.
- Start no agent except one fresh reviewer per review round. The reviewer must
  start no agent.

### Branch and checks

- For first work, follow **Choose the base** and create a branch named
  `feat/<slug>`, `fix/<slug>`, or `chore/<slug>`.
- For later work, continue from the pushed `origin/<branch>` tip in a new
  worktree.
- Run every check that the repo rules require for the changed paths. Read the
  command output. Fix each failure or report the exact failure.
- Stage only task files. Do not use `git add .`. Commit before review.

### Review

- Fetch before review. If new `origin/<default>` commits change the same files,
  merge them into the task branch, rerun the needed checks, and commit the
  result before review.
- Ask a fresh agent of the repo's reviewer type to review the exact committed
  diff and run the repo's review check.
- Create a separate detached worktree at that commit for the reviewer. Give it
  that worktree, the author worktree path only for an identity check, the
  branch, base SHA, task, acceptance rules, checklist, and changed paths. No
  reviewer may use the author's worktree. Do not name the model that wrote the
  change.
- A reviewer returns `PASS`, `BLOCK`, or `ERROR`. Each `BLOCK` must name a real
  flaw and give a file and line. A crash, timeout, or tool fault returns
  `ERROR` and does not use a review attempt.
- After each `BLOCK` below the allowed count, the same running worker fixes
  every finding, reruns checks, and commits. A new reviewer then checks the new
  commit.
- After the repo's allowed number of `BLOCK` results, rerun lint, commit all
  remaining task changes, push the branch, open no PR, and return every
  finding. The manager must send the pushed branch to the next worker type at
  once.
- On `PASS`, make no more code or doc changes. Push that reviewed commit and
  open the PR.

### PR and cleanup

- Push with `git push -u origin <branch>`.
- If the repo rules choose push-only delivery, report the pushed branch and
  skip the rest of the PR and artifact steps.
- On `PASS`, open the PR with `gh pr create --base <default> --head <branch>`.
  Apply the required labels and draft state. Follow any check that runs before
  PR creation.
- Use `Resolves #N` for each ticket that should close on merge. A plain `#N`
  only links the ticket.
- Add each required artifact. Open and inspect the first artifact made by a
  new tool or fixture.
- After push and PR work, run plain `git worktree remove <path>` from outside
  the worktree. Never use `--force` or a broad `git worktree prune`. A runtime
  lock means `worktree_cleanup: harness-locked`. A refusal due to changed or
  untracked files means work remains; report it.
- Remove each reviewer worktree after its reviewer returns. Apply the same
  plain-remove and no-force rules.
- Wait for the user's review and clear approval. Never merge.

### Return form

```yaml
status: pass | blocked
worker_type: <repo agent type>
base_sha: <sha>
branch: <branch>
pr_url: <url on pass; n/a on blocked>
labels: [<labels>]
summary: <what changed and why>
files_changed: [<paths>]
diff_stat: <summary>
verify:
  typecheck: pass | n/a
  lint: pass | n/a
  test: pass | n/a
review: <rounds and final result>
review_findings: [<open BLOCK findings copied word for word>]
artifacts: <urls or n/a>
open_questions: [<question and owner>]
worktree_cleanup: removed | harness-locked | failed
```

Put each open question in the PR body. Never guess a product or business
choice.

## Worker types and review results

The repo rules name logical worker and reviewer types. Provider files choose
their models and effort. This skill must not name, map, or guess provider
models.

Start with the first worker type unless the repo rules allow another start.
Do not raise the type because a task looks hard. Do not pass a model or effort
override. Provider agent files choose both.

When a worker uses all allowed `BLOCK` results, treat that result as work in
progress. Send a new worker of the next type the pushed branch and every
finding. Do not hand the branch to the user as the finished result. If the last
worker type also uses all allowed `BLOCK` results, stop and report the commits,
checks, and findings. Do not create a new type.

## Review after the PR opens

The manager checks the PR but does not fix it.

1. Confirm that the remote branch tip matches the reviewed commit.
2. Open the PR diff and inspect at least one changed file.
3. Confirm that CI passes, labels and text are right, and required artifacts
   exist and look right.
4. Confirm that the final review came from a fresh reviewer, its marker names
   the PR tip when the repo uses markers, and no `BLOCK` remains.
5. Check scope, decision records, secrets, `.env` files, and lockfile changes.

If any check fails, send a fresh worker the exact findings and the pushed
branch. Do not edit the PR yourself. If all checks pass, report the URL and
wait for the user.

If the repo provides a local PR status service, watch it after reporting the
PR. A merge notice says what happened; it does not grant approval. After the
user merges, fetch and start any task that depended on that merge.

## Worktree rules

- Each worker gets a new worktree. No two agents share one.
- Each reviewer gets a new detached worktree at the commit it reviews. It must
  not use the author's worktree.
- Keep all edits and git writes out of the main checkout. `git fetch origin`
  is the only allowed main-checkout git write.
- A later worker may need a detached worktree because an old runtime worktree
  still holds the branch. Start at `origin/<branch>`, then push with
  `git push origin HEAD:refs/heads/<branch>`. Before a SHA marker runs, update
  the local branch ref to the commit under review.
- If a push conflicts, update the branch in its worktree, rerun all checks and
  review, then push again.
- If a worker stops before it cleans up, remove only its named worktree after
  you confirm that all useful work reached the remote or no longer matters.

## Failures

| Problem                                         | Action                                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A check fails                                   | The running worker fixes it. If it cannot continue, send a fresh worker of the same type the exact output.        |
| A worker stops or returns nothing               | Inspect its branch and worktree without changing them, then send a fresh worker of the same type the saved state. |
| A worker waits on a command but does not return | Wait for the normal command time, inspect its saved state, then continue with a fresh worker if needed.           |
| A push conflicts                                | Update in the worktree, rerun checks and review, then push.                                                       |
| Scope grows                                     | Split it into small tasks and separate PRs.                                                                       |
| A product choice remains open                   | Ask the user. Do not guess.                                                                                       |
| The last worker type uses all `BLOCK` results   | Stop and report every finding and saved commit.                                                                   |

## Hard rules

- The worker owns the task through the open PR.
- Only a green PR with a fresh `PASS` and no open `BLOCK` counts as delivery,
  except when repo rules choose push-only delivery.
- The manager never fixes a worker's change.
- No agent edits the user's main checkout.
- A worker starts only fresh reviewers. A reviewer starts no agent.
- Read command output before you report a result.
- Do not add secrets, `.env` files, lockfiles, or agent settings unless the task
  calls for them.
- Never merge. Wait for the user's clear approval for each PR.
