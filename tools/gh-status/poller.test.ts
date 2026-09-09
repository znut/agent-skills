import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PRUNE_AFTER_MS, pruneOld } from "./poller.ts"

const DAY_MS = 24 * 60 * 60 * 1000
const OLD = new Date(Date.now() - PRUNE_AFTER_MS - DAY_MS).toISOString()
const RECENT = new Date(Date.now() - DAY_MS).toISOString()

function dirs() {
	const root = mkdtempSync(join(tmpdir(), "poller-prune-"))
	const statusDir = join(root, "status")
	const eventsDir = join(root, "events")
	mkdirSync(statusDir)
	mkdirSync(eventsDir)
	return { statusDir, eventsDir }
}

function pr(statusDir: string, eventsDir: string, n: number, snap: Record<string, unknown>) {
	writeFileSync(join(statusDir, `pr-${n}.json`), JSON.stringify({ number: n, ...snap }))
	writeFileSync(join(eventsDir, `pr-${n}.log`), "{}\n")
	writeFileSync(join(eventsDir, `pr-${n}.merged`), "x")
	writeFileSync(join(eventsDir, `pr-${n}.comments.json`), "[]")
}

describe("pruneOld", () => {
	it("removes every file of a PR merged or closed past the cutoff and outside the window", async () => {
		const { statusDir, eventsDir } = dirs()
		pr(statusDir, eventsDir, 1, { state: "MERGED", mergedAt: OLD, updatedAt: OLD })
		pr(statusDir, eventsDir, 2, { state: "CLOSED", mergedAt: null, updatedAt: OLD })
		pr(statusDir, eventsDir, 10, { state: "MERGED", mergedAt: RECENT, updatedAt: RECENT })
		await pruneOld(statusDir, eventsDir, new Set())
		for (const n of [1, 2]) {
			expect(existsSync(join(statusDir, `pr-${n}.json`))).toBe(false)
			for (const suffix of ["log", "merged", "comments.json"]) expect(existsSync(join(eventsDir, `pr-${n}.${suffix}`))).toBe(false)
		}
		// pr-1 must not take pr-10 with it
		expect(existsSync(join(statusDir, "pr-10.json"))).toBe(true)
		expect(existsSync(join(eventsDir, "pr-10.log"))).toBe(true)
	})

	it("keeps open PRs, PRs in the window, and unreadable snapshots", async () => {
		const { statusDir, eventsDir } = dirs()
		pr(statusDir, eventsDir, 3, { state: "OPEN", mergedAt: null, updatedAt: OLD })
		pr(statusDir, eventsDir, 4, { state: "MERGED", mergedAt: OLD, updatedAt: OLD })
		writeFileSync(join(statusDir, "pr-5.json"), "not json")
		writeFileSync(join(eventsDir, "pr-5.log"), "{}\n")
		writeFileSync(join(statusDir, "state.json"), "{}")
		await pruneOld(statusDir, eventsDir, new Set([4]))
		for (const n of [3, 4, 5]) expect(existsSync(join(statusDir, `pr-${n}.json`))).toBe(true)
		expect(existsSync(join(eventsDir, "pr-5.log"))).toBe(true)
		expect(existsSync(join(statusDir, "state.json"))).toBe(true)
	})

	it("removes issue files whose log has been idle past the cutoff", async () => {
		const { statusDir, eventsDir } = dirs()
		for (const n of [7, 8]) {
			writeFileSync(join(eventsDir, `issue-${n}.log`), "{}\n")
			writeFileSync(join(eventsDir, `issue-${n}.comments.json`), "[]")
		}
		const past = (Date.now() - PRUNE_AFTER_MS - DAY_MS) / 1000
		utimesSync(join(eventsDir, "issue-7.log"), past, past)
		await pruneOld(statusDir, eventsDir, new Set())
		expect(existsSync(join(eventsDir, "issue-7.log"))).toBe(false)
		expect(existsSync(join(eventsDir, "issue-7.comments.json"))).toBe(false)
		expect(existsSync(join(eventsDir, "issue-8.log"))).toBe(true)
		expect(existsSync(join(eventsDir, "issue-8.comments.json"))).toBe(true)
	})
})
