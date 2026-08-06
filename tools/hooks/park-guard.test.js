const assert = require("node:assert/strict")
const { execFileSync, spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const hook = path.join(__dirname, "park-guard.js")

function bashUse(id, command, bg) {
	const input = bg ? { command, run_in_background: true } : { command }
	return { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input }] } }
}

function bgResult(toolUseId, taskId, auto) {
	const text = auto
		? `Command did not complete within its 600s timeout and was moved to the background (ID: ${taskId}). Output is being written to: /tmp/tasks/${taskId}.output. You will be notified when it completes.`
		: `Command running in background with ID: ${taskId}. Output is being written to: /tmp/tasks/${taskId}.output. You will be notified when it completes. To check interim output, use Read on that file path.`
	return {
		type: "user",
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text }] }] },
	}
}

function notification(taskId) {
	return {
		type: "user",
		message: {
			role: "user",
			content: [{ type: "text", text: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>` }],
		},
	}
}

function taskStop(taskId) {
	return {
		type: "assistant",
		message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_stop_${taskId}`, name: "TaskStop", input: { task_id: taskId } }] },
	}
}

let agentSeq = 0
function runHook(entries, { files = {}, gitConfig = null, agentId } = {}) {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "park-guard-test-"))
	const id = agentId || `agent-test-${agentSeq++}`
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo })
		if (gitConfig) execFileSync("git", ["config", gitConfig[0], gitConfig[1]], { cwd: repo })
		for (const [name, text] of Object.entries(files)) {
			const file = path.join(repo, name)
			fs.mkdirSync(path.dirname(file), { recursive: true })
			fs.writeFileSync(file, text)
		}
		const transcript = path.join(repo, `${id}.jsonl`)
		fs.writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join("\n"))
		return spawnSync(process.execPath, [hook], {
			cwd: repo,
			encoding: "utf8",
			input: JSON.stringify({
				hook_event_name: "SubagentStop",
				cwd: repo,
				transcript_path: transcript,
				agent_id: id,
			}),
		})
	} finally {
		fs.rmSync(repo, { force: true, recursive: true })
		try {
			fs.unlinkSync(path.join(os.tmpdir(), `park-guard-${id}.count`))
		} catch {}
	}
}

function decision(result) {
	assert.equal(result.status, 0)
	if (!result.stdout.trim()) return null
	return JSON.parse(result.stdout)
}

test("no transcript → fail open, no block", () => {
	const result = spawnSync(process.execPath, [hook], {
		encoding: "utf8",
		input: JSON.stringify({ hook_event_name: "SubagentStop", transcript_path: "/nonexistent/agent-x.jsonl" }),
	})
	assert.equal(result.status, 0)
	assert.equal(result.stdout.trim(), "")
})

test("garbage stdin → fail open", () => {
	const result = spawnSync(process.execPath, [hook], { encoding: "utf8", input: "not json" })
	assert.equal(result.status, 0)
	assert.equal(result.stdout.trim(), "")
})

test("no background tasks → allow", () => {
	const out = decision(runHook([bashUse("toolu_1", "ls -la", false)]))
	assert.equal(out, null)
})

test("explicit background task without completion → block with id and output path", () => {
	const out = decision(runHook([bashUse("toolu_1", "sleep 900", true), bgResult("toolu_1", "btask01", false)]))
	assert.equal(out.decision, "block")
	assert.match(out.reason, /btask01/)
	assert.match(out.reason, /btask01\.output/)
})

test("auto-backgrounded foreground command without completion → block", () => {
	const out = decision(runHook([bashUse("toolu_1", "bash scripts/verify-gate.sh --mark feat/x", false), bgResult("toolu_1", "bauto01", true)]))
	assert.equal(out.decision, "block")
	assert.match(out.reason, /bauto01/)
	assert.match(out.reason, /verify-gate/)
})

test("completed task (task-notification in transcript) → allow", () => {
	const out = decision(runHook([bashUse("toolu_1", "sleep 5", true), bgResult("toolu_1", "bdone01", false), notification("bdone01")]))
	assert.equal(out, null)
})

test("TaskStop acknowledgment clears the gate", () => {
	const out = decision(runHook([bashUse("toolu_1", "sleep 900", true), bgResult("toolu_1", "bstop01", false), taskStop("bstop01")]))
	assert.equal(out, null)
})

test("one completed, one outstanding → block names only the outstanding id", () => {
	const out = decision(
		runHook([
			bashUse("toolu_1", "sleep 5", true),
			bgResult("toolu_1", "bdone02", false),
			notification("bdone02"),
			bashUse("toolu_2", "sleep 900", true),
			bgResult("toolu_2", "blive02", false),
		]),
	)
	assert.equal(out.decision, "block")
	assert.match(out.reason, /blive02/)
	assert.doesNotMatch(out.reason, /bdone02/)
})

test("standing watcher exact shape is exempt by default", () => {
	const out = decision(runHook([bashUse("toolu_1", "bash scripts/watch-lane.sh manager 101 102", true), bgResult("toolu_1", "bwatch01", false)]))
	assert.equal(out, null)
})

test("watcher-ish command with extra shell machinery is NOT exempt", () => {
	const out = decision(runHook([bashUse("toolu_1", "bash scripts/watch-lane.sh manager; rm -rf /tmp/x", true), bgResult("toolu_1", "bwatch02", false)]))
	assert.equal(out.decision, "block")
})

test("git config agent.park-guard-exempt extends the exemption", () => {
	const entries = [bashUse("toolu_1", "node tools/my-daemon.js --standing", true), bgResult("toolu_1", "bcfg01", false)]
	const blocked = decision(runHook(entries))
	assert.equal(blocked.decision, "block")
	const allowed = decision(runHook(entries, { gitConfig: ["agent.park-guard-exempt", "^node tools/my-daemon\\.js"] }))
	assert.equal(allowed, null)
})

test("park_guard: off in hook settings disables the gate", () => {
	const out = decision(
		runHook([bashUse("toolu_1", "sleep 900", true), bgResult("toolu_1", "boff01", false)], {
			files: { ".agent/orchestrate.md": "## Hook settings\n\n- park_guard: off\n" },
		}),
	)
	assert.equal(out, null)
})

test("loop cap: stands down after MAX_BLOCKS blocks for the same agent", () => {
	const id = "agent-test-cap"
	fs.writeFileSync(path.join(os.tmpdir(), `park-guard-${id}.count`), "8")
	try {
		const out = decision(runHook([bashUse("toolu_1", "sleep 900", true), bgResult("toolu_1", "bcap01", false)], { agentId: id }))
		assert.equal(out, null)
	} finally {
		try {
			fs.unlinkSync(path.join(os.tmpdir(), `park-guard-${id}.count`))
		} catch {}
	}
})

test("non-SubagentStop event → allow untouched", () => {
	const result = spawnSync(process.execPath, [hook], {
		encoding: "utf8",
		input: JSON.stringify({ hook_event_name: "Stop", transcript_path: "/tmp/whatever.jsonl" }),
	})
	assert.equal(result.status, 0)
	assert.equal(result.stdout.trim(), "")
})
