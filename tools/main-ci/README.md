# main-ci

A post-merge CI driver. It follows one repo's default-branch tip and runs the
config's checks on it. This README is the design doc.

## One process

The driver is one long-lived process: `bun tools/main-ci/main-ci.mjs
<configName>`, run by the launchd job `com.agent-tools.main-ci` with
`KeepAlive`. Every 45 s it polls:

1. It runs board-snapshot when the config has a `board` block and the
   newest mtime under `var/<name>/gh-status/events/` changed since the last
   poll.
2. It runs `git fetch origin` in `mainCi.repo` and resolves
   `origin/<branch>`. Each git call is its own process group, and the whole
   group is killed after 120 s, so a stalled fetch and its helpers (ssh,
   git-remote-https) fail that poll and the next poll retries.
3. When the tip equals the current run's sha, it does nothing more.
4. When the tip moved, it cancels the current run, moves the `origin-main`
   worktree to the new tip (`checkout --detach -f`,
   `clean -fd -e node_modules`), and starts a run on the new sha.

The driver holds the current run and its process groups in memory. It
writes no lock file and stores no pid, so a crash leaves nothing to recover
from. launchd restarts the process, and a started driver always begins a
fresh run on the current tip. A tick job with a detached runner, a lock
file, and pids in a state file is rejected: every handoff between the tick
and the runner was a race, and stored pids can name unrelated processes
after a restart.

The driver alone moves the `origin-main` worktree. Its path defaults to
`<repo>-worktrees/origin-main`, and it is added `--lock` because repo
cleanup scripts remove unlocked worktrees.

Tip moves are the only trigger. A comment, a review, or a ready flip starts
nothing; a `WatchPaths` job on `events/` (on-merge) is rejected because every
such event fires it. A failed poll logs `poll FAILED: <cause>` once per
distinct cause and `poll ok again` when it recovers.

## Cancel and restart

Every command a run starts is its own process group (`detached`), added to
the run's in-memory set in the same synchronous turn as the spawn. A cancel
first marks the run cancelled, so it starts no further command and writes no
further state. It then sends `SIGTERM` to every group in the set and
`SIGKILL` to any group alive after 10 s, and waits for the run to unwind.
Only then does the worktree move, because a live command would write into
the new checkout. A group kill reaches every grandchild, such as a test pool
or a dev server. When a command exits on its own, its group is killed too,
so nothing it left behind holds a port. A run cancelled after its first
`state.json` write is marked `"phase": "cancelled"`.

When the driver exits (SIGTERM from `launchctl bootout`, SIGINT, SIGHUP, or
an uncaught error), its exit handler sends `SIGKILL` to the current run's
groups and to any git call in flight. A `SIGKILL` of the driver itself runs
no handler, and those groups keep running. After one, stop `KeepAlive` from
restarting the driver mid-cleanup, then kill every process whose working
directory is inside the worktree:

```bash
launchctl bootout gui/$UID/com.agent-tools.main-ci
kill $(lsof -a -d cwd -t +D <worktree path>); sleep 10
pids=$(lsof -a -d cwd -t +D <worktree path>); [ -z "$pids" ] || kill -9 $pids
lsof -a -d cwd -t +D <worktree path> || launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.agent-tools.main-ci.plist
```

## Run order

1. **Cleanup and skip check**: `mainCi.cleanup` runs, logged but outside
   the verdict. When every path changed since the last green, finished run
   matches `skipPattern`, the run writes a green `state.json` with a
   `skipped` step and stops.
2. **Core**: `mainCi.core` steps, in order in the worktree. A failed core
   step does not stop the next one, so one red run reports every broken
   step. Core green means every core step passed.
3. **Warm cache**: on green core, `state.json` is written with
   `"phase": "builds"` and `"green": true`, then `mainCi.warmCache` runs.
   The warm-cache command reads that `state.json` to confirm green at the
   worktree's HEAD. It runs before the builds, which rewrite build output
   while it copies.
4. **Builds**: `mainCi.builds` is a list of lanes. Each lane is a list of
   steps that run in order, such as a build and then the screenshots that
   need it. At most `buildConcurrency` lanes run at once (default 1). Unlike
   core, a failed step marks the rest of its lane `skipped`: a later step in
   a lane needs the earlier one's output. The run ends only after every lane
   has settled, a lane that threw included.

A red core skips the warm cache and the builds. A cleanup or warm-cache
failure is logged and leaves `green` as it was: neither says anything about
the tip. A run that throws writes `green: false`, a `runner: FAIL` step, and
`"phase": "done"`.

Each step runs as `nice -n 19 bash -c <cmd>`. `nice` yields to interactive
work; `ProcessType=Background` (DARWIN_BG) would starve test pools under
load. A step is killed after `stepTimeout` seconds. A failed step is retried
once, and its first attempt's log is kept as `step-<name>.attempt1.log`.
Only the final attempt's failing tests go into `failing`.

## What each run writes

Under `$AGENT_TOOLS_HOME/var/<name>/main-ci/`:

- `state.json`: `{ sha, finishedAt, green, failing, phase, steps }`. This
  is main-health's shape plus `phase` (`builds`, `done`, or `cancelled`).
  boot-report and the repo's warm-cache command read it. A new run leaves the
  previous verdict in place until its core finishes.
- `run.log`: the driver's decisions and step outcomes, one timestamped line
  each. It records driver start, tip moves, cancels, run start, and each
  step's `ok` or `FAIL exit=<code>` with the step log's last line. It also
  records `FAIL <file> › <test>` lines parsed from vitest output, the
  cleanup, warm-cache, and board-snapshot outcomes, and `poll FAILED` when
  git fails or times out.
- `runs/<UTC ts>-<sha8>/`: `step-<name>.log` per step, `cleanup.log`, and
  `warm-cache.log`. The last 20 run dirs are kept.

A step that cannot run is a failure. A missing binary makes `bash` exit 127,
and a failed spawn is recorded as exit 127, so the step's status is `FAIL`
with a logged reason. The driver's own stderr goes to
`var/main-ci-launchd.log`.

## What the repo config supplies

The `mainCi` block of `$AGENT_TOOLS_HOME/config/<name>.json` decides what
green means. The driver owns everything else.

| Field | Required | Meaning |
|---|---|---|
| `repo` | yes | Main checkout. The driver fetches there and adds the worktree from it; that checkout's HEAD never moves |
| `core` | yes | `[{name, cmd}]`, run in order |
| `builds` | no | `[[{name, cmd}, ...], ...]`: lanes that run in parallel, steps in order within a lane |
| `buildConcurrency` | no | Lanes at once (default 1) |
| `warmCache` | no | Command run once core is green |
| `cleanup` | no | Command run first in every run, so on every tip move |
| `worktree` | no | `origin-main` worktree path (default `<repo>-worktrees/origin-main`) |
| `branch` | no | Branch to follow (default: `origin/HEAD`, else `main`) |
| `env` | no | Map exported to every command |
| `skipPattern` | no | ERE of paths that cannot affect the checks; a tip whose changes all match it is stamped green without running the checks (default `^docs/\|\.md$`) |
| `stepTimeout` | no | Seconds per step, cleanup, and warm cache (default 1800) |

Every command runs in the worktree with `MAIN_CI_VAR` (the var dir above),
`MAIN_CI_WORKTREE`, and `MAIN_CI_SHA` exported, so a config does not
hard-code those paths.

```jsonc
"mainCi": {
  "repo": "~/src/your-repo",
  "core": [
    { "name": "install", "cmd": "bun install --frozen-lockfile" },
    { "name": "test", "cmd": "bun run test" }
  ],
  "warmCache": "bash scripts/warm-cache.sh \"$MAIN_CI_VAR\" \"$MAIN_CI_WORKTREE\"",
  "builds": [
    [{ "name": "build-web", "cmd": "bun run --cwd apps/web build" },
     { "name": "screenshots-web", "cmd": "bun run --cwd apps/web screenshots" }]
  ],
  "buildConcurrency": 2,
  "cleanup": "bash scripts/cleanup-worktrees.sh --apply"
}
```

## Install

`tools/install.sh <name>` renders `com.agent-tools.main-ci.plist` with the
other plists. Remove the main-health step from `onMerge` before you
bootstrap it, or both jobs run the suite on every merge. main-health keeps
working until then.

## Manual runs

```bash
bun tools/main-ci/main-ci.mjs <name>   # the driver in the foreground; Ctrl-C stops its run
launchctl kickstart -k gui/$UID/com.agent-tools.main-ci   # restart: a fresh run on the current tip
tail -f "$AGENT_TOOLS_HOME/var/<name>/main-ci/run.log"
```

To try a config without touching the live one, point `AGENT_TOOLS_HOME` at a
scratch dir holding a copy of the config.
