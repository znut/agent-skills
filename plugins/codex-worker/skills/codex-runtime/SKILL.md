---
name: codex-runtime
description: >
  Internal, locked contract for how the codex-worker wrapper invokes Codex —
  prompt-file discipline, the single sanctioned entry point
  (scripts/run-codex.mjs), the mandatory constraints preamble every Codex
  prompt opens with, and the prompt-body rules that keep a Codex round
  closed-ended and reviewable. user-invocable: false.
user-invocable: false
---

# codex-runtime — locked invocation contract

Use this skill only from inside `worker-codex` / `worker-pipeline`, at Step 2 ("Codex authors").

## Write the prompt to a file, outside the repo tree

Write the full Codex prompt to a file **beside the worktree, not inside it** (e.g. a sibling scratch path) — never inline it as a Bash heredoc. macOS's default `/bin/bash` is 3.2, and it mangles `$(...)` command substitution combined with backticks inside heredoc bodies; a prompt with either construct silently corrupts. A plain file has no such trap.

## Invoke only through run-codex.mjs

The **only** sanctioned entry point is:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-codex.mjs" --prompt-file <path> --model <id> --effort <tier>
```

This call is synchronous — it blocks until Codex finishes. Capture its full stdout/stderr; that is the record of what Codex did.

Never call the `codex` CLI directly. Never call the openai-codex plugin's `codex-companion.mjs` with hand-built flags, and never bypass `run-codex.mjs` to reach it "just this once." `run-codex.mjs` is the choke point that keeps every Codex invocation narrow and auditable — going around it defeats the whole point of the wrapper.

## The mandatory constraints preamble

Every Codex prompt file MUST open with this block, verbatim except for `<repo>`:

```
You are editing code in a checkout of <repo> (your current working directory).
CONSTRAINTS: do NOT run any `git` or `gh` command — the caller owns version
control; never read token/credential files; never set skip/bypass
environment flags. If a REQUIRED pipeline command is blocked or denied, STOP
and report the exact error. If an OPTIONAL tool you chose yourself fails,
skip it, continue, and note it.
```

## Prompt body rules (after the preamble)

- **Closed-ended**: state exactly what to build/fix — not an open invitation to explore or redesign.
- **Hard touch-list**: name the exact files/paths in scope. Anything else is out of bounds.
- **Verify commands, verbatim**: paste the target repo's conventions' verify-gate commands exactly as written — no paraphrasing, no "run the usual checks."
- **"Do not commit."** Codex edits the working tree only; the wrapper owns git.
- **Final-output field list**: tell Codex exactly what to report back (files touched, verify results, any blockers hit) so its output is easy to fold into the wrapper's own independent verify and review steps.
- **Bun cache fallback**: if the target repo uses Bun and Codex's sandbox can't reach the usual global cache, include `BUN_INSTALL_CACHE_DIR="$PWD/.cache/bun"` in the commands Codex is told to run.

Keep the prompt self-contained — Codex has no memory of this conversation and no access to anything outside the target repo checkout and the prompt file itself.
