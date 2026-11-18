import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, FsEntry, PluginOptions, Register, Timer } from 'claude-code'

import type { Run } from '../types'
import { type Avatar, SPRITE_COLS, avatarOf, avatarPicture } from './sprites'
import {
  TAIL_LINES,
  codexTail,
  elapsed,
  epochMs,
  kindOf,
  labelOf,
  lines,
  localEnvValue,
  chainLinks,
  prMark,
  sortPrs,
  type PrMark,
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
  fnv1a,
  headerSegments,
  parsePanelOutput,
  parseSpecs,
  pickOptions,
  pickTab,
  placeBeside,
  rowSegments,
  TONES,
} from './panels'

type $ = EngineInterface
type Root = { dir: string; isPanel: boolean }
type Tail = { lines: string[]; lastMessage: string }
type Cached = { mtime: string; probe: Probe | null }
type Probe = { run: Run; pid: string; hasDone: boolean; exitCode: string }
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
type PrRow = { number: number; title: string; mark: PrMark }
const MARK_TONES: Record<PrMark, number> = { '✓': TONES.good as number, '⋯': TONES.mid as number, '✗': TONES.bad as number, '⚡': TONES.bad as number }
type PrFile = { mtimeMs: number; pr: PrRow | null }
type PrCache = { key: string; files: Map<string, PrFile>; open: Map<number, PrRow> }

const REFRESH_MS = 3000
const RECENT_DONE = 5
const LIVE_WINDOW_MS = 24 * 3_600_000
const MAX_ROWS = 30
const TAIL_BYTES = 262_144
const ACCENT = '#CBA6F7'

let prCache: PrCache = { key: '', files: new Map(), open: new Map() }
type Board = { key: string; done: Set<number>; titles: Map<number, string> }
const NO_BOARD: Board = { key: '', done: new Set(), titles: new Map() }
let boardCache = NO_BOARD

async function readText($: $, path: string): Promise<string> {
  return $.fs.read(path).then(
    text => (typeof text === 'string' ? text.trim() : ''),
    () => '',
  )
}

async function listDir($: $, path: string): Promise<FsEntry[]> {
  return $.fs.list(path).catch(() => [])
}

async function tailBytes($: $, path: string, bytes = TAIL_BYTES): Promise<string> {
  const ran = await $.process.run(['tail', '-c', String(bytes), path]).catch(() => null)
  return ran?.exitCode === 0 ? ran.stdout : ''
}

// One answer per session project root, hit or miss: a shell `cd` never moves it, while `/cd`, a
// host directory change or a worktree move does. The promise is cached, so concurrent callers share one run.
const byRoot = new Map<string, { root: string; value: Promise<unknown> }>()

async function perRoot<T>($: $, name: string, compute: (root: string) => Promise<T>): Promise<T> {
  const root = await $.session.root()
  const hit = byRoot.get(name)
  if (hit?.root === root) return hit.value as Promise<T>
  const value = compute(root)
  byRoot.set(name, { root, value })
  return value
}

async function gitCommonDir($: $): Promise<string | null> {
  return perRoot($, 'git', async root => {
    const ran = await $.process
      .run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root })
      .catch(() => null)
    return ran?.exitCode === 0 ? ran.stdout.trim() : null
  })
}

const childrenDirOf = (options: PluginOptions) => String(options.childrenDir ?? '').replace(/\/+$/, '')

async function resolveRoots($: $, options: PluginOptions): Promise<Root[]> {
  return perRoot($, 'roots', async () => {
    const children = childrenDirOf(options)
    const common = await gitCommonDir($)
    return [...(children ? [{ dir: children, isPanel: false }] : []), ...(common ? [{ dir: `${common}/.review-panel`, isPanel: true }] : [])]
  })
}

// NUL delimiters preserve paths with whitespace. Perl supplies sub-second directory mtimes
// on both BSD and GNU find and includes the PID snapshot in the first root's process call.
const DISCOVER_RUNS = String.raw`
  use Time::HiRes qw(stat);
  my ($root, $depth, $hours, $pids) = @ARGV;
  if ($pids) {
    open my $ps, '-|', 'ps', '-ax', '-o', 'pid=' or die $!;
    while (<$ps>) { print "pid\0$1\0" if /^\s*(\d+)/; }
    close $ps or die 'ps failed';
  }
  exit 0 unless -d $root;
  $root = './' . $root unless $root =~ m{^/};
  open my $find, '-|', 'find', '-H', $root, '-mindepth', $depth, '-maxdepth', $depth,
    '-type', 'd', '-mmin', '-' . ($hours * 60), '-print0' or die $!;
  local $/ = "\0";
  my $found = 0;
  while (my $dir = <$find>) {
    chomp $dir;
    my @stat = stat($dir);
    next unless @stat;
    printf "%.9f\0%s\0", $stat[9], $dir;
    $found = 1;
  }
  close $find or $found or die 'find failed';
`

async function probe($: $, dir: string, entries: FsEntry[], isPanel: boolean, sid: string): Promise<Probe | null> {
  const names = new Map(entries.map(entry => [entry.name, entry]))
  if (!sid || !names.has('pid') || !names.has('owner-session')) return null
  if (await readText($, `${dir}/owner-session`) !== sid) return null
  const field = (name: string) => (names.has(name) ? readText($, `${dir}/${name}`) : Promise.resolve(''))
  const [pid, provider, model, start, end, exitCode, cwd, agent] = await Promise.all([
    field('pid'),
    field('provider'),
    field('model'),
    field('start-epoch'),
    field('end-epoch'),
    field('exit-code'),
    field('cwd'),
    field('agent'),
  ])
  const lastMtime = Math.max(0, ...entries.map(entry => entry.mtimeMs))
  return {
    pid,
    hasDone: names.has('done'),
    exitCode,
    run: {
      dir,
      kind: kindOf(provider, isPanel),
      label: labelOf(dir, isPanel),
      cwd,
      isReviewer: isPanel || agent === 'reviewer',
      model: [provider, model].filter(Boolean).join('/'),
      status: 'running',
      startedAt: epochMs(start),
      endedAt: epochMs(end) ?? (lastMtime || null),
    },
  }
}

async function scanRuns($: $, options: PluginOptions, now: number, probes: Map<string, Cached>): Promise<Run[] | null> {
  const sid = await $.session.id()
  const roots = await resolveRoots($, options)
  const discovery = await Promise.all(roots.map((root, index) => $.process.run([
    'perl', '-e', DISCOVER_RUNS, '--', root.dir, root.isPanel ? '2' : '1',
    String(LIVE_WINDOW_MS / 3_600_000), index === 0 ? '1' : '',
  ]).catch(() => null)))
  if (discovery.some(result => !result || result.exitCode !== 0 || result.isStdoutTruncated)) return null

  const alive = new Set<string>()
  const dirs = new Map<string, { mtime: string; isPanel: boolean }>()
  for (const [index, result] of discovery.entries()) {
    const fields = result?.stdout.split('\0') ?? []
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [mtime, dir] = [fields[i]!, fields[i + 1]!]
      if (mtime === 'pid') alive.add(dir)
      else dirs.set(dir, { mtime, isPanel: roots[index]!.isPanel })
    }
  }

  const found: Probe[] = []
  for (const dir of probes.keys()) if (!dirs.has(dir)) probes.delete(dir)
  await Promise.all([...dirs].map(async ([dir, { mtime, isPanel }]) => {
    const cached = probes.get(dir)
    // Writes to an existing log leave the directory mtime unchanged.
    if (cached?.mtime === mtime && (cached.probe === null || cached.probe.hasDone)) return
    const entries = await $.fs.list(dir).catch(() => null)
    if (entries) probes.set(dir, { mtime, probe: await probe($, dir, entries, isPanel, sid) })
  }))
  for (const cached of probes.values()) if (cached.probe) found.push(cached.probe)
  // older runs without `done` read as dead: bounds the ps list and ignores reused pids
  const recent = (one: Probe) => now - (one.run.startedAt ?? 0) <= LIVE_WINDOW_MS
  const running: Run[] = []
  const done: Run[] = []
  for (const one of found) {
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

// GPT runs stream codex events to result.jsonl; Claude runs only stderr.log.
let diskTail: { key: string; tail: Tail } | null = null
async function readTail($: $, run: Run): Promise<Tail> {
  const entries = new Map((await listDir($, run.dir)).map(entry => [entry.name, entry]))
  const log = entries.get('result.jsonl') ?? entries.get('stderr.log')
  const message = run.status === 'running' ? undefined : entries.get('last-message') ?? entries.get('result.json')
  const version = (entry?: FsEntry) => entry && [entry.name, entry.mtimeMs, entry.size]
  const key = JSON.stringify([run.dir, version(log), version(message)])
  if (diskTail?.key === key) return diskTail.tail

  const [output, final] = await Promise.all([
    log ? tailBytes($, `${run.dir}/${log.name}`) : '',
    message ? readText($, `${run.dir}/${message.name}`) : '',
  ])
  const tail = {
    lines: log?.name === 'result.jsonl' ? codexTail(output) : lines(output).slice(-TAIL_LINES),
    lastMessage: message?.name === 'result.json' ? resultJsonMessage(final) : final,
  }
  diskTail = { key, tail }
  return tail
}

async function readNativeTail($: $, agentId: string): Promise<Tail> {
  const messages = await $.session.messages({ agentId }).catch(() => [])
  if (!Array.isArray(messages)) return { lines: [], lastMessage: '' }
  const linesOut = messages.flatMap(message => lines(message.text)).slice(-TAIL_LINES)
  return { lines: linesOut, lastMessage: '' }
}

// The open PRs from gh-status files, re-read only where a file's mtime moved.
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
        ? { number: value.number, title: typeof value.title === 'string' ? value.title : '', mark: prMark(value.mergeable, value.checks) }
        : null
      return [entry.name, { mtimeMs: entry.mtimeMs, pr }] as const
    }))
    for (const [name, file] of parsed) cache.files.set(name, file)
    cache.open = new Map([...cache.files.values()].flatMap(file => file.pr ? [[file.pr.number, file.pr] as const] : []))
    cache.key = key
  }
  return cache
}

async function readReadyPrs($: $): Promise<PrRow[]> {
  const state = await resolveStateDir($)
  if (!state) return []
  const cache = await refreshPrCache($, `${state}/gh-status`)
  return sortPrs([...cache.open.values()])
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
  const key = stat ? `${root}|${stat.mtimeMs}|${stat.size}` : ''
  if (panelList.key !== key) {
    const specs = stat ? parseSpecs(await readText($, `${root}/.agent/pane-panels.json`)) : []
    panelList = { key, specs }
    const kept = new Set(specs.map(spec => panelKey(root, spec)))
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
  let before: string | undefined
  try {
    before = await panelResultKey($, root, spec)
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
    if (panelRuns.get(panelKey(root, spec)) === run && before !== await panelResultKey($, root, spec).catch(() => before)) {
      $.ui.invalidate('ui.render')
    }
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
    if (panelList.specs !== specs) return
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

async function panelResultKey($: $, root: string, spec: PanelSpec): Promise<string> {
  const [open, tabs, filters] = await Promise.all([read($, panelsOpen), read($, panelTabs), read($, panelFilters)])
  const [view] = panelViews(root, [spec], open, tabs, filters, 0, 1000, 1000)
  if (!view) return ''
  return JSON.stringify([
    view.summary, view.error, !!view.data, view.chipRows, view.header, view.noData, view.tab?.note,
    view.rows.map(({ key, row, segments, card }) => [key, row.dim, segments, card]),
  ])
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

// `state_dir` from the main checkout's `.agent/local.env`; every state path is a fixed name under
// it. No file or no key: null, and the state-scoped sections draw nothing.
async function resolveStateDir($: $): Promise<string | null> {
  return perRoot($, 'state', async () => {
    const main = await repoRoot($)
    if (!main) return null
    return localEnvValue(await readText($, `${main}/.agent/local.env`), 'state_dir', (await $.env.get('HOME')) ?? '')
  })
}

// board-snapshot.md's issue rows, cached on its mtime and size: the Done set and each title (a
// `\|` in a cell is a literal pipe; the Status cell has five cells after it).
async function readBoard($: $): Promise<Board> {
  const state = await resolveStateDir($)
  const stat = state ? (await listDir($, state)).find(entry => entry.name === 'board-snapshot.md' && entry.kind === 'file') : undefined
  if (!state || !stat) return NO_BOARD
  const key = `${state}|${stat.mtimeMs}:${stat.size}`
  if (boardCache.key !== key) {
    const board: Board = { key, done: new Set(), titles: new Map() }
    for (const line of (await readText($, `${state}/board-snapshot.md`)).split('\n')) {
      const row = /^\| #(\d+) \| (.*) \| ([^|]*) \|(?:[^|]*\|){5}$/.exec(line)
      if (!row) continue
      board.titles.set(Number(row[1]), (row[2] ?? '').replaceAll('\\|', '|').trim())
      if (row[3]?.trim() === 'Done') board.done.add(Number(row[1]))
    }
    boardCache = board
  }
  return boardCache
}

// `<state>/chains/<session-id>`: one chain a line, issue numbers in dispatch order.
async function readChains($: $): Promise<number[][]> {
  const [state, sid] = await Promise.all([resolveStateDir($), $.session.id()])
  if (!state || !sid) return []
  return (await readText($, `${state}/chains/${sid}`))
    .split('\n')
    .map(line => line.split(/\s+/).flatMap(token => (/^#?\d+$/.test(token) ? [Number(token.replace('#', ''))] : [])))
    .filter(chain => chain.length > 0)
}

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

// The session repo's `origin` remote, read from the git config file: null when it names no
// GitHub repo, and ticket refs stay text.
async function resolveRepo($: $): Promise<string | null> {
  return perRoot($, 'repo', async () => {
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

const PANE = 'workers'
const expanded = atom({ plugin: 'agent-ui', key: 'expanded' } as const, [] as string[])
const selectedRun = atom({ plugin: 'agent-ui', key: 'selectedRun' } as const, null)
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

function syncFrames($: $): void {
  if (animating.length === 0) {
    frameTimer?.cancel()
    frameTimer = null
    return
  }
  if (frameTimer) return
  frameTimer = $.clock.every(FRAME_MS, async () => {
    frameTick++
    const results = await Promise.all(
      animating.map(row =>
        $.ui
          .blit({ requestId: PANE, key: `avatar:${row.key}`, source: avatarPicture(row.avatar, 'running', frameTick) })
          .catch(() => ({ deny: 'blit failed' })),
      ),
    )
    // nothing of ours is mounted any more (the pane closed): wait for the next render
    if (results.every(result => result.deny)) animating = []
    syncFrames($)
  })
}

// A hovered row's background.
const COLUMN_LIT = '#3a3d50'

// The card draws on its own dark background, so its text colors are fixed, not the theme's.
const CARD_TEXT = '#e1e1e6'
const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, '0')}`
// A hover card, a panel row's or a chain issue's: hidden until its scope is hovered, painted over
// the pane at its place.
const CARD = { position: 'absolute', display: 'none', flexDirection: 'column', borderStyle: 'round', backgroundColor: '#2c2e3c', paddingX: 1 } as const

const MARK = { running: '◐', done: '✓', failed: '✗', dead: '†' } as const

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

const allRows = (rows: Row[]) => rows.flatMap(row => [row, ...row.children])

function selectedRow(rows: Row[], key: string | null): Row | null {
  return allRows(rows).find(row => row.key === key) ?? null
}

function visibleRows(rows: Row[], open: string[]) {
  return rows.flatMap(row => [
    { row, isChild: false },
    ...(open.includes(row.key) ? row.children.slice(0, CHILD_CAP).map(child => ({ row: child, isChild: true })) : []),
  ])
}

const tailOf = ($: $, row: Row) => row.diskRun ? readTail($, row.diskRun) : readNativeTail($, row.agentId ?? '')

const probes = new Map<string, Cached>()
let probeScope = ''
let runs: Run[] = []
let rows: Row[] = []
let prs: PrRow[] = []
let repo: string | null = null
let chains: ReturnType<typeof chainLinks>[] = []
let board = NO_BOARD
let selectedTail: { key: string; tail: Tail } | null = null
let refreshTimer: Timer | null = null
let refreshQueued = false
let refreshing = false
let lastRefreshAt: number | null = null
let drawnKey = ''

// Use the same visible rows and chain titles as the pane. Hidden child durations
// and unrelated board changes do not require a redraw.
const paneKey = (open: string[], chosen: string | null) => {
  const shown = selectedRow(rows, chosen)
  return JSON.stringify([
    visibleRows(rows, open).map(({ row, isChild }) =>
      [row.key, isChild, row.kind, row.label, row.status, row.avatar, row.model, row.duration, row.children.length]),
    shown && [shown.key, shown.label, shown.status, selectedTail?.key === shown.key ? selectedTail.tail : null],
    prs, prs.length > 0 || chains.length > 0 ? repo : null,
    chains.map(chain => chain.map(issue => [issue, board.titles.get(issue.n)])),
    panelListKey,
  ])
}

let panelListKey = ''
const panelTitles = (specs: PanelSpec[]) => JSON.stringify(specs.map(spec => [spec.id, spec.title]))

async function refresh($: $, options: PluginOptions): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    const panes = await $.ui.panes()
    if (!panes.some(pane => pane.id === PANE && pane.isShown)) return
    const now = await $.clock.now()
    const scope = JSON.stringify(await Promise.all([$.session.root(), $.session.id()]))
    if (scope !== probeScope) {
      probeScope = scope
      probes.clear()
      diskTail = null
      runs = []
    }
    const [scanned, agents, nextPrs, nextRepo, chainFile, root] = await Promise.all([
      scanRuns($, options, now, probes), $.agent.list().catch(() => []), readReadyPrs($),
      resolveRepo($), readChains($), repoRoot($),
    ])
    const [nextBoard, specs, chosen] = await Promise.all([
      chainFile.length > 0 ? readBoard($) : NO_BOARD,
      root ? readPanelSpecs($, root) : [],
      read($, selectedRun),
    ])
    runs = scanned ?? runs
    const nextRows = rowsFor(runs, agents, now)
    const shown = selectedRow(nextRows, chosen)
    const tail = shown ? await tailOf($, shown) : null
    const [open, currentChoice, refreshedAt] = await Promise.all([read($, expanded), read($, selectedRun), $.clock.now()])
    const active = new Set(allRows(nextRows).flatMap(row => {
      const n = row.status === 'running' ? issueNumber(row.label) : null
      return n ? [Number(n)] : []
    }))
    lastRefreshAt = refreshedAt
    rows = nextRows
    prs = nextPrs
    repo = nextRepo
    board = nextBoard
    chains = chainFile.map(chain => chainLinks(chain, board.done, active))
    if (chosen === currentChoice) selectedTail = shown && tail ? { key: shown.key, tail } : null
    panelListKey = panelTitles(specs)
    if (root) schedulePanels($, root, specs, now)
    const key = paneKey(open, currentChoice)
    if (drawnKey !== key) {
      drawnKey = key
      $.ui.invalidate('ui.render')
    }
  } finally {
    refreshing = false
  }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'workers',
      description: "Open a pane of this session's child runs; click one for its live tail",
    })
    roleTicksLeft = e.isInteractive ? ROLE_WAIT_TICKS : 0
    await openForManager($)
    if (roleTicksLeft > 0) {
      const roleTimer = $.clock.every(REFRESH_MS, async () => {
        await openForManager($)
        if (roleTicksLeft <= 0) roleTimer.cancel()
      })
    }
    return next(e)
  })

  on('command.run', { command: 'workers' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Workers' })

    return { text: 'Workers pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown, Link } = $.ui.resolve(e)
    const Image = e.surface === 'terminal' ? $.ui.resolve(e).Image : null
    refreshTimer ??= $.clock.every(REFRESH_MS, () => refresh($, options))
    const [chosen, open, root, openPanels, tabPicks, filterPicks, now] = await Promise.all([
      read($, selectedRun), read($, expanded), repoRoot($), read($, panelsOpen), read($, panelTabs), read($, panelFilters), $.clock.now(),
    ])
    const refreshedAt = lastRefreshAt
    if (!refreshQueued && !refreshing && (refreshedAt === null || now - refreshedAt > REFRESH_MS)) {
      refreshQueued = true
      $.clock.after(1, () => {
        refreshQueued = false
        if (lastRefreshAt === refreshedAt) return refresh($, options)
      })
    }
    const specs = root ? await readPanelSpecs($, root) : []
    if (root && specs.length > 0) schedulePanels($, root, specs, now)
    panelListKey = panelTitles(specs)
    const visible = visibleRows(rows, open)
    const shown = selectedRow(rows, chosen)
    const tail = shown && selectedTail?.key === shown.key ? selectedTail.tail : null
    drawnKey = paneKey(open, chosen)
    animating = Image
      ? visible.flatMap(({ row }) => (row.status === 'running' && row.avatar ? [{ key: row.key, avatar: row.avatar }] : [])).slice(0, MAX_ANIMATED)
      : []
    syncFrames($)
    // a card's top counts pane rows: the panels are the first rows of the pane
    const panels = root ? panelViews(root, specs, openPanels, tabPicks, filterPicks, 0, e.props.bodyColumns, e.props.scroll.offset + e.props.scroll.bodyRows) : []
    // chain row i sits below the panels (one line each: head, error, chips, columns, rows, no
    // data, note) and the Needs you list (title, one line per PR, a blank line)
    const panelLines = panels.reduce(
      (sum, view) => sum + 1 + (view.error ? 1 : 0) + view.chipRows.length + (view.header.length > 0 ? 1 : 0) + view.rows.length + (view.noData ? 1 : 0) + (view.tab?.note ? 1 : 0),
      0,
    )
    const chainTop = panelLines + (prs.length > 0 ? prs.length + 2 : 0)
    const paneRows = e.props.scroll.offset + e.props.scroll.bodyRows
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

    return (
      <Box flexDirection="column">
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
        {prs.length > 0 && (
          <Box key="needs-you" flexDirection="column" marginBottom={1}>
            <Text bold>Needs you</Text>
            {prs.map(pr => {
              const href = repo ? safeHref(`https://github.com/${repo}/pull/${pr.number}`) : null
              return (
                <Box key={`pr:${pr.number}`}>
                  <Box key={`pr-mark-${pr.number}`} width={3} flexShrink={0}>
                    <Text color={hex(MARK_TONES[pr.mark])}>{pr.mark}</Text>
                  </Box>
                  <Box key={`pr-num-${pr.number}`} flexShrink={0}>
                    {href ? <Text color={ACCENT}><Link key={`pr-link-${pr.number}`} href={href} label={`#${pr.number}`} /></Text> : <Text color={ACCENT}>{`#${pr.number}`}</Text>}
                  </Box>
                  <Text wrap="truncate-end">{` ${pr.title}`}</Text>
                </Box>
              )
            })}
          </Box>
        )}
        {chains.length > 0 && (
          <Box key="chains" flexDirection="column" marginBottom={1}>
            {chains.map((chain, i) => (
              <Box key={`chain:${i}`} flexDirection="row">
                {chain.map(({ n, mark }, k) => {
                  const href = repo ? safeHref(`https://github.com/${repo}/issues/${n}`) : null
                  return (
                    <Box key={`chain-issue:${i}:${k}`} flexDirection="row" flexShrink={0} hover={{ scope: `chain:${i}:${n}`, backgroundColor: COLUMN_LIT }}>
                      {k > 0 && <Text dimColor>{' → '}</Text>}
                      <Text color={mark === 'merged' ? 'green' : mark === 'active' ? ACCENT : undefined} dimColor={mark === 'merged'}>
                        {href ? <Link href={href} label={`#${n}`} /> : `#${n}`}
                        {mark === 'merged' ? ' ✓' : ''}
                      </Text>
                    </Box>
                  )
                })}
              </Box>
            ))}
          </Box>
        )}
        <Text bold>Workers</Text>
        {!childrenDirOf(options) ? (
          <Box key="no-children-dir">
            <Text dimColor>set childrenDir in /config</Text>
          </Box>
        ) : (
          rows.length === 0 && <Text dimColor>No child runs for this session.</Text>
        )}
        {visible.map(({ row, isChild }) => (
          <Box key={`row:${row.key}`} flexDirection="row">
            {isChild && <Text dimColor>{'  └ '}</Text>}
            {Image && row.avatar ? (
              <Image key={`avatar:${row.key}`} columns={SPRITE_COLS} rows={1} source={avatarPicture(row.avatar, row.status, frameTick)} alt={MARK[row.status]} />
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
              label={`${row.kind ? `${row.kind} ` : ''}${row.label}${row.model ? `  ${row.model}` : ''}${row.duration ? `  ${row.duration}` : ''}  ${row.status}${row.children.length > 0 ? `  ${open.includes(row.key) ? '▾' : '▸'}${row.children.length}` : ''}`}
              onPress={async () => {
                const wasShown = (await read($, selectedRun)) === row.key
                const tail = wasShown ? null : await tailOf($, row)
                selectedTail = tail ? { key: row.key, tail } : null
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
        {/* a hovered #N reveals a card of its board title, below its chain row or else above it */}
        {chains.flatMap((chain, i) =>
          chain.flatMap(({ n, mark }, k) => {
            const title = board.titles.get(n)
            if (title === undefined) return []
            const head = `#${n}${mark === 'merged' ? ' ✓' : ''} · `
            const width = Math.min(e.props.bodyColumns, head.length + title.length + 4)
            return [
              <Box key={`chain-card:${i}:${k}`} {...CARD} top={placeBeside(chainTop + i, 1, 3, paneRows).x} left={0} width={width} hover={{ display: 'flex', scope: `chain:${i}:${n}` }}>
                <Box key="chain-card-line" flexDirection="row" flexWrap="nowrap">
                  <Text color={mark === 'merged' ? 'green' : mark === 'active' ? ACCENT : CARD_TEXT}>{head}</Text>
                  <Text color={CARD_TEXT} wrap="truncate-end">{title}</Text>
                </Box>
              </Box>,
            ]
          }),
        )}
      </Box>
    )
  })


}
