/**
 * main-ci metrics — one metrics.jsonl row per job attempt: `/usr/bin/time -l`
 * numbers, turbo cache counts, and for browser jobs a whole-tree RSS peak.
 * Nothing here may fail or slow a job: every error becomes nulls + a warning.
 */
import { execFile } from "node:child_process"
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { loadavg } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)
const TIME = "/usr/bin/time"
const SAMPLE_MS = 1000
// Browser helpers macOS starts through launchd instead of as children.
const HOST_PATTERNS = [".app/Contents/MacOS/", ".xpc/Contents/MacOS/", "/bin/bun"]

export const timeArgs = (timeFile) => (existsSync(TIME) ? [TIME, "-l", "-o", timeFile] : [])

/** Parses the `time -l` report: real, user, sys seconds and peak RSS (bytes on macOS). */
export function parseTime(text) {
	const m = text.match(/([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/)
	const rss = text.match(/^\s*(\d+)\s+maximum resident set size/m)
	if (!m || !rss) return null
	return { wall_s: +m[1], cpu_user_s: +m[2], cpu_sys_s: +m[3], max_rss_mb: +(+rss[1] / 1048576).toFixed(1) }
}

/** Counts tasks in a turbo run summary; null when it has no usable shape. */
export function turboCounts(summary) {
	const tasks = summary?.tasks
	if (!Array.isArray(tasks) || !summary.execution) return null
	const status = (t) => t.cache?.status
	return { tasks: summary.execution.attempted ?? tasks.length, hit: tasks.filter((t) => status(t) === "HIT").length, miss: tasks.filter((t) => status(t) === "MISS").length }
}

/** Newest `.turbo/runs/*.json` in `cwd` written at or after `sinceMs`. */
export function turboSince(cwd, sinceMs) {
	const dir = join(cwd, ".turbo", "runs")
	if (!existsSync(dir)) return null
	let best = null
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json")) continue
		const m = statSync(join(dir, f)).mtimeMs
		if (m >= sinceMs && (!best || m > best.m)) best = { f, m }
	}
	return best ? turboCounts(JSON.parse(readFileSync(join(dir, best.f), "utf8"))) : null
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
		const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/)
		return m ? [{ pid: +m[1], ppid: +m[2], rss: +m[3], exe: m[4] }] : []
	})
}

/** Samples the tree under `pid` every second; stop() returns the peak in MB (null if never sampled). */
export function treeSampler(pid, hostPatterns = HOST_PATTERNS, warn = () => {}) {
	const known = new Set([pid])
	const services = new Map() // host pid -> its launchd service pids, read once
	let peak = null
	let busy = false
	const tick = async () => {
		if (busy) return
		busy = true
		try {
			const rows = await psRows()
			for (const r of rows) {
				if (!known.has(r.pid) || services.has(r.pid) || !hostPatterns.some((p) => r.exe.includes(p))) continue
				const out = await run("launchctl", ["print", `pid/${r.pid}`]).then((x) => x.stdout, () => "")
				services.set(r.pid, [...out.matchAll(/^\s+(\d+)\s+-\s+\S+/gm)].map((m) => +m[1]).filter(Boolean))
			}
			const mb = attribute(rows, known, hostPatterns, (p) => services.get(p) ?? [])
			peak = Math.max(peak ?? 0, mb)
		} catch (e) {
			warn(`sampler: ${e.message}`)
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
		row.turbo = turboSince(r.cwd, r.startMs)
	} catch (e) {
		s.log(`metrics: ${meta.job}: turbo summary unreadable (${e.message})`)
	}
	try {
		appendFileSync(join(s.dir, "metrics.jsonl"), `${JSON.stringify(row)}\n`)
	} catch (e) {
		s.log(`metrics: ${meta.job}: row not written (${e.message})`)
	}
}

export const load1 = () => loadavg()[0]
