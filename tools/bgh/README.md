# bgh — bot-identity gh wrapper

`bgh <anything gh takes>` = `GH_TOKEN=$(cat <repo's token file>) gh <anything>`.

Kills the per-command inline-prefix boilerplate that the review-gate hook's
bot-identity guard demands, without weakening the guard: bare mutating `gh`
stays blocked; `bgh` is bot-authored by construction.

## Install (once per machine)

```sh
ln -s ~/src/agent-skills/tools/bgh/bgh ~/.local/bin/bgh
```

## Configure (once per repo)

Token resolution is **per-repo** via machine-local git config — different
repos/orgs use different bot identities, and worktrees inherit automatically
because they share the main `.git/config`:

```sh
cd <repo>
git config agent.bot-token-file '~/.config/<bot>.token'
```

No config → clear error (never silently falls back to the human login).
One-call override: `BGH_TOKEN_FILE=<path> bgh …`.

## Hook interplay

The review-gate hook's bot-identity guard anchors on literal `gh` at command
position, so `bgh` invocations pass untouched and bare mutating `gh` still
blocks. The guard's error message names `bgh` as the preferred fix.

## Self-event log

`bgh` can automatically log the ids of comments and reviews it creates so the
session's watcher can skip its own echoes. Set `BGH_SELF_LOG=<file>` explicitly,
or let `bgh` derive it from the session harness and role marker:

- **Claude Code**: when `BGH_SELF_LOG` is unset and `CLAUDE_CODE_SESSION_ID` is
  set, `bgh` reads the role from `/tmp/cc-session-roles/$CLAUDE_CODE_SESSION_ID`
  and writes to `<agent.self-events-dir>/<role>.ids` for posting-shaped calls.
- **pi**: when `BGH_SELF_LOG` is unset, `CLAUDE_CODE_SESSION_ID` is empty, and
  `PI_SESSION_ID` is set, `bgh` reads the role from
  `/tmp/pi-session-roles/$PI_SESSION_ID` and writes to the same path.

Posting-shaped calls are `pr comment`, `issue comment`, `pr review`, and `api`
calls to comments/reviews endpoints using `POST` or `PATCH`. Path-unsafe
session ids (`/`, `..`) are skipped. Explicit `BGH_SELF_LOG` always wins;
absent config or marker falls back to plain `gh`.

`tools/boot-report.sh <role>` writes the pi role marker when `PI_SESSION_ID` is
present.
