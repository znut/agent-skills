/**
 * `main-ci vouch <configName> <pr> <sha>` — records that a PR's head is
 * vouched, so the preview gate readies the draft on a green preview of that
 * head. Format and meaning: README.md §Vouch.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../lib/config.mjs"
import { expandHome, writeAtomic } from "../lib/fs-util.mjs"

function fail(msg) {
	console.error(`vouch: ${msg}`)
	process.exit(1)
}

export function vouch(name, pr, sha) {
	if (!name || !/^\d+$/.test(pr ?? "") || !/^[0-9a-f]{40}$/.test(sha ?? "")) {
		fail("usage: main-ci.mjs vouch <configName> <pr> <full 40-char sha>")
	}
	const config = loadConfig(name)
	const resultsDir = config.mainCi?.preview?.resultsDir
	if (!resultsDir || !config.org || !config.repo) fail(`config ${name} has no mainCi.preview.resultsDir, org and repo`)
	const r = spawnSync("gh", ["pr", "view", pr, "--repo", `${config.org}/${config.repo}`, "--json", "headRefOid", "--jq", ".headRefOid"], { encoding: "utf8" })
	if (r.status !== 0) fail(`gh pr view ${pr} failed: ${(r.stderr || "no stderr").trim()}`)
	const head = r.stdout.trim()
	if (head !== sha) fail(`PR #${pr} head is ${head}, not ${sha}; nothing written`)
	const dir = join(expandHome(resultsDir), `pr-${pr}`)
	mkdirSync(dir, { recursive: true })
	writeAtomic(join(dir, "vouched.json"), `${JSON.stringify({ head, at: new Date().toISOString().replace(/\.\d+Z$/, "Z") })}\n`)
	console.log(`vouched PR #${pr} at ${head}`)
}
