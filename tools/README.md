# tools/

Local, config-driven background services for agents working across GitHub
repos. The purpose: when several agents/workers are running in parallel on a
local machine, each polling GitHub for PR status, board state, or merge
events adds up fast — you exhaust the GitHub API quota and every check pays a
network round trip. These services poll GitHub **once**, centrally, and
materialize the result as local files. Agents then just read a file — faster
than an API call, and it costs zero additional GitHub requests no matter how
many agents are watching.

Seven tool families: a multi-repo PR status poller (`gh-status`), a
project-board-to-markdown renderer (`board-snapshot`), a generic post-merge
step runner (`on-merge`), a bot-identity `gh` wrapper (`bgh`), a post-merge
main-health runner (`main-health`), a WorktreeCreate hook that puts agent
worktrees outside the repo (`worktree-hook`), and a read-only session-boot
state collector (`boot-report`) for TL/PM roles.

## Layout

```
tools/
  install.sh                 renders + installs the launchd services
  config/example.json        example config (copy the pattern; real configs
                              live OUTSIDE this repo, under $AGENT_TOOLS_HOME/config/)
  lib/                        shared config-loading + atomic-write helpers
  gh-status/poller.ts         multi-repo PR status poller (bun)
  board-snapshot/             board -> $AGENT_TOOLS_HOME/var/<name>/board-snapshot.md
  on-merge/run.mjs            generic post-merge step runner
  bgh/                        bot-identity gh wrapper (per-repo token file)
  boot-report.sh              read-only session-boot state collector for TL/PM roles
  main-health/                post-merge full-suite runner on the main tip
                              (env: MAIN_HEALTH_STEP_TIMEOUT per-step watchdog,
                              MAIN_HEALTH_SKIP_PATTERN skip-eligible paths;
                              runs at background QoS)
  worktree-hook/              WorktreeCreate hook: agent worktrees outside the repo
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
| `tokenFile` | gh-status, board-snapshot | yes | Path to a file containing a GitHub token, `~` expanded, read fresh on every poll/run (token rotation picked up automatically) |
| `board.owner` | board-snapshot, gh-status board probe | yes, if using board-snapshot | GitHub org that owns the ProjectV2 board |
| `board.projectNumber` | board-snapshot, gh-status board probe | yes, if using board-snapshot | ProjectV2 number (the `N` in `github.com/orgs/<org>/projects/N`) |
| `onMerge` | on-merge runner | yes, if using on-merge | Ordered array of steps, see below |

`gh-status` reads **every** `$AGENT_TOOLS_HOME/config/*.json` each poll cycle
and covers all of them in one process (one 40s loop, one GraphQL request per
configured repo per cycle plus one repo-wide `issues/comments?since=` REST
call feeding `events/issue-<n>.log|.commented|.comments.json` — same shapes as
the PR comment events; configs with a `board` block add a 1-point
`projectV2.updatedAt` probe per cycle and re-derive `board-snapshot.md` only
when that stamp moves — agents read the board file with zero API calls). `board-snapshot` and `on-merge` are invoked
per-config by name (`bun tools/board-snapshot/board-snapshot.mjs <name>`).

### `onMerge` step types

```jsonc
{ "type": "board-snapshot" }
{ "type": "command", "cmd": "bash scripts/foo.sh", "cwd": "~/src/YOUR_REPO" }
```

No other step types exist. `command` runs via `execSync` in `cwd` (`~`
expanded); non-zero exit is logged, not thrown — one failing step doesn't
block the rest.

## What each tool writes

`gh-status/poller.ts` — per config `<name>`, under
`$AGENT_TOOLS_HOME/var/<name>/gh-status/`:

- `status/pr-<n>.json`, `status/state.json`
- `events/pr-<n>.merged` / `.closed` / `.checks-success` / `.checks-failure` /
  `.checks-info.json` / `.approved` / `.changes-requested`
- `events/pr-<n>.commented` (mtime-bump, consume-then-rewatch) +
  `events/pr-<n>.comments.json`

The one notable design choice: `comments.json` is written **before** the
`.commented` marker bumps, so a watcher woken by the marker's mtime can never
observe it before the payload file exists.

`board-snapshot/board-snapshot.mjs` — `$AGENT_TOOLS_HOME/var/<name>/board-snapshot.md`
(atomic write) plus `$AGENT_TOOLS_HOME/var/<name>/.board-snapshot-last-run`
(60s debounce state). Filters out board items whose Status is Done and closed
more than 7 days ago; keeps everything else. This version only ever writes a
local file — it never clones/commits/pushes.

`on-merge/run.mjs` — runs a config's `onMerge` steps in order, once per
invocation, debounced as a whole run (skips all steps if the last run for
that config started < 60s ago). Appends one line per step to
`$AGENT_TOOLS_HOME/var/<name>/on-merge.log`: `<ISO time> <step> exit=<code>`.

## Install

1. `bun install` isn't needed — everything here is dependency-free (bun/node
   builtins only). You do need `bun` and the GitHub CLI (`gh`) on `PATH`.
2. Add a config file per target repo under `$AGENT_TOOLS_HOME/config/`
   (default `~/.config/agent-tools/config/`) — see the contract above.
3. Run `tools/install.sh <name>`. It resolves your `bun` and `gh`
   locations, renders both `tools/launchd/*.plist.template` files with those
   paths substituted in, lints them with `plutil -lint`, and writes the
   result to `~/Library/LaunchAgents/` (override with `$LAUNCH_AGENTS_DIR`,
   mainly useful for testing). It does **not** run `launchctl bootstrap`
   itself — it prints the exact commands so you can review the rendered
   plists first.
4. Run the printed `launchctl bootstrap gui/$UID ...` commands.

`<name>` here is only used for the on-merge watcher's `WatchPaths` argument
(it watches one config's `gh-status/events/` dir and runs that config's
`onMerge` steps). If you're tracking multiple repos with `gh-status` but only
want on-merge behavior for one of them, that's exactly what this supports —
`gh-status` itself always covers every config.

### Uninstall

```bash
launchctl bootout gui/$UID/com.agent-tools.gh-status
launchctl bootout gui/$UID/com.agent-tools.on-merge
rm ~/Library/LaunchAgents/com.agent-tools.gh-status.plist ~/Library/LaunchAgents/com.agent-tools.on-merge.plist
```

### Manual runs

Both tools also run as one-shot CLIs, independent of launchd — useful for
testing a config before installing the services:

```bash
bun tools/board-snapshot/board-snapshot.mjs <name>
bun tools/on-merge/run.mjs <name>
timeout 15 bun tools/gh-status/poller.ts || true   # poller loops forever by default
```

### Migrating from an existing single-repo poller

If you're replacing an existing bespoke local poller/watcher pair with this
tool family:

1. Stop the old service:
   ```bash
   launchctl bootout gui/$UID/<old-label>
   ```
2. Back up the old service's directory if you want to keep its
   README/source for reference — the next step may reuse its path as a
   symlink target.
3. Install and bootstrap this repo's services (see Install above).
4. If anything still hardcodes the **old** var/output path (a script, a
   convention doc, another agent's tool config), point it at the new
   location with a compatibility symlink instead of updating every
   reference at once:
   ```bash
   ln -sfn "$AGENT_TOOLS_HOME/var/<name>/gh-status" <old-path>/gh-status
   ```
   Confirm the old path still resolves (`cat <old-path>/gh-status/status/state.json`),
   then update references at your own pace and drop the symlink later.

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
with a valid `tokenFile` — they make live GitHub calls.
