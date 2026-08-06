# Bootstrap interview — run ONCE when repo conventions are missing

Explicit answers, never silent defaults. DETECT first, cheaply: `git remote -v` (git service), `gh auth status` (identity), the package manifest's scripts (verify-gate candidates), `gh label list` (label scheme), existing docs layout (`README`/`AGENTS.md`/decision docs). Then CONFIRM with the user through the runtime's user-input mechanism — detections pre-filled as recommendations, but every dimension gets an explicit answer:

1. **Git service + PR flow**: `github` (full automation: issues, PRs, labels, comments) | `push-only` (any non-GitHub service, or by choice — pipeline ends at commit+push+structured report; no PR/label/marker steps).
2. **Identity**: dedicated bot account + token file (inline `GH_TOKEN=` prefix convention) | the user's own `gh` CLI auth.
3. **Tracker**: `github-projects` | `none` | `external-manual` (Jira/Linear/etc — agents format ticket text, the human files it; no API adapters).
4. **Review gate strictness**: `strict` (fresh reviewer + sha-pinned marker + hook) | `lite` (fresh reviewer, no marker machinery) | `none`.
5. **Merge policy**: `user-merges` | `agent-merges-after-user-confirm` (agent proposes on green, merges only on the user's explicit per-PR yes) | `auto-on-green` (explicit opt-in only — never recommend it).
6. **Verify gate commands** (confirm the detected scripts; name the exact runner).
7. **Labels**: use existing | create a scheme | none (`gh pr create --label` fails on undefined labels — never assume).
8. **Docs read order**: full decision-record apparatus | lightweight fixed docs (e.g. `README.md → PAYROLL.md`).
9. **Agent runtime**: detect and confirm the active provider/harness, its
   provider-native agent-definition location, the ordered worker ladder, the
   reviewer agent type, substantive review allowance per tier, and concurrency
   cap. Never translate model names between providers or assume inheritance.

Write the answers into canonical `.agent/orchestrate.md`, including the
enforcement policy reflecting answers 2 and 4. Identity and marker guards
default to ENFORCE, so opt-outs must be explicit; include opt-in draft-first or
label checks only when requested. Generate or update provider-native agent
definitions without overwriting unrelated provider configuration:

- Codex: register project agents in `.codex/config.toml` and define them under
  `.codex/agents/*.toml`.
- Claude: define project agents under `.claude/agents/*.md` and add only the
  provider shim or hook configuration the repo requires.
- Other runtimes: use their documented project-scoped agent format.

Land the files through the normal pipeline and proceed. Never re-interview
while canonical conventions exist; edit them instead.
