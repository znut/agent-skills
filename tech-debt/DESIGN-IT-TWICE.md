# Design it twice

For a taken candidate whose interface is not obvious. The first idea is
rarely the best; make three and compare.

## 1. Frame the problem

Write for the user: the constraints any interface must satisfy, the
dependencies and their category ([DEEPENING.md](DEEPENING.md)), and a short
code sketch that makes the constraints concrete — not a proposal. Show it,
then start step 2 while the user reads.

## 2. Three designs in parallel

Spawn three read-only agents (a fourth when a cross-seam dependency exists),
each with the same technical brief (paths, coupling, dependency category, what
sits behind the seam, the glossary terms for the domain and
[DESIGN.md](DESIGN.md) for the architecture) and one distinct constraint:

- **Minimal** — one to three entry points; maximise leverage per entry point.
- **Common case** — the default caller's call is trivial.
- **Flexible** — many use cases and extension points.
- **Ports and adapters** — for a remote or external dependency.

Each returns: the interface (types, invariants, ordering, error modes) · a
usage example · what the implementation hides · dependency strategy and
adapters · trade-offs (where leverage is high, where thin).

## 3. Compare and recommend

Present the designs one at a time, then compare on depth, locality and seam
placement. Give one recommendation, or a named hybrid. Then apply the
simplify-first test once more: does the recommended interface add a mechanism
the codebase lacks, and is it the sole owner of the effect it introduces? The
answer goes in the ticket's Included / Excluded.
