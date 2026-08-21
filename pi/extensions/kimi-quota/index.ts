/**
 * pi kimi-quota extension
 *
 * Polls the Kimi Code quota endpoint (`GET /coding/v1/usages` — same one the
 * kimi.com/code console uses, readable with the plain `kimi-coding` API key)
 * and shows a persistent footer segment:
 *
 *   5h:54%(10:03am) wk:41%(sat 9:03pm)
 *
 * % = used, reset times in local tz. Turns warning-colored when the 5h window
 * has ≤15% left or the weekly ≤20% left. Polls every KIMI_QUOTA_POLL_SECONDS
 * (default 60, 0 disables) plus a throttled refresh after each agent turn.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "kimi-quota";
const USAGES_URL = "https://api.kimi.com/coding/v1/usages";
const FETCH_TIMEOUT_MS = 10_000;
const TURN_REFRESH_MIN_MS = 20_000;

interface QuotaWindow {
	used: number;
	limit: number;
	resetTime?: string;
}

interface QuotaSnapshot {
	windows: { label: string; w: QuotaWindow }[]; // e.g. [{5h},{wk}]
	fetchedAt: number;
}

export function readKimiCredential(): string | null {
	try {
		const auth = JSON.parse(
			fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf-8"),
		);
		const entry = auth?.["kimi-coding"];
		if (!entry) return null;
		if (typeof entry.key === "string" && entry.key.trim()) return entry.key.trim();
		if (typeof entry.access === "string" && entry.access.trim()) return entry.access.trim();
		return null;
	} catch {
		return null;
	}
}

function toNum(v: unknown): number | null {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function windowMinutes(w: unknown): number | null {
	if (typeof w !== "object" || w === null) return null;
	const r = w as Record<string, unknown>;
	const duration = toNum(r.duration);
	const unit = String(r.timeUnit ?? r.time_unit ?? "").toUpperCase();
	if (!duration) return null;
	if (unit.includes("MINUTE")) return duration;
	if (unit.includes("HOUR")) return duration * 60;
	if (unit.includes("DAY")) return duration * 60 * 24;
	if (unit.includes("WEEK")) return duration * 60 * 24 * 7;
	return null;
}

function parseRow(v: unknown): QuotaWindow | null {
	if (typeof v !== "object" || v === null) return null;
	const r = v as Record<string, unknown>;
	const limit = toNum(r.limit);
	const usedRaw = toNum(r.used);
	const remaining = toNum(r.remaining);
	const used = usedRaw ?? (limit !== null && remaining !== null ? limit - remaining : null);
	if (limit === null || used === null) return null;
	const reset = typeof r.resetTime === "string" ? r.resetTime : undefined;
	return { used, limit, ...(reset ? { resetTime: reset } : {}) };
}

export function parseUsages(payload: unknown): QuotaSnapshot | null {
	if (typeof payload !== "object" || payload === null) return null;
	const r = payload as Record<string, unknown>;
	const windows: { label: string; w: QuotaWindow }[] = [];

	if (Array.isArray(r.limits)) {
		for (const item of r.limits) {
			if (typeof item !== "object" || item === null) continue;
			const rec = item as Record<string, unknown>;
			const mins = windowMinutes(rec.window);
			const row = parseRow(rec.detail ?? rec);
			if (!mins || !row) continue;
			const label =
				mins % (60 * 24 * 7) === 0
					? `${mins / (60 * 24 * 7)}wk`
					: mins % (60 * 24) === 0
						? `${mins / (60 * 24)}d`
						: mins % 60 === 0
							? `${mins / 60}h`
							: `${mins}m`;
			windows.push({ label, w: row });
		}
	}
	const weekly = parseRow(r.usage);
	if (weekly) windows.push({ label: "wk", w: weekly });
	if (windows.length === 0) return null;
	// shortest window first, weekly (usage) last
	return { windows, fetchedAt: Date.now() };
}

function fmtTime(d: Date): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		hour: "numeric",
		hour12: true,
		minute: "2-digit",
	}).formatToParts(d);
	const h = parts.find((p) => p.type === "hour")?.value ?? "";
	const m = parts.find((p) => p.type === "minute")?.value ?? "";
	const ap = (parts.find((p) => p.type === "dayPeriod")?.value ?? "").toLowerCase();
	return `${h}:${m}${ap}`;
}

function fmtReset(resetTime: string | undefined, withWeekday: boolean): string {
	if (!resetTime) return "?";
	const d = new Date(resetTime);
	if (Number.isNaN(d.getTime())) return "?";
	const t = fmtTime(d);
	if (!withWeekday) return t;
	const wd = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(d).toLowerCase();
	return `${wd} ${t}`;
}

export function formatSegment(snap: QuotaSnapshot): string {
	return snap.windows
		.map(({ label, w }) => {
			const pct = w.limit > 0 ? Math.round((w.used / w.limit) * 100) : 0;
			const weekly = label === "wk" || label.endsWith("wk");
			return `${label}:${pct}%(${fmtReset(w.resetTime, weekly)})`;
		})
		.join(" ");
}

export function lowestRemainingPct(snap: QuotaSnapshot): number {
	let min = 100;
	for (const { w } of snap.windows) {
		if (w.limit <= 0) continue;
		min = Math.min(min, Math.round(((w.limit - w.used) / w.limit) * 100));
	}
	return min;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let lastGood: QuotaSnapshot | null = null;
	let lastFetch = 0;
	let failures = 0;
	let ui: { setStatus: (key: string, text?: string) => void; theme: any } | null = null;

	const render = () => {
		if (!ui) return;
		if (!lastGood) {
			ui.setStatus(STATUS_KEY, ui.theme.fg("dim", "quota:…"));
			return;
		}
		const text = formatSegment(lastGood);
		const stale = failures > 0 ? `${text}?` : text;
		ui.setStatus(
			STATUS_KEY,
			lowestRemainingPct(lastGood) <= 15 ? ui.theme.fg("warning", stale) : stale,
		);
	};

	const refresh = async () => {
		const token = readKimiCredential();
		if (!token) {
			failures++;
			render();
			return;
		}
		lastFetch = Date.now();
		try {
			const res = await fetch(USAGES_URL, {
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(String(res.status));
			const snap = parseUsages(await res.json());
			if (!snap) throw new Error("no windows");
			lastGood = snap;
			failures = 0;
		} catch {
			failures++;
		}
		render();
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ui = ctx.ui;
		render();
		void refresh();
		const pollSec = Math.max(0, Number(process.env.KIMI_QUOTA_POLL_SECONDS ?? 60) || 0);
		if (pollSec > 0)
			timer = setInterval(() => void refresh(), pollSec * 1000);
	});

	pi.on("agent_end", () => {
		if (!ui) return;
		if (Date.now() - lastFetch < TURN_REFRESH_MIN_MS) return;
		void refresh();
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = null;
		if (ui) ui.setStatus(STATUS_KEY, undefined);
		ui = null;
	});
}
