const assert = require("node:assert/strict")
const { execFileSync, spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const hook = path.join(__dirname, "review-gate.js")

function runHook(files) {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "review-gate-test-"))
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo })
		for (const [name, text] of Object.entries(files)) {
			const file = path.join(repo, name)
			fs.mkdirSync(path.dirname(file), { recursive: true })
			fs.writeFileSync(file, text)
		}
		return spawnSync(process.execPath, [hook], {
			cwd: repo,
			encoding: "utf8",
			input: JSON.stringify({
				cwd: repo,
				tool_input: { command: "gh issue create --title test" },
			}),
		})
	} finally {
		fs.rmSync(repo, { force: true, recursive: true })
	}
}

test("main hook settings turn off a guard", () => {
	const result = runHook({
		".agent/orchestrate.md": "## Hook settings\n\n- bot_identity: off\n",
	})
	assert.equal(result.status, 0)
})

test("main hook settings win over legacy settings", () => {
	const result = runHook({
		".agent/orchestrate.md": "## Hook settings\n\n- bot_identity: required\n",
		".claude/orchestrate.md": "## Enforcement policy\n\n- bot_identity: off\n",
	})
	assert.equal(result.status, 2)
})

test("legacy settings work when the main file has none", () => {
	const result = runHook({
		".agent/orchestrate.md": "# Project rules\n",
		".claude/orchestrate.md": "## Enforcement policy\n\n- bot_identity: off\n",
	})
	assert.equal(result.status, 0)
})

test("missing settings keep guards on", () => {
	const result = runHook({})
	assert.equal(result.status, 2)
	assert.match(result.stderr, /bot-identity guard/)
})
