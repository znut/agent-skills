/**
 * main-ci runner — one run on one sha, started detached by main-ci.mjs.
 *
 * CLI (internal): `bun tools/main-ci/run.mjs <configName> <sha> <runDir>`.
 * Runs mainCi.core in order; on green, the warmCache command, then the
 * mainCi.builds lanes, at most buildConcurrency at once. Each step runs in
 * its own process group, listed in run.json so the tick can cancel it.
 */
import { spawn } from "node:child_process"
import { copyFileSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../lib/config.mjs"
import { writeAtomic } from "../lib/fs-util.mjs"
import { log, readJson, runCommand, settings } from "./main-ci.mjs"

const KEEP_RUNS = 20

const [name, sha, runDir] = process.argv.slice(2)
if (!name || !sha || !runDir) {
	console.error("usage: bun tools/main-ci/run.mjs <configName> <sha> <runDir>")
	process.exit(1)
}
const s = settings(loadConfig(name))
s.env.MAIN_CI_SHA = sha
const steps = {}
const failing = []
let green = true

function updateRun(fn) {
	const run = readJson(s.runFile)
	if (run?.sha !== sha || run.runDir !== runDir) return
	fn(run)
	writeAtomic(s.runFile, `${JSON.stringify(run)}\n`)
}

function writeState(phase) {
	const finishedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z")
	writeAtomic(s.stateFile, `${JSON.stringify({ sha, finishedAt, green, failing, phase, steps: { ...steps, _: "end" } })}\n`)
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

function attempt(step, file) {
	return new Promise((resolve) => {
		const fd = openSync(file, "w")
		const child = spawn("nice", ["-n", "19", "bash", "-c", step.cmd], { cwd: s.worktree, env: s.env, detached: true, stdio: ["ignore", fd, fd] })
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			try {
				process.kill(-child.pid, "SIGKILL")
			} catch {}
		}, s.stepTimeoutMs)
		if (child.pid) updateRun((run) => run.jobs.push(child.pid))
		const done = (code, why) => {
			clearTimeout(timer)
			if (child.pid) updateRun((run) => (run.jobs = run.jobs.filter((p) => p !== child.pid)))
			if (why) log(s, `${step.name}: ${why}`)
			resolve(code)
		}
		child.on("error", (e) => done(127, `cannot start: ${e.message}`))
		child.on("exit", (code, signal) => done(code ?? 128, timedOut ? `killed after ${s.stepTimeoutMs / 1000}s timeout` : signal ? `ended by ${signal}` : ""))
	})
}

// A failed step is retried once; only the final attempt's failing tests count.
async function runStep(step) {
	const file = join(runDir, `step-${step.name}.log`)
	let code = await attempt(step, file)
	if (code === 0) {
		steps[step.name] = "ok"
		log(s, `${step.name}: ok`)
		return true
	}
	for (const f of failLines(file)) log(s, `${step.name}: FAIL ${f}`)
	log(s, `${step.name}: fail exit=${code} — retrying once`)
	copyFileSync(file, join(runDir, `step-${step.name}.attempt1.log`))
	code = await attempt(step, file)
	if (code === 0) {
		steps[step.name] = "ok(retry)"
		log(s, `${step.name}: ok on retry`)
		return true
	}
	for (const f of failLines(file)) {
		log(s, `${step.name}: FAIL ${f}`)
		failing.push(`${step.name}: ${f}`)
	}
	steps[step.name] = "FAIL"
	green = false
	const last = readFileSync(file, "utf8").trim().split("\n").pop()
	log(s, `${step.name}: FAIL exit=${code} (retried)${last ? ` — ${last}` : ""}`)
	return false
}

// A lane's steps run in order; one failure skips the rest of that lane.
async function runLane(lane) {
	for (const [i, step] of lane.entries()) {
		if (await runStep(step)) {
			writeState("builds")
			continue
		}
		for (const rest of lane.slice(i + 1)) steps[rest.name] = "skipped"
		writeState("builds")
		return
	}
}

function prune() {
	const dirs = readdirSync(join(s.dir, "runs")).sort()
	for (const old of dirs.slice(0, Math.max(0, dirs.length - KEEP_RUNS))) rmSync(join(s.dir, "runs", old), { recursive: true, force: true })
}

async function main() {
	prune()
	log(s, `core start sha=${sha}`)
	for (const step of s.mc.core) await runStep(step)
	const lanes = s.mc.builds ?? []
	for (const lane of green ? lanes : []) for (const step of lane) steps[step.name] = "pending"
	writeState(green && lanes.length > 0 ? "builds" : "done")
	if (green && s.mc.warmCache) runCommand(s, "warm-cache", s.mc.warmCache, s.stepTimeoutMs)
	if (green && lanes.length > 0) {
		const queue = [...lanes]
		const cap = Math.max(1, s.mc.buildConcurrency ?? 1)
		await Promise.all(
			Array.from({ length: Math.min(cap, queue.length) }, async () => {
				while (queue.length > 0) await runLane(queue.shift())
			}),
		)
		writeState("done")
	}
	updateRun((run) => (run.finishedAt = new Date().toISOString()))
	log(s, `run ${green ? "green" : "RED"} sha=${sha}`)
}

try {
	await main()
} catch (e) {
	log(s, `runner FAILED sha=${sha}: ${e instanceof Error ? e.message : e}`)
	process.exit(1)
}
