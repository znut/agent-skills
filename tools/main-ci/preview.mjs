/**
 * main-ci preview gate — each eligible open PR merged onto a green tip and
 * checked by the config's preview command, inside a run (run.mjs). Design in
 * README.md §Preview gate.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { expandHome, writeAtomic } from "../lib/fs-util.mjs"
import { CANCELLED, jobSet } from "./jobs.mjs"

const SHORT_MS = 120_000
// Each gh pr ready runs the clone's ready check, which spends the shared GraphQL budget.
const READY_TRIES = 3
const ARCHIVE_DAYS = 30

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"))
	} catch {
		return null
	}
}

function message(e) {
	return e instanceof Error ? e.message : String(e)
}

function lastLine(file) {
	return readFileSync(file, "utf8").trim().split("\n").pop() || "no output"
}

// The first vitest "FAIL [project] <file> > <test>" or playwright "N) [project] › <file> › <test>" line of an attempt's log, ANSI stripped.
function firstFailingSpec(file) {
	if (!file) return ""
	try {
		const plain = readFileSync(file, "utf8").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
		return plain.match(/(?:\bFAIL\s+(\S.* > .+)|^\s*(?:\S+:\s+)?\d+\)\s+(\S.* › .+))$/m)?.slice(1).find(Boolean)?.trim() ?? ""
	} catch {
		return ""
	}
}

/** Starts the preview gate for the run on `sha`; nothing runs before start(). */
export function startPreviews(s, sha, env, runDir) {
	const p = s.mc.preview
	const resultsDir = expandHome(p.resultsDir)
	const cap = Math.max(1, p.concurrency ?? 1)
	const main8 = sha.slice(0, 8)
	const aux = jobSet(s) // eligibility, follow-ups, and retirement, outside any one preview
	const queue = [] // { number, head, branch, ready }, ready PRs first
	const running = new Map() // pr -> { head, jobs, done }
	const settled = new Map() // pr -> head whose result this tip has followed up
	const failed = new Map() // pr -> head whose preview failed on this tip; the next tip retries
	const readyTries = new Map() // pr -> { head, count } of failed gh pr ready calls on this tip
	let started = false
	let stopped = false
	let scanning = null

	const prDir = (n) => join(resultsDir, `pr-${n}`)
	// Red logs outlive their PR here, so a flake ticket keeps its evidence.
	const archiveDir = (n) => join(resultsDir, "red-archive", `pr-${n}`)
	const pairOf = (head) => `${head.slice(0, 8)}-${main8}`
	const treeOf = (n) => join(s.dir, "previews", `pr-${n}`)
	const prEnv = (pr) => ({ ...env, MAIN_CI_PR: String(pr.number), MAIN_CI_HEAD: pr.head ?? "", MAIN_CI_BRANCH: pr.branch ?? "", MAIN_CI_PREVIEW: treeOf(pr.number) })

	// A short driver-side command for one PR; its output lands in the run dir.
	async function run(jobs, pr, label, cmd, cwd, extra = {}) {
		const file = join(runDir, `preview-${pr.number}-${label}.log`)
		const code = await jobs.exec(`preview #${pr.number} ${label}`, cmd, { cwd, env: { ...prEnv(pr), ...extra }, file, timeoutMs: SHORT_MS })
		return { code, file }
	}

	async function view(jobs, pr) {
		const r = await run(jobs, pr, "view", 'gh pr view "$MAIN_CI_PR" --repo "$MAIN_CI_REPO" --json isDraft,headRefOid', s.worktree)
		// The log holds stderr too; the JSON object is the part between braces.
		const text = readFileSync(r.file, "utf8")
		const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
		try {
			if (r.code === 0) return JSON.parse(json)
		} catch {}
		throw new Error(`gh pr view FAILED exit=${r.code}: ${lastLine(r.file)}`)
	}

	function statuses() {
		const dir = s.statusDir
		if (!existsSync(dir)) return []
		const out = []
		for (const f of readdirSync(dir)) {
			if (!/^pr-\d+\.json$/.test(f)) continue
			const j = readJson(join(dir, f))
			if (j?.number) out.push({ number: j.number, state: j.state, isDraft: j.isDraft, branch: j.branch, head: j.headOid })
		}
		return out
	}

	// Newest green result for this head on an earlier tip, as the carry candidate.
	function priorGreen(n, head) {
		const dir = prDir(n)
		if (!existsSync(dir)) return null
		const re = new RegExp(`^${head.slice(0, 8)}-[0-9a-f]{8}\\.json$`)
		return readdirSync(dir)
			.filter((f) => re.test(f))
			.map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs, j: readJson(join(dir, f)) }))
			.filter((x) => x.j?.green === true && x.j.main !== sha)
			.sort((a, b) => b.at - a.at)
			.map((x) => ({ name: x.f.replace(/\.json$/, ""), main: x.j.main }))[0] ?? null
	}

	// A green result restores the ready state the preview took; a red one
	// sends the config's notice once per (head, tip) pair. False = retry on the next poll.
	async function followUp(jobs, pr, result) {
		const dir = prDir(pr.number)
		const vouchFile = join(dir, "vouched.json")
		if (result.green) {
			if (readJson(vouchFile)?.head !== pr.head) return true
			const now = await view(jobs, pr)
			if (now.headRefOid !== pr.head) {
				s.log(`preview #${pr.number}: stays draft, head moved to ${now.headRefOid.slice(0, 8)}`)
				return true
			}
			if (!now.isDraft) {
				rmSync(vouchFile, { force: true })
				return true
			}
			const prev = readyTries.get(pr.number)
			const used = prev?.head === pr.head ? prev.count : 0
			if (used >= READY_TRIES) return true
			const r = await run(jobs, pr, "ready", 'gh pr ready "$MAIN_CI_PR" --repo "$MAIN_CI_REPO"', s.worktree)
			if (r.code !== 0) {
				const count = used + 1
				readyTries.set(pr.number, { head: pr.head, count })
				const giveUp = count >= READY_TRIES
				s.log(`preview #${pr.number}: stays draft, gh pr ready FAIL exit=${r.code} (${count}/${READY_TRIES}) — ${lastLine(r.file)}; ${giveUp ? "giving up until the next head or tip" : "retrying on the next poll"}`)
				return giveUp
			}
			rmSync(vouchFile, { force: true })
			s.log(`preview #${pr.number}: ready again`)
			return true
		}
		// A failed notice waits for the next tip: an unroutable PR would cost a gh call every poll.
		const marker = join(dir, `${pairOf(pr.head)}.notified`)
		if (!p.notify || existsSync(marker)) return true
		const r = await run(jobs, pr, "notify", p.notify, s.worktree, { MAIN_CI_RESULT: join(dir, `${pairOf(pr.head)}.json`), MAIN_CI_SPEC: firstFailingSpec(result.log), MAIN_CI_LOG_ARCHIVE: archiveDir(pr.number) })
		if (r.code === 0) writeFileSync(marker, "")
		else s.log(`preview #${pr.number}: notify FAIL exit=${r.code} — ${lastLine(r.file)}`)
		return true
	}

	// Settled only once nothing is left to retry, so the next poll repeats a failed follow-up.
	async function settle(jobs, pr, result) {
		try {
			if (await followUp(jobs, pr, result)) settled.set(pr.number, pr.head)
		} catch (e) {
			if (e === CANCELLED) throw e
			s.log(`preview #${pr.number}: FAIL ${message(e)}; retrying on the next poll`)
		}
	}

	async function preview(jobs, pr) {
		const n = pr.number
		const dir = prDir(n)
		const pair = pairOf(pr.head)
		const tree = treeOf(n)
		const now = await view(jobs, pr)
		if (now.headRefOid !== pr.head) {
			return s.log(`preview #${n}: GitHub head is ${now.headRefOid.slice(0, 8)}, not ${pr.head.slice(0, 8)}; waiting for gh-status`)
		}
		mkdirSync(dir, { recursive: true })
		// A pairing without a result is fresh, a rerun after a deleted result file included.
		settled.delete(n)
		readyTries.delete(n)
		const must = async (label, cmd, cwd) => {
			const r = await run(jobs, pr, label, cmd, cwd)
			if (r.code !== 0) throw new Error(`${label} FAILED exit=${r.code}: ${lastLine(r.file)}`)
		}
		// --lock: repo cleanup scripts reap unlocked worktrees.
		if (!existsSync(tree)) await must("add", 'git worktree add -q --detach --lock --reason main-ci-preview "$MAIN_CI_PREVIEW" "$MAIN_CI_SHA"', s.repo)
		await must("fetch", 'git fetch -q origin "$MAIN_CI_HEAD" && git checkout -q --detach -f "$MAIN_CI_SHA" && git clean -q -fd -e node_modules', tree)
		const conflict = (await run(jobs, pr, "merge", 'git merge -q --no-ff --no-edit "$MAIN_CI_HEAD" || { git merge --abort; exit 1; }', tree)).code !== 0

		let carried = null
		if (!conflict && p.unaffected) {
			const prior = priorGreen(n, pr.head)
			if (prior && (await run(jobs, pr, "unaffected", p.unaffected, s.worktree, { MAIN_CI_PRIOR: prior.main })).code === 0) carried = prior.name
		}
		// Draft for the check itself; a carried green leaves a ready PR ready. The
		// vouch comes first: a cancel after GitHub took the draft must not lose it.
		if (!carried && !now.isDraft) {
			writeAtomic(join(dir, "vouched.json"), `${JSON.stringify({ head: pr.head, at: new Date().toISOString().replace(/\.\d+Z$/, "Z") })}\n`)
			const r = await run(jobs, pr, "draft", 'gh pr ready --undo "$MAIN_CI_PR" --repo "$MAIN_CI_REPO"', s.worktree)
			if (r.code !== 0) throw new Error(`gh pr ready --undo FAILED exit=${r.code}: ${lastLine(r.file)}`)
		}

		let green = false
		let log = ""
		if (carried) green = true
		else if (!conflict) {
			// Every attempt keeps its own log; a rerun after a deleted result is the next attempt.
			const kept = existsSync(archiveDir(n)) ? readdirSync(archiveDir(n)) : []
			const taken = [...readdirSync(dir), ...kept].map((f) => f.match(new RegExp(`^${pair}\\.(\\d+)(?:-\\d+)?\\.log$`))?.[1])
			log = join(dir, `${pair}.${Math.max(0, ...taken.filter(Boolean).map(Number)) + 1}.log`)
			s.log(`preview #${n} ${pair}: start`)
			green = (await jobs.exec(`preview #${n}`, p.cmd, { cwd: tree, env: prEnv(pr), file: log, metrics: { run: basename(runDir), sha, job: `preview-${n}`, kind: "preview", pr: n, attempt: 1 } })) === 0
		}
		const result = { pr: n, head: pr.head, main: sha, green, conflict, log, finishedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z") }
		if (carried) result.inherited = carried
		writeAtomic(join(dir, `${pair}.json`), `${JSON.stringify(result)}\n`)
		s.log(`preview #${n} ${pair}: ${conflict ? "CONFLICT" : carried ? `green (carried from ${carried})` : green ? "green" : `RED — ${log}`}`)
		await settle(jobs, pr, result)
	}

	function pump() {
		while (!stopped && running.size < cap) {
			const i = queue.findIndex((q) => !running.has(q.number))
			if (i < 0) return
			const [pr] = queue.splice(i, 1)
			const jobs = jobSet(s)
			const entry = { head: pr.head, jobs }
			entry.done = preview(jobs, pr)
				.catch((e) => {
					if (e === CANCELLED) return s.log(`preview #${pr.number}: cancelled`)
					failed.set(pr.number, pr.head)
					s.log(`preview #${pr.number}: FAIL ${message(e)}`)
				})
				.finally(() => {
					if (running.get(pr.number) === entry) running.delete(pr.number)
					// A macrotask later, so a head move's re-queue of this PR ranks first.
					setTimeout(pump, 0)
				})
			running.set(pr.number, entry)
		}
	}

	function enqueue(pr) {
		const i = pr.ready ? queue.findIndex((q) => !q.ready) : -1
		if (i < 0) queue.push(pr)
		else queue.splice(i, 0, pr)
		s.log(`preview #${pr.number} ${pairOf(pr.head)}: queued (${pr.ready ? "ready" : "draft with a PASS"})`)
	}

	// A merged or closed PR loses its preview worktree and its results.
	async function retire(pr) {
		const i = queue.findIndex((q) => q.number === pr.number)
		if (i >= 0) queue.splice(i, 1)
		if (running.has(pr.number)) return
		const tree = treeOf(pr.number)
		if (existsSync(tree) && (await run(aux, pr, "remove", 'git worktree remove -f -f "$MAIN_CI_PREVIEW"', s.repo)).code !== 0) {
			rmSync(tree, { recursive: true, force: true })
			await run(aux, pr, "prune", "git worktree prune", s.repo)
		}
		archiveRedLogs(pr.number)
		if (existsSync(prDir(pr.number))) rmSync(prDir(pr.number), { recursive: true, force: true })
		sweepArchive()
	}

	// Every attempt log except the ones a green result records is red.
	function archiveRedLogs(n) {
		const dir = prDir(n)
		if (!existsSync(dir)) return
		const files = readdirSync(dir)
		const green = new Set(files.filter((f) => f.endsWith(".json")).map((f) => readJson(join(dir, f))).filter((j) => j?.green === true && j.log).map((j) => basename(j.log)))
		for (const f of files.filter((x) => /^[0-9a-f]{8}-[0-9a-f]{8}(\.\d+)?\.log$/.test(x) && !green.has(x))) {
			mkdirSync(archiveDir(n), { recursive: true })
			// A legacy unnumbered log is attempt 0; an archived name is never overwritten.
			const stem = f.replace(/(\.\d+)?\.log$/, "")
			const base = /\.\d+\.log$/.test(f) ? f.slice(0, -4) : `${stem}.0`
			let to = `${base}.log`
			for (let k = 2; existsSync(join(archiveDir(n), to)); k++) to = `${base}-${k}.log`
			renameSync(join(dir, f), join(archiveDir(n), to))
		}
	}

	function sweepArchive() {
		const root = join(resultsDir, "red-archive")
		if (!existsSync(root)) return
		const cutoff = Date.now() - ARCHIVE_DAYS * 86_400_000
		for (const d of readdirSync(root)) {
			const dir = join(root, d)
			for (const f of readdirSync(dir)) if (statSync(join(dir, f)).mtimeMs < cutoff) rmSync(join(dir, f), { force: true })
			if (readdirSync(dir).length === 0) rmdirSync(dir)
		}
	}

	async function consider(pr) {
		const n = pr.number
		if (pr.state !== "OPEN") return retire(pr)
		if (!pr.head) return
		const r = running.get(n)
		if (r && r.head === pr.head) return
		if (r) {
			s.log(`preview #${n}: head moved ${r.head.slice(0, 8)} -> ${pr.head.slice(0, 8)}; cancelling its preview`)
			await r.jobs.cancel()
			await r.done
		}
		const q = queue.findIndex((x) => x.number === n)
		if (q >= 0) {
			if (queue[q].head === pr.head) return
			queue.splice(q, 1)
		}
		if (failed.get(n) === pr.head) return
		// A deleted result file is a rerun request: the pair runs again.
		const result = readJson(join(prDir(n), `${pairOf(pr.head)}.json`))
		if (result) {
			if (settled.get(n) !== pr.head) await settle(aux, pr, result)
			return
		}
		// A PR this driver drafted for its preview still ranks as ready.
		const ready = !pr.isDraft || readJson(join(prDir(n), "vouched.json"))?.head === pr.head
		if (!ready && !(p.eligible && (await run(aux, pr, "eligible", p.eligible, s.worktree)).code === 0)) return
		enqueue({ ...pr, ready })
	}

	/** One pass over gh-status: a PR without a result for its (head, tip) pair gets one. */
	function scan() {
		if (!started || stopped || scanning) return scanning
		scanning = (async () => {
			for (const pr of statuses()) {
				if (stopped) return
				try {
					await consider(pr)
				} catch (e) {
					if (e !== CANCELLED) s.log(`preview #${pr.number}: FAIL ${message(e)}`)
				}
			}
			pump()
		})().finally(() => {
			scanning = null
		})
		return scanning
	}

	// gh-status showing no open PR while GitHub lists some is a failure, not an empty pass.
	async function start() {
		if (started || stopped) return
		started = true
		s.log(`preview start sha=${sha}`)
		try {
			if (!statuses().some((pr) => pr.state === "OPEN")) {
				const r = await run(aux, { number: "all" }, "list", 'gh pr list --repo "$MAIN_CI_REPO" --state open --json number --jq length', s.worktree)
				const count = Number(lastLine(r.file))
				if (r.code !== 0 || count !== 0) s.log(`preview: FAIL gh-status lists no open PR; gh pr list ${r.code === 0 ? `lists ${count}` : `FAILED exit=${r.code}`}`)
			}
		} catch (e) {
			if (e !== CANCELLED) s.log(`preview: FAIL ${message(e)}`)
		}
		await scan()
	}

	async function cancel() {
		stopped = true
		queue.length = 0
		const live = [...running.values()]
		const ends = await Promise.all([aux.cancel(), ...live.map((r) => r.jobs.cancel())])
		await Promise.all(live.map((r) => r.done))
		await scanning
		return { live: ends.flatMap((e) => e.live), stubborn: ends.flatMap((e) => e.stubborn) }
	}

	function kill() {
		stopped = true
		aux.kill()
		for (const r of running.values()) r.jobs.kill()
	}

	return { start, scan, cancel, kill }
}
