/**
 * main-ci jobs — repo commands as process groups that one cancel ends
 * together. A run (run.mjs) holds one set; each preview (preview.mjs) holds
 * its own, so a PR head move cancels that PR's preview alone.
 */
import { spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"

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
	// the spawn, so no cancel can run between the two.
	function exec(label, cmd, { cwd, env, file, timeoutMs = s.stepTimeoutMs }) {
		if (cancelled) return Promise.reject(CANCELLED)
		return new Promise((resolve, reject) => {
			const fd = openSync(file, "w")
			const child = spawn("nice", ["-n", "19", "bash", "-c", cmd], { cwd, env, detached: true, stdio: ["ignore", fd, fd] })
			closeSync(fd)
			if (child.pid) groups.add(child.pid)
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
