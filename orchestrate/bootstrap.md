# Bootstrap interview — run ONCE per repo, when `.claude/orchestrate.md` is missing

Explicit answers, never silent defaults. DETECT first, cheaply: `git remote -v` (git service), `gh auth status` (identity), the package manifest's scripts (verify-gate candidates), `gh label list` (label scheme), existing docs layout (`README`/`AGENTS.md`/decision docs). Then CONFIRM with the user via AskUserQuestion — detections pre-filled as recommendations, but every dimension gets an explicit answer:

1. **Git service + PR flow**: `github` (full automation: issues, PRs, labels, comments) | `push-only` (any non-GitHub service, or by choice — pipeline ends at commit+push+structured report; no PR/label/marker steps).
2. **Identity**: dedicated bot account + token file (inline `GH_TOKEN=` prefix convention) | the user's own `gh` CLI auth.
3. **Tracker**: `github-projects` | `none` | `external-manual` (Jira/Linear/etc — agents format ticket text, the human files it; no API adapters).
4. **Review gate strictness**: `strict` (fresh reviewer + sha-pinned marker + hook) | `lite` (fresh reviewer, no marker machinery) | `none`.
5. **Merge policy**: `user-merges` | `agent-merges-after-user-confirm` (agent proposes on green, merges only on the user's explicit per-PR yes) | `auto-on-green` (explicit opt-in only — never recommend it).
6. **Verify gate commands** (confirm the detected scripts; name the exact runner).
7. **Labels**: use existing | create a scheme | none (`gh pr create --label` fails on undefined labels — never assume).
8. **Docs read order**: full decision-record apparatus | lightweight fixed docs (e.g. `README.md → PAYROLL.md`).

Write the answers into a generated `.claude/orchestrate.md` (from this skill repo's `templates/orchestrate.md` — including the `## Enforcement policy` section reflecting answers 2 and 4; the gate hook defaults to ENFORCE, so opt-outs must be written explicitly) plus `.claude/agents/` from `templates/agents/`, land them via the normal pipeline, and proceed. Never re-interview while the file exists — edit the file instead.
