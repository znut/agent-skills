#!/usr/bin/env node
// run-codex.mjs — the ONLY sanctioned entry point into the openai-codex
// plugin's companion runtime. Narrow argv surface, no shell, no passthrough
// flags. See skills/codex-runtime/SKILL.md for the contract this enforces.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const ALLOWED_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];

function fail(message) {
	console.error(`run-codex: ${message}`);
	process.exit(1);
}

function parseArgs(argv) {
	const out = { promptFile: null, model: null, effort: null, resumeLast: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--prompt-file") {
			out.promptFile = argv[++i];
			if (out.promptFile === undefined) fail("--prompt-file requires a value");
		} else if (arg === "--model") {
			out.model = argv[++i];
			if (out.model === undefined) fail("--model requires a value");
		} else if (arg === "--effort") {
			out.effort = argv[++i];
			if (out.effort === undefined) fail("--effort requires a value");
		} else if (arg === "--resume-last") {
			out.resumeLast = true;
		} else {
			// Only --prompt-file/--model/--effort/--resume-last are accepted.
			// Everything else — --add-dir, --sandbox, --danger*, -c, --config,
			// or any other flag/positional — is rejected by name, no exceptions.
			fail(`rejected argument: "${arg}" (only --prompt-file, --model, --effort, --resume-last are accepted)`);
		}
	}
	return out;
}

const { promptFile, model, effort, resumeLast } = parseArgs(process.argv.slice(2));

if (!promptFile) fail("missing required --prompt-file <path>");
if (!model) fail("missing required --model <id>");
if (!effort) fail(`missing required --effort <${ALLOWED_EFFORTS.join("|")}>`);
if (!ALLOWED_EFFORTS.includes(effort)) {
	fail(`invalid --effort "${effort}" (must be one of ${ALLOWED_EFFORTS.join(", ")})`);
}
if (!existsSync(promptFile)) fail(`prompt file not found: ${promptFile}`);

const promptContent = readFileSync(promptFile, "utf8");

// Resolve the stock openai-codex companion dynamically — never hardcode a
// version path, it changes on every plugin update.
const installedPluginsPath = join(homedir(), ".claude", "plugins", "installed_plugins.json");
if (!existsSync(installedPluginsPath)) {
	fail(`cannot find ${installedPluginsPath} — install the openai-codex plugin first`);
}

let installed;
try {
	installed = JSON.parse(readFileSync(installedPluginsPath, "utf8"));
} catch (err) {
	fail(`cannot parse ${installedPluginsPath}: ${err.message}`);
}

const entries = installed?.plugins?.["codex@openai-codex"];
if (!Array.isArray(entries) || entries.length === 0) {
	fail("openai-codex plugin is not installed (no codex@openai-codex entry) — install the openai-codex plugin first");
}

const newest = [...entries].sort(
	(a, b) => new Date(b.lastUpdated ?? b.installedAt ?? 0) - new Date(a.lastUpdated ?? a.installedAt ?? 0),
)[0];
const companionPath = join(newest.installPath, "scripts", "codex-companion.mjs");
if (!existsSync(companionPath)) {
	fail(`companion script not found at ${companionPath} — install the openai-codex plugin`);
}

const childArgs = ["task", promptContent, "--model", model, "--effort", effort, "--write"];
if (resumeLast) childArgs.push("--resume-last");

const result = spawnSync("node", [companionPath, ...childArgs], {
	cwd: process.cwd(),
	stdio: "inherit",
});

if (result.error) fail(`failed to spawn companion: ${result.error.message}`);
process.exit(result.status ?? 1);
