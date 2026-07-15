/**
 * on-merge — generic post-merge step runner.
 *
 * CLI: `bun tools/on-merge/run.mjs <configName>` — loads
 * $AGENT_TOOLS_HOME/config/<configName>.json and executes its `onMerge`
 * array in order. Meant to be triggered by a launchd WatchPaths agent
 * watching that config's gh-status events dir (see tools/launchd/), so it
 * fires shortly after the poller touches a `.merged` marker — not tied to
 * any single PR number, just "something changed".
 *
 * Step types:
 *   { type: "board-snapshot" }                     — runs board-snapshot for this config
 *   { type: "command", cmd: "...", cwd: "..." }     — runs a shell command (cwd supports ~)
 *
 * Debounced as a whole run (skip all steps if the last run for this config
 * started < 60s ago) — WatchPaths can fire multiple times for one burst of
 * marker writes. Every step outcome is appended to
 * $AGENT_TOOLS_HOME/var/<name>/on-merge.log.
 */
import { execSync } from "node:child_process"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig, varDir } from "../lib/config.mjs"
import { expandHome, writeAtomic } from "../lib/fs-util.mjs"

const DEBOUNCE_MS = 60_000

function isDebounced(stateFile) {
	if (!existsSync(stateFile)) return false
	const last = Number(readFileSync(stateFile, "utf8").trim())
	return Number.isFinite(last) && Date.now() - last < DEBOUNCE_MS
}

function appendLog(logFile, line) {
	appendFileSync(logFile, `${line}\n`)
}

async function runStep(config, step, logFile) {
	const at = new Date().toISOString()
	if (step.type === "board-snapshot") {
		try {
			const { run } = await import("../board-snapshot/board-snapshot.mjs")
			run(config)
			appendLog(logFile, `${at} board-snapshot exit=0`)
		} catch (e) {
			appendLog(logFile, `${at} board-snapshot exit=1 ${e instanceof Error ? e.message : e}`)
		}
		return
	}
	if (step.type === "command") {
		try {
			// env: process.env passed explicitly — see board-snapshot.mjs's ghJson
			// comment; Bun's exec*Sync doesn't reliably inherit env mutated at
			// runtime unless told to.
			execSync(step.cmd, { cwd: expandHome(step.cwd), stdio: "pipe", env: process.env })
			appendLog(logFile, `${at} command(${step.cmd}) exit=0`)
		} catch (e) {
			const code = typeof e === "object" && e && "status" in e ? e.status : 1
			appendLog(logFile, `${at} command(${step.cmd}) exit=${code}`)
		}
		return
	}
	appendLog(logFile, `${at} unknown-step-type(${step.type}) exit=1`)
}

export async function runOnMerge(config) {
	const dir = varDir(config.name)
	const stateFile = join(dir, ".on-merge-last-run")
	const logFile = join(dir, "on-merge.log")

	if (isDebounced(stateFile)) {
		console.log(`on-merge[${config.name}]: debounced (last run < 60s ago), skipping`)
		return
	}
	writeAtomic(stateFile, `${Date.now()}\n`)

	for (const step of config.onMerge ?? []) {
		await runStep(config, step, logFile)
	}
}

function main() {
	const name = process.argv[2]
	if (!name) {
		console.error("usage: bun tools/on-merge/run.mjs <configName>")
		process.exit(1)
	}
	runOnMerge(loadConfig(name))
}

main()
