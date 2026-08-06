const assert = require("node:assert/strict")
const { execFileSync, spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const hook = path.join(__dirname, "review-gate.js")

function runHook(files, command = "gh issue create --title test", gitArgs = null) {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "review-gate-test-"))
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo })
		if (gitArgs) execFileSync("git", gitArgs, { cwd: repo })
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

test("bot identity ignores token text inside another assignment", () => {
	for (const lineBreak of ["\n", "\r\n"]) {
		for (const command of [
			`NOTE="value GH_TOKEN=decoy" gh pr \\${lineBreak}create --draft --title test`,
			`NOTE="value GH_TOKEN=decoy" gh "p\\${lineBreak}r" create --draft --title test`,
		]) {
			const result = runHook({ ".agent/orchestrate.md": identitySettings }, command)
			assert.equal(result.status, 2, JSON.stringify(command))
			assert.match(result.stderr, /bot-identity guard/, JSON.stringify(command))
		}
	}
})

test("bot identity accepts an exact token assignment after normalization", () => {
	const command = 'NOTE="value GH_TOKEN=decoy" GH_TOKEN=real gh "p\\\nr" create --draft'
	const result = runHook({ ".agent/orchestrate.md": identitySettings }, command)
	assert.equal(result.status, 0)
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

test("bare-gh: wrapped invocations block with the unwrap message, not silence", () => {
	for (const command of [
		"command gh pr create --draft --title test",
		"env -i gh pr create --draft --title test",
		"env GH_TOKEN=real gh pr create --draft --title test",
		"nohup gh pr create --draft --title test",
	]) {
		const result = runHook({ ".agent/orchestrate.md": draftFirstSettings }, command)
		assert.equal(result.status, 2, command)
		assert.match(result.stderr, /bare-gh/, command)
	}
})

test("bare-gh: a quoted gh command passed as an argument blocks (env -S / sh -c shape)", () => {
	for (const command of [
		'env -S "gh pr create --draft --title test"',
		'sh -c "gh pr comment 1 --body hi"',
		'xargs -I{} "gh pr comment {} --body hi"',
	]) {
		const result = runHook({ ".agent/orchestrate.md": identitySettings }, command)
		assert.equal(result.status, 2, command)
		assert.match(result.stderr, /bare-gh/, command)
	}
})

test("bare-gh: env -C decoy token cannot satisfy the identity guard", () => {
	const command = "env -C GH_TOKEN=decoy gh pr comment 1 --body hi"
	const result = runHook({ ".agent/orchestrate.md": identitySettings }, command)
	assert.equal(result.status, 2)
	assert.match(result.stderr, /bare-gh/)
})

test("bare-gh: quoted prose mentioning a gh mutation never trips", () => {
	const command = 'GH_TOKEN=real gh pr comment 1 --body "then run gh pr create later"'
	const result = runHook({ ".agent/orchestrate.md": identitySettings }, command)
	assert.equal(result.status, 0)
})

test("bare-gh: unquoted prose trips closed (documented false positive)", () => {
	const command = "echo run gh pr create later"
	const result = runHook({ ".agent/orchestrate.md": identitySettings }, command)
	assert.equal(result.status, 2)
	assert.match(result.stderr, /bare-gh/)
})

test("bare-gh: hidden second mutation behind a wrapper trips despite a clean first one", () => {
	const command = "GH_TOKEN=real gh pr comment 1 --body hi; nohup gh pr edit 2 --title x"
	const result = runHook({ ".agent/orchestrate.md": identitySettings }, command)
	assert.equal(result.status, 2)
	assert.match(result.stderr, /bare-gh/)
})

test("gh-wrapper config: wrapper satisfies identity and still gets draft gating", () => {
	const settings = { ".agent/orchestrate.md": draftFirstSettings.replace("- bot_identity: off\n", "") }
	const blocked = runHook(settings, "bgh pr create --title test", ["config", "agent.gh-wrapper", "bgh"])
	assert.equal(blocked.status, 2)
	assert.match(blocked.stderr, /draft-first gate/)
	const allowed = runHook(settings, "bgh pr create --draft --title test", ["config", "agent.gh-wrapper", "bgh"])
	assert.equal(allowed.status, 0)
})

test("gh-wrapper config: unconfigured wrapper name is not recognized as gh", () => {
	const result = runHook({ ".agent/orchestrate.md": draftFirstSettings }, "bgh pr create --title test")
	assert.equal(result.status, 0)
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

const readySnapshot = JSON.stringify({ number: 7, state: "OPEN", isDraft: false, branch: "feat/x" })
const draftSnapshot = JSON.stringify({ number: 7, state: "OPEN", isDraft: true, branch: "feat/x" })
const preUpgradeSnapshot = JSON.stringify({ number: 7, state: "OPEN", branch: "feat/x" })

function runPushHook(snapshot, command, extra = {}) {
	const statusRoot = fs.mkdtempSync(path.join(os.tmpdir(), "review-gate-status-"))
	fs.mkdirSync(path.join(statusRoot, "status"), { recursive: true })
	if (snapshot) fs.writeFileSync(path.join(statusRoot, "status", "pr-7.json"), snapshot)
	try {
		return runHook(
			extra.files ?? {},
			command,
			extra.noConfig ? null : ["config", "agent.pr-status-dir", statusRoot],
		)
	} finally {
		fs.rmSync(statusRoot, { force: true, recursive: true })
	}
}

test("ready-push gate blocks a push to a ready PR's branch", () => {
	for (const command of [
		"git push origin feat/x",
		"git push -u origin feat/x",
		"git push origin HEAD:refs/heads/feat/x",
		"git push origin HEAD:feat/x",
	]) {
		const result = runPushHook(readySnapshot, command)
		assert.equal(result.status, 2, command)
		assert.match(result.stderr, /ready-push gate/, command)
	}
})

test("ready-push gate allows a draft PR, a missing config, and a pre-upgrade snapshot", () => {
	assert.equal(runPushHook(draftSnapshot, "git push origin feat/x").status, 0)
	assert.equal(runPushHook(readySnapshot, "git push origin feat/x", { noConfig: true }).status, 0)
	assert.equal(runPushHook(preUpgradeSnapshot, "git push origin feat/x").status, 0)
})

test("ready-push gate allows other branches and honors the override", () => {
	assert.equal(runPushHook(readySnapshot, "git push origin feat/other").status, 0)
	assert.equal(runPushHook(readySnapshot, "READY_PUSH_OK=1 git push origin feat/x").status, 0)
})

test("ready-push gate honors the ready_push_gate: off setting", () => {
	const result = runPushHook(readySnapshot, "git push origin feat/x", {
		files: { ".agent/orchestrate.md": "## Hook settings\n\n- ready_push_gate: off\n" },
	})
	assert.equal(result.status, 0)
})
