import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expandHome } from "./fs-util.mjs"

// All config + tool output lives OUTSIDE the repo, under $AGENT_TOOLS_HOME
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

/** Every $AGENT_TOOLS_HOME/config/*.json, parsed. Used by the poller to poll every configured repo in one process. */
export function loadAllConfigs() {
	const dir = configDir()
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
}

function keychainItem(item) {
	return execFileSync("security", ["find-generic-password", "-s", item, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
}

/**
 * The GitHub token for a config. `tokenItem` (a macOS login-keychain service
 * name) wins over `tokenFile`, as in bgh. Throws a message naming the source,
 * never the token. `readItem` is injectable so tests never touch a keychain.
 */
export function readToken(config, readItem = keychainItem) {
	if (config.tokenItem) {
		let token = ""
		try {
			token = readItem(config.tokenItem).trim()
		} catch {}
		if (!token) {
			throw new Error(
				`keychain item not found: ${config.tokenItem} (store it: security add-generic-password -U -s ${config.tokenItem} -a "$USER" -w)`,
			)
		}
		return token
	}
	if (!config.tokenFile) throw new Error(`config ${config.name} sets neither tokenItem nor tokenFile`)
	let token = ""
	try {
		token = readFileSync(expandHome(config.tokenFile), "utf8").trim()
	} catch {}
	if (!token) throw new Error(`token file unreadable or empty: ${config.tokenFile}`)
	return token
}
