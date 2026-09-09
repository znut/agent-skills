# Migrating to the slimmed skills

For a machine or repo that used this repo before `chore/slim-skills` merged
(2026-09-09). Delete `MIGRATION.md` once every machine and repo you run is
through it.

## What changed

- The review-gate PreToolUse hook and every SHA marker are gone. Proof of
  checks is the repo's CI or its local gate result for the PR head. The
  reviewer records its verdict where the repo rules say; the default for PR
  delivery is a PR review naming the reviewed SHA. `bgh pr ready <n>` runs
  the clone's declared ready check first.
- Draft-first is a delivery value in the repo rules, not a hook setting. The
  draft opens before the review so evidence lands on the PR.
- The base is the newer of local and origin default when one contains the
  other. A re-review reads only the delta since the last verdict.
- orchestrate, review-gate, tl, and pm are rewritten around invariants and
  outcomes; the return form and the failures table are gone.
- boot-report writes the session role marker for Claude Code, pi, and Codex
  and prints the last main-health verdict; the UserPromptSubmit role-marker
  hook is gone.
- main-health takes its steps from the config's `mainHealth` block.
- The poller writes `status/pr-<n>.json`, `status/state.json`,
  `events/pr-<n>.log`, `events/pr-<n>.merged`, the comments payloads, and
  `events/issue-<n>.log`, and prunes PRs merged or closed for thirty days.
  `.commented`, `.approved`, `.checks-*`, `.head-*`, and `main-health-*.red`
  are no longer written.
- Terms: "the user", never PO; "harness", never runtime; "main checkout";
  "repo rules".

## Machine

1. Pull; the skill and tool symlinks pick the change up. Restart the poller:
   `launchctl kickstart -k gui/$UID/com.agent-tools.gh-status`.
2. Remove the `review-gate.js` PreToolUse entry and the
   `session-role-marker.sh` UserPromptSubmit entry from `~/.claude/settings.json`,
   `~/.codex/hooks.json`, and every repo's `.claude/settings.local.json`.
   Keep watch-guard.
3. If you run main-health: add a `mainHealth` block to
   `$AGENT_TOOLS_HOME/config/<name>.json` (see `tools/config/example.json`
   and the script header) and change the on-merge step to
   `bash <agent-skills>/tools/main-health/main-health.sh <name>`. Env
   prefixes on the old command move into `mainHealth.env`.
4. Per clone: `git config --unset agent.pr-status-dir`. Set
   `git config agent.ready-check '<command>'` when the repo has a check that
   decides ready (a local gate result, a verdict for the head).
5. Optional cleanup: `.git/.review-gate`, `.git/.zcr-reviewed`,
   `.git/.verify-green` under each clone's git common dir; the poller's
   leftover marker kinds listed under What changed, which age out with their
   PRs.
6. If you set `KIMI_QUOTA_POLL_SECONDS`, rename it to `QUOTA_POLL_SECONDS`.

## Each repo's rules

Edit `.agent/orchestrate.md` against `templates/orchestrate.md`:

1. Delivery: add `Draft first: yes | no`.
2. Hook settings: drop `bot_identity`, `review_marker`, `verify_marker`,
   `draft_first`; keep `watch_guard` and any key your own scripts read.
3. Review: replace review form, marker command, and PR hook with
   `Reviewer verdict goes to`, `Proof of checks`, and `Ready check`.
4. Remove every mention of `## Enforcement policy`, a legacy
   `.claude/orchestrate.md`, park-guard, ZCR, review-mark, and verify-mark
   unless your repo keeps its own verdict files, in which case name them as
   where the verdict goes.
5. Reviewer agent definitions: "follow /review-gate and record the verdict
   where the rules say" replaces "write the SHA-bound marker".
6. Worker conventions: the draft opens before the review; `--head` on
   `gh pr create` is no longer required by anything.
7. Scripts that read a poller file the poller no longer writes switch to the
   timeline `events/pr-<n>.log`. Scripts that gate on a marker read the gate
   result or verdict file instead. watch-lane must accept `--generation` for
   named sessions.
8. Writing overlay: the canonical term for the person the agents serve is
   your repo's word; the skills say "the user".

## Verify

```sh
bun test tools/                      # board-snapshot and poller prune
bash tools/bgh/bgh-self-log.test.sh  # self-log and ready check
boot-report <pm|tl-<lane>>           # role marker written, main-health line
```
