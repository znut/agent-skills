# bgh — per-clone-identity gh wrapper

`bgh <anything gh takes>` runs `gh` as the identity the clone declares: a bot
token file, or the user's own login. Scripts and agents call `bgh` for every
GitHub write, so identity is the clone's choice, never the call site's.

## Install (once per machine)

```sh
ln -s ~/src/agent-skills/tools/bgh/bgh ~/.local/bin/bgh
ln -s ~/src/agent-skills/tools/bgh/bgh ~/.local/bin/gh   # ahead of the real gh on PATH
```

Installed as `gh`, every gh call in a clone uses that clone's identity, the
way a per-repo tool-version file picks a runtime, and nothing can post as a
person who never logged in. bgh finds the real binary as the first `gh` on
PATH that is not itself. A preset `GH_TOKEN`, or a directory outside any git
repo, runs the real gh unchanged.

## Configure (once per repo)

Token resolution is **per-repo** via machine-local git config — different
repos/orgs use different bot identities, and worktrees inherit automatically
because they share the main `.git/config`:

```sh
cd <repo>
git config agent.bot-token-file '~/.config/<bot>.token'
```

No config → clear error (never silently falls back to the user's own login).
One-call override: `BGH_TOKEN_FILE=<path> bgh …`.

## Ready check

`bgh pr ready <n>` first runs the check the clone declares:

```sh
git config agent.ready-check 'bash scripts/final-check.sh'
```

bgh runs `<command> <n>` from the repo root and refuses to mark the PR ready
when it exits non-zero, leaving the check's output on the terminal. `--undo`
is never gated. The clone decides what ready needs, such as a green local
gate result for the head and a review verdict naming it; bgh only holds the
door. No shell parsing is involved, and a refusal is an ordinary command
failure the agent reads and acts on.

## Self-event log

`bgh` logs the ids of the comments and reviews it creates so the session's
watcher can skip its own echoes. Set `BGH_SELF_LOG=<file>` explicitly, or let
`bgh` derive it: for posting-shaped calls it reads the role from the session's
marker, `/tmp/<cc|pi|codex>-session-roles/<session id>`, which `boot-report`
writes at every PM and TL boot.

A named session's watcher reads its own per-generation self-events dir, not
the shared role dir, so `bgh` asks `agent-session current` (`AGENT_SESSION_TOOL`
env, else `agent-session` on PATH, else the sibling `tools/agent-session`)
whether this session has a live registration whose role/lane matches the
marker; a match logs to `<paths.self_events>/<role>.ids` instead. The lookup
runs with stdin from `/dev/null` and a bounded wait (a few seconds); a
timeout, non-zero exit, malformed JSON, non-absolute path, or a mismatched
role/lane falls back to `<agent.self-events-dir>/<role>.ids` as before.

Posting-shaped calls are `pr comment`, `issue comment`, `pr review`, and `api`
calls to comments/reviews endpoints using `POST` or `PATCH`. Path-unsafe
session ids (`/`, `..`) are skipped. Explicit `BGH_SELF_LOG` always wins;
absent config or marker falls back to plain `gh`.
