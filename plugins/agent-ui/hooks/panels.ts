import { TONES } from './ci'

// Repo panels: `.agent/pane-panels.json` lists commands, each prints one JSON object of tabs of
// rows (README, "Repo panels"). This file parses both and lays a row out as colored segments.
export type PanelSpec = { id: string; title: string; cmd: string[]; refreshMs: number }
export type Bar = { frac: number; text: string; tone: string }
export type Column = { key: string; label: string; width: number; align: 'left' | 'right'; isBar: boolean }
export type PanelRow = { id: string; dim: boolean; cells: Record<string, string | Bar>; hover: string[] }
export type PanelTab = { id: string; label: string; columns: Column[]; rows: PanelRow[]; note: string }
export type PanelData = { summary: string; tab: string; tabs: PanelTab[] }
export type Segment = { text: string; color?: number }

export const PANEL_TIMEOUT_MS = 10_000
const REFRESH_DEFAULT_S = 60
// above the pane's 3 s tick, so a panel never runs on every tick
const REFRESH_MIN_S = 5
const HOVER_LINES = 6
// one space between columns
const GAP = 1

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback)

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// Entries without an id or an argv are skipped; a file that is no list lists nothing.
export function parseSpecs(text: string): PanelSpec[] {
  const list = parseJson(text)
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  return list.flatMap(entry => {
    if (!isObject(entry) || typeof entry.id !== 'string' || entry.id === '' || seen.has(entry.id)) return []
    const cmd = entry.cmd
    if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every(arg => typeof arg === 'string') || cmd[0] === '') return []
    seen.add(entry.id)
    const refresh = typeof entry.refresh_s === 'number' && Number.isFinite(entry.refresh_s) ? entry.refresh_s : REFRESH_DEFAULT_S
    return [{ id: entry.id, title: str(entry.title, entry.id), cmd: cmd as string[], refreshMs: Math.max(REFRESH_MIN_S, refresh) * 1000 }]
  })
}

function parseCell(value: unknown): string | Bar {
  if (!isObject(value)) return str(value)
  const frac = typeof value.frac === 'number' && Number.isFinite(value.frac) ? Math.min(1, Math.max(0, value.frac)) : 0
  return { frac, text: str(value.text), tone: str(value.tone, 'dim') }
}

// One JSON object with a list of tabs, else null; a tab without an id, columns or rows is dropped.
export function parsePanelOutput(stdout: string): PanelData | null {
  const value = parseJson(stdout.trim())
  if (!isObject(value) || !Array.isArray(value.tabs)) return null
  const tabs = value.tabs.flatMap((tab): PanelTab[] => {
    if (!isObject(tab) || typeof tab.id !== 'string' || !Array.isArray(tab.columns) || !Array.isArray(tab.rows)) return []
    const columns = tab.columns.filter(isObject).map(column => ({
      key: str(column.key),
      label: str(column.label, str(column.key)),
      width: typeof column.width === 'number' && column.width > 0 ? Math.floor(column.width) : str(column.label, str(column.key)).length,
      align: column.align === 'right' ? ('right' as const) : ('left' as const),
      isBar: column.kind === 'bar',
    }))
    const rows = tab.rows.filter(isObject).map((row, i) => ({
      id: str(row.id, String(i)),
      dim: row.dim === true,
      cells: Object.fromEntries(Object.entries(isObject(row.cells) ? row.cells : {}).map(([key, cell]) => [key, parseCell(cell)])),
      hover: (Array.isArray(row.hover) ? row.hover : []).map(line => str(line)).slice(0, HOVER_LINES),
    }))
    return [{ id: tab.id, label: str(tab.label, tab.id), columns, rows, note: str(tab.note) }]
  })
  return { summary: str(value.summary), tab: str(value.tab), tabs }
}

// The user's pick if the output still has it, else the output's default, else the first tab.
export function pickTab(data: PanelData, chosen: string | undefined): PanelTab | null {
  return data.tabs.find(tab => tab.id === chosen) ?? data.tabs.find(tab => tab.id === data.tab) ?? data.tabs[0] ?? null
}

const fit = (text: string, width: number, right: boolean) => (right ? text.slice(0, width).padStart(width) : text.slice(0, width).padEnd(width))

// `frac` of `width` cells in eighths: full blocks, then one partial block, then blanks.
export function barGlyphs(frac: number, width: number): string {
  const eighths = Math.round(Math.min(1, Math.max(0, frac)) * width * 8)
  const full = Math.floor(eighths / 8)
  const part = eighths % 8 === 0 || full >= width ? '' : String.fromCharCode(0x2590 - (eighths % 8))
  return `${'█'.repeat(full)}${part}`.padEnd(width)
}

function cellSegments(column: Column, value: string | Bar | undefined): Segment[] {
  if (column.isBar && typeof value === 'object') {
    const barWidth = Math.max(0, column.width - 4)
    return [
      { text: barGlyphs(value.frac, barWidth), color: TONES[value.tone] ?? TONES.dim },
      { text: fit(value.text, column.width - barWidth, true) },
    ]
  }
  const text = typeof value === 'object' ? value.text : (value ?? '')
  return [{ text: fit(text, column.width, column.align === 'right') }]
}

// Cut to `width` columns: a row never wraps.
export function clip(segments: Segment[], width: number): Segment[] {
  const out: Segment[] = []
  let left = Math.max(0, width)
  for (const segment of segments) {
    if (left === 0) break
    const text = segment.text.slice(0, left)
    left -= text.length
    if (text !== '') out.push({ ...segment, text })
  }
  return out
}

const join = (cells: Segment[][]): Segment[] => cells.flatMap((cell, i) => (i === 0 ? cell : [{ text: ' '.repeat(GAP) }, ...cell]))

export const headerSegments = (tab: PanelTab, width: number): Segment[] =>
  clip(join(tab.columns.map(column => [{ text: fit(column.label, column.width, column.align === 'right' && !column.isBar) }])), width)

export const rowSegments = (tab: PanelTab, row: PanelRow, width: number): Segment[] =>
  clip(join(tab.columns.map(column => cellSegments(column, row.cells[column.key]))), width)

export function firstLine(text: string): string {
  return text.split('\n').map(line => line.trim()).find(Boolean) ?? ''
}
