import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readToken } from "./config.mjs"

function tokenFile(content: string) {
	const path = join(mkdtempSync(join(tmpdir(), "config-token-")), "token")
	writeFileSync(path, content)
	return path
}

const keychain = (items: Record<string, string>) => (item: string) => {
	if (!(item in items)) throw new Error("security: item not found")
	return items[item]
}

describe("readToken", () => {
	it("reads tokenItem from the keychain and it wins over tokenFile", () => {
		const config = { name: "t", tokenItem: "svc", tokenFile: tokenFile("file-value\n") }
		expect(readToken(config, keychain({ svc: "item-value\n" }))).toBe("item-value")
	})

	it("fails on a missing tokenItem with the store command and no fallback to tokenFile", () => {
		const config = { name: "t", tokenItem: "absent", tokenFile: tokenFile("file-value") }
		expect(() => readToken(config, keychain({}))).toThrow(/keychain item not found: absent.*security add-generic-password -U -s absent -a "\$USER" -w/)
	})

	it("fails on an empty tokenItem", () => {
		expect(() => readToken({ name: "t", tokenItem: "svc" }, keychain({ svc: "\n" }))).toThrow(/keychain item not found: svc/)
	})

	it("still reads tokenFile when no tokenItem is set", () => {
		const neverCalled = () => {
			throw new Error("keychain read without tokenItem")
		}
		expect(readToken({ name: "t", tokenFile: tokenFile("file-value\n") }, neverCalled)).toBe("file-value")
	})

	it("fails on a missing tokenFile naming the path", () => {
		expect(() => readToken({ name: "t", tokenFile: "/nonexistent/token" })).toThrow(/token file unreadable or empty: \/nonexistent\/token/)
	})

	it("fails when neither key is set", () => {
		expect(() => readToken({ name: "t" })).toThrow(/neither tokenItem nor tokenFile/)
	})
})
