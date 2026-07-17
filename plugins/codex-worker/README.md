# codex-worker

A hybrid implementation worker for Claude Code: **Codex authors the code, a Claude wrapper owns everything else** — reading the target repo's conventions, git/gh mechanics, independent verification, a fresh-reviewer gate, and the PR.

Codex is fast and cheap to re-run but has no memory of your repo's conventions and no stake in whether its own diff is correct. The wrapper is the opposite: it never writes application code, but it holds the pipeline state, reads the conventions once per dispatch, and never trusts a "looks green to me" from the process it just spawned.

## Three layers

```
┌─────────────────────────────────────────────────────────────┐
│ agents/worker-codex.md                                       │
│   The role. Dispatched by name; reads the two skills below   │
│   as a binding contract before doing anything.                │
└───────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│ skills/worker-pipeline/  +  skills/codex-runtime/             │
│   The contract. Conventions discovery → worktree/branch →     │
│   codex invocation → independent verify → fresh review →      │
│   ship (commit/push/PR/markers) → self-clean. codex-runtime   │
│   is the narrow, locked sub-contract for talking to Codex.     │
└───────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│ scripts/run-codex.mjs  +  hooks/hooks.json + scripts/guard.mjs│
│   The enforcement. run-codex.mjs is the ONLY sanctioned entry │
│   point into the openai-codex plugin's companion runtime — a  │
│   4-flag allowlist, no shell. guard.mjs is a PreToolUse/Bash   │
│   hook that blocks any attempt to route around it.             │
└─────────────────────────────────────────────────────────────┘
```

## Install

```bash
claude plugin marketplace add ~/src/agent-skills
claude plugin install codex-worker@agent-skills --scope project
```

## Requirements

- The [`openai-codex`](https://github.com/openai/codex-plugin-cc) plugin installed (`codex@openai-codex` in `~/.claude/plugins/installed_plugins.json`) — `run-codex.mjs` resolves its companion script from there at call time.
- The `codex` CLI authenticated on the machine running the dispatch.

## Dispatch

```
Agent({
  subagent_type: "codex-worker:worker-codex",
  description: "Implement ticket #42",
  prompt: `
    Target repo: /path/to/repo (work in a fresh worktree you create there)
    Ticket: #42 — <title>, see .claude/tickets/042.md for acceptance criteria
    Branch: feat/042-short-slug
    Codex effort: medium
    Scope boundaries: only src/lib/foo/**, no schema changes, no new deps.

    Read the target repo's .claude/orchestrate.md and
    .claude/review-checklist.md from origin/<default> tip first — they own
    every project-specific fact (verify commands, labels, PR body rules).
    Follow the worker-pipeline skill's contract exactly. Report the full
    return structure when done.
  `,
})
```

Everything past that brief — the pipeline, the Codex prompt shape, the review gate, the PR — comes from `worker-pipeline` and `codex-runtime`, not from the dispatch prompt.

## Provenance

This contract was distilled from calibration runs 4–7 against a private application repo (2026-07-17): repeated observation of where a Codex-authored diff needed an independent, non-authoring verify pass and a fresh review round before it was safe to ship, and where a hand-rolled Codex invocation needed to be locked down to a narrow, auditable entry point.
