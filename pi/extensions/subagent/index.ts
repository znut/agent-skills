/**
 * pi subagent extension
 *
 * Spawns isolated pi processes as workers/reviewers, captures their JSON-mode
 * output, and enables parent↔subagent signalling (status pings and steer
 * messages).
 *
 * Also provides:
 * - a TUI widget listing live subagents (role, activity, elapsed, tokens);
 * - a non-blocking lane watcher (`arm_lane_watch` tool / `/lane-watch`
 *   command) that runs the repo's watch-lane script detached and injects the
 *   fire as a follow-up message instead of blocking a foreground bash call.
 *
 * This is harness-only plumbing: the prompts and conventions that govern agent
 * behavior live in the project using the extension (e.g. `.pi/prompts/`).
 */

import { createHash, randomUUID } from "node:crypto";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Defaults (can be overridden per repo or per spawn)
// ---------------------------------------------------------------------------

const DEFAULT_PROMPTS: Record<string, string> = {
	worker: process.env.PI_EXT_SUBAGENT_WORKER_PROMPT || "worker",
	reviewer: process.env.PI_EXT_SUBAGENT_REVIEWER_PROMPT || "reviewer",
};

const DEFAULT_AWAIT_TIMEOUT_MS = 600_000; // 10 min

const SUBAGENTS_ROOT = path.join(os.homedir(), ".pi", "agent", "subagents");

/** Finished agents stay visible in the widget for this long. */
const FINISHED_VISIBLE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// State (per pi process)
// ---------------------------------------------------------------------------

interface AgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
	turns: number;
}

/** Resolve a model alias to its catalog display name (e.g. kimi-for-coding → "Kimi K2.7 Code"). */
function resolveModelName(ctx: any, modelId?: string): string | undefined {
	if (!modelId) return undefined;
	try {
		const hit = ctx.modelRegistry?.getAll?.().find((m: any) => m.id === modelId);
		return hit?.name;
	} catch {
		return undefined;
	}
}

interface AgentState {
	dir: string;
	process: ChildProcess;
	collected: boolean;
	lastStatus?: string;
	/** True once a terminal status (done/needs_help/error) was already reported via agent_ping. */
	terminalNotified?: boolean;
	watcher?: fs.FSWatcher;
	role: string;
	model?: string;
	modelName?: string;
	parentId?: string;
	startedAt: number;
	activity: string;
	usage: AgentUsage;
	finishedAt?: number;
}

interface LiveFile {
	agent_id: string;
	role: string;
	model?: string;
	modelName?: string;
	parentId?: string;
	startedAt: number;
	finishedAt?: number;
	activity: string;
	usage: AgentUsage;
	status: string;
}

const agents = new Map<string, AgentState>();

/** Armed lane watchers, keyed by role. */
interface LaneWatcher {
	proc: ChildProcess;
	/** Set when we deliberately kill the process on re-arm or shutdown. */
	killed?: boolean;
}
const laneWatchers = new Map<string, LaneWatcher>();

/**
 * Normalise any path inside a clone (primary checkout or linked worktree) to
 * the primary checkout, so every agent of the same repo shares one project id
 * regardless of which worktree spawned it.
 */
function primaryCheckout(cwd: string): string {
	try {
		const common = execSync("git rev-parse --git-common-dir", {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return path.dirname(path.resolve(cwd, common));
	} catch {
		return path.resolve(cwd);
	}
}

function projectId(cwd: string): string {
	return createHash("sha256").update(primaryCheckout(cwd)).digest("hex").slice(0, 16);
}

function projectRoot(cwd: string): string {
	return path.join(SUBAGENTS_ROOT, projectId(cwd));
}

function agentDir(cwd: string, agentId: string): string {
	return path.join(projectRoot(cwd), agentId);
}

function ensureAgentDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

function writeResult(dir: string, result: unknown): void {
	fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2), "utf-8");
}

function writeStatus(dir: string, status: { status: string; message?: string }): void {
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
}

function readStatus(dir: string): { status: string; message?: string } | null {
	const p = path.join(dir, "status.json");
	if (!fs.existsSync(p)) return null;
	return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function readResult(dir: string): unknown | null {
	const p = path.join(dir, "result.json");
	if (!fs.existsSync(p)) return null;
	return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function emptyUsage(): AgentUsage {
	return { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0 };
}

function writeLive(agentId: string, state: AgentState, status: string): void {
	const live: LiveFile = {
		agent_id: agentId,
		role: state.role,
		model: state.model,
		modelName: state.modelName,
		parentId: state.parentId,
		startedAt: state.startedAt,
		finishedAt: state.finishedAt,
		activity: state.activity,
		usage: state.usage,
		status,
	};
	try {
		fs.writeFileSync(path.join(state.dir, "live.json"), JSON.stringify(live, null, 2), "utf-8");
	} catch {
		/* ignore */
	}
}

function readLive(dir: string): LiveFile | null {
	const p = path.join(dir, "live.json");
	if (!fs.existsSync(p)) return null;
	try {
		return JSON.parse(fs.readFileSync(p, "utf-8")) as LiveFile;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Activity summaries + formatting
// ---------------------------------------------------------------------------

function truncate(s: string, n: number): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

function summarizeTool(toolName: string, args: any): string {
	const a = args ?? {};
	switch (toolName) {
		case "bash":
			return `bash: ${truncate(String(a.command ?? ""), 56)}`;
		case "read":
			return `read ${path.basename(String(a.path ?? ""))}`;
		case "write":
			return `write ${path.basename(String(a.path ?? ""))}`;
		case "edit":
			return `edit ${path.basename(String(a.path ?? ""))}`;
		case "spawn_agent":
			return `spawn ${a.role ?? "agent"}${a.model ? ` (${a.model})` : ""}`;
		case "await_agent":
			return "awaiting reviewer";
		case "agent_ping":
			return `ping ${a.status ?? ""}`;
		default:
			return toolName;
	}
}

function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
	return `${sec}s`;
}

function formatTokens(usage: AgentUsage): string {
	const total = usage.input + usage.output;
	if (total >= 1000) return `${(total / 1000).toFixed(1)}k tok`;
	return `${total} tok`;
}

// ---------------------------------------------------------------------------
// Steer watcher (subagent side)
// ---------------------------------------------------------------------------

interface AgentMessage {
	type: string;
	content?: string;
}

function writeMessage(dir: string, message: AgentMessage): void {
	fs.writeFileSync(path.join(dir, "message.json"), JSON.stringify(message, null, 2), "utf-8");
}

function readAndDeleteMessage(dir: string): AgentMessage | null {
	const p = path.join(dir, "message.json");
	if (!fs.existsSync(p)) return null;
	try {
		const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
		fs.unlinkSync(p);
		return raw as AgentMessage;
	} catch {
		return null;
	}
}

function formatSteerMessage(message: AgentMessage): string {
	const prefix = message.type ? `[${message.type.toUpperCase()}] ` : "[STEER] ";
	const body = message.content ?? "";
	if (message.type === "stop") {
		return `${prefix}The orchestrator has cancelled this task. Stop working immediately, call agent_ping with status error, and exit.`;
	}
	if (message.type === "steer") {
		return `${prefix}Direction change from the orchestrator — treat this as an override to your previous instructions:\n${body}`;
	}
	return `${prefix}${body}`;
}

function startSteerWatcher(pi: ExtensionAPI, ctx: any): void {
	const ownId = process.env.PI_EXT_SUBAGENT_ID;
	const ownDir = process.env.PI_EXT_SUBAGENT_DIR || (ownId ? agentDir(ctx.cwd, ownId) : null);
	if (!ownDir) return;
	ensureAgentDir(ownDir);
	const messagePath = path.join(ownDir, "message.json");

	// Clear stale messages from a previous run.
	if (fs.existsSync(messagePath)) {
		fs.unlinkSync(messagePath);
	}

	const consume = () => {
		const message = readAndDeleteMessage(ownDir);
		if (!message) return;
		const text = formatSteerMessage(message);
		try {
			// Queue as a follow-up user message; pi delivers it in the gap after the
			// current assistant turn / tool chain completes, without interrupting
			// an in-flight tool call.
			pi.sendUserMessage(text, { deliverAs: "followUp" });
		} catch {
			/* ignore */
		}
	};

	// Handle messages that arrived before the watcher started.
	if (fs.existsSync(messagePath)) {
		consume();
	}

	fs.watch(ownDir, { persistent: false }, (eventType, filename) => {
		if (filename !== "message.json" || !fs.existsSync(messagePath)) return;
		consume();
	});
}

// ---------------------------------------------------------------------------
// Agent lifecycle
// ---------------------------------------------------------------------------

function killAgent(state: AgentState): void {
	try {
		state.process.kill("SIGTERM");
		setTimeout(() => {
			if (!state.process.killed) state.process.kill("SIGKILL");
		}, 5000);
	} catch {
		/* ignore */
	}
	state.watcher?.close();
}

function cleanup(agentId: string): void {
	const state = agents.get(agentId);
	if (!state) return;
	state.watcher?.close();
	agents.delete(agentId);
}

function sendNotification(
	pi: ExtensionAPI,
	state: AgentState,
	agentId: string,
	status: { status: string; message?: string },
): void {
	if (state.collected) return;
	const text = status.message
		? `Subagent ${agentId} is ${status.status}: ${status.message}`
		: `Subagent ${agentId} is ${status.status}. Result: ${path.join(state.dir, "result.json")}`;
	// In TUI/RPC modes this wakes the parent session; in print/json it is a no-op,
	// and the parent is expected to call await_agent instead.
	try {
		pi.sendUserMessage(text, { deliverAs: "followUp" });
	} catch {
		/* non-TUI or idle: ignore */
	}
}

function watchStatus(pi: ExtensionAPI, agentId: string, state: AgentState): void {
	const statusPath = path.join(state.dir, "status.json");
	const terminalStatuses = new Set(["done", "needs_help", "error"]);
	if (fs.existsSync(statusPath)) {
		const status = readStatus(state.dir);
		if (status) {
			if (terminalStatuses.has(status.status)) state.terminalNotified = true;
			sendNotification(pi, state, agentId, status);
		}
		return;
	}
	state.watcher = fs.watch(state.dir, (eventType, filename) => {
		if (filename !== "status.json" || !fs.existsSync(statusPath)) return;
		const status = readStatus(state.dir);
		if (!status) return;
		if (status.status === state.lastStatus) return;
		state.lastStatus = status.status;
		if (terminalStatuses.has(status.status)) state.terminalNotified = true;
		sendNotification(pi, state, agentId, status);
	});
}

// ---------------------------------------------------------------------------
// Subagent runner
// ---------------------------------------------------------------------------

interface AgentResult {
	exitCode: number;
	output: string;
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
	usage: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: number;
		turns?: number;
	};
}

async function finalizeAgent(pi: ExtensionAPI, agentId: string, state: AgentState, result: AgentResult): Promise<void> {
	const emptyReturn = result.exitCode === 0 && (!result.output || result.output.trim().length === 0);
	const status = emptyReturn ? "error" : result.exitCode === 0 && !result.errorMessage ? "done" : "error";
	state.finishedAt = Date.now();
	// Stamp model identity + timings so result.json is a complete per-task cost
	// record (modelName = catalog-resolved version, model = the stable alias).
	writeResult(state.dir, {
		...result,
		role: state.role,
		model: state.model,
		modelName: state.modelName,
		startedAt: state.startedAt,
		finishedAt: state.finishedAt,
	});

	const existingStatus = readStatus(state.dir);
	const message = emptyReturn
		? "empty return (protocol violation: no return block)"
		: result.errorMessage || result.stderr?.slice(0, 500) || undefined;
	if (!existingStatus || emptyReturn) {
		writeStatus(state.dir, { status, message });
	}
	const reported = readStatus(state.dir);
	writeLive(agentId, state, reported?.status ?? status);
	// The subagent already reported its final status via agent_ping; don't
	// notify again when the process later exits.
	if (!state.terminalNotified) {
		sendNotification(pi, state, agentId, reported!);
	}
}

// ---------------------------------------------------------------------------
// Lane watcher (non-blocking; injects the fire as a follow-up message)
// ---------------------------------------------------------------------------

function armLaneWatch(pi: ExtensionAPI, ctx: any, role: string, prs: string[]): string {
	const existing = laneWatchers.get(role);
	if (existing) {
		existing.killed = true;
		existing.proc.kill("SIGTERM");
		laneWatchers.delete(role);
	}
	const script = path.join(ctx.cwd, "scripts", "watch-lane.sh");
	if (!fs.existsSync(script)) {
		return `watch-lane: no scripts/watch-lane.sh under ${ctx.cwd} — not armed`;
	}
	const proc = spawn("bash", [script, role, ...prs], {
		cwd: ctx.cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	let err = "";
	proc.stdout.on("data", (d: Buffer) => (out += d.toString("utf-8")));
	proc.stderr.on("data", (d: Buffer) => (err += d.toString("utf-8")));
	proc.on("close", (code) => {
		const watcher = laneWatchers.get(role);
		laneWatchers.delete(role);
		if (watcher?.killed) return;
		const stdout = out.trim();
		const stderr = err.trim();
		let text: string;
		if (code === 0 && stdout) {
			text = `[lane-watch:${role}] watcher fired:\n${stdout}\nSweep/archive the fire, then re-arm with arm_lane_watch.`;
		} else if (code === 0) {
			text = `[lane-watch:${role}] watcher exited 0 with no output — investigate before re-arming.`;
		} else {
			text = `[lane-watch:${role}] watcher exited ${code}${stderr ? `: ${stderr.slice(0, 300)}` : ""} — fall back to gh polling if the service is down.`;
		}
		try {
			pi.sendUserMessage(text, { deliverAs: "followUp" });
		} catch {
			/* session gone */
		}
	});
	laneWatchers.set(role, { proc, killed: false });
	return `lane watcher armed for ${role}${prs.length ? ` (PRs: ${prs.join(", ")})` : ""} — runs detached; the fire arrives as a follow-up message`;
}

// ---------------------------------------------------------------------------
// TUI widget
// ---------------------------------------------------------------------------

interface WidgetRow {
	id: string;
	status: string;
	role: string;
	model?: string;
	modelName?: string;
	parentId?: string;
	activity: string;
	elapsedMs: number;
	usage: AgentUsage;
	finishedAt?: number;
}

function collectRows(cwd: string): WidgetRow[] {
	const now = Date.now();
	const rows = new Map<string, WidgetRow>();
	const root = projectRoot(cwd);
	if (fs.existsSync(root)) {
		for (const entry of fs.readdirSync(root)) {
			const dir = path.join(root, entry);
			try {
				if (!fs.statSync(dir).isDirectory()) continue;
			} catch {
				continue;
			}
			const live = readLive(dir);
			if (live) {
				const done = live.status !== "running";
				if (done && live.finishedAt && now - live.finishedAt > FINISHED_VISIBLE_MS) continue;
				rows.set(entry, {
					id: entry,
					status: live.status,
					role: live.role,
					model: live.model,
					modelName: live.modelName,
					parentId: live.parentId,
					activity: live.activity,
					elapsedMs: (live.finishedAt ?? now) - live.startedAt,
					usage: live.usage,
					finishedAt: live.finishedAt,
				});
				continue;
			}
			// No live.json (pre-widget agents): fall back to status.json.
			const status = readStatus(dir);
			if (!status) continue;
			let mtime = 0;
			try {
				mtime = fs.statSync(path.join(dir, "status.json")).mtimeMs;
			} catch {
				/* ignore */
			}
			if (now - mtime > FINISHED_VISIBLE_MS) continue;
			rows.set(entry, {
				id: entry,
				status: status.status,
				role: "agent",
				activity: status.message ?? "",
				elapsedMs: 0,
				usage: emptyUsage(),
				finishedAt: mtime,
			});
		}
	}
	// In-memory state wins (fresher than the last live.json flush).
	for (const [id, state] of agents) {
		if (projectRoot(state.dir) !== root && path.dirname(state.dir) !== root) continue;
		// Skip finished agents that already aged out of the widget.
		if (state.finishedAt && now - state.finishedAt > FINISHED_VISIBLE_MS) continue;
		rows.set(id, {
			id,
			status: state.finishedAt ? (readStatus(state.dir)?.status ?? "done") : "running",
			role: state.role,
			model: state.model,
			modelName: state.modelName,
			parentId: state.parentId,
			activity: state.activity,
			elapsedMs: (state.finishedAt ?? now) - state.startedAt,
			usage: state.usage,
			finishedAt: state.finishedAt,
		});
	}
	return [...rows.values()].sort((a, b) => {
		const ar = a.status === "running" ? 0 : 1;
		const br = b.status === "running" ? 0 : 1;
		if (ar !== br) return ar - br;
		return (b.finishedAt ?? 0) - (a.finishedAt ?? 0);
	});
}

let widgetTimer: NodeJS.Timeout | null = null;

function shortModel(model?: string): string {
	if (!model) return "";
	if (model.includes("kimi")) return "kimi";
	return truncate(model, 12);
}

/** Compact a catalog display name for the widget: "Kimi K2.7 Code" → "K2.7", "Kimi K3-256K" → "K3-256K". */
function shortModelName(name?: string): string {
	if (!name) return "";
	const m = name.match(/K[\d.]+(?:-256K)?/i);
	return m ? m[0] : truncate(name, 12);
}

function updateWidget(pi: ExtensionAPI, ctx: any): void {
	if (ctx.mode !== "tui") return;
	const rows = collectRows(ctx.cwd);
	const watchRoles = [...laneWatchers.keys()];
	if (rows.length === 0 && watchRoles.length === 0) {
		ctx.ui.setWidget("subagents", undefined);
		return;
	}
	ctx.ui.setWidget("subagents", (_tui: any, theme: any) => ({
		render: () => {
			const lines: string[] = [];
			for (const w of watchRoles) {
				lines.push(theme.fg("dim", `◌ watch:${w} armed`));
			}
			const renderRow = (r: WidgetRow, indent: string) => {
				const icon =
					r.status === "running"
						? theme.fg("accent", "●")
						: r.status === "done"
							? theme.fg("success", "✓")
							: r.status === "needs_help"
								? theme.fg("warning", "?")
								: theme.fg("error", "✗");
				const name = theme.fg("muted", `${r.role}${r.modelName ? `·${shortModelName(r.modelName)}` : r.model ? `·${shortModel(r.model)}` : ""}`);
				const activity = r.status === "running" ? truncate(r.activity, 60) : theme.fg("dim", truncate(r.activity || r.status, 60));
				const right = theme.fg("dim", `${formatElapsed(r.elapsedMs)} · ${formatTokens(r.usage)}`);
				lines.push(`${indent}${icon} ${name}  ${activity}  ${right}`);
			};
			const byParent = new Map<string, WidgetRow[]>();
			const roots: WidgetRow[] = [];
			const ids = new Set(rows.map((r) => r.id));
			for (const r of rows) {
				if (r.parentId && ids.has(r.parentId)) {
					const list = byParent.get(r.parentId) ?? [];
					list.push(r);
					byParent.set(r.parentId, list);
				} else {
					roots.push(r);
				}
			}
			const renderTree = (r: WidgetRow, indent: string) => {
				renderRow(r, indent);
				for (const c of byParent.get(r.id) ?? []) renderTree(c, `${indent}  `);
			};
			for (const r of roots) renderTree(r, "");
			return lines;
		},
		invalidate: () => {},
	}));
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const SpawnParams = Type.Object({
	role: StringEnum(["worker", "reviewer"] as const, {
		description: "Agent role; selects default model and prompt template",
	}),
	task: Type.String({ description: "Self-contained task contract passed to the subagent" }),
	model: Type.Optional(Type.String({ description: "Model for the subagent (defaults to the current session's default model if omitted)" })),
	prompt_template: Type.Optional(Type.String({ description: "Override the default prompt template for the role" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent process (defaults to current cwd)" })),
	async: Type.Optional(Type.Boolean({ description: "Return a handle and notify/ping when done instead of blocking", default: false })),
	tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist for the subagent" })),
});

const AgentIdParams = Type.Object({
	agent_id: Type.String({ description: "Subagent id returned by spawn_agent" }),
});

const AwaitParams = Type.Object({
	agent_id: Type.String({ description: "Subagent id returned by spawn_agent" }),
	timeout_ms: Type.Optional(Type.Number({ description: "Maximum time to wait for a status signal", default: DEFAULT_AWAIT_TIMEOUT_MS })),
});

const PingParams = Type.Object({
	agent_id: Type.String({ description: "Subagent id to ping" }),
	status: StringEnum(["done", "needs_help", "error"] as const, { description: "New status" }),
	message: Type.Optional(Type.String({ description: "Optional human-readable detail" })),
});

const SendMessageParams = Type.Object({
	agent_id: Type.String({ description: "Subagent id to send a message to" }),
	type: StringEnum(["steer", "stop", "context"] as const, { description: "Message type" }),
	content: Type.String({ description: "Human-readable message content" }),
});

const LaneWatchParams = Type.Object({
	role: StringEnum(["pm", "tl-product", "tl-platform"] as const, {
		description: "Lane role whose inbox + PR events to watch",
	}),
	prs: Type.Optional(Type.Array(Type.String(), { description: "Optional PR numbers to scope the watch" })),
});

export default function (pi: ExtensionAPI) {
	// If this process is a subagent, start the steer watcher so parent messages
	// are injected as user messages and cannot be ignored by the agent.
	pi.on("session_start", async (_event, ctx) => {
		startSteerWatcher(pi, ctx);
		if (ctx.mode === "tui") {
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = setInterval(() => updateWidget(pi, ctx), 4000);
			updateWidget(pi, ctx);
		}
	});

	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn agent",
		description:
			"Spawn a fresh pi process as a worker or reviewer. With async=false the tool blocks until the subagent exits; with async=true it returns a handle and the parent receives a follow-up message when the subagent finishes or calls agent_ping. The parent can steer a running async subagent with send_agent_message; the subagent receives the steer as an injected user message. Pass model explicitly if the subagent needs a different model from the session default.",
		parameters: SpawnParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const agentId = randomUUID();
			const cwd = params.cwd || ctx.cwd;
			const dir = agentDir(cwd, agentId);
			ensureAgentDir(dir);
			// Remember which project this subagent belongs to.
			fs.writeFileSync(path.join(projectRoot(cwd), ".cwd"), cwd, "utf-8");

			const model = params.model;
			const modelName = resolveModelName(ctx, model);
			const promptTemplate = params.prompt_template || DEFAULT_PROMPTS[params.role];

			const state: AgentState = {
				dir,
				process: null as unknown as ChildProcess,
				collected: false,
				role: params.role,
				model,
				modelName,
				// Set when the spawning process is itself a subagent (worker → reviewer).
				parentId: process.env.PI_EXT_SUBAGENT_ID,
				startedAt: Date.now(),
				activity: "starting",
				usage: emptyUsage(),
			};
			agents.set(agentId, state);
			writeLive(agentId, state, "running");

			const taskFile = path.join(dir, "task.md");
			fs.writeFileSync(taskFile, params.task, "utf-8");
			const args = ["--mode", "json", "--no-session"];
			if (model) args.push("--model", model);
			if (promptTemplate) args.push("--prompt-template", promptTemplate);
			if (params.tools) args.push("--tools", params.tools);
			args.push("-p", `@${taskFile}`);

			const proc = spawn("pi", args, {
				cwd,
				env: {
					...process.env,
					PI_EXT_SUBAGENT_ID: agentId,
					PI_EXT_SUBAGENT_DIR: dir,
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			state.process = proc;

			// Capture result
			const capturePromise = new Promise<AgentResult>((resolve) => {
				const result: AgentResult = {
					exitCode: 0,
					output: "",
					stderr: "",
					usage: {},
				};
				let buffer = "";
				proc.stdout.on("data", (data: Buffer) => {
					buffer += data.toString("utf-8");
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) {
						if (!line.trim()) continue;
						try {
							const event = JSON.parse(line) as any;
							if (event.type === "tool_execution_start") {
								state.activity = summarizeTool(event.toolName, event.args);
								writeLive(agentId, state, "running");
							} else if (event.type === "message_end" && event.message?.role === "assistant") {
								const msg = event.message as any;
								if (msg.stopReason) result.stopReason = msg.stopReason;
								if (msg.errorMessage) result.errorMessage = msg.errorMessage;
								const u = msg.usage;
								if (u) {
									result.usage.input = (result.usage.input || 0) + (u.input || 0);
									result.usage.output = (result.usage.output || 0) + (u.output || 0);
									result.usage.cacheRead = (result.usage.cacheRead || 0) + (u.cacheRead || 0);
									result.usage.cacheWrite = (result.usage.cacheWrite || 0) + (u.cacheWrite || 0);
									result.usage.cost = (result.usage.cost || 0) + (u.cost?.total || 0);
									result.usage.turns = (result.usage.turns || 0) + 1;
									state.usage.input += u.input || 0;
									state.usage.output += u.output || 0;
									state.usage.cacheRead += u.cacheRead || 0;
									state.usage.cost += u.cost?.total || 0;
									state.usage.turns += 1;
								}
								const textParts = (msg.content || [])
									.filter((c: any) => c.type === "text")
									.map((c: any) => c.text);
								if (textParts.length) {
									result.output = textParts.join("\n");
									state.activity = truncate(textParts[textParts.length - 1], 60);
								}
								writeLive(agentId, state, "running");
							}
						} catch {
							/* ignore */
						}
					}
				});
				proc.stderr.on("data", (data: Buffer) => {
					result.stderr += data.toString("utf-8");
				});
				proc.on("close", (code) => {
					if (buffer.trim()) {
						try {
							const event = JSON.parse(buffer.trim()) as any;
							if (event.type === "message_end" && event.message?.role === "assistant") {
								const msg = event.message as any;
								const textParts = (msg.content || [])
									.filter((c: any) => c.type === "text")
									.map((c: any) => c.text);
								if (textParts.length) result.output = textParts.join("\n");
								if (msg.stopReason) result.stopReason = msg.stopReason;
								if (msg.errorMessage) result.errorMessage = msg.errorMessage;
							}
						} catch {
							/* ignore */
						}
					}
					result.exitCode = code ?? 0;
					resolve(result);
				});

				proc.on("error", () => {
					result.exitCode = 1;
					resolve(result);
				});
				// Only SYNC spawns tie the child's lifetime to the tool-call abort
				// signal. Async workers must survive turn aborts (Esc) in the parent;
				// they are reaped via stop_agent or session_shutdown instead.
				if (!params.async && signal) {
					signal.addEventListener(
						"abort",
						() => {
							proc.kill("SIGTERM");
							setTimeout(() => {
								if (!proc.killed) proc.kill("SIGKILL");
							}, 5000);
						},
						{ once: true },
					);
				}
			});

			// Async: finalize on completion and notify parent.
			if (params.async) {
				capturePromise
					.then((result) => finalizeAgent(pi, agentId, state, result))
					.catch(() => {});
				watchStatus(pi, agentId, state);
				const modelText = model ? ` (${model})` : "";
				return {
					content: [
						{
							type: "text",
							text: `Spawned ${params.role} ${agentId}${modelText}. It will run in the background; use await_agent or wait for the follow-up ping.`,
						},
					],
					details: { agent_id: agentId, dir, model, modelName, prompt_template: promptTemplate, async: true },
				};
			}

			// Sync: block until done.
			const result = await capturePromise;
			await finalizeAgent(pi, agentId, state, result);
			state.collected = true;
			cleanup(agentId);
			const isError = result.exitCode !== 0 || !!result.errorMessage;
			const text = result.output || result.stderr || "(no output)";
			return {
				content: [{ type: "text", text }],
				details: { agent_id: agentId, result },
				isError,
			};
		},
	});

	pi.registerTool({
		name: "await_agent",
		label: "Await agent",
		description:
			"Block until a subagent writes a status signal. Uses filesystem events, not polling. Returns the status and captured result.",
		parameters: AwaitParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = agents.get(params.agent_id);
			const dir = state?.dir || agentDir(ctx.cwd, params.agent_id);
			const timeoutMs = params.timeout_ms ?? DEFAULT_AWAIT_TIMEOUT_MS;

			const status = await new Promise<{ status: string; message?: string }>((resolve, reject) => {
				const existing = readStatus(dir);
				if (existing) {
					resolve(existing);
					return;
				}
				const timer = setTimeout(() => {
					watcher.close();
					reject(new Error(`Timeout waiting for subagent ${params.agent_id}`));
				}, timeoutMs);
				const statusPath = path.join(dir, "status.json");
				const watcher = fs.watch(dir, (eventType, filename) => {
					if (filename !== "status.json" || !fs.existsSync(statusPath)) return;
					const s = readStatus(dir);
					if (s) {
						clearTimeout(timer);
						watcher.close();
						resolve(s);
					}
				});
			});

			const result = readResult(dir);
			if (state) {
				state.collected = true;
				cleanup(params.agent_id);
			}
			return {
				content: [
					{
						type: "text",
						text: `Subagent ${params.agent_id} status: ${status.status}${status.message ? ` — ${status.message}` : ""}`,
					},
				],
				details: { agent_id: params.agent_id, status, result },
				isError: status.status === "error",
			};
		},
	});

	pi.registerTool({
		name: "agent_ping",
		label: "Agent ping",
		description:
			"Signal the parent session. A subagent calls this to report done, needs_help, or error without exiting. The parent receives a follow-up ping in TUI mode; in print/json mode the parent should await_agent.",
		parameters: PingParams,
		async execute(_toolCallId, params) {
			const dir = agentDir(process.cwd(), params.agent_id);
			ensureAgentDir(dir);
			writeStatus(dir, { status: params.status, message: params.message });
			return {
				content: [
					{
						type: "text",
						text: `Pinged parent for ${params.agent_id}: ${params.status}`,
					},
				],
				details: { agent_id: params.agent_id, status: params.status },
			};
		},
	});

	pi.registerTool({
		name: "send_agent_message",
		label: "Send agent message",
		description:
			"Send a one-way message to a running subagent. The subagent's own extension instance injects the message as a user message, so it cannot be ignored. Typical types: steer (change direction), stop (abort and exit), context (add missing context).",
		parameters: SendMessageParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const dir = agentDir(cwd, params.agent_id);
			ensureAgentDir(dir);
			writeMessage(dir, { type: params.type, content: params.content });
			return {
				content: [{ type: "text", text: `Sent ${params.type} message to ${params.agent_id}` }],
				details: { agent_id: params.agent_id, type: params.type },
			};
		},
	});

	pi.registerTool({
		name: "agent_status",
		label: "Agent status",
		description: "Read the current status of a subagent without blocking.",
		parameters: AgentIdParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = agents.get(params.agent_id);
			const dir = state?.dir || agentDir(ctx.cwd, params.agent_id);
			const status = readStatus(dir);
			const result = readResult(dir);
			const live = readLive(dir);
			const running = state ? !state.process.killed : null;
			return {
				content: [
					{
						type: "text",
						text: status
							? `Subagent ${params.agent_id} is ${status.status}${live ? ` — ${live.activity}` : ""}`
							: `Subagent ${params.agent_id} has not reported status yet${live ? ` (running: ${live.activity})` : ""}`,
					},
				],
				details: { agent_id: params.agent_id, status, result, live, running },
			};
		},
	});

	pi.registerTool({
		name: "list_agents",
		label: "List agents",
		description: "List active and recently finished subagents in this project.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const root = projectRoot(ctx.cwd);
			const ids: { agent_id: string; status?: string; activity?: string; running?: boolean }[] = [];
			if (fs.existsSync(root)) {
				for (const entry of fs.readdirSync(root)) {
					const dir = path.join(root, entry);
					const st = fs.statSync(dir);
					if (!st.isDirectory()) continue;
					const state = agents.get(entry);
					const status = readStatus(dir);
					const live = readLive(dir);
					ids.push({
						agent_id: entry,
						status: status?.status ?? (live?.status || undefined),
						activity: live?.activity,
						running: state ? !state.process.killed : undefined,
					});
				}
			}
			return {
				content: [
					{
						type: "text",
						text: ids
							.map((i) => `${i.agent_id}: ${i.status || "no status"}${i.activity ? ` — ${truncate(i.activity, 60)}` : ""}`)
							.join("\n"),
					},
				],
				details: { agents: ids },
			};
		},
	});

	pi.registerTool({
		name: "stop_agent",
		label: "Stop agent",
		description: "Send SIGTERM to a running subagent and mark it stopped.",
		parameters: AgentIdParams,
		async execute(_toolCallId, params) {
			const state = agents.get(params.agent_id);
			if (state) {
				killAgent(state);
				writeStatus(state.dir, { status: "stopped", message: "Stopped by parent" });
				cleanup(params.agent_id);
				return {
					content: [{ type: "text", text: `Stopped ${params.agent_id}` }],
					details: { agent_id: params.agent_id },
				};
			}
			return {
				content: [{ type: "text", text: `No running subagent ${params.agent_id}` }],
				details: { agent_id: params.agent_id },
				isError: true,
			};
		},
	});

	pi.registerTool({
		name: "arm_lane_watch",
		label: "Arm lane watch",
		description:
			"Arm the repo's lane watcher (scripts/watch-lane.sh) as a detached background process. NON-BLOCKING: when the watch fires (session-bus message, merge, PR activity), the fire arrives as an injected follow-up message. Re-arm only after sweeping/archiving the fire. One watcher per role; re-arming replaces the previous one.",
		parameters: LaneWatchParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const text = armLaneWatch(pi, ctx, params.role, params.prs ?? []);
			updateWidget(pi, ctx);
			return {
				content: [{ type: "text", text }],
				details: { role: params.role, prs: params.prs ?? [] },
			};
		},
	});

	pi.registerCommand("lane-watch", {
		description: "Arm a non-blocking lane watcher: /lane-watch <pm|tl-product|tl-platform> [pr#...]",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			const role = parts[0];
			if (!role || !["pm", "tl-product", "tl-platform"].includes(role)) {
				ctx.ui.notify("Usage: /lane-watch <pm|tl-product|tl-platform> [pr#...]", "error");
				return;
			}
			const text = armLaneWatch(pi, ctx, role, parts.slice(1));
			ctx.ui.notify(text, "info");
		},
	});

	pi.on("session_shutdown", () => {
		if (widgetTimer) {
			clearInterval(widgetTimer);
			widgetTimer = null;
		}
		for (const watcher of laneWatchers.values()) {
			watcher.killed = true;
			try {
				watcher.proc.kill("SIGTERM");
			} catch {
				/* ignore */
			}
		}
		laneWatchers.clear();
		for (const [agentId, state] of agents) {
			killAgent(state);
			cleanup(agentId);
		}
	});
}
