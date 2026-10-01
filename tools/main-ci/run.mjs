/**
 * main-ci run — one run on one sha, inside the driver process (main-ci.mjs).
 *
 * Runs the cleanup command, then mainCi.core in order; on green, the
 * warmCache command, then the mainCi.builds lanes (at most buildConcurrency
 * at once) alongside the preview gate (preview.mjs). Every command is its
 * own process group, held in memory so a cancel reaches it.
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { basename, join } from "node:path"
import { writeAtomic } from "../lib/fs-util.mjs"
import { CANCELLED, jobSet } from "./jobs.mjs"
import { startPreviews } from "./preview.mjs"

const KEEP_RUNS = 20
const DEFAULT_SKIP = "^docs/|\\.md$"

function readState(s) {
	try {
		return JSON.parse(readFileSync(s.stateFile, "utf8"))
	} catch {
		return null
	}
}

function lastLine(file) {
	return readFileSync(file, "utf8").trim().split("\n").pop() || "no output"
}

// `bunx turbo run <task>` prefixes each line with `<pkg>:<task>: `; keep pkg
// in front of the vitest FAIL line it carries.
function failLines(file) {
	const out = []
	for (const raw of readFileSync(file, "utf8").split("\n")) {
		// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
		const m = raw.replace(/\x1b\[[0-9;]*m/g, "").match(/^(?:([\w@/.-]+):[\w-]+: )?\s*FAIL\s+(\S.*)$/)
		if (m) out.push(`${m[1] ? `${m[1]} ` : ""}${m[2].replaceAll(" > ", " › ")}`)
	}
	return out
}

function prune(s) {
	const dirs = readdirSync(join(s.dir, "runs")).sort()
	for (const old of dirs.slice(0, Math.max(0, dirs.length - KEEP_RUNS))) rmSync(join(s.dir, "runs", old), { recursive: true, force: true })
}

/** Starts a run on `sha` in s.worktree; returns { sha, done, cancel, kill, scan }. */
export function startRun(s, sha) {
	const runDir = join(s.dir, "runs", `${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}-${sha.slice(0, 8)}`)
	mkdirSync(runDir, { recursive: true })
	const env = { ...s.env, MAIN_CI_SHA: sha }
	const jobs = jobSet(s)
	const previews = s.mc.preview ? startPreviews(s, sha, env, runDir) : null
	const steps = {}
	const failing = []
	let green = true

	function writeState(phase) {
		if (jobs.isCancelled()) return
		const finishedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z")
		writeAtomic(s.stateFile, `${JSON.stringify({ sha, finishedAt, green, failing, phase, steps: { ...steps, _: "end" } })}\n`)
	}

	const run = basename(runDir)
	const sampled = [].concat(s.mc.metrics?.treeSampleJobs ?? []).map((g) => new Bun.Glob(g))
	const kindOf = (step) => (laneNames.has(step.name) ? (sampled.some((g) => g.match(step.name)) ? "browser" : "build") : "core")
	const laneNames = new Set((s.mc.builds ?? []).flat().map((x) => x.name))
	const attempt = (step, file, n) => jobs.exec(step.name, step.cmd, { cwd: s.worktree, env, file, metrics: { run, sha, job: step.name, kind: kindOf(step), attempt: n } })

	// A failed step is retried once; only the final attempt's failing tests count.
	async function runStep(step) {
		const file = join(runDir, `step-${step.name}.log`)
		let code = await attempt(step, file, 1)
		if (code === 0) {
			steps[step.name] = "ok"
			s.log(`${step.name}: ok`)
			return true
		}
		for (const f of failLines(file)) s.log(`${step.name}: FAIL ${f}`)
		s.log(`${step.name}: fail exit=${code} — retrying once`)
		copyFileSync(file, join(runDir, `step-${step.name}.attempt1.log`))
		code = await attempt(step, file, 2)
		if (code === 0) {
			steps[step.name] = "ok(retry)"
			s.log(`${step.name}: ok on retry`)
			return true
		}
		for (const f of failLines(file)) {
			s.log(`${step.name}: FAIL ${f}`)
			failing.push(`${step.name}: ${f}`)
		}
		steps[step.name] = "FAIL"
		green = false
		s.log(`${step.name}: FAIL exit=${code} (retried) — ${lastLine(file)}`)
		return false
	}

	// A repo command outside the verdict (cleanup, warm cache): run once, logged.
	async function runCommand(label, cmd) {
		const file = join(runDir, `${label}.log`)
		const code = await jobs.exec(label, cmd, { cwd: s.worktree, env, file })
		s.log(`${label}: ${code === 0 ? "ok" : `FAIL exit=${code} — ${lastLine(file)}`}`)
	}

	// A lane's steps run in order; one failure skips the rest of that lane.
	async function runLane(lane) {
		for (const [i, step] of lane.entries()) {
			const ok = await runStep(step)
			if (!ok) for (const rest of lane.slice(i + 1)) steps[rest.name] = "skipped"
			writeState("builds")
			if (!ok) return
		}
	}

	// Every path changed since the last green, finished run matches
	// skipPattern: nothing the checks could newly prove.
	function skippedSince() {
		const state = readState(s)
		if (!state?.green || state.phase !== "done" || !state.sha || state.sha === sha) return null
		const r = spawnSync("git", ["-C", s.worktree, "diff", "--name-only", `${state.sha}..${sha}`], { encoding: "utf8", timeout: 60_000 })
		if (r.status !== 0) return null
		const skip = new RegExp(s.mc.skipPattern ?? DEFAULT_SKIP)
		return r.stdout.split("\n").every((f) => f === "" || skip.test(f)) ? state.sha : null
	}

	async function main() {
		prune(s)
		if (s.mc.cleanup) await runCommand("cleanup", s.mc.cleanup)
		const prev = skippedSince()
		if (prev) {
			steps.skipped = `skip-pattern-only since ${prev.slice(0, 8)}`
			writeState("done")
			s.log(`run skipped sha=${sha} (skip-pattern-only since ${prev.slice(0, 8)})`)
			previews?.start()
			return
		}
		s.log(`core start sha=${sha}`)
		for (const step of s.mc.core) await runStep(step)
		const lanes = s.mc.builds ?? []
		for (const lane of green ? lanes : []) for (const step of lane) steps[step.name] = "pending"
		writeState(green && lanes.length > 0 ? "builds" : "done")
		if (green && s.mc.warmCache) await runCommand("warm-cache", s.mc.warmCache)
		if (green) previews?.start()
		if (green && lanes.length > 0) {
			const queue = [...lanes]
			const cap = Math.max(1, s.mc.buildConcurrency ?? 1)
			const workers = Array.from({ length: Math.min(cap, queue.length) }, async () => {
				while (queue.length > 0) await runLane(queue.shift())
			})
			// Settle every lane first: a lane that throws must not end the run
			// while other lanes still have live groups.
			const failed = (await Promise.allSettled(workers)).find((r) => r.status === "rejected")
			if (failed) throw failed.reason
			writeState("done")
		}
		s.log(`run ${green ? "green" : "RED"} sha=${sha}`)
	}

	const done = main().catch((e) => {
		if (e === CANCELLED) return
		green = false
		steps.runner = "FAIL"
		writeState("done")
		s.log(`run FAILED sha=${sha}: ${e instanceof Error ? e.message : e}`)
	})

	// End every group, the previews' included, then wait for the run to unwind.
	async function cancel() {
		const ends = await Promise.all([jobs.cancel(), previews?.cancel() ?? { live: [], stubborn: [] }])
		await done
		const state = readState(s)
		if (state?.sha === sha && state.phase !== "done") writeAtomic(s.stateFile, `${JSON.stringify({ ...state, phase: "cancelled" })}\n`)
		return { live: ends.flatMap((e) => e.live), stubborn: ends.flatMap((e) => e.stubborn) }
	}

	// Synchronous, for the driver's exit handler.
	function kill() {
		jobs.kill()
		previews?.kill()
	}

	s.log(`run start sha=${sha} dir=${runDir}`)
	return { sha, done, cancel, kill, scan: () => previews?.scan() }
}
