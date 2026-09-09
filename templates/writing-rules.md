# Writing rules overlay — <repo>

The `comm` skill owns every prose rule and register. The overlay owns what is
repo-specific: canonical terms, glossary, repo-only registers, sweep lists.

## Canonical terms

Banned synonyms never appear in NEW text; sweep them convert-as-touched.

| Concept | Canonical | Banned synonyms |
| --- | --- | --- |
| The person who owns the product | `<repo term>` | the user, the human, stakeholder |

## Glossary — workflow terms

- **<term>** — <one line>.

## Repo-only registers

| Surface | Register | Never |
| --- | --- | --- |

## Sweep lists

<which check reads which list, on which paths>. One term per line, `#`
comments allowed, `[section]` headers select the list; edit here, not scripts.

```text
[hedge-vague]
should
consider

[narration]
review round
round 1

[attribution]
ruled
per <repo term>
```
