---
name: orchestrate
description: >
  Generic orchestration loop: stay conversational with the user, decompose
  intent into small independent tasks, dispatch subagent workers each in an
  isolated git worktree in parallel, verify their output against a quality
  gate, then the worker commits → pushes → opens one small, labeled PR per
  task via `gh` CLI (draft vs ready per the repo's conventions). Project-specific facts (verify commands,
  labels, review gates, artifact rules) come from the repo's conventions file
  — this skill is project-agnostic. It is the dispatch ENGINE, not a role:
  pair it with a lane skill (`/tl` for tech-lead work, `/pm` for
  product/requirements work).
  Trigger: "orchestrate", "fan out agents", "dispatch subagents",
  "run this as parallel tasks", "multi-agent", "/orchestrate".
---

## Step 0 — load the repo conventions file, and your role skill

Before anything else, resolve and read the repo's orchestration conventions
from the **default branch tip**, not a possibly-stale checkout. Prefer the
provider-neutral `.agent/orchestrate.md`; fall back to a provider shim such as
`.claude/orchestrate.md`, and follow it when it points to the canonical file.
Run `git fetch origin -q`, then use `git show origin/<default>:<path>` for the
conventions and every file they reference. Worktrees fork at dispatch time;
conventions move faster. The file defines the project-specific layer this
engine slots into:

- repo/remote/default branch + bot identity (token, git user)
- workspace layout + agent read order
- **verify gate** commands (typecheck / lint / test, and how to scope them)
- **review gate** (e.g. a pre-PR review skill) and any enforcement hooks
- **PR conventions**: label scheme + how to pick labels, issue-closing keywords, body template
- **artifact rules** (e.g. screenshots for UI PRs) and how to produce/host them
- project-specific code rules to inject into worker prompts (banned APIs, required libs)
- ordered worker agent types, reviewer agent type, review allowance, and any
  provider-specific approval rules
- optionally a **worker-scoped conventions file** — a leaner file holding what workers/reviewers need (identity, verify gate, review gate, PR conventions, code rules); worker contracts then name THAT file as their read order, and workers skip the orchestrator-side conventions entirely

**If no conventions file exists — run the bootstrap interview once for the
repo: follow `bootstrap.md` in this skill's directory.** Use the runtime's user
input mechanism, generate the canonical conventions plus provider-native agent
definitions, and land them through the normal pipeline. Never re-interview
while the file exists; edit it instead.

Everything below marked **[conventions]** means: the concrete value comes from that file.

**This skill is an engine, not a role.** It says how to dispatch, verify, and land work — not what work is yours. Load the lane skill that says who you are:

- **`/tl`** — tech lead: takes a Ready queue, dispatches workers, final-checks PRs, owns ADRs. Picks a lane first if the conventions declare more than one.
- **`/pm`** — product manager: grills requirements, writes PRDs, cuts tickets, locks designs. No lane; its workers write docs, not app code.

Both may be loaded at once on a small project. If neither is loaded and the work is ambiguous, ask the user which role you're in before dispatching.

---

## Roles

| Actor                          | Responsibility                                                                                                                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orchestrator (main thread)** | Talk to user, refine questions, decompose tasks, dispatch workers, then **final-check the worker's opened PR**. Does NOT implement, and does NOT push or open PRs on the worker's behalf.                                          |
| **Workers (subagents)**        | Own the ENTIRE pipeline for one task: implement → fresh-reviewer gate → fix until green → push. On PASS, open the labeled PR and return its URL; if review-blocked, return the pushed continuation branch + findings without a PR. |

> **A wrong or red PR gets a FRESH worker re-dispatched with the findings** — the orchestrator fixes nothing inline. The main thread hand-edits only its OWN work (skills, memory, chores it owns).

> **Every worker-tier dispatch and every review round = a NEW agent** with a
> fully self-contained prompt: branch name + current state, findings verbatim,
> pipeline steps. A still-running worker folds findings from its first blocked
> review; never resume a completed worker or reviewer. One exception: message a
> STILL-RUNNING worker to adjust its in-flight scope. The orchestrator's session
> is the only long-running context.

---

## The worker pipeline (every worker runs ALL of this before returning)

1. **Implement** one small logical change in its worktree (reads the **[conventions]** read-order docs first).
2. **Verify gate**: run the **[conventions]** typecheck/lint/test commands, scoped to the touched workspace when possible. All green.
3. **Review gate — fresh reviewer, never yourself**: FIRST re-freshen the base — `git fetch origin`; if `origin/<default>` moved onto files your diff touches, merge it in and re-run the affected verify steps BEFORE spawning the reviewer (a review on a stale base wastes the whole round — two rounds were burned on this in one day). Then spawn ONE fresh review subagent using the **[conventions]** reviewer agent type to run the **[conventions]** review gate on the diff. **The author of a diff never reviews it** — a clean context is the mechanism. Give the reviewer the branch + worktree path, acceptance criteria, and reviewer-contract items; never tell it what engine wrote the diff. After a substantive `BLOCK`, the same running worker folds every must-fix, commits, and spawns a NEW reviewer for the next round. When the **[conventions]** review allowance is exhausted, set the result to `blocked`; finish lint, commit, push, cleanup, and structured return, but skip PR creation and artifacts. The orchestrator owns tier escalation. Reviewer crashes, timeouts, and tooling failures do not consume the allowance. (Chain depth caps at manager → worker → reviewer; the reviewer spawns NOTHING.)
4. **Lint until green** exactly the way **[conventions]** says CI validates it (some setups need explicit file paths or a commit to trigger staged-file hooks — the conventions file documents the traps).
5. **Push** the branch (`git push -u origin <branch>`), including a blocked branch so the next tier has a durable continuation point.
6. **Open the PR on PASS only** (`gh pr create`) **with the labels the conventions' scheme assigns** (`--label`) and the draft/ready state the conventions define, honoring any pre-PR enforcement hook. A blocked result opens no PR.
7. **Artifacts on PASS only**: produce + attach whatever **[conventions]** requires for this diff type (e.g. screenshot for UI changes). A blocked result reports `n/a`.
8. **Self-clean**: attempt to remove your own worktree (see Worktree lifecycle — plain `git worktree remove <path>` from outside it, never `--force`). A runtime pid-lock refusal is EXPECTED for session-managed worktrees — report `worktree_cleanup: harness-locked` and move on. A modified/untracked-files refusal = unpushed work — report that loudly instead.
9. **Return** the structured result: PR URL on pass, or pushed branch plus all unresolved findings on blocked. Done.

Workers use the **[conventions]** bot identity for push / PR / uploads.

---

## Task contract — required in every worker prompt

Every worker prompt MUST include:

1. **Read order**: FIRST the conventions file (the worker-scoped conventions file when the repo declares one) + review checklist **from `origin/<default>` tip via `git show`** (your worktree copy may predate rule changes — quote this instruction verbatim in the prompt), then the **[conventions]** doc read order (project docs → plan → decisions → scoped plan/progress). When the orchestrator relays a project rule into a prompt, it QUOTES the conventions wording verbatim — paraphrasing has diluted rules into violations.
2. **Scope**: "Work only inside your worktree. Touch only `<declared paths>`. One logical change. Keep it small."
3. **Branch**: "Create branch `feat/<slug>` | `fix/<slug>` | `chore/<slug>` branched from **latest `origin/<default>`**. FIRST run `git fetch origin && git checkout -B <branch> origin/<default>`, then `git log -1 origin/<default>` and confirm your HEAD matches it. If your worktree HEAD ≠ `origin/<default>`, reset onto it before writing a line of code — stale local state is the trap."
4. **Verify gate**: "Before returning, run the **[conventions]** verify commands (scoped). Do not return if any fail — fix or report."
   4b. **Code & test economy (DEFAULT TO LESS)**: "Write the MINIMUM code that is correct, clear, and meets the task. Prefer the simpler design that satisfies the spec; skip speculative flexibility and machinery the requirement doesn't need. **Tests: cover OUR logic + the load-bearing edge cases + known bugs — the framework's own behavior and input permutations stay untested.** A focused ~8–15 test suite beats 32. Match the surrounding code's density + comment level. **Comments: none unless necessary — make the code self-describe (clear names, small functions, obvious structure). A comment must ADD VALUE the code cannot: non-obvious why, a gotcha/invariant, or a decision-record/spec ref for business rules. Never provenance (names/dates/'per <person>' as authority — that lives in git blame and tickets), never WHAT the code already shows.** If unsure whether something is needed, leave it out and note it in open_questions."
   4c. **Project code rules**: paste the **[conventions]** worker code-rules block verbatim (banned APIs, required shared libs, style constraints) — some repos keep it as a marked section of the worker-scoped conventions file; paste that section.
5. **PR labels**: "Open the PR with `--label <labels>`" — labels chosen per the **[conventions]** scheme from the paths the task touches.
6. **Return structure**:
   ```
   status: pass | blocked
   worker_tier: <declared agent type>
   pr_url: <URL on pass; "n/a" when review allowance was exhausted>
   branch: feat/<slug>
   labels: [applied labels]
   summary: <1-2 sentences what changed and why>
   files_changed: [list]
   diff_stat: <N files changed, N insertions, N deletions>
   verify (ALL must be green before the PR was opened):
     typecheck: pass
     lint: pass
     test: pass
   review: <fresh-reviewer rounds to PASS; findings folded; marker written by the reviewer>
   review_findings: [all unresolved BLOCK findings, verbatim]
   artifacts: <URL(s) if the conventions require any for this diff type, else "n/a">
   open_questions: [unresolved tech/business questions — note in the PR body too]
   ```
7. **Full pipeline**: "You own the whole pipeline — do NOT hand back uncommitted work. PASS path: verify gate green → fresh-reviewer gate PASS (findings folded) → lint green the way CI checks it → `git push -u origin <branch>` → open a labeled PR in the conventions' draft/ready state (honoring any pre-PR hook) → attach required artifacts → attempt to remove your own worktree (plain `git worktree remove` from outside it, never `--force`; harness pid-lock = expected, report `harness-locked`; modified/untracked refusal = unpushed work, report loudly) → return the PR URL. BLOCKED path after the review allowance is exhausted: lint → commit all work → push the continuation branch → open no PR → attempt cleanup → return `blocked` with every finding verbatim."

If a worker hits an ambiguity it cannot resolve (business logic, decision-record conflict, scope unclear), it MUST surface it in `open_questions` (in the PR body + its return) — do not guess on business decisions.

---

## Repo-defined worker ladder

This engine is provider-neutral. It does not name models, reasoning levels, or
agent-manifest formats. Provider-specific model and effort settings belong in
the repo's agent definitions; the conventions declare their logical agent
types.

- Read an ordered worker ladder from **[conventions]**, initial tier first, and
  the reviewer agent type plus substantive review allowance.
- Start every task at the initial worker tier unless **[conventions]** explicitly
  authorize another entry point. Do not pre-escalate from estimated complexity.
- Dispatch by declared agent type. Do not pass provider-specific model or effort
  overrides unless **[conventions]** explicitly require them.
- After one substantive `BLOCK`, the same running worker folds findings and a
  NEW reviewer checks the revision. After the configured number of `BLOCK`
  verdicts, the worker returns without a PR; dispatch a FRESH worker at the next
  tier with every finding verbatim.
- Exhausting the final tier is a HARD STOP. Report the accumulated findings and
  diffs; do not invent another tier.
- Reviewer crashes, timeouts, and tooling failures get a fresh replacement at
  the same worker tier and do not count as `BLOCK` verdicts.
- Read-only locator questions ("where is X / what calls Y / list uses") go to
  the runtime's read-only exploration agent, never a pipeline worker.

If the repo defines no worker ladder or reviewer type, stop and run the
bootstrap flow. Do not guess a provider's model names or inheritance behavior.

## Single arm by default; dual arm only for high-stakes

- **Default = ONE worker per task**, economy directives in the prompt (contract 4b), then the orchestrator review gate. This catches most over-build/wrong-trim without paying for a second arm.
- **Dual independent arms ONLY for high-stakes judgment forks** — security, schema/migrations, auth, money, anything where shipping the wrong trim is expensive. Two workers, identical prompt, each in its own isolated worktree with a distinct branch slug; compare diffs and **PR the better one, grafting the runner-up's edges**. Note dual-arm in the PR.
- Dual-arm costs 2× — reserve it for the high-stakes list above; routine UI/CRUD/bugfix tasks get one arm.
- Keep worker prompts free of style/tooling treatments (terseness directives, CLI wrappers) — measured net-negative or neutral.

## Dispatch rules

- **Refine before dispatch**: resolve open questions with the user first using the runtime's user-input mechanism for real tech/business forks — tradeoffs + a recommendation — then decompose into small independent tasks (disjoint files; shared-file tasks run sequentially).
- **⛔ The primary checkout is the USER'S — no agent works in it.** Every agent, the orchestrator included, does ALL file/git work in a worktree: use the runtime's isolated-worktree option when available, otherwise create one explicitly with `git worktree add`. Never `git checkout`/`pull`/commit/edit in the primary tree — multiple agents share the machine, and branch-switching there corrupts each other's state. `git fetch origin` is the only allowed primary-tree operation.
- **Pre-dispatch freshness (EVERY TIME)**: `git fetch origin` before spawning ANY worker (no checkout/pull — see the rule above). The worker contract (#3: branch from `origin/<default>` + HEAD confirmation) guarantees a fresh base regardless of what the worktree forked from.
- **Pre-dispatch existing-work check (EVERY TIME)**: before dispatching a ticket, search for work that already exists — `gh pr list --search "<ticket # / feature nouns>"` plus `git ls-remote origin | grep <slug>`. An open PR or pushed branch for the same work means STOP and reconcile with the user, not re-build (two lanes once built the same ticket concurrently).
- **Independent tasks** → parallel background subagent calls in isolated worktrees, capped by **[conventions]** and the runtime's concurrency limit.
- **Same-shaped batch over a list** → use the runtime's batch primitive when available; otherwise dispatch bounded parallel workers.
- **Sequential dependency** (task B needs task A's output) → chain: wait for A completion → dispatch B.
- **Concurrent workers get disjoint files** — same-file tasks run in sequence.
- **New scope = a separate, sequential worker with its own self-contained prompt.** Message a RUNNING worker only to adjust its in-flight task (clarification, narrowed scope, found-a-blocker).

---

## Final check (orchestrator, AFTER the worker opens the PR)

The worker already self-reviewed, got green, pushed, opened the labeled PR, and attached artifacts. My job is a lightweight final check of the OPENED PR — NOT to fix anything:

1. **Verify the push actually landed**: the remote tip exists and matches (`git ls-remote origin <branch>`), and spot-check one changed file's content in the PR diff. Workers have returned "pushed" with nothing landed — never trust the return structure alone.
2. Open the PR; confirm CI is green, labels are applied, and required artifacts are present.
3. Confirm the review gate ran in a fresh reviewer and findings were folded (the PR body should note it).
4. Spot-check: scope is right, no secrets/`.env`/lockfile churn beyond a real dep change, decision-record compliance.
5. **First-of-a-kind artifacts get eyeballed**: the first time a task produces a required artifact through a NEW harness/fixture (e.g. a package's first screenshot fixtures), open the artifact itself and look at it — a presence-check alone has passed visibly-broken artifacts.
6. **PASS** → report the PR URL to the user. **FAIL/RED/wrong/unlabeled** → **re-dispatch a fresh worker** with the specific findings (fresh worktree, checking out the pushed branch). ⛔ Do NOT fix it yourself.

Accept only green, labeled PRs with their required artifacts — anything else bounces to a fresh worker.

### Post-PASS merge watch (if the conventions define a PR-status service)

Merge approval belongs to the USER — never merge without their explicit per-PR go-ahead, and never treat a watcher event as approval. But don't make them announce the merge either: if **[conventions]** defines a local PR-status service (file markers, status daemon), use the runtime's background execution to arm a watcher on the PR right after reporting PASS (e.g. `until [ -f <events>/pr-<N>.merged ]; do sleep 20; done`). When it fires: confirm the merge, `git fetch`, do any post-merge bookkeeping the conventions call for (often none — the PR's closing keyword already closes the ticket and board workflows move it; don't duplicate automation by hand), and start any queued dependent task without waiting to be told. If CI was still pending at PASS time, watch the service's CI marker the same way instead of polling `gh pr checks`.

---

## PR step (gh CLI)

**PR flow `push-only`** (non-GitHub service, or by choice — per **[conventions]**): the pipeline ends at commit + `git push` + the structured return (state the pushed branch and that no PR exists); skip everything below plus label/marker steps. Otherwise:

Honor the **[conventions]** review gate BEFORE `gh pr create` (some repos hook-enforce it).

From inside the worktree:

```bash
git -C <worktree_path> add -p   # selective; never git add .
git -C <worktree_path> commit   # conventional message; the why, not the what

git -C <worktree_path> push -u origin <branch>

gh pr create \
  --base <default> \
  --head <branch> \
  --label "<labels per conventions scheme>" \
  --title "<type>(<scope>): <subject>" \
  --body "<SHORT: goal/problem + why, decision notes, concerns + Resolves #N, per conventions template — no file lists/diff stats/verify checkmarks (GitHub UI shows those), don't repeat the what/how>"
```

- Draft vs ready: per **[conventions]** — default ready-for-review; some repos open every pipeline PR draft and the orchestrator flips it ready after final check.
- **Auto-close tickets with a closing keyword**: `Resolves #<issue>` in the body closes it on merge. A bare `#N` only links — it does NOT close. Closing >1 ticket: repeat the keyword per issue (`Resolves #10, resolves #123`). For a parent/tracking issue that must stay open, use a plain `#N` link.
- Keep small — if the diff grew beyond a single concern, split into two branches before pushing.
- Report the PR URL to the user immediately.

---

## Worktree lifecycle

- **Born** at dispatch: use the runtime's isolated-worktree support when available; otherwise create an explicit worktree at the latest default tip. Runtime-created worktrees may be detached or session-locked; the repo's cleanup mechanism is the backstop.
- **Live**: the worker does ALL its work inside it; no other agent touches it.
- **Dies with its worker**: after the PR is open and required artifacts are attached, the worker attempts to remove its OWN worktree as the last pipeline step — by explicit path, plain `git worktree remove <path>` (run from outside the tree). **NEVER `--force`, NEVER a bare `git worktree prune`** (a bare prune once deleted a live lane's tree). Two refusal cases, different meanings: a **harness pid-lock** is expected for harness-created worktrees (locked for the whole session; the harness/cleanup mechanism reclaims them) — report `harness-locked`, not an error; **modified/untracked files** means something never got committed or pushed — REPORT that loudly instead of forcing. Self-clean fully applies to self-made worktrees (`git worktree add` — orchestrator chores, doc edits).
- **Rework = fresh tree**: a re-dispatched worker always gets a FRESH worktree and continues from the pushed branch — never revive or reuse a previous worker's tree. Trap: the original worker's still-locked worktree usually HOLDS the branch checkout, so a second worktree cannot check it out — work detached from `origin/<branch>`, push via `git push origin HEAD:refs/heads/<branch>`, then fast-forward the shared local branch ref to the pushed tip BEFORE running any tip-pinned marker script (they resolve `refs/heads/<branch>`; a stale local ref pins stale markers that a review-gate hook will happily accept).
- **Crash orphans**: workers that die mid-pipeline leave worktrees behind; clean via the conventions' cleanup mechanism if one exists, else `git worktree remove <path>` by explicit path after confirming the branch is pushed or dead.
- If a branch needs rebase after PR: rebase in a fresh worktree, re-run verify, re-push.

---

## Staying available

Dispatch workers as background tasks when the runtime supports it so the main thread stays free. When a completion notification arrives: run the final check → report or re-dispatch → continue the conversation. Do not block on multiple completions — handle each as it arrives.

---

## Failure handling

| Situation                                                       | Response                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verify fails (typecheck/lint/test)                              | The running worker fixes it. If continuation is impossible, dispatch a fresh worker at the same tier with the exact output; verify failures do not consume review allowance.                                                                                                                                                                                                                                      |
| Worker dies / no return                                         | Summarize to user, dispatch fresh at the same tier with narrowed scope and any committed state.                                                                                                                                                                                                                                                                                                                   |
| Worker returns "waiting on a background command, will continue" | Treat as AT-RISK — self-resume is not guaranteed (one died silently at exactly this point). If no completion within the command's expected runtime, presume dead: audit its branch/worktree state (`git branch --list`, `git -C <its worktree> log/status` read-only), then dispatch a FRESH continuation worker from the committed state — detached-HEAD flow if the dead worker's locked tree holds the branch. |
| Merge conflict on push                                          | Rebase in worktree, re-run verify, then push.                                                                                                                                                                                                                                                                                                                                                                     |
| Ambiguity in `open_questions`                                   | Bring to user immediately. Do not guess business logic.                                                                                                                                                                                                                                                                                                                                                           |
| Scope grew too large                                            | Split into 2+ tasks, dispatch separately, 2+ PRs.                                                                                                                                                                                                                                                                                                                                                                 |
| **Final worker tier exhausts its review allowance**             | **HARD STOP.** Report to the user with accumulated findings/diffs from every tier; do not invent or dispatch another tier.                                                                                                                                                                                                                                                                                        |

---

## What NOT to do

- ⛔ **Don't fix a worker's mistakes yourself** (per the Roles rule — wrong/red PR = re-dispatch) and **don't touch the primary checkout** (per Dispatch rules — worktrees for everything, orchestrator included).
- ⛔ **Workers spawn NO subagents except the review-gate reviewer.** Chain depth = manager → worker → reviewer, full stop — the reviewer spawns nothing, and there is no other sanctioned worker-spawned agent (no locators, no helpers, **no forks** — a forked agent inherits the worker's context AND shares its worktree, and can stash/push/PR/spawn on its own: treat any pipeline that forked as contaminated at final-check). One fresh reviewer per review round, using the reviewer agent type declared by **[conventions]**. Put this instruction verbatim in every worker prompt.
- ⛔ **Workers write ONLY inside their worktree.** Never to user-level agent configuration (for example `~/.claude` or `~/.codex`), never to the primary checkout, never to other worktrees. Rule/skill changes are the manager's own work — a worker that spots a rule gap REPORTS it as a checklist/skill candidate in its return, nothing more.
- Workers produce the deliverable (feature code, docs, research); the main thread orchestrates. The urge to patch a PR is a re-dispatch signal.
- Read actual command output before reporting verify results.
- When reviewing a worker's diff, push back on bloat, not just bugs (the 4b economy bar applies to acceptance too).
- Commit lockfiles, `.mcp.json`, or `.env` only when the task explicitly requires them.
