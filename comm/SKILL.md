---
name: comm
description: >
  Rules for prose the PO reads: chat replies, PR bodies, PR and ticket
  comments, ticket bodies, decision records, product docs, code comments,
  cross-session pings, partner messages. Every role and every worker loads it
  before writing. Trigger: "/comm", "writing convention", "communication
  convention".
---

# Communication convention

PO = the person who owns the product and reads what agents write. Load this
skill before the first sentence the PO reads. The register table names the
surface; the rules bind every surface in it.

`writing/rules.md` (this repo) is the base for agent-facing docs. A repo
overlay (`.agent/writing-rules.md`, from `templates/writing-rules.md`) owns the
repo's glossary, its canonical-term table, and the machine-read sweep lists.
The overlay links here; it restates no rule.

## Registers

| Surface | Register | Never |
| --- | --- | --- |
| Chat reply to the PO | Result first, then what they must act on; 1–3 sentences unless asked for detail; tables only for real structure | Preamble, narration of steps, closing recap of the same message |
| PR body | Only what the ticket cannot know: `## Decisions` (choice + rejected alternative) · `## Deltas` (found or fixed in passing; deliberately untouched) · `## Running it` · `## Not verified` (untested limits only) · `## Open questions` · `## Screenshot` · `Resolves #N` | `## Problem`/`## Summary`, file lists, diff stats, checkmarks, review-round or contract history |
| PR / ticket comment | One claim per paragraph; quote the line you mean; end with the disposition (fold, ticket #N, ruled) | "Flagging for awareness", open-ended questions with no owner |
| Ticket body | Problem · Included · Excluded · Acceptance · Schema (`none` or column + why) | Implementation narrative, guessed business rules |
| Code comment | One line of WHY, then the mechanism name (`see validateX`); ADR rationale = one clause + `(ADR-NNN)` | WHAT restatements, provenance (who/when/round), non-English words, > 5 lines |
| Decision record (ADR) | Declarative present; numbered sections; trade-offs stated; amendment = dated section | Modality words, narrative of how the decision was reached |
| Product doc (PRD) | Narrative the PO and partners read; hard/soft vocabulary as the repo defines it | Engineering mechanism, ticket numbers in prose |
| Cross-session ping (bus) | Frontmatter `from/subject/refs`; numbered facts; one ask per number; "Archive after reading." | Chat filler, questions the reader cannot answer |
| Partner channel (Lark etc.) | Partner language only; zero emoji; acknowledge, then one TLDR; the PO releases every message | English, emoji, unsolicited nudges |

## Rules

1. **Decisions are rules, not history.** Write the rule the code now follows
   and the alternative rejected — never "a first review round found…", never
   "per the dispatch contract". The reader sees the PR, not the round.
2. **Rationale = one clause + pointer.** "X — Y breaks otherwise (#N)". A bare
   `(#N)` is not a reason; a paragraph is not a clause.
3. **No hedges, no vague verbs.** should / consider / prefer / might → bind it
   or delete it. handle / manage / support / robust / covers → the specific
   verb. Repo overlays list the exact sweep terms; `final-check` enforces them
   on PR bodies.
4. **Exact term, one meaning** (`writing/rules.md` 1–2): use the overlay's
   canonical term; a synonym reads as a different concept.
5. **Owner on every open item.** An open question names who rules it and by
   when, or it becomes a ticket with a link — never "worth a follow-up".
6. **Limits are limits.** `## Not verified` holds only what was not tested;
   a known behaviour gap is a Delta or an Open question with an owner.
7. **State once, link elsewhere** (`writing/rules.md` 7): a rule lives in one
   file; every other surface links.
8. **Numbers and identifiers survive every edit** (`writing/rules.md` 10):
   a style pass keeps every SHA, path, flag, term, and `#N`.
9. **Bare `#N` only.** Ticket and PR references are `#N` — no dates, no names,
   no "PO ruled on…" — the ticket carries its own provenance.

## Enforcement

- `scripts/final-check.sh` (repo) fails a PR body on any overlay sweep-list
  hit in Decisions / Deltas / Not verified / Open questions.
- The review panel's `+writing` focus reads the PR body and every added
  comment on every PR.
- Chat and bus text: self-check against the register table before sending;
  no tool enforces them.

## Loading

- `/tl`, `/pm`, `/orchestrate`, `/review-gate`: load at session start — their
  output is prose the PO reads all session.
- Workers: load at the PR step, immediately before writing the PR body, a PR
  comment, or ticket text — not at contract start; a rule read an hour before
  the body is written decays. Code comments follow the code rules pasted into
  the contract.
- Reviewers: load when the panel's `+writing` focus is theirs.
- A repo's worker conventions name it in the PR step: "load `/comm`, then
  write the body to its PO-facing register".
