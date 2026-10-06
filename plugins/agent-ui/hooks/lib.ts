import type { RunStatus } from '../types'

export const TAIL_LINES = 40

// Base64 in 8 KiB slices: one spread of a large array overflows the argument limit.
export function toBase64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(text)
}

export function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path
}

export function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut <= 0 ? '/' : trimmed.slice(0, cut)
}

// The run's `provider` file: openai and codex are gpt, claude is claude; any other value as written.
export function kindOf(provider: string, isPanel: boolean): string {
  if (provider === 'openai' || provider === 'codex') return 'gpt'
  if (provider === 'claude') return isPanel ? 'claude-panel' : 'claude'
  return provider
}

export function labelOf(dir: string, isPanel: boolean): string {
  if (isPanel) return `rev ${baseName(parentDir(dir)).slice(0, 8)}/${baseName(dir)}`
  return baseName(dir)
}

export function statusOf(hasDone: boolean, exitCode: string, isAlive: boolean): RunStatus {
  if (hasDone) return exitCode === '' || exitCode === '0' ? 'done' : 'failed'
  return isAlive ? 'running' : 'dead'
}

export function epochMs(text: string): number | null {
  const seconds = Number.parseInt(text, 10)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
}

export function elapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`
}

export function lines(text: string): string[] {
  return text.split('\n').filter(line => line.trim() !== '')
}

function oneLine(text: string, width = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat
}

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// codex exec --json events: agent messages, finished commands, errors.
export function codexTail(jsonl: string): string[] {
  const out: string[] = []
  for (const line of jsonl.split('\n')) {
    const event = parseJson(line)
    const item = event?.item as Record<string, unknown> | undefined
    if (event?.type === 'item.completed' && item?.type === 'agent_message') {
      out.push(...lines(String(item.text ?? '')))
    } else if (event?.type === 'item.completed' && item?.type === 'command_execution') {
      const command = String(item.command ?? '').replace(/^\S*bash -lc ['"]?/, '')
      out.push(`$ ${oneLine(command, 120)}  (exit ${String(item.exit_code ?? '?')})`)
    } else if (event?.type === 'error' || event?.type === 'turn.failed') {
      out.push(`error: ${oneLine(JSON.stringify(event.error ?? event.message ?? ''))}`)
    }
  }
  return out.slice(-TAIL_LINES)
}

// claude -p --output-format json writes one object; its `result` is the final message.
export function resultJsonMessage(text: string): string {
  const result = parseJson(text)?.result
  return typeof result === 'string' ? result : ''
}

export function busStateDir(localMd: string, home: string): string | null {
  const match = /^- `session_bus_dir`: `([^`]*)`/m.exec(localMd)
  if (!match?.[1]) return null
  return parentDir(match[1].replace(/^~(?=\/|$)/, home))
}

// main-ci's run.log, replayed a chunk of lines at a time: the previews still queued or running
// (a PR's entry ends with its result, a cancel, or a head move; the last two carry no sha
// pair), and each run cancelled because the tip moved (`<ts> cancel run sha=<sha>`).
export type RunLog = { previews: Map<number, { main: string; state: 'queued' | 'running' }>; cancels: { sha8: string; at: string }[] }

export const freshRunLog = (): RunLog => ({ previews: new Map(), cancels: [] })

export function applyRunLog(log: RunLog, text: string): void {
  for (const line of text.split('\n')) {
    const cancel = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)\S* cancel run sha=([0-9a-f]{8})/.exec(line)
    if (cancel) {
      const [, y, mo, d, h, mi, s, sha8 = ''] = cancel
      log.cancels.push({ sha8, at: `${y}${mo}${d}T${h}${mi}${s}` })
      continue
    }
    const match = /preview #(\d+)(?: [0-9a-f]+-([0-9a-f]+))?: (queued|start|green|red|conflict|cancelled|head moved)/i.exec(line)
    if (!match) continue
    const [, pr = '', main, event = ''] = match
    if (/^(queued|start)$/i.test(event)) {
      if (main) log.previews.set(Number(pr), { main, state: /^start$/i.test(event) ? 'running' : 'queued' })
    } else log.previews.delete(Number(pr))
  }
}

export function previewQueue(log: RunLog, main8: string): { running: number; queued: number } {
  const current = [...log.previews.values()].filter(entry => entry.main === main8)
  return { running: current.filter(entry => entry.state === 'running').length, queued: current.filter(entry => entry.state === 'queued').length }
}
