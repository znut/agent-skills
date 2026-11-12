import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendRun,
	branchType,
	buildReviewPrompt,
	buildRunRow,
	candidatesFor,
	describeStatus,
	drawModel,
	extractTicket,
	findPrUrl,
	findReviewLinks,
	loadConfig,
	mergeConfig,
	normalizeConfig,
	parseModelSpec,
	parseNeedsHelp,
	parseVerdict,
	planWorktree,
	readRuns,
	resolveSkills,
	resolveWorktreesDir,
	resultMessage,
	scanAgentDirs,
	findAgentDir,
	resolvePingDir,
	reviewerFor,
	seededRandom,
	skillArgs,
	taskSlug,
	uniqueSlug,
	type RunRow,
	type Size,
} from "./engine";

const A = "anthropic/claude-sonnet-5-5:high";
const B = "openai-codex/gpt-6.1-sol:high";
const NOW = Date.parse("2026-06-15T12:00:00Z");
const DAY = 24 * 3600 * 1000;

function row(over: Partial<RunRow> & { spec?: string; ageDays?: number }): RunRow {
	const spec = parseModelSpec(over.spec ?? A);
	const { spec: _s, ageDays, ...rest } = over;
	return {
		ts: new Date(NOW - (ageDays ?? 1) * DAY).toISOString(),
		repo: "/r/one",
		branch: "feat/x",
		task: "t",
		ticket: null,
		size: "M",
		provider: spec.provider,
		model: spec.model,
		effort: spec.effort,
		review_rounds: 1,
		first_review: "pass",
		outcome: "pass",
		tokens_in: 1,
		tokens_out: 1,
		tokens_cache: 0,
		cost_usd: 1,
		wall_s: 100,
		why: "",
		...rest,
	};
}

const many = (n: number, over: Parameters<typeof row>[0]) => Array.from({ length: n }, () => row(over));

describe("parseModelSpec", () => {
	test("splits provider, model, effort", () => {
		expect(parseModelSpec(A)).toEqual({ raw: A, provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" });
		expect(parseModelSpec("openai-codex/gpt-6.1-sol:xhigh").effort).toBe("xhigh");
	});
	test("effort is optional and only real levels count", () => {
		expect(parseModelSpec("anthropic/claude-x").effort).toBeNull();
		expect(parseModelSpec("openrouter/vendor/model:free")).toMatchObject({ provider: "openrouter", model: "vendor/model:free", effort: null });
	});
	test("rejects bare names", () => {
		expect(() => parseModelSpec("sonnet")).toThrow();
	});
});

describe("config", () => {
	test("mergeConfig is shallow: repo keys replace global keys", () => {
		const merged = mergeConfig(
			{ draw: "learned", skills: { worker: ["a"], reviewer: ["b"] }, max_review_rounds: 2 },
			{ skills: { worker: ["c"] }, max_review_rounds: 3 },
		);
		expect(merged).toEqual({ draw: "learned", skills: { worker: ["c"] }, max_review_rounds: 3 });
		expect(mergeConfig(null, { draw: "uniform" })).toEqual({ draw: "uniform" });
		expect(mergeConfig({ draw: "uniform" }, undefined)).toEqual({ draw: "uniform" });
	});

	test("normalizeConfig applies defaults", () => {
		const cfg = normalizeConfig({ classes: { standard: [A], strong: [B] } });
		expect(cfg.draw).toBe("learned");
		expect(cfg.max_review_rounds).toBe(2);
		expect(cfg.size_class).toEqual({ S: "standard", M: "standard", L: "strong", XL: "strong" });
		expect(cfg.skills).toEqual({ worker: [], reviewer: [] });
		expect(cfg.worktrees_dir).toBe("<repo-parent>/<repo-name>-worktrees");
	});

	test("normalizeConfig validates", () => {
		expect(() => normalizeConfig({ draw: "greedy" })).toThrow();
		expect(() => normalizeConfig({ max_review_rounds: 0 })).toThrow();
		expect(() => normalizeConfig({ classes: { a: ["nonsense"] } })).toThrow();
		expect(() => normalizeConfig({ skills: { worker: "x" } })).toThrow();
	});

	test("loadConfig merges global and <repo>/.pi/subagents.json", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-cfg-"));
		const globalFile = path.join(dir, "global.json");
		fs.writeFileSync(globalFile, JSON.stringify({ classes: { standard: [A], strong: [B] }, max_review_rounds: 2, draw: "uniform" }));
		const repo = path.join(dir, "repo");
		fs.mkdirSync(path.join(repo, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(repo, ".pi", "subagents.json"), JSON.stringify({ max_review_rounds: 4 }));
		const cfg = loadConfig(repo, globalFile);
		expect(cfg.max_review_rounds).toBe(4);
		expect(cfg.draw).toBe("uniform");
		expect(cfg.classes.standard).toEqual([A]);
		// no per-repo file, no global file
		expect(loadConfig(path.join(dir, "other"), globalFile).max_review_rounds).toBe(2);
		expect(loadConfig(path.join(dir, "other"), path.join(dir, "missing.json")).classes).toEqual({});
	});

	test("loadConfig names the file with invalid JSON", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-cfg-"));
		const bad = path.join(dir, "bad.json");
		fs.writeFileSync(bad, "{nope");
		expect(() => loadConfig(dir, bad)).toThrow(bad);
	});

	test("resolveWorktreesDir expands placeholders", () => {
		const cfg = normalizeConfig({});
		expect(resolveWorktreesDir(cfg, "/src/agent-skills")).toBe("/src/agent-skills-worktrees");
		expect(resolveWorktreesDir({ ...cfg, worktrees_dir: "~/wt/<repo-name>" }, "/src/x")).toBe(path.join(os.homedir(), "wt", "x"));
	});

	test("candidatesFor picks the size's class and explains a missing one", () => {
		const cfg = normalizeConfig({ classes: { standard: [A], strong: [B] } });
		expect(candidatesFor(cfg, "S")).toEqual([A]);
		expect(candidatesFor(cfg, "XL")).toEqual([B]);
		expect(() => candidatesFor(normalizeConfig({}), "M")).toThrow(/standard/);
	});

	test("reviewerFor uses the map, else any other provider", () => {
		const cfg = normalizeConfig({
			classes: { standard: [A, B] },
			reviewer: { anthropic: "openai-codex/gpt-6.1-sol:high", "openai-codex": "anthropic/claude-opus-5-5:high" },
		});
		expect(reviewerFor(parseModelSpec(A), cfg).provider).toBe("openai-codex");
		expect(reviewerFor(parseModelSpec(B), cfg).provider).toBe("anthropic");
		const noMap = normalizeConfig({ classes: { standard: [A, B] } });
		expect(reviewerFor(parseModelSpec(A), noMap).raw).toBe(B);
		expect(() => reviewerFor(parseModelSpec(A), normalizeConfig({ classes: { standard: [A] } }))).toThrow();
		expect(() => reviewerFor(parseModelSpec(A), normalizeConfig({ reviewer: { anthropic: A } }))).toThrow(/different provider/);
	});
});

describe("skills", () => {
	const home = "/home/u";
	const present = new Set(["/home/u/.claude/skills/tl", "/home/u/.pi/agent/skill-library/pm.md", "/repo/skills/x"]);
	const exists = (p: string) => present.has(p);
	test("names resolve under the skill roots", () => {
		expect(resolveSkills(["tl", "pm"], { base: "/repo", home, exists })).toEqual(["/home/u/.claude/skills/tl", "/home/u/.pi/agent/skill-library/pm.md"]);
	});
	test("paths resolve against the repo, ~ against home", () => {
		expect(resolveSkills(["skills/x", "~/.claude/skills/tl"], { base: "/repo", home, exists })).toEqual(["/repo/skills/x", "/home/u/.claude/skills/tl"]);
	});
	test("missing skill throws", () => {
		expect(() => resolveSkills(["nope"], { base: "/repo", home, exists })).toThrow(/nope/);
	});
	test("skillArgs always disables discovery", () => {
		expect(skillArgs([])).toEqual(["--no-skills"]);
		expect(skillArgs(["/a", "/b"])).toEqual(["--no-skills", "--skill", "/a", "--skill", "/b"]);
	});
});

describe("seededRandom", () => {
	test("same seed, same stream; different seed differs", () => {
		const a = seededRandom("s");
		const b = seededRandom("s");
		const xs = [a(), a(), a()];
		expect(xs).toEqual([b(), b(), b()]);
		expect(seededRandom("t")()).not.toBe(xs[0]);
		expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
	});
});

describe("drawModel uniform", () => {
	test("covers all candidates and is seed-deterministic", () => {
		const draw = (seed: string) => drawModel({ candidates: [A, B], size: "M", repo: "/r", runs: [], mode: "uniform", rand: seededRandom(seed) }).spec.raw;
		const seen = new Set(Array.from({ length: 30 }, (_, i) => draw(`seed${i}`)));
		expect(seen).toEqual(new Set([A, B]));
		expect(draw("x")).toBe(draw("x"));
	});
	test("says so in why", () => {
		expect(drawModel({ candidates: [A], size: "S", repo: "/r", runs: [], mode: "uniform" }).why).toMatch(/uniform/);
	});
});

describe("drawModel learned", () => {
	const base = { candidates: [A, B], size: "M" as Size, repo: "/r/one", now: NOW, mode: "learned" as const };
	const statsOf = (runs: RunRow[], seed: string) => drawModel({ ...base, runs, rand: seededRandom(seed) });

	test("is deterministic under a seed", () => {
		const runs = [...many(12, { spec: A }), ...many(12, { spec: B, first_review: "block" })];
		for (const seed of ["a", "b", "c"]) expect(statsOf(runs, seed)).toEqual(statsOf(runs, seed));
	});

	test("favours the candidate with a better pass rate at equal cost/wall", () => {
		const runs = [...many(15, { spec: A, first_review: "pass" }), ...many(15, { spec: B, first_review: "block" })];
		let picksA = 0;
		for (let i = 0; i < 200; i++) if (statsOf(runs, `s${i}`).spec.raw === A) picksA++;
		expect(picksA).toBeGreaterThan(170);
	});

	test("favours the cheaper candidate at equal pass rate", () => {
		const runs = [...many(15, { spec: A, cost_usd: 0.1 }), ...many(15, { spec: B, cost_usd: 4 })];
		let picksA = 0;
		for (let i = 0; i < 200; i++) if (statsOf(runs, `s${i}`).spec.raw === A) picksA++;
		expect(picksA).toBeGreaterThan(170);
	});

	test("scope: repo+size when it has >= 5 runs", () => {
		const runs = [...many(5, { spec: A }), ...many(5, { spec: B })];
		const { why } = statsOf(runs, "x");
		expect(why).toContain("scope=repo+size");
		expect(why).toContain("n=5 ");
	});

	test("scope: falls back to repo (any size), then to all repos", () => {
		const repoOtherSize = [...many(6, { spec: A, size: "L" }), ...many(6, { spec: B, size: "L" })];
		expect(statsOf(repoOtherSize, "x").why).toContain("scope=repo ");
		const otherRepo = [...many(6, { spec: A, repo: "/r/two" }), ...many(6, { spec: B, repo: "/r/two" })];
		const w = statsOf(otherRepo, "x").why;
		expect(w).toContain("scope=all");
		expect(w).toMatch(/n=6 /);
		// <5 anywhere still reports scope all
		expect(statsOf(many(2, { spec: A }), "x").why).toContain("scope=all");
	});

	test("ignores runs older than 30 days", () => {
		const old = [...many(20, { spec: A, ageDays: 40 }), ...many(20, { spec: B, ageDays: 40 })];
		const { why } = statsOf(old, "x");
		expect(why).toContain("n=0 ");
		expect(why).toContain("a=1 b=1");
	});

	test("alpha/beta count first-review passes; blocks, errors and null are misses", () => {
		const runs = [
			...many(5, { spec: A, first_review: "pass" }),
			...many(2, { spec: A, first_review: "block", outcome: "block" }),
			row({ spec: A, first_review: null, outcome: "error" }),
		];
		const out = drawModel({ ...base, candidates: [A], runs, rand: seededRandom("k") });
		expect(out.why).toContain("a=6 b=4");
	});

	test("candidate without priced runs uses the cheapest known mean", () => {
		const runs = [...many(12, { spec: A, cost_usd: 0.3, wall_s: 50 }), ...many(12, { spec: B, cost_usd: 0, wall_s: 0 })];
		const picked = drawModel({ ...base, candidates: [B], runs, rand: seededRandom("k") });
		expect(picked.why).toContain("cost=1.0000"); // only B in play: nothing known -> 1
		// B alongside A borrows A's 0.3
		let sawFallback = false;
		for (let i = 0; i < 100 && !sawFallback; i++) {
			const r = drawModel({ ...base, candidates: [A, B], runs, rand: seededRandom(`q${i}`) });
			if (r.spec.raw === B && r.why.includes("cost=0.3000") && r.why.includes("wall=50s")) sawFallback = true;
		}
		expect(sawFallback).toBe(true);
	});

	test("explore: unseen candidates are tried ~20% of the time even when another wins", () => {
		// A is great with plenty of runs; B has never run anywhere.
		const runs = many(30, { spec: A });
		let explored = 0;
		let b = 0;
		const N = 1000;
		for (let i = 0; i < N; i++) {
			const r = statsOf(runs, `e${i}`);
			if (r.why.includes("path=explore")) explored++;
			if (r.spec.raw === B) b++;
		}
		expect(explored / N).toBeGreaterThan(0.12);
		expect(explored / N).toBeLessThan(0.28);
		expect(b).toBeGreaterThanOrEqual(explored); // explore always lands on the unseen B
	});

	test("explore pool: only candidates below 10 runs; none -> never explores", () => {
		const runs = [...many(12, { spec: A }), ...many(12, { spec: B })];
		for (let i = 0; i < 300; i++) expect(statsOf(runs, `n${i}`).why).toContain("path=score");
		const some = [...many(12, { spec: A }), ...many(3, { spec: B })];
		let explored = 0;
		for (let i = 0; i < 500; i++) {
			const r = statsOf(some, `m${i}`);
			if (r.why.includes("path=explore")) {
				explored++;
				expect(r.spec.raw).toBe(B);
			}
		}
		expect(explored).toBeGreaterThan(30);
	});

	test("one candidate always wins", () => {
		expect(drawModel({ ...base, candidates: [A], runs: [], rand: seededRandom("1") }).spec.raw).toBe(A);
	});

	test("no candidates throws", () => {
		expect(() => drawModel({ ...base, candidates: [], runs: [] })).toThrow();
	});
});

describe("run rows", () => {
	test("buildRunRow", () => {
		const r = buildRunRow({
			ts: new Date("2026-06-15T12:00:00Z"),
			repo: "/r/one",
			branch: "feat/a-thing",
			task: "\n  Add a thing\nmore detail (see #42, not #7)",
			size: "M",
			spec: parseModelSpec(A),
			reviewRounds: 2,
			firstReview: "block",
			outcome: "pass",
			usage: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 20, cost: 0.123456789 },
			wallMs: 61_234,
			why: "learned …",
		});
		expect(r).toEqual({
			ts: "2026-06-15T12:00:00.000Z",
			repo: "/r/one",
			branch: "feat/a-thing",
			task: "Add a thing",
			ticket: 42,
			size: "M",
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			effort: "high",
			review_rounds: 2,
			first_review: "block",
			outcome: "pass",
			tokens_in: 100,
			tokens_out: 50,
			tokens_cache: 1020,
			cost_usd: 0.123457,
			wall_s: 61.2,
			why: "learned …",
		});
	});

	test("extractTicket: first #<digits> anywhere in the task, else null", () => {
		expect(extractTicket("fix: login (#123)")).toBe(123);
		expect(extractTicket("first line\nsee #9 and #10")).toBe(9);
		expect(extractTicket("no ticket, # alone, #abc")).toBeNull();
		expect(extractTicket("")).toBeNull();
	});

	test("missing usage becomes zeros; null first_review is kept", () => {
		const r = buildRunRow({ repo: "/r", branch: "b", task: "t", size: null, spec: parseModelSpec(B), reviewRounds: 0, firstReview: null, outcome: "error", usage: {}, wallMs: 0, why: "explicit" });
		expect(r).toMatchObject({ tokens_in: 0, tokens_cache: 0, cost_usd: 0, wall_s: 0, first_review: null, size: null });
	});

	test("appendRun / readRuns round-trip and skip torn lines", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-runs-"));
		const file = path.join(dir, "nested", "runs.jsonl");
		expect(readRuns(file)).toEqual([]);
		appendRun(row({}), file);
		fs.appendFileSync(file, "{torn\n");
		appendRun(row({ branch: "feat/y" }), file);
		expect(readRuns(file).map((r) => r.branch)).toEqual(["feat/x", "feat/y"]);
	});
});

describe("verdicts", () => {
	test("PASS", () => {
		expect(parseVerdict("VERDICT: PASS\n\nNits: none")).toEqual({ verdict: "pass", findings: "Nits: none" });
	});
	test("BLOCK with findings", () => {
		const v = parseVerdict("VERDICT: BLOCK\n1. a.ts:3 off by one\n2. missing test");
		expect(v.verdict).toBe("block");
		expect(v.findings).toBe("1. a.ts:3 off by one\n2. missing test");
	});
	test("tolerates markdown decoration and trailing verdict", () => {
		expect(parseVerdict("Looks fine.\n\n**VERDICT: PASS**").verdict).toBe("pass");
		expect(parseVerdict("1. bad\n`VERDICT: BLOCK`").verdict).toBe("block");
	});
	test("last verdict wins; mid-sentence mentions do not count", () => {
		expect(parseVerdict("VERDICT: BLOCK\n...\nVERDICT: PASS").verdict).toBe("pass");
		expect(parseVerdict("I would say VERDICT: PASS if tests ran").verdict).toBeNull();
	});
	test("no verdict", () => {
		expect(parseVerdict("looks ok to me").verdict).toBeNull();
		expect(parseVerdict("").verdict).toBeNull();
	});
	test("needs-help signal and PR url", () => {
		expect(parseNeedsHelp("did some work\nNEEDS_HELP: which db should I use?")).toBe("which db should I use?");
		expect(parseNeedsHelp("all done")).toBeNull();
		expect(findPrUrl("opened https://github.com/o/r/pull/12 and\nhttps://github.com/o/r/pull/13\n")).toBe("https://github.com/o/r/pull/13");
		expect(findPrUrl("nothing")).toBeNull();
	});
});

describe("slug and worktree naming", () => {
	test("taskSlug", () => {
		expect(taskSlug("Add the Foo widget to the dashboard")).toBe("add-the-foo-widget-to-the-dashboard");
		expect(taskSlug("\n\n  fix(api): handle empty body!  \nlong rest")).toBe("handle-empty-body");
		expect(taskSlug("Ünïcode café")).toBe("unicode-cafe");
		expect(taskSlug("???")).toBe("task");
		expect(taskSlug("")).toBe("task");
		const long = taskSlug("implement an extraordinarily descriptive feature name that keeps going and going");
		expect(long.length).toBeLessThanOrEqual(40);
		expect(long.endsWith("-")).toBe(false);
		expect(taskSlug("x".repeat(80)).length).toBe(40);
	});
	test("branchType", () => {
		expect(branchType("fix(api): x")).toBe("fix");
		expect(branchType("Fix the thing")).toBe("fix");
		expect(branchType("docs: update")).toBe("docs");
		expect(branchType("Add a widget")).toBe("feat");
		expect(branchType("")).toBe("feat");
	});
	test("uniqueSlug", () => {
		expect(uniqueSlug("a", () => false)).toBe("a");
		expect(uniqueSlug("a", (s) => s === "a" || s === "a-2")).toBe("a-3");
	});
	test("planWorktree avoids taken branches and directories", () => {
		const plan = planWorktree({ task: "fix: login bug", worktreesDir: "/wt/repo-worktrees", branchExists: () => false, pathExists: () => false });
		expect(plan).toEqual({ type: "fix", slug: "login-bug", branch: "fix/login-bug", dir: "/wt/repo-worktrees/login-bug" });
		const again = planWorktree({
			task: "fix: login bug",
			worktreesDir: "/wt/repo-worktrees",
			branchExists: (b) => b === "fix/login-bug",
			pathExists: (p) => p === "/wt/repo-worktrees/login-bug-2",
		});
		expect(again.slug).toBe("login-bug-3");
		expect(again.branch).toBe("fix/login-bug-3");
	});
});

describe("status text", () => {
	test("resultMessage: output before stderr; stderr only when output empty", () => {
		expect(resultMessage({ output: "did it", stderr: "warn: noisy" })).toBe("did it");
		expect(resultMessage({ output: "", stderr: "boom" })).toBe("boom");
		expect(resultMessage({ output: "partial", errorMessage: "429" })).toBe("partial | error: 429");
		expect(resultMessage({ output: "", stderr: "" })).toBeUndefined();
		expect(resultMessage({ output: "x".repeat(900) })?.length).toBe(501);
	});
	test("describeStatus shows output (clipped) and hides stderr when there is output", () => {
		const t = describeStatus("id1", { status: "done" }, { output: "a".repeat(600), stderr: "SECRET" });
		expect(t).toContain("status: done");
		expect(t).toContain("Output: " + "a".repeat(500));
		expect(t).not.toContain("SECRET");
		expect(describeStatus("id1", { status: "error" }, { output: "", stderr: "boom" })).toContain("stderr: boom");
		expect(describeStatus("id1", { status: "done", message: "all good" }, null)).toBe("Subagent id1 status: done — all good");
	});
});

describe("review prompt", () => {
	test("findReviewLinks picks local review/checklist links only", () => {
		const md = "See [review checklist](docs/REVIEW.md#x), [site](https://x.dev/review), [style](docs/style.md), [Code Review](./rv.md).";
		expect(findReviewLinks(md)).toEqual(["docs/REVIEW.md", "./rv.md"]);
	});
	test("buildReviewPrompt carries task, diff, AGENTS.md and the verdict contract", () => {
		const p = buildReviewPrompt({
			task: "Do the thing",
			base: "a".repeat(40),
			tip: "b".repeat(40),
			diff: "diff --git a/x b/x\n+1",
			agentsMd: "RULES HERE",
			linked: [{ path: "docs/REVIEW.md", text: "CHECKLIST" }],
		});
		for (const s of ["Do the thing", "+1", "RULES HERE", "CHECKLIST", "VERDICT: PASS", "VERDICT: BLOCK", "aaaaaaaaaaaa..bbbbbbbbbbbb"]) expect(p).toContain(s);
	});
	test("a huge diff is truncated with a hint", () => {
		const p = buildReviewPrompt({ task: "t", base: "a", tip: "b", diff: "x".repeat(400_000), agentsMd: null, linked: [] });
		expect(p.length).toBeLessThan(200_000);
		expect(p).toContain("truncated");
	});
});

describe("agent state dirs", () => {
	function mk(root: string, project: string, id: string, owner: string | null) {
		const dir = path.join(root, project, id);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "live.json"), JSON.stringify(owner ? { ownerId: owner, status: "running" } : { status: "running" }));
		return dir;
	}

	test("scanAgentDirs finds the owner's agents under every project root, not just the manager's", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-scan-"));
		const managerProject = mk(root, "aaaa", "manager-child", "S1");
		const worktreeWorker = mk(root, "bbbb", "worktree-worker", "S1");
		mk(root, "bbbb", "other-session", "S2");
		mk(root, "cccc", "no-owner", null);
		fs.writeFileSync(path.join(root, "aaaa", ".cwd"), "/x");
		fs.mkdirSync(path.join(root, "dddd", "empty-dir"), { recursive: true });
		fs.writeFileSync(path.join(root, "stray-file"), "x");
		const found = scanAgentDirs(root, "S1");
		expect(found.map((f) => f.id).sort()).toEqual(["manager-child", "worktree-worker"]);
		expect(found.find((f) => f.id === "worktree-worker")?.dir).toBe(worktreeWorker);
		expect(found.find((f) => f.id === "manager-child")?.dir).toBe(managerProject);
		expect(scanAgentDirs(root, "S2").map((f) => f.id)).toEqual(["other-session"]);
		expect(scanAgentDirs(root, "nobody")).toEqual([]);
		expect(scanAgentDirs(path.join(root, "missing"), "S1")).toEqual([]);
	});

	test("findAgentDir locates an id in any project root", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-find-"));
		const dir = mk(root, "bbbb", "w1", "S1");
		expect(findAgentDir(root, "w1")).toBe(dir);
		expect(findAgentDir(root, "nope")).toBeNull();
	});

	test("resolvePingDir allows self or same-owner agents only", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-ping-"));
		const mine = mk(root, "aaaa", "mine", "S1");
		const child = mk(root, "bbbb", "child", "S1");
		const foreign = mk(root, "bbbb", "foreign", "S2");
		const orphan = mk(root, "cccc", "orphan", null);
		const asManager = { owner: "S1" };
		expect(resolvePingDir(root, "child", asManager)).toBe(child);
		expect(resolvePingDir(root, "foreign", asManager)).toBeNull();
		expect(resolvePingDir(root, "orphan", asManager)).toBeNull();
		expect(resolvePingDir(root, "missing", asManager)).toBeNull();
		// A subagent pings itself via env even with a different owner lookup.
		const self = { selfId: "foreign", selfDir: foreign, owner: "S1" };
		expect(resolvePingDir(root, "foreign", self)).toBe(foreign);
		// ...but not a sibling it does not own.
		expect(resolvePingDir(root, "orphan", { selfId: "mine", selfDir: mine, owner: "S1" })).toBeNull();
		expect(orphan).toBeTruthy();
	});
});
