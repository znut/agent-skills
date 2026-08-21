# pi subagent extension

A generic pi extension that lets a session spawn isolated pi sub-processes as
`worker` or `reviewer` agents, capture their output, and signal the parent when
they finish or need help.

## Install

```bash
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf /path/to/agent-skills/pi/extensions/subagent/index.ts ~/.pi/agent/extensions/subagent/index.ts
```

Restart pi. The extension auto-discovers in every trusted project.

## Required prompt templates

By default the extension looks for prompt templates named `worker` and
`reviewer` in the project's `.pi/prompts/` directory. You can override:

- per spawn: pass `prompt_template` to `spawn_agent`
- per project: set env vars `PI_EXT_SUBAGENT_WORKER_PROMPT` and
  `PI_EXT_SUBAGENT_REVIEWER_PROMPT`

`model` is **not defaulted** by the extension. If you don't pass `model`, the
subagent inherits the current pi session's default model. Pass it explicitly when
the subagent needs a different model from the session default.

## Multiple subagents

There is no global singleton. Each `spawn_agent` call creates an isolated
process with its own state directory keyed by a fresh UUID. A worker can spawn
reviewers, those reviewers can spawn their own helpers, and so on. The parent
keeps a map of only the agents it created; tools that resolve an agent by id
fall back to the on-disk state directory so cross-process references work.

## Tools

### spawn_agent

Spawn a fresh pi process. With `async: false` the tool blocks until the
subagent exits; with `async: true` it returns a handle and the parent is notified
later.

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

Block on the subagent's status file using filesystem events (no polling).

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
state directory. The subagent's own extension instance watches that file and
**injects the message as a user message**, so the agent cannot ignore it.

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
The extension queues it as a normal user message, delivered in the gap after
its current assistant turn / tool chain completes.

### agent_status / list_agents / stop_agent

Read status, list agents, or kill a running agent.

## Subagent state

Subagent state is stored under the pi machine state directory, outside any repo:

```
~/.pi/agent/subagents/<project-hash>/<agent-id>/
  task.md
  status.json
  result.json
  message.json
```

This keeps spawned processes and their artifacts out of project working trees
and avoids conflicts between concurrent checkouts.

## Limitations

- Async subagents are children of the parent pi process. In `pi -p` print mode
the parent exits after the turn, so async agents should be collected with
`await_agent` in the same turn. In TUI/monitor sessions the parent stays alive
and follow-up pings work.
- Nested subagents work, but each level must load this extension.
- Captured output is read from JSON-mode assistant messages and subject to the
usual pi output limits.
