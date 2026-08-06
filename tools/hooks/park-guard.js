#!/usr/bin/env node
/*
 * park-guard — SubagentStop gate against the parked-worker death.
 *
 * A subagent that ends its turn while a Bash task it backgrounded — explicitly
 * (run_in_background:true) or by the harness moving a long foreground command
 * to the background at its time limit — is gone: a stopped subagent never
 * receives the task's completion notification, so the work finishes with
 * nobody alive to read, push, or report it. This gate refuses the stop and
 * tells the agent to poll the task to completion instead.
 *
 * Detection: parse the stopping subagent's own transcript (stdin
 * `transcript_path`) for background-task starts, task-notifications, and
 * TaskStop calls; outstanding = started − completed − stopped − exempt.
 * Monitor tasks are NOT counted: a Monitor is the harness's sanctioned
 * re-invoking waiter, while background-Bash notifications provably do not
 * resume a stopped subagent.
 *
 * Block = exit 0 + stdout {"decision":"block","reason":...} (the SubagentStop
 * contract). Fail-OPEN everywhere else: unreadable stdin/transcript, foreign
 * event, parse errors → plain exit 0. A broken gate must never wedge every
 * subagent globally.
 *
 * Standing watchers are exempt by shape (a watcher is DESIGNED to outlive the
 * turn): default `bash scripts/watch-lane.sh <args>` exact shape; extend with
 * `git config agent.park-guard-exempt <regex>` in the repo the agent runs in.
 * Loop cap: after MAX_BLOCKS consecutive blocks for the same agent the guard
 * stands down — a task that never ends must not wedge the harness.
 * Off-switch (human-committed): `- park_guard: off` under `## Hook settings`
 * in .agent/orchestrate.md (legacy: `## Enforcement policy` in
 * .claude/orchestrate.md). Debug: PARK_GUARD_DEBUG=1 appends each stdin
 * payload to /tmp/park-guard-debug.jsonl for wiring validation.
 */
const fs = require("fs")
const os = require("os")
const path = require("path")
const { execSync } = require("child_process")

const MAX_BLOCKS = 8
const DEFAULT_EXEMPT = /^(bash|sh)\s+\S*watch-lane\.sh(\s+[A-Za-z0-9_#-]+)*\s*$/

function allow() {
	process.exit(0)
}

let data
try {
	data = JSON.parse(fs.readFileSync(0, "utf8"))
} catch {
	allow()
}
if (!data || typeof data !== "object") allow()

if (process.env.PARK_GUARD_DEBUG) {
	try {
		fs.appendFileSync(path.join(os.tmpdir(), "park-guard-debug.jsonl"), `${JSON.stringify(data)}\n`)
	} catch {}
}

if (data.hook_event_name && data.hook_event_name !== "SubagentStop") allow()

const cwd = data.cwd || process.cwd()
const transcript = data.transcript_path || ""
// Attribution requires the SUBAGENT's own transcript. The documented contract
// delivers exactly that; anything else (or nothing) → cannot tell whose tasks
// these are → fail open rather than block on another session's state.
if (!transcript || !/\.jsonl$/.test(transcript)) allow()

// ── per-repo settings (same mechanism as review-gate.js) ───────────────────
function guardOff() {
	try {
		const top = execSync("git rev-parse --show-toplevel", {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim()
		const sources = [
			{
				file: path.join(top, ".agent", "orchestrate.md"),
				section: /^## Hook settings[ \t]*\r?$\n([\s\S]*?)(?=^#{1,2}(?:[ \t]|\r?$)|$(?![\s\S]))/m,
			},
			{
				file: path.join(top, ".claude", "orchestrate.md"),
				section: /^## Enforcement policy[ \t]*\r?$\n([\s\S]*?)(?=^#{1,2}(?:[ \t]|\r?$)|$(?![\s\S]))/m,
			},
		]
		for (const { file, section } of sources) {
			let text
			try {
				text = fs.readFileSync(file, "utf8")
			} catch {
				continue
			}
			const sec = section.exec(text)
			if (!sec) continue
			const match = /^[-*]\s*park_guard\s*:\s*(\S+)/m.exec(sec[1])
			return !!match && match[1] === "off"
		}
		return false
	} catch {
		return false
	}
}
if (guardOff()) allow()

function exemptPattern() {
	try {
		const raw = execSync("git config --get agent.park-guard-exempt", {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim()
		if (raw) return new RegExp(raw)
	} catch {}
	return null
}

// ── transcript scan ────────────────────────────────────────────────────────
let lines
try {
	lines = fs.readFileSync(transcript, "utf8").split("\n")
} catch {
	allow()
}

function flattenContent(content) {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content.map((c) => (c && typeof c === "object" && typeof c.text === "string" ? c.text : "")).join("\n")
}

const commands = new Map() // tool_use id → Bash command text
const started = new Map() // task id → { output, toolUse }
const ended = new Set() // task ids completed (notification) or TaskStop'd
const NOTIF = /<task-notification>(?:\\n|\s)*<task-id>([A-Za-z0-9_-]+)<\/task-id>/g
const EXPLICIT_BG = /Command running in background with ID: ([A-Za-z0-9_-]+)\./g
const AUTO_BG = /moved to the background \(ID: ([A-Za-z0-9_-]+)\)/g
const OUTPUT_PATH = /Output is being written to: (\S+?)\.?(?:\s|$)/

for (const line of lines) {
	if (line.includes("task-notification")) {
		for (const m of line.matchAll(NOTIF)) ended.add(m[1])
	}
	if (!(line.includes("Bash") || line.includes("TaskStop") || line.includes("background"))) continue
	let entry
	try {
		entry = JSON.parse(line)
	} catch {
		continue
	}
	const content = entry && entry.message && entry.message.content
	if (!Array.isArray(content)) continue
	for (const item of content) {
		if (!item || typeof item !== "object") continue
		if (item.type === "tool_use" && item.name === "Bash") {
			commands.set(item.id, String((item.input || {}).command || ""))
		} else if (item.type === "tool_use" && item.name === "TaskStop") {
			const input = item.input || {}
			const tid = input.task_id || input.taskId || input.id
			if (tid) ended.add(String(tid))
		} else if (item.type === "tool_result") {
			const text = flattenContent(item.content)
			if (!text.includes("background")) continue
			const outputMatch = OUTPUT_PATH.exec(text)
			const output = outputMatch ? outputMatch[1] : "(output file not named)"
			for (const m of text.matchAll(EXPLICIT_BG)) {
				started.set(m[1], { output, toolUse: item.tool_use_id })
			}
			for (const m of text.matchAll(AUTO_BG)) {
				started.set(m[1], { output, toolUse: item.tool_use_id })
			}
		}
	}
}

const configExempt = started.size ? exemptPattern() : null
const outstanding = []
for (const [id, info] of started) {
	if (ended.has(id)) continue
	const command = commands.get(info.toolUse) || ""
	if (command && DEFAULT_EXEMPT.test(command)) continue
	if (command && configExempt && configExempt.test(command)) continue
	outstanding.push({ id, output: info.output, command })
}

const agentKey = String(data.agent_id || path.basename(transcript, ".jsonl")).replace(/[^A-Za-z0-9_-]/g, "_")
const countFile = path.join(os.tmpdir(), `park-guard-${agentKey}.count`)

if (!outstanding.length) {
	try {
		fs.unlinkSync(countFile)
	} catch {}
	allow()
}

let blocks = 0
try {
	blocks = parseInt(fs.readFileSync(countFile, "utf8"), 10) || 0
} catch {}
blocks += 1
try {
	fs.writeFileSync(countFile, String(blocks))
} catch {}
if (blocks > MAX_BLOCKS) allow() // never-ending task — stand down, don't wedge

const taskList = outstanding
	.map((t) => `  - ${t.id} → ${t.output}${t.command ? ` ← ${t.command.slice(0, 100)}` : ""}`)
	.join("\n")
process.stdout.write(
	JSON.stringify({
		decision: "block",
		reason:
			`park-guard: ${outstanding.length} backgrounded command(s) of yours still running:\n${taskList}\n` +
			`A stopped subagent never receives their completion notifications — ending your turn now loses the work. ` +
			`Poll each task's output file (Read it in a loop) until the command finishes, and act on the result. ` +
			`Then acknowledge each task by calling TaskStop with its id — on a finished task that is pure bookkeeping, ` +
			`and it is what clears this gate. Same for a task you deliberately no longer need: TaskStop it, then return. ` +
			`(block ${blocks}/${MAX_BLOCKS})`,
	}),
)
process.exit(0)
