# Design vocabulary

Deep modules: a lot of behaviour behind a small interface, at a clean seam,
testable through that interface. The aim is leverage for callers, locality for
maintainers, testability for everyone. Use these terms exactly.

## Glossary

- **Module** — anything with an interface and an implementation: a function,
  a package, a route family, a cross-app slice. Not "unit", "component",
  "service".
- **Interface** — everything a caller must know to use the module correctly:
  signature, invariants, ordering, error modes, required config, cost. Not
  "API", "signature".
- **Implementation** — the body behind the interface.
- **Depth** — leverage at the interface: how much behaviour a caller or test
  exercises per unit of interface learned. Deep = small interface, large
  behaviour. Shallow = interface nearly as complex as the implementation.
- **Seam** — the place where behaviour can change without editing there; where
  a module's interface lives. Where the seam goes is its own decision. Not
  "boundary".
- **Adapter** — a concrete thing that satisfies an interface at a seam; a
  role, not a substance (an HTTP read, an in-memory fake).
- **Leverage** — what callers get from depth: one implementation repaid across
  N call sites and M tests.
- **Locality** — what maintainers get from depth: change, bugs, knowledge and
  verification concentrate in one place.

## Principles

1. **Depth is a property of the interface.** A deep module may be built from
   small internal parts; they are not part of its interface. Internal seams
   (private, used by the module's own tests) stay internal.
2. **The deletion test.** Delete the module in your head. Complexity vanishes:
   it was a pass-through. Complexity reappears across N callers: it earned
   its keep.
3. **The interface is the test surface.** Callers and tests cross the same
   seam. A test that reaches past the interface says the module is the wrong
   shape.
4. **One adapter is a hypothetical seam; two are a real one.** No port until
   something varies across it (production + test counts as two).
5. **Simplify first.** The zero-new-mechanism option is evaluated before any
   other; a new mechanism is proposed only as the sole owner of one named
   effect. Minimum correct code; tests exercise our logic, edges, and known bugs
   — never the framework.
6. **Accept dependencies, return results.** A module that constructs its own
   dependencies or mutates its inputs is hard to test through its interface.

## Interface questions

- Fewer entry points?
- Simpler parameters?
- More hidden inside?
- Which facts must a caller know that the type does not say? Write them down;
  they are interface.

## Rejected framings

- Depth as lines-of-implementation over lines-of-interface: rewards padding.
- "Interface" as the TypeScript keyword or a class's public methods: too
  narrow.
- "Boundary": overloaded with bounded contexts.
