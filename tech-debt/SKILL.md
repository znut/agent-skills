---
name: tech-debt
description: >
  Weekly technical-debt revisit. Gather the week's friction signals (hot spots,
  repeated review findings, flaky and slow tests, worker hiccups), scan for
  deepening and deletion candidates in the design vocabulary, present a private
  report, settle each candidate with the user, and turn the takes into sized
  tickets and decision-record amendments. Never refactors directly.
  Trigger: "/tech-debt", "debt revisit", "architecture review", "weekly cleanup",
  "what should we simplify".
---

# Tech debt revisit

One session a week, in spare capacity, after the product queue. The output is
tickets and decision records, never code: every change still goes through
`/tl` and `/orchestrate`.

Load `/comm` first. Read the repo rules as `/orchestrate` directs. Read
[DESIGN.md](DESIGN.md) and use its vocabulary exactly — **module, interface,
implementation, depth, seam, adapter, leverage, locality** — in every
candidate; never "component", "service", "API", "boundary".

## Repo facts this skill reads

The repo rules (or the user, once, on first run) name:

- the glossary (root map + per-app glossaries) — the domain names for seams;
- the decision-record directory — settled choices this skill does not reopen
  without flagging;
- the review checklist — the findings taxonomy;
- the health and gate logs — flake and duration evidence;
- the ticket tool and its required fields;
- the label or field that marks a debt ticket;
- the stamp file for the last revisit (`<var>/tech-debt/last-run`).

## 1. Gather the week's signals

Since the last stamp (default seven days). Numbers, with anchors.

1. **Hot spots** — `git log --since=<stamp> --name-only` on the default branch:
   files touched by three or more merged PRs. Recent change is where deepening
   pays back (YAGNI: weight these first).
2. **Repeated findings** — FIX and WARN findings that recurred across this
   week's PRs (review returns, PR comments, the dispatch dataset's caveat
   field). Three repeats of one checklist item = a mechanism gap, not a worker
   gap.
3. **Test health** — from the health and gate logs: specs that failed and
   passed on retry (flakes, with counts), the three costliest gate steps, the
   fifteen slowest test files, runs red on main and why.
4. **Worker friction** — harness facts from the week's handoff notes: steps
   workers could not run, setup a fresh worktree needed, resumes that failed.
5. **Open debt** — debt tickets already on the board, and last week's takes:
   merged, open, or dropped. Never cut a duplicate.

Send the log and code reads to read-only search agents; keep the conclusions.

## 2. Scan for candidates

Spawn read-only agents over the hot spots and the flake owners. Note friction,
not heuristics:

- one concept understood only by bouncing across many small modules;
- a **shallow** module — interface nearly as complex as its implementation;
- pure functions extracted for testability while the bugs live in how they are
  called (no **locality**);
- state leaking across a seam (two apps reading one table, a mirror kept by
  hand);
- code untestable through its interface, so tests reach past it;
- tests with no owner: tombstones, framework re-tests, the same behaviour
  asserted at three tiers.

Apply the **deletion test** to every suspect: would deleting it concentrate
complexity, or only move it? Concentrate = candidate.

Classify each candidate's dependencies per [DEEPENING.md](DEEPENING.md) —
that decides how the deepened module is tested.

**Simplify first.** For every candidate the first option is zero new
mechanism: delete, merge, or reuse what exists. A new table, flag, wrapper,
cache, or port is proposed only when it becomes the sole owner of one effect,
and the candidate names that effect. Two adapters make a seam; one is
indirection.

## 3. Present the report

A private artifact (never a repo file), one page:

- **Header** — week, stamp range, merged-PR count, gate cost (median gate
  minutes, red runs on main).
- **Test health** — flake table (spec, app, count, ticket), slowest files,
  proposed deletions (tombstone / framework re-test / duplicate tier) with
  anchors and the seconds saved.
- **Candidates** — one card each: files · problem (one sentence) · solution
  (one sentence) · wins (≤6 words each, in leverage and locality terms) ·
  before/after diagram (mermaid where the shape is a graph; plain boxes
  otherwise) · dependency category · size (`one PR` / `two PRs in order` /
  `needs a decision record first`) · strength badge `Strong` / `Worth
  exploring` / `Speculative` · decision-record callout when a candidate
  contradicts one — only when the friction is real enough to reopen it.
- **Top three** — what to take this week and why.

No interfaces yet. End with: "Which of these do you take?"

## 4. Settle each candidate

For each take, walk the constraints with the user: what varies across the
seam, what sits behind it, which tests survive. Test rule: **replace, don't
layer** — tests at the deepened interface replace the unit tests on the
shallow modules they absorb; a test that must change when the implementation
changes was testing past the interface.

Rulings:

- **Take** → a ticket, sized to one PR, with Problem · Included · Excluded ·
  Acceptance · Schema, ordered `blocked_by` when files are shared.
- **Park** → the candidate and the reason go in the report's archive; it
  returns next week only if the signal repeats.
- **Reject with a load-bearing reason** → a decision-record entry, so no
  future revisit re-suggests it. Skip ephemeral reasons ("not this week").
- **Name a deepened module after a term the glossary lacks** → the glossary
  gains the term in the same PR as the code.
- **Alternative interfaces wanted** → [DESIGN-IT-TWICE.md](DESIGN-IT-TWICE.md).

## 5. Deliver

- Tickets through the repo's ticket tool with every required field; the debt
  marker set; a link back to the report.
- Decision-record amendments and glossary edits through `/orchestrate` (a
  worker, a worktree, a fresh review, a PR).
- Flake fixes are tickets of the same shape: the spec waits on the state it
  asserts; behaviour under test untouched; acceptance = N consecutive runs
  under parallel load.
- Write the stamp. Report: takes, parks, rejects, tickets cut, and last week's
  takes that landed.

## Hard rules

- No application code from this skill; no direct refactor; no merge.
- The debt lane never pre-empts the product queue — dispatch priority stays
  with the user.
- Every candidate carries the deletion-test verdict and its dependency
  category; every take carries a ticket number before the session ends.
- A candidate that contradicts a decision record is flagged, never silently
  proposed.
