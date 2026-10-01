import { describe, expect, it } from "bun:test"
import { attribute, launchctlServices, parseTime, turboFooter } from "./metrics.mjs"

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

describe("turboFooter", () => {
	it("reads the last footer, ANSI stripped, and derives misses", () => {
		const log = "\x1b[1m Tasks:    1 successful, 2 total\x1b[0m\n Cached:    0 cached, 2 total\n Tasks:    3 successful, 4 total\n Cached:    3 cached, 4 total\n"
		expect(turboFooter(log)).toEqual({ tasks: 4, hit: 3, miss: 1 })
	})
	it("returns null without a footer", () => {
		expect(turboFooter("plain output")).toBeNull()
	})
})

describe("launchctlServices", () => {
	it("reads plain and flagged rows, skipping pid 0", () => {
		const text = "\tservices = {\n\t  1234  -  com.a.b\n\t  5678  (pe)  com.c.d\n\t  0  -  com.e.f\n\t}"
		expect(launchctlServices(text)).toEqual([1234, 5678])
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
