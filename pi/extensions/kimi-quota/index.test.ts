import { describe, expect, it } from "bun:test";
import {
	formatSegment,
	parseOpenAIHeaders,
	parseOpenAIUsage,
	parseUsages,
} from "./index";

describe("plan quota parsing", () => {
	it("parses Kimi short and weekly windows", () => {
		const snapshot = parseUsages({
			limits: [
				{
					window: { duration: 5, timeUnit: "HOUR" },
					detail: { limit: 100, used: 54 },
				},
			],
			usage: { limit: 100, remaining: 59 },
		});

		expect(snapshot?.windows.map(({ label }) => label)).toEqual(["5h", "wk"]);
		expect(snapshot && formatSegment(snapshot)).toBe("5h:54%(?) wk:41%(?)");
	});

	it("parses OpenAI usage endpoint windows", () => {
		const snapshot = parseOpenAIUsage({
			rate_limit: {
				primary_window: {
					used_percent: 78,
					limit_window_seconds: 18_000,
					reset_at: 1_788_037_911,
				},
				secondary_window: {
					used_percent: 19,
					limit_window_seconds: 604_800,
					reset_at: 1_788_452_665,
				},
			},
		});

		expect(snapshot?.windows.map(({ label, w }) => [label, w.used])).toEqual([
			["5h", 78],
			["wk", 19],
		]);
	});

	it("uses OpenAI response rate-limit headers when available", () => {
		const snapshot = parseOpenAIHeaders({
			"X-Codex-Primary-Used-Percent": "81",
			"X-Codex-Primary-Window-Minutes": "300",
			"X-Codex-Primary-Reset-At": "1788037911",
			"x-codex-secondary-used-percent": "20",
			"x-codex-secondary-window-minutes": "10080",
			"x-codex-secondary-reset-at": "1788452665",
		});

		expect(snapshot?.windows.map(({ label, w }) => [label, w.used])).toEqual([
			["5h", 81],
			["wk", 20],
		]);
	});
});
