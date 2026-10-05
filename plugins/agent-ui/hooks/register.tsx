import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, FsEntry, PluginOptions, Register, Timer } from 'claude-code'

import type { OpenAsk, Run } from '../types'
import { type Avatar, SPRITE_COLS, avatarCells, avatarOf, avatarPicture } from './sprites'
import {
  AXIS_COLS,
  CHART_ROWS,
  type Cell,
  type CiRun,
  METRICS,
  type MainState,
  type Metric,
  type MetricRow,
  axisLabels,
  barMax,
  barTotal,
  cardPlace,
  cardTable,
  chartCells,
  chartTiles,
  encodeCells,
  fnv1a,
  jobColor,
  markCancelled,
  parseRows,
  placeBeside,
  runsFit,
  summarize,
  tileCells,
  withPending,
} from './ci'
import {
  TAIL_LINES,
  busStateDir,
  codexTail,
  elapsed,
  epochMs,
  kindOf,
  labelOf,
  lines,
  parentDir,
  applyRunLog,
  freshRunLog,
  previewQueue,
  type RunLog,
  resultJsonMessage,
  statusOf,
} from './lib'
import {
  PANEL_TIMEOUT_MS,
  type PanelData,
  type PanelRow,
  type PanelSpec,
  type PanelTab,
  type Segment,
  clip,
  firstLine,
  headerSegments,
  parsePanelOutput,
  parseSpecs,
  pickOptions,
  pickTab,
  rowSegments,
} from './panels'

type $ = EngineInterface
type Root = { dir: string; isPanel: boolean }
type Tail = { lines: string[]; lastMessage: string }
type Cached = { key: string; mtimeMs: number; done: boolean; probe: Probe | null }
type RunDir = { dir: string; mtimeMs: number }
type Probe = { run: Run; pid: string; hasDone: boolean; exitCode: string; unowned: boolean; startMs: number | null; lastMtime: number }
type NativeRun = { id: string; label: string; kind: string; status: Run['status'] }
type Row = {
  key: string
  kind: string
  label: string
  status: Run['status']
  avatar: Avatar | null
  model?: string
  duration?: string
  diskRun?: Run
  agentId?: string
  parent?: string
  children: Row[]
}
type PrRow = { number: number; title: string; head: string }
type PrFile = { mtimeMs: number; pr: PrRow | null; done: number | null }
type PrCache = { key: string; files: Map<string, PrFile>; open: Map<number, PrRow>; done: Set<number> }

const REFRESH_MS = 3000
const RECENT_DONE = 5
const LIVE_WINDOW_MS = 24 * 3_600_000
const MAX_ROWS = 30
const TAIL_BYTES = 262_144
const ASK_ACCENT = '#CBA6F7'

// Probes keyed by the out-dir's listing (names + newest file mtime): a resume that
// removes `done`, or a new owner stamp, changes the key and forces a re-probe.
// A run with `done` is immutable: it is not re-listed while its parent's entry mtime holds.
const probes = new Map<string, Cached>()
const shaRuns = new Map<string, { mtimeMs: number; runs: RunDir[] }>()
let prCache: PrCache = { key: '', files: new Map(), open: new Map(), done: new Set() }
let boardCache = { key: '', done: new Set<number>() }

async function readText($: $, path: string): Promise<string> {
  return $.fs.read(path).then(
    text => (typeof text === 'string' ? text.trim() : ''),
    () => '',
  )
}

async function listDir($: $, path: string): Promise<FsEntry[]> {
  return $.fs.list(path).catch(() => [])
}

async function tailBytes($: $, path: string): Promise<string> {
  const ran = await $.process.run(['tail', '-c', String(TAIL_BYTES), path]).catch(() => null)
  return ran?.exitCode === 0 ? ran.stdout : ''
}

// One answer per session cwd, hit or miss: a non-git cwd costs one lookup per cwd change, and
// a later repo cwd resolves afresh. The promise is cached, so concurrent callers share one run.
const byCwd = new Map<string, { cwd: string; value: Promise<unknown> }>()

async function perCwd<T>($: $, name: string, compute: () => Promise<T>): Promise<T> {
  const cwd = await $.session.cwd()
  const hit = byCwd.get(name)
  if (hit?.cwd === cwd) return hit.value as Promise<T>
  const entry = { cwd, value: compute() }
  byCwd.set(name, entry)
  entry.value.catch(() => { if (byCwd.get(name) === entry) byCwd.delete(name) })
  return entry.value
}

async function gitCommonDir($: $): Promise<string | null> {
  return perCwd($, 'git', async () => {
    const ran = await $.process
      .run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
      .catch(() => null)
    return ran?.exitCode === 0 ? ran.stdout.trim() : null
  })
}

async function resolveRoots($: $, options: PluginOptions): Promise<Root[]> {
  return perCwd($, 'roots', async () => {
    const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
    const children = String(options.childrenDir ?? '').replace(/\/+$/, '') || `${tmp}/agent-tools/children`
    const common = await gitCommonDir($)
    return [{ dir: children, isPanel: false }, ...(common ? [{ dir: `${common}/.review-panel`, isPanel: true }] : [])]
  })
}

const subDirs = (entries: FsEntry[], parent: string): RunDir[] =>
  entries.filter(entry => entry.kind === 'dir').map(entry => ({ dir: `${parent}/${entry.name}`, mtimeMs: entry.mtimeMs }))

// A sha dir is re-listed only when its own mtime moves (a new panel run dir appears).
async function runDirs($: $, root: Root): Promise<RunDir[]> {
  const top = subDirs(await listDir($, root.dir), root.dir)
  if (!root.isPanel) return top
  const nested = await Promise.all(
    top.map(async sha => {
      let cached = shaRuns.get(sha.dir)
      if (cached?.mtimeMs !== sha.mtimeMs) {
        cached = { mtimeMs: sha.mtimeMs, runs: subDirs(await listDir($, sha.dir), sha.dir) }
        shaRuns.set(sha.dir, cached)
      }
      return cached.runs
    }),
  )
  return nested.flat()
}

async function probe($: $, dir: string, entries: FsEntry[], isPanel: boolean, sid: string): Promise<Probe | null> {
  const names = new Map(entries.map(entry => [entry.name, entry]))
  const pidEntry = names.get('pid')
  if (!pidEntry) return null
  const field = (name: string) => (names.has(name) ? readText($, `${dir}/${name}`) : Promise.resolve(''))
  const [owner, pid, provider, model, fullModel, start, end, exitCode, cwd, agent] = await Promise.all([
    field('owner-session'),
    field('pid'),
    field('provider'),
    field('model'),
    field('full-model'),
    field('start-epoch'),
    field('end-epoch'),
    field('exit-code'),
    field('cwd'),
    field('agent'),
  ])
  if (owner !== '' && sid !== '' && owner !== sid) return null
  const lastMtime = Math.max(0, ...entries.map(entry => entry.mtimeMs))
  const startMs = epochMs(start)
  const evidence = names.has('result.jsonl') ? 'codex-events' : fullModel
  const inferred = kindOf(provider, isPanel, evidence)
  const providerLabel = provider || (inferred === 'gpt' ? 'gpt' : '?')
  const modelLabel = model || fullModel.replace(/^gpt-/, '') || '?'
  const hasDone = names.has('done')
  const startedAt = startMs ?? (pidEntry.mtimeMs || null)
  const endedAt = epochMs(end) ?? (lastMtime || null)
  return {
    pid,
    hasDone,
    exitCode,
    unowned: owner === '',
    startMs,
    lastMtime,
    run: {
      dir,
      kind: inferred,
      label: labelOf(dir, isPanel),
      cwd,
      isReviewer: isPanel || agent === 'reviewer',
      model: [providerLabel, modelLabel].join('/'),
      status: 'running',
      startedAt,
      endedAt,
    },
  }
}

async function alivePids($: $, pids: string[]): Promise<Set<string>> {
  const valid = pids.filter(pid => /^\d+$/.test(pid))
  if (valid.length === 0) return new Set()
  const ran = await $.process.run(['ps', '-o', 'pid=', '-p', valid.join(',')]).catch(() => null)
  return new Set((ran?.stdout ?? '').split(/\s+/).filter(Boolean))
}

async function scanRuns($: $, options: PluginOptions, now: number): Promise<Run[]> {
  const sid = await $.session.id()
  const found: Probe[] = []
  const seen = new Set<string>()
  for (const root of await resolveRoots($, options)) {
    for (const { dir, mtimeMs } of await runDirs($, root)) {
      seen.add(dir)
      let cached = probes.get(dir)
      if (!(cached?.done && cached.mtimeMs === mtimeMs)) {
        const entries = await listDir($, dir)
        const key = entries
          .map(entry => entry.name)
          .sort()
          .concat(String(Math.max(0, ...entries.map(entry => entry.mtimeMs))))
          .join('/')
        if (cached?.key !== key) {
          const done = entries.some(entry => entry.name === 'done')
          cached = { key, mtimeMs, done, probe: await probe($, dir, entries, root.isPanel, sid) }
        } else cached.mtimeMs = mtimeMs
        probes.set(dir, cached)
      }
      if (cached.probe) found.push(cached.probe)
    }
  }
  for (const dir of probes.keys()) if (!seen.has(dir)) probes.delete(dir)
  // older runs without `done` read as dead: bounds the ps list and ignores reused pids
  const recent = (one: Probe) => now - (one.run.startedAt ?? 0) <= LIVE_WINDOW_MS
  const alive = await alivePids($, found.filter(one => !one.hasDone && recent(one)).map(one => one.pid))
  const running: Run[] = []
  const done: Run[] = []
  for (const one of found) {
    if (one.unowned && now - Math.max(one.startMs ?? 0, one.lastMtime) > LIVE_WINDOW_MS) continue
    const run = { ...one.run, status: statusOf(one.hasDone, one.exitCode, recent(one) && alive.has(one.pid)) }
    ;(run.status === 'running' ? running : done).push(run)
  }
  const when = (run: Run) => run.endedAt ?? run.startedAt ?? 0
  done.sort((a, b) => when(b) - when(a))
  running.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  return [...running, ...done]
}

function runElapsed(run: Run, now: number): string {
  return run.startedAt === null ? '?' : elapsed(((run.status === 'running' ? now : run.endedAt) ?? now) - run.startedAt)
}

// GPT runs stream codex events to result.jsonl; Claude and Kimi runs only stderr.log.
async function readTail($: $, run: Run): Promise<Tail> {
  const names = new Set((await listDir($, run.dir)).map(entry => entry.name))
  const tail = names.has('result.jsonl')
    ? codexTail(await tailBytes($, `${run.dir}/result.jsonl`))
    : names.has('stderr.log')
      ? lines(await tailBytes($, `${run.dir}/stderr.log`)).slice(-TAIL_LINES)
      : []
  let lastMessage = ''
  if (run.status !== 'running') {
    lastMessage = names.has('last-message')
      ? await readText($, `${run.dir}/last-message`)
      : resultJsonMessage(names.has('result.json') ? await readText($, `${run.dir}/result.json`) : '')
  }
  return { lines: tail, lastMessage }
}

async function readNativeTail($: $, agentId: string): Promise<Tail> {
  const messages = await $.session.messages({ agentId }).catch(() => [])
  if (!Array.isArray(messages)) return { lines: [], lastMessage: '' }
  const linesOut = messages.flatMap(message => lines(message.text)).slice(-TAIL_LINES)
  return { lines: linesOut, lastMessage: '' }
}

type PrState = { prs: PrRow[]; gates: Map<number, Record<string, unknown> | null> }

// The gh-status files, re-read only where a file's mtime moved: the open PRs, and the numbers of
// PRs that are MERGED or CLOSED.
async function refreshPrCache($: $, dir: string): Promise<PrCache> {
  const entries = (await listDir($, `${dir}/status`)).filter(entry => entry.kind === 'file' && /^pr-\d+\.json$/.test(entry.name))
  const key = entries.map(entry => `${entry.name}:${entry.mtimeMs}`).sort().join('|')
  const cache = prCache
  if (cache.key !== key) {
    const current = new Set(entries.map(entry => entry.name))
    for (const name of cache.files.keys()) if (!current.has(name)) cache.files.delete(name)
    const changed = entries.filter(entry => cache.files.get(entry.name)?.mtimeMs !== entry.mtimeMs)
    const parsed = await Promise.all(changed.map(async entry => {
      const value = jsonObject(await readText($, `${dir}/status/${entry.name}`))
      const pr = value?.state === 'OPEN' && value.isDraft === false && typeof value.number === 'number'
        ? { number: value.number, title: typeof value.title === 'string' ? value.title : '', head: typeof value.headOid === 'string' ? value.headOid : '' }
        : null
      const done = (value?.state === 'MERGED' || value?.state === 'CLOSED') && typeof value.number === 'number' ? value.number : null
      return [entry.name, { mtimeMs: entry.mtimeMs, pr, done }] as const
    }))
    for (const [name, file] of parsed) cache.files.set(name, file)
    cache.open = new Map([...cache.files.values()].flatMap(file => file.pr ? [[file.pr.number, file.pr] as const] : []))
    cache.done = new Set([...cache.files.values()].flatMap(file => file.done === null ? [] : [file.done]))
    cache.key = key
  }
  return cache
}

async function readReadyPrs($: $, options: PluginOptions, mainSha: string): Promise<PrState> {
  const dir = await resolveGhStatusDir($, options)
  if (!dir) return { prs: [], gates: new Map() }
  const cache = await refreshPrCache($, dir)
  const prs = [...cache.open.values()]
  const gates = new Map<number, Record<string, unknown> | null>()
  await Promise.all(prs.map(async pr => {
    const path = `${parentDir(dir)}/gate/pr-${pr.number}/${pr.head.slice(0, 8)}-${mainSha.slice(0, 8)}.json`
    gates.set(pr.number, jsonObject(await readText($, path)))
  }))
  const rank = (pr: PrRow) => {
    const gate = gates.get(pr.number)
    return gate?.green === true ? 0 : gate === null ? 1 : 2
  }
  prs.sort((a, b) => rank(a) - rank(b) || a.number - b.number)
  return { prs, gates }
}

type MainStrip = { sha: string; state: string; queue: { running: number; queued: number }; ciDir: string; ci: MainState; metrics: FsEntry | null; log: LogFeed | null }

// A file read as it grows: the first read takes the last `window` bytes from a line start, each
// later one only the whole lines appended since. The offset stays on a line boundary, so a
// partial last line is read again whole next time. A caller starts over on a shorter file.
type Cursor = { path: string; offset: number }

// Bytes of `text` as read from the file: a read that starts inside a character decodes each of
// its stray bytes as one U+FFFD, which TextEncoder would count as three.
function fileBytes(text: string, fromMidFile: boolean): number {
  const stray = fromMidFile ? (/^\uFFFD*/.exec(text)?.[0].length ?? 0) : 0
  return new TextEncoder().encode(text).length - 2 * stray
}

async function readAppended($: $, cursor: Cursor, size: number, window: number): Promise<{ text: string; midFile: boolean } | null> {
  if (size === cursor.offset) return null
  const offset = cursor.offset
  const start = offset < 0 ? Math.max(0, size - window) : offset
  const ran = await $.process.run(['tail', '-c', `+${start + 1}`, cursor.path]).catch(() => null)
  // another render read these bytes while this one waited
  if (cursor.offset !== offset || ran?.exitCode !== 0) return null
  const midFile = offset < 0 && start > 0
  const text = ran.stdout
  const from = midFile ? text.indexOf('\n') + 1 : 0
  const cut = text.lastIndexOf('\n') + 1
  if (cut <= from) return null
  cursor.offset = start + fileBytes(text.slice(0, cut), midFile)
  return { text: text.slice(from, cut), midFile }
}

// run.log replayed as it grows; `version` moves when a cancel is added.
type LogFeed = Cursor & { log: RunLog; version: number }
const LOG_WINDOW = 1_048_576
let logFeed: LogFeed | null = null

async function readMainStrip($: $, options: PluginOptions): Promise<MainStrip | null> {
  const ghDir = await resolveGhStatusDir($, options)
  if (!ghDir) return null
  const root = parentDir(ghDir)
  const stateText = await readText($, `${root}/main-ci/state.json`)
  const state = jsonObject(stateText)
  if (!state || typeof state.sha !== 'string') return null
  const main8 = state.sha.slice(0, 8)
  const logPath = `${root}/main-ci/run.log`
  const listing = await listDir($, `${root}/main-ci`)
  const logStat = listing.find(entry => entry.name === 'run.log' && entry.kind === 'file')
  if (logStat) {
    if (!logFeed || logFeed.path !== logPath || logStat.size < logFeed.offset) logFeed = { path: logPath, offset: -1, log: freshRunLog(), version: ++ciVersion }
    const feed = logFeed
    const read = await readAppended($, feed, logStat.size, LOG_WINDOW)
    if (read && logFeed === feed) {
      const cancels = feed.log.cancels.length
      applyRunLog(feed.log, read.text)
      if (feed.log.cancels.length !== cancels) feed.version = ++ciVersion
    }
  }
  const log = logStat ? logFeed : null
  return {
    sha: main8,
    state: state.green === true ? 'green' : state.phase === 'done' ? 'failed' : String(state.phase ?? 'running'),
    queue: log ? previewQueue(log.log, main8) : { running: 0, queued: 0 },
    log,
    ciDir: `${root}/main-ci`,
    ci: { sha: state.sha, phase: String(state.phase ?? '') },
    metrics: listing.find(entry => entry.name === 'metrics.jsonl' && entry.kind === 'file') ?? null,
  }
}

// metrics.jsonl as it grows: the first read takes the tail that holds `cap` runs.
type CiFeed = Cursor & { cap: number; rows: Map<string, MetricRow[]>; runs: CiRun[]; version: number }
const RUN_BYTES = 16_384
let ciFeed: CiFeed | null = null
// Feed versions never repeat, a fresh feed's included, so a chart cached on one cannot match.
let ciVersion = 0
const freshFeed = (path: string, cap: number): CiFeed => ({ path, cap, offset: -1, rows: new Map(), runs: [], version: ++ciVersion })

async function readCiRuns($: $, main: MainStrip, need: number): Promise<CiFeed | null> {
  const path = `${main.ciDir}/metrics.jsonl`
  const stat = main.metrics
  if (!stat) return null
  if (!ciFeed || ciFeed.path !== path || need > ciFeed.cap || stat.size < ciFeed.offset) ciFeed = freshFeed(path, Math.max(need, ciFeed?.cap ?? 0))
  const feed = ciFeed
  const read = await readAppended($, feed, stat.size, feed.cap * RUN_BYTES)
  if (!read || ciFeed !== feed) return ciFeed
  const rows = parseRows(read.text)
  if (rows.length === 0) return feed
  for (const row of rows) {
    const list = feed.rows.get(row.run)
    if (list) list.push(row)
    else feed.rows.set(row.run, [row])
  }
  const names = [...feed.rows.keys()].sort()
  // a read from mid-file can begin inside its oldest run
  if (read.midFile && names.length > 0) feed.rows.delete(names.shift() as string)
  for (const name of names.splice(0, Math.max(0, names.length - feed.cap))) feed.rows.delete(name)
  feed.runs = names.map(name => summarize(name, feed.rows.get(name) ?? []))
  feed.version = ++ciVersion
  return feed
}

type CiCard = ReturnType<typeof cardTable> & { left: number }
type CiChart = { key: string; metric: Metric; runs: CiRun[]; max: number; tiles: ReturnType<typeof chartTiles>; cards: CiCard[]; fallback?: { grids: Cell[][][]; cells: string[] } }
let ciChart: CiChart | null = null

// Encoded again only when a run is added or changes, main-ci's state moves, or the width or the
// metric does.
async function readCiChart($: $, main: MainStrip, bodyColumns: number, metric: Metric): Promise<CiChart | null> {
  const fit = runsFit(bodyColumns)
  const feed = fit > 0 ? await readCiRuns($, main, fit) : null
  if (!feed) return null
  const key = `${feed.version}|${main.log?.version ?? 0}|${main.ci.sha}|${main.ci.phase}|${bodyColumns}|${metric}`
  if (ciChart?.key === key) return ciChart
  const runs = markCancelled(withPending(feed.runs, main.ci), main.log?.log.cancels ?? []).slice(-fit)
  if (runs.length === 0) return null
  // a card's border and padding take 4 columns beside its content
  const cards = runs.map((run, i) => {
    const place = cardPlace(i, cardTable(run, bodyColumns - 4).width + 4, bodyColumns)
    return { ...cardTable(run, place.width - 4), left: place.x }
  })
  ciChart = { key, metric, runs, max: barMax(runs, metric), tiles: chartTiles(runs, metric), cards }
  return ciChart
}

// Block-glyph cells, built only where a picture cannot be drawn.
function fallbackOf(chart: CiChart): { grids: Cell[][][]; cells: string[] } {
  if (!chart.fallback) {
    const grid = chartCells(chart.runs, chart.metric)
    const grids = chart.runs.map((_, i) => tileCells(grid, i))
    chart.fallback = { grids, cells: grids.map(encodeCells) }
  }
  return chart.fallback
}

// Repo panels: the list re-read when its file changes; each panel's last good output and last
// error kept per root, id and argv.
type PanelRun = { data: PanelData | null; error: string | null; startedAt: number | null; running: boolean }
let panelList = { key: '', specs: [] as PanelSpec[] }
const panelRuns = new Map<string, PanelRun>()
const panelKey = (root: string, spec: PanelSpec) => [root, spec.id, ...spec.cmd].join('\0')

// A re-read drops the kept output of every panel the list no longer has, in any root.
async function readPanelSpecs($: $, root: string): Promise<PanelSpec[]> {
  const stat = (await listDir($, `${root}/.agent`)).find(entry => entry.name === 'pane-panels.json' && entry.kind === 'file')
  if (!stat) return []
  const key = `${root}|${stat.mtimeMs}|${stat.size}`
  if (panelList.key !== key) {
    panelList = { key, specs: parseSpecs(await readText($, `${root}/.agent/pane-panels.json`)) }
    const kept = new Set(panelList.specs.map(spec => panelKey(root, spec)))
    for (const runKey of panelRuns.keys()) if (!kept.has(runKey)) panelRuns.delete(runKey)
  }
  return panelList.specs
}

const panelRunOf = (root: string, spec: PanelSpec): PanelRun => {
  const key = panelKey(root, spec)
  let run = panelRuns.get(key)
  if (!run) panelRuns.set(key, (run = { data: null, error: null, startedAt: null, running: false }))
  return run
}

async function runPanel($: $, root: string, spec: PanelSpec, run: PanelRun, now: number): Promise<void> {
  run.running = true
  run.startedAt = now
  try {
    const ran = await $.process.run(spec.cmd, { cwd: root, stdin: '', timeoutMs: PANEL_TIMEOUT_MS })
    const data = ran.exitCode === 0 ? parsePanelOutput(ran.stdout) : null
    if (data) {
      run.data = data
      run.error = null
    } else run.error = firstLine(ran.stderr) || (ran.exitCode === 0 ? 'stdout is not one panel JSON object' : `exit ${ran.exitCode}`)
  } catch (error) {
    run.error = firstLine(error instanceof Error ? error.message : String(error)) || 'did not run'
  } finally {
    run.running = false
    $.ui.invalidate('ui.render')
  }
}

// Each panel, collapsed or expanded, runs at most once per refresh, and never twice at once.
const isDue = (run: PanelRun, spec: PanelSpec, now: number) => !run.running && (run.startedAt === null || now - run.startedAt >= spec.refreshMs)

// The render only schedules: a run it started itself would be cut when its dispatch ends, as
// every `$` call in flight with a dispatch is ("Work that outlives a dispatch", plugin-authoring
// reference), so the due panels start on a module timer. The render draws the last data; a
// run's end draws the pane again. Each render that finds a panel due sets a timer; `isDue` and
// the `running` flag, set as a run starts, let only the first timer start it.
function schedulePanels($: $, root: string, specs: PanelSpec[], now: number): void {
  if (!specs.some(spec => isDue(panelRunOf(root, spec), spec, now))) return
  $.clock.after(1, () => {
    for (const spec of specs) {
      const run = panelRunOf(root, spec)
      if (isDue(run, spec, now)) void runPanel($, root, spec, run, now)
    }
  })
}

type PanelRowView = { row: PanelRow; key: string; scope: string; segments: Segment[]; card: { top: number; left: number; width: number; lines: string[] } | null }
// One row of chips: the tabs (`filter` null), or one filter's options.
type ChipRow = { filter: string | null; chips: { id: string; label: string; selected: boolean }[] }
type PanelView = {
  spec: PanelSpec
  isOpen: boolean
  summary: string
  error: string
  data: PanelData | null
  tab: PanelTab | null
  chipRows: ChipRow[]
  header: Segment[]
  noData: boolean
  rows: PanelRowView[]
}
const PANEL_INDENT = 2

// The panels as drawn from pane row `top` down, one line each; a row's card goes below it, else
// above it, never over it.
function panelViews(
  root: string,
  specs: PanelSpec[],
  open: string[],
  tabs: Record<string, string>,
  filterPicks: Record<string, Record<string, string>>,
  top: number,
  bodyColumns: number,
  paneRows: number,
): PanelView[] {
  let y = top
  const width = bodyColumns - PANEL_INDENT
  return specs.map(spec => {
    const run = panelRunOf(root, spec)
    const isOpen = open.includes(spec.id)
    const data = isOpen ? run.data : null
    // with filters, their picks name the tab; a combination the output lacks has no rows
    const filters = data?.filters ?? []
    const picked = pickOptions(filters, filterPicks[spec.id])
    const tab = !data ? null : filters.length > 0 ? (data.tabs.find(one => one.id === picked.join('/')) ?? null) : pickTab(data, tabs[spec.id])
    const noData = !!data && filters.length > 0 && !tab
    const columnsOf = tab ?? (noData ? (data.tabs[0] ?? null) : null)
    const chipRows: ChipRow[] = !data
      ? []
      : filters.length > 0
        ? filters.map((filter, k) => ({ filter: filter.id, chips: filter.options.map(option => ({ ...option, selected: option.id === picked[k] })) }))
        : data.tabs.length > 1
          ? [{ filter: null, chips: data.tabs.map(one => ({ id: one.id, label: one.label, selected: one.id === tab?.id })) }]
          : []
    const header = columnsOf ? headerSegments(columnsOf, width) : []
    y += 1 + (run.error ? 1 : 0) + chipRows.length + (header.length > 0 ? 1 : 0)
    const seen = new Set<string>()
    const rows = (tab?.rows ?? []).map((row, i) => {
      const key = seen.has(row.id) ? `${row.id}#${i}` : row.id
      seen.add(key)
      const at = y++
      const cardWidth = Math.min(width, Math.max(0, ...row.hover.map(line => line.length)) + 4)
      const place = placeBeside(at, 1, row.hover.length + 2, paneRows)
      return {
        row,
        key,
        scope: `panel:${fnv1a(`${spec.id}\0${key}`).toString(36)}`,
        segments: rowSegments(tab as PanelTab, row, width),
        card: row.hover.length === 0 ? null : { top: place.x, left: PANEL_INDENT, width: cardWidth, lines: row.hover.map(line => line.slice(0, Math.max(1, cardWidth - 4))) },
      }
    })
    if (noData) y++
    if (tab?.note) y++
    const title = `▸ ${spec.title}`
    return {
      spec,
      isOpen,
      summary: !isOpen && run.data?.summary ? clip([{ text: `  ${run.data.summary}` }], bodyColumns - title.length)[0]?.text ?? '' : '',
      error: run.error ? clip([{ text: `panel error: ${run.error}` }], width)[0]?.text ?? '' : '',
      data,
      tab,
      chipRows,
      header,
      noData,
      rows,
    }
  })
}

const startOf = (row: Row) => row.diskRun?.startedAt ?? 0

function rowsFor(runs: Run[], agents: AgentInfo[], now: number): Row[] {
  const disk: Row[] = runs.map(run => ({ key: `disk:${run.dir}`, kind: run.kind, label: run.label, status: run.status, avatar: avatarOf(run.kind), model: run.model, duration: runElapsed(run, now), diskRun: run, children: [] }))
  const native: Row[] = agents.map(agent => {
    const run = asNative(agent)
    const parent = agents.some(other => other.id === agent.parentId) ? `native:${agent.parentId}` : undefined
    return { key: `native:${run.id}`, kind: run.kind, label: run.label, status: run.status, avatar: 'claude', agentId: run.id, parent, children: [] }
  })
  // A disk reviewer joins the newest worker that started before it in the same worktree.
  const workers = disk.filter(row => row.diskRun && !row.diskRun.isReviewer && row.diskRun.cwd.startsWith('/'))
  for (const row of disk) {
    const run = row.diskRun
    if (!run?.isReviewer || !run.cwd.startsWith('/')) continue
    row.parent = workers.filter(w => w.diskRun?.cwd === run.cwd && startOf(w) <= (run.startedAt ?? Infinity)).sort((a, b) => startOf(b) - startOf(a))[0]?.key
  }
  const all = [...disk, ...native]
  const byKey = new Map(all.map(row => [row.key, row]))
  const rootOf = (row: Row) => {
    let root = row
    for (let hops = 0; root.parent && hops < 8; hops++) root = byKey.get(root.parent) ?? root
    return root
  }
  const nested = new Set<Row>()
  for (const row of all) {
    const root = rootOf(row)
    if (root !== row) { root.children.push(row); nested.add(row) }
  }
  const top = all.filter(row => !nested.has(row))
  const running = top.filter(row => row.status === 'running')
  const finishedDisk = top.filter(row => row.diskRun && row.status !== 'running').slice(0, RECENT_DONE)
  const finishedNative = top.filter(row => !row.diskRun && row.status !== 'running').slice(-RECENT_DONE).reverse()
  // MAX_ROWS caps the finished rows only: a running row is never dropped
  const shown = [...running, ...[...finishedDisk, ...finishedNative].slice(0, Math.max(0, MAX_ROWS - running.length))]
  // a running child whose worker rolled off the list stays visible at the top
  const orphans = all.filter(row => nested.has(row) && row.status === 'running' && !shown.includes(rootOf(row)))
  return [...shown, ...orphans]
}

// The main checkout of the session's clone: its git common dir's parent.
async function repoRoot($: $): Promise<string | null> {
  return (await gitCommonDir($))?.replace(/\/\.git$/, '') ?? null
}

async function localMdOf($: $): Promise<string> {
  const main = await repoRoot($)
  return main ? readText($, `${main}/.agent/orchestrate.local.md`) : ''
}

async function resolveStateDir($: $, options: PluginOptions): Promise<string | null> {
  return perCwd($, 'state', async () => {
    const configured = String(options.stateDir ?? '')
    if (configured) return configured.replace(/\/+$/, '')
    return busStateDir(await localMdOf($), (await $.env.get('HOME')) ?? '')
  })
}

async function resolveGhStatusDir($: $, options: PluginOptions): Promise<string | null> {
  return perCwd($, 'gh-status', async () => {
    const configured = String(options.stateDir ?? '')
    if (configured) return `${configured.replace(/\/+$/, '')}/gh-status`
    const match = /^- `gh_status_dir`: `([^`]*)`/m.exec(await localMdOf($))
    const value = match?.[1]?.replace(/^~(?=\/|$)/, (await $.env.get('HOME')) ?? '')
    return value ? value.replace(/\/+$/, '') : null
  })
}

async function resolveBoardFile($: $, options: PluginOptions): Promise<string | null> {
  return perCwd($, 'board', async () => {
    const configured = String(options.stateDir ?? '')
    if (configured) return `${configured.replace(/\/+$/, '')}/board-snapshot.md`
    const match = /^- `board_snapshot_file`: `([^`]*)`/m.exec(await localMdOf($))
    return match?.[1]?.replace(/^~(?=\/|$)/, (await $.env.get('HOME')) ?? '') || null
  })
}

// Tickets that are done, from local files only: a PR MERGED or CLOSED in the gh-status files, or an
// issue whose board-snapshot row has Status Done. Both are cached on the file's mtime.
async function readDoneTickets($: $, options: PluginOptions): Promise<Set<number>> {
  const [ghDir, board] = await Promise.all([resolveGhStatusDir($, options), resolveBoardFile($, options)])
  const done = new Set<number>(ghDir ? (await refreshPrCache($, ghDir)).done : [])
  if (board) {
    const slash = board.lastIndexOf('/')
    const stat = (await listDir($, board.slice(0, slash))).find(entry => entry.name === board.slice(slash + 1) && entry.kind === 'file')
    if (stat) {
      const key = `${stat.mtimeMs}:${stat.size}`
      if (boardCache.key !== key) {
        const rows = (await readText($, board)).split('\n').flatMap(line => {
          const row = /^\| #(\d+) \|.*\| Done \|(?:[^|]*\|){5}$/.exec(line)
          return row?.[1] ? [Number(row[1])] : []
        })
        boardCache = { key, done: new Set(rows) }
      }
      for (const n of boardCache.done) done.add(n)
    }
  }
  return done
}

type Ask = { n: number; text: string }

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function issueNumber(text: string): string | null {
  return /#(\d+)/.exec(text)?.[1] ?? /\/issues\/(\d+)/.exec(text)?.[1] ?? /\/pull\/(\d+)/.exec(text)?.[1] ?? null
}

function trailingLink(text: string): string | null {
  return /https?:\/\/\S+$/.exec(text)?.[0] ?? null
}

function linkLabel(href: string): string {
  const issue = issueNumber(href)
  if (issue) return `#${issue}`
  try {
    const url = new URL(href)
    return url.pathname.split('/').filter(Boolean).at(-1) || url.host
  } catch {
    return href
  }
}

function labeledLine(line: string): { label: string; value: string } | null {
  if (/^https?:\/\//i.test(line.trim())) return null
  const match = /^([\p{L}][\p{L} /_-]*):\s*(.*)$/u.exec(line)
  return match ? { label: match[1] ?? '', value: match[2] ?? '' } : null
}

function safeHref(href: string): string | null {
  if (href.length > 2048 || /[^\x20-\x7E]/.test(href)) return null
  if (!href.startsWith('https://') && !/^http:\/\/localhost(?::\d+)?(?:\/|$|[?#])/i.test(href)) return null
  try {
    const url = new URL(href)
    return url.href === href && (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost')) ? href : null
  } catch {
    return null
  }
}

// `owner/repo` of a GitHub remote URL (https, ssh or scp form), else null.
function githubSlug(url: string): string | null {
  const match = /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())
  return match?.[1] ?? null
}

// The configured slug, else the session repo's `origin` remote, read from the git config file:
// null when neither names a GitHub repo, and ticket refs stay text.
async function resolveRepo($: $, options: PluginOptions): Promise<string | null> {
  const configured = String(options.repoSlug ?? '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '')
  if (configured) return configured
  return perCwd($, 'repo', async () => {
    const common = await gitCommonDir($)
    if (!common) return null
    let inOrigin = false
    for (const line of (await readText($, `${common}/config`)).split('\n')) {
      const section = /^\s*\[(.*)\]\s*$/.exec(line)
      if (section) inOrigin = section[1] === 'remote "origin"'
      const url = inOrigin ? /^\s*url\s*=\s*(\S+)/.exec(line)?.[1] : undefined
      if (url) return githubSlug(url)
    }
    return null
  })
}

function asNative(agent: AgentInfo): NativeRun {
  const status = agent.status === 'completed' ? 'done' : agent.status === 'failed' ? 'failed' : agent.status === 'killed' ? 'dead' : 'running'
  return { id: agent.id, label: agent.description || agent.type, kind: agent.type, status }
}

// The ask's sentence, minus the linked `#issue` at its very start or end (the link beside it
// carries the number); a mid-sentence `#issue` and every other `#N` stay.
function askBody(text: string, issue: string | null, dropUrl: boolean): string {
  const body = dropUrl ? text.replace(/\s*https?:\/\/\S+$/, '') : text
  return issue ? body.replace(new RegExp(`^#${issue}(?!\\d)\\s*`), '').replace(new RegExp(`\\s*#${issue}$`), '') : body
}

function askOptions(detail: string): string[] {
  const line = detail.split('\n').find(text => /^options?:/i.test(text.trim()))
  return line ? line.replace(/^options?:/i, '').split(/\s*[|;]\s*/).map(text => text.trim()).filter(Boolean).slice(0, 4) : []
}

// `n` is the ask's 1-based line number in the file: its detail file is `<n>.md`.
async function readAsks($: $, options: PluginOptions): Promise<{ asks: Ask[]; detailDir: string }> {
  const [state, sid] = await Promise.all([resolveStateDir($, options), $.session.id()])
  if (!state || !sid) return { asks: [], detailDir: '' }
  const file = `${state}/asks/${sid}`
  const all = (await readText($, file))
    .split('\n')
    .map((text, i) => ({ n: i + 1, text: text.trim() }))
    .filter(ask => ask.text !== '')
  // An ask keyed by a done ticket is hidden at once; the hook deletes it on its next write.
  const ticketOf = (ask: Ask) => /#(\d+)/.exec(ask.text)?.[1]
  const done = all.some(ticketOf) ? await readDoneTickets($, options) : new Set<number>()
  const asks = all.filter(ask => {
    const ticket = ticketOf(ask)
    return ticket === undefined || !done.has(Number(ticket))
  })
  return { asks, detailDir: `${file}.d` }
}

async function readAskDetail($: $, detailDir: string, n: number): Promise<string> {
  return readText($, `${detailDir}/${n}.md`)
}

const PANE = 'workers'
const expanded = atom({ plugin: 'agent-ui', key: 'expanded' } as const, [] as string[])
const selectedRun = atom({ plugin: 'agent-ui', key: 'selectedRun' } as const, null)
const openAsk = atom({ plugin: 'agent-ui', key: 'openAsk' } as const, null)
const ciOpen = atom({ plugin: 'agent-ui', key: 'ciOpen' } as const, false)
const ciMetric = atom({ plugin: 'agent-ui', key: 'ciMetric' } as const, 'wall' as Metric)
const panelsOpen = atom({ plugin: 'agent-ui', key: 'panelsOpen' } as const, [] as string[])
const panelTabs = atom({ plugin: 'agent-ui', key: 'panelTabs' } as const, {} as Record<string, string>)
const panelFilters = atom({ plugin: 'agent-ui', key: 'panelFilters' } as const, {} as Record<string, Record<string, string>>)

const FRAME_MS = 250
const MAX_ANIMATED = 20
const CHILD_CAP = 8

// Only running rows animate: one timer, one keyed blit per row a frame (no pane redraw).
// A render lists the rows to animate; the timer cancels itself once the list is empty.
let frameTimer: Timer | null = null
let frameTick = 0
let animating: { key: string; avatar: Avatar }[] = []
let animatingPictures = false
// A terminal without pictures draws an Image's alt dim and uncolored; once a blit says so,
// the pane draws braille Rasters instead.
let picturesDrawAlt = false

function syncFrames($: $): void {
  if (animating.length === 0) {
    frameTimer?.cancel()
    frameTimer = null
    return
  }
  if (frameTimer) return
  frameTimer = $.clock.every(FRAME_MS, async () => {
    frameTick++
    const batch = animating
    const pictures = animatingPictures
    const results = await Promise.all(
      batch.map(row => {
        const key = `avatar:${row.key}`
        const blit = pictures
          ? $.ui.blit({ requestId: PANE, key, source: avatarPicture(row.avatar, 'running', frameTick).source })
          : $.ui.blit({ requestId: PANE, key, cells: avatarCells(row.avatar, 'running', frameTick) })
        return blit.catch(() => ({ deny: 'blit failed' }))
      }),
    )
    // Reads the engine's deny wording (its reasons are "spelled out for a fallback"); not yet
    // confirmed against a real terminal without pictures.
    if (pictures && results.some(result => /\balt\b/i.test(result.deny ?? ''))) {
      picturesDrawAlt = true
      animating = []
      $.ui.invalidate('ui.render')
    }
    // nothing of ours is mounted any more (the pane closed): wait for the next render
    if (results.every(result => result.deny)) animating = []
    syncFrames($)
  })
}

// A hovered run column's background, behind its bar's transparent pixels.
const COLUMN_LIT = '#3a3d50'
// A bar's alt text where a picture cannot be drawn: its height as a block glyph, twice.
const barGlyphs = (run: CiRun, chart: CiChart) => String.fromCharCode(0x2581 + Math.min(7, Math.floor((barTotal(run, chart.metric) / chart.max) * 8))).repeat(2)

// The card draws on its own dark background, so its text colors are fixed, not the theme's.
const CARD_TEXT = '#e1e1e6'
const CARD_DIM = '#9a9cab'
const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, '0')}`
// A hover card, the chart's and a panel row's: hidden until its scope is hovered, painted over
// the pane at its place.
const CARD = { position: 'absolute', display: 'none', flexDirection: 'column', borderStyle: 'round', backgroundColor: '#2c2e3c', paddingX: 1 } as const

const MARK = { running: '◐', done: '✓', failed: '✗', dead: '†' } as const

const isSameAsk = (open: OpenAsk | null, ask: Ask) => open?.n === ask.n && open.text === ask.text

// boot-report writes the role marker after the session starts, so the pane waits for it a few ticks.
const MANAGER_ROLE = /^(pm|tl-[a-z0-9-]+)$/
const ROLE_DIR = '/tmp/cc-session-roles'
const ROLE_WAIT_TICKS = 60
let roleTicksLeft = 0

async function openForManager($: $): Promise<void> {
  if (roleTicksLeft <= 0) return
  roleTicksLeft--
  const sid = await $.session.id()
  if (!sid || /[/]|\.\./.test(sid)) return
  if (!MANAGER_ROLE.test(await readText($, `${ROLE_DIR}/${sid}`))) return
  roleTicksLeft = 0
  await $.ui.open({ id: PANE, title: 'Workers' })
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'workers',
      description: "Open a pane of this session's child runs; click one for its live tail",
    })
    // One tick redraws the pane and the band (each re-reads its files while drawn)
    // and drops an expanded ask whose line is gone, so a later ask at that line opens closed.
    roleTicksLeft = e.isInteractive ? ROLE_WAIT_TICKS : 0
    await openForManager($)
    $.clock.every(REFRESH_MS, async () => {
      await openForManager($)
      $.ui.invalidate('ui.render')
      const open = await read($, openAsk)
      if (open === null) return
      const { asks } = await readAsks($, options)
      if (!asks.some(ask => isSameAsk(open, ask))) await update($, openAsk, () => null)
    })

    return next(e)
  })

  on('command.run', { command: 'workers' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Workers' })

    return { text: 'Workers pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown, Link } = $.ui.resolve(e)
    const terminal = e.surface === 'terminal' ? $.ui.resolve(e) : null
    const Image = picturesDrawAlt ? null : terminal?.Image ?? null
    const Raster = terminal?.Raster ?? null
    const now = await $.clock.now()
    const [runs, agents, main] = await Promise.all([scanRuns($, options, now), $.agent.list().catch(() => []), readMainStrip($, options)])
    const rows = rowsFor(runs, agents, now)
    const prState = await readReadyPrs($, options, main?.sha ?? '')
    const [chosen, open, isCiOpen, metric] = await Promise.all([read($, selectedRun), read($, expanded), read($, ciOpen), read($, ciMetric)])
    const chart = main && isCiOpen ? await readCiChart($, main, e.props.bodyColumns, metric) : null
    const axis = chart ? axisLabels(chart.max, chart.metric) : null
    const visible = rows.flatMap(row => [
      { row, isChild: false },
      ...(open.includes(row.key) ? row.children.slice(0, CHILD_CAP).map(child => ({ row: child, isChild: true })) : []),
    ])
    const shown = rows.flatMap(row => [row, ...row.children]).find(row => row.key === chosen) ?? null
    animating = Image || Raster
      ? visible.flatMap(({ row }) => (row.status === 'running' && row.avatar ? [{ key: row.key, avatar: row.avatar }] : [])).slice(0, MAX_ANIMATED)
      : []
    animatingPictures = !!Image
    syncFrames($)
    const tail = shown ? (shown.diskRun ? await readTail($, shown.diskRun) : await readNativeTail($, shown.agentId ?? '')) : null
    const repo = await resolveRepo($, options)
    const root = await repoRoot($)
    const specs = root ? await readPanelSpecs($, root) : []
    const [openPanels, tabPicks, filterPicks] = await Promise.all([read($, panelsOpen), read($, panelTabs), read($, panelFilters)])
    if (root && specs.length > 0) schedulePanels($, root, specs, now)
    // a card's top counts pane rows: the panels start below the main strip (1 row) and the
    // open chart (CHART_ROWS bars, its metric chips and its legend line), the only rows above them
    const panelTop = (main ? 1 : 0) + (chart ? CHART_ROWS + 2 : 0)
    const panels = root ? panelViews(root, specs, openPanels, tabPicks, filterPicks, panelTop, e.props.bodyColumns, e.props.scroll.offset + e.props.scroll.bodyRows) : []
    const segmentTexts = (segments: Segment[], dim: boolean, prefix: string) =>
      segments.map((segment, k) => (
        <Text
          key={`${prefix}-${k}`}
          color={segment.color === undefined ? undefined : hex(segment.color)}
          backgroundColor={segment.background === undefined ? undefined : hex(segment.background)}
          dimColor={dim && segment.background === undefined}
        >
          {segment.text}
        </Text>
      ))
    const stateColor = main?.state === 'green' ? 'green' : main?.state === 'failed' || main?.state === 'red' ? 'red' : undefined

    return (
      <Box flexDirection="column">
        {main && (
          <Box key="main-strip" flexDirection="row">
            <Button key="ci-toggle" plain dimColor label={`${isCiOpen ? '▾' : '▸'} main ${main.sha} · `} onPress={() => update($, ciOpen, was => !was)} />
            <Text color={stateColor} dimColor={!stateColor}>{main.state}</Text>
            <Text dimColor>{' · preview '}</Text>
            <Text color={main.queue.running > 0 ? 'green' : undefined} dimColor={main.queue.running === 0}>{main.queue.running}</Text>
            <Text dimColor>/</Text>
            <Text color={main.queue.queued > 0 ? 'red' : undefined} dimColor={main.queue.queued === 0}>{main.queue.queued}</Text>
          </Box>
        )}
        {chart && (
          <Box key="ci" flexDirection="column">
            <Box flexDirection="row" height={CHART_ROWS}>
              <Box width={AXIS_COLS} height={CHART_ROWS} flexDirection="column" justifyContent="space-between">
                <Text dimColor>{axis?.top}</Text>
                <Text dimColor>{axis?.bottom}</Text>
              </Box>
              {/* each run column holds its own bar: the hover zone and the bar are one box (runCell) */}
              {chart.runs.map((run, i) => (
                <Box key={`ci-run:${run.run}`} width={2} height={CHART_ROWS} flexDirection="column" hover={{ scope: `ci:${run.run}`, backgroundColor: COLUMN_LIT }}>
                  {Image ? (
                    <Image key={`ci-bar:${run.run}`} source={chart.tiles[i] as CiChart['tiles'][number]} columns={2} rows={CHART_ROWS} alt={barGlyphs(run, chart)} />
                  ) : Raster ? (
                    <Raster key={`ci-bar:${run.run}`} columns={2} rows={CHART_ROWS} cells={fallbackOf(chart).cells[i] ?? ''} />
                  ) : (
                    (fallbackOf(chart).grids[i] ?? []).map((row, y) => (
                      <Text key={`ci-cell-${i}-${y}`} color={hex(row[0]?.color ?? 0)}>{row.map(cell => String.fromCharCode(cell.glyph)).join('')}</Text>
                    ))
                  )}
                </Box>
              ))}
            </Box>
            <Box key="ci-metrics" flexDirection="row">
              {METRICS.map((one, k) => (
                <Box key={`ci-metric-box:${one}`} flexDirection="row">
                  {k > 0 && <Text dimColor>{' · '}</Text>}
                  <Button key={`ci-metric:${one}`} plain dimColor={one !== chart.metric} label={one} onPress={() => update($, ciMetric, () => one)} />
                </Box>
              ))}
            </Box>
            <Text dimColor>{`last ${chart.runs.length} runs · line = load · red = retry`}</Text>
          </Box>
        )}
        {panels.map(({ spec, isOpen, summary, error, data, tab, chipRows, header, noData, rows: panelRows }) => (
          <Box key={`panel:${spec.id}`} flexDirection="column">
            <Box key="panel-head" flexDirection="row">
              <Button
                key={`panel-toggle:${spec.id}`}
                plain
                label={`${isOpen ? '▾' : '▸'} ${spec.title}`}
                onPress={() => update($, panelsOpen, ids => (ids.includes(spec.id) ? ids.filter(id => id !== spec.id) : [...ids, spec.id]))}
              />
              {summary && <Text dimColor>{summary}</Text>}
            </Box>
            {error && (
              <Box key="panel-error" marginLeft={PANEL_INDENT}>
                <Text dimColor>{error}</Text>
              </Box>
            )}
            {data && (
              <Box key="panel-body" flexDirection="column" marginLeft={PANEL_INDENT}>
                {chipRows.map(({ filter, chips }) => (
                  <Box key={filter === null ? 'panel-tabs' : `panel-filter:${filter}`} flexDirection="row">
                    {chips.map((chip, k) => (
                      <Box key={`panel-chip-box:${chip.id}`} flexDirection="row">
                        {k > 0 && <Text>{'  '}</Text>}
                        <Button
                          key={filter === null ? `panel-tab:${spec.id}:${chip.id}` : `panel-filter:${spec.id}:${filter}:${chip.id}`}
                          plain
                          dimColor={!chip.selected}
                          label={chip.label}
                          onPress={() =>
                            filter === null
                              ? update($, panelTabs, picks => ({ ...picks, [spec.id]: chip.id }))
                              : update($, panelFilters, picks => ({ ...picks, [spec.id]: { ...picks[spec.id], [filter]: chip.id } }))
                          }
                        />
                      </Box>
                    ))}
                  </Box>
                ))}
                {header.length > 0 && (
                  <Box key="panel-columns" flexDirection="row">
                    {segmentTexts(header, true, 'panel-col')}
                  </Box>
                )}
                {noData && (
                  <Box key="panel-no-data">
                    <Text dimColor>no data</Text>
                  </Box>
                )}
                {panelRows.map(({ row, key, scope, segments }) => (
                  <Box key={`panel-row:${spec.id}:${key}`} flexDirection="row" hover={{ scope, backgroundColor: COLUMN_LIT }}>
                    {segmentTexts(segments, row.dim, 'panel-cell')}
                  </Box>
                ))}
                {tab?.note && <Text dimColor>{clip([{ text: tab.note }], e.props.bodyColumns - PANEL_INDENT)[0]?.text ?? ''}</Text>}
              </Box>
            )}
          </Box>
        ))}
        {prState.prs.length > 0 && (
          <Box key="needs-you" flexDirection="column" marginBottom={1}>
            <Text bold>Needs you</Text>
            {prState.prs.map(pr => {
              const gate = prState.gates.get(pr.number) ?? null
              const result = gate == null ? '…' : gate.green === true ? '✓' : '✗'
              const href = repo ? safeHref(`https://github.com/${repo}/pull/${pr.number}`) : null
              return (
                <Box key={`pr:${pr.number}`}>
                  {href ? <Text color={ASK_ACCENT}><Link key={`pr-link-${pr.number}`} href={href} label={`#${pr.number}`} /></Text> : <Text color={ASK_ACCENT}>{`#${pr.number}`}</Text>}
                  <Text>{` ${pr.title} ${result}${gate?.conflict === true ? ' ⚡ conflict' : ''}`}</Text>
                </Box>
              )
            })}
          </Box>
        )}
        <Text bold>Workers</Text>
        {rows.length === 0 && <Text dimColor>No child runs for this session.</Text>}
        {visible.map(({ row, isChild }) => (
          <Box key={`row:${row.key}`} flexDirection="row">
            {isChild && <Text dimColor>{'  └ '}</Text>}
            {Image && row.avatar ? (
              <Image key={`avatar:${row.key}`} columns={SPRITE_COLS} rows={1} {...avatarPicture(row.avatar, row.status, frameTick)} />
            ) : Raster && row.avatar ? (
              <Raster key={`avatar:${row.key}`} columns={SPRITE_COLS} rows={1} cells={avatarCells(row.avatar, row.status, frameTick)} />
            ) : (
              <Box key={`mark:${row.key}`}>
                <Text dimColor={row.status !== 'running'}>{`${MARK[row.status]} `}</Text>
              </Box>
            )}
            <Text>{' '}</Text>
            <Button
              key={row.key}
              plain
              dimColor={row.status !== 'running'}
              label={`${row.kind} ${row.label}${row.model ? `  ${row.model}` : ''}${row.duration ? `  ${row.duration}` : ''}  ${row.status}${row.children.length > 0 ? `  ${open.includes(row.key) ? '▾' : '▸'}${row.children.length}` : ''}`}
              onPress={async () => {
                const wasShown = (await read($, selectedRun)) === row.key
                await update($, selectedRun, () => (wasShown ? null : row.key))
                if (row.children.length > 0) await update($, expanded, keys => (wasShown ? keys.filter(key => key !== row.key) : [...keys, row.key]))
              }}
            />
          </Box>
        ))}
        {shown && tail && (
          <Box key="tail" flexDirection="column" marginTop={1}>
            <Text bold>{`${shown.label} (${shown.status})`}</Text>
            {tail.lines.length === 0 && <Text dimColor>No output yet.</Text>}
            {tail.lines.map(line => (
              <Text wrap="truncate-end">{line}</Text>
            ))}
            {tail.lastMessage !== '' && (
              <Box key="last" flexDirection="column" marginTop={1}>
                <Text bold>last message</Text>
                <Markdown key="last-message" text={tail.lastMessage} />
              </Box>
            )}
          </Box>
        )}
        {/* drawn last so each card paints over the rows below the chart; its run column, in
            the same hover scope, reveals it */}
        {chart?.runs.map((run, i) => {
          const card = chart.cards[i] as CiCard
          return (
            <Box key={`ci-card:${run.run}`} {...CARD} top={2} left={card.left} width={card.width + 4} hover={{ display: 'flex', scope: `ci:${run.run}` }}>
              <Box key="ci-line-0" flexDirection="row" flexWrap="nowrap">
                <Text color={CARD_TEXT} wrap="truncate-end">{card.head}</Text>
              </Box>
              {/* each table row is one line: a row Box of the name cell and the numbers cell */}
              {[card.header, ...card.rows].map((row, k) => (
                <Box key={`ci-line-${k + 1}`} flexDirection="row" flexWrap="nowrap">
                  <Text color={k === 0 ? CARD_DIM : hex(jobColor(row.job))} wrap="truncate-end">{row.name}</Text>
                  <Text color={k === 0 ? CARD_DIM : CARD_TEXT} wrap="truncate-end">{row.nums}</Text>
                </Box>
              ))}
            </Box>
          )
        })}
        {panels.flatMap(({ spec, rows: panelRows }) =>
          panelRows.flatMap(({ key, scope, card }) =>
            card
              ? [
                  <Box key={`panel-card:${spec.id}:${key}`} {...CARD} top={card.top} left={card.left} width={card.width} hover={{ display: 'flex', scope }}>
                    {card.lines.map((line, k) => (
                      <Text key={`panel-line-${k}`} color={CARD_TEXT}>{line}</Text>
                    ))}
                  </Box>,
                ]
              : [],
          ),
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { asks, detailDir } = await readAsks($, options)
    if (asks.length === 0) return next(e)
    const { Box, Text, Button, Markdown, Link } = $.ui.resolve(e)
    const repo = await resolveRepo($, options)
    const open = await read($, openAsk)
    const shown = asks.find(ask => isSameAsk(open, ask))
    const detail = shown ? await readAskDetail($, detailDir, shown.n) : ''
    // Three text lines (options: among them) plus one link: line, whatever the file holds.
    const rows = detail.split('\n').map(line => line.trim()).filter(Boolean)
    const isLink = (line: string) => /^link:/i.test(line)
    const textLines = rows.filter(line => !isLink(line)).slice(0, 3)
    const detailLines = [...textLines.filter(line => !/^options?:/i.test(line)), ...rows.filter(isLink).slice(0, 1)]
    const askViews = asks.map(ask => {
      const issue = issueNumber(ask.text)
      const trailing = trailingLink(ask.text)
      return {
        ask,
        issue,
        issueHref: issue && repo ? safeHref(`https://github.com/${repo}/issues/${issue}`) : null,
        trailing,
        trailingHref: trailing ? safeHref(trailing) : null,
        askOpts: askOptions(ask === shown ? textLines.join('\n') : ''),
      }
    })

    return (
      <Box flexDirection="column">
        {askViews.map(({ ask, issue, issueHref, trailing, trailingHref, askOpts }) => {
          // The toggle leads every row, ticket or not, so no ask reads as part of the row above.
          const urlLink = !issue && trailingHref
          return (
          <Box key={`ask-row-${ask.n}`} flexDirection="column">
            <Box key={`ask-line-${ask.n}`} flexDirection="row">
              <Button
                key={`ask-${ask.n}`}
                plain
                label={`${ask === shown ? '▾' : '▸'} ${askBody(ask.text, issue, !!urlLink)}`}
                onPress={() => update($, openAsk, was => (isSameAsk(was, ask) ? null : { n: ask.n, text: ask.text }))}
              />
              {issue || urlLink ? <Text>{' '}</Text> : null}
              {issue ? issueHref ? <Text color={ASK_ACCENT}><Link href={issueHref} label={`#${issue}`} /></Text> : <Text color={ASK_ACCENT}>{`#${issue}`}</Text> : null}
              {urlLink ? <Text color={ASK_ACCENT} underline><Link href={trailingHref} label={linkLabel(trailingHref)} /></Text> : null}
            </Box>
            {ask === shown &&
              (detail ? (
                <Box key={`ask-detail-${ask.n}`} flexDirection="column" marginLeft={2}>
                  <Box key="ask-detail-border" flexDirection="row">
                    <Text color={ASK_ACCENT}>│</Text>
                    <Box flexDirection="column" marginLeft={1}>
                      {detailLines.map((line, i) => {
                        const labeled = labeledLine(line)
                        const link = /^link:\s*(?:<([^>]+)>|(\S+))/i.exec(line.trim())
                        if (link) {
                          const href = link[1] ?? link[2] ?? ''
                          const safe = safeHref(href)
                          if (!safe) return <Text key={`ask-context-${i}`}>{line}</Text>
                          return (
                            <Text key={`ask-context-${i}`} color={ASK_ACCENT} underline>
                              <Link href={safe} label={linkLabel(safe)} />
                            </Text>
                          )
                        }
                        if (labeled) {
                          return (
                            <Box key={`ask-context-${i}`} flexDirection="row">
                              <Text dimColor bold>{`${labeled.label}: `}</Text>
                              <Text>{labeled.value}</Text>
                            </Box>
                          )
                        }
                        return <Text key={`ask-context-${i}`}>{line}</Text>
                      })}
                    </Box>
                  </Box>
                  {askOpts.length > 0 && (
                    <Box key="ask-options" flexDirection="row" marginTop={1}>
                      {askOpts.map((option, i) => (
                        <Button
                          key={`ask-option-${ask.n}-${i}`}
                          plain
                          label={option}
                          onPress={() => {
                            const prefix = issue ? `#${issue}` : trailing ?? ''
                            return $.prompt.fill({ text: `${prefix} ${option}`.trim(), mode: 'insert' })
                          }}
                        />
                      ))}
                    </Box>
                  )}
                </Box>
              ) : (
                <Text dimColor>no context recorded</Text>
              ))}
          </Box>
          )
        })}
      </Box>
    )
  })
}
