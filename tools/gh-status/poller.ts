/**
 * gh-status — shared local GitHub PR status poller for agents.
 *
 * Reads every $AGENT_TOOLS_HOME/config/*.json and polls each repo once per
 * cycle via one GraphQL request, materializing PR state as local files under
 * $AGENT_TOOLS_HOME/var/<name>/gh-status/ so any number of agents can watch for
 * merge/CI/comment/review events with zero GitHub calls and zero model-token
 * polling:
 *
 *   status/pr-<n>.json      — current snapshot per PR (overwritten every poll)
 *   status/state.json       — full snapshot of the last poll + comment cursors
 *   events/pr-<n>.log       — the PR's timeline, append-only JSONL
 *     {at, type, id?, actor?, body?, kind?, path?, line?, sha?}: merged,
 *     closed, checks-success, checks-failure, approved, changes-requested,
 *     commented, ready-stale. One watcher per PR plus a line cursor covers
 *     everything; transitions are detected against the previous snapshot.
 *   events/pr-<n>.merged    — marker, touched once, for watchers that key
 *                             on a path
 *   events/pr-<n>.comments.json — the new comments/reviews since the last
 *                             cursor ({author, createdAt, kind, path?, line?,
 *                             body}), overwritten each batch
 *   events/issue-<n>.log / .comments.json — ISSUE comments, same shapes: one
 *     repo-wide `issues/comments?since=` REST call per cycle feeds them;
 *     PR-owned comments are routed to the pr-<n> flow, first sight is
 *     baseline-only.
 *
 * Configs with a `board` block additionally get a 1-point board-change probe
 * per cycle that re-derives $AGENT_TOOLS_HOME/var/<name>/board-snapshot.md on
 * change (see probeBoard) — agents read the board from that file, no API calls.
 *
 * Files of PRs that left the tracked window and have been merged or closed
 * for PRUNE_AFTER_MS are removed, as are issue files idle that long.
 *
 * The comments payload fetch only runs on a detected change — the
 * steady-state poll is always exactly one GraphQL request per configured
 * repo, and a failure in the follow-up call is caught locally so it never
 * aborts the main poll loop.
 */

import { renameSync } from "node:fs"
import { loadAllConfigs, varDir } from "../lib/config.mjs"
import { expandHome } from "../lib/fs-util.mjs"

const POLL_MS = 40_000
const PR_WINDOW = 30
export const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000
const PRUNE_EVERY_MS = 60 * 60 * 1000

const QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${PR_WINDOW}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number
        state
        isDraft
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
	isDraft: boolean
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
	issueCommentCursor?: string | null
	prunedAt?: string | null
}

type Snapshot = {
	state?: string
	isDraft?: boolean
	merged?: boolean
	mergedAt?: string | null
	updatedAt?: string
	headOid?: string | null
	checks?: string | null
	reviewDecision?: string | null
}

type CommentPayload = {
	id: number
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
		id: number
		user: { login: string } | null
		created_at: string
		updated_at: string
		body: string | null
	}>
	const reviewComments = (await reviewCommentRes.json()) as Array<{
		id: number
		user: { login: string } | null
		created_at: string
		updated_at: string
		body: string | null
		path: string
		line: number | null
		original_line: number | null
	}>
	const reviews = (await reviewRes.json()) as Array<{
		id: number
		user: { login: string } | null
		submitted_at: string | null
		body: string | null
	}>

	const out: CommentPayload[] = []

	for (const c of issueComments) {
		if (Date.parse(c.updated_at) <= sinceMs) continue
		out.push({ id: c.id, author: c.user?.login ?? "unknown", createdAt: c.created_at, kind: "issue", body: capBody(c.body) })
	}
	for (const c of reviewComments) {
		if (Date.parse(c.updated_at) <= sinceMs) continue
		out.push({
			id: c.id,
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
		// the state transition itself is already an approved / changes-requested
		// event, so skip it here.
		if (!r.submitted_at || Date.parse(r.submitted_at) <= sinceMs) continue
		if (!r.body || !r.body.trim()) continue
		out.push({ id: r.id, author: r.user?.login ?? "unknown", createdAt: r.submitted_at, kind: "review", body: capBody(r.body) })
	}

	out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
	return out
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

/** Create-only marker for a monotonic fact. */
async function touch(path: string): Promise<void> {
	if (!(await Bun.file(path).exists())) await Bun.write(path, `${new Date().toISOString()}\n`)
}

type TimelineEvent = {
	at: string
	// GitHub object id of the comment/review behind a "commented" event —
	// lets a session skip fires for events it posted itself (self-echo
	// exclusion; watch-lane matches against the role's posted-ids file).
	id?: number
	type: "merged" | "closed" | "checks-success" | "checks-failure" | "approved" | "changes-requested" | "commented" | "ready-stale"
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
async function appendEvent(eventsDir: string, key: string | number, ev: TimelineEvent): Promise<void> {
	// key: bare number = PR, string = full prefix e.g. "issue-954"
	const name = typeof key === "number" ? `pr-${key}` : key
	const { appendFileSync } = await import("node:fs")
	appendFileSync(`${eventsDir}/${name}.log`, `${JSON.stringify(ev)}\n`)
}

async function readPrevState(stateFile: string): Promise<PollState | null> {
	try {
		return (await Bun.file(stateFile).json()) as PollState
	} catch {
		return null
	}
}

/**
 * Drop the files of PRs that left the tracked window and have been merged or
 * closed for PRUNE_AFTER_MS, and of issues whose log has been idle that long.
 * Open PRs outside the window keep their files: their state is unknown.
 */
export async function pruneOld(statusDir: string, eventsDir: string, window: Set<number>): Promise<void> {
	const { readdirSync, rmSync, statSync } = await import("node:fs")
	const cutoff = Date.now() - PRUNE_AFTER_MS
	const events = readdirSync(eventsDir)
	for (const f of readdirSync(statusDir)) {
		const m = /^pr-(\d+)\.json$/.exec(f)
		if (!m) continue
		const n = Number(m[1])
		if (window.has(n)) continue
		let snap: Snapshot
		try {
			snap = (await Bun.file(`${statusDir}/${f}`).json()) as Snapshot
		} catch {
			continue
		}
		if (snap.state === "OPEN") continue
		const last = Date.parse(snap.mergedAt ?? snap.updatedAt ?? "")
		if (!Number.isFinite(last) || last > cutoff) continue
		rmSync(`${statusDir}/${f}`, { force: true })
		for (const e of events) if (e.startsWith(`pr-${n}.`)) rmSync(`${eventsDir}/${e}`, { force: true })
	}
	for (const e of events) {
		const m = /^issue-(\d+)\.log$/.exec(e)
		if (!m) continue
		let mtime: number
		try {
			mtime = statSync(`${eventsDir}/${e}`).mtimeMs
		} catch {
			continue
		}
		if (mtime > cutoff) continue
		for (const f of events) if (f.startsWith(`issue-${m[1]}.`)) rmSync(`${eventsDir}/${f}`, { force: true })
	}
}

/**
 * ISSUE comment events — one repo-wide REST call per cycle
 * (`issues/comments?since=<cursor>`), mirroring the PR comment pattern:
 * `events/issue-<n>.comments.json` payload plus append-only
 * `events/issue-<n>.log` JSONL. First run records the cursor and never fires.
 * Comments whose issue is actually a PR are skipped — the PR flow owns those
 * (in-window PRs matched by number; out-of-window checked via a per-cycle
 * `issues/{n}` lookup, only on new-comment transitions). All authors are
 * emitted (bot included) — consumers filter by `actor`, same contract as the
 * PR events.
 */
async function pollIssueComments(
	config: RepoConfig,
	prevCursor: string | null | undefined,
	prNumbers: Set<number>,
	eventsDir: string,
	token: string,
): Promise<string> {
	const nowIso = new Date().toISOString()
	if (!prevCursor) return nowIso // baseline only — never fire on first sight

	const base = `https://api.github.com/repos/${config.org}/${config.repo}`
	const res = await fetch(`${base}/issues/comments?since=${encodeURIComponent(prevCursor)}&per_page=100&sort=updated&direction=asc`, {
		headers: ghHeaders(token),
	})
	if (!res.ok) throw new Error(`issue comments fetch HTTP ${res.status}`)
	const comments = (await res.json()) as Array<{
		id: number
		issue_url: string
		user: { login: string } | null
		created_at: string
		updated_at: string
		body: string | null
	}>

	const prevMs = Date.parse(prevCursor)
	let cursor = prevCursor
	const byIssue = new Map<number, typeof comments>()
	for (const c of comments) {
		if (Date.parse(c.updated_at) <= prevMs) continue // since= is inclusive
		if (Date.parse(c.updated_at) > Date.parse(cursor)) cursor = c.updated_at
		const n = Number(c.issue_url.split("/").pop())
		if (!Number.isFinite(n) || prNumbers.has(n)) continue
		if (!byIssue.has(n)) byIssue.set(n, [])
		byIssue.get(n)?.push(c)
	}

	for (const [n, list] of byIssue) {
		// out-of-window PR comments also arrive on this endpoint — skip them
		const issueRes = await fetch(`${base}/issues/${n}`, { headers: ghHeaders(token) })
		if (issueRes.ok && ((await issueRes.json()) as { pull_request?: unknown }).pull_request) continue

		const payload = list.map((c) => ({ issue: n, id: c.id, author: c.user?.login ?? "unknown", createdAt: c.created_at, body: capBody(c.body) }))
		await writeAtomic(`${eventsDir}/issue-${n}.comments.json`, `${JSON.stringify(payload, null, "\t")}\n`)
		for (const p of payload) {
			await appendEvent(eventsDir, `issue-${n}`, { at: p.createdAt, type: "commented", id: p.id, actor: p.author, body: p.body })
		}
	}
	return cursor
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

		// The previous snapshot is the transition detector for every event
		// below — read it BEFORE overwriting.
		let prev: Snapshot | null = null
		try {
			prev = JSON.parse(await Bun.file(`${statusDir}/pr-${pr.number}.json`).text())
		} catch {
			prev = null
		}

		const snapshot = {
			number: pr.number,
			state: pr.state,
			isDraft: pr.isDraft,
			merged: pr.merged,
			mergedAt: pr.mergedAt,
			branch: pr.headRefName,
			title: pr.title,
			checks: rollup, // SUCCESS | FAILURE | PENDING | ERROR | EXPECTED | null
			reviewDecision: pr.reviewDecision, // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
			commentCount, // issue comments + reviews combined (see Pr.reviews note above)
			lastCommentAt,
			updatedAt: pr.updatedAt,
			headOid: sha,
			fetchedAt,
		}
		await writeAtomic(`${statusDir}/pr-${pr.number}.json`, `${JSON.stringify(snapshot, null, "\t")}\n`)

		// Ready-stale: a READY (non-draft, open) PR whose head moved while ready —
		// someone pushed without flipping draft first, so the manager's final
		// check is void until it re-runs. Fires once per push, since the next
		// snapshot carries the new head.
		if (pr.state === "OPEN" && !pr.isDraft && prev?.state === "OPEN" && prev.isDraft === false && prev.headOid && sha && prev.headOid !== sha) {
			await appendEvent(eventsDir, pr.number, { at: fetchedAt, type: "ready-stale", sha })
		}

		if (pr.merged) {
			const marker = `${eventsDir}/pr-${pr.number}.merged`
			if (!(await Bun.file(marker).exists())) await appendEvent(eventsDir, pr.number, { at: fetchedAt, type: "merged" })
			await touch(marker)
		} else if (pr.state === "CLOSED" && prev?.state !== "CLOSED") {
			await appendEvent(eventsDir, pr.number, { at: fetchedAt, type: "closed" })
		}

		// CI rollup: an outcome is news when it differs from the last one seen,
		// or when it belongs to a new head.
		const headMoved = !!sha && prev?.headOid !== sha
		if (rollup === "SUCCESS") {
			if (prev?.checks !== "SUCCESS" || headMoved) await appendEvent(eventsDir, pr.number, { at: fetchedAt, type: "checks-success", sha })
		} else if (rollup === "FAILURE" || rollup === "ERROR") {
			if ((prev?.checks !== "FAILURE" && prev?.checks !== "ERROR") || headMoved) await appendEvent(eventsDir, pr.number, { at: fetchedAt, type: "checks-failure", sha })
		}

		// Approval decision, same shape.
		if (pr.reviewDecision === "APPROVED" && prev?.reviewDecision !== "APPROVED") {
			const rv = pr.reviews.nodes[0]
			await appendEvent(eventsDir, pr.number, { at: fetchedAt, type: "approved", actor: rv?.author?.login, body: capBody(rv?.body) })
		} else if (pr.reviewDecision === "CHANGES_REQUESTED" && prev?.reviewDecision !== "CHANGES_REQUESTED") {
			const rv = pr.reviews.nodes[0]
			await appendEvent(eventsDir, pr.number, { at: fetchedAt, type: "changes-requested", actor: rv?.author?.login, body: capBody(rv?.body) })
		}

		// Comment/review activity — cursor-based. No baseline (PR unseen since
		// this poller last started, or new to the tracked window) => record
		// the cursor only, never fire.
		const prevCursor = prevCursors[String(pr.number)]
		if (prevCursor !== undefined && commentCount > prevCursor.count) {
			try {
				const sinceAt = prevCursor.lastAt ?? new Date(0).toISOString()
				const newComments = await fetchNewComments(config.org, config.repo, pr.number, sinceAt, token)
				await writeAtomic(`${eventsDir}/pr-${pr.number}.comments.json`, `${JSON.stringify(newComments, null, "\t")}\n`)
				for (const c of newComments) {
					await appendEvent(eventsDir, pr.number, { at: c.createdAt, type: "commented", id: c.id, actor: c.author, kind: c.kind, path: c.path, line: c.line, body: c.body })
				}
			} catch (e) {
				console.error(`${new Date().toISOString()} pr-${pr.number} comments payload fetch failed: ${e instanceof Error ? e.message : e}`)
			}
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

	let issueCommentCursor = prevState?.issueCommentCursor ?? null
	try {
		issueCommentCursor = await pollIssueComments(config, issueCommentCursor, new Set(prs.map((p) => p.number)), eventsDir, token)
	} catch (e) {
		// keep the previous cursor — missed comments re-fetch next cycle
		console.error(`${new Date().toISOString()} [${config.name}] issue comments poll failed: ${e instanceof Error ? e.message : e}`)
	}

	let prunedAt = prevState?.prunedAt ?? null
	if (!prunedAt || Date.parse(prunedAt) < Date.now() - PRUNE_EVERY_MS) {
		try {
			await pruneOld(statusDir, eventsDir, new Set(prs.map((p) => p.number)))
			prunedAt = fetchedAt
		} catch (e) {
			console.error(`${new Date().toISOString()} [${config.name}] prune failed: ${e instanceof Error ? e.message : e}`)
		}
	}

	const state: PollState = { fetchedAt, prs: prs.map((p) => p.number), commentCursors: nextCursors, boardUpdatedAt, issueCommentCursor, prunedAt }
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
