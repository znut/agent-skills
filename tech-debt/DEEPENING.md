# Deepening

How to deepen a cluster of shallow modules safely. Classify each dependency;
the category decides how the deepened module is tested across its seam.

## Dependency categories

1. **In-process** — pure computation, in-memory state. Merge the modules and
   test through the new interface. No adapter.
2. **Local-substitutable** — a local stand-in exists in the test suite (a
   local database engine, an in-memory filesystem, a browser runner). Test
   with the stand-in; the seam stays internal — no port at the external
   interface.
3. **Remote but owned** — your own service across a network edge. Define a
   port at the seam; the deep module owns the logic; production injects the
   transport adapter, tests inject an in-memory adapter. Where the repo already
   has a cross-service read contract idiom (typed contract + cached pull),
   that idiom is the port — reuse it, do not add a second shape.
4. **True external** — third parties you do not control. The module takes the
   dependency as an injected port; tests provide a fake adapter. Do not
   simulate the third party's state machine in tests — test your mapping
   logic, leave the transport as thin glue verified by the real integration.

## Seam discipline

- Two adapters make a seam. A single-adapter port is indirection — delete it
  or wait for the second adapter.
- Internal seams stay internal. Tests that need them are the module's own.
- Direction laws in the repo's decision records (who owns a table, who may
  read whom, no new mirrors) bound where a seam may go. A candidate that
  needs a new mirror or a reverse read is a decision-record change first.

## Testing: replace, don't layer

- Unit tests on the absorbed shallow modules become waste once tests at the
  deepened interface exist — delete them in the same PR.
- New tests assert observable outcomes through the interface, not internal
  state, and survive internal refactors.
- Tests that assert the non-existence of something must name the live rule
  that owns the absence; an absence with no owner is a tombstone — delete it
  with the feature.
- Keep the count proportionate: our logic, load-bearing edges, known bugs.
