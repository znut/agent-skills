# Writing rules — agent-facing docs

For docs agents read as instructions: skills, repo rules, conventions,
checklists, agent definitions. Human-narrative docs (decision records,
product docs) follow the repo's register table; rules 2, 4, 6, 7 still
apply. Each repo carries an overlay (`templates/writing-rules.md`): its
glossary, canonical-term table, register table. This file names no
repo-specific terms.

1. **Exact term, never a paraphrase.** A term of art is shorter and has one
   meaning: "the command's timeout", not "the normal command time". A plain
   word wins only when equally precise.

2. **One term, one meaning.** Every concept gets one name, recorded in the
   overlay's canonical-term table — synonym rotation reads as distinct
   concepts ("worker"/"agent"/"subagent" = three things). Two concepts
   sharing a word: rename one.

3. **Binding modality only.** A rule carries a severity tag (the repo's
   ladder, e.g. `BLOCK`/`FIX`/`WARN`) or `MUST`/`NEVER`. "Should",
   "consider", "prefer": bind it or delete it. One rule, one severity.

4. **Rule + why + example.** Mechanism in one clause, inline: "do X — Y
   breaks otherwise (#N)". A bare pointer is not a rationale. Add an example
   where misreading is likely; it must match the rule exactly — on conflict,
   readers copy the example.

5. **One instruction per sentence.** Imperative, active, present tense.
   25 words or fewer unless splitting loses precision. Never bury a
   constraint in a compound clause.

6. **No distant references.** No "above", "below", "this file" — name the
   file and section. Text quoted into another agent's prompt must still
   resolve there.

7. **State once, link elsewhere.** A rule lives in one file; every other
   file links. A rule pasted into three files drifts into three rules.

8. **Rule first, exception after.** Tables for enumerable facts, prose for
   mechanism, fenced code for commands.

9. **New term, same change.** A change that introduces a house term adds
   its one-line glossary entry with it.

10. **A style pass never trades precision for brevity.** Cutting words
    keeps every constraint, term, path, flag, and identifier. Shorter and
    vaguer is a regression.

11. **Hot docs state what IS** — a doc read every session never states a
    dead fact in present tense. A supersession note lives only while the
    old fact is reachable un-bannered at its source; a tempting dead-end
    becomes a ban with its why; pure provenance goes.
