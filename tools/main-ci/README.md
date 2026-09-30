# main-ci

A post-merge CI driver. It follows one repo's default-branch tip and runs the
config's checks on it. This README is the design doc.

## Tip tracking

One launchd job (`com.agent-tools.main-ci`, `StartInterval` 45 s) runs one
tick: `bun tools/main-ci/main-ci.mjs <configName>`. A tick:

1. Runs board-snapshot when the config has a `board` block and the newest
   mtime under `var/<name>/gh-status/events/` changed since the last tick.
2. Runs `git fetch origin` in `mainCi.repo` and resolves
   `origin/<branch>`.
3. Returns when that sha equals `run.json`'s `sha`: the tip did not move.
   An idle tick logs nothing.
4. When the tip moved, it cancels the current run, moves the `origin-main`
   worktree to the new tip (`checkout --detach -f`, `reset --hard`,
   `clean -fd -e node_modules`), runs `mainCi.cleanup`, and starts a
   detached runner, `run.mjs`, on the new sha. Then it exits.

The driver alone moves the `origin-main` worktree. Its path defaults to
`<repo>-worktrees/origin-main`, and it is added `--lock` because repo
cleanup scripts remove unlocked worktrees. A tick lock (`.tick.lock`, a live
pid) keeps a manual tick from overlapping the launchd one.

Tip moves are the only trigger. A comment, a review, or a ready flip starts
nothing; a `WatchPaths` job on `events/` (on-merge) is rejected because every
such event fires it.

## Cancel and restart

Every job a run starts is its own process group. The runner's group comes
first in `run.json` (`runnerPid`), and each running step's group follows in
`jobs`. On a tip move the tick sends `SIGTERM` to every listed group. After
10 s it sends `SIGKILL` to any group still alive. Then it moves the worktree,
because a step still running would write into the new checkout. A group kill
reaches every grandchild, such as a test pool or a dev server. A run
cancelled after its first `state.json` write is left marked
`"phase": "cancelled"`.

The plist sets `AbandonProcessGroup`, so launchd leaves the detached run
alone when the tick exits.

`--rerun` starts a fresh run on the current tip. Use it after a reboot or a
killed runner, because a tip that did not move starts nothing.

## Run order

1. **Core**: `mainCi.core` steps, in order in the worktree. Every step runs,
   so one red run reports every broken step. Core green means every core
   step passed.
2. **Warm cache**: on green core, `state.json` is written with
   `"phase": "builds"` and `"green": true`, then `mainCi.warmCache` runs.
   The warm-cache command reads that `state.json` to confirm green at the
   worktree's HEAD. It runs before the builds, which rewrite build output
   while it copies.
3. **Builds**: `mainCi.builds` is a list of lanes. Each lane is a list of
   steps that run in order, such as a build and then the screenshots that
   need it. At most `buildConcurrency` lanes run at once (default 1). A
   failed step marks the rest of its lane `skipped`. `state.json` is
   rewritten after each step and ends with `"phase": "done"`.

A red core skips the warm cache and the builds. A warm-cache failure is
logged and leaves `green` as it was, because the cache only speeds up later
installs and builds.

Each step runs as `nice -n 19 bash -c <cmd>`. `nice` yields to interactive
work; `ProcessType=Background` (DARWIN_BG) would starve test pools under
load. A step is killed after `stepTimeout` seconds. A failed step is retried
once, and its first attempt's log is kept as `step-<name>.attempt1.log`.
Only the final attempt's failing tests go into `failing`.

When every path changed since the last green, finished run matches
`skipPattern`, the tick writes a green `state.json` with a `skipped` step and
starts no run.

## What each run writes

Under `$AGENT_TOOLS_HOME/var/<name>/main-ci/`:

- `state.json`: `{ sha, finishedAt, green, failing, phase, steps }`. This
  is main-health's shape plus `phase` (`builds`, `done`, or `cancelled`).
  boot-report and the repo's warm-cache command read it. A new run leaves the
  previous verdict in place until its core finishes.
- `run.json`: the current run's `sha`, `runDir`, `runnerPid`, `jobs`,
  `startedAt`, and `finishedAt`.
- `run.log`: the driver's decisions and step outcomes, one timestamped line
  each. It records tip moves, cancels, run start, and each step's `ok` or
  `FAIL exit=<code>` with the first stderr line or the last log line. It also
  records `FAIL <file> › <test>` lines parsed from vitest output, the
  cleanup, warm-cache, and board-snapshot outcomes, and `tick FAILED` when
  `git fetch` or the checkout fails.
- `runs/<UTC ts>-<sha8>/`: `step-<name>.log` per step and `runner.log`, the
  runner's own output. The last 20 run dirs are kept.

A step that cannot run is a failure. A missing binary makes `bash` exit 127,
and a failed spawn is recorded as exit 127, so the step's status is `FAIL`
with a logged reason. A failed fetch (auth, network) logs `tick FAILED` and
exits 1.

## What the repo config supplies

The `mainCi` block of `$AGENT_TOOLS_HOME/config/<name>.json` decides what
green means. The driver owns everything else.

| Field | Required | Meaning |
|---|---|---|
| `repo` | yes | Main checkout. The tick fetches there and adds the worktree from it; that checkout's HEAD never moves |
| `core` | yes | `[{name, cmd}]`, run in order |
| `builds` | no | `[[{name, cmd}, ...], ...]`: lanes that run in parallel, steps in order within a lane |
| `buildConcurrency` | no | Lanes at once (default 1) |
| `warmCache` | no | Command run once core is green |
| `cleanup` | no | Command run on every tip move, after the worktree moves |
| `worktree` | no | `origin-main` worktree path (default `<repo>-worktrees/origin-main`) |
| `branch` | no | Branch to follow (default: `origin/HEAD`, else `main`) |
| `env` | no | Map exported to every command |
| `skipPattern` | no | ERE of paths that cannot affect the checks (default `^docs/\|\.md$`) |
| `stepTimeout` | no | Seconds per step and per command (default 1800) |

Every command runs in the worktree with `MAIN_CI_VAR` (the var dir above),
`MAIN_CI_WORKTREE`, and, in the runner, `MAIN_CI_SHA` exported, so a config
does not hard-code those paths.

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
bun tools/main-ci/main-ci.mjs <name>           # one tick
bun tools/main-ci/main-ci.mjs <name> --rerun   # fresh run on the current tip
tail -f "$AGENT_TOOLS_HOME/var/<name>/main-ci/run.log"
```

To try a config without touching the live one, point `AGENT_TOOLS_HOME` at a
scratch dir holding a copy of the config.
