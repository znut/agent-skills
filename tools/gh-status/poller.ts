/**
 * gh-status — shared local GitHub PR status poller for Claude agents.
 *
 * Generalized multi-repo port of a single-repo local poller. Reads every
 * $AGENT_TOOLS_HOME/config/*.json and polls each repo once per cycle via one
 * GraphQL request, materializing PR state as local files under
 * $AGENT_TOOLS_HOME/var/<name>/gh-status/ so any number of agents can watch for
 * merge/CI/comment/review events with zero GitHub calls and zero model-token
 * polling:
 *
 *   status/pr-<n>.json      — current snapshot per PR (overwritten every poll)
 *   status/state.json       — full snapshot of the last poll + comment cursors
 *   events/pr-<n>.log       — UNIFIED per-PR timeline (append-only JSONL:
 *     {at, type, actor?, body?, kind?, path?, line?, sha?}) — one watcher +
 *     line-cursor backfill covers merge/close/checks/approval(+body)/comments.
 *     Legacy per-type markers below stay during the transition.
 *   events/pr-<n>.merged    — marker, touched once when the PR is seen merged
 *   events/pr-<n>.closed    — marker, touched once when closed without merge
 *   events/pr-<n>.checks-success / .checks-failure — marker per CI outcome
 *   events/pr-<n>.checks-info.json — payload written on a checks-success/
 *                             failure TRANSITION only: {conclusion, runId,
 *                             runUrl, failedJobs: [{name, failedSteps,
 *                             firstErrorLines}]}. Job/log detail only fetched
 *                             for failures.
 *   events/pr-<n>.commented — bumped (mtime) whenever NEW comment/review
 *                             activity is observed since the last poll
 *   events/pr-<n>.comments.json — payload written alongside `.commented`:
 *                             array of the new comments/reviews since the
 *                             last cursor ({author, createdAt, kind, path?,
 *                             line?, body}). Overwritten each firing.
 *   events/pr-<n>.approved  — marker, touched when reviewDecision becomes APPROVED
 *   events/pr-<n>.changes-requested — marker, touched on CHANGES_REQUESTED
 *
 * Configs with a `board` block additionally get a 1-point board-change probe
 * per cycle that re-derives $AGENT_TOOLS_HOME/var/<name>/board-snapshot.md on
 * change (see probeBoard) — agents read the board from that file, no API calls.
 *
 * Markers for merged/closed are monotonic facts. CI and approval markers are
 * re-created if a new push flips the rollup/decision (the stale opposite
 * marker is removed). The `commented` marker uses a different, "consume then
 * rewatch" pattern — see tools/README.md for details.
 *
 * Payload fetches (comments.json, checks-info.json) only ever run on a
 * detected transition/change — the steady-state poll is always exactly one
 * GraphQL request per configured repo; extra REST calls happen only when
 * there's something new to report, and any failure in those follow-up calls
 * is caught locally so it never aborts the main poll loop.
 *
 * IMPROVEMENT over the original single-repo poller: `comments.json` is now
 * written BEFORE the `.commented` marker is bumped (was: marker-then-payload),
 * so a watcher woken by the marker's mtime can never observe the marker
 * without its payload file already present.
 */

import { renameSync } from "node:fs"
import { loadAllConfigs, varDir } from "../lib/config.mjs"
import { expandHome } from "../lib/fs-util.mjs"

const POLL_MS = 40_000
const PR_WINDOW = 30

const QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${PR_WINDOW}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number
        state
        merged
        mergedAt
        headRefName
        title
        updatedAt
        reviewDecision
        commits(last: 1) {
          nodes { commit { oid statusCheckRollup { state } } }
        }
        comments(last: 1) {
          totalCount
          nodes { updatedAt }
        }
        reviews(last: 1) {
          totalCount
          nodes { updatedAt state body author { login } }
        }
      }
    }
  }
}`

type RepoConfig = {
	name: string
	org: string
	repo: string
	tokenFile: string
	board?: { owner: string; projectNumber: number }
}

type Pr = {
	number: number
	state: "OPEN" | "CLOSED" | "MERGED"
	merged: boolean
	mergedAt: string | null
	headRefName: string
	title: string
	updatedAt: string
	reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null
	commits: { nodes: Array<{ commit: { oid: string; statusCheckRollup: { state: string } | null } }> }
	comments: { totalCount: number; nodes: Array<{ updatedAt: string }> }
	reviews: { totalCount: number; nodes: Array<{ updatedAt: string; state: string; body: string | null; author: { login: string } | null }> }
}

type PollState = {
	fetchedAt: string
	prs: number[]
	commentCursors: Record<string, { count: number; lastAt: string | null }>
	boardUpdatedAt?: string | null
}

type CommentPayload = {
	author: string
	createdAt: string
	kind: "issue" | "review" | "review-thread"
	path?: string
	line?: number | null
	body: string
}

const COMMENT_BODY_CAP = 2000

function capBody(body: string | null | undefined): string {
	const s = (body ?? "").trim()
	return s.length > COMMENT_BODY_CAP ? `${s.slice(0, COMMENT_BODY_CAP)}\n…[truncated]` : s
}

function ghHeaders(token: string): Record<string, string> {
	return { authorization: `bearer ${token}`, "user-agent": "gh-status-poller", accept: "application/vnd.github+json" }
}

/** Targeted follow-up fetch for ONE PR, run only when the cursor in poll() detected new activity. */
async function fetchNewComments(owner: string, repo: string, prNumber: number, sinceAt: string, token: string): Promise<CommentPayload[]> {
	const headers = ghHeaders(token)
	const base = `https://api.github.com/repos/${owner}/${repo}`
	const sinceMs = Date.parse(sinceAt)

	const [issueRes, reviewCommentRes, reviewRes] = await Promise.all([
		fetch(`${base}/issues/${prNumber}/comments?sort=updated&direction=desc&per_page=30`, { headers }),
		fetch(`${base}/pulls/${prNumber}/comments?sort=updated&direction=desc&per_page=30`, { headers }),
		fetch(`${base}/pulls/${prNumber}/reviews?per_page=30`, { headers }),
	])
	if (!issueRes.ok) throw new Error(`issue comments fetch HTTP ${issueRes.status}`)
	if (!reviewCommentRes.ok) throw new Error(`review comments fetch HTTP ${reviewCommentRes.status}`)
	if (!reviewRes.ok) throw new Error(`reviews fetch HTTP ${reviewRes.status}`)

	const issueComments = (await issueRes.json()) as Array<{
		user: { login: string } | null
		created_at: string
		updated_at: string
		body: string | null
	}>
	const reviewComments = (await reviewCommentRes.json()) as Array<{
		user: { login: string } | null
		created_at: string
		updated_at: string
		body: string | null
		path: string
		line: number | null
		original_line: number | null
	}>
	const reviews = (await reviewRes.json()) as Array<{
		user: { login: string } | null
		submitted_at: string | null
		body: string | null
	}>

	const out: CommentPayload[] = []

	for (const c of issueComments) {
		if (Date.parse(c.updated_at) <= sinceMs) continue
		out.push({ author: c.user?.login ?? "unknown", createdAt: c.created_at, kind: "issue", body: capBody(c.body) })
	}
	for (const c of reviewComments) {
		if (Date.parse(c.updated_at) <= sinceMs) continue
		out.push({
			author: c.user?.login ?? "unknown",
			createdAt: c.created_at,
			kind: "review-thread",
			path: c.path,
			line: c.line ?? c.original_line ?? null,
			body: capBody(c.body),
		})
	}
	for (const r of reviews) {
		// Bare Approve/Request-changes with no written comment carries no text;
		// the state transition itself is already covered by the approved /
		// changes-requested markers, so skip it here.
		if (!r.submitted_at || Date.parse(r.submitted_at) <= sinceMs) continue
		if (!r.body || !r.body.trim()) continue
		out.push({ author: r.user?.login ?? "unknown", createdAt: r.submitted_at, kind: "review", body: capBody(r.body) })
	}

	out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
	return out
}

type FailedJob = { name: string; failedSteps: string[]; firstErrorLines: string[] }
type ChecksInfo = { conclusion: string; runId: number | null; runUrl: string | null; failedJobs: FailedJob[] }

const ANSI_RE = /\x1b\[[0-9;]*m/g
const LOG_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/
const ERROR_LINE_RE = /error TS\d+:|Error:|FAIL\b|✗/
const MAX_ERROR_LINES = 15

function cleanLogLine(line: string): string {
	return line.replace(ANSI_RE, "").replace(LOG_TIMESTAMP_RE, "").trim()
}

async function fetchJobLogErrorLines(owner: string, repo: string, jobId: number, token: string): Promise<string[]> {
	const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, {
		headers: ghHeaders(token),
	})
	if (!res.ok) throw new Error(`job log fetch HTTP ${res.status}`)
	const text = await res.text()
	const matched: string[] = []
	for (const line of text.split("\n")) {
		if (!ERROR_LINE_RE.test(line)) continue
		matched.push(cleanLogLine(line))
		if (matched.length >= MAX_ERROR_LINES) break
	}
	return matched
}

/**
 * Runs only on a checks-success/failure marker TRANSITION (see poll()) —
 * never on the steady-state path. `fetchLogs` gates the expensive
 * jobs+per-job-log calls, used only for the FAILURE case; success only
 * needs the run identity (conclusion/runId/runUrl). Swallows its own errors
 * (logs to poller.log) so a flaky follow-up call never breaks the main poll.
 */
async function writeChecksInfo(
	owner: string,
	repo: string,
	eventsDir: string,
	prNumber: number,
	sha: string | null,
	conclusion: string,
	fetchLogs: boolean,
	token: string,
): Promise<void> {
	const info: ChecksInfo = { conclusion, runId: null, runUrl: null, failedJobs: [] }
	try {
		if (!sha) throw new Error("no commit sha available")
		const runsRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=20`, {
			headers: ghHeaders(token),
		})
		if (!runsRes.ok) throw new Error(`list runs HTTP ${runsRes.status}`)
		const runsBody = (await runsRes.json()) as {
			workflow_runs: Array<{ id: number; html_url: string; conclusion: string | null; created_at: string }>
		}
		const runs = runsBody.workflow_runs ?? []
		const wantConclusion = fetchLogs ? "failure" : "success"
		const candidates = runs.filter((r) => r.conclusion === wantConclusion)
		const chosen = (candidates.length ? candidates : runs).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
		if (chosen) {
			info.runId = chosen.id
			info.runUrl = chosen.html_url
		}

		if (fetchLogs && chosen) {
			const jobsRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${chosen.id}/jobs`, {
				headers: ghHeaders(token),
			})
			if (!jobsRes.ok) throw new Error(`list jobs HTTP ${jobsRes.status}`)
			const jobsBody = (await jobsRes.json()) as {
				jobs: Array<{ id: number; name: string; conclusion: string | null; steps: Array<{ name: string; conclusion: string | null }> }>
			}
			for (const job of (jobsBody.jobs ?? []).filter((j) => j.conclusion === "failure")) {
				const failedSteps = job.steps.filter((s) => s.conclusion === "failure").map((s) => s.name)
				let firstErrorLines: string[] = []
				try {
					firstErrorLines = await fetchJobLogErrorLines(owner, repo, job.id, token)
				} catch (e) {
					console.error(`${new Date().toISOString()} pr-${prNumber} checks log fetch failed (job ${job.id}): ${e instanceof Error ? e.message : e}`)
				}
				info.failedJobs.push({ name: job.name, failedSteps, firstErrorLines })
			}
		}
	} catch (e) {
		console.error(`${new Date().toISOString()} pr-${prNumber} checks-info fetch failed: ${e instanceof Error ? e.message : e}`)
	}
	await writeAtomic(`${eventsDir}/pr-${prNumber}.checks-info.json`, `${JSON.stringify(info, null, "\t")}\n`)
}

async function readToken(tokenFile: string): Promise<string> {
	return (await Bun.file(expandHome(tokenFile)).text()).trim()
}

/** Atomic write: agents reading concurrently never see a partial file. */
async function writeAtomic(path: string, content: string): Promise<void> {
	const tmp = `${path}.tmp`
	await Bun.write(tmp, content)
	renameSync(tmp, path)
}

/** Create-only marker: monotonic facts (merged, closed, checks-*, approved, changes-requested). */
async function touch(path: string): Promise<void> {
	if (!(await Bun.file(path).exists())) await Bun.write(path, `${new Date().toISOString()}\n`)
}

/**
 * Create-or-refresh marker: always (over)writes, bumping mtime even if the
 * file already exists. Used for `commented`, where an agent may `rm` the
 * marker after handling it and expects to be re-notified on the next new
 * comment even though the marker path itself isn't new.
 */
async function bump(path: string): Promise<void> {
	await Bun.write(path, `${new Date().toISOString()}\n`)
}

type TimelineEvent = {
	at: string
	type: "merged" | "closed" | "checks-success" | "checks-failure" | "approved" | "changes-requested" | "commented"
	actor?: string
	body?: string
	kind?: string
	path?: string
	line?: number | null
	sha?: string | null
}

// Unified per-PR timeline: one append-only JSONL file per PR so a session
// arms ONE watcher (`find events -name 'pr-*.log' -newer <stamp>`) instead of
// one loop per marker type, and backfills by reading lines since a stamp.
// Legacy marker files stay during the transition — same firings, two shapes.
async function appendEvent(eventsDir: string, prNumber: number, ev: TimelineEvent): Promise<void> {
	const { appendFileSync } = await import("node:fs")
	appendFileSync(`${eventsDir}/pr-${prNumber}.log`, `${JSON.stringify(ev)}\n`)
}

async function rm(path: string): Promise<void> {
	const { rmSync } = await import("node:fs")
	try {
		rmSync(path)
	} catch {}
}

async function readPrevState(stateFile: string): Promise<PollState | null> {
	try {
		return (await Bun.file(stateFile).json()) as PollState
	} catch {
		return null
	}
}

/**
 * Board-change probe — configs with a `board` block only. One 1-point GraphQL
 * query (`projectV2.updatedAt`) per cycle; a board-snapshot refresh (the
 * expensive multi-page search, ~15 points) runs ONLY when the stamp moved.
 * Agents then read the snapshot file with zero API calls of their own.
 * The refresh subprocess passes --force: probe-gating already rate-limits, and
 * the tool's own debounce would silently swallow a change that lands within
 * 60s of an on-merge refresh. The new stamp is stored only after a successful
 * refresh, so a failed run self-heals by retrying on the next cycle.
 * Known blind spot: an issue TITLE edit may not bump projectV2.updatedAt —
 * the title stales until the next real board change. Field edits, adds,
 * status flips, and closes all bump it.
 */
async function probeBoard(config: RepoConfig, prevUpdatedAt: string | null | undefined, token: string): Promise<string | null | undefined> {
	if (!config.board) return undefined
	const { owner, projectNumber } = config.board
	const query = `query { organization(login: "${owner}") { projectV2(number: ${projectNumber}) { updatedAt } } }`
	const res = await fetch("https://api.github.com/graphql", {
		method: "POST",
		headers: { authorization: `bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ query }),
	})
	if (!res.ok) throw new Error(`board probe HTTP ${res.status}`)
	const body = (await res.json()) as { data?: { organization: { projectV2: { updatedAt: string } | null } | null }; errors?: unknown }
	const updatedAt = body.data?.organization?.projectV2?.updatedAt
	if (!updatedAt) throw new Error(`board probe errors: ${JSON.stringify(body.errors ?? body)}`)
	if (prevUpdatedAt === updatedAt) return updatedAt

	const script = new URL("../board-snapshot/board-snapshot.mjs", import.meta.url).pathname
	const proc = Bun.spawn(["bun", script, config.name, "--force"], { stdout: "inherit", stderr: "inherit" })
	if ((await proc.exited) !== 0) throw new Error("board-snapshot refresh exited non-zero")
	return updatedAt
}

async function pollRepo(config: RepoConfig): Promise<void> {
	const base = `${varDir(config.name)}/gh-status`
	const statusDir = `${base}/status`
	const eventsDir = `${base}/events`
	const stateFile = `${statusDir}/state.json`
	const { mkdirSync } = await import("node:fs")
	mkdirSync(statusDir, { recursive: true })
	mkdirSync(eventsDir, { recursive: true })

	const prevState = await readPrevState(stateFile)
	const prevCursors = prevState?.commentCursors ?? {}

	const token = await readToken(config.tokenFile)
	const res = await fetch("https://api.github.com/graphql", {
		method: "POST",
		headers: { authorization: `bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ query: QUERY, variables: { owner: config.org, name: config.repo } }),
	})
	if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`)
	const body = (await res.json()) as { data?: { repository: { pullRequests: { nodes: Pr[] } } }; errors?: unknown }
	if (!body.data) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`)

	const prs = body.data.repository.pullRequests.nodes
	const fetchedAt = new Date().toISOString()
	const nextCursors: Record<string, { count: number; lastAt: string | null }> = {}

	for (const pr of prs) {
		const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null
		const sha = pr.commits.nodes[0]?.commit.oid ?? null

		const commentsTotal = pr.comments.totalCount
		const commentsLatest = pr.comments.nodes[0]?.updatedAt ?? null
		const reviewsTotal = pr.reviews.totalCount
		const reviewsLatest = pr.reviews.nodes[0]?.updatedAt ?? null
		const commentCount = commentsTotal + reviewsTotal
		const lastCommentAt = [commentsLatest, reviewsLatest].filter((d): d is string => !!d).sort().pop() ?? null

		const snapshot = {
			number: pr.number,
			state: pr.state,
			merged: pr.merged,
			mergedAt: pr.mergedAt,
			branch: pr.headRefName,
			title: pr.title,
			checks: rollup, // SUCCESS | FAILURE | PENDING | ERROR | EXPECTED | null
			reviewDecision: pr.reviewDecision, // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
			commentCount, // issue comments + reviews combined (see Pr.reviews note above)
			lastCommentAt,
			updatedAt: pr.updatedAt,
			fetchedAt,
		}
		await writeAtomic(`${statusDir}/pr-${pr.number}.json`, `${JSON.stringify(snapshot, null, "\t")}\n`)

		if (pr.merged) {
			const marker = `${eventsDir}/pr-${pr.number}.merged`
			if (!(await Bun.file(marker).exists())) await appendEvent(eventsDir, pr.number, { at: fetchedAt, type: "merged" })
			await touch(marker)
		} else if (pr.state === "CLOSED") {
			const marker = `${eventsDir}/pr-${pr.number}.closed`
			if (!(await Bun.file(marker).exists())) await appendEvent(eventsDir, pr.number, { at: fetchedAt, type: "closed" })
			await touch(marker)
		}

		if (rollup === "SUCCESS") {
			await rm(`${eventsDir}/pr-${pr.number}.checks-failure`)
			const marker = `${eventsDir}/pr-${pr.number}.checks-success`
			const isTransition = !(await Bun.file(marker).exists())
			await touch(marker)
			if (isTransition) {
				await appendEvent(eventsDir, pr.number, { at: fetchedAt, type: "checks-success", sha })
				try {
					await writeChecksInfo(config.org, config.repo, eventsDir, pr.number, sha, "SUCCESS", false, token)
				} catch (e) {
					console.error(`${new Date().toISOString()} pr-${pr.number} checks-info write failed: ${e instanceof Error ? e.message : e}`)
				}
			}
		} else if (rollup === "FAILURE" || rollup === "ERROR") {
			await rm(`${eventsDir}/pr-${pr.number}.checks-success`)
			const marker = `${eventsDir}/pr-${pr.number}.checks-failure`
			const isTransition = !(await Bun.file(marker).exists())
			await touch(marker)
			if (isTransition) {
				await appendEvent(eventsDir, pr.number, { at: fetchedAt, type: "checks-failure", sha })
				try {
					await writeChecksInfo(config.org, config.repo, eventsDir, pr.number, sha, rollup, true, token)
				} catch (e) {
					console.error(`${new Date().toISOString()} pr-${pr.number} checks-info write failed: ${e instanceof Error ? e.message : e}`)
				}
			}
		} else if (rollup === "PENDING") {
			// New push in flight — clear both outcomes so watchers wait on the fresh run.
			await rm(`${eventsDir}/pr-${pr.number}.checks-success`)
			await rm(`${eventsDir}/pr-${pr.number}.checks-failure`)
		}

		// Approval decision — same create/clear shape as the checks rollup above.
		if (pr.reviewDecision === "APPROVED") {
			await rm(`${eventsDir}/pr-${pr.number}.changes-requested`)
			const marker = `${eventsDir}/pr-${pr.number}.approved`
			if (!(await Bun.file(marker).exists())) {
				const rv = pr.reviews.nodes[0]
				await appendEvent(eventsDir, pr.number, { at: fetchedAt, type: "approved", actor: rv?.author?.login, body: capBody(rv?.body) })
			}
			await touch(marker)
		} else if (pr.reviewDecision === "CHANGES_REQUESTED") {
			await rm(`${eventsDir}/pr-${pr.number}.approved`)
			const marker = `${eventsDir}/pr-${pr.number}.changes-requested`
			if (!(await Bun.file(marker).exists())) {
				const rv = pr.reviews.nodes[0]
				await appendEvent(eventsDir, pr.number, { at: fetchedAt, type: "changes-requested", actor: rv?.author?.login, body: capBody(rv?.body) })
			}
			await touch(marker)
		} else {
			// REVIEW_REQUIRED or null: a later push (or dismissal) reset the
			// decision — clear both so watchers wait on the fresh outcome.
			await rm(`${eventsDir}/pr-${pr.number}.approved`)
			await rm(`${eventsDir}/pr-${pr.number}.changes-requested`)
		}

		// Comment/review activity — cursor-based, not a pure create/clear
		// marker. No baseline (PR unseen since this poller last started, or
		// new to the tracked window) => record the cursor only, never fire.
		const prevCursor = prevCursors[String(pr.number)]
		if (prevCursor !== undefined && commentCount > prevCursor.count) {
			// IMPROVEMENT vs. the original single-repo poller: write the payload BEFORE
			// bumping the marker, so a watcher woken by the marker's mtime can
			// never observe `.commented` without `.comments.json` already
			// present (the old order raced: marker-then-payload). The marker
			// still bumps even if the payload fetch fails below (mirrors the
			// original's "stale/missing sidecar until next transition"
			// resilience contract), it just won't have fresh content this round.
			try {
				const sinceAt = prevCursor.lastAt ?? new Date(0).toISOString()
				const newComments = await fetchNewComments(config.org, config.repo, pr.number, sinceAt, token)
				await writeAtomic(`${eventsDir}/pr-${pr.number}.comments.json`, `${JSON.stringify(newComments, null, "\t")}\n`)
				for (const c of newComments) {
					await appendEvent(eventsDir, pr.number, { at: c.createdAt, type: "commented", actor: c.author, kind: c.kind, path: c.path, line: c.line, body: c.body })
				}
			} catch (e) {
				console.error(`${new Date().toISOString()} pr-${pr.number} comments payload fetch failed: ${e instanceof Error ? e.message : e}`)
			}
			await bump(`${eventsDir}/pr-${pr.number}.commented`)
		}
		nextCursors[String(pr.number)] = { count: commentCount, lastAt: lastCommentAt }
	}

	let boardUpdatedAt = prevState?.boardUpdatedAt ?? null
	try {
		boardUpdatedAt = (await probeBoard(config, boardUpdatedAt, token)) ?? null
	} catch (e) {
		// keep the previous stamp — the change (if any) re-triggers next cycle
		console.error(`${new Date().toISOString()} [${config.name}] board probe failed: ${e instanceof Error ? e.message : e}`)
	}

	const state: PollState = { fetchedAt, prs: prs.map((p) => p.number), commentCursors: nextCursors, boardUpdatedAt }
	await writeAtomic(stateFile, `${JSON.stringify(state, null, "\t")}\n`)
}

async function poll(): Promise<void> {
	const configs = loadAllConfigs() as RepoConfig[]
	for (const config of configs) {
		try {
			await pollRepo(config)
		} catch (e) {
			console.error(`${new Date().toISOString()} [${config.name}] poll failed: ${e instanceof Error ? e.message : e}`)
		}
	}
}

const isMain = import.meta.main
if (isMain) {
	console.log(`gh-status poller up — polling $AGENT_TOOLS_HOME/config/*.json every ${POLL_MS / 1000}s`)
	while (true) {
		await poll()
		await Bun.sleep(POLL_MS)
	}
}

export { poll, pollRepo }
