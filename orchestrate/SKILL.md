---
name: orchestrate
description: >
  Generic orchestration loop: stay conversational with the user, decompose
  intent into small independent tasks, dispatch subagent workers each in an
  isolated git worktree in parallel, verify their output against a quality
  gate, then the worker commits → pushes → opens one small ready-for-review,
  labeled PR per task via `gh` CLI. Project-specific facts (verify commands,
  labels, review gates, artifact rules) come from the repo's conventions file
  — this skill is project-agnostic. It is the dispatch ENGINE, not a role:
  pair it with a lane skill (`/tl` for tech-lead work, `/pm` for
  product/requirements work).
  Trigger: "orchestrate", "fan out agents", "dispatch subagents",
  "run this as parallel tasks", "multi-agent", "/orchestrate".
---

## Step 0 — load the repo conventions file, and your role skill

Before anything else, read **`.claude/orchestrate.md`** — from the **default branch tip**, not a possibly-stale checkout: `git fetch origin -q && git show origin/<default>:.claude/orchestrate.md` (same for any files it references, e.g. the review checklist). Worktrees fork at dispatch time; conventions move faster. It defines the project-specific layer this engine slots into:

- repo/remote/default branch + bot identity (token, git user)
- workspace layout + agent read order
- **verify gate** commands (typecheck / lint / test, and how to scope them)
- **review gate** (e.g. a pre-PR review skill) and any enforcement hooks
- **PR conventions**: label scheme + how to pick labels, issue-closing keywords, body template
- **artifact rules** (e.g. screenshots for UI PRs) and how to produce/host them
- project-specific code rules to inject into worker prompts (banned APIs, required libs)

**If the file is missing**: derive defaults — read `AGENTS.md`/`CONTRIBUTING.md`, take verify commands from `package.json` scripts (or the ecosystem equivalent), skip label/artifact steps, and tell the user you're running on derived defaults (offer to generate a conventions file).

Everything below marked **[conventions]** means: the concrete value comes from that file.

**This skill is an engine, not a role.** It says how to dispatch, verify, and land work — not what work is yours. Load the lane skill that says who you are:

- **`/tl`** — tech lead: takes a Ready queue, dispatches workers, final-checks PRs, owns ADRs. Picks a lane first if the conventions declare more than one.
- **`/pm`** — product manager: grills requirements, writes PRDs, cuts tickets, locks designs. No lane; its workers write docs, not app code.

Both may be loaded at once on a small project. If neither is loaded and the work is ambiguous, ask the user which role you're in before dispatching.

---

## Roles

| Actor | Responsibility |
|---|---|
| **Orchestrator (main thread)** | Talk to user, refine questions, decompose tasks, dispatch workers, then **final-check the worker's opened PR**. Does NOT implement, does NOT fix the worker's mistakes, does NOT run lint for the worker, does NOT push or open PRs on the worker's behalf. Never edits files or switches branches in the primary checkout — that tree belongs to the user. |
| **Workers (subagents)** | Own the ENTIRE pipeline for one task: implement → fresh-reviewer gate → fix until green → push → open labeled PR → attach required artifacts → return the PR URL. |

> ⛔ **The orchestrator NEVER fixes a worker's mistakes by itself** (no inline lint/review-finding fixes, no "I'll just patch it"). If a returned PR is wrong or red, **re-dispatch a FRESH worker** with the findings. The only thing the main thread hand-edits is its OWN non-worker work (skills, memory, tiny chores it explicitly owns).

> ⛔ **Workers are always FRESH — never resume a completed worker.** Every dispatch and every fix/review round = a NEW agent (default worker model) with a fully self-contained prompt: the branch name + its current state, the findings/decisions verbatim, and the pipeline steps. Resuming a completed agent by message causes role confusion (it narrates or re-delegates instead of working) and silently runs on the orchestrator's session model instead of the worker tier. Only exception: messaging a STILL-RUNNING worker to adjust its in-flight scope. The orchestrator's session is the only long-running context.

---

## The worker pipeline (every worker runs ALL of this before returning)

1. **Implement** one small logical change in its worktree (reads the **[conventions]** read-order docs first).
2. **Verify gate**: run the **[conventions]** typecheck/lint/test commands, scoped to the touched workspace when possible. All green.
3. **Review gate — fresh reviewer, never yourself**: spawn ONE fresh review subagent (the **[conventions]** reviewer agent type if defined, else a clean subagent with an explicit model) to run the **[conventions]** review gate on the diff. **The author of a diff never reviews it** — a clean context is the mechanism. Give the reviewer the branch + worktree path, the acceptance criteria, and the conventions' reviewer-contract items; never tell it what engine wrote the diff. Fold every must-fix, commit, then spawn a NEW fresh reviewer for the next round (never resume one). Cap 2 rounds; still failing → return to the orchestrator with the findings instead of opening a PR. (Chain depth caps at manager → worker → reviewer; the reviewer spawns NOTHING.)
4. **Lint until green** exactly the way **[conventions]** says CI validates it (some setups need explicit file paths or a commit to trigger staged-file hooks — the conventions file documents the traps).
5. **Push** the branch (`git push -u origin <branch>`).
6. **Open the PR** (`gh pr create`, ready-for-review) **with the labels the conventions' scheme assigns** (`--label`), honoring any pre-PR enforcement hook the conventions define.
7. **Artifacts**: produce + attach whatever **[conventions]** requires for this diff type (e.g. screenshot for UI changes).
8. **Self-clean**: remove your own worktree (see Worktree lifecycle — plain `git worktree remove <path>` from outside it, never `--force`; refused = report, don't force).
9. **Return** the PR URL + a short summary. Done.

Workers use the **[conventions]** bot identity for push / PR / uploads.

## Loop

```
user feeds intent
  └─ I refine open questions (AskUserQuestion for tech/business forks)
     └─ I decompose into ≤5 independent tasks (disjoint files; shared-file tasks run sequentially)
        └─ per task: spawn Agent, isolation:"worktree", run_in_background:true
           └─ worker runs the FULL pipeline above → opens PR → returns PR URL
        └─ on worker return: I do a FINAL CHECK of the opened PR
           ├─ PASS → report PR URL to user (nothing for me to fix)
           └─ FAIL/RED/wrong → RE-DISPATCH a worker with the findings (never fix it myself)
  └─ keep talking with user the whole time (background = non-blocking)
```

---

## Task contract — required in every worker prompt

Every worker prompt MUST include:

1. **Read order**: FIRST the conventions file + review checklist **from `origin/<default>` tip via `git show`** (your worktree copy may predate rule changes — quote this instruction verbatim in the prompt), then the **[conventions]** doc read order (project docs → plan → decisions → scoped plan/progress). When the orchestrator relays a project rule into a prompt, it QUOTES the conventions wording verbatim — paraphrasing has diluted rules into violations.
2. **Scope**: "Work only inside your worktree. Touch only `<declared paths>`. One logical change. Keep it small."
3. **Branch**: "Create branch `feat/<slug>` | `fix/<slug>` | `chore/<slug>` branched from **latest `origin/<default>`**. FIRST run `git fetch origin && git checkout -B <branch> origin/<default>`, then `git log -1 origin/<default>` and confirm your HEAD matches it. Do NOT branch from stale local state — if your worktree HEAD ≠ `origin/<default>`, reset onto it before writing a line of code."
4. **Verify gate**: "Before returning, run the **[conventions]** verify commands (scoped). Do not return if any fail — fix or report."
4b. **Code & test economy (be considerate — DEFAULT TO LESS)**: "Write the MINIMUM code that is correct, clear, and meets the task. Do NOT over-abstract, over-generalize, add speculative flexibility, or build machinery the requirement doesn't need. Prefer the simpler design that satisfies the spec. **Tests: cover OUR logic + the load-bearing edge cases + known bugs — NOT the framework/library's own behavior, NOT every input permutation.** A focused ~8–15 test suite beats 32. Match the surrounding code's density + comment level — don't pad with verbose JSDoc. **Comments: write LESS, compact + precise. Make the code self-describe (clear names, small functions, obvious structure) so it needs no narration. A comment earns its place only when it says WHY (non-obvious intent, a gotcha, an invariant, a spec/ADR ref) — never WHAT the code already shows.** If unsure whether something is needed, leave it out and note it in open_questions."
4c. **Project code rules**: paste the **[conventions]** "worker prompt rules" block verbatim (banned APIs, required shared libs, style constraints).
5. **PR labels**: "Open the PR with `--label <labels>`" — labels chosen per the **[conventions]** scheme from the paths the task touches.
6. **Return structure**:
   ```
   pr_url: <URL>                  ← REQUIRED (worker opened it)
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
   artifacts: <URL(s) if the conventions require any for this diff type, else "n/a">
   open_questions: [unresolved tech/business questions — note in the PR body too]
   ```
7. **Full pipeline**: "You own the whole pipeline — do NOT hand back uncommitted work. After the code is done: verify gate green → fresh-reviewer gate PASS (findings folded) → lint green the way CI checks it → `git push -u origin <branch>` → open a ready, labeled PR (honoring any pre-PR hook) → attach required artifacts → remove your own worktree (plain `git worktree remove` from outside it, never `--force`; refused = report instead). Return the PR URL. Do NOT return until the PR is open and green."

If a worker hits an ambiguity it cannot resolve (business logic, decision-record conflict, scope unclear), it MUST surface it in `open_questions` (in the PR body + its return) — do not guess on business decisions.

---

## Worker tier policy (effort × model)

Reasoning effort is pinned per worker agent definition (`.claude/agents/worker-*.md` frontmatter `effort:` — the Agent tool has no per-call effort param). The orchestrator picks the subagent type by estimated task complexity. Do NOT dispatch pipeline work as a generic agent type (it inherits the main session's effort — typically the most expensive tier — and breaks cost attribution). If the repo defines no worker agents, generate them from this skill repo's `templates/agents/` before dispatching.

| Estimated complexity | subagent_type | approval |
|---|---|---|
| Mechanical: config flips, comment/label churn, single-file obvious fix | `worker-low` | auto |
| Routine: CRUD, standard UI, focused bugfix, test updates | `worker-medium` | auto |
| Substantial: multi-file feature, concurrency, auth-adjacent, schema/migrations | `worker-high` | auto |
| Super-complex: architecture-heavy, security-critical core | `worker-xhigh` | **ask the user FIRST** — if the task is splittable, propose the split instead |

- Research/investigation dispatches are exempt from the xhigh approval gate. Read-only locator questions ("where is X / what calls Y / list uses") go to a read-only explore agent, never a worker.
- Reviewers: the conventions' reviewer agent type (default effort **high**), always with an explicit model.
- Re-dispatch after a failed round: escalate one EFFORT tier (e.g. `worker-medium` → `worker-high`). Effort escalation is the orchestrator's call.
- **Model tier is a separate axis. Default `sonnet` for every worker and reviewer.** Escalating a coder above sonnet (`opus`, or mythos-tier `fable`) is allowed when the task genuinely warrants it — but **every above-sonnet dispatch needs the user's explicit approval, every time**: give a one-line TLDR of why the tier is warranted, then wait for the go-ahead. No standing auto-escalation mode.
- **Model is ALWAYS explicit, at every level**: the orchestrator passes `model:` on every worker dispatch (escalate deliberately, never by accident), and worker prompts instruct that any subagent the worker itself spawns (its reviewer) also passes an explicit model — an omitted model inherits the TOP session's model, not the spawning worker's, which silently runs helpers on the most expensive tier.

## Single arm by default; dual arm only for high-stakes

- **Default = ONE worker per task**, economy directives in the prompt (contract 4b), then the orchestrator review gate. This catches most over-build/wrong-trim without paying for a second arm.
- **Dual independent arms ONLY for high-stakes judgment forks** — security, schema/migrations, auth, money, anything where shipping the wrong trim is expensive. Two workers, identical prompt, each in its own `isolation: "worktree"`, distinct branch slugs; compare diffs and **PR the better one, grafting the runner-up's edges**. Note dual-arm in the PR.
- Dual-arm costs 2× — reserve it; don't reflexively pair routine UI/CRUD/bugfix tasks.
- Do NOT inject style/tooling treatments (terseness directives, CLI wrappers) into worker prompts — measured net-negative or neutral.

## Dispatch rules

- **⛔ The primary checkout is the USER'S — no agent works in it.** Every agent, the orchestrator included, does ALL file/git work in a worktree: workers via `isolation: "worktree"`, the orchestrator's own repo chores via `git worktree add` (or EnterWorktree). Never `git checkout`/`pull`/commit/edit in the primary tree — multiple agents share the machine, and branch-switching there corrupts each other's state. `git fetch origin` is the only allowed primary-tree operation.
- **Pre-dispatch freshness (EVERY TIME)**: `git fetch origin` before spawning ANY worker (no checkout/pull — see the rule above). The worker contract (#3: branch from `origin/<default>` + HEAD confirmation) guarantees a fresh base regardless of what the worktree forked from.
- **Pre-dispatch existing-work check (EVERY TIME)**: before dispatching a ticket, search for work that already exists — `gh pr list --search "<ticket # / feature nouns>"` plus `git ls-remote origin | grep <slug>`. An open PR or pushed branch for the same work means STOP and reconcile with the user, not re-build (two lanes once built the same ticket concurrently).
- **Independent tasks** → parallel `Agent` calls, `isolation: "worktree"`, `run_in_background: true`, max **5** concurrent.
- **Same-shaped batch over a list** → `Workflow` with `pipeline()`.
- **Sequential dependency** (task B needs task A's output) → chain: wait for A completion → dispatch B.
- **Never** two workers touching the same files concurrently.
- **Never send NEW SCOPE to a worker whose contract is locked.** Messaging a RUNNING worker is only for adjusting its in-flight task (clarification, narrowed scope, found-a-blocker). Anything beyond the dispatched contract = a separate, sequential worker with its own self-contained prompt.

---

## Final check (orchestrator, AFTER the worker opens the PR)

The worker already self-reviewed, got green, pushed, opened the labeled PR, and attached artifacts. My job is a lightweight final check of the OPENED PR — NOT to fix anything:

1. **Verify the push actually landed**: the remote tip exists and matches (`git ls-remote origin <branch>`), and spot-check one changed file's content in the PR diff. Workers have returned "pushed" with nothing landed — never trust the return structure alone.
2. Open the PR; confirm CI is green, labels are applied, and required artifacts are present.
3. Confirm the review gate ran in a fresh reviewer and findings were folded (the PR body should note it).
4. Spot-check: scope is right, no secrets/`.env`/lockfile churn beyond a real dep change, decision-record compliance.
5. **First-of-a-kind artifacts get eyeballed**: the first time a task produces a required artifact through a NEW harness/fixture (e.g. a package's first screenshot fixtures), open the artifact itself and look at it — a presence-check alone has passed visibly-broken artifacts.
6. **PASS** → report the PR URL to the user. **FAIL/RED/wrong/unlabeled** → **re-dispatch a fresh worker** with the specific findings (fresh worktree, checking out the pushed branch). ⛔ Do NOT fix it yourself.

Never accept a red PR. Never accept a PR missing a required artifact or label — bounce it back to a worker.

### Post-PASS merge watch (if the conventions define a PR-status service)

Merge approval belongs to the USER — never merge without their explicit per-PR go-ahead, and never treat a watcher event as approval. But don't make them announce the merge either: if **[conventions]** defines a local PR-status service (file markers, status daemon), arm a background watcher on the PR right after reporting PASS (`run_in_background: true`, e.g. `until [ -f <events>/pr-<N>.merged ]; do sleep 20; done`). When it fires: confirm the merge, do the post-merge bookkeeping the conventions call for (board status, ticket state, `git fetch`), and start any queued dependent task without waiting to be told. If CI was still pending at PASS time, watch the service's CI marker the same way instead of polling `gh pr checks`.

---

## PR step (gh CLI)

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

- PRs are **ready-for-review** (no `--draft`).
- **Auto-close tickets with a closing keyword**: `Resolves #<issue>` in the body closes it on merge. A bare `#N` only links — it does NOT close. Closing >1 ticket: repeat the keyword per issue (`Resolves #10, resolves #123`). For a parent/tracking issue that must stay open, use a plain `#N` link.
- Keep small — if the diff grew beyond a single concern, split into two branches before pushing.
- Report the PR URL to the user immediately.

---

## Worktree lifecycle

- **Born** at dispatch: the harness creates the worktree (`isolation: "worktree"`), branched off latest default (the harness auto-removes it again if the worker never changed anything).
- **Live**: the worker does ALL its work inside it; no other agent touches it.
- **Dies with its worker**: after the PR is open and required artifacts are attached, the worker removes its OWN worktree as the last pipeline step — by explicit path, plain `git worktree remove <path>` (run from outside the tree). **NEVER `--force`, NEVER a bare `git worktree prune`** (a bare prune once deleted a live lane's tree). If removal is refused (modified/untracked files present), that is a signal something never got committed or pushed — REPORT it in the return instead of forcing.
- **Rework = fresh tree**: a re-dispatched worker always gets a FRESH worktree and checks out the pushed branch there — never revive or reuse a previous worker's tree.
- **Crash orphans**: workers that die mid-pipeline leave worktrees behind; clean via the conventions' cleanup mechanism if one exists, else `git worktree remove <path>` by explicit path after confirming the branch is pushed or dead.
- If a branch needs rebase after PR: rebase in a fresh worktree, re-run verify, re-push.

---

## Staying available

Dispatch workers as background tasks (`run_in_background: true`) so the main thread stays free. When a completion notification arrives: run the final check → report or re-dispatch → continue the conversation. Do not block on multiple completions — handle each as it arrives.

---

## Failure handling

| Situation | Response |
|---|---|
| Verify fails (typecheck/lint/test) | Re-dispatch with error output + "fix only this". Escalate model if same error repeats. |
| Worker dies / no return | Summarize to user, dispatch fresh with narrowed scope. |
| Merge conflict on push | Rebase in worktree, re-run verify, then push. |
| Ambiguity in `open_questions` | Bring to user immediately. Do not guess business logic. |
| Scope grew too large | Split into 2+ tasks, dispatch separately, 2+ PRs. |
| **Same task failed 3 worker rounds** | **HARD STOP — dispatch no 4th worker.** Report to the user with the accumulated findings/diffs from all rounds: at 3 failures the task spec or its premise is the problem, not the worker (goal-style turn cap; adopted 2026-07-07 from "Getting started with loops"). |

---

## What NOT to do

- ⛔ **Don't fix a worker's mistakes yourself.** No inline lint/review-finding patches, no "I'll just hand-edit it", no producing the worker's artifacts, no committing on its behalf. A wrong/red PR → RE-DISPATCH. The main thread only hand-edits its OWN work (skills, memory, a chore it explicitly owns) — and any repo-file chore happens in a worktree, never the primary checkout.
- ⛔ **Don't touch the primary checkout.** No branch switches, commits, or file edits there — it's reserved for the user. Worktrees for everything, orchestrator included.
- ⛔ **Workers spawn NO subagents except the review-gate reviewer.** Chain depth = manager → worker → reviewer, full stop — the reviewer spawns nothing, and there is no other sanctioned worker-spawned agent (no locators, no helpers, **no forks** — a forked agent inherits the worker's context AND shares its worktree, and can stash/push/PR/spawn on its own: treat any pipeline that forked as contaminated at final-check). One fresh reviewer per review round, explicit model. Put this instruction verbatim in every worker prompt.
- ⛔ **Workers write ONLY inside their worktree.** Never to `~/.claude` (skills, hooks, settings, memory), never to the primary checkout, never to other worktrees. Rule/skill changes are the manager's own work — a worker that spots a rule gap REPORTS it as a checklist/skill candidate in its return, nothing more (a reviewer child once hand-edited a global skill mid-task: right idea, wrong actor).
- Don't do the workers' work in the main thread — whatever the deliverable is (feature code, docs, research). Workers own implement → fresh-reviewer gate → fix-green → push → PR → artifacts.
- Don't accept a PR you had to fix. If you're tempted to patch it, that's a re-dispatch.
- Don't open PRs with `--draft` unless the user explicitly requests it.
- Don't run more than 5 concurrent workers.
- Don't let a worker touch files outside its declared scope.
- Don't fabricate verify results — read actual command output.
- Don't over-write. No speculative abstractions the task doesn't need; no tests that re-verify the framework; no verbose JSDoc padding; comment only the non-obvious WHY. When reviewing a worker's diff, push back on bloat, not just bugs.
- Don't commit lockfiles, `.mcp.json`, or `.env` unless the task explicitly requires it.
