import { describe, expect, it } from "bun:test"
import { attribute, parseTime, turboCounts } from "./metrics.mjs"

const REPORT = `        1.50 real         0.80 user         0.20 sys
          52428800  maximum resident set size
                 0  average shared memory size
`

describe("parseTime", () => {
	it("reads seconds and converts peak RSS bytes to MB", () => {
		expect(parseTime(REPORT)).toEqual({ wall_s: 1.5, cpu_user_s: 0.8, cpu_sys_s: 0.2, max_rss_mb: 50 })
	})
	it("returns null for text without a report", () => {
		expect(parseTime("bash: boom")).toBeNull()
	})
})

describe("turboCounts", () => {
	it("counts hits and misses from per-task cache status", () => {
		const summary = { execution: { attempted: 3, cached: 2 }, tasks: [{ cache: { status: "HIT" } }, { cache: { status: "HIT" } }, { cache: { status: "MISS" } }] }
		expect(turboCounts(summary)).toEqual({ tasks: 3, hit: 2, miss: 1 })
	})
	it("returns null for a malformed summary", () => {
		expect(turboCounts({})).toBeNull()
	})
})

describe("attribute", () => {
	it("sums descendants and launchd services of host processes, in MB", () => {
		const rows = [
			{ pid: 1, ppid: 0, rss: 1024, exe: "/bin/bun" },
			{ pid: 2, ppid: 1, rss: 2048, exe: "/x/node" },
			{ pid: 9, ppid: 1000, rss: 4096, exe: "/x/WebKit.xpc/Contents/MacOS/Web" },
			{ pid: 7, ppid: 1000, rss: 8192, exe: "/other" },
		]
		expect(attribute(rows, new Set([1]), ["/bin/bun"], (p) => (p === 1 ? [9] : []))).toBe(7)
	})
})
