// Footer `ant $197.26/200 →21 Nov`: Anthropic API credit left this cycle, as a
// local tally. Anthropic has no balance endpoint for a plain API key, so this
// subtracts the cost pi records (session files + subagent result.json) since the
// cycle start. Spend outside pi (Claude Code, Console) is not counted.
//
// ANT_BUDGET_USD   budget per cycle (default 200)
// ANT_CYCLE_DAY    UTC day of month the cycle resets at 00:00 (default 21)
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const STATUS_KEY = "ant-budget";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const SESSIONS_DIR = path.join(AGENT_DIR, "sessions");
const SUBAGENTS_DIR = path.join(AGENT_DIR, "subagents");
const ANTHROPIC_MODEL = /claude|anthropic|sonnet|opus|fable|haiku/i;

export function cycleBounds(now: Date, day: number): { start: number; end: number } {
	const y = now.getUTCFullYear();
	const m = now.getUTCMonth();
	const thisMonth = Date.UTC(y, m, day);
	const start = now.getTime() >= thisMonth ? thisMonth : Date.UTC(y, m - 1, day);
	const s = new Date(start);
	return { start, end: Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, day) };
}

function entryTime(e: any): number {
	const ts = e?.timestamp ?? e?.message?.timestamp;
	if (typeof ts === "number") return ts;
	if (typeof ts === "string") return Date.parse(ts) || 0;
	return 0;
}

/** Anthropic cost in one session file at or after `since`. */
export function sessionSpend(text: string, since: number): number {
	let sum = 0;
	for (const line of text.split("\n")) {
		if (!line.includes('"anthropic"')) continue;
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		const m = e.type === "message" ? e.message : e.type === "usage" ? e : null;
		if (m?.provider !== "anthropic" || entryTime(e) < since) continue;
		sum += m.usage?.cost?.total ?? 0;
	}
	return sum;
}

function walk(dir: string, match: (f: string) => boolean, out: string[] = []): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const d of entries) {
		const p = path.join(dir, d.name);
		if (d.isDirectory()) walk(p, match, out);
		else if (match(d.name)) out.push(p);
	}
	return out;
}

// Per-file cache keyed on mtime + size so a refresh rereads only changed files.
const cache = new Map<string, { key: string; cost: number }>();

function cached(file: string, since: number, read: (text: string) => number): number {
	let st: fs.Stats;
	try {
		st = fs.statSync(file);
	} catch {
		return 0;
	}
	if (st.mtimeMs < since) return 0;
	const key = `${since}:${st.mtimeMs}:${st.size}`;
	const hit = cache.get(file);
	if (hit?.key === key) return hit.cost;
	let cost = 0;
	try {
		cost = read(fs.readFileSync(file, "utf-8"));
	} catch {}
	cache.set(file, { key, cost });
	return cost;
}

export function spendSince(since: number): number {
	let sum = 0;
	for (const f of walk(SESSIONS_DIR, (n) => n.endsWith(".jsonl"))) {
		sum += cached(f, since, (t) => sessionSpend(t, since));
	}
	// Subagents run with --no-session; their cost lives only in result.json.
	for (const f of walk(SUBAGENTS_DIR, (n) => n === "result.json")) {
		sum += cached(f, since, (t) => {
			const r = JSON.parse(t);
			if ((r.startedAt ?? 0) < since) return 0;
			if (r.model && !ANTHROPIC_MODEL.test(`${r.model} ${r.modelName ?? ""}`)) return 0;
			return r.usage?.cost ?? 0;
		});
	}
	return sum;
}

export default function (pi: ExtensionAPI) {
	let ui: { setStatus: (key: string, text?: string) => void; theme: any } | null = null;
	const budget = Number(process.env.ANT_BUDGET_USD) || 200;
	const day = Number(process.env.ANT_CYCLE_DAY) || 21;

	const render = () => {
		if (!ui) return;
		const { start, end } = cycleBounds(new Date(), day);
		const left = budget - spendSince(start);
		const reset = new Date(end).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
		const text = `ant $${left.toFixed(2)}/${budget} →${reset}`;
		ui.setStatus(STATUS_KEY, left / budget <= 0.15 ? ui.theme.fg("warning", text) : text);
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ui = ctx.ui;
		render();
	});
	pi.on("agent_end", () => render());
	pi.on("session_shutdown", () => {
		ui?.setStatus(STATUS_KEY, undefined);
		ui = null;
	});
}
