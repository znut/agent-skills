# Orchestration conventions — <project>

Project-specific layer for the generic `/orchestrate` engine and its roles (`/tl`, `/pm`). The skills read this file at step 0; every `[conventions]` slot resolves here. Delete any optional section you don't need — skills skip silently.

## Repo + identity

- Repo: `<org>/<repo>` (remote `origin`), default branch `<main>`.
- Operate as `<bot-or-user>`: `<how gh/git authenticate — token file, credential helper>`.
- Package manager: `<bun|pnpm|npm|cargo|…>` (lockfile rules).

## Layout + lanes

- `<path>` → `<lane>` (`<label>`)
- `<path>` → `<lane>` (`<label>`)

Declared lanes: `<none | list>`. <If >1: a `/tl` session picks one before dispatching; lane = concurrency mutex.>

## Working-tree rule

The primary checkout is reserved for `<the human>`. Every agent does ALL git work in its own worktree; `git fetch origin` is the only allowed primary-tree operation.

## Agent read order

`<README/AGENTS.md>` → `<plan doc>` → `<decision records dir>` → `<progress docs>`.

## Worker agents

The standard complexity→effort ladder and model-escalation policy live in the /orchestrate skill. Define the worker/reviewer agents in `.claude/agents/` (bootstrap from the skill repo's `templates/agents/`). Note repo-specific deviations here: `<e.g. renamed tiers, extra approval gates — or delete this line>`.

## Verify gate

```bash
<typecheck command>
<lint command>
<test command — name the exact runner; wrong-runner traps go here>
<build command if the compiler misses route/config errors>
```

Known traps: `<e.g. linter ignores dotdirs; scope commands to touched workspace>`.

## Review gate (optional)

Run the `review-gate` skill on the diff BEFORE `gh pr create`, inside a fresh `reviewer` subagent (the author of a diff never reviews it). Checklist: `<.claude/review-checklist.md>`. Mechanical pass script: `<scripts/review-grep.sh | none — grep table by hand>`. Marker: `<scripts/review-mark.sh — pins PASS to the branch tip; hook checks it at gh pr create>`. Skip variable for pure-docs diffs: `<REVIEW_GATE_SKIP=1 | none>`.

## PR merge/CI watch (optional)

`<local PR-status service: paths to status/event files, or delete this section — skills fall back to gh>`

## PR conventions

### Labels

| Paths touched | Label |
|---|---|
| `<path>` | `<label>` |
| docs: `<product docs>` | `<pm-label>` |
| docs: `<engineering process>` | `<tech-label>` |

### Body + tickets

- `Resolves #N` for the issue a PR completes; plain `#N` for tracking issues that stay open.
- Body sections (omit empty ones): `## Decisions` · `## Deltas` · `## Running it` (⚠️ irreversibles) · `## Not verified` · `## Open questions` · `<## Screenshot if UI>` · `Resolves #N`.
- Banned: file lists, diff stats, verify checkmarks, restating the ticket's problem.
- One small concern per PR; ready-for-review, never draft.

## Ticket conventions

- Tracker: `<GitHub issues | …>`. Board: `<name/id>`.
- Title prefix scheme: `<[Component] …>`.
- Required fields on every new issue: `<milestone, component, tier, iteration, …>`.
- Relationships are NATIVE (`<blocked-by API / sub-issues>`), never prose-only. Same-file sequencing IS blocking.

## TL conventions

### Artifact rules (optional)

`<e.g. UI PRs need before/after screenshots: how to capture, where to host, what's banned (committing them, real data)>`

### Worker prompt rules (paste into every worker prompt — engine contract slot 4c)

- `<banned APIs / required shared libs>`
- `<style constraints>`
- `<domain rules — datetime, money, i18n, confidentiality>`

### Design-lock gate (optional)

`<UI tickets dispatch only with a locked design spec; who locks, what the spec contains>`

## PM conventions

- Milestones: `<scheme>`.
- Product spec → `<docs/prd/>`; engineering decisions → `<docs/decisions/>`; roadmap SSOT → `<plan doc>`.
- Design principles: `<path to design-principles doc — density, composition, breakpoints; enforced in every generation prompt, critique pass, and lock>`.
- Design ideation flow: `<tooling → stakeholder lock → reference + spec deltas on the ticket>`.
- Requirements sources: `<where stakeholder input lives>`.
- Confidentiality: `<what never enters the tracker/repo>`.

## Session boot (PM)

1. Consume session-handoff notes flagged in the memory index (honor "delete when consumed").
2. Read `<progress docs>` from the default-branch tip.
3. Check PR/merge state via `<free/local sources — PR-status files, one cheap gh call>`.
4. NO expensive tracker/board scans at boot — query on demand only.
5. Open with a ready report: open loops, in-flight PRs, pending design locks, date-sensitive items.

## Session boot (TL)

1–3 as PM boot, then:
4. Read the Ready queue only when about to dispatch (targeted query, never a full board scan).
5. Open with a ready report: open loops, in-flight PRs, blocked chains, proposed first dispatch.
