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
 *    sees (agents have posted comments as the human login this way
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
	const on = { identity: true, review: true, verify: true, draft: false, readyPush: true }
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
				readyPush: !isOff("ready_push_gate"),
			})
		}
		return (_policy = on)
	} catch {
		return (_policy = on)
	}
}

// ── ready-push gate ─────────────────────────────────────────────────────────
// A push to a branch whose OPEN PR is READY (not draft) voids the manager's
// ready vouch without anyone noticing — the user reads "ready" as merge-safe.
// Rule: flip the PR to draft first (gh pr ready <N> --undo), push, re-check,
// re-ready. The gate reads the LOCAL PR status snapshots (no network):
//   git config agent.pr-status-dir   → the gh-status dir (status/pr-*.json)
// Fail-open: no config, no dir, unreadable snapshot, or a snapshot without
// isDraft (pre-upgrade poller). Deliberate override: READY_PUSH_OK=1 prefix.
function pushTargetBranch(words) {
	let index = 0
	while (ASSIGNMENT.test(words[index] || "")) index += 1
	if (words[index] !== "git") return null
	index += 1
	if (words[index] === "-C") index += 2
	if (words[index] !== "push") return null
	index += 1
	const positional = []
	while (index < words.length) {
		const word = words[index]
		if (word === "--") {
			positional.push(...words.slice(index + 1))
			break
		}
		if (word.startsWith("-")) {
			index += 1
			continue
		}
		positional.push(word)
		index += 1
	}
	if (positional.length < 2) {
		try {
			return execSync("git rev-parse --abbrev-ref HEAD", {
				cwd,
				stdio: ["ignore", "pipe", "ignore"],
			})
				.toString()
				.trim()
		} catch {
			return null
		}
	}
	const refspec = positional[1]
	const dst = refspec.includes(":") ? refspec.split(":").pop() : refspec
	return dst.replace(/^refs\/heads\//, "").replace(/^\+/, "") || null
}

function readyPrForBranch(branch) {
	let dir
	try {
		dir = execSync("git config agent.pr-status-dir", {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim()
	} catch {
		return null
	}
	if (!dir) return null
	if (dir.startsWith("~")) dir = path.join(process.env.HOME || "", dir.slice(1))
	let files
	try {
		files = fs.readdirSync(path.join(dir, "status"))
	} catch {
		return null
	}
	for (const file of files) {
		if (!/^pr-\d+\.json$/.test(file)) continue
		let snap
		try {
			snap = JSON.parse(fs.readFileSync(path.join(dir, "status", file), "utf8"))
		} catch {
			continue
		}
		if (snap.branch !== branch) continue
		if (snap.state !== "OPEN") continue
		if (snap.isDraft === false) return snap.number
		return null // draft, or pre-upgrade snapshot without isDraft → allow
	}
	return null
}

// ── bare-gh contract ────────────────────────────────────────────────────────
// The gate recognizes exactly `[VAR=val …] gh …` (plus the repo's configured
// wrapper, below) as a gh invocation. It deliberately unwraps NOTHING — no
// `env`, no `command`, no `nohup`, no `sh -c`. Wrapper behavior differs by
// platform (GNU and BSD env -S split differently; -C is GNU-only), and each
// accepted wrapper is one more way for a model's next habit to slip past the
// gate. Instead, anything gh-shaped that the bare parse cannot account for
// BLOCKS with an unwrap message (see the tripwire at the bottom): the parse
// catches the normal shapes, the tripwire catches the rest, and when they
// disagree the gate blocks.
// The gate guards against an honest agent that drifts, not an attacker — it
// turns drift into loud blocks; it cannot stop deliberate evasion.
//
// Repo wrapper: `git config agent.gh-wrapper` (e.g. `bgh`) names a wrapper
// that injects the bot token per call. A wrapper call needs no token prefix —
// injecting the token is the wrapper's job — and still gets draft and marker
// checks.
let _wrapper
function ghWrapper() {
	if (_wrapper !== undefined) return _wrapper
	try {
		_wrapper =
			execSync("git config agent.gh-wrapper", {
				cwd,
				stdio: ["ignore", "pipe", "ignore"],
			})
				.toString()
				.trim() || null
	} catch {
		_wrapper = null
	}
	if (_wrapper && !/^[A-Za-z0-9_.-]+$/.test(_wrapper)) _wrapper = null
	return _wrapper
}
function ghWordRe() {
	const wrapper = ghWrapper()
	return wrapper ? `(?:gh|${wrapper.replace(/\./g, "\\.")})` : "gh"
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
// Bare-gh: no `(?:env\s+)?` here — `env VAR=x gh …` is not a recognized shape;
// the tripwire blocks it with a rewrite-as-plain-prefix message.
const CMD_POS = `(?:^|[;&|\`\\n]|\\$\\()\\s*`
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
const GH_MUT = new RegExp(`${CMD_POS}${ENV_PREFIX}(${ghWordRe()})\\s+${FILLER}(?:${MUT_SUB})\\b`, "g")
const GH_API = new RegExp(`${CMD_POS}${ENV_PREFIX}(${ghWordRe()})\\s+${FILLER}api\\s+([^;&|\`\\n]*)`, "g")

// gh api auto-switches to POST when field/body flags are present; an explicit
// --method wins either way.
function apiIsMutation(args) {
	const m = args.match(/(?:^|\s)(?:--method|-X)[=\s]+["']?([A-Za-z]+)/)
	if (m) return !/^(?:GET|HEAD)$/i.test(m[1])
	return /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)\b/.test(args)
}

function hasGhTokenAssignment(words) {
	return words.some((word) => /^GH_TOKEN=/.test(word))
}

function prefixHasGhToken(prefix) {
	const commands = shellCommands(prefix)
	return hasGhTokenAssignment(commands[commands.length - 1] || [])
}

function collectIdentityOffenders(input, inlineToken, offenders) {
	const wrapper = ghWrapper()
	let match
	while ((match = GH_MUT.exec(input))) {
		if (match[2] === wrapper) continue // injecting the token is the wrapper's job
		const hasToken = inlineToken === undefined ? prefixHasGhToken(match[1] || "") : inlineToken
		if (!hasToken) offenders.add(match[0])
	}
	while ((match = GH_API.exec(input))) {
		if (!apiIsMutation(match[3] || "")) continue
		if (match[2] === wrapper) continue
		const hasToken = inlineToken === undefined ? prefixHasGhToken(match[1] || "") : inlineToken
		if (!hasToken) offenders.add(match[0])
	}
}

function blockIdentity(offenders) {
	process.stderr.write(
		`⛔ bot-identity guard: mutating gh invocation(s) WITHOUT an inline GH_TOKEN= prefix — would author/post as the HUMAN keychain login:\n` +
			[...offenders]
				.map((o) => `  ✗ ${o.replace(/\s+/g, " ").trim().slice(0, 120)}`)
				.join("\n") +
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
// This small lexer preserves shell word boundaries, so body text and comments
// cannot pose as options. Per the bare-gh contract it recognizes NO wrappers —
// the command word after the assignments prefix must be gh (or the wrapper).
function commandSubstitution(input, start) {
	let depth = 1
	let quote = ""
	let index = start + 2
	while (index < input.length) {
		const char = input[index]
		if (quote) {
			if (char === quote) quote = ""
			else if (char === "\\") index += 1
			index += 1
			continue
		}
		if (char === "'" || char === '"') {
			quote = char
			index += 1
			continue
		}
		if (char === "\\") {
			index += 2
			continue
		}
		if (char === "$") {
			if (input[index + 1] === "(") {
				depth += 1
				index += 2
				continue
			}
		}
		if (char === "(") {
			depth += 1
			index += 1
			continue
		}
		if (char === ")") {
			depth -= 1
			index += 1
			if (depth === 0) return { end: index, contentEnd: index - 1 }
			continue
		}
		index += 1
	}
	return { end: input.length, contentEnd: input.length }
}

function backtickSubstitution(input, start) {
	let index = start + 1
	while (index < input.length) {
		if (input[index] === "\\") {
			index += 2
			continue
		}
		if (input[index] === "`") return { end: index + 1, contentEnd: index }
		index += 1
	}
	return { end: input.length, contentEnd: input.length }
}

function shellCommands(input) {
	const commands = []
	let words = []
	let word = ""
	let hasWord = false
	let quote = ""
	let index = 0
	const endWord = () => {
		if (!hasWord) return
		words.push(word)
		word = ""
		hasWord = false
	}
	const endCommand = () => {
		endWord()
		if (words.length) commands.push(words)
		words = []
	}
	while (index < input.length) {
		const char = input[index]
		if (quote === "'") {
			if (char === "'") quote = ""
			else word += char
			index += 1
			continue
		}
		if (quote === '"') {
			if (char === '"') {
				quote = ""
				index += 1
				continue
			}
			if (
				char === "\\" &&
				(input[index + 1] === "\n" ||
					(input[index + 1] === "\r" && input[index + 2] === "\n"))
			) {
				index += input[index + 1] === "\r" ? 3 : 2
				continue
			}
			if (char === "$") {
				if (input[index + 1] === "(") {
					const sub = commandSubstitution(input, index)
					commands.push(...shellCommands(input.slice(index + 2, sub.contentEnd)))
					word += input.slice(index, sub.end)
					hasWord = true
					index = sub.end
					continue
				}
			}
			if (char === "`") {
				const sub = backtickSubstitution(input, index)
				commands.push(...shellCommands(input.slice(index + 1, sub.contentEnd)))
				word += input.slice(index, sub.end)
				hasWord = true
				index = sub.end
				continue
			}
			if (char === "\\" && index + 1 < input.length) {
				word += input[index + 1]
				hasWord = true
				index += 2
				continue
			}
			word += char
			hasWord = true
			index += 1
			continue
		}
		if (char === "'" || char === '"') {
			quote = char
			hasWord = true
			index += 1
			continue
		}
		if (
			char === "\\" &&
			(input[index + 1] === "\n" ||
				(input[index + 1] === "\r" && input[index + 2] === "\n"))
		) {
			index += input[index + 1] === "\r" ? 3 : 2
			continue
		}
		if (char === "\\" && index + 1 < input.length) {
			word += input[index + 1]
			hasWord = true
			index += 2
			continue
		}
		if (char === "$") {
			if (input[index + 1] === "(") {
				const sub = commandSubstitution(input, index)
				commands.push(...shellCommands(input.slice(index + 2, sub.contentEnd)))
				word += input.slice(index, sub.end)
				hasWord = true
				index = sub.end
				continue
			}
		}
		if (char === "`") {
			const sub = backtickSubstitution(input, index)
			commands.push(...shellCommands(input.slice(index + 1, sub.contentEnd)))
			word += input.slice(index, sub.end)
			hasWord = true
			index = sub.end
			continue
		}
		if (char === "#" && !hasWord) {
			while (index < input.length && input[index] !== "\n") index += 1
			continue
		}
		if (char === ";" || char === "\n" || char === "|" || char === "&") {
			endCommand()
			if ((char === "|" || char === "&") && input[index + 1] === char) index += 1
			index += 1
			continue
		}
		if (/\s/.test(char)) {
			endWord()
			index += 1
			continue
		}
		word += char
		hasWord = true
		index += 1
	}
	endCommand()
	return commands
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const GH_VALUE_OPTIONS = new Set([
	"-R",
	"--browser",
	"--config",
	"--hostname",
	"--pager",
	"--repo",
])
const PR_CREATE_VALUE_OPTIONS = new Set([
	"-R",
	"-a",
	"-B",
	"-b",
	"-F",
	"-H",
	"-l",
	"-m",
	"-p",
	"-r",
	"-T",
	"-t",
	"--assignee",
	"--base",
	"--body",
	"--body-file",
	"--browser",
	"--config",
	"--head",
	"--hostname",
	"--label",
	"--milestone",
	"--pager",
	"--project",
	"--recover",
	"--repo",
	"--reviewer",
	"--template",
	"--title",
])

// Bare-gh: an assignments prefix, then the command word must BE `gh` (or the
// configured wrapper). Wrapped forms (`env …`, `command …`, `nohup …`) are
// deliberately NOT parsed — the tripwire below blocks anything gh-shaped they
// might hide. Because only ASSIGNMENT-matching words are skipped, the prefix
// zone [0, index) can hold nothing but assignments —
// an option value like `-C GH_TOKEN=decoy` can never land in it.
function ghCommandIndex(words) {
	let index = 0
	while (ASSIGNMENT.test(words[index] || "")) index += 1
	const word = words[index]
	if (word === "gh") return index
	if (ghWrapper() && word === ghWrapper()) return index
	return -1
}

function prCreateArgs(words) {
	let index = ghCommandIndex(words)
	if (index < 0) return null
	index += 1
	while (words[index]) {
		const word = words[index]
		if (word === "pr" && words[index + 1] === "create") return words.slice(index + 2)
		if (word === "--" || !word.startsWith("-")) return null
		index += GH_VALUE_OPTIONS.has(word) ? 2 : 1
	}
	return null
}

const DRAFT_TRUE_VALUES = new Set(["1", "t", "T", "true", "TRUE", "True"])

function hasDraftFlag(args) {
	let draft = false
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]
		if (arg === "--") break
		if (arg === "--draft") {
			draft = true
			continue
		}
		const match = /^--draft=(.*)$/.exec(arg)
		if (match) {
			draft = DRAFT_TRUE_VALUES.has(match[1])
			continue
		}
		if (PR_CREATE_VALUE_OPTIONS.has(arg)) index += 1
	}
	return draft
}

if (policy().readyPush && !/\bREADY_PUSH_OK=1\b/.test(cmd) && /\bgit\b[^;|&`\n]*\bpush\b/.test(cmd)) {
	for (const words of shellCommands(cmd)) {
		const branch = pushTargetBranch(words)
		if (!branch) continue
		const prNumber = readyPrForBranch(branch)
		if (prNumber) {
			process.stderr.write(
				'⛔ ready-push gate: branch "' + branch + '" has OPEN PR #' + prNumber + ' marked READY - pushing now silently voids the ready vouch.\n' +
					'Flip it first: gh pr ready ' + prNumber + ' --undo  (via the repo wrapper), then push, re-run the final check, and re-ready.\n' +
					'Deliberate exception: prefix the push with READY_PUSH_OK=1.',
			)
			process.exit(2)
		}
	}
}

const identityOffenders = new Set()
collectIdentityOffenders(cmd, undefined, identityOffenders)
for (const words of shellCommands(cmd)) {
	const index = ghCommandIndex(words)
	if (index < 0) continue
	collectIdentityOffenders(
		words.slice(index).join(" "),
		hasGhTokenAssignment(words.slice(0, index)),
		identityOffenders,
	)
}
if (identityOffenders.size && policy().identity) blockIdentity(identityOffenders)

// ── bare-gh tripwire ────────────────────────────────────────────────────────
// Catches what the bare parse misses; runs whenever ANY guard is active.
// Two rules, both fail-CLOSED:
//   A) a single shell WORD that itself starts with `gh ` is a quoted gh
//      command passed as an argument — the `env -S "gh …"` / `sh -c "gh …"`
//      shape. Blocked outright.
//   B) counting rule over the UNQUOTED text (quote contents stripped, so
//      PR-body prose never trips): more mutating-gh sightings than the
//      structural CMD_POS parse accounts for means a wrapper (`nohup`, `env`,
//      `xargs`, …) is hiding one. Blocked.
// Known false positive: UNQUOTED prose mentioning a mutating gh command
// (`echo run gh pr create later`) — blocks in the closed direction; quote the
// text or use --body-file.
function unquotedView(input) {
	let out = ""
	let quote = ""
	for (let index = 0; index < input.length; index += 1) {
		const char = input[index]
		if (quote) {
			if (char === "\\" && quote === '"') {
				index += 1
				continue
			}
			if (char === quote) quote = ""
			continue
		}
		if (char === "'" || char === '"') {
			quote = char
			out += " "
			continue
		}
		if (char === "\\") {
			out += " "
			index += 1
			continue
		}
		out += char
	}
	return out
}

function blockBareGh(reason, sample) {
	const wrapper = ghWrapper()
	process.stderr.write(
		`⛔ review-gate (bare-gh): ${reason}:\n  ✗ ${sample.replace(/\s+/g, " ").trim().slice(0, 120)}\n` +
			`The gate parses only \`[VAR=val …] gh …\`${wrapper ? ` (or \`${wrapper} …\`)` : ""} — no env/command/nohup/sh -c wrappers, no quoted gh command strings.\n` +
			`Rewrite as a bare invocation, e.g. \`GH_TOKEN=$(…) gh <subcommand> …\`${wrapper ? ` or \`${wrapper} <subcommand> …\`` : ""}.\n` +
			`Prose mentioning a gh command? Quote it or move it to --body-file.`,
	)
	process.exit(2)
}

const anyGuardActive = policy().identity || policy().draft || policy().review || policy().verify
if (anyGuardActive) {
	const GH_WORD_START = new RegExp(`^${ghWordRe()}\\s`)
	for (const words of shellCommands(cmd)) {
		for (const word of words) {
			if (GH_WORD_START.test(word))
				blockBareGh("a quoted gh command is passed as an argument (env -S / sh -c shape)", word)
		}
	}

	// Shell line-continuations are transparent to the shell but opaque to the
	// structural regexes — collapse them BEFORE both counters so a legal
	// `gh pr \<newline>create` counts identically on both sides.
	const joined = cmd.replace(/\\\r?\n/g, " ")
	const stripped = unquotedView(joined)
	const TRIP_MUT = new RegExp(`\\b${ghWordRe()}\\s+${FILLER}(?:${MUT_SUB})\\b`, "g")
	const TRIP_API = new RegExp(`\\b${ghWordRe()}\\s+${FILLER}api\\s+([^;&|\`\\n]*)`, "g")
	let tripCount = 0
	while (TRIP_MUT.exec(stripped)) tripCount += 1
	let match
	while ((match = TRIP_API.exec(stripped))) {
		if (apiIsMutation(match[1] || "")) tripCount += 1
	}
	let structuralCount = 0
	while (GH_MUT.exec(joined)) structuralCount += 1
	while ((match = GH_API.exec(joined))) {
		if (apiIsMutation(match[3] || "")) structuralCount += 1
	}
	if (tripCount > structuralCount)
		blockBareGh("a mutating gh invocation sits inside an unparsed wrapper or construct", cmd)
}

const prCreates = shellCommands(cmd)
	.map(prCreateArgs)
	.filter((args) => args !== null)
if (prCreates.length === 0) allow()

if (policy().draft) {
	if (prCreates.some((args) => !hasDraftFlag(args))) {
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
