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
export type CiRun = { run: string; sha8: string; jobs: CiJob[]; green: boolean; retries: number; load: number | null; peak: number; pending: boolean }
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
  }
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
  return [...runs, { run: `pending-${sha8}`, sha8, jobs: [], green: false, retries: 0, load: null, peak: 0, pending: true }]
}

export const runsFit = (bodyColumns: number) => Math.max(0, Math.floor((bodyColumns - AXIS_COLS) / 2))

// FNV-1a of the name: a job keeps its color whatever other jobs exist.
export function jobColor(job: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < job.length; i++) hash = Math.imul(hash ^ job.charCodeAt(i), 0x01000193)
  return PALETTE[(hash >>> 0) % PALETTE.length] as number
}

export const totalWall = (run: CiRun) => run.jobs.reduce((sum, job) => sum + job.wall, 0)
export const maxWall = (runs: CiRun[]) => Math.max(1, ...runs.map(totalWall))

// 3x5 digits for a retry count; 9+ reads "+".
const DIGITS: Record<string, string> = {
  '1': '.X.XX..X..X.XXX', '2': 'XX...X.X.X..XXX', '3': 'XX...X.X...XXX.', '4': 'X.XX.XXXX..X..X',
  '5': 'XXXX..XX...XXX.', '6': '.XXX..XX.X.X.X.', '7': 'XXX..X.X..X..X.', '8': '.X.X.X.X.X.X.X.',
  '9': '.X.X.X.XX..X.X.', '+': '....X.XXX.X....',
}

export function encodeChart(runs: CiRun[]): { rgba: string; width: number; height: number } {
  const width = Math.max(1, runs.length) * 2 * PX_COL
  const height = CHART_ROWS * PX_ROW
  const bytes = new Uint8Array(width * height * 4)
  const put = (x: number, y: number, rgb: number, alpha = 255) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    bytes.set([(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, alpha], (y * width + x) * 4)
  }
  const base = height - UNDER - 1
  const span = base - TOP
  const scale = span / maxWall(runs)
  const loadMax = Math.max(1, ...runs.map(run => run.load ?? 0))
  const points: [number, number][] = []
  runs.forEach((run, i) => {
    const x0 = i * 2 * PX_COL + BAR_PAD
    const x1 = (i + 1) * 2 * PX_COL - BAR_PAD
    let sum = 0
    let top = base + 1
    for (const job of run.jobs) {
      const from = base - Math.round((sum + job.wall) * scale) + 1
      for (let y = from; y < top; y++) for (let x = x0; x < x1; x++) put(x, y, jobColor(job.job), run.pending ? 128 : 255)
      sum += job.wall
      top = Math.min(top, from)
    }
    if (run.pending) {
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
    if (!run.green && !run.pending) for (let y = base + 2; y < height; y++) for (let x = x0; x < x1; x++) put(x, y, RED)
    if (run.load !== null) points.push([Math.floor((x0 + x1) / 2), base - Math.round((run.load / loadMax) * span)])
  })
  for (let k = 1; k < points.length; k++) {
    const [ax, ay] = points[k - 1] as [number, number]
    const [bx, by] = points[k] as [number, number]
    const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay), 1)
    for (let s = 0; s <= steps; s++) put(Math.round(ax + ((bx - ax) * s) / steps), Math.round(ay + ((by - ay) * s) / steps), LOAD)
  }
  return { rgba: toBase64(bytes), width, height }
}

// The fallback: rows x (2 per run) cells of ▁..█, colored by the run's slowest job; a retry
// count in red above the bar.
export function chartCells(runs: CiRun[]): Cell[][] {
  const eighths = CHART_ROWS * 8
  const scale = (eighths - 8) / maxWall(runs)
  const grid: Cell[][] = Array.from({ length: CHART_ROWS }, () => Array.from({ length: runs.length * 2 }, () => ({ glyph: 0x20, color: DIM })))
  runs.forEach((run, i) => {
    const color = run.jobs.reduce<CiJob | null>((top, job) => (top && top.wall >= job.wall ? top : job), null)
    const level = Math.round(totalWall(run) * scale)
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

export function encodeCells(grid: Cell[][]): string {
  const words = Uint32Array.from(grid.flatMap(row => row.flatMap(cell => [cell.glyph, cell.color, 0x01000000])))
  return toBase64(new Uint8Array(words.buffer))
}

const pad = (text: string, width: number, right = false) => (right ? text.padStart(width) : text.padEnd(width))

// The hover card: a heading, then job / wall / cpu / MB / re for the run's 8 slowest jobs, each
// line at most `width` columns (the job name gives way first).
export function cardLines(run: CiRun, width = Infinity): string[] {
  const nameWidth = Math.max(4, Math.min(16, width - 21))
  const line = (job: string, ...cells: [string, number][]) => `${pad(job.slice(0, nameWidth - 1), nameWidth)}${cells.map(([text, w]) => pad(text, w, true)).join('')}`
  const head = `${run.sha8} · load1 ${run.load === null ? '-' : run.load.toFixed(1)} · peak ${Math.round(run.peak)} MB${run.pending ? ' · running' : ''}`
  const table = [...run.jobs].sort((a, b) => b.wall - a.wall).slice(0, 8).map(job =>
    line(job.job, [job.wall.toFixed(1), 6], [job.cpu.toFixed(1), 6], [String(Math.round(job.mb)), 6], [String(job.retries), 3]),
  )
  return [head, line('job', ['wall', 6], ['cpu', 6], ['MB', 6], ['re', 3]), ...table].map(text => text.slice(0, Math.max(1, width)))
}

// The card's left offset from its run column, clamped so the card stays inside the pane.
export function cardLeft(column: number, cardWidth: number, bodyColumns: number): number {
  const at = AXIS_COLS + column * 2
  return Math.max(-at, Math.min(2, bodyColumns - cardWidth - at))
}
