import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expandHome } from "./fs-util.mjs"

// All config + runtime output lives OUTSIDE the repo, under $AGENT_TOOLS_HOME
// (default ~/.config/agent-tools), so this repo can be published without
// leaking any operator's real project configs or local var/ output.
export function agentToolsHome() {
	return expandHome(process.env.AGENT_TOOLS_HOME || "~/.config/agent-tools")
}

export function configDir() {
	return join(agentToolsHome(), "config")
}

export function varDir(name) {
	return join(agentToolsHome(), "var", name)
}

export function loadConfig(name) {
	return JSON.parse(readFileSync(join(configDir(), `${name}.json`), "utf8"))
}

/** Every $AGENT_TOOLS_HOME/config/*.json, parsed. Used by the poller to cover all configured repos in one process. */
export function loadAllConfigs() {
	const dir = configDir()
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
}
