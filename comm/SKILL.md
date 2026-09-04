---
name: comm
description: >
  Rules for communication and writing: chat replies, PR bodies, comments,
  decision records, product docs, agent rules.
  Trigger: "/comm", "writing convention", "communication convention".
---

# Communication convention

PO = the person who owns the product. Load this skill before talking. The repo overlay
(`.agent/writing-rules.md`, from `templates/writing-rules.md`) owns the
canonical-term table, the glossary, any repo-only register, and the
machine-read sweep lists.

## Registers

| Surface | Register |
| --- | --- |
| Chat reply | Result first, then what the reader must act on; 1–3 sentences unless asked for detail; tables only for real structure |
| Decision record (ADR) | Declarative present; numbered sections; trade-offs stated; amend inline, history to archive | 
| Product doc (PRD) | Focus on What, Why and goals without dictating the technical "how". |
| Agent rules (`.agent/*.md`, skills, agent definitions) | Dense, imperative, rule + why inline, MUST/NEVER; a checklist is one-line bullets, each a BLOCK condition |

## Rules

1. **Decisions are rules, not history.** Write the rule now in force and the alternative rejected, with a `#N` or `ADR-NNN` pointer.
2. **Rationale = one clause + pointer.** "X — Y breaks otherwise (#N)". A bare `(#N)` is not a reason; a paragraph is not a clause.
3. **Bind it or delete it.** should / consider / prefer / might become a rule with a severity, or nothing. handle / manage / support / robust / covers become the specific verb. The overlay lists the sweep terms; the repo's checks enforce them.
4. **One term, one meaning.** The overlay's canonical term, never a synonym — a synonym reads as a different concept. A new house term ships with its one-line glossary entry in the same change.
5. **Owner on every open item.** An open question names who settles it and by when, or becomes a ticket with a link.
6. **Limits are limits.** `## Not verified` holds only what was not tested; a known gap is a decision or an open question with an owner.
7. **State once, link elsewhere.** A rule lives in one file; every other surface links to it by file and section — never "above", "below", "this file".
8. **A style pass keeps every constraint.** Every SHA, path, flag, term and `#N` survives an edit. A doc read every session states only what IS: a dead fact goes, a tempting dead-end becomes a ban with its why.
