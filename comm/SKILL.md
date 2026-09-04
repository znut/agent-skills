---
name: comm
description: >
  Rules for prose a person reads: chat replies, PR bodies, PR and ticket
  comments, ticket bodies, decision records, product docs, code comments,
  agent rules. Every role and every worker loads it before writing.
  Trigger: "/comm", "writing convention", "communication convention".
---

# Communication convention

PO = the person who owns the product and reads what agents write. Load this
skill before the first sentence the PO reads. The repo overlay
(`.agent/writing-rules.md`, from `templates/writing-rules.md`) owns the
canonical-term table, the glossary, any repo-only register, and the
machine-read sweep lists; it restates no rule from here.

## Registers

| Surface | Register | Never |
| --- | --- | --- |
| Chat reply | Result first, then what the reader must act on; 1–3 sentences unless asked for detail; tables only for real structure | Preamble, step narration, closing recap |
| PR body | The repo's body template owns the shape; one self-contained sentence, then only the non-empty sections | Restating the ticket, code facts visible in the diff, commands the gate runs, file lists, review history |
| PR / ticket comment | One claim per paragraph; quote the line you mean; end with the disposition (fold, ticket #N, decided) | "Flagging for awareness", a question with no owner |
| Ticket body | Problem · Included · Excluded · Acceptance · Schema | Implementation narrative, guessed business rules |
| Code comment | The repo checklist's Code section owns it: one line of WHY, then the mechanism name; ADR rationale = one clause + `(ADR-NNN)` | WHAT restatements, who/when/round, `#N` |
| Decision record (ADR) | Declarative present; numbered sections; trade-offs stated; an amendment is a dated section | Modality words, who decided, how the decision was reached |
| Product doc (PRD) | Narrative the PO and partners read, in the repo's product vocabulary | Engineering mechanism, ticket numbers in prose |
| Agent rules (`.agent/*.md`, skills, agent definitions) | Dense, imperative, rule + why inline, MUST/NEVER; a checklist is one-line bullets, each a BLOCK condition | should / consider / prefer / might; prose paragraphs in a checklist |

## Rules

1. **Decisions are rules, not history.** Write the rule now in force and the alternative rejected, with a `#N` or `ADR-NNN` pointer — never who decided, when, or in which round. "Ruled", "ruling", "per <person>", "<person> said" are narration. Every ticket/PR reference is bare `#N` — no other format, no date, no name, in any register; the ticket carries its own provenance.
2. **Rationale = one clause + pointer.** "X — Y breaks otherwise (#N)". A bare `(#N)` is not a reason; a paragraph is not a clause.
3. **Bind it or delete it.** should / consider / prefer / might become a rule with a severity, or nothing. handle / manage / support / robust / covers become the specific verb. The overlay lists the sweep terms; the repo's checks enforce them.
4. **One term, one meaning.** The overlay's canonical term, never a synonym — a synonym reads as a different concept. A new house term ships with its one-line glossary entry in the same change.
5. **Owner on every open item.** An open question names who settles it and by when, or becomes a ticket with a link.
6. **Limits are limits.** `## Not verified` holds only what was not tested; a known gap is a decision or an open question with an owner.
7. **State once, link elsewhere.** A rule lives in one file; every other surface links to it by file and section — never "above", "below", "this file".
8. **A style pass keeps every constraint.** Every SHA, path, flag, term and `#N` survives an edit. A doc read every session states only what IS: a dead fact goes, a tempting dead-end becomes a ban with its why.

## Loading

- `/tl`, `/pm`, `/orchestrate`, `/review-gate`: at session start — their output is prose the PO reads all session.
- Workers: at the PR step, immediately before writing the PR body, a PR comment, or ticket text — a rule read an hour earlier decays. Code comments follow the code rules pasted into the contract.
- Reviewers: when the writing focus is theirs.
