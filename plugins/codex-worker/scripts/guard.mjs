#!/usr/bin/env node
// PreToolUse/Bash guard for codex-worker. Reads the hook JSON from stdin,
// inspects tool_input.command, and blocks the narrow set of ways an agent
// could bypass run-codex.mjs and talk to Codex (or its sandbox flags)
// directly. Protocol matches this ecosystem's other PreToolUse/Bash hook
// (agent-skills/tools/hooks/review-gate.js): exit 2 + a reason on stderr to
// block, exit 0 to allow. Fails OPEN on any parse error — a broken guard
// must never wedge an unrelated Bash call.

import { readFileSync } from "node:fs";

function allow() {
	process.exit(0);
}

function block(reason) {
	process.stderr.write(`⛔ codex-worker guard: ${reason}\n`);
	process.exit(2);
}

let input;
try {
	input = JSON.parse(readFileSync(0, "utf8"));
} catch {
	allow(); // unreadable/non-JSON stdin — nothing to gate
}

const cmd = (input && input.tool_input && input.tool_input.command) || "";
if (!cmd) allow();

// 1. Direct `codex exec` / `codex apply` — the raw CLI subcommands that
//    write to disk or run a turn outside the wrapper's prompt/verify loop.
if (/\bcodex\s+(exec|apply)\b/.test(cmd)) {
	block('direct "codex exec"/"codex apply" is banned — invoke via scripts/run-codex.mjs');
}

// 2. --add-dir widens Codex's sandbox beyond the target repo checkout.
if (/--add-dir\b/.test(cmd)) {
	block("--add-dir is banned — Codex must stay scoped to the target repo checkout");
}

// 3. The "danger-full-access" sandbox mode disables Codex's sandboxing entirely.
if (/danger-full-access/.test(cmd)) {
	block("danger-full-access sandbox mode is banned");
}

// 4. Any --dangerously-* flag (e.g. bypass-approvals-and-sandbox) is banned outright.
if (/--dangerously-/.test(cmd)) {
	block("--dangerously-* flags are banned");
}

// 5. A direct `codex-companion.mjs ... task` call bypasses run-codex.mjs's
//    argv allowlist. Scoped per-segment (up to the next ; & | ` or newline)
//    so it doesn't false-block unrelated "task" text elsewhere on the line.
//    Non-"task" subcommands (status/result/cancel/setup) are the stock
//    openai-codex plugin's own machinery and stay allowed.
const segments = cmd.split(/codex-companion\.mjs\b/).slice(1);
for (const seg of segments) {
	const nextStatement = seg.split(/[;&|`\n]/, 1)[0];
	if (/\btask\b/.test(nextStatement)) {
		block('direct "codex-companion.mjs task" is banned — invoke via scripts/run-codex.mjs');
	}
}

allow();
