#!/usr/bin/env node
/**
 * PreToolUse/Bash gate, three jobs:
 *
 * 1. Bot-identity guard: EVERY mutating
 *    `gh` invocation — pr/issue/project/label/release/repo mutations and
 *    `gh api` writes (non-GET --method/-X, or field/body flags with no
 *    explicit GET) — must carry GH_TOKEN= as a DIRECT inline prefix on that
 *    invocation. A token assignment elsewhere on the line proves nothing:
 *    `GH_TOKEN=$(…); gh …` sets an UNexported shell var the gh child never
 *    sees (comments have shipped authored as the human login this way
 *    before), and env vars never persist across tool calls either.
 *    Reads (list/view/status/checks, api GET) are exempt. Applies even under
 *    ZCR_SKIP. Known false-positive: a quoted string containing something
 *    like `; gh pr comment …` can trip the guard — fails in the block
 *    direction; reword the string or use --body-file.
 *
 * 2. Draft-first: an explicit repo setting requires `--draft` on every
 *    `gh pr create`.
 *
 * 3. Review/verify markers for `gh pr create` (unchanged): block unless BOTH
 *    markers are fresh for the head branch (each pinned to the branch tip
 *    sha — commits after invalidate):
 *      review marker  (<git-common-dir>/.review-gate/<branch>; legacy
 *                      .zcr-reviewed/<branch> honored for repos that predate
 *                      the current marker-dir name)
 *                      — /review-gate passed
 *      verify marker  (<git-common-dir>/.verify-green/<branch>)  — scripts/verify-mark.sh
 *
 * Fail-OPEN by design: any error / non-repo / parse failure → exit 0 (allow).
 * A broken gate must never block PRs globally. Escape hatches:
 * `REVIEW_GATE_SKIP=1` (legacy alias `ZCR_SKIP=1`) skips the marker checks
 * (pure-docs exception; NEVER the identity or draft-first guard);
 * `VERIFY_SKIP=1` skips only the verify marker.
 */
const fs = require("fs")
const path = require("path")
const { execSync } = require("child_process")

function allow() {
	process.exit(0)
}

let data
try {
	data = JSON.parse(fs.readFileSync(0, "utf8"))
} catch {
	allow()
}

const cmd = (data && data.tool_input && data.tool_input.command) || ""
const cwd = (data && data.cwd) || process.cwd()

// ── per-repo settings ──────────────────────────────────────────────────────
// A repo may set a guard only through a human-committed `## Hook settings`
// section in .agent/orchestrate.md:
//   ## Hook settings
//   - bot_identity: off      # repo uses the human's own gh auth — no bot
//   - review_marker: off
//   - verify_marker: off
//   - draft_first: required
// A legacy `## Enforcement policy` section in .claude/orchestrate.md also
// works. The main file wins when both files hold a settings section.
// Identity, review, and verify default ON and only literal `off` relaxes them.
// Draft-first defaults OFF and only literal `required` enables it. The
// /orchestrate bootstrap interview writes this section from the user's explicit
// answers — agents never author an `off` or `required` themselves.
let _policy
function policy() {
	if (_policy) return _policy
	const on = { identity: true, review: true, verify: true, draft: false }
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
				section: /^##[ \t]+Hook settings[ \t]*\r?$\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m,
			},
			{
				file: path.join(top, ".claude", "orchestrate.md"),
				section: /^##[ \t]+Enforcement policy[ \t]*\r?$\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m,
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
			const isOff = (key) => {
				const match = new RegExp(`^[-*]\\s*${key}\\s*:\\s*(\\S+)`, "m").exec(sec[1])
				return !!match && match[1] === "off"
			}
			const isRequired = (key) => {
				const match = new RegExp(`^[-*]\\s*${key}\\s*:\\s*(\\S+)`, "m").exec(sec[1])
				return !!match && match[1] === "required"
			}
			return (_policy = {
				identity: !isOff("bot_identity"),
				review: !isOff("review_marker"),
				verify: !isOff("verify_marker"),
				draft: isRequired("draft_first"),
			})
		}
		return (_policy = on)
	} catch {
		return (_policy = on)
	}
}

// ── shared regex pieces ──────────────────────────────────────────────────────
// Command position: start of string, after ; && || | ` newline, or inside $( .
// Env-var values may contain spaces inside quotes or $(…) — e.g.
// `GH_TOKEN=$(cat <token-file>) gh …` — so the value part accepts
// quoted/command-substituted segments, not just \S* (a plain \S* let that
// exact form bypass the gate).
// Bare value chars must EXCLUDE statement separators and parens: a plain \S
// let `GH_TOKEN=$(…);` swallow its trailing `;` and pose as an inline prefix
// (the exact semicolon trap this guard exists to catch), and paren-eating
// filler let the inner `$(` of a nested substitution anchor a phantom
// unprefixed match.
// The $(…) alternative supports ONE nesting level — enough for the canonical
// `GH_TOKEN=$(cat …)` inside a `VAR=$( … gh … )` capture; deeper nesting
// mis-parses toward a false block, never a false allow.
const ENV_VAL = `(?:"[^"]*"|'[^']*'|\\$\\((?:[^()]|\\$\\([^)]*\\))*\\)|[^\\s;&|\`()])*`
const CMD_POS = `(?:^|[;&|\`\\n]|\\$\\()\\s*(?:env\\s+)?`
const ENV_PREFIX = `((?:[A-Za-z_][A-Za-z0-9_]*=${ENV_VAL}\\s+)*)`
// Global flags between `gh` and the subcommand (e.g. `-R owner/repo`). Token
// filler cannot cross a statement separator or a paren, so one invocation
// never borrows a subcommand from the next or from outside its substitution.
const FILLER = `(?:[^;&|\`\\n\\s()]+\\s+)*?`

// ── 1. bot-identity guard over every mutating gh invocation ─────────────────
const MUT_SUB =
	`(?:pr|issue)\\s+(?:create|comment|edit|review|close|reopen|merge|ready|lock|unlock|transfer|pin|delete|develop)` +
	`|project\\s+(?:create|copy|close|delete|edit|field-create|field-delete|item-add|item-archive|item-create|item-delete|item-edit|link|unlink|mark-template)` +
	`|(?:release|label)\\s+(?:create|edit|delete|clone|upload|delete-asset)` +
	`|repo\\s+(?:create|edit|delete|rename|archive|unarchive|sync)`
const GH_MUT = new RegExp(`${CMD_POS}${ENV_PREFIX}gh\\s+${FILLER}(?:${MUT_SUB})\\b`, "g")
const GH_API = new RegExp(`${CMD_POS}${ENV_PREFIX}gh\\s+${FILLER}api\\s+([^;&|\`\\n]*)`, "g")

// gh api auto-switches to POST when field/body flags are present; an explicit
// --method wins either way.
function apiIsMutation(args) {
	const m = args.match(/(?:^|\s)(?:--method|-X)[=\s]+["']?([A-Za-z]+)/)
	if (m) return !/^(?:GET|HEAD)$/i.test(m[1])
	return /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)\b/.test(args)
}

const offenders = []
let m
while ((m = GH_MUT.exec(cmd))) {
	if (!/(?:^|\s)GH_TOKEN=/.test(m[1] || "")) offenders.push(m[0])
}
while ((m = GH_API.exec(cmd))) {
	if (!apiIsMutation(m[2] || "")) continue
	if (!/(?:^|\s)GH_TOKEN=/.test(m[1] || "")) offenders.push(m[0])
}
if (offenders.length && policy().identity) {
	process.stderr.write(
		`⛔ bot-identity guard: mutating gh invocation(s) WITHOUT an inline GH_TOKEN= prefix — would author/post as the HUMAN keychain login:\n` +
			offenders.map((o) => `  ✗ ${o.replace(/\s+/g, " ").trim().slice(0, 120)}`).join("\n") +
			`\nPreferred fix — the bgh wrapper (resolves the repo's \`git config agent.bot-token-file\`):\n` +
				`  bgh <subcommand> …\n` +
				`or an inline prefix on EACH gh invocation (\`GH_TOKEN=$(…); gh …\` does NOT work — the semicolon makes it an unexported shell var the gh child never sees):\n` +
			`  GH_TOKEN=$(cat <token-file per the repo conventions>) gh <subcommand> …\n` +
			`Applies even under REVIEW_GATE_SKIP/ZCR_SKIP. Reads (gh pr list/view, gh api GET) are exempt.\n` +
			`(Repo with no bot identity? The human can commit a "## Hook settings" section with "- bot_identity: off" in .agent/orchestrate.md.)`,
	)
	process.exit(2)
}

// ── 2. draft-first and review/verify markers for `gh pr create` ─────────────
const GH_PR_CREATE = new RegExp(`${CMD_POS}${ENV_PREFIX}gh\\s+${FILLER}pr\\s+create\\b([^;&|\`\\n]*)`, "g")
const prCreates = [...cmd.matchAll(GH_PR_CREATE)]
if (prCreates.length === 0) allow()

if (policy().draft) {
	const hasDraftFlag = (args) => /(?:^|\s)--draft(?:\s|$|=(?:true|1)(?=\s|$))/i.test(args)
	if (prCreates.some((pr) => !hasDraftFlag(pr[2] || ""))) {
		process.stderr.write(
			"⛔ draft-first gate: each gh pr create requires --draft. Add required artifacts and wait for checks before the manager marks the PR ready.\n",
		)
		process.exit(2)
	}
}

// Deliberate, explicit override (markers only — identity guard already ran).
if (/\b(?:REVIEW_GATE_SKIP|ZCR_SKIP)=1\b/.test(cmd)) allow()
// Explicit human-committed per-repo opt-out (see policy() above); default ON.
if (!policy().review && !policy().verify) allow()

function git(args) {
	return execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
}

let commonDir
try {
	commonDir = path.resolve(cwd, git("rev-parse --git-common-dir"))
} catch {
	allow() // not a git repo → nothing to gate
}

// Branch: prefer an explicit --head (required by convention — cwd-derived
// detection is wrong when the command runs outside the branch's worktree).
let branch
const hm = cmd.match(/--head[=\s]+["']?([^\s"']+)/)
if (hm) {
	branch = hm[1]
} else {
	try {
		branch = git("rev-parse --abbrev-ref HEAD")
	} catch {
		allow()
	}
}

// Marker may live in .review-gate/ (current) or .zcr-reviewed/ (legacy name,
// honored during the rename transition) — freshest match in either wins.
const MARKER_DIRS = [".review-gate", ".zcr-reviewed"]
const markerFile = branch.replace(/\//g, "__")

function block(reason) {
	process.stderr.write(
		`⛔ review-gate: ${reason} (branch "${branch}").\n` +
			`Run the /review-gate skill on this diff FIRST — on PASS it pins the marker to the branch tip — then retry.\n` +
			`If you committed after the review, re-run the review.\n` +
			`Deliberate exception (rare): prefix the command with REVIEW_GATE_SKIP=1.`,
	)
	process.exit(2)
}

let _tip
function tipSha() {
	if (_tip !== undefined) return _tip
	try {
		return (_tip = git(`rev-parse "refs/heads/${branch}"`))
	} catch {
		allow() // branch not resolvable from here → fail open
	}
}

if (policy().review) {
	const existing = MARKER_DIRS.map((d) => path.join(commonDir, d, markerFile)).filter((p) => fs.existsSync(p))
	if (existing.length === 0) block("no review marker")
	const tip = tipSha()

	let sawEmpty = false
	let fresh = false
	for (const p of existing) {
		let want
		try {
			want = fs.readFileSync(p, "utf8").trim()
		} catch {
			allow() // unreadable marker → fail open
		}
		if (!want) {
			sawEmpty = true
			continue
		}
		if (want === tip) {
			fresh = true
			break
		}
	}
	if (!fresh) {
		if (sawEmpty) block("empty (legacy) review marker — re-run the review to pin the sha")
		block("review marker is stale — the branch tip moved since the review")
	}
}

// Verify-green marker (scripts/verify-mark.sh) — proof the local verify gate
// passed at this tip (repos that gate merges on a local verify run instead of CI).
if (policy().verify && !/\bVERIFY_SKIP=1\b/.test(cmd)) {
	const vMarker = path.join(commonDir, ".verify-green", branch.replace(/\//g, "__"))

	function blockVerify(reason) {
		process.stderr.write(
			`⛔ verify-green gate: ${reason} (branch "${branch}").\n` +
				`Run the local checks from the repo rules, then pin them: bash scripts/verify-mark.sh ${branch} — then retry.\n` +
				`If you committed after verifying, re-run the gate.\n` +
				`Deliberate exception (rare): prefix the command with VERIFY_SKIP=1.`,
		)
		process.exit(2)
	}

	if (!fs.existsSync(vMarker)) blockVerify("no verify-green marker")

	let vWant
	try {
		vWant = fs.readFileSync(vMarker, "utf8").trim()
	} catch {
		allow() // unreadable marker → fail open
	}
	if (!vWant) blockVerify("empty verify-green marker — re-run scripts/verify-mark.sh to pin the sha")
	if (vWant !== tipSha()) blockVerify("verify-green marker is stale — the branch tip moved since the verify run")
}

allow()
