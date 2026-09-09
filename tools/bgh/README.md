# bgh — per-clone-identity gh wrapper

`bgh <anything gh takes>` runs `gh` as the identity the clone declares: a bot
token file, or the user's own login. Scripts and agents call `bgh` for every
GitHub write, so identity is the clone's choice, never the call site's.

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

No config → clear error (never silently falls back to the user's own login).
One-call override: `BGH_TOKEN_FILE=<path> bgh …`.

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
