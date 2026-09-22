/**
 * on-merge — generic post-merge step runner.
 *
 * CLI: `bun tools/on-merge/run.mjs <configName> [listKey]` — loads
 * $AGENT_TOOLS_HOME/config/<configName>.json and executes the named step
 * array (default `onMerge`) in order. A second list runs as its own
 * launchd job via the third ProgramArguments entry (tools/launchd/).
 * Meant to be triggered by a launchd WatchPaths agent watching that
 * config's gh-status events dir (see tools/launchd/), so it fires shortly
 * after the poller touches a `.merged` marker — not tied to any single PR
 * number: it means only that something changed.
 *
 * Step types:
 *   { type: "board-snapshot" }                     — runs board-snapshot for this config
 *   { type: "command", cmd: "...", cwd: "..." }     — runs a shell command (cwd accepts ~)
 *
 * Debounced as a whole run per list (skip all steps if the last run for
 * this config's list started < 60s ago) — WatchPaths can fire multiple
 * times for one burst of marker writes. Every step outcome is appended to
 * $AGENT_TOOLS_HOME/var/<name>/on-merge.log (default list) or
 * on-merge-<kebab-list-key>.log (any other list).
 */
import { execSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
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
			// env passed explicitly: see ghJson in board-snapshot.mjs.
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

function kebabCase(key) {
	return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

export async function runOnMerge(config, listKey = "onMerge") {
	const dir = varDir(config.name)
	const isDefault = listKey === "onMerge"
	const stateFile = join(dir, isDefault ? ".on-merge-last-run" : `.on-merge-last-run-${listKey}`)
	const logFile = join(dir, isDefault ? "on-merge.log" : `${kebabCase(listKey)}.log`)

	const steps = config[listKey]
	if (!Array.isArray(steps) || steps.length === 0) {
		mkdirSync(dir, { recursive: true })
		appendLog(logFile, `${new Date().toISOString()} no-steps(${listKey}) exit=0`)
		return
	}

	if (isDebounced(stateFile)) {
		console.log(`on-merge[${config.name}/${listKey}]: debounced (last run < 60s ago), skipping`)
		return
	}
	writeAtomic(stateFile, `${Date.now()}\n`)

	for (const step of steps) {
		await runStep(config, step, logFile)
	}
}

function main() {
	const name = process.argv[2]
	const listKey = process.argv[3] || "onMerge"
	if (!name) {
		console.error("usage: bun tools/on-merge/run.mjs <configName> [listKey]")
		process.exit(1)
	}
	runOnMerge(loadConfig(name), listKey)
}

main()
