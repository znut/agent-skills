import type { RunKind, RunStatus } from '../types'

export const TAIL_LINES = 40

export function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path
}

export function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut <= 0 ? '/' : trimmed.slice(0, cut)
}

export function kindOf(provider: string, isPanel: boolean): RunKind {
  if (provider === 'openai' || provider === 'codex') return 'gpt'
  if (provider === 'claude') return isPanel ? 'claude-panel' : 'claude'
  return 'kimi'
}

export function labelOf(dir: string, isPanel: boolean): string {
  if (isPanel) return `rev ${baseName(parentDir(dir)).slice(0, 8)}/${baseName(dir)}`
  return baseName(dir).replace(/^kimi-/, '')
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
