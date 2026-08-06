---
name: orchestrate
description: >
  Run repo work through subagents. Split work into small tasks, give each worker
  an isolated git worktree, check the result, and require the worker to commit,
  pass review, and deliver through the repo's chosen mode. Read project rules
  from the repo. Pair this skill with /tl for engineering work or /pm for
  product work. Trigger: "orchestrate", "fan out agents", "dispatch subagents",
  "parallel agents", "multi-agent", or "/orchestrate".
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
- worker types in order, the reviewer type, and the worker limit.

If the repo has no rules, read [bootstrap.md](bootstrap.md), ask the user for
the missing facts, and add the files through this process. Do this once. Later
runs read the files and do not read `bootstrap.md`.

Load `/tl` for engineering work or `/pm` for product work. If the role remains
unclear, ask the user before you send work to an agent.

## Duties

The manager talks with the user, settles open choices, splits the work, sends
tasks to workers, and checks each open PR. The manager does not edit a worker's
change.

The active worker owns the task from its first edit through checks, review,
push, and, when the repo uses PRs, the open PR. After a third `BLOCK`, the next
worker takes ownership. A worker may start one fresh reviewer for each review.
The reviewer uses the worker's worktree while the worker pauses. The worker may
start no other agent. A reviewer may start no agent.

The same rules apply when the manager changes repo files. Start from the right
default-branch tip, use a separate worktree, pass review with no open `BLOCK`,
and deliver through the repo's chosen mode.

Unless the repo rules choose push-only delivery, only this result counts as
done:

- all checks pass;
- a fresh reviewer returns `PASS` for the final commit with no open `BLOCK`;
- the branch exists on the remote;
- a PR exists with all required labels, text, and artifacts;
- for `draft_first: required`, the manager has checked the draft and marked its
  unchanged PR ready;
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
3. If both point to the same commit, use either. If local `<default>` is an
   ancestor of `origin/<default>`, use the remote tip.
4. If local `<default>` is ahead of `origin/<default>`, stop before work and
   ask the user to publish or undo the local commits. A PR from that base would
   include commits that the remote default branch lacks.
5. If the refs have split, stop and ask the user. Neither ref is the newer
   linear tip. Do not compare commit dates.
6. Create a new branch and worktree at the selected commit. Record the base
   SHA and confirm that `HEAD` matches it before any edit.

For a replacement worker or a higher worker type, start a new worktree at the
pushed `origin/<branch>` tip. Do not restart from the default branch. The same
running worker makes its first two review fixes in its current worktree.

Before opening a PR, confirm again that the recorded base belongs to
`origin/<default>`.

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
- Run `git status --porcelain` after the commit. Do not start review until it
  prints nothing.

### Review

- Fetch before review. If new `origin/<default>` commits change the same files,
  merge them into the task branch, rerun the needed checks, and commit the
  result before review.
- Ask a fresh agent of the repo's reviewer type to review the exact committed
  diff and run the repo's review check.
- Pause the worker. Give the reviewer the worker's worktree, reviewed SHA,
  branch, base SHA, task, acceptance rules, checklist, and changed paths. The
  reviewer must confirm that `HEAD` equals the reviewed SHA and that
  `git status --porcelain` prints nothing before and after review. Do not name
  the model that wrote the change.
- A reviewer returns `PASS`, `BLOCK`, or `ERROR`. Each `BLOCK` must name a real
  flaw and give a file and line. A crash, timeout, or tool fault returns
  `ERROR` and does not use a review attempt.
- On the first `BLOCK`, the same running worker fixes every finding, reruns
  checks, commits, confirms a clean worktree, and starts a new reviewer.
- On the second `BLOCK`, the same worker gets one more fix. It repeats the
  checks, commit, clean-worktree check, and fresh review.
- On the third `BLOCK`, rerun the required checks, commit only remaining task
  changes, confirm a clean worktree, push the continuation branch, open no PR,
  and return every finding. The manager must send the pushed branch to the next
  worker type at once.
- A project checklist may define nonblocking findings. A reviewer may return
  `PASS` with those findings; handle them as the project rules require.
- On `PASS`, make no more source or doc changes. Confirm that `HEAD` still
  equals the reviewed SHA and that `git status --porcelain` prints nothing.
  Push that exact commit. Open a PR only when the repo uses PR delivery.

### PR and cleanup

- Push with `git push -u origin <branch>`.
- Confirm that `git ls-remote origin refs/heads/<branch>` equals the reviewed
  SHA. Do not open a PR when they differ.
- If the repo rules choose push-only delivery, report the pushed branch and
  skip the rest of the PR and artifact steps.
- On `PASS`, open the PR with `gh pr create --base <default> --head <branch>`.
  When `draft_first: required` is set, pass `--draft`. Apply required labels
  and follow any check that runs before PR creation.
- Use `Resolves #N` for each ticket that should close on merge. A plain `#N`
  only links the ticket.
- Add each required artifact. Open and inspect the first artifact made by a
  new tool or fixture.
- Wait for required checks. With `draft_first: required`, report the draft to
  the manager and do not mark it ready.
- After push and PR work, run plain `git worktree remove <path>` from outside
  the worktree. Never use `--force` or a broad `git worktree prune`. A runtime
  lock means `worktree_cleanup: harness-locked`. A refusal due to changed or
  untracked files means work remains; report it.
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
reviewed_sha: <sha that passed and was pushed>
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

When a worker gets a third `BLOCK`, treat that result as work in progress. Send
a new worker of the next type the pushed branch and every finding. Do not hand
the branch to the user as the finished result. If the last worker type also
gets a third `BLOCK`, stop and report the commits, checks, and findings. Do not
create a new type.

## Review after the PR opens

The manager checks the PR but does not fix it.

1. Confirm that the exact PR head and remote branch tip match the reviewed
   commit.
2. Open the PR diff and inspect at least one changed file.
3. Confirm that CI passes, labels and text are right, and required artifacts
   exist and look right.
4. Confirm that the final review came from a fresh reviewer, its marker names
   the PR tip when the repo uses markers, and no `BLOCK` remains.
5. Check scope, decision records, secrets, `.env` files, and lockfile changes.
6. With `draft_first: required`, check the PR head again, then mark that exact
   PR ready.

If any check fails, send a fresh worker the exact findings and the pushed
branch. Do not edit the PR yourself. If all checks pass, report the ready URL
and wait for the user. The user does not review a draft PR.

If the repo provides a local PR status service, watch it after reporting the
PR. A merge notice says what happened; it does not grant approval. After the
user merges, fetch and start any task that depended on that merge.

## Worktree rules

- Each worker gets a new worktree. No two workers share one.
- A fresh reviewer may use the active worker's worktree only while the worker
  pauses and only to read the committed tip. It may write only a required
  review marker outside the worktree files.
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
| The last worker type gets a third `BLOCK`       | Stop and report every finding and saved commit.                                                                   |

## Hard rules

- The worker owns the task through the reviewed pushed branch and, when the
  repo uses PRs, the open PR.
- Only a green PR with a fresh `PASS` and no open `BLOCK` counts as delivery,
  except when repo rules choose push-only delivery.
- The manager never fixes a worker's change.
- No agent edits the user's main checkout.
- A worker starts only fresh reviewers. A reviewer starts no agent.
- Read command output before you report a result.
- Do not add secrets, `.env` files, lockfiles, or agent settings unless the task
  calls for them.
- Never merge. Wait for the user's clear approval for each PR.
