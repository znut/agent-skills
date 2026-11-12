/**
 * Git plumbing for the subagent engine: repo root, default branch, worktree
 * creation, diffs, and PR capability detection. Synchronous and small; every
 * call is a plain `git`/`gh` invocation in a given directory.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { planWorktree, type WorktreePlan } from "./engine";

export function git(cwd: string, args: string[], timeoutMs = 60_000): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }).trim();
}

function gitOk(cwd: string, args: string[]): boolean {
	try {
		git(cwd, args);
		return true;
	} catch {
		return false;
	}
}

export function repoRoot(cwd: string): string {
	try {
		return fs.realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]));
	} catch {
		throw new Error(`${cwd} is not inside a git repository`);
	}
}

/** `origin/HEAD` if present, else `main`, else the current branch. Returns a ref usable in `git worktree add`. */
export function defaultBranchRef(root: string): string {
	try {
		const ref = git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
		if (ref && gitOk(root, ["rev-parse", "--verify", "--quiet", ref])) return ref;
	} catch {
		/* no origin/HEAD */
	}
	if (gitOk(root, ["rev-parse", "--verify", "--quiet", "refs/heads/main"])) return "main";
	return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/** Best-effort refresh of the default branch so a worktree does not start from a stale tip. */
export function refreshDefaultBranch(root: string, ref: string): void {
	const m = ref.match(/^([^/]+)\/(.+)$/);
	if (!m || !gitOk(root, ["remote", "get-url", m[1]])) return;
	try {
		git(root, ["fetch", "--quiet", m[1], m[2]], 20_000);
	} catch {
		/* offline or auth: use the local tip */
	}
}

export interface Worktree extends WorktreePlan {
	base: string;
	baseRef: string;
}

export function createWorktree(root: string, task: string, worktreesDir: string): Worktree {
	const baseRef = defaultBranchRef(root);
	refreshDefaultBranch(root, baseRef);
	const plan = planWorktree({
		task,
		worktreesDir,
		branchExists: (b) => gitOk(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]),
		pathExists: (p) => fs.existsSync(p),
	});
	if (!gitOk(root, ["check-ref-format", "--branch", plan.branch])) throw new Error(`refusing invalid branch name ${JSON.stringify(plan.branch)}`);
	const base = git(root, ["rev-parse", baseRef]);
	fs.mkdirSync(path.dirname(plan.dir), { recursive: true });
	git(root, ["worktree", "add", "--no-track", "-b", plan.branch, plan.dir, baseRef]);
	return { ...plan, base, baseRef };
}

export function headSha(cwd: string): string {
	return git(cwd, ["rev-parse", "HEAD"]);
}

export function diffRange(cwd: string, base: string, tip: string): string {
	try {
		return execFileSync("git", ["diff", `${base}..${tip}`], { cwd, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
	} catch (e) {
		throw new Error(`git diff ${base}..${tip} failed: ${(e as Error).message}`);
	}
}

/** `git status --porcelain` lines (tracked changes and untracked files); empty when clean. */
export function dirtyFiles(cwd: string): string[] {
	return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
		.split("\n")
		.filter((l) => l.length > 0);
}

export function commitCount(cwd: string, base: string, tip: string): number {
	return Number.parseInt(git(cwd, ["rev-list", "--count", `${base}..${tip}`]), 10) || 0;
}

/** True when `origin` points at GitHub and `gh` works in this repo. */
export function canOpenPr(cwd: string): boolean {
	try {
		const url = git(cwd, ["remote", "get-url", "origin"]);
		if (!/github\.com[:/]/.test(url)) return false;
	} catch {
		return false;
	}
	const gh = spawnSync("gh", ["repo", "view", "--json", "url"], { cwd, encoding: "utf-8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
	return gh.status === 0;
}
