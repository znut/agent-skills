import type { FsEntry, On } from 'claude-code'
import type { MockClock } from 'claude-code/testing'
import { mock } from 'claude-code/testing'

export const SID = 'sid-1'
export const NOW = 1_790_000_000_000
export const KIDS = '/fx/tmp/ez-opd/kimi-children'
export const PANEL = '/fx/repo/.git/.review-panel'
export const STATE = '/fx/home/state'

export const epoch = (minutesAgo: number) => String(Math.floor(NOW / 1000) - minutesAgo * 60)

export const run = (provider: string, pid: string, owner = SID): Record<string, string> => ({
  pid,
  provider,
  model: provider === 'openai' ? 'sol' : 'opus',
  'start-epoch': epoch(5),
  'owner-session': owner,
})

export function under(dir: string, files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([name, text]) => [`${dir}/${name}`, text]))
}

const CODEX_EVENTS = [
  { type: 'item.completed', item: { type: 'agent_message', text: 'hello from codex' } },
  { type: 'item.completed', item: { type: 'command_execution', command: "/bin/bash -lc 'git status'", exit_code: 0 } },
]
  .map(event => JSON.stringify(event))
  .join('\n')

// Runs: a-run live, b-done finished, c-dead gone without done, d-foreign another
// session's, e-failed non-zero exit, plus one
// live claude review panel.
export const RUN_FILES: Record<string, string> = {
  ...under(`${KIDS}/a-run`, { ...run('openai', '101'), 'result.jsonl': CODEX_EVENTS }),
  ...under(`${KIDS}/b-done`, {
    ...run('openai', '102'),
    done: '',
    'exit-code': '0',
    'end-epoch': epoch(1),
    'last-message': 'All green.',
  }),
  ...under(`${KIDS}/c-dead`, run('kimi', '103')),
  ...under(`${KIDS}/d-foreign`, run('openai', '104', 'sid-other')),
  ...under(`${KIDS}/e-failed`, { ...run('openai', '105'), done: '', 'exit-code': '1', 'end-epoch': epoch(2) }),
  ...under(`${PANEL}/0123abcdef/code`, run('claude', '106')),
  '/fx/repo/.agent/orchestrate.local.md': '- `session_bus_dir`: `~/state/bus` (peer inboxes)\n',
}

export const ALIVE = ['101', '106']

export type World = {
  files: Record<string, string>
  alive: Set<string>
  reads: string[]
  clock: MockClock
  mtimes: Record<string, number>
  agents: { id: string; description: string; type: string; status: string }[]
  transcripts: Record<string, { role: 'user' | 'assistant'; text: string; toolUses: [] }[]>
  filled: string[]
}

// Answers the nouns beneath the plugin from `files`: no disk, no processes, no waits.
// The test mutates the returned world (files, alive pids) to stage a change.
export function world(
  on: On,
  files: Record<string, string>,
  alive: readonly string[] = ALIVE,
  fixtures: { mtimes?: Record<string, number>; agents?: World['agents']; transcripts?: World['transcripts'] } = {},
): World {
  mock.env(on, { TMPDIR: '/fx/tmp/', HOME: '/fx/home' })
  const clock = mock.clock(on, { now: NOW })
  const w: World = {
    files: { ...files }, alive: new Set(alive), reads: [], clock,
    mtimes: fixtures.mtimes ?? {}, agents: fixtures.agents ?? [], transcripts: fixtures.transcripts ?? {}, filled: [],
  }
  on('session.id', () => ({ value: SID }))
  on('agent.list', () => ({ value: w.agents }))
  on('session.messages', ($, e) => ({ value: w.transcripts[e.agentId ?? ''] ?? [] }))
  on('prompt.fill', ($, e) => {
    w.filled.push(e.text)
    return { isFilled: true }
  })
  on('fs.read', ($, e) => {
    w.reads.push(e.path)
    const text = w.files[e.path]
    if (text === undefined) return { deny: `ENOENT: ${e.path}` }
    return { value: text }
  })
  on('fs.list', ($, e) => {
    const seen = new Map<string, FsEntry>()
    for (const [path, text] of Object.entries(w.files)) {
      if (!path.startsWith(`${e.path}/`)) continue
      const [name = '', ...rest] = path.slice(e.path.length + 1).split('/')
      const kind = rest.length > 0 ? 'dir' : 'file'
      const old = seen.get(name)
      seen.set(name, {
        name,
        kind,
        size: kind === 'file' ? text.length : 0,
        mtimeMs: Math.max(old?.mtimeMs ?? 0, w.mtimes[path] ?? 0),
        isLink: false,
      })
    }
    if (seen.size === 0) return { deny: `ENOENT: ${e.path}` }
    return { value: [...seen.values()] }
  })
  on('process.run', ($, e) => {
    const [command, ...args] = e.argv
    const ok = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (command === 'git') return ok('/fx/repo/.git\n')
    if (command === 'ps') return ok((args.at(-1) ?? '').split(',').filter(pid => w.alive.has(pid)).join('\n'))
    if (command === 'tail') {
      const text = w.files[args.at(-1) ?? '']
      if (text === undefined || args[0] !== '-c') return ok('', 1)
      return ok(text.slice(-Number(args[1])))
    }
    throw new Error(`unexpected command ${command}`)
  })
  return w
}
