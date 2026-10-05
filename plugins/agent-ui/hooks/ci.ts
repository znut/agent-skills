import { toBase64 } from './lib'

// main-ci's run history, from its metrics.jsonl (one row per job attempt): runs grouped, the
// stacked-bar chart encoded as one RGBA picture or as block-glyph cells, and a run's hover card.
export type MetricRow = {
  run: string
  sha: string
  job: string
  attempt: number
  wall: number
  cpu: number
  mb: number
  exit: number | null
  load: number | null
}
export type CiJob = { job: string; wall: number; cpu: number; mb: number; retries: number }
export type CiRun = { run: string; sha8: string; jobs: CiJob[]; green: boolean; retries: number; load: number | null; peak: number; pending: boolean; cancelled: boolean }
export type MainState = { sha: string; phase: string }
export type Cell = { glyph: number; color: number }

export const AXIS_COLS = 6
export const CHART_ROWS = 6
const PX_COL = 6 // picture pixels per terminal column
const PX_ROW = 12 // and per row: a cell is about 1:2
const BAR_PAD = 2 // pixels clear on each side of a bar
const TOP = 8 // room above the tallest bar for a retry count
const UNDER = 3 // room below the bars for a red run's underline
const RED = 0xe65a50
const LOAD = 0x8caad2
const DIM = 0x787a87
const PALETTE = [
  0xb25248, 0xb08c50, 0xc4c45a, 0x8caa5a, 0x5aa0a0, 0x6e82c8, 0x5a5ac8,
  0x965ac8, 0xb45ab4, 0xc878a0, 0x82bed2, 0xdcaa78, 0x787878, 0xaa6e5a,
]
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

// One row per line; a preview's rows and lines that are not a job attempt are skipped.
export function parseRows(text: string): MetricRow[] {
  const rows: MetricRow[] = []
  for (const line of text.split('\n')) {
    let value: Record<string, unknown>
    try {
      value = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (value?.kind === 'preview' || typeof value?.run !== 'string' || typeof value.job !== 'string') continue
    rows.push({
      run: value.run,
      sha: typeof value.sha === 'string' ? value.sha : '',
      job: value.job,
      attempt: num(value.attempt) ?? 1,
      wall: num(value.wall_s) ?? 0,
      cpu: (num(value.cpu_user_s) ?? 0) + (num(value.cpu_sys_s) ?? 0),
      mb: num(value.max_rss_mb) ?? 0,
      exit: num(value.exit),
      load: num(value.load1_start),
    })
  }
  return rows
}

// A run's jobs at their final (highest) attempt; retries count every attempt after the first.
export function summarize(run: string, rows: MetricRow[]): CiRun {
  const final = new Map<string, MetricRow>()
  for (const row of rows) if (row.attempt >= (final.get(row.job)?.attempt ?? 0)) final.set(row.job, row)
  const jobs = [...final.values()].map(row => ({ job: row.job, wall: row.wall, cpu: row.cpu, mb: row.mb, retries: row.attempt - 1 }))
  return {
    run,
    sha8: (rows[0]?.sha ?? '').slice(0, 8),
    jobs: jobs.sort((a, b) => a.job.localeCompare(b.job)),
    green: [...final.values()].every(row => row.exit === 0),
    retries: rows.filter(row => row.attempt > 1).length,
    load: rows.find(row => row.load !== null)?.load ?? null,
    peak: Math.max(0, ...rows.map(row => row.mb)),
    pending: false,
    cancelled: false,
  }
}

// A cancel (run.log: the tip moved) ends the latest run of its sha that started before it; the
// run name starts with its start time, `YYYYMMDDTHHMMSS`, as `at` does.
export function markCancelled(runs: CiRun[], cancels: { sha8: string; at: string }[]): CiRun[] {
  const hit = new Set<string>()
  for (const cancel of cancels) {
    let latest: CiRun | undefined
    for (const run of runs) if (run.sha8 === cancel.sha8 && run.run.slice(0, 15) <= cancel.at && (!latest || run.run > latest.run)) latest = run
    if (latest) hit.add(latest.run)
  }
  return hit.size === 0 ? runs : runs.map(run => (hit.has(run.run) ? { ...run, cancelled: true, pending: false } : run))
}

// The run main-ci is on: state.json's run while its lanes build, or a run newer than state.json's
// (its core has not finished). A building run with no rows yet is an empty slot at the end.
export function withPending(runs: CiRun[], state: MainState | null): CiRun[] {
  if (!state) return runs
  const sha8 = state.sha.slice(0, 8)
  const at = runs.findLastIndex(run => run.sha8 === sha8)
  const last = runs.at(-1)
  const pendLast = () => [...runs.slice(0, -1), { ...(last as CiRun), pending: true }]
  if (last && at >= 0 && at < runs.length - 1) return pendLast()
  if (state.phase !== 'builds') return runs
  if (at >= 0) return pendLast()
  return [...runs, { run: `pending-${sha8}`, sha8, jobs: [], green: false, retries: 0, load: null, peak: 0, pending: true, cancelled: false }]
}

// Run i's first cell, counted from the chart's left edge (the axis included): its bar, its
// hover column and its card's placement all start here.
export const runCell = (i: number) => AXIS_COLS + i * 2

export const runsFit = (bodyColumns: number) => Math.max(0, Math.floor((bodyColumns - AXIS_COLS) / 2))

export function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return hash >>> 0
}

// Hashed from the name: a job keeps its color whatever other jobs exist.
export const jobColor = (job: string): number => PALETTE[fnv1a(job) % PALETTE.length] as number

// A repo panel's bar tones, in the chart's colors.
export const TONES: Record<string, number> = { good: PALETTE[3] as number, mid: PALETTE[2] as number, bad: RED, dim: DIM }

// What a bar measures: each job's wall or cpu seconds stacked, or the run's peak memory.
export type Metric = 'wall' | 'cpu' | 'mem'
export const METRICS: readonly Metric[] = ['wall', 'cpu', 'mem']

// A run's bar, bottom up. mem is one part, the run's peak in the colour of the job that hit it:
// jobs run one after another, so a sum of their peaks is memory never in use at once.
export function barParts(run: CiRun, metric: Metric): { job: string; value: number }[] {
  if (metric !== 'mem') return run.jobs.map(job => ({ job: job.job, value: metric === 'cpu' ? job.cpu : job.wall }))
  const top = run.jobs.reduce<CiJob | null>((best, job) => (best && best.mb >= job.mb ? best : job), null)
  return top ? [{ job: top.job, value: run.peak }] : []
}

export const barTotal = (run: CiRun, metric: Metric) => barParts(run, metric).reduce((sum, part) => sum + part.value, 0)
export const barMax = (runs: CiRun[], metric: Metric) => Math.max(1, ...runs.map(run => barTotal(run, metric)))

// The axis's top label, a line each (it is AXIS_COLS wide), and its bottom one.
export function axisLabels(max: number, metric: Metric): { top: string[]; bottom: string } {
  if (metric === 'mem') return { top: [max >= 1024 ? `${(max / 1024).toFixed(1)}G` : `${Math.round(max)}M`], bottom: '0' }
  return { top: metric === 'cpu' ? [`${Math.round(max)}s`, 'cpu'] : [`${Math.round(max)}s`], bottom: '0s' }
}

// 3x5 digits for a retry count; 9+ reads "+".
const DIGITS: Record<string, string> = {
  '1': '.X.XX..X..X.XXX', '2': 'XX...X.X.X..XXX', '3': 'XX...X.X...XXX.', '4': 'X.XX.XXXX..X..X',
  '5': 'XXXX..XX...XXX.', '6': '.XXX..XX.X.X.X.', '7': 'XXX..X.X..X..X.', '8': '.X.X.X.X.X.X.X.',
  '9': '.X.X.X.XX..X.X.', '+': '....X.XXX.X....',
}

type Picture = { rgba: string; width: number; height: number }

// One picture per run, 2 cells by CHART_ROWS, cut from the whole chart so the load line runs on
// across them. A terminal fits a picture to its cell box keeping its aspect ratio, so one wide
// picture drifts off the cell grid wherever the cells are not exactly 1:2; one per run column
// keeps each bar inside its own hover column.
export function chartTiles(runs: CiRun[], metric: Metric = 'wall'): Picture[] {
  const whole = chartBytes(runs, metric)
  const tile = 2 * PX_COL
  return runs.map((_, i) => {
    const bytes = new Uint8Array(tile * whole.height * 4)
    for (let y = 0; y < whole.height; y++) bytes.set(whole.bytes.subarray((y * whole.width + i * tile) * 4, (y * whole.width + (i + 1) * tile) * 4), y * tile * 4)
    return { rgba: toBase64(bytes), width: tile, height: whole.height }
  })
}

export function chartBytes(runs: CiRun[], metric: Metric = 'wall'): { bytes: Uint8Array; width: number; height: number } {
  const width = Math.max(1, runs.length) * 2 * PX_COL
  const height = CHART_ROWS * PX_ROW
  const bytes = new Uint8Array(width * height * 4)
  const put = (x: number, y: number, rgb: number, alpha = 255) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    bytes.set([(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, alpha], (y * width + x) * 4)
  }
  const base = height - UNDER - 1
  const span = base - TOP
  const scale = span / barMax(runs, metric)
  const loadMax = Math.max(1, ...runs.map(run => run.load ?? 0))
  const points: [number, number][] = []
  runs.forEach((run, i) => {
    const x0 = (runCell(i) - AXIS_COLS) * PX_COL + BAR_PAD
    const x1 = (runCell(i) - AXIS_COLS + 2) * PX_COL - BAR_PAD
    let sum = 0
    let top = base + 1
    const faded = run.pending || run.cancelled
    for (const part of barParts(run, metric)) {
      const from = base - Math.round((sum + part.value) * scale) + 1
      for (let y = from; y < top; y++) for (let x = x0; x < x1; x++) put(x, y, jobColor(part.job), faded ? 128 : 255)
      sum += part.value
      top = Math.min(top, from)
    }
    if (faded) {
      for (let y = TOP; y <= base; y += 2) {
        put(x0, y, DIM)
        put(x1 - 1, y, DIM)
      }
    }
    if (run.retries > 0) {
      const glyph = DIGITS[run.retries > 9 ? '+' : String(run.retries)] ?? ''
      const gx = Math.floor((x0 + x1) / 2) - 1
      for (let k = 0; k < 15; k++) if (glyph[k] === 'X') put(gx + (k % 3), top - 6 + Math.floor(k / 3), RED)
    }
    if (!run.green && !faded) for (let y = base + 2; y < height; y++) for (let x = x0; x < x1; x++) put(x, y, RED)
    if (run.load !== null) points.push([Math.floor((x0 + x1) / 2), base - Math.round((run.load / loadMax) * span)])
  })
  for (let k = 1; k < points.length; k++) {
    const [ax, ay] = points[k - 1] as [number, number]
    const [bx, by] = points[k] as [number, number]
    const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay), 1)
    for (let s = 0; s <= steps; s++) put(Math.round(ax + ((bx - ax) * s) / steps), Math.round(ay + ((by - ay) * s) / steps), LOAD)
  }
  return { bytes, width, height }
}

// The fallback: rows x (2 per run) cells of ▁..█, colored by the bar's largest part; a retry
// count in red above the bar.
export function chartCells(runs: CiRun[], metric: Metric = 'wall'): Cell[][] {
  const eighths = CHART_ROWS * 8
  const scale = (eighths - 8) / barMax(runs, metric)
  const grid: Cell[][] = Array.from({ length: CHART_ROWS }, () => Array.from({ length: runs.length * 2 }, () => ({ glyph: 0x20, color: DIM })))
  runs.forEach((run, i) => {
    const parts = barParts(run, metric)
    const color = parts.reduce<(typeof parts)[number] | null>((top, part) => (top && top.value >= part.value ? top : part), null)
    const level = Math.round(barTotal(run, metric) * scale)
    for (let row = 0; row < CHART_ROWS; row++) {
      const fill = Math.min(8, Math.max(0, level - (CHART_ROWS - 1 - row) * 8))
      const glyph = fill === 0 ? 0x20 : 0x2580 + fill
      for (const dx of [0, 1]) (grid[row] as Cell[])[i * 2 + dx] = { glyph, color: color ? jobColor(color.job) : DIM }
    }
    const above = CHART_ROWS - 1 - Math.ceil(level / 8)
    if (run.retries > 0 && above >= 0) (grid[above] as Cell[])[i * 2] = { glyph: (run.retries > 9 ? '+' : String(run.retries)).charCodeAt(0), color: RED }
  })
  return grid
}

// Run i's 2 columns of the fallback grid.
export const tileCells = (grid: Cell[][], i: number): Cell[][] => grid.map(row => row.slice(i * 2, i * 2 + 2))

export function encodeCells(grid: Cell[][]): string {
  const words = Uint32Array.from(grid.flatMap(row => row.flatMap(cell => [cell.glyph, cell.color, 0x01000000])))
  return toBase64(new Uint8Array(words.buffer))
}

const pad = (text: string, width: number, right = false) => (right ? text.padStart(width) : text.padEnd(width))

export type CardRow = { job: string; name: string; nums: string }
export type CardTable = { head: string; header: CardRow; rows: CardRow[]; nameWidth: number; width: number }

const CARD_COLUMNS: { label: string; width: number; of: (job: CiJob) => string }[] = [
  { label: 'wall', width: 6, of: job => job.wall.toFixed(1) },
  { label: 'cpu', width: 6, of: job => job.cpu.toFixed(1) },
  { label: 'MB', width: 6, of: job => String(Math.round(job.mb)) },
  { label: 're', width: 3, of: job => String(job.retries) },
]
const NAME_MIN = 8
const NAME_MAX = 16

// The hover card: a heading, then job / wall / cpu / MB / re for the run's 8 slowest jobs, each
// row a name cell and a numbers cell, never wider than `width`: the name shortens first (to
// NAME_MIN), then `re` goes, then `cpu`. `width` is the card's content width.
export function cardTable(run: CiRun, maxWidth = Infinity): CardTable {
  const head = `${run.sha8}${run.cancelled ? ' · cancelled (tip moved)' : ''} · load ${run.load === null ? '-' : run.load.toFixed(1)} · peak ${Math.round(run.peak)} MB${run.pending ? ' · running' : ''}`
  const slowest = [...run.jobs].sort((a, b) => b.wall - a.wall).slice(0, 8)
  const natural = Math.min(NAME_MAX, Math.max('job'.length, ...slowest.map(job => job.job.length)) + 1)
  let columns = CARD_COLUMNS
  const numsWidth = () => columns.reduce((sum, column) => sum + column.width, 0)
  const nameFor = () => Math.max(Math.min(natural, NAME_MIN), Math.min(natural, maxWidth - numsWidth()))
  for (const drop of ['re', 'cpu']) if (nameFor() + numsWidth() > maxWidth) columns = columns.filter(column => column.label !== drop)
  const nameWidth = Math.min(nameFor(), Math.max(1, maxWidth))
  const width = Math.max(1, Math.min(maxWidth, Math.max(head.length, nameWidth + numsWidth())))
  const row = (job: string, cells: string[]): CardRow => ({
    job,
    name: pad(job.slice(0, nameWidth - 1), nameWidth),
    nums: cells.map((text, k) => pad(text, (columns[k] as (typeof columns)[number]).width, true)).join('').slice(0, width - nameWidth),
  })
  return {
    head: head.slice(0, width),
    header: row('job', columns.map(column => column.label)),
    rows: slowest.map(job => row(job.job, columns.map(column => column.of(job)))),
    nameWidth,
    width,
  }
}

// Where a card goes along one axis of `span` cells, beside the `size` cells it describes at `at`:
// after them, else before them, never over them; when it fits on neither side whole, on the
// roomier side, cut to fit.
export function placeBeside(at: number, size: number, card: number, span: number): { x: number; width: number } {
  const after = span - (at + size)
  if (card <= after) return { x: at + size, width: card }
  if (card <= at) return { x: at - card, width: card }
  return after >= at ? { x: at + size, width: after } : { x: 0, width: at }
}

// A run's card: right of its column, else left of it.
export const cardPlace = (column: number, cardWidth: number, bodyColumns: number) => placeBeside(runCell(column), 2, cardWidth, bodyColumns)
