# agent-skills

Project-agnostic Claude Code skills for running a small multi-agent software team: a PM role, a TL role, a dispatch engine, and a pre-PR review gate. One person + one Claude session can wear any hat; workers (subagents) do all implementation in isolated git worktrees and open small labeled PRs.

## Two-tier architecture

These skills contain **zero project facts**. Every project-specific value — verify commands, label scheme, board identity, artifact rules, design principles — lives in a **conventions file committed in the target repo** at `.claude/orchestrate.md`. The skills read it at step 0 and resolve every `[conventions]` slot from it.

```
tier 1 (this repo, reusable)          tier 2 (each project repo, committed)
─────────────────────────────        ──────────────────────────────────────
orchestrate/SKILL.md  engine    ←──  .claude/orchestrate.md   conventions SSOT
pm/SKILL.md           role      ←──  .claude/review-checklist.md
tl/SKILL.md           role      ←──  docs (PRD / ADRs / plan / progress)
znut-code-review/     gate      ←──  repo-local hooks + helper scripts
```

New project = copy `templates/orchestrate.md` into the repo, fill it in, done. The skills work day one.

## Skills

| Skill | Role |
|---|---|
| `orchestrate` | Dispatch engine: decompose → worker-per-task in worktrees → verify/review gates → worker opens labeled PR → orchestrator final-checks. Not a role — pair with `/pm` or `/tl`. |
| `pm` | Product manager: requirements grill, PRD deltas, tickets + board, design direction + design locks. Auto-loads the engine, runs the conventions' PM session boot, reports ready. |
| `tl` | Tech lead: gates Ready tickets, dispatches workers, final-checks PRs, owns ADRs. Auto-loads the engine, runs the conventions' TL session boot, reports ready. |
| `znut-code-review` | Pre-PR review gate: deterministic banned-pattern grep + diff-scoped judgment review against the repo's checklist; sha-pinned PASS marker for hook enforcement. |

## Install

```bash
git clone <this repo> ~/src/agent-skills
for s in orchestrate pm tl znut-code-review; do
  rm -rf ~/.claude/skills/$s
  ln -s ~/src/agent-skills/$s ~/.claude/skills/$s
done
```

Symlinks keep bare skill names (`/pm`, not `plugin:pm`) and make edits in the clone live immediately.

## The conventions-file contract

`.claude/orchestrate.md` in the target repo. Sections the skills read (★ = required, others optional — skills skip silently when absent):

| Section | Read by | Contents |
|---|---|---|
| ★ Repo + identity | all | repo/remote/default branch, bot identity + token source, package manager |
| Layout + lanes | tl, orchestrate | paths → lane table; lane = concurrency mutex when >1 declared |
| Working-tree rule | all | who may touch the primary checkout (recommended: nobody but the human) |
| ★ Agent read order | all | ordered doc list workers read before coding (plan → decisions → progress) |
| Worker effort policy | orchestrate, tl | complexity → subagent type/effort table, approval gates |
| ★ Verify gate | orchestrate, tl | exact typecheck/lint/test/build commands + known traps |
| Review gate | orchestrate, znut-code-review | gate skill name, checklist path, marker script, enforcing hooks |
| PR merge/CI watch | orchestrate, tl | local PR-status service paths for merge watchers (else `gh` fallback) |
| ★ PR conventions | all | label table (paths → labels), body template, closing-keyword rules |
| Ticket conventions | pm, tl | tracker + board identity, required fields, native relationship APIs |
| TL conventions | tl | artifact rules (e.g. UI screenshots), worker-prompt rules block (pasted verbatim into every worker prompt), design-lock gate |
| PM conventions | pm | milestones, doc locations, design ideation flow + design-principles doc pointer, external requirements sources, confidentiality rules |
| Session boot (PM) / (TL) | pm, tl | cheap/local sources to check at role start (handoff notes, progress docs, PR-status files) + what the ready report covers |

`templates/orchestrate.md` is a fill-in starter covering all of the above.

## Design notes

- **Engine vs role**: `orchestrate` never decides what work is yours; `/pm` and `/tl` never restate how dispatch works. Both may load together on a small project.
- **Workers own the whole pipeline** (implement → self-review → green → push → PR → artifacts). The orchestrator never fixes a worker's output — it re-dispatches fresh with findings.
- **Chain depth 2 max**: manager → worker. Workers never spawn subagents.
- **Merge approval is always the human's**, per PR. Watchers detect merges; they never authorize them.

## Tools

`tools/` is a separate, config-driven family of local background services these
skills lean on but don't require: a multi-repo GitHub PR status poller
(`gh-status`), a project-board-to-markdown renderer (`board-snapshot`), and a
generic post-merge step runner (`on-merge`). Each target repo gets one JSON
file under `$AGENT_TOOLS_HOME/config/` (outside this repo — see
`tools/config/example.json` for the shape). See `tools/README.md` for the
config contract, `tools/install.sh` usage, and the migration checklist from
any prior per-repo service.
