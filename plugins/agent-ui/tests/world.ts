import type { FsEntry, On } from 'claude-code'
import type { MockClock } from 'claude-code/testing'
import { mock } from 'claude-code/testing'

export const SID = 'sid-1'
export const NOW = 1_790_000_000_000
export const KIDS = '/fx/children'
export const PANEL = '/fx/repo/.git/.review-panel'
export const STATE = '/fx/home/state'
export const GIT_CONFIG = { '/fx/repo/.git/config': '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n' }

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
  ...under(`${KIDS}/c-dead`, run('claude', '103')),
  ...under(`${KIDS}/d-foreign`, run('openai', '104', 'sid-other')),
  ...under(`${KIDS}/e-failed`, { ...run('openai', '105'), done: '', 'exit-code': '1', 'end-epoch': epoch(2) }),
  ...under(`${PANEL}/0123abcdef/code`, run('claude', '106')),
  '/fx/repo/.agent/local.env': 'state_dir=~/state\n',
  ...GIT_CONFIG,
}

export const ALIVE = ['101', '106']

export type World = {
  files: Record<string, string>
  alive: Set<string>
  reads: string[]
  clock: MockClock
  mtimes: Record<string, number>
  agents: { id: string; description: string; type: string; status: string; parentId?: string }[]
  transcripts: Record<string, { role: 'user' | 'assistant'; text: string; toolUses: [] }[]>
  filled: string[]
  modes: string[]
  lists: string[]
  blits: { key: string; rgba: string }[]
  // the pane is "mounted" for blits only when a test says so; otherwise a blit is denied, as after unmount
  blitOk: boolean
  invalidated: number
  // set: an invalidate draws the mounted pane again, as the engine does; off, it is only counted
  redraws: boolean
  // each tail run: its -c argument and path
  tails: string[]
  denied: number
  // the session cwd and project root; `git` succeeds only inside a repo dir and every run is counted
  cwd: string
  root: string
  repos: Set<string>
  gitRuns: number
  // each repo-panel command run, and what it answers: a result, or a deny (the call rejects, as on a timeout)
  panelRuns: { argv: readonly string[]; cwd?: string; stdin?: string; timeoutMs?: number }[]
  panel: (argv: readonly string[]) => PanelResult | Promise<PanelResult>
  // each ask text a dismiss-ask.pl run dropped
  dismissed: string[]
}

export type PanelResult = { exitCode?: number; stdout?: string; stderr?: string; deny?: string }

// Answers the nouns beneath the plugin from `files`: no disk, no processes, no waits.
// The test mutates the returned world (files, alive pids) to stage a change.
export function world(
  on: On,
  files: Record<string, string>,
  alive: readonly string[] = ALIVE,
  fixtures: { mtimes?: Record<string, number>; agents?: World['agents']; transcripts?: World['transcripts'] } = {},
): World {
  mock.env(on, { HOME: '/fx/home' })
  const clock = mock.clock(on, { now: NOW })
  const w: World = {
    files: { ...files }, alive: new Set(alive), reads: [], clock,
    mtimes: fixtures.mtimes ?? {}, agents: fixtures.agents ?? [], transcripts: fixtures.transcripts ?? {}, filled: [], modes: [], lists: [], blits: [], blitOk: false, denied: 0, invalidated: 0, redraws: false, tails: [],
    cwd: '/fx/repo', root: '/fx/repo', repos: new Set(['/fx/repo']), gitRuns: 0,
    panelRuns: [], dismissed: [], panel: argv => ({ deny: `no answer staged for ${argv.join(' ')}` }),
  }
  on('session.cwd', () => ({ value: w.cwd }))
  on('session.root', () => ({ value: w.root }))
  on('session.id', () => ({ value: SID }))
  on('agent.list', () => ({ value: w.agents }))
  on('session.messages', ($, e) => ({ value: w.transcripts[e.agentId ?? ''] ?? [] }))
  on('ui.blit', ($, e) => {
    if (!w.blitOk) {
      w.denied++
      return { value: { deny: 'not mounted' } }
    }
    if ('source' in e && 'rgba' in e.source) w.blits.push({ key: e.key, rgba: e.source.rgba })
    return { value: {} }
  })
  on('ui.invalidate', ($, e, next) => {
    w.invalidated++
    return w.redraws ? next(e) : { value: undefined }
  })
  on('prompt.fill', ($, e) => {
    w.filled.push(e.text)
    w.modes.push(String(e.mode))
    return { isFilled: true }
  })
  on('fs.read', ($, e) => {
    w.reads.push(e.path)
    const text = w.files[e.path]
    if (text === undefined) return { deny: `ENOENT: ${e.path}` }
    return { value: text }
  })
  on('fs.list', ($, e) => {
    w.lists.push(e.path)
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
  on('process.run', async ($, e) => {
    const [command, ...args] = e.argv
    const ok = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (command === 'git') {
      w.gitRuns++
      const dir = e.init?.cwd ?? w.cwd
      return w.repos.has(dir) ? ok(`${dir}/.git\n`) : ok('', 128)
    }
    if (command === 'ps') return ok((args.at(-1) ?? '').split(',').filter(pid => w.alive.has(pid)).join('\n'))
    if (command === 'tail') {
      const text = w.files[args.at(-1) ?? '']
      if (text === undefined || args[0] !== '-c') return ok('', 1)
      w.tails.push(`${args[1]} ${args.at(-1)}`)
      const from = args[1] ?? ''
      return ok(from.startsWith('+') ? text.slice(Number(from.slice(1)) - 1) : text.slice(-Number(from)))
    }
    // dismiss-ask.pl, as its own test (dismiss-ask.test.sh) shows it: drop the lines with the
    // text, renumber the later detail files.
    if (command === 'perl' && args[0]?.endsWith('/scripts/dismiss-ask.pl')) {
      const [, asks = '', text = ''] = args
      w.dismissed.push(text)
      const lines = (w.files[asks] ?? '').split('\n').slice(0, -1)
      const kept: string[] = []
      lines.forEach((line, i) => {
        const from = `${asks}.d/${i + 1}.md`
        const detail = w.files[from]
        delete w.files[from]
        if (line.trim() === text) return
        kept.push(line)
        if (detail !== undefined) w.files[`${asks}.d/${kept.length}.md`] = detail
      })
      w.files[asks] = kept.map(line => `${line}\n`).join('')
      return ok('')
    }
    if (command === 'acme-panel') {
      w.panelRuns.push({ argv: e.argv, ...e.init })
      const result = await w.panel(e.argv)
      if (result.deny) return { deny: result.deny }
      return { value: { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    throw new Error(`unexpected command ${command}`)
  })
  return w
}
