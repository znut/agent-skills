/**
 * main-ci — the post-merge CI driver; design in README.md here.
 *
 * CLI: `bun tools/main-ci/main-ci.mjs <configName>` — one long-lived process
 * (launchd KeepAlive) that polls origin every 45 s and owns its runs'
 * process groups in memory. Reads the config's `mainCi` block.
 */
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { loadConfig, varDir } from "../lib/config.mjs"
import { expandHome } from "../lib/fs-util.mjs"
import { startRun } from "./run.mjs"

const POLL_MS = 45_000
const GIT_TIMEOUT_MS = 120_000
const BOARD_TIMEOUT_MS = 120_000

function settings(config) {
	const mc = config.mainCi
	if (!mc?.repo || !Array.isArray(mc.core) || mc.core.length === 0) {
		throw new Error(`config ${config.name} needs mainCi.repo and a non-empty mainCi.core`)
	}
	const repo = expandHome(mc.repo)
	const worktree = mc.worktree ? expandHome(mc.worktree) : join(dirname(repo), `${basename(repo)}-worktrees`, "origin-main")
	const dir = join(varDir(config.name), "main-ci")
	const logFile = join(dir, "run.log")
	mkdirSync(join(dir, "runs"), { recursive: true })
	return {
		mc,
		repo,
		worktree,
		dir,
		stateFile: join(dir, "state.json"),
		stepTimeoutMs: (mc.stepTimeout ?? 1800) * 1000,
		env: { ...process.env, ...(mc.env ?? {}), MAIN_CI_VAR: dir, MAIN_CI_WORKTREE: worktree },
		log: (line) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`),
	}
}

// A bounded child with captured output; a timeout counts as exit 124.
function capture(s, cmd, args, timeoutMs) {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { env: s.env, stdio: ["ignore", "pipe", "pipe"] })
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (d) => (stdout += d))
		child.stderr.on("data", (d) => (stderr += d))
		const timer = setTimeout(() => {
			stderr = `timed out after ${timeoutMs / 1000}s\n${stderr}`
			child.kill("SIGKILL")
		}, timeoutMs)
		child.on("error", (e) => resolve({ code: 127, stdout, stderr: e.message }))
		child.on("close", (code) => {
			clearTimeout(timer)
			resolve({ code: code ?? 124, stdout: stdout.trim(), stderr })
		})
	})
}

// A failed child's first stderr line names the cause; the stack follows it.
function reason(r) {
	return r.stderr.split("\n").find((l) => l.trim()) ?? "no stderr"
}

async function git(s, cwd, args) {
	const r = await capture(s, "git", ["-C", cwd, ...args], GIT_TIMEOUT_MS)
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} FAILED exit=${r.code}: ${reason(r)}`)
	return r.stdout
}

async function defaultBranch(s) {
	if (s.mc.branch) return s.mc.branch
	const r = await capture(s, "git", ["-C", s.repo, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], GIT_TIMEOUT_MS)
	return r.code === 0 && r.stdout ? r.stdout.replace(/^origin\//, "") : "main"
}

async function moveWorktree(s, sha) {
	if (!existsSync(s.worktree)) {
		// --lock: repo cleanup scripts reap unlocked worktrees.
		await git(s, s.repo, ["worktree", "add", "--detach", "--lock", "--reason", "main-ci", s.worktree, sha])
	}
	await git(s, s.worktree, ["checkout", "-q", "--detach", "-f", sha])
	await git(s, s.worktree, ["clean", "-q", "-fd", "-e", "node_modules"])
}

function eventsStamp(config) {
	const dir = join(varDir(config.name), "gh-status", "events")
	if (!existsSync(dir)) return null
	let max = statSync(dir).mtimeMs
	for (const f of readdirSync(dir)) {
		try {
			max = Math.max(max, statSync(join(dir, f)).mtimeMs)
		} catch {}
	}
	return String(max)
}

// Board snapshot on gh-status event changes; a subprocess, so its own exit
// paths cannot end the driver.
async function boardSnapshot(config, s) {
	if (!config.board) return
	const stamp = eventsStamp(config)
	const stampFile = join(s.dir, ".events-stamp")
	if (stamp === null || (existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp)) return
	writeFileSync(stampFile, stamp)
	const script = new URL("../board-snapshot/board-snapshot.mjs", import.meta.url).pathname
	const r = await capture(s, process.execPath, [script, config.name, "--force"], BOARD_TIMEOUT_MS)
	if (r.code !== 0) s.log(`board-snapshot: FAIL exit=${r.code} — ${reason(r)}`)
}

async function drive(config) {
	const s = settings(config)
	let current = null
	let lastError = ""
	// Every exit path, a crash included, takes the run's groups with it.
	process.on("exit", () => current?.kill())
	for (const [sig, n] of [["SIGTERM", 15], ["SIGINT", 2], ["SIGHUP", 1]]) process.on(sig, () => process.exit(128 + n))
	s.log(`driver start pid=${process.pid}`)

	for (;;) {
		try {
			await boardSnapshot(config, s)
			const branch = await defaultBranch(s)
			await git(s, s.repo, ["fetch", "-q", "origin"])
			const tip = await git(s, s.repo, ["rev-parse", `refs/remotes/origin/${branch}^{commit}`])
			if (current?.sha !== tip) {
				s.log(`tip moved ${current?.sha.slice(0, 8) ?? "(driver start)"} -> ${tip.slice(0, 8)} (origin/${branch})`)
				if (current) {
					const { live, stubborn } = await current.cancel()
					if (live.length > 0) s.log(`cancel run sha=${current.sha} groups=${live.join(",")}${stubborn.length ? ` sigkill=${stubborn.join(",")}` : ""}`)
					current = null
				}
				await moveWorktree(s, tip)
				current = startRun(s, tip)
			}
			if (lastError) s.log("poll ok again")
			lastError = ""
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			if (msg !== lastError) s.log(`poll FAILED: ${msg}`)
			lastError = msg
		}
		await Bun.sleep(POLL_MS)
	}
}

const name = process.argv[2]
if (!name) {
	console.error("usage: bun tools/main-ci/main-ci.mjs <configName>")
	process.exit(1)
}
await drive(loadConfig(name))
