# tools/

Local, config-driven background services for agents working across GitHub
repos. They poll GitHub once, centrally, and materialize the result as local
files — many parallel agents each polling would exhaust the API quota. Agents
read a file: no API call, no quota, however many agents watch.

## Layout

```
tools/
  install.sh                 renders + installs the launchd services
  config/example.json        example config (copy the pattern; real configs
                              live OUTSIDE this repo, under $AGENT_TOOLS_HOME/config/)
  lib/                        shared config-loading + atomic-write helpers
  gh-status/poller.ts         multi-repo PR status poller (bun)
  board-snapshot/             board -> $AGENT_TOOLS_HOME/var/<name>/board-snapshot.md
  bgh/                        per-clone-identity gh wrapper; install as gh too
                              (bgh/README.md)
  boot-report.sh              session-boot state collector for TL/PM roles; also
                              writes the session's role marker under /tmp
                              (install on PATH like bgh:
                              ln -s ~/src/agent-skills/tools/boot-report.sh ~/.local/bin/boot-report;
                              skills call `boot-report <role>`)
  worktree-hook/              WorktreeCreate hook: agent worktrees outside the repo
  hooks/                      Claude Code hooks: watch-guard, asks-hook
  launchd/*.plist.template    launchd service templates, rendered by install.sh
```

## Config contract (`$AGENT_TOOLS_HOME/config/<name>.json`)

Config files are **not** part of this repo — they live under
`$AGENT_TOOLS_HOME` (default `~/.config/agent-tools`), one JSON file per
target repo, so cloning or forking this repo never carries anyone's real
project names, org names, or token file paths. `tools/config/example.json`
shows the shape (fill-me-in placeholders); copy it to
`$AGENT_TOOLS_HOME/config/<name>.json` and fill in your own values.

| Field | Used by | Required | Meaning |
|---|---|---|---|
| `name` | all | yes | Identifies this config; also the directory name under `$AGENT_TOOLS_HOME/var/<name>/` |
| `org` | gh-status, board-snapshot | yes | GitHub org/owner of the repo to poll (e.g. `YOUR_ORG`) |
| `repo` | gh-status, board-snapshot | yes | Repo name, without org (e.g. `YOUR_REPO`) |
| `tokenItem` | gh-status, board-snapshot | one of `tokenItem` / `tokenFile` | macOS login-keychain service holding the GitHub token, read with `security find-generic-password -s <item> -w` once per poll cycle/run; wins over `tokenFile` (same precedence as bgh). Store it: `security add-generic-password -U -s <item> -a "$USER" -w` |
| `tokenFile` | gh-status, board-snapshot | one of `tokenItem` / `tokenFile` | Path to a file containing a GitHub token, `~` expanded, read fresh on every poll/run (token rotation picked up automatically) |
| `board.owner` | board-snapshot, gh-status board probe | yes, if using board-snapshot | GitHub org that owns the ProjectV2 board |
| `board.projectNumber` | board-snapshot, gh-status board probe | yes, if using board-snapshot | ProjectV2 number (the `N` in `github.com/orgs/<org>/projects/N`) |

`gh-status` reads **every** `$AGENT_TOOLS_HOME/config/*.json` each poll cycle
and polls all of them in one process (one 40s loop, one GraphQL request per
configured repo per cycle plus one repo-wide `issues/comments?since=` REST
call feeding `events/issue-<n>.log|.comments.json` — same shapes as the PR
comment events; configs with a `board` block add a 1-point
`projectV2.updatedAt` probe per cycle and re-derive `board-snapshot.md` only
when that stamp moves — agents read the board file with zero API calls). `board-snapshot` is invoked
per-config by name (`bun tools/board-snapshot/board-snapshot.mjs <name>`).

## What each tool writes

`gh-status/poller.ts` — per config `<name>`, under
`$AGENT_TOOLS_HOME/var/<name>/gh-status/`:

- `status/pr-<n>.json` (current snapshot per PR), `status/state.json`
- `events/pr-<n>.log` — the PR's timeline, append-only JSONL: merged, closed,
  checks-success, checks-failure, approved, changes-requested, commented,
  ready-stale. One watcher per PR sees every event.
- `events/pr-<n>.merged` — marker, for watchers that key on a path
- `events/pr-<n>.comments.json`, `events/issue-<n>.log`,
  `events/issue-<n>.comments.json` — the latest comment batch and the issue
  timeline

Files of PRs that left the tracked window and have been merged or closed for
thirty days are removed, as are issue files idle that long.

`board-snapshot/board-snapshot.mjs` — `$AGENT_TOOLS_HOME/var/<name>/board-snapshot.md`
(atomic write) plus `$AGENT_TOOLS_HOME/var/<name>/.board-snapshot-last-run`
(60s debounce state). Filters out board items whose Status is Done and closed
more than 7 days ago; keeps everything else. This version only ever writes a
local file — it never clones/commits/pushes.

## Install

1. `bun install` isn't needed — everything here is dependency-free (bun/node
   builtins only). You do need `bun` and the GitHub CLI (`gh`) on `PATH`.
2. Add a config file per target repo under `$AGENT_TOOLS_HOME/config/`
   (default `~/.config/agent-tools/config/`) — see Config contract.
3. Run `tools/install.sh <name>` (`--dry-run` first to see the rendered
   launchd PATH). It resolves your `bun` and the real `gh` (the first `gh`
   on PATH that is not a bgh symlink), renders every
   `tools/launchd/*.plist.template` file with those paths substituted in,
   lints them with `plutil -lint`, and writes the result to
   `~/Library/LaunchAgents/` (override with `$LAUNCH_AGENTS_DIR`, mainly
   useful for testing). It does **not** run `launchctl bootstrap`
   itself — it prints the exact commands so you can review the rendered
   plists first.
4. Run the printed `launchctl bootstrap gui/$UID ...` commands.

`gh-status` polls every config regardless of the `<name>` given here.

### Uninstall

```bash
launchctl bootout gui/$UID/com.agent-tools.gh-status
rm ~/Library/LaunchAgents/com.agent-tools.gh-status.plist
```

### Manual runs

Both tools also run as one-shot CLIs, independent of launchd — useful for
testing a config before installing the services:

```bash
bun tools/board-snapshot/board-snapshot.mjs <name>
timeout 15 bun tools/gh-status/poller.ts || true   # poller loops forever by default
```

## Verify

```bash
bun test tools/
```

Smoke a single board render (writes only under `$AGENT_TOOLS_HOME/var/`):

```bash
bun tools/board-snapshot/board-snapshot.mjs <name>
cat "$AGENT_TOOLS_HOME/var/<name>/board-snapshot.md"
```

Smoke one poll cycle (writes only under `$AGENT_TOOLS_HOME/var/`; the poller
loops forever by default, so run it in the background and kill it, or add a
one-shot wrapper if you need this often):

```bash
timeout 15 bun tools/gh-status/poller.ts || true
cat "$AGENT_TOOLS_HOME/var/<name>/gh-status/status/state.json"
```

Both smoke tests need a real config at `$AGENT_TOOLS_HOME/config/<name>.json`
with a valid `tokenItem` or `tokenFile` — they make live GitHub calls.
