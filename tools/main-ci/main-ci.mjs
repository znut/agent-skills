/**
 * main-ci — the tick of the post-merge CI driver; design in README.md here.
 *
 * CLI: `bun tools/main-ci/main-ci.mjs <configName> [--rerun]` — one tick,
 * run by launchd on a StartInterval. Reads the config's `mainCi` block.
 * --rerun starts a fresh run on the current tip even when it has not moved.
 */
import { spawn, spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { loadConfig, varDir } from "../lib/config.mjs"
import { expandHome, writeAtomic } from "../lib/fs-util.mjs"

const KILL_GRACE_MS = 10_000
const DEFAULT_SKIP = "^docs/|\\.md$"

export function settings(config) {
	const mc = config.mainCi
	if (!mc?.repo || !Array.isArray(mc.core) || mc.core.length === 0) {
		throw new Error(`config ${config.name} needs mainCi.repo and a non-empty mainCi.core`)
	}
	const repo = expandHome(mc.repo)
	const worktree = mc.worktree ? expandHome(mc.worktree) : join(dirname(repo), `${basename(repo)}-worktrees`, "origin-main")
	const dir = join(varDir(config.name), "main-ci")
	return {
		mc,
		repo,
		worktree,
		dir,
		logFile: join(dir, "run.log"),
		stateFile: join(dir, "state.json"),
		runFile: join(dir, "run.json"),
		stepTimeoutMs: (mc.stepTimeout ?? 1800) * 1000,
		env: { ...process.env, ...(mc.env ?? {}), MAIN_CI_VAR: dir, MAIN_CI_WORKTREE: worktree },
	}
}

export function log(s, line) {
	mkdirSync(s.dir, { recursive: true })
	appendFileSync(s.logFile, `${new Date().toISOString()} ${line}\n`)
}

export function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"))
	} catch {
		return null
	}
}

function git(s, cwd, args) {
	const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: s.env, stdio: ["ignore", "pipe", "pipe"] })
	if (r.error) return { ok: false, out: "", err: r.error.message, code: 127 }
	return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim(), code: r.status }
}

function mustGit(s, cwd, args) {
	const r = git(s, cwd, args)
	if (!r.ok) throw new Error(`git ${args.join(" ")} FAILED exit=${r.code}: ${reason({ stderr: r.err })}`)
	return r.out
}

function defaultBranch(s) {
	if (s.mc.branch) return s.mc.branch
	const r = git(s, s.repo, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"])
	return r.ok && r.out ? r.out.replace(/^origin\//, "") : "main"
}

function alive(pgid) {
	try {
		process.kill(-pgid, 0)
		return true
	} catch (e) {
		return e.code === "EPERM"
	}
}

function signalAll(pgids, sig) {
	for (const pgid of pgids) {
		try {
			process.kill(-pgid, sig)
		} catch {}
	}
}

// Every job the runner started is its own process group, listed in run.json;
// the runner's group is listed first. Group kills reach grandchildren too.
async function cancel(s, run) {
	const pgids = [run.runnerPid, ...(run.jobs ?? [])].filter((p) => Number.isInteger(p) && p > 1 && alive(p))
	if (pgids.length === 0) return
	signalAll(pgids, "SIGTERM")
	const until = Date.now() + KILL_GRACE_MS
	while (Date.now() < until && pgids.some(alive)) await Bun.sleep(200)
	const stubborn = pgids.filter(alive)
	signalAll(stubborn, "SIGKILL")
	log(s, `cancel run sha=${run.sha} groups=${pgids.join(",")}${stubborn.length ? ` sigkill=${stubborn.join(",")}` : ""}`)
	const state = readJson(s.stateFile)
	if (state?.sha === run.sha && state.phase !== "done") writeAtomic(s.stateFile, `${JSON.stringify({ ...state, phase: "cancelled" })}\n`)
}

function moveWorktree(s, sha) {
	if (!existsSync(s.worktree)) {
		// --lock: repo cleanup scripts reap unlocked worktrees.
		mustGit(s, s.repo, ["worktree", "add", "--detach", "--lock", "--reason", "main-ci", s.worktree, sha])
	}
	mustGit(s, s.worktree, ["checkout", "-q", "--detach", "-f", sha])
	mustGit(s, s.worktree, ["reset", "-q", "--hard", sha])
	mustGit(s, s.worktree, ["clean", "-q", "-fd", "-e", "node_modules"])
}

// A failed child's first stderr line names the cause; the stack follows it.
function reason(r) {
	return r.error?.message ?? (r.stderr ?? "").split("\n").find((l) => l.trim()) ?? "no stderr"
}

// Bounded repo-supplied command in the worktree; its outcome is logged.
export function runCommand(s, label, cmd, timeoutMs) {
	const r = spawnSync("bash", ["-c", cmd], { cwd: s.worktree, env: s.env, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] })
	const code = r.error ? 127 : (r.status ?? 128)
	log(s, `${label}: ${code === 0 ? "ok" : `FAIL exit=${code} — ${reason(r)}`}`)
	return code === 0
}

// Every change since the last green run matches skipPattern: nothing the
// suite could newly prove.
function skippable(s, sha) {
	const state = readJson(s.stateFile)
	if (!state?.green || state.phase !== "done" || !state.sha || state.sha === sha) return null
	const diff = git(s, s.repo, ["diff", "--name-only", `${state.sha}..${sha}`])
	if (!diff.ok) return null
	const skip = new RegExp(s.mc.skipPattern ?? DEFAULT_SKIP)
	return diff.out.split("\n").every((f) => f === "" || skip.test(f)) ? state.sha : null
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
// paths cannot end the tick.
function boardSnapshot(config, s) {
	if (!config.board) return
	const stamp = eventsStamp(config)
	const stampFile = join(s.dir, ".events-stamp")
	if (stamp === null || (existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp)) return
	const script = new URL("../board-snapshot/board-snapshot.mjs", import.meta.url).pathname
	const r = spawnSync(process.execPath, [script, config.name, "--force"], { env: s.env, encoding: "utf8", timeout: 120_000 })
	writeFileSync(stampFile, stamp)
	if (r.status !== 0) log(s, `board-snapshot: FAIL exit=${r.status ?? 128} — ${reason(r)}`)
}

function startRunner(config, s, sha) {
	const runDir = join(s.dir, "runs", `${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}-${sha.slice(0, 8)}`)
	mkdirSync(runDir, { recursive: true })
	const out = openSync(join(runDir, "runner.log"), "a")
	const script = new URL("./run.mjs", import.meta.url).pathname
	const child = spawn(process.execPath, [script, config.name, sha, runDir], { detached: true, stdio: ["ignore", out, out], env: s.env })
	child.unref()
	writeAtomic(s.runFile, `${JSON.stringify({ sha, runDir, runnerPid: child.pid, jobs: [], startedAt: new Date().toISOString() })}\n`)
	log(s, `run start sha=${sha} runner=${child.pid} dir=${runDir}`)
}

async function tick(config, rerun) {
	const s = settings(config)
	mkdirSync(s.dir, { recursive: true })
	const lock = join(s.dir, ".tick.lock")
	const holder = Number(existsSync(lock) ? readFileSync(lock, "utf8") : 0)
	if (holder > 1 && holder !== process.pid && alive(holder)) return
	writeFileSync(lock, String(process.pid))
	try {
		boardSnapshot(config, s)

		const branch = defaultBranch(s)
		mustGit(s, s.repo, ["fetch", "-q", "origin"])
		const tip = mustGit(s, s.repo, ["rev-parse", `refs/remotes/origin/${branch}^{commit}`])
		const run = readJson(s.runFile)
		if (run?.sha === tip && !rerun) return

		log(s, `${rerun ? "rerun" : "tip moved"} ${run?.sha?.slice(0, 8) ?? "none"} -> ${tip.slice(0, 8)} (origin/${branch})`)
		if (run) await cancel(s, run)
		moveWorktree(s, tip)
		if (s.mc.cleanup) runCommand(s, "cleanup", s.mc.cleanup, s.stepTimeoutMs)

		const prev = rerun ? null : skippable(s, tip)
		if (prev) {
			const at = new Date().toISOString().replace(/\.\d+Z$/, "Z")
			const steps = { skipped: `skip-pattern-only since ${prev.slice(0, 8)}`, _: "end" }
			writeAtomic(s.stateFile, `${JSON.stringify({ sha: tip, finishedAt: at, green: true, failing: [], phase: "done", steps })}\n`)
			writeAtomic(s.runFile, `${JSON.stringify({ sha: tip, jobs: [], skipped: prev })}\n`)
			log(s, `run skipped sha=${tip} (skip-pattern-only since ${prev.slice(0, 8)})`)
			return
		}
		startRunner(config, s, tip)
	} finally {
		rmSync(lock, { force: true })
	}
}

if (import.meta.main) {
	const name = process.argv[2]
	if (!name) {
		console.error("usage: bun tools/main-ci/main-ci.mjs <configName> [--rerun]")
		process.exit(1)
	}
	const config = loadConfig(name)
	try {
		await tick(config, process.argv.includes("--rerun"))
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		try {
			log(settings(config), `tick FAILED: ${msg}`)
		} catch {}
		console.error(`main-ci[${name}]: ${msg}`)
		process.exit(1)
	}
}
