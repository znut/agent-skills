/**
 * Pure engine logic for the subagent extension: config, model draw, run log,
 * verdict parsing, slug/worktree naming, skill resolution and prompt builders.
 *
 * Nothing in here talks to pi or spawns processes, so `bun test` can import it
 * directly. Git/process plumbing lives in `git.ts`, orchestration in `index.ts`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Size = "S" | "M" | "L" | "XL";
export const SIZES: readonly Size[] = ["S", "M", "L", "XL"];

export type FirstReview = "pass" | "block" | null;
export type Outcome = "pass" | "block" | "stopped" | "error";

export interface ModelSpec {
	/** The string handed to `pi --model`, e.g. `anthropic/claude-sonnet-5-5:high`. */
	raw: string;
	provider: string;
	/** Model id without provider and effort. */
	model: string;
	/** Thinking level suffix, or null when the spec has none. */
	effort: string | null;
}

export interface Config {
	classes: Record<string, string[]>;
	size_class: Record<Size, string>;
	draw: "uniform" | "learned";
	reviewer: Record<string, string>;
	skills: { worker: string[]; reviewer: string[] };
	max_review_rounds: number;
	/** May contain `<repo-parent>` / `<repo-name>` placeholders and a leading `~`. */
	worktrees_dir: string;
}

export interface RunRow {
	ts: string;
	repo: string;
	branch: string;
	task: string;
	/** First `#<digits>` in the task text, as a number. */
	ticket: number | null;
	size: Size | null;
	provider: string;
	model: string;
	effort: string | null;
	review_rounds: number;
	first_review: FirstReview;
	outcome: Outcome;
	tokens_in: number;
	tokens_out: number;
	/** cache read + cache write tokens */
	tokens_cache: number;
	cost_usd: number;
	wall_s: number;
	why: string;
}

export interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
}

// ---------------------------------------------------------------------------
// Model specs
// ---------------------------------------------------------------------------

const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Parse `provider/model[:effort]`. Only a recognised thinking level counts as effort. */
export function parseModelSpec(raw: string): ModelSpec {
	let rest = raw.trim();
	let effort: string | null = null;
	const colon = rest.lastIndexOf(":");
	if (colon > 0 && EFFORTS.has(rest.slice(colon + 1))) {
		effort = rest.slice(colon + 1);
		rest = rest.slice(0, colon);
	}
	const slash = rest.indexOf("/");
	if (slash <= 0 || slash === rest.length - 1) {
		throw new Error(`model "${raw}" must look like provider/model[:effort]`);
	}
	return { raw: raw.trim(), provider: rest.slice(0, slash), model: rest.slice(slash + 1), effort };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const DEFAULT_SIZE_CLASS: Record<Size, string> = { S: "standard", M: "standard", L: "strong", XL: "strong" };
export const DEFAULT_WORKTREES_DIR = "<repo-parent>/<repo-name>-worktrees";

/** Shallow merge: every top-level key in `repo` replaces the one in `global`. */
export function mergeConfig(
	global: Record<string, unknown> | null | undefined,
	repo: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
	return { ...(global ?? {}), ...(repo ?? {}) };
}

function stringList(value: unknown, what: string): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
		throw new Error(`subagents config: ${what} must be an array of strings`);
	}
	return value as string[];
}

/** Apply defaults and validate a merged raw config. */
export function normalizeConfig(raw: Record<string, unknown>): Config {
	const classes: Record<string, string[]> = {};
	const rawClasses = (raw.classes ?? {}) as Record<string, unknown>;
	if (typeof rawClasses !== "object" || Array.isArray(rawClasses)) throw new Error("subagents config: classes must be an object");
	for (const [name, list] of Object.entries(rawClasses)) {
		const specs = stringList(list, `classes.${name}`);
		specs.forEach((s) => parseModelSpec(s));
		classes[name] = specs;
	}
	const size_class = { ...DEFAULT_SIZE_CLASS, ...((raw.size_class ?? {}) as Record<string, string>) } as Record<Size, string>;
	const draw = (raw.draw ?? "learned") as string;
	if (draw !== "uniform" && draw !== "learned") throw new Error(`subagents config: draw must be "uniform" or "learned"`);
	const reviewer = (raw.reviewer ?? {}) as Record<string, string>;
	for (const spec of Object.values(reviewer)) parseModelSpec(spec);
	const rawSkills = (raw.skills ?? {}) as { worker?: unknown; reviewer?: unknown };
	const max = raw.max_review_rounds ?? 2;
	if (typeof max !== "number" || !Number.isInteger(max) || max < 1) {
		throw new Error("subagents config: max_review_rounds must be an integer >= 1");
	}
	const wt = raw.worktrees_dir ?? DEFAULT_WORKTREES_DIR;
	if (typeof wt !== "string") throw new Error("subagents config: worktrees_dir must be a string");
	return {
		classes,
		size_class,
		draw,
		reviewer,
		skills: { worker: stringList(rawSkills.worker, "skills.worker"), reviewer: stringList(rawSkills.reviewer, "skills.reviewer") },
		max_review_rounds: max,
		worktrees_dir: wt,
	};
}

export function globalConfigPath(): string {
	return process.env.PI_SUBAGENT_CONFIG || path.join(os.homedir(), ".pi", "agent", "subagents.json");
}

function readJsonFile(file: string): Record<string, unknown> | null {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
		return parsed as Record<string, unknown>;
	} catch (e) {
		throw new Error(`invalid JSON in ${file}: ${(e as Error).message}`);
	}
}

/** Global config (read only) shallow-merged with `<repo>/.pi/subagents.json`. */
export function loadConfig(repoRoot: string, globalFile: string = globalConfigPath()): Config {
	const merged = mergeConfig(readJsonFile(globalFile), readJsonFile(path.join(repoRoot, ".pi", "subagents.json")));
	return normalizeConfig(merged);
}

export function resolveWorktreesDir(cfg: Config, repoRoot: string): string {
	let dir = cfg.worktrees_dir
		.replaceAll("<repo-parent>", path.dirname(repoRoot))
		.replaceAll("<repo-name>", path.basename(repoRoot));
	if (dir === "~" || dir.startsWith("~/")) dir = path.join(os.homedir(), dir.slice(1));
	return path.resolve(repoRoot, dir);
}

/** Candidates for a size, or throw a message that tells the user what to configure. */
export function candidatesFor(cfg: Config, size: Size): string[] {
	const cls = cfg.size_class[size];
	const list = cfg.classes[cls];
	if (!list || list.length === 0) {
		throw new Error(
			`no models configured for size ${size}: class "${cls}" is missing or empty (see subagents.json; example in pi/extensions/subagent/example.json)`,
		);
	}
	return list;
}

/** The reviewer model for a worker: the `reviewer` map, else any configured model on a different provider. */
export function reviewerFor(worker: ModelSpec, cfg: Config): ModelSpec {
	const mapped = cfg.reviewer[worker.provider];
	if (mapped) {
		const spec = parseModelSpec(mapped);
		if (spec.provider === worker.provider) {
			throw new Error(`reviewer for "${worker.provider}" must be on a different provider, got ${mapped}`);
		}
		return spec;
	}
	const pool = [...Object.values(cfg.reviewer), ...Object.values(cfg.classes).flat()];
	for (const raw of pool) {
		const spec = parseModelSpec(raw);
		if (spec.provider !== worker.provider) return spec;
	}
	throw new Error(`no reviewer on another provider than "${worker.provider}": add it to "reviewer" in subagents.json`);
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export function skillRoots(home: string = os.homedir()): string[] {
	return [path.join(home, ".pi", "agent", "skill-library"), path.join(home, ".claude", "skills")];
}

/**
 * Resolve skill entries to paths for `--skill`. Entries containing a slash (or
 * starting with `~`) are paths (relative ones resolve against `base`); bare
 * names are looked up under the skill roots as `<name>`, `<name>.md`.
 */
export function resolveSkills(
	entries: string[],
	opts: { base: string; home?: string; exists?: (p: string) => boolean },
): string[] {
	const home = opts.home ?? os.homedir();
	const exists = opts.exists ?? fs.existsSync;
	return entries.map((entry) => {
		if (entry.startsWith("~") || entry.includes("/")) {
			const expanded = entry === "~" || entry.startsWith("~/") ? path.join(home, entry.slice(1)) : entry;
			const resolved = path.resolve(opts.base, expanded);
			if (!exists(resolved)) throw new Error(`skill "${entry}" not found at ${resolved}`);
			return resolved;
		}
		const roots = skillRoots(home);
		for (const root of roots) {
			for (const candidate of [path.join(root, entry), path.join(root, `${entry}.md`)]) {
				if (exists(candidate)) return candidate;
			}
		}
		throw new Error(`skill "${entry}" not found under ${roots.join(" or ")}`);
	});
}

/** `pi` flags for a role's skills: skills are never auto-discovered. */
export function skillArgs(paths: string[]): string[] {
	return ["--no-skills", ...paths.flatMap((p) => ["--skill", p])];
}

// ---------------------------------------------------------------------------
// RNG + draw
// ---------------------------------------------------------------------------

/** mulberry32 over an FNV-1a hash of the seed string. */
export function seededRandom(seed: string): () => number {
	let h = 2166136261;
	for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
	let a = h >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Marsaglia-Tsang; every shape used here is >= 1. */
function sampleGamma(shape: number, rand: () => number): number {
	const d = shape - 1 / 3;
	const c = 1 / Math.sqrt(9 * d);
	for (;;) {
		const x = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
		const v = (1 + c * x) ** 3;
		if (v > 0 && Math.log(1 - rand()) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
	}
}

export function sampleBeta(a: number, b: number, rand: () => number): number {
	const x = sampleGamma(a, rand);
	return x / (x + sampleGamma(b, rand));
}

export const DRAW_WINDOW_DAYS = 30;
export const MIN_SCOPE_RUNS = 5;
export const EXPLORE_BELOW_RUNS = 10;
export const EXPLORE_P = 0.2;
const COST_POWER = 0.5;
const WALL_POWER = 0.5;
const DAY_MS = 24 * 3600 * 1000;

export interface DrawInput {
	candidates: string[];
	size: Size;
	repo: string;
	runs: RunRow[];
	now?: number;
	rand?: () => number;
	mode?: "uniform" | "learned";
}

export interface DrawResult {
	spec: ModelSpec;
	why: string;
}

type Scope = "repo+size" | "repo" | "all";

interface Ranked {
	spec: ModelSpec;
	scope: Scope;
	n: number;
	alpha: number;
	beta: number;
	cost: number;
	wall: number;
	score: number;
}

function sameModel(row: RunRow, spec: ModelSpec): boolean {
	return row.provider === spec.provider && row.model === spec.model && (row.effort ?? null) === spec.effort;
}

function mean(values: number[]): number | null {
	return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/**
 * Pick a model for a task. `uniform` is a random pick. `learned` is Thompson
 * sampling on first-review pass rate, divided by sqrt(avg cost * avg wall).
 * Odds are computed from the run log here; nothing is stored.
 */
export function drawModel(input: DrawInput): DrawResult {
	const rand = input.rand ?? Math.random;
	const now = input.now ?? Date.now();
	const specs = input.candidates.map(parseModelSpec);
	if (specs.length === 0) throw new Error("no candidates to draw from");

	if (input.mode === "uniform") {
		const spec = specs[Math.floor(rand() * specs.length)];
		return { spec, why: `uniform pick among ${specs.length} candidate(s) for size ${input.size}` };
	}

	const recent = input.runs.filter((r) => now - Date.parse(r.ts) <= DRAW_WINDOW_DAYS * DAY_MS);
	const stats = specs.map((spec) => {
		const own = recent.filter((r) => sameModel(r, spec));
		const bySize = own.filter((r) => r.repo === input.repo && r.size === input.size);
		const byRepo = own.filter((r) => r.repo === input.repo);
		const [scope, rows]: [Scope, RunRow[]] =
			bySize.length >= MIN_SCOPE_RUNS ? ["repo+size", bySize] : byRepo.length >= MIN_SCOPE_RUNS ? ["repo", byRepo] : ["all", own];
		const passes = rows.filter((r) => r.first_review === "pass").length;
		return {
			spec,
			scope,
			n: rows.length,
			alpha: 1 + passes,
			beta: 1 + rows.length - passes,
			cost: mean(rows.map((r) => r.cost_usd).filter((c) => c > 0)),
			wall: mean(rows.map((r) => r.wall_s).filter((w) => w > 0)),
		};
	});
	const knownCosts = stats.flatMap((s) => (s.cost == null ? [] : [s.cost]));
	const knownWalls = stats.flatMap((s) => (s.wall == null ? [] : [s.wall]));
	const costFallback = knownCosts.length ? Math.min(...knownCosts) : 1;
	const wallFallback = knownWalls.length ? Math.min(...knownWalls) : 1;

	const ranked: Ranked[] = stats
		.map((s) => {
			const cost = s.cost ?? costFallback;
			const wall = s.wall ?? wallFallback;
			const sample = sampleBeta(s.alpha, s.beta, rand);
			return { spec: s.spec, scope: s.scope, n: s.n, alpha: s.alpha, beta: s.beta, cost, wall, score: sample / (cost ** COST_POWER * wall ** WALL_POWER) };
		})
		.sort((a, b) => b.score - a.score);

	const under = ranked.filter((r) => r.n < EXPLORE_BELOW_RUNS);
	const unseen = under.filter((r) => r.n === 0);
	const pool = unseen.length ? unseen : under;
	const explore = pool.length > 0 && rand() < EXPLORE_P;
	const best = explore ? pool[Math.floor(rand() * pool.length)] : ranked[0];
	const why =
		`learned size=${input.size} scope=${best.scope} n=${best.n} a=${best.alpha} b=${best.beta} ` +
		`cost=${best.cost.toFixed(4)} wall=${best.wall.toFixed(0)}s score=${best.score.toFixed(4)} path=${explore ? "explore" : "score"}`;
	return { spec: best.spec, why };
}

// ---------------------------------------------------------------------------
// Run log
// ---------------------------------------------------------------------------

export function runsPath(): string {
	return process.env.PI_SUBAGENT_RUNS || path.join(os.homedir(), ".pi", "agent", "subagents", "runs.jsonl");
}

export function readRuns(file: string = runsPath()): RunRow[] {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	const rows: RunRow[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line) as RunRow);
		} catch {
			/* skip a torn line */
		}
	}
	return rows;
}

export function appendRun(row: RunRow, file: string = runsPath()): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(row)}\n`, "utf-8");
}

export function firstLine(text: string, max = 200): string {
	const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
	const trimmed = line.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** First `#<digits>` in the text (issue/ticket reference), else null. */
export function extractTicket(text: string): number | null {
	const m = text.match(/#(\d+)/);
	return m ? Number.parseInt(m[1], 10) : null;
}

export interface RunRowInput {
	ts?: Date;
	repo: string;
	branch: string;
	task: string;
	size: Size | null;
	spec: ModelSpec;
	reviewRounds: number;
	firstReview: FirstReview;
	outcome: Outcome;
	usage: Usage;
	wallMs: number;
	why: string;
}

export function buildRunRow(i: RunRowInput): RunRow {
	return {
		ts: (i.ts ?? new Date()).toISOString(),
		repo: i.repo,
		branch: i.branch,
		task: firstLine(i.task),
		ticket: extractTicket(i.task),
		size: i.size,
		provider: i.spec.provider,
		model: i.spec.model,
		effort: i.spec.effort,
		review_rounds: i.reviewRounds,
		first_review: i.firstReview,
		outcome: i.outcome,
		tokens_in: i.usage.input ?? 0,
		tokens_out: i.usage.output ?? 0,
		tokens_cache: (i.usage.cacheRead ?? 0) + (i.usage.cacheWrite ?? 0),
		cost_usd: Math.round((i.usage.cost ?? 0) * 1e6) / 1e6,
		wall_s: Math.round(i.wallMs / 100) / 10,
		why: i.why,
	};
}

export function addUsage(total: Usage, add: Usage): Usage {
	return {
		input: (total.input ?? 0) + (add.input ?? 0),
		output: (total.output ?? 0) + (add.output ?? 0),
		cacheRead: (total.cacheRead ?? 0) + (add.cacheRead ?? 0),
		cacheWrite: (total.cacheWrite ?? 0) + (add.cacheWrite ?? 0),
		cost: (total.cost ?? 0) + (add.cost ?? 0),
	};
}

// ---------------------------------------------------------------------------
// Verdicts + worker signals
// ---------------------------------------------------------------------------

export interface Verdict {
	verdict: "pass" | "block" | null;
	/** Reviewer output without the verdict line. */
	findings: string;
}

/** Find the last line-anchored `VERDICT: PASS|BLOCK` in a reviewer's output. */
export function parseVerdict(output: string): Verdict {
	const lines = output.split("\n");
	let idx = -1;
	let verdict: "pass" | "block" | null = null;
	lines.forEach((line, i) => {
		const m = line.match(/^\s*[*_`#>\s-]*VERDICT:\s*(PASS|BLOCK)\b[*_`\s.]*$/i);
		if (m) {
			idx = i;
			verdict = m[1].toLowerCase() as "pass" | "block";
		}
	});
	if (idx < 0) return { verdict: null, findings: output.trim() };
	const findings = lines.filter((_, i) => i !== idx).join("\n").trim();
	return { verdict, findings };
}

/** A worker that lacks a product/design choice ends its message with `NEEDS_HELP: <question>`. */
export function parseNeedsHelp(output: string): string | null {
	const m = output.match(/^\s*[*_`]*NEEDS_HELP:[*_`]*\s*([\s\S]+)$/im);
	return m ? m[1].trim() : null;
}

export function findPrUrl(output: string): string | null {
	const urls = output.match(/https:\/\/github\.com\/[^\s)>\]]+\/pull\/\d+/g);
	return urls ? urls[urls.length - 1] : null;
}

// ---------------------------------------------------------------------------
// Slug / worktree naming
// ---------------------------------------------------------------------------

const CONVENTIONAL = /^\s*(feat|fix|docs|chore|refactor|test|perf|ci|build|style)(\([^)]*\))?!?\s*:\s*/i;
const LEADING_VERBS: Record<string, string> = {
	fix: "fix",
	fixes: "fix",
	bugfix: "fix",
	docs: "docs",
	document: "docs",
	refactor: "refactor",
	test: "test",
	tests: "test",
	chore: "chore",
};

/** Branch type: a conventional-commit prefix, a leading verb, else `feat`. */
export function branchType(task: string): string {
	const line = firstLine(task, 400);
	const conv = line.match(CONVENTIONAL);
	if (conv) return conv[1].toLowerCase();
	const first = line.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
	return LEADING_VERBS[first] ?? "feat";
}

/** Kebab-case slug of the task's first line (conventional prefix stripped), max 40 chars. */
export function taskSlug(task: string, max = 40): string {
	const line = firstLine(task, 400).replace(CONVENTIONAL, "");
	const words = line
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	let slug = "";
	for (const word of words) {
		const next = slug ? `${slug}-${word}` : word;
		if (next.length > max) {
			if (!slug) slug = word.slice(0, max);
			break;
		}
		slug = next;
	}
	return slug || "task";
}

/** `slug`, `slug-2`, `slug-3`, ... until `taken` says no. */
export function uniqueSlug(slug: string, taken: (candidate: string) => boolean): string {
	if (!taken(slug)) return slug;
	for (let i = 2; ; i++) {
		const candidate = `${slug}-${i}`;
		if (!taken(candidate)) return candidate;
	}
}

export interface WorktreePlan {
	type: string;
	slug: string;
	branch: string;
	dir: string;
}

export function planWorktree(opts: {
	task: string;
	worktreesDir: string;
	branchExists: (branch: string) => boolean;
	pathExists: (p: string) => boolean;
}): WorktreePlan {
	const type = branchType(opts.task);
	const slug = uniqueSlug(
		taskSlug(opts.task),
		(s) => opts.branchExists(`${type}/${s}`) || opts.pathExists(path.join(opts.worktreesDir, s)),
	);
	return { type, slug, branch: `${type}/${slug}`, dir: path.join(opts.worktreesDir, slug) };
}

// ---------------------------------------------------------------------------
// Status text
// ---------------------------------------------------------------------------

const MESSAGE_MAX = 500;

function clip(text: string, max = MESSAGE_MAX): string {
	const t = text.trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Status message for a finished process: output first, stderr only when output is empty. */
export function resultMessage(r: { output?: string; stderr?: string; errorMessage?: string }): string | undefined {
	const out = clip(r.output ?? "");
	if (r.errorMessage) return out ? `${out} | error: ${clip(r.errorMessage)}` : clip(r.errorMessage);
	if (out) return out;
	return r.stderr?.trim() ? clip(r.stderr) : undefined;
}

/** Text for await_agent: status, message, then output (stderr only when there is no output). */
export function describeStatus(
	id: string,
	status: { status: string; message?: string },
	result: { output?: string; stderr?: string } | null,
): string {
	let text = `Subagent ${id} status: ${status.status}`;
	if (status.message) text += ` — ${status.message}`;
	const out = clip(result?.output ?? "");
	if (out && !(status.message ?? "").includes(out.slice(0, 80))) text += `\nOutput: ${out}`;
	else if (!out && !status.message && result?.stderr?.trim()) text += `\nstderr: ${clip(result.stderr)}`;
	return text;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export function buildWorkerPrompt(o: { task: string; branch: string; base: string; defaultBranch: string }): string {
	return [
		`You are a worker in an isolated git worktree on branch \`${o.branch}\` (base ${o.base.slice(0, 12)}, from \`${o.defaultBranch}\`).`,
		"",
		"Build the task below. Rules:",
		"- Read AGENTS.md (and README) for this repo's own conventions and checks; run those checks (lint, typecheck, tests) and fix failures before you finish.",
		"- Commit everything on this branch in small focused commits. Leave no uncommitted changes.",
		"- Do not push, open a PR, merge, or touch any other checkout. A fresh reviewer examines your commits next; the engine reports status, so do not call agent_ping.",
		"- If a product or design choice is missing and you cannot proceed without guessing, stop and end your message with `NEEDS_HELP: <your question>`.",
		"- End with a short summary: what changed, which checks you ran and their result.",
		"",
		"## Task",
		"",
		o.task.trim(),
	].join("\n");
}

export function buildFixPrompt(o: { findings: string; round: number; max: number }): string {
	return [
		`A fresh reviewer returned VERDICT: BLOCK (${o.round} of at most ${o.max} before the task is handed back to the manager).`,
		"Fix every finding below that is valid. If you disagree with one, say why in your summary instead of changing code.",
		"Re-run the repo's checks and commit the fixes on the same branch. Do not push. End with a short summary.",
		"",
		"## Findings",
		"",
		o.findings.trim() || "(the reviewer gave no details)",
	].join("\n");
}

export function buildDeliveryPrompt(o: { branch: string; defaultBranch: string; task: string }): string {
	return [
		"The reviewer returned VERDICT: PASS. Deliver the branch:",
		`1. \`git push -u origin ${o.branch}\``,
		`2. \`gh pr create --base ${o.defaultBranch.replace(/^origin\//, "")} --head ${o.branch}\` with a clear title and a short body (what changed, why, checks run).`,
		"3. Finish with the PR URL on its own line. If push or PR creation fails, say exactly why and do not retry in a loop.",
		"",
		`Task (for the PR text): ${firstLine(o.task, 300)}`,
	].join("\n");
}

const MAX_DIFF_CHARS = 150_000;
const MAX_DOC_CHARS = 20_000;

export function clipText(text: string, max: number, hint: string): string {
	return text.length > max ? `${text.slice(0, max)}\n… [truncated: ${hint}]` : text;
}

/** Local markdown links in AGENTS.md whose text or target mentions review/checklist. */
export function findReviewLinks(markdown: string, limit = 3): string[] {
	const found: string[] = [];
	for (const m of markdown.matchAll(/\[([^\]]*)\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
		const [, text, target] = m;
		if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) continue;
		if (!/review|checklist/i.test(text) && !/review|checklist/i.test(target)) continue;
		if (!found.includes(target)) found.push(target);
		if (found.length >= limit) break;
	}
	return found;
}

export function buildReviewPrompt(o: {
	task: string;
	base: string;
	tip: string;
	diff: string;
	agentsMd: string | null;
	linked: { path: string; text: string }[];
}): string {
	const parts = [
		"You are an independent code reviewer. You did not write this change and have no history with it.",
		"Judge the diff below against the task and the repo's own rules. You run in the worktree at the tip commit with read-only tools: use `read`, `grep`, `find`, `ls`, and bash only for `git` (log/show/diff) and `grep`. Never modify files.",
		"",
		"Check: does it do what the task asks (and nothing unrelated)? Bugs, missing edge cases, missing or weak tests, violations of the repo rules below, checks that would fail.",
		"",
		"Answer format. The first line must be exactly one of:",
		"VERDICT: PASS",
		"VERDICT: BLOCK",
		"For BLOCK, follow with numbered findings, each with file/line and what to change. Block only on real problems; list nits separately under `Nits:` and still PASS if nothing else is wrong.",
		"",
		"## Task",
		"",
		o.task.trim(),
		"",
		`## Diff (git diff ${o.base.slice(0, 12)}..${o.tip.slice(0, 12)})`,
		"",
		"```diff",
		clipText(o.diff, MAX_DIFF_CHARS, "run `git diff` yourself for the rest"),
		"```",
	];
	if (o.agentsMd) parts.push("", "## AGENTS.md", "", clipText(o.agentsMd, MAX_DOC_CHARS, "read the file for the rest"));
	for (const doc of o.linked) parts.push("", `## ${doc.path}`, "", clipText(doc.text, MAX_DOC_CHARS, "read the file for the rest"));
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Agent state dirs
// ---------------------------------------------------------------------------

/**
 * State dirs are `<subagents-root>/<project-hash>/<agent-id>/`, keyed by the
 * *subagent's* cwd, so one session's agents can live under several project
 * hashes (every worktree worker does). Scan all of them.
 */
function projectDirs(subagentsRoot: string): string[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(subagentsRoot);
	} catch {
		return [];
	}
	return entries.map((e) => path.join(subagentsRoot, e)).filter((d) => isDir(d));
}

function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function readLiveFile<T>(dir: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, "live.json"), "utf-8")) as T;
	} catch {
		return null;
	}
}

/** Every agent dir whose live.json is owned by `owner`, regardless of which cwd it ran in. */
export function scanAgentDirs<T extends { ownerId?: string }>(
	subagentsRoot: string,
	owner: string,
): { id: string; dir: string; live: T }[] {
	const found: { id: string; dir: string; live: T }[] = [];
	for (const project of projectDirs(subagentsRoot)) {
		let ids: string[];
		try {
			ids = fs.readdirSync(project);
		} catch {
			continue;
		}
		for (const id of ids) {
			const dir = path.join(project, id);
			if (!isDir(dir)) continue;
			const live = readLiveFile<T>(dir);
			// A state file without an owner cannot be attributed to a session.
			if (live && live.ownerId === owner) found.push({ id, dir, live });
		}
	}
	return found;
}

/** Locate an agent's dir by id across all project hashes. */
export function findAgentDir(subagentsRoot: string, id: string): string | null {
	for (const project of projectDirs(subagentsRoot)) {
		const dir = path.join(project, id);
		if (isDir(dir)) return dir;
	}
	return null;
}

/**
 * Which agent dir `agent_ping` may write for `agentId`. A subagent may ping only
 * itself (`self`), or an agent whose live.json `ownerId` equals the caller's
 * owner id. Anything else (unknown id, another session's agent) returns null.
 */
export function resolvePingDir(
	subagentsRoot: string,
	agentId: string,
	caller: { selfId?: string; selfDir?: string; owner: string },
): string | null {
	if (caller.selfId && caller.selfDir && caller.selfId === agentId) return caller.selfDir;
	const dir = findAgentDir(subagentsRoot, agentId);
	if (!dir) return null;
	return readLiveFile<{ ownerId?: string }>(dir)?.ownerId === caller.owner ? dir : null;
}
