---
name: worker-pipeline
description: >
  Pipeline contract for the codex-worker hybrid: Codex authors code, this
  wrapper owns conventions discovery, branch/worktree hygiene, the codex
  invocation, independent verification, a fresh-reviewer gate, and the
  ship steps (commit/push/PR/markers/self-clean). Project-specific facts
  (verify-gate commands, labels, PR body rules, marker procedure, read-order
  docs) come from the TARGET repo's own conventions file — this skill carries
  zero project facts. user-invocable: false.
user-invocable: false
---

# worker-pipeline — the codex-worker contract

You are dispatched with: target repo path, ticket/spec reference, branch name, Codex effort tier, and scope boundaries. Everything else below is procedure, not negotiable.

## Step 0 — read the target repo's conventions, not your assumptions

Read the TARGET repo's `.claude/orchestrate.md` and `.claude/review-checklist.md` **from `origin/<default>` tip**, never a possibly-stale worktree copy:

```bash
git -C <target-repo-or-worktree> fetch origin -q
git -C <target-repo-or-worktree> show origin/<default>:.claude/orchestrate.md
git -C <target-repo-or-worktree> show origin/<default>:.claude/review-checklist.md
```

Some repos commit a pointer file instead of the conventions directly (e.g. `.claude/orchestrate.md` containing only an `@`-include of another path, mirroring how `CLAUDE.md`/`AGENTS.md` chain in this ecosystem) — if what you read is a pointer, follow it to the real file before trusting anything in it. These files define: verify-gate commands, label scheme, PR body rules, the marker procedure (if the repo has one), and the doc read-order workers follow before writing code.

Then read the ticket or spec the dispatcher named, and any read-order docs the conventions point to (plan → decisions → progress, or the repo's lightweight equivalent).

**If no conventions file exists in the target repo: STOP and report.** Do not improvise a pipeline, do not guess at verify commands, do not invent labels. A missing conventions file is a blocker to surface, not a gap to fill.

## Step 1 — worktree and branch

All work happens in your assigned or self-created worktree — never the target repo's primary checkout. Branch from the **latest** `origin/<default>`:

```bash
git -C <worktree> fetch origin
git -C <worktree> checkout -B <branch> origin/<default>
git -C <worktree> log -1 origin/<default>
```

Confirm your worktree's HEAD matches that `origin/<default>` log line before writing anything. A stale fork point means re-run the fetch/checkout, not "close enough."

## Step 2 — Codex authors

Build the Codex prompt exactly as `codex-runtime` specifies, then invoke it. Codex implements the change and runs its own verify loop inside its sandbox.

You NEVER write or edit application code. The one explicit, narrow exception: you MAY run deterministic formatters (`prettier --write`, `gofmt`, etc.) on Codex's output — that is pipeline hygiene, not authorship. Every other gap, bug, or missing piece goes back to Codex as a new round; you do not hand-patch it.

## Step 3 — independent verify (never trust Codex's claims)

Re-run the conventions' verify-gate commands yourself, from scratch, in your worktree. A green claim in Codex's output is not evidence — only your own command output is.

**Schema tickets are special**: Codex may run the generate-migrations step only (its sandbox cannot bind local sockets, so it cannot apply/migrate). YOU run the migrate/apply step yourself, independently, after Codex hands back the generated migration.

Check scope discipline: `git status` (and `git diff --stat` against the branch base) must match the task's declared touch-list. Any out-of-scope file — touched, created, or deleted — is a review BLOCK, not a note.

## Step 4 — review gate (you are the fresh reviewer)

Codex authored the diff; you review it — author and reviewer are different roles even inside one dispatch. Review the full diff against the target repo's checklist (`.claude/review-checklist.md` if one exists, else general correctness/security/economy judgment): correctness, security, scope, dead code, test quality, and any repo-specific banned patterns.

- **BLOCK findings** → send them back to Codex verbatim, framed as "fix ONLY these," for exactly ONE more round.
- **Max 2 Codex rounds total.** Still red after round 2 → STOP, report the findings, open no PR. Do not attempt a third round and do not hand-fix it yourself to force a green.

## Step 5 — ship

Stage intended files **individually** — never `git add .` or `git add -A`. A conventional commit message that carries the why, not a restatement of the diff:

```bash
git -C <worktree> add <file> <file> ...
git -C <worktree> commit -m "<type>(<scope>): <subject>"
git -C <worktree> push -u origin <branch>
```

If the conventions define a marker procedure (verify-green and/or review-gate sha-pinned markers checked by a PreToolUse hook), execute it now, exactly as documented, before `gh pr create` — these are typically sha-pinned to the branch tip via a committed marker script.

Open a ready-for-review PR (no `--draft`) with the labels the conventions' path→label scheme assigns:

```bash
gh pr create --base <default> --head <branch> \
  --label "<labels per conventions>" \
  --title "<type>(<scope>): <subject>" \
  --body "<per the conventions' body template>"
```

Note Codex's authorship in the PR body (e.g. a short "Implemented by Codex (gpt-5.6-sol); reviewed and shipped by worker-codex" line) so the review trail is honest about who wrote what. Apply the conventions' closing-keyword rules (`Resolves #N` closes; a bare `#N` only links) exactly as documented — do not invent a convention the repo doesn't declare.

## Step 6 — self-clean

From outside the worktree:

```bash
git worktree remove <worktree-path>
```

Never `--force`. Two refusal cases mean different things:
- **pid-lock refusal** — expected for harness-created worktrees held for the session's lifetime. Report `worktree_cleanup: harness-locked` and move on; this is not a failure.
- **modified/untracked-files refusal** — means something never got committed or pushed. Report this loudly as unpushed work; do not force past it.

---

## Hard rules

- **No subagents, ever.** Not for research, not for review, not to parallelize scope. Spawning any agent/subagent from this pipeline is an automatic FAIL of the dispatch.
- **Never touch any primary checkout** — the target repo's or this plugin's. Worktrees only.
- **Stop-on-denial for required pipeline commands.** A denied `git`/`gh`/verify command is a hard stop: report the exact error verbatim. Never retry it altered, re-encoded, or with a bypass flag to route around the denial.
- **Optional, self-chosen tooling that fails** (a formatter you decided to run, a convenience lint) → skip it, continue the pipeline, and note the skip in your return. This is different from a required pipeline command failing.

## Return structure

Report exactly this shape when done (or when stopping short with findings):

```
pr_url: <URL, or "none — see open_questions">
branch: <branch>
labels: [applied labels]
codex_rounds: <1 or 2>
codex_notes: <what Codex reported doing, condensed>
files_changed: [list]
diff_stat: <N files changed, N insertions, N deletions>
verify_independent: <your own re-run results — pass/fail per command>
review: <BLOCK findings folded, or PASS on first pass>
markers: <n/a if the target repo has no marker machinery, else which markers were written>
worktree_cleanup: <removed | harness-locked | unpushed-work (loud)>
open_questions: [unresolved ambiguities — surfaced, not guessed at]
```
