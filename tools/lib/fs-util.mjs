import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"

/** "~/foo" -> "/Users/x/foo"; leaves absolute/relative paths untouched. */
export function expandHome(p) {
	if (p === "~") return homedir()
	if (p.startsWith("~/")) return `${homedir()}${p.slice(1)}`
	return p
}

/** Atomic write: readers polling the path concurrently never see a partial file. */
export function writeAtomic(path, content) {
	mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true })
	const tmp = `${path}.tmp`
	writeFileSync(tmp, content)
	renameSync(tmp, path)
}
