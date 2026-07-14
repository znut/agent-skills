---
name: znut-code-review
description: >
  Pre-PR review gate. Run ONCE on a finished branch diff BEFORE opening the
  PR: deterministic grep pass over the repo's banned-pattern list, then a
  diff-scoped judgment review against the repo's recurring-mistakes
  checklist, plus file-type sub-skills. Returns a structured BLOCK/PASS
  verdict; on PASS writes a sha-pinned marker that a PreToolUse hook checks
  at `gh pr create` (commits after review invalidate the marker). Repo
  specifics live in the committed `.claude/review-checklist.md` — this skill
  is project-agnostic. Trigger: "/znut-code-review", "review gate",
  "pre-PR review", or automatically from orchestrate's review gate.
---

# znut-code-review — pre-PR review gate

Goal: catch the repo's recurring review findings BEFORE the PR is opened, so the human review loop shrinks. Run once per finished diff; re-run after any fix commits (the marker is sha-pinned — new commits un-gate).

## Step 0 — load the repo checklist (LATEST, not your fork's copy)

Read the checklist from the **default branch tip**, not the worktree's possibly-stale copy: `git fetch origin -q && git show origin/<default>:.claude/review-checklist.md`. Rules move faster than worktree fork points — reviewing against a stale checklist has shipped violations of freshly-banked rules. It defines:
- the **grep pass** table (banned patterns + severity + allowed exceptions)
- **judgment sections**, each tagged with the paths it applies to
- **file-type sub-skills** (e.g. Svelte best-practices for `.svelte`)
- per-item **severity**: `BLOCK` vs `FIX` (fix before PR if cheap, else note a follow-up in the PR)

If the file is missing: fall back to a generic pass — correctness, security (injection, secrets, authz), dead code, test quality, economy/bloat — all severities judged by impact, and tell the user the repo has no banked checklist (offer to create one).

## Step 1 — resolve the diff

Identify the branch under review (the one about to be PRed). From its worktree:
```bash
git fetch origin
git diff origin/<default>...<branch>          # the diff under review
git diff --name-status origin/<default>...<branch>   # changed-path list for scoping
```

## Step 2 — mechanical grep pass (deterministic, before any LLM)

Run every pattern in the checklist's grep table against the **added lines** of the diff (`git diff -U0 ... | grep '^+'`). Every hit = a finding at the table's severity. Patterns with documented exceptions (e.g. "raw SQL is correct when there's no binding") are handed to the judgment pass to adjudicate, not silently dropped.

## Step 3 — scope the checklist

Match the changed paths against each judgment section's path tags. Only sections that match run (docs-only diff skips DB checks; no `.svelte` changed → no Svelte sub-skill). Sections tagged `always` always run.

## Step 4 — judgment pass

**Max agent-chain depth is 2: manager → one subagent.** If you are already a subagent (a worker running its pre-PR gate, or an agent dispatched specifically to run this review): do the judgment pass **INLINE yourself** — do NOT spawn a reviewer child (that made 3-level manager→agent→reviewer chains; the review dispatch from the main thread is the only sanctioned review spawn).

Only when running in the top-level interactive session: dispatch **ONE reviewer subagent** (`cavecrew-reviewer` or general-purpose) — **ALWAYS with an explicit `model: "sonnet"`** (an omitted model inherits the TOP session's model, not the caller's — review children silently ran on the most expensive tier). Give it: the diff, the selected checklist sections, and the grep hits needing adjudication.

Either way (inline or dispatched), findings come back ONLY as `path:line — rule — problem — fix`, must-fix focus, no praise, no scope creep, plus **checklist candidates** (recurring-looking mistakes not yet banked).

## Step 5 — file-type sub-skills

Run each sub-skill the checklist maps to changed file types (e.g. `svelte-core-bestpractices` on changed `.svelte`).

## Step 6 — verdict (structured, no prose-parsing)

Collate into:
```
verdict: BLOCK | PASS
blockers:     [{path:line, rule, problem, fix}]   # any BLOCK-severity finding
should_fix:   [{path:line, rule, problem, fix}]   # FIX-severity
checklist_candidates: [suggested new recurring patterns — user decides to bank]
```
`verdict: BLOCK` ⇔ `blockers` is non-empty.

## Step 7 — fold + re-verify

Fix blockers (and cheap should_fixes); unfixed should_fixes become follow-up notes in the PR body. Re-run the repo verify gate after fixes. Fix commits move the branch tip — re-run this gate (cheap: the grep pass + only affected sections).

## Step 8 — write the sha-pinned marker (REQUIRED — hook-enforced)

Only on `verdict: PASS`, pin the marker to the reviewed branch tip.

**Preferred — the repo's committed marker script**, if the conventions file declares one (check the repo's orchestration conventions; e.g. `scripts/zcr-mark.sh`):
```bash
bash scripts/zcr-mark.sh <branch>
```
**Fallback — split commands**, only if no such script exists on your base. Each command must start with the bare binary; do NOT combine them into one line with `$(...)` command substitution — the auto-mode permission classifier (Claude Code ≥2.1.205) denies that compound form and background workers die on it:
```bash
git rev-parse --git-common-dir      # resolve <common-dir> first, standalone
mkdir -p "<common-dir>/.zcr-reviewed"
git rev-parse "refs/heads/<branch>" > "<common-dir>/.zcr-reviewed/<branch with / replaced by __>"
```
A PreToolUse hook blocks `gh pr create` unless the marker exists AND matches the head branch's current tip — so a commit after review forces a re-review. Run from inside the repo/worktree (the common dir resolves to the shared `.git`, so worktrees and the main tree agree).

**Always pass `--head <branch>` to `gh pr create`** — the hook keys the marker off `--head`, which keeps the gate correct even when the command runs from a different worktree/cwd.

Escape hatch (rare, deliberate): `ZCR_SKIP=1 gh pr create …` for a genuine pure-docs/non-code exception. Default is: review → marker → PR.

## After the PR is opened

Artifact obligations (e.g. UI screenshots) are POST-PR per the repo's orchestration conventions (upload keys often need the PR number) — this gate doesn't block on them, the orchestrator's final check does.
