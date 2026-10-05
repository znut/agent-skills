import { TONES } from './ci'

// Repo panels: `.agent/pane-panels.json` lists commands, each prints one JSON object of tabs of
// rows (README, "Repo panels"). This file parses both and lays a row out as colored segments.
export type PanelSpec = { id: string; title: string; cmd: string[]; refreshMs: number }
export type Bar = { frac: number; text: string; tone: string }
export type Column = { key: string; label: string; width: number; align: 'left' | 'right'; isBar: boolean }
export type PanelRow = { id: string; dim: boolean; cells: Record<string, string | Bar>; hover: string[] }
export type PanelTab = { id: string; label: string; columns: Column[]; rows: PanelRow[]; note: string }
export type FilterOption = { id: string; label: string }
export type Filter = { id: string; options: FilterOption[]; default: string }
export type PanelData = { summary: string; tab: string; tabs: PanelTab[]; filters: Filter[] }
export type Segment = { text: string; color?: number; background?: number }

export const PANEL_TIMEOUT_MS = 10_000
const REFRESH_DEFAULT_S = 60
// above the pane's 3 s tick, so a panel never runs on every tick
const REFRESH_MIN_S = 5
// what one panel may draw, whatever its command prints
const HOVER_LINES = 6
const MAX_WIDTH = 200
const MAX_COLUMNS = 12
const MAX_TABS = 12
// with filters, one tab per option combination
const MAX_FILTERS = 3
const MAX_OPTIONS = 12
const MAX_FILTER_TABS = 48
const MAX_ROWS = 100
// one space between columns
const GAP = 1
// a bar's unfilled cells, and its text's ink over the fill and over the track
export const BAR_TRACK = 0x3a3c4e
export const INK_ON_FILL = 0x1e1f28
export const INK_ON_TRACK = 0xe1e1e6

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
// A control character (a newline, an escape sequence's ESC) would break the row or restyle the
// terminal: each becomes a space.
export const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, ' ')
const str = (value: unknown, fallback = ''): string => clean(typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback)

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
// v1.1 filters: chip rows that together pick a tab, its id their picks joined by `/`. A filter
// without an id or an option, and an option without an id or seen before, is dropped; the caps
// count what is left.
function parseFilters(value: unknown): Filter[] {
  if (!Array.isArray(value)) return []
  const filters = value.flatMap((filter): Filter[] => {
    if (!isObject(filter) || typeof filter.id !== 'string' || filter.id === '' || !Array.isArray(filter.options)) return []
    const seen = new Set<string>()
    const options = filter.options.flatMap((option): FilterOption[] => {
      if (!isObject(option) || typeof option.id !== 'string' || option.id === '' || seen.has(option.id)) return []
      seen.add(option.id)
      return [{ id: option.id, label: str(option.label, option.id) }]
    })
    return options.length === 0 ? [] : [{ id: filter.id, options: options.slice(0, MAX_OPTIONS), default: typeof filter.default === 'string' ? filter.default : '' }]
  })
  return filters.slice(0, MAX_FILTERS)
}

export function parsePanelOutput(stdout: string): PanelData | null {
  const value = parseJson(stdout.trim())
  if (!isObject(value) || !Array.isArray(value.tabs)) return null
  const filters = parseFilters(value.filters)
  const tabs = value.tabs.slice(0, filters.length > 0 ? MAX_FILTER_TABS : MAX_TABS).flatMap((tab): PanelTab[] => {
    if (!isObject(tab) || typeof tab.id !== 'string' || !Array.isArray(tab.columns) || !Array.isArray(tab.rows)) return []
    const columns = tab.columns.slice(0, MAX_COLUMNS).filter(isObject).map(column => ({
      key: str(column.key),
      label: str(column.label, str(column.key)),
      width: Math.min(MAX_WIDTH, typeof column.width === 'number' && column.width > 0 ? Math.floor(column.width) : str(column.label, str(column.key)).length),
      align: column.align === 'right' ? ('right' as const) : ('left' as const),
      isBar: column.kind === 'bar',
    }))
    const rows = tab.rows.slice(0, MAX_ROWS).filter(isObject).map((row, i) => ({
      id: str(row.id, String(i)),
      dim: row.dim === true,
      cells: Object.fromEntries(Object.entries(isObject(row.cells) ? row.cells : {}).map(([key, cell]) => [key, parseCell(cell)])),
      hover: (Array.isArray(row.hover) ? row.hover : []).slice(0, HOVER_LINES).map(line => str(line)),
    }))
    return [{ id: tab.id, label: str(tab.label, tab.id), columns, rows, note: str(tab.note) }]
  })
  return { summary: str(value.summary), tab: str(value.tab), tabs, filters }
}

// Each filter's option: the user's pick while still offered, else its default, else its first.
export function pickOptions(filters: Filter[], picks: Record<string, string> | undefined): string[] {
  const offered = (filter: Filter, id: string | undefined) => filter.options.some(option => option.id === id)
  return filters.map(filter => {
    const pick = picks?.[filter.id]
    return offered(filter, pick) ? (pick as string) : offered(filter, filter.default) ? filter.default : (filter.options[0] as FilterOption).id
  })
}

// The user's pick if the output still has it, else the output's default, else the first tab.
export function pickTab(data: PanelData, chosen: string | undefined): PanelTab | null {
  return data.tabs.find(tab => tab.id === chosen) ?? data.tabs.find(tab => tab.id === data.tab) ?? data.tabs[0] ?? null
}

const fit = (text: string, width: number, right: boolean) => (right ? text.slice(0, width).padStart(width) : text.slice(0, width).padEnd(width))

// A bar the whole cell wide: its first `frac` of the cells on the tone's background, the rest
// on the track; the text right-aligned over it, one cell clear of the right edge when it fits,
// each character inked dark over the fill and light over the track. One segment per run of
// characters alike.
export function barSegments(bar: Bar, width: number, dim: boolean): Segment[] {
  // any work done shows: a non-zero fraction fills at least one cell
  const fill = bar.frac > 0 ? Math.max(1, Math.round(bar.frac * width)) : 0
  // own keys only: an inherited name ("constructor") is no tone
  const tone = (!dim && Object.hasOwn(TONES, bar.tone) ? TONES[bar.tone] : TONES.dim) as number
  const text = bar.text.slice(0, width)
  const line = (text.length + 2 <= width ? `${text} ` : text).padStart(width)
  const out: Segment[] = []
  for (let i = 0; i < width; i++) {
    const filled = i < fill
    const last = out.at(-1)
    if (last && last.background === (filled ? tone : BAR_TRACK)) last.text += line[i]
    else out.push({ text: line[i] as string, color: filled ? INK_ON_FILL : INK_ON_TRACK, background: filled ? tone : BAR_TRACK })
  }
  return out
}

function cellSegments(column: Column, value: string | Bar | undefined, dim: boolean): Segment[] {
  if (column.isBar && typeof value === 'object') return barSegments(value, column.width, dim)
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
  clip(join(tab.columns.map(column => cellSegments(column, row.cells[column.key], row.dim))), width)

// stderr's first line with text, its control characters spaces
export function firstLine(text: string): string {
  return text.split('\n').map(line => clean(line).trim()).find(Boolean) ?? ''
}
