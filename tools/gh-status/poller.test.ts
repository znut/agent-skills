import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type CiRun, ciTransitions, conflictTransition, PRUNE_AFTER_MS, pruneOld } from "./poller.ts"

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

describe("conflictTransition", () => {
	it("fires once when CONFLICTING follows MERGEABLE", () => {
		const first = conflictTransition("MERGEABLE", "CONFLICTING")
		expect(first).toEqual({ mergeable: "CONFLICTING", fire: true })
		expect(conflictTransition(first.mergeable, "CONFLICTING").fire).toBe(false)
	})

	it("UNKNOWN or any unrecognised value fires nothing and keeps the stored state", () => {
		expect(conflictTransition("CONFLICTING", "UNKNOWN")).toEqual({ mergeable: "CONFLICTING", fire: false })
		expect(conflictTransition("MERGEABLE", "UNKNOWN")).toEqual({ mergeable: "MERGEABLE", fire: false })
		// any other value is treated like UNKNOWN
		expect(conflictTransition("MERGEABLE", "SOMETHING_NEW" as "UNKNOWN")).toEqual({ mergeable: "MERGEABLE", fire: false })
	})
})

describe("ciTransitions", () => {
	const NOW = Date.parse("2026-10-15T12:00:00Z")
	const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
	const run = (id: number, status: string, createdMin: number, extra: Partial<CiRun> = {}): CiRun => ({ id, head_branch: "feat", name: "ci", status, conclusion: null, created_at: ago(createdMin), ...extra })
	const calm = () => ({ load: 1, freeGb: 8 })
	const types = (runs: CiRun[], fired = {}, strain: string | null = null, host = calm) => ciTransitions(runs, NOW, "main", fired, strain, host)

	it("fires each type once per run on its transition, not before", () => {
		const runs = [
			run(1, "completed", 30, { head_branch: "main", conclusion: "failure" }),
			run(2, "completed", 30, { conclusion: "failure" }), // non-default branch
			run(3, "queued", 6),
			run(4, "queued", 4),
			run(5, "in_progress", 11),
			run(6, "in_progress", 9),
		]
		const r = types(runs)
		expect(r.events.map((e) => [e.type, e.run])).toEqual([
			["main-red", 1],
			["ci-queued", 3],
			["ci-slow", 5],
		])
		expect(r.events[1]?.minutes).toBe(6)
		expect(types(runs, r.fired).events).toEqual([])
	})

	it("does not re-fire after a restart from persisted state (JSON round trip)", () => {
		const runs = [run(1, "queued", 20), run(2, "in_progress", 20)]
		const persisted = JSON.parse(JSON.stringify(types(runs).fired))
		expect(types(runs, persisted).events).toEqual([])
	})

	it("drops fired ids that left the window", () => {
		const r = types([run(9, "queued", 1)], { "ci-queued": [1, 9] })
		expect(r.fired["ci-queued"]).toEqual([9])
	})

	it("host-strain needs a running job and a strained host, once per 10 min", () => {
		const strained = () => ({ load: 20, freeGb: 8 })
		expect(types([run(1, "queued", 1)], {}, null, strained).events).toEqual([])
		expect(types([run(1, "in_progress", 1)], {}, null, calm).events).toEqual([])
		const first = types([run(1, "in_progress", 1)], {}, null, strained)
		expect(first.events.map((e) => e.type)).toEqual(["host-strain"])
		expect(types([run(1, "in_progress", 1)], {}, first.hostStrainAt, strained).events).toEqual([])
		const later = ciTransitions([run(1, "in_progress", 1)], NOW + 10 * 60_000, "main", {}, first.hostStrainAt, () => ({ load: 1, freeGb: 1 }))
		expect(later.events.filter((e) => e.type === "host-strain")).toHaveLength(1)
	})
})
