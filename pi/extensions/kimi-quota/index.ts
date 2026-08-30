/**
 * pi plan-quota extension
 *
 * Polls the Kimi Code and OpenAI Codex plan-usage endpoints and shows one
 * persistent footer segment:
 *
 *   kimi 5h:54%(10:03am) wk:41%(sat 9:03pm) | oai 5h:78%(1:32am) wk:19%(tue 12:04am)
 *
 * % = used, reset times in local tz. A provider turns warning-colored when a
 * window has <=15% left. Polls every QUOTA_POLL_SECONDS (default 60) plus a
 * throttled refresh after each agent turn.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "plan-quota";
const KIMI_USAGES_URL = "https://api.kimi.com/coding/v1/usages";
const OPENAI_USAGES_URL = "https://chatgpt.com/backend-api/wham/usage";
const FETCH_TIMEOUT_MS = 10_000;
const TURN_REFRESH_MIN_MS = 20_000;

interface QuotaWindow {
	used: number;
	limit: number;
	resetTime?: string;
}

export interface QuotaSnapshot {
	windows: { label: string; w: QuotaWindow }[];
	fetchedAt: number;
}

interface OpenAICredential {
	access: string;
	accountId: string;
}

interface ProviderState {
	lastGood: QuotaSnapshot | null;
	failures: number;
}

function readAuth(): Record<string, unknown> | null {
	try {
		return JSON.parse(
			fs.readFileSync(
				path.join(os.homedir(), ".pi", "agent", "auth.json"),
				"utf-8",
			),
		) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function readKimiCredential(): string | null {
	const auth = readAuth();
	const entry = auth?.["kimi-coding"] as Record<string, unknown> | undefined;
	if (!entry) return null;
	if (typeof entry.key === "string" && entry.key.trim())
		return entry.key.trim();
	if (typeof entry.access === "string" && entry.access.trim())
		return entry.access.trim();
	return null;
}

export function readOpenAICredential(): OpenAICredential | null {
	const auth = readAuth();
	const entry = auth?.["openai-codex"] as Record<string, unknown> | undefined;
	if (!entry) return null;
	const access = typeof entry.access === "string" ? entry.access.trim() : "";
	const accountId =
		typeof entry.accountId === "string" ? entry.accountId.trim() : "";
	return access && accountId ? { access, accountId } : null;
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

function windowLabel(minutes: number): string {
	if (minutes === 60 * 24 * 7) return "wk";
	if (minutes % (60 * 24 * 7) === 0) return `${minutes / (60 * 24 * 7)}wk`;
	if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

function parseRow(v: unknown): QuotaWindow | null {
	if (typeof v !== "object" || v === null) return null;
	const r = v as Record<string, unknown>;
	const limit = toNum(r.limit);
	const usedRaw = toNum(r.used);
	const remaining = toNum(r.remaining);
	const used =
		usedRaw ??
		(limit !== null && remaining !== null ? limit - remaining : null);
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
			windows.push({ label: windowLabel(mins), w: row });
		}
	}
	const weekly = parseRow(r.usage);
	if (weekly) windows.push({ label: "wk", w: weekly });
	if (windows.length === 0) return null;
	return { windows, fetchedAt: Date.now() };
}

function parseOpenAIWindow(
	value: unknown,
): { minutes: number; w: QuotaWindow } | null {
	if (typeof value !== "object" || value === null) return null;
	const row = value as Record<string, unknown>;
	const usedPercent = toNum(row.used_percent);
	const windowSeconds = toNum(row.limit_window_seconds);
	const resetAt = toNum(row.reset_at);
	const resetAfter = toNum(row.reset_after_seconds);
	if (usedPercent === null || !windowSeconds) return null;
	const resetDate =
		resetAt !== null
			? new Date(resetAt * 1000)
			: resetAfter !== null
				? new Date(Date.now() + resetAfter * 1000)
				: null;
	const resetTime =
		resetDate && !Number.isNaN(resetDate.getTime())
			? resetDate.toISOString()
			: undefined;
	return {
		minutes: windowSeconds / 60,
		w: { used: usedPercent, limit: 100, ...(resetTime ? { resetTime } : {}) },
	};
}

export function parseOpenAIUsage(payload: unknown): QuotaSnapshot | null {
	if (typeof payload !== "object" || payload === null) return null;
	const rateLimit = (payload as Record<string, unknown>).rate_limit;
	if (typeof rateLimit !== "object" || rateLimit === null) return null;
	const row = rateLimit as Record<string, unknown>;
	const windows: { label: string; w: QuotaWindow }[] = [];

	for (const key of ["primary_window", "secondary_window"] as const) {
		const parsed = parseOpenAIWindow(row[key]);
		if (!parsed) continue;
		windows.push({ label: windowLabel(parsed.minutes), w: parsed.w });
	}

	return windows.length > 0 ? { windows, fetchedAt: Date.now() } : null;
}

function headerValue(
	headers: Record<string, string>,
	name: string,
): string | undefined {
	const direct = headers[name];
	if (direct !== undefined) return direct;
	const entry = Object.entries(headers).find(
		([key]) => key.toLowerCase() === name,
	);
	return entry?.[1];
}

function parseOpenAIHeaderWindow(
	headers: Record<string, string>,
	window: "primary" | "secondary",
): { label: string; w: QuotaWindow } | null {
	const prefix = `x-codex-${window}`;
	const usedPercent = toNum(headerValue(headers, `${prefix}-used-percent`));
	const windowMinutes = toNum(headerValue(headers, `${prefix}-window-minutes`));
	const resetAt = toNum(headerValue(headers, `${prefix}-reset-at`));
	if (usedPercent === null || !windowMinutes) return null;
	const resetDate = resetAt !== null ? new Date(resetAt * 1000) : null;
	const resetTime =
		resetDate && !Number.isNaN(resetDate.getTime())
			? resetDate.toISOString()
			: undefined;
	return {
		label: windowLabel(windowMinutes),
		w: { used: usedPercent, limit: 100, ...(resetTime ? { resetTime } : {}) },
	};
}

export function parseOpenAIHeaders(
	headers: Record<string, string>,
): QuotaSnapshot | null {
	const windows = (["primary", "secondary"] as const)
		.map((window) => parseOpenAIHeaderWindow(headers, window))
		.filter(
			(window): window is { label: string; w: QuotaWindow } => window !== null,
		);
	return windows.length > 0 ? { windows, fetchedAt: Date.now() } : null;
}

function fmtTime(d: Date): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		hour: "numeric",
		hour12: true,
		minute: "2-digit",
	}).formatToParts(d);
	const h = parts.find((p) => p.type === "hour")?.value ?? "";
	const m = parts.find((p) => p.type === "minute")?.value ?? "";
	const ap = (
		parts.find((p) => p.type === "dayPeriod")?.value ?? ""
	).toLowerCase();
	return `${h}:${m}${ap}`;
}

function fmtReset(resetTime: string | undefined, withWeekday: boolean): string {
	if (!resetTime) return "?";
	const d = new Date(resetTime);
	if (Number.isNaN(d.getTime())) return "?";
	const t = fmtTime(d);
	if (!withWeekday) return t;
	const wd = new Intl.DateTimeFormat("en-US", { weekday: "short" })
		.format(d)
		.toLowerCase();
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
	let lastFetch = 0;
	let openaiFromHeaders = false;
	let refreshInFlight: Promise<void> | null = null;
	let ui: {
		setStatus: (key: string, text?: string) => void;
		theme: any;
	} | null = null;
	const kimi: ProviderState = { lastGood: null, failures: 0 };
	const openai: ProviderState = { lastGood: null, failures: 0 };

	const renderProvider = (label: string, state: ProviderState) => {
		if (!ui) return "";
		if (!state.lastGood) return ui.theme.fg("dim", `${label} …`);
		const text = `${label} ${formatSegment(state.lastGood)}${state.failures > 0 ? "?" : ""}`;
		return lowestRemainingPct(state.lastGood) <= 15
			? ui.theme.fg("warning", text)
			: text;
	};

	const render = () => {
		if (!ui) return;
		ui.setStatus(
			STATUS_KEY,
			`${renderProvider("kimi", kimi)} ${ui.theme.fg("dim", "|")} ${renderProvider("oai", openai)}`,
		);
	};

	const refreshProvider = async (
		state: ProviderState,
		url: string,
		headers: Record<string, string> | null,
		parse: (payload: unknown) => QuotaSnapshot | null,
	) => {
		if (!headers) {
			state.failures++;
			return;
		}
		try {
			const res = await fetch(url, {
				headers,
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(String(res.status));
			const snap = parse(await res.json());
			if (!snap) throw new Error("no windows");
			state.lastGood = snap;
			state.failures = 0;
		} catch {
			state.failures++;
		}
	};

	const refresh = () => {
		if (refreshInFlight) return refreshInFlight;
		lastFetch = Date.now();
		refreshInFlight = (async () => {
			const kimiToken = readKimiCredential();
			const refreshes = [
				refreshProvider(
					kimi,
					KIMI_USAGES_URL,
					kimiToken ? { Authorization: `Bearer ${kimiToken}` } : null,
					parseUsages,
				),
			];
			if (!openaiFromHeaders) {
				const openaiCredential = readOpenAICredential();
				refreshes.push(
					refreshProvider(
						openai,
						OPENAI_USAGES_URL,
						openaiCredential
							? {
									Authorization: `Bearer ${openaiCredential.access}`,
									"ChatGPT-Account-ID": openaiCredential.accountId,
								}
							: null,
						parseOpenAIUsage,
					),
				);
			}
			await Promise.all(refreshes);
			render();
		})().finally(() => {
			refreshInFlight = null;
		});
		return refreshInFlight;
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ui = ctx.ui;
		render();
		void refresh();
		const configuredPollSeconds =
			process.env.QUOTA_POLL_SECONDS ??
			process.env.KIMI_QUOTA_POLL_SECONDS ??
			60;
		const pollSec = Math.max(0, Number(configuredPollSeconds) || 0);
		if (pollSec > 0) timer = setInterval(() => void refresh(), pollSec * 1000);
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.model?.provider !== "openai-codex") return;
		const snapshot = parseOpenAIHeaders(event.headers);
		if (!snapshot) return;
		openai.lastGood = snapshot;
		openai.failures = 0;
		openaiFromHeaders = true;
		render();
	});

	pi.on("agent_end", () => {
		if (!ui || Date.now() - lastFetch < TURN_REFRESH_MIN_MS) return;
		void refresh();
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = null;
		if (ui) ui.setStatus(STATUS_KEY, undefined);
		ui = null;
	});
}
