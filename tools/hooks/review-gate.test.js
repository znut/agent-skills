const assert = require("node:assert/strict")
const { execFileSync, spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const hook = path.join(__dirname, "review-gate.js")

function runHook(files, command = "gh issue create --title test") {
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
				tool_input: { command },
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

test("legacy heading in the main file does not turn off a guard", () => {
	const result = runHook({
		".agent/orchestrate.md": "## Enforcement policy\n\n- bot_identity: off\n",
	})
	assert.equal(result.status, 2)
})

test("main heading in the legacy file does not turn off a guard", () => {
	const result = runHook({
		".claude/orchestrate.md": "## Hook settings\n\n- bot_identity: off\n",
	})
	assert.equal(result.status, 2)
})

test("trailing text on the main heading does not turn off a guard", () => {
	const result = runHook({
		".agent/orchestrate.md": "## Hook settings that are not the exact heading\n\n- bot_identity: off\n",
	})
	assert.equal(result.status, 2)
})

test("trailing text on the legacy heading does not turn off a guard", () => {
	const result = runHook({
		".claude/orchestrate.md": "## Enforcement policy that is not the exact heading\n\n- bot_identity: off\n",
	})
	assert.equal(result.status, 2)
})

test("main hook settings require one literal space after ##", () => {
	for (const heading of ["##\tHook settings", "##  Hook settings"]) {
		const result = runHook({
			".agent/orchestrate.md": `${heading}\n\n- bot_identity: off\n`,
		})
		assert.equal(result.status, 2, heading)
	}
})

test("legacy settings require one literal space after ##", () => {
	for (const heading of ["##\tEnforcement policy", "##  Enforcement policy"]) {
		const result = runHook({
			".claude/orchestrate.md": `${heading}\n\n- bot_identity: off\n`,
		})
		assert.equal(result.status, 2, heading)
	}
})

test("allowed headings permit trailing horizontal whitespace", () => {
	for (const [file, heading] of [
		[".agent/orchestrate.md", "## Hook settings \t"],
		[".claude/orchestrate.md", "## Enforcement policy \t"],
	]) {
		const result = runHook({ [file]: `${heading}\n\n- bot_identity: off\n` })
		assert.equal(result.status, 0, file)
	}
})

const draftFirstSettings =
	"## Hook settings\n\n- bot_identity: off\n- review_marker: off\n- verify_marker: off\n- draft_first: required\n"
const identitySettings =
	"## Hook settings\n\n- review_marker: off\n- verify_marker: off\n"

test("bot identity recognizes shell line continuations", () => {
	for (const lineBreak of ["\n", "\r\n"]) {
		for (const command of [
			`gh pr \\${lineBreak}create --draft --title test`,
			`gh "p\\${lineBreak}r" create --draft --title test`,
		]) {
			const result = runHook({ ".agent/orchestrate.md": identitySettings }, command)
			assert.equal(result.status, 2, JSON.stringify(command))
			assert.match(result.stderr, /bot-identity guard/, JSON.stringify(command))
		}
	}
})

test("draft-first setting blocks a PR without --draft", () => {
	const result = runHook(
		{ ".agent/orchestrate.md": draftFirstSettings },
		"gh pr create --title test",
	)
	assert.equal(result.status, 2)
	assert.match(result.stderr, /draft-first gate/)
})

test("draft-first setting permits a draft PR", () => {
	const result = runHook(
		{ ".agent/orchestrate.md": draftFirstSettings },
		"gh pr create --draft --title test",
	)
	assert.equal(result.status, 0)
})

test("draft-first setting recognizes shell line continuations", () => {
	for (const lineBreak of ["\n", "\r\n"]) {
		for (const command of [
			`gh pr \\${lineBreak}create --title test`,
			`gh "p\\${lineBreak}r" create --title test`,
		]) {
			const result = runHook({ ".agent/orchestrate.md": draftFirstSettings }, command)
			assert.equal(result.status, 2, JSON.stringify(command))
			assert.match(result.stderr, /draft-first gate/, JSON.stringify(command))
		}
	}
})

test("draft-first setting accepts every true boolean spelling", () => {
	for (const value of ["1", "t", "T", "true", "TRUE", "True"]) {
		const command = `gh pr create --draft=${value} --title test`
		const result = runHook({ ".agent/orchestrate.md": draftFirstSettings }, command)
		assert.equal(result.status, 0, command)
	}
})

test("draft-first setting rejects false and invalid boolean spellings", () => {
	for (const value of ["0", "f", "F", "false", "FALSE", "False", "TrUe", "yes"]) {
		const command = `gh pr create --draft=${value} --title test`
		const result = runHook({ ".agent/orchestrate.md": draftFirstSettings }, command)
		assert.equal(result.status, 2, command)
		assert.match(result.stderr, /draft-first gate/, command)
	}
})

test("draft-first setting uses the last repeated draft value", () => {
	for (const command of [
		"gh pr create --draft --draft=false --title test",
		"gh pr create --draft=true --draft=0 --title test",
	]) {
		const result = runHook({ ".agent/orchestrate.md": draftFirstSettings }, command)
		assert.equal(result.status, 2, command)
		assert.match(result.stderr, /draft-first gate/, command)
	}
	for (const command of [
		"gh pr create --draft=false --draft --title test",
		"gh pr create --draft=f --draft=T --title test",
	]) {
		const result = runHook({ ".agent/orchestrate.md": draftFirstSettings }, command)
		assert.equal(result.status, 0, command)
	}
})

test("draft-first setting checks every PR creation", () => {
	for (const command of [
		"gh pr create --draft --title one; gh pr create --title two",
		"gh pr create --draft --title one\ngh pr create --title two",
	]) {
		const result = runHook({ ".agent/orchestrate.md": draftFirstSettings }, command)
		assert.equal(result.status, 2, command)
	}
})

test("draft-first setting recognizes command and env wrappers", () => {
	for (const command of [
		"command gh pr create --title test",
		"env -i gh pr create --title test",
	]) {
		const result = runHook({ ".agent/orchestrate.md": draftFirstSettings }, command)
		assert.equal(result.status, 2, command)
	}
})

test("draft-first ignores text and comments that only look like --draft", () => {
	for (const command of [
		'gh pr create --title "--draft"',
		'gh pr create --body "--draft"',
		"gh pr create -F --draft",
		"gh pr create -T --draft",
		"gh pr create --draft=false",
		"gh pr create --title test # --draft",
		"gh pr create -- --draft",
	]) {
		const result = runHook({ ".agent/orchestrate.md": draftFirstSettings }, command)
		assert.equal(result.status, 2, command)
	}
})

test("missing draft-first setting does not require a draft PR", () => {
	const result = runHook(
		{
			".agent/orchestrate.md":
				"## Hook settings\n\n- bot_identity: off\n- review_marker: off\n- verify_marker: off\n",
		},
		"gh pr create --title test",
	)
	assert.equal(result.status, 0)
})

test("level-one and level-two headings end hook settings", () => {
	for (const heading of ["# Other rules", "## Other rules", "#", "##"]) {
		const result = runHook(
			{
				".agent/orchestrate.md":
					"## Hook settings\n\n- bot_identity: off\n- review_marker: off\n- verify_marker: off\n\n" +
						`${heading}\n\n- draft_first: required\n`,
			},
			"gh pr create --title test",
		)
		assert.equal(result.status, 0, heading)
	}
})

test("legacy draft-first setting blocks a PR without --draft", () => {
	const result = runHook(
		{
			".claude/orchestrate.md":
				"## Enforcement policy\n\n- bot_identity: off\n- review_marker: off\n- verify_marker: off\n- draft_first: required\n",
		},
		"gh pr create --title test",
	)
	assert.equal(result.status, 2)
})

test("only literal required enables draft-first", () => {
	const result = runHook(
		{
			".agent/orchestrate.md":
				"## Hook settings\n\n- bot_identity: off\n- review_marker: off\n- verify_marker: off\n- draft_first: requiredish\n",
		},
		"gh pr create --title test",
	)
	assert.equal(result.status, 0)
})

test("missing settings keep guards on", () => {
	const result = runHook({})
	assert.equal(result.status, 2)
	assert.match(result.stderr, /bot-identity guard/)
})
