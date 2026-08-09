# Writing rules overlay — <repo>

Repo overlay for `writing/rules.md` in the skills repo. Fill every slot;
delete none. Agents read this file before editing any doc in this repo.

## Canonical terms

One row per concept. The banned column lists synonyms that must not appear
in new text; sweep them when touching a file.

| Concept | Canonical term | Banned synonyms |
| ------- | -------------- | --------------- |
| <the human principal> | <term> | <terms> |
| <a dispatched agent> | <term> | <terms> |
| <a unit of work> | <term> | <terms> |

## Glossary

One line per house term. A term used in any rule file must appear here.

- **<term>** — <one-line definition>.

## Registers

| Doc family | Register | Modality |
| ---------- | -------- | -------- |
| <agent rule files> | dense, imperative | severity tags / MUST-NEVER |
| <decision records> | declarative present, numbered | none |
| <product docs> | narrative | <soft vocabulary, defined here> |

## Enforcement

- Vague-verb sweep (warn): `<grep list, e.g. handle|manage|support|robust>`
- Hedge sweep (warn, agent-register paths only): `<grep list, e.g.
  should|consider|prefer|might>`
- <hook or check that runs the sweeps, or "manual at review">
