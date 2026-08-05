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

Before anything else, read **`.claude/orchestrate.md`** — from the **default branch tip**, not a possibly-stale checkout: `git fetch origin -q && git show origin/<default>:.claude/orchestrate.md` (same for any files it references, e.g. the review checklist). Worktrees fork at dispatch time; conventions move faster. It defines the project-specific layer this engine slots into:

- repo/remote/default branch + bot identity (token, git user)
- workspace layout + agent read order
- **verify gate** commands (typecheck / lint / test, and how to scope them)
- **review gate** (e.g. a pre-PR review skill) and any enforcement hooks
- **PR conventions**: label scheme + how to pick labels, issue-closing keywords, body template
- **artifact rules** (e.g. screenshots for UI PRs) and how to produce/host them
- project-specific code rules to inject into worker prompts (banned APIs, required libs)
- optionally a **worker-scoped conventions file** — a leaner file holding what workers/reviewers need (identity, verify gate, review gate, PR conventions, code rules); worker contracts then name THAT file as their read order, and workers skip the orchestrator-side conventions entirely

**If the file is missing — run the bootstrap interview (once per repo): follow `bootstrap.md` in this skill's directory.** Detect cheaply, confirm every dimension with the user via AskUserQuestion, generate `.claude/orchestrate.md` + `.claude/agents/` from this skill repo's `templates/`, land them via the normal pipeline. Never re-interview while the file exists — edit the file instead.

Everything below marked **[conventions]** means: the concrete value comes from that file.

**This skill is an engine, not a role.** It says how to dispatch, verify, and land work — not what work is yours. Load the lane skill that says who you are:

- **`/tl`** — tech lead: takes a Ready queue, dispatches workers, final-checks PRs, owns ADRs. Picks a lane first if the conventions declare more than one.
- **`/pm`** — product manager: grills requirements, writes PRDs, cuts tickets, locks designs. No lane; its workers write docs, not app code.

Both may be loaded at once on a small project. If neither is loaded and the work is ambiguous, ask the user which role you're in before dispatching.

---

## Roles

| Actor | Responsibility |
|---|---|
| **Orchestrator (main thread)** | Talk to user, refine questions, decompose tasks, dispatch workers, then **final-check the worker's opened PR**. Does NOT implement, and does NOT push or open PRs on the worker's behalf. |
| **Workers (subagents)** | Own the ENTIRE pipeline for one task: implement → fresh-reviewer gate → fix until green → push → open labeled PR → attach required artifacts → return the PR URL. |

> **A wrong or red PR gets a FRESH worker re-dispatched with the findings** — the orchestrator fixes nothing inline. The main thread hand-edits only its OWN work (skills, memory, chores it owns).

> **Every dispatch and every fix/review round = a NEW agent** with a fully self-contained prompt: branch name + current state, findings verbatim, pipeline steps. A resumed completed agent narrates or re-delegates instead of working, and silently runs on the orchestrator's session model instead of the worker tier. One exception: message a STILL-RUNNING worker to adjust its in-flight scope. The orchestrator's session is the only long-running context.

---

## The worker pipeline (every worker runs ALL of this before returning)

1. **Implement** one small logical change in its worktree (reads the **[conventions]** read-order docs first).
2. **Verify gate**: run the **[conventions]** typecheck/lint/test commands, scoped to the touched workspace when possible. All green.
3. **Review gate — fresh reviewer, never yourself**: spawn ONE fresh review subagent (the **[conventions]** reviewer agent type if defined, else a clean subagent with an explicit model) to run the **[conventions]** review gate on the diff. **The author of a diff never reviews it** — a clean context is the mechanism. Give the reviewer the branch + worktree path, the acceptance criteria, and the conventions' reviewer-contract items; never tell it what engine wrote the diff. Fold every must-fix, commit, then spawn a NEW fresh reviewer for the next round (never resume one). Cap 2 rounds; still failing → return to the orchestrator with the findings instead of opening a PR. (Chain depth caps at manager → worker → reviewer; the reviewer spawns NOTHING.)
4. **Lint until green** exactly the way **[conventions]** says CI validates it (some setups need explicit file paths or a commit to trigger staged-file hooks — the conventions file documents the traps).
5. **Push** the branch (`git push -u origin <branch>`).
6. **Open the PR** (`gh pr create`) **with the labels the conventions' scheme assigns** (`--label`) and the draft/ready state the conventions define, honoring any pre-PR enforcement hook.
7. **Artifacts**: produce + attach whatever **[conventions]** requires for this diff type (e.g. screenshot for UI changes).
8. **Self-clean**: attempt to remove your own worktree (see Worktree lifecycle — plain `git worktree remove <path>` from outside it, never `--force`). A harness pid-lock refusal is EXPECTED for harness-created worktrees (`isolation: "worktree"` trees stay locked for the session's lifetime) — report `worktree_cleanup: harness-locked` and move on. A modified/untracked-files refusal = unpushed work — report that loudly instead.
9. **Return** the PR URL + a short summary. Done.

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
7. **Full pipeline**: "You own the whole pipeline — do NOT hand back uncommitted work. After the code is done: verify gate green → fresh-reviewer gate PASS (findings folded) → lint green the way CI checks it → `git push -u origin <branch>` → open a labeled PR in the conventions' draft/ready state (honoring any pre-PR hook) → attach required artifacts → attempt to remove your own worktree (plain `git worktree remove` from outside it, never `--force`; harness pid-lock = expected, report `harness-locked`; modified/untracked refusal = unpushed work, report loudly). Return the PR URL. Do NOT return until the PR is open and green."

If a worker hits an ambiguity it cannot resolve (business logic, decision-record conflict, scope unclear), it MUST surface it in `open_questions` (in the PR body + its return) — do not guess on business decisions.

---

## Worker tier policy (effort × model)

Reasoning effort is pinned per worker agent definition (`.claude/agents/worker-*.md` frontmatter `effort:` — the Agent tool has no per-call effort param). The orchestrator picks the subagent type by estimated task complexity. Dispatch pipeline work only as a worker type — a generic agent type inherits the main session's effort (usually the most expensive tier) and breaks cost attribution. If the repo defines no worker agents, generate them from this skill repo's `templates/agents/` before dispatching.

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
- Dual-arm costs 2× — reserve it for the high-stakes list above; routine UI/CRUD/bugfix tasks get one arm.
- Keep worker prompts free of style/tooling treatments (terseness directives, CLI wrappers) — measured net-negative or neutral.

## Dispatch rules

- **Refine before dispatch**: resolve open questions with the user first (AskUserQuestion for real tech/business forks — tradeoffs + a recommendation), then decompose into small independent tasks (disjoint files; shared-file tasks run sequentially).
- **⛔ The primary checkout is the USER'S — no agent works in it.** Every agent, the orchestrator included, does ALL file/git work in a worktree: workers via `isolation: "worktree"`, the orchestrator's own repo chores via `git worktree add` (or EnterWorktree). Never `git checkout`/`pull`/commit/edit in the primary tree — multiple agents share the machine, and branch-switching there corrupts each other's state. `git fetch origin` is the only allowed primary-tree operation.
- **Pre-dispatch freshness (EVERY TIME)**: `git fetch origin` before spawning ANY worker (no checkout/pull — see the rule above). The worker contract (#3: branch from `origin/<default>` + HEAD confirmation) guarantees a fresh base regardless of what the worktree forked from.
- **Pre-dispatch existing-work check (EVERY TIME)**: before dispatching a ticket, search for work that already exists — `gh pr list --search "<ticket # / feature nouns>"` plus `git ls-remote origin | grep <slug>`. An open PR or pushed branch for the same work means STOP and reconcile with the user, not re-build (two lanes once built the same ticket concurrently).
- **Independent tasks** → parallel `Agent` calls, `isolation: "worktree"`, `run_in_background: true`, max **5** concurrent.
- **Same-shaped batch over a list** → `Workflow` with `pipeline()`.
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

Merge approval belongs to the USER — never merge without their explicit per-PR go-ahead, and never treat a watcher event as approval. But don't make them announce the merge either: if **[conventions]** defines a local PR-status service (file markers, status daemon), arm a background watcher on the PR right after reporting PASS (`run_in_background: true`, e.g. `until [ -f <events>/pr-<N>.merged ]; do sleep 20; done`). When it fires: confirm the merge, `git fetch`, do any post-merge bookkeeping the conventions call for (often none — the PR's closing keyword already closes the ticket and board workflows move it; don't duplicate automation by hand), and start any queued dependent task without waiting to be told. If CI was still pending at PASS time, watch the service's CI marker the same way instead of polling `gh pr checks`.

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

- **Born** at dispatch: the harness creates the worktree (`isolation: "worktree"`) at the latest default tip — detached, no stub branch, when a `WorktreeCreate` hook creates it (see `tools/worktree-hook/`). The harness auto-removes unchanged trees; under a custom hook that auto-removal is unverified — the repo's cleanup mechanism is the backstop.
- **Live**: the worker does ALL its work inside it; no other agent touches it.
- **Dies with its worker**: after the PR is open and required artifacts are attached, the worker attempts to remove its OWN worktree as the last pipeline step — by explicit path, plain `git worktree remove <path>` (run from outside the tree). **NEVER `--force`, NEVER a bare `git worktree prune`** (a bare prune once deleted a live lane's tree). Two refusal cases, different meanings: a **harness pid-lock** is expected for harness-created worktrees (locked for the whole session; the harness/cleanup mechanism reclaims them) — report `harness-locked`, not an error; **modified/untracked files** means something never got committed or pushed — REPORT that loudly instead of forcing. Self-clean fully applies to self-made worktrees (`git worktree add` — orchestrator chores, doc edits).
- **Rework = fresh tree**: a re-dispatched worker always gets a FRESH worktree and continues from the pushed branch — never revive or reuse a previous worker's tree. Trap: the original worker's still-locked worktree usually HOLDS the branch checkout, so a second worktree cannot check it out — work detached from `origin/<branch>`, push via `git push origin HEAD:refs/heads/<branch>`, then fast-forward the shared local branch ref to the pushed tip BEFORE running any tip-pinned marker script (they resolve `refs/heads/<branch>`; a stale local ref pins stale markers that a review-gate hook will happily accept).
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
| Worker returns "waiting on a background command, will continue" | Treat as AT-RISK — self-resume is not guaranteed (one died silently at exactly this point). If no completion within the command's expected runtime, presume dead: audit its branch/worktree state (`git branch --list`, `git -C <its worktree> log/status` read-only), then dispatch a FRESH continuation worker from the committed state — detached-HEAD flow if the dead worker's locked tree holds the branch. |
| Merge conflict on push | Rebase in worktree, re-run verify, then push. |
| Ambiguity in `open_questions` | Bring to user immediately. Do not guess business logic. |
| Scope grew too large | Split into 2+ tasks, dispatch separately, 2+ PRs. |
| **Same task failed 3 worker rounds** | **HARD STOP — dispatch no 4th worker.** Report to the user with the accumulated findings/diffs from all rounds: at 3 failures the task spec or its premise is the problem, not the worker. |

---

## What NOT to do

- ⛔ **Don't fix a worker's mistakes yourself** (per the Roles rule — wrong/red PR = re-dispatch) and **don't touch the primary checkout** (per Dispatch rules — worktrees for everything, orchestrator included).
- ⛔ **Workers spawn NO subagents except the review-gate reviewer.** Chain depth = manager → worker → reviewer, full stop — the reviewer spawns nothing, and there is no other sanctioned worker-spawned agent (no locators, no helpers, **no forks** — a forked agent inherits the worker's context AND shares its worktree, and can stash/push/PR/spawn on its own: treat any pipeline that forked as contaminated at final-check). One fresh reviewer per review round, explicit model. Put this instruction verbatim in every worker prompt.
- ⛔ **Workers write ONLY inside their worktree.** Never to `~/.claude` (skills, hooks, settings, memory), never to the primary checkout, never to other worktrees. Rule/skill changes are the manager's own work — a worker that spots a rule gap REPORTS it as a checklist/skill candidate in its return, nothing more.
- Workers produce the deliverable (feature code, docs, research); the main thread orchestrates. The urge to patch a PR is a re-dispatch signal.
- Read actual command output before reporting verify results.
- When reviewing a worker's diff, push back on bloat, not just bugs (the 4b economy bar applies to acceptance too).
- Commit lockfiles, `.mcp.json`, or `.env` only when the task explicitly requires them.
