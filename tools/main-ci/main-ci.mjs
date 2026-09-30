/**
 * main-ci — the tick of the post-merge CI driver; design in README.md here.
 *
 * CLI: `bun tools/main-ci/main-ci.mjs <configName> [--rerun]` — one tick,
 * run by launchd on a StartInterval. Reads the config's `mainCi` block.
 * --rerun starts a fresh run on the current tip even when it has not moved.
 */
import { spawn, spawnSync } from "node:child_process"
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { loadConfig, varDir } from "../lib/config.mjs"
import { expandHome, writeAtomic } from "../lib/fs-util.mjs"

const KILL_GRACE_MS = 10_000

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

function signal(pgid, sig) {
	try {
		process.kill(-pgid, sig)
	} catch {}
}

// SIGTERM, then SIGKILL whatever outlives the grace period.
async function stop(pgids) {
	const live = pgids.filter((p) => Number.isInteger(p) && p > 1 && alive(p))
	for (const p of live) signal(p, "SIGTERM")
	const until = Date.now() + KILL_GRACE_MS
	while (Date.now() < until && live.some(alive)) await Bun.sleep(200)
	const stubborn = live.filter(alive)
	for (const p of stubborn) signal(p, "SIGKILL")
	return { live, stubborn }
}

// The runner goes first so it starts no new job; then run.json, re-read,
// lists every job group it left. A finished run's pids may be reused.
async function cancel(s, run) {
	if (run.finishedAt) return
	const runner = await stop([run.runnerPid])
	const after = readJson(s.runFile) ?? run
	const jobs = await stop(after.jobs ?? [])
	writeAtomic(s.runFile, `${JSON.stringify({ ...after, jobs: [], finishedAt: new Date().toISOString() })}\n`)
	const live = [...runner.live, ...jobs.live]
	const stubborn = [...runner.stubborn, ...jobs.stubborn]
	if (live.length > 0) log(s, `cancel run sha=${run.sha} groups=${live.join(",")}${stubborn.length ? ` sigkill=${stubborn.join(",")}` : ""}`)
	const state = readJson(s.stateFile)
	if (state?.sha === run.sha && state.phase !== "done") writeAtomic(s.stateFile, `${JSON.stringify({ ...state, phase: "cancelled" })}\n`)
}

function moveWorktree(s, sha) {
	if (!existsSync(s.worktree)) {
		// --lock: repo cleanup scripts reap unlocked worktrees.
		mustGit(s, s.repo, ["worktree", "add", "--detach", "--lock", "--reason", "main-ci", s.worktree, sha])
	}
	mustGit(s, s.worktree, ["checkout", "-q", "--detach", "-f", sha])
	mustGit(s, s.worktree, ["clean", "-q", "-fd", "-e", "node_modules"])
}

// A failed child's first stderr line names the cause; the stack follows it.
function reason(r) {
	return r.error?.message ?? (r.stderr ?? "").split("\n").find((l) => l.trim()) ?? "no stderr"
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

// run.json exists before the runner starts; from then on the runner is its
// only writer until the next cancel.
function startRunner(config, s, sha, rerun) {
	const runDir = join(s.dir, "runs", `${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}-${sha.slice(0, 8)}`)
	mkdirSync(runDir, { recursive: true })
	writeAtomic(s.runFile, `${JSON.stringify({ sha, runDir, jobs: [], startedAt: new Date().toISOString() })}\n`)
	const out = openSync(join(runDir, "runner.log"), "a")
	const script = new URL("./run.mjs", import.meta.url).pathname
	const args = [script, config.name, sha, runDir, ...(rerun ? ["--rerun"] : [])]
	const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", out, out], env: s.env })
	closeSync(out)
	child.unref()
	log(s, `run start sha=${sha} runner=${child.pid} dir=${runDir}`)
}

// O_EXCL create; a lock whose holder pid is gone is stale.
function takeLock(lock) {
	for (let i = 0; i < 2; i++) {
		try {
			writeFileSync(lock, String(process.pid), { flag: "wx" })
			return true
		} catch {
			try {
				process.kill(Number(readFileSync(lock, "utf8")), 0)
				return false
			} catch {
				rmSync(lock, { force: true })
			}
		}
	}
	return false
}

async function tick(config, rerun) {
	const s = settings(config)
	mkdirSync(s.dir, { recursive: true })
	const lock = join(s.dir, ".tick.lock")
	if (!takeLock(lock)) return
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
		startRunner(config, s, tip, rerun)
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
