/**
 * main-ci jobs — repo commands as process groups that one cancel ends
 * together. A run (run.mjs) holds one set; each preview (preview.mjs) holds
 * its own, so a PR head move cancels that PR's preview alone.
 */
import { spawn } from "node:child_process"
import { closeSync, openSync, rmSync } from "node:fs"
import { load1, timeArgs, treeSampler, writeRow } from "./metrics.mjs"

export const CANCELLED = Symbol("cancelled")
const KILL_GRACE_MS = 10_000

export function signal(pgid, sig) {
	try {
		process.kill(-pgid, sig)
	} catch {}
}

function alive(pgid) {
	try {
		process.kill(-pgid, 0)
		return true
	} catch (e) {
		return e.code === "EPERM"
	}
}

export function jobSet(s) {
	const groups = new Set()
	let cancelled = false

	// `nice -n 19 bash -c <cmd>` with stdout and stderr in `file`; resolves
	// the exit code. The group is recorded in the same synchronous turn as
	// the spawn, so no cancel can run between the two. With `metrics` the
	// command runs under `time -l` (report in a side file) and a row is logged.
	function exec(label, cmd, { cwd, env, file, timeoutMs = s.stepTimeoutMs, metrics }) {
		if (cancelled) return Promise.reject(CANCELLED)
		return new Promise((resolve, reject) => {
			const fd = openSync(file, "w")
			const timeFile = `${file}.time`
			const startMs = Date.now()
			const load1Start = load1()
			const child = spawn("nice", ["-n", "19", ...(metrics ? timeArgs(timeFile) : []), "bash", "-c", cmd], { cwd, env, detached: true, stdio: ["ignore", fd, fd] })
			closeSync(fd)
			if (child.pid) groups.add(child.pid)
			let sampler = null
			if (metrics?.kind === "browser" && child.pid) {
				try {
					sampler = treeSampler(child.pid, s.mc.metrics?.treeProcessNames, s.log)
				} catch (e) {
					s.log(`metrics: ${metrics.job}: sampler not started (${e.message})`)
				}
			}
			let timedOut = false
			let over = false
			const timer = setTimeout(() => {
				timedOut = true
				signal(child.pid, "SIGKILL")
			}, timeoutMs)
			const done = (code, why) => {
				if (over) return
				over = true
				clearTimeout(timer)
				// The leader exited; whatever it left in its group goes with it.
				if (child.pid) signal(child.pid, "SIGKILL")
				groups.delete(child.pid)
				if (metrics) {
					try {
						const tree = sampler?.stop() ?? null
						if (!cancelled) writeRow(s, metrics, { startMs, logFile: file, code: code ?? 128, load1: load1Start, timeFile, tree })
						rmSync(timeFile, { force: true })
					} catch (e) {
						s.log(`metrics: ${metrics.job}: ${e.message}`)
					}
				}
				if (cancelled) return reject(CANCELLED)
				if (why) s.log(`${label}: ${why}`)
				resolve(code)
			}
			child.on("error", (e) => done(127, `cannot start: ${e.message}`))
			child.on("exit", (code, sig) => done(code ?? 128, timedOut ? `killed after ${timeoutMs / 1000}s timeout` : sig ? `ended by ${sig}` : ""))
		})
	}

	// SIGTERM every live group, then SIGKILL whatever outlives the grace period.
	async function cancel() {
		cancelled = true
		const live = [...groups]
		for (const g of live) signal(g, "SIGTERM")
		const until = Date.now() + KILL_GRACE_MS
		while (Date.now() < until && live.some(alive)) await Bun.sleep(200)
		const stubborn = live.filter(alive)
		for (const g of stubborn) signal(g, "SIGKILL")
		return { live, stubborn }
	}

	// Synchronous, for the driver's exit handler.
	function kill() {
		cancelled = true
		for (const g of groups) signal(g, "SIGKILL")
	}

	return { exec, cancel, kill, isCancelled: () => cancelled }
}
