# pi subagent extension

A generic, repo-agnostic pi extension that lets a session spawn isolated pi
sub-processes, capture their output, and signal the parent when they finish or
need help. It has two modes:

- **Managed** (`spawn_agent({ task, size })`): the engine draws the worker model,
  creates a git worktree, runs worker → fresh review → fix loop → PR or ready
  branch, and logs one run row. See [Managed workflow](#managed-workflow).
- **Plain** (no `size`): spawn one process with an explicit `model`, `role`,
  `prompt_template`, `cwd`.

## Install

```bash
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf /path/to/agent-skills/pi/extensions/subagent/index.ts ~/.pi/agent/extensions/subagent/index.ts
```

Restart pi. The extension auto-discovers in every trusted project.

`index.ts` imports `engine.ts` and `git.ts` next to it; a symlink to `index.ts`
resolves them from the real path. Managed mode also needs `git` (and `gh` for PRs)
on `PATH`, and a config file:

```bash
cp /path/to/agent-skills/pi/extensions/subagent/example.json ~/.pi/agent/subagents.json
```

## Config

Global `~/.pi/agent/subagents.json` (the extension only reads it), optionally
shallow-merged with `<repo>/.pi/subagents.json` (each top-level key in the repo
file replaces the global one). Missing keys use the defaults shown.
`example.json` is a complete file.

| key                 | meaning                                                                                       | default                                  |
| ------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `classes`           | named lists of `provider/model:effort` candidates                                              | none (required for managed mode)         |
| `size_class`        | which class each size draws from                                                               | S,M → `standard`; L,XL → `strong`        |
| `draw`              | `"uniform"` or `"learned"` (see below)                                                         | `"learned"`                              |
| `reviewer`          | worker provider → reviewer model on the *other* provider; absent → first model on another provider in the config | `{}`              |
| `skills`            | `{worker: [], reviewer: []}`: paths, or names under `~/.pi/agent/skill-library/` and `~/.claude/skills/` | none                   |
| `max_review_rounds` | stop after this many BLOCK verdicts and ping `needs_help`                                      | `2`                                      |
| `worktrees_dir`     | where worktrees go; `<repo-parent>` / `<repo-name>` / leading `~` expand                       | `<repo-parent>/<repo-name>-worktrees`    |

Every subagent starts `pi --no-skills` plus one `--skill <path>` per entry of its
role's list, and runs with `PI_CACHE_RETENTION=short`. Effort is the `:suffix`
(`off|minimal|low|medium|high|xhigh|max`).

Env overrides (tests, experiments): `PI_SUBAGENT_CONFIG` (global config path),
`PI_SUBAGENT_RUNS` (run log path), `PI_SUBAGENT_SEED` (seed the draw).

## Managed workflow

```json
{ "task": "fix: handle empty request body in /api/orders", "size": "M" }
```

`spawn_agent` with `size` (`S|M|L|XL`) and no model:

1. **Draw** a worker model from `classes[size_class[size]]` (an explicit `model`
   skips the draw). The one-line `why` is in the spawn result and the run row.
2. **Worktree**: `git worktree add --no-track -b <type>/<slug> <worktrees_dir>/<slug> <default tip>`.
   Type comes from a conventional prefix or leading verb (`fix`, `docs`, …, else
   `feat`); the slug is the task's first line, kebab-cased, de-duplicated with
   `-2`, `-3`. Default branch is `origin/HEAD`, else `main`, else the current
   branch (a best-effort `git fetch` of it runs first).
3. **Worker** (`pi --session-dir … --session-id …`, in the worktree) builds the
   task, runs the repo's own checks (it reads AGENTS.md/README) and commits. It
   ends with `NEEDS_HELP: <question>` if a product/design choice is missing; the
   engine then stops and pings you.
4. **Fresh reviewer** on the other provider (`reviewer` map), no worker history.
   Its prompt is the task, `git diff <base>..<tip>`, the repo's AGENTS.md and any
   review/checklist doc it links to locally. It must answer `VERDICT: PASS` or
   `VERDICT: BLOCK` plus numbered findings. It runs in the worktree with
   `--tools read,bash,grep,find,ls` (agent tools excluded); the "bash only for
   git/grep" part is an instruction, not a sandbox.
5. **BLOCK**: the findings go back to the *same* worker (same pi session), then a
   new fresh review. After `max_review_rounds` BLOCKs the engine stops and the
   task ends `needs_help` with the latest findings. A reviewer that returns no
   verdict ends the task `error`.
6. **PASS**: if `origin` is on GitHub and `gh repo view` works there, the worker
   pushes and opens a PR; the PR URL is in the final message. Otherwise the
   branch is left ready in its worktree. The manager gets a follow-up ping
   (`done` with link/branch, or `needs_help`/`error` with the reason).

Managed tasks default to `async: true`; `await_agent`, `send_agent_message`
(`steer`/`context` go to the running worker, or are queued for its next turn;
`stop` cancels the task), `agent_status`, `list_agents` and `stop_agent` all take
the task id. Each phase shows as a child row in the widget.

### Draw

`uniform` picks at random. `learned` is Thompson sampling, computed from the run
log at draw time (nothing is stored):

- success = the *first* review was PASS; anything else is a miss.
- `score = Beta(1+passes, 1+misses) sample / (avg_cost^0.5 * avg_wall_s^0.5)`.
  A candidate with no priced runs uses the cheapest known mean (or 1); same for wall time.
- Per candidate, data comes from the same repo + same size; with < 5 runs, the
  same repo at any size; with < 5, all repos. Only the last 30 days count.
- With probability 0.2 it explores: a uniform pick among candidates with < 10
  runs in their scope (never-run candidates first).

### Run log

`~/.pi/agent/subagents/runs.jsonl` (`PI_SUBAGENT_RUNS` overrides), one JSON row
per finished managed task:

```json
{"ts":"…","repo":"/src/app","branch":"fix/handle-empty-body","task":"fix: handle empty…","ticket":123,"size":"M",
 "provider":"anthropic","model":"claude-sonnet-5-5","effort":"high","review_rounds":2,
 "first_review":"block","outcome":"pass","tokens_in":0,"tokens_out":0,"tokens_cache":0,
 "cost_usd":0.0,"wall_s":0.0,"why":"learned size=M scope=repo n=7 a=4 b=4 cost=… wall=…s score=… path=score"}
```

`ticket` is the first `#<digits>` in the task text as a number, else `null`. `outcome` is `pass | block | stopped | error`; `first_review` is `pass | block |
null`; tokens and cost sum the worker and reviewer runs (`tokens_cache` = cache
read + write).

## Tests

```bash
cd pi/extensions/subagent && bun test
```

Pure logic (config, draw, run rows, verdicts, naming) lives in `engine.ts`, so
tests need no pi.

## Plain mode: prompt templates

In plain mode (no `size`) the extension looks for prompt templates named `worker` and
`reviewer` in the project's `.pi/prompts/` directory. (Managed mode builds its
own prompts.) You can override:

- per spawn: pass `prompt_template` to `spawn_agent`
- per project: set env vars `PI_EXT_SUBAGENT_WORKER_PROMPT` and
  `PI_EXT_SUBAGENT_REVIEWER_PROMPT`

In plain mode `model` is **not defaulted** by the extension. If you don't pass
`model`, the subagent inherits the current pi session's default model. Pass it
explicitly when the subagent needs a different model from the session default.

## Multiple subagents

Each `spawn_agent` call creates an isolated process with its own state directory
keyed by a fresh UUID. Every agent also records the root parent session that
spawned its tree. The widget and agent-management tools show only that session's
tree, so simultaneous Pi sessions in the same checkout do not see or control
one another's agents. Nested reviewers inherit the root owner and remain visible
to the session that spawned their worker.

## Tools

### spawn_agent

Spawn a fresh pi process. With `async: false` the tool blocks until the
subagent exits; with `async: true` it returns a handle and the parent is notified
later. With `size` it runs the managed workflow above (`role` must be `worker`;
`async` defaults to true).

```json
{
  "role": "worker",
  "task": "self-contained task contract",
  "async": true,
  "model": "<model-alias>",
  "prompt_template": "my-worker"
}
```

### await_agent

Block on the subagent's status file using filesystem events (no polling). The
text shows the status message and the agent's output (first ~500 chars); stderr
appears only when there is no output.

```json
{ "agent_id": "...", "timeout_ms": 600000 }
```

### agent_ping

Called by a subagent to report `done`, `needs_help`, or `error` without exiting.

```json
{ "agent_id": "...", "status": "done", "message": "..." }
```

### send_agent_message

Parent → subagent steering. The parent writes a message into the subagent's
state directory (atomically). The subagent's own extension instance picks it up
(`fs.watch` plus a 1 s poll, because `fs.watch` does not fire in `pi -p` children;
the file is claimed by rename so it is consumed once) and **injects the message as a user message**, so the agent cannot ignore it.

Types:

- `steer` — override direction mid-task.
- `stop` — cancel the task; the subagent sees a user message telling it to
  abort and exit.
- `context` — add missing context without changing direction.

Parent:

```json
{ "agent_id": "...", "type": "steer", "content": "Use approach B" }
```

The subagent does not need to call any special tool to receive the message.
`steer` and `stop` are delivered with `deliverAs: "steer"`: right after the
current tool call finishes, before the next model request (so a steer during a
long `sleep`/test run lands before the agent writes its reply). `context` is a
`followUp`, delivered once the agent has finished its tools.

### agent_status / list_agents / stop_agent

Read status, list agents, or kill a running agent.

## Subagent state

Subagent state is stored under the pi machine state directory, outside any repo:

```
~/.pi/agent/subagents/<project-hash>/<agent-id>/
  task.md
  live.json
  status.json
  result.json
  message.json
```

This keeps spawned processes and their artifacts out of project working trees
and avoids conflicts between concurrent checkouts. State without an owner id is not shown: it cannot be attributed to a session.

## Limitations

- Async subagents are children of the parent pi process. In `pi -p` print mode
the parent exits after the turn, so collect async agents with
`await_agent` in the same turn. In TUI/monitor sessions the parent stays alive
and follow-up pings work.
- Nested subagents work, but each level must load this extension.
- Captured output is read from JSON-mode assistant messages and subject to the
usual pi output limits.
