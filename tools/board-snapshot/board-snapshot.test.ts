import { describe, expect, it } from "bun:test"
import { isWithinDebounce, renderMarkdown, selectRenderableItems, sortItems, stripTimestamp } from "./board-snapshot.mjs"

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse("2026-07-14T00:00:00Z")

function item(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		number: 1,
		title: "Sample",
		status: "Backlog",
		service: null,
		tier: null,
		week: null,
		milestone: null,
		closedAt: null,
		blockedBy: [],
		...overrides,
	}
}

describe("selectRenderableItems", () => {
	it("keeps non-Done items regardless of closedAt", () => {
		const items = [item({ number: 1, status: "Ready", closedAt: null })]
		expect(selectRenderableItems(items, NOW)).toHaveLength(1)
	})

	it("keeps Done items closed within the last 7 days", () => {
		const items = [item({ number: 2, status: "Done", closedAt: "2026-07-10T00:00:00Z" })]
		expect(selectRenderableItems(items, NOW)).toHaveLength(1)
	})

	it("drops Done items closed before the 7-day cutoff", () => {
		const items = [item({ number: 3, status: "Done", closedAt: "2026-07-01T00:00:00Z" })]
		expect(selectRenderableItems(items, NOW)).toHaveLength(0)
	})

	it("drops Done items with no closedAt", () => {
		const items = [item({ number: 4, status: "Done", closedAt: null })]
		expect(selectRenderableItems(items, NOW)).toHaveLength(0)
	})

	it("keeps a Done item exactly at the cutoff boundary", () => {
		const items = [item({ number: 5, status: "Done", closedAt: new Date(NOW - 7 * DAY_MS).toISOString() })]
		expect(selectRenderableItems(items, NOW)).toHaveLength(1)
	})
})

describe("sortItems", () => {
	it("groups by Status in board order (Backlog, Ready, In Progress, Done)", () => {
		const items = [
			item({ number: 1, status: "Done" }),
			item({ number: 2, status: "Backlog" }),
			item({ number: 3, status: "In Progress" }),
			item({ number: 4, status: "Ready" }),
		]
		expect(sortItems(items).map((i) => i.status)).toEqual(["Backlog", "Ready", "In Progress", "Done"])
	})

	it("sorts by issue number descending within a status group", () => {
		const items = [item({ number: 5, status: "Ready" }), item({ number: 20, status: "Ready" })]
		expect(sortItems(items).map((i) => i.number)).toEqual([20, 5])
	})

	it("sorts unrecognized/null status after Done", () => {
		const items = [item({ number: 1, status: null }), item({ number: 2, status: "Done" })]
		expect(sortItems(items).map((i) => i.status)).toEqual(["Done", null])
	})
})

describe("renderMarkdown", () => {
	it("includes the derived header comment and generated-at line", () => {
		const md = renderMarkdown([], "2026-07-14T00:00:00.000Z")
		expect(md).toContain("<!-- DERIVED — DO NOT EDIT.")
		expect(md).toContain("Generated: 2026-07-14T00:00:00.000Z")
	})

	it("renders the em-dash placeholder for missing fields and blocked-by", () => {
		const md = renderMarkdown([item({ number: 9 })], "2026-07-14T00:00:00.000Z")
		expect(md).toContain("| #9 | Sample | Backlog | — | — | — | — | — |")
	})

	it("escapes pipe characters in titles", () => {
		const md = renderMarkdown([item({ number: 9, title: "A | B" })], "2026-07-14T00:00:00.000Z")
		expect(md).toContain("A \\| B")
	})

	it("renders blocked-by as sorted issue references", () => {
		const md = renderMarkdown([item({ number: 9, blockedBy: [5, 1] })], "2026-07-14T00:00:00.000Z")
		expect(md).toContain("#5, #1")
	})
})

describe("stripTimestamp", () => {
	it("treats renders that differ only by generated-at as identical", () => {
		const a = renderMarkdown([item({ number: 1 })], "2026-07-14T00:00:00.000Z")
		const b = renderMarkdown([item({ number: 1 })], "2026-07-15T12:30:00.000Z")
		expect(stripTimestamp(a)).toBe(stripTimestamp(b))
	})

	it("still detects a real content change", () => {
		const a = renderMarkdown([item({ number: 1 })], "2026-07-14T00:00:00.000Z")
		const b = renderMarkdown([item({ number: 2 })], "2026-07-14T00:00:00.000Z")
		expect(stripTimestamp(a)).not.toBe(stripTimestamp(b))
	})
})

describe("isWithinDebounce", () => {
	it("is true just under the debounce window", () => {
		expect(isWithinDebounce(NOW - 59_000, NOW, 60_000)).toBe(true)
	})

	it("is false once the debounce window has fully elapsed", () => {
		expect(isWithinDebounce(NOW - 60_000, NOW, 60_000)).toBe(false)
	})
})
