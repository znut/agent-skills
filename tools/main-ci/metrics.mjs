/**
 * main-ci metrics — one metrics.jsonl row per job attempt: `/usr/bin/time -l`
 * numbers, turbo cache counts, and for browser jobs a whole-tree RSS peak.
 * Nothing here may fail or slow a job: every error becomes nulls + a warning.
 */
import { execFile } from "node:child_process"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { loadavg } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)
const TIME = "/usr/bin/time"
const SAMPLE_MS = 1000
// Browser helpers macOS starts through launchd instead of as children.
const HOST_PATTERNS = [".app/Contents/MacOS/", ".xpc/Contents/MacOS/", "/bin/bun"]

export const timeArgs = (timeFile) => (process.platform === "darwin" && existsSync(TIME) ? [TIME, "-l", "-o", timeFile] : [])

/** Parses the `time -l` report: real, user, sys seconds and peak RSS (bytes on macOS). */
export function parseTime(text) {
	const m = text.match(/([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/)
	const rss = text.match(/^\s*(\d+)\s+maximum resident set size/m)
	if (!m || !rss) return null
	return { wall_s: +m[1], cpu_user_s: +m[2], cpu_sys_s: +m[3], max_rss_mb: +(+rss[1] / 1048576).toFixed(1) }
}

/** Last turbo footer (`Tasks:` / `Cached:` lines) in a step log; null when absent. */
export function turboFooter(log) {
	let total = null
	let cached = null
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
	for (const raw of log.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
		const t = raw.match(/^\s*Tasks:\s+\d+ successful, (\d+) total/)
		if (t) total = +t[1]
		const c = raw.match(/^\s*Cached:\s+(\d+) cached, \d+ total/)
		if (c) cached = +c[1]
	}
	return total === null || cached === null ? null : { tasks: total, hit: cached, miss: total - cached }
}

/** Service pids in `launchctl print pid/N` text (rows: pid, status or `-`, label). */
export function launchctlServices(text) {
	return [...text.matchAll(/^\s+(\d+)\s+(?:\(\w+\)|-)\s+\S+/gm)].map((m) => +m[1]).filter(Boolean)
}

/** Pids in `known`'s process tree, plus launchd services of host processes. */
export function attribute(rows, known, hostPatterns, servicesOf) {
	for (let pass = 0; pass < 20; pass++) {
		const before = known.size
		for (const r of rows) if (known.has(r.ppid)) known.add(r.pid)
		if (known.size === before) break
	}
	for (const r of rows) {
		if (known.has(r.pid) && hostPatterns.some((p) => r.exe.includes(p))) for (const pid of servicesOf(r.pid)) known.add(pid)
	}
	return rows.reduce((sum, r) => sum + (known.has(r.pid) ? r.rss : 0), 0) / 1024
}

async function psRows() {
	const { stdout } = await run("ps", ["-Ao", "pid=,ppid=,rss=,command="], { maxBuffer: 64 << 20 })
	return stdout.split("\n").flatMap((l) => {
		const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)/)
		return m ? [{ pid: +m[1], ppid: +m[2], rss: +m[3], exe: m[4] }] : []
	})
}

/** Samples the tree under `pid` every second; stop() returns the peak in MB (null if never sampled). */
export function treeSampler(pid, names, warn = () => {}) {
	const hostPatterns = [].concat(names ?? HOST_PATTERNS)
	const known = new Set([pid])
	const services = new Map() // host pid -> { list, at } of launchd service pids
	let peak = null
	let busy = false
	let warned = false
	let n = 0
	const tick = async () => {
		if (busy) return
		busy = true
		n++
		try {
			const rows = await psRows()
			for (const r of rows) {
				if (!known.has(r.pid) || !hostPatterns.some((p) => r.exe.includes(p))) continue
				const seen = services.get(r.pid)
				// Helpers start late: re-read while empty, else every 5th tick.
				if (seen && seen.list.length > 0 && n - seen.at < 5) continue
				const out = await run("launchctl", ["print", `pid/${r.pid}`]).then((x) => x.stdout, () => "")
				services.set(r.pid, { list: launchctlServices(out), at: n })
			}
			const mb = attribute(rows, known, hostPatterns, (p) => services.get(p)?.list ?? [])
			peak = Math.max(peak ?? 0, mb)
		} catch (e) {
			if (!warned) warn(`metrics: sampler: ${e.message}`)
			warned = true
		} finally {
			busy = false
		}
	}
	tick()
	const timer = setInterval(tick, SAMPLE_MS)
	return { stop: () => (clearInterval(timer), peak === null ? null : +peak.toFixed(1)) }
}

/** Appends one row; `meta` = { job, kind, pr, attempt, run, sha }. Never throws. */
export function writeRow(s, meta, r) {
	const row = {
		run: meta.run, sha: meta.sha, job: meta.job, kind: meta.kind, pr: meta.pr ?? null, attempt: meta.attempt ?? 1,
		retried: (meta.attempt ?? 1) > 1, start: new Date(r.startMs).toISOString(), wall_s: null, cpu_user_s: null, cpu_sys_s: null,
		max_rss_mb: null, tree_peak_rss_mb: r.tree, exit: r.code, load1_start: r.load1, turbo: null,
	}
	try {
		Object.assign(row, parseTime(readFileSync(r.timeFile, "utf8")) ?? {})
	} catch (e) {
		s.log(`metrics: ${meta.job}: no time report (${e.code ?? e.message})`)
	}
	try {
		row.turbo = turboFooter(readFileSync(r.logFile, "utf8"))
	} catch (e) {
		s.log(`metrics: ${meta.job}: step log unreadable (${e.message})`)
	}
	try {
		appendFileSync(join(s.dir, "metrics.jsonl"), `${JSON.stringify(row)}\n`)
	} catch (e) {
		s.log(`metrics: ${meta.job}: row not written (${e.message})`)
	}
}

export const load1 = () => loadavg()[0]
