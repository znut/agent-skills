import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, PluginOptions, Register } from 'claude-code'

import type { Run } from '../types'
import {
  TAIL_LINES,
  busStateDir,
  codexTail,
  elapsed,
  epochMs,
  kindOf,
  labelOf,
  lines,
  projectSlug,
  resultJsonMessage,
  statusOf,
  transcriptTail,
} from './lib'

type $ = EngineInterface
type Root = { dir: string; isPanel: boolean }

type Tail = { lines: string[]; lastMessage: string }

const MAX_ROWS = 30
const TAIL_READ = 200

// Settled out-dirs (finished, foreign or too old) never change: skip them on later scans.
const settled = new Map<string, Run | null>()
const settledShas = new Map<string, string[]>()
let roots: Root[] | null = null
let stateDir: string | null | undefined

async function readText($: $, path: string): Promise<string> {
  return $.fs.read(path).then(
    text => (typeof text === 'string' ? text.trim() : ''),
    () => '',
  )
}

async function listDir($: $, path: string): Promise<FsEntry[]> {
  return $.fs.list(path).catch(() => [])
}

async function tailFile($: $, path: string, count: number): Promise<string> {
  const ran = await $.process.run(['tail', '-n', String(count), path]).catch(() => null)
  return ran?.exitCode === 0 ? ran.stdout : ''
}

async function gitCommonDir($: $): Promise<string | null> {
  const ran = await $.process
    .run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    .catch(() => null)
  return ran?.exitCode === 0 ? ran.stdout.trim() : null
}

async function tmpDir($: $): Promise<string> {
  return ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
}

async function resolveRoots($: $, options: PluginOptions): Promise<Root[]> {
  if (roots) return roots
  const tmp = await tmpDir($)
  const runtime = (await $.env.get('EZOPD_RUNTIME_DIR')) || `${tmp}/ez-opd`
  const children = String(options.childrenDir ?? '') || `${runtime}/kimi-children`
  let panels = String(options.panelDirs ?? '')
    .split(',')
    .map(dir => dir.trim())
    .filter(Boolean)
  if (panels.length === 0) {
    const common = await gitCommonDir($)
    panels = [...(common ? [`${common}/.review-panel`] : []), `${tmp}/review-panel`]
  }
  roots = [{ dir: children, isPanel: false }, ...panels.map(dir => ({ dir, isPanel: true }))]
  return roots
}

async function runDirs($: $, root: Root): Promise<string[]> {
  const top = (await listDir($, root.dir)).filter(entry => entry.kind === 'dir')
  if (!root.isPanel) return top.map(entry => `${root.dir}/${entry.name}`)
  const nested = await Promise.all(
    top.map(async sha => {
      const shaDir = `${root.dir}/${sha.name}`
      const cached = settledShas.get(shaDir)
      if (cached) return cached
      const focuses = (await listDir($, shaDir)).filter(entry => entry.kind === 'dir')
      const dirs = focuses.map(entry => `${shaDir}/${entry.name}`)
      if (dirs.length > 0 && dirs.every(dir => settled.has(dir))) settledShas.set(shaDir, dirs)
      return dirs
    }),
  )
  return nested.flat()
}

type Probe = { run: Run; pid: string; hasDone: boolean; exitCode: string; changedAt: number }

async function probe($: $, dir: string, isPanel: boolean, sid: string): Promise<Probe | null> {
  const entries = await listDir($, dir)
  const names = new Map(entries.map(entry => [entry.name, entry]))
  const pidEntry = names.get('pid')
  if (!pidEntry) {
    if (names.has('native') || names.has('done')) settled.set(dir, null)
    return null
  }
  const owner = names.has('owner-session') ? await readText($, `${dir}/owner-session`) : ''
  if (owner !== '' && sid !== '' && owner !== sid) {
    settled.set(dir, null)
    return null
  }
  const field = (name: string) => (names.has(name) ? readText($, `${dir}/${name}`) : Promise.resolve(''))
  const [pid, provider, model, start, end, exitCode] = await Promise.all([
    field('pid'),
    field('provider'),
    field('model'),
    field('start-epoch'),
    field('end-epoch'),
    field('exit-code'),
  ])
  const hasDone = names.has('done')
  const startedAt = epochMs(start) ?? (pidEntry.mtimeMs || null)
  const endedAt = epochMs(end) ?? (hasDone ? names.get('done')?.mtimeMs || null : null)
  return {
    pid,
    hasDone,
    exitCode,
    changedAt: endedAt ?? startedAt ?? 0,
    run: {
      dir,
      kind: kindOf(provider, isPanel),
      label: labelOf(dir, isPanel),
      model: [provider || '?', model || '?'].join('/'),
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
  const maxAgeMs = Number(options.maxAgeHours ?? 12) * 3_600_000
  const rows: Run[] = []
  const probes: Probe[] = []
  for (const root of await resolveRoots($, options)) {
    for (const dir of await runDirs($, root)) {
      if (settled.has(dir)) {
        const kept = settled.get(dir)
        if (kept && now - (kept.endedAt ?? 0) <= maxAgeMs) rows.push(kept)
        continue
      }
      const found = await probe($, dir, root.isPanel, sid)
      if (found) probes.push(found)
    }
  }
  const alive = await alivePids($, probes.filter(one => !one.hasDone).map(one => one.pid))
  for (const one of probes) {
    const run = { ...one.run, status: statusOf(one.hasDone, one.exitCode, alive.has(one.pid)) }
    const isOld = now - one.changedAt > maxAgeMs
    if (run.status === 'done' || run.status === 'failed') settled.set(run.dir, isOld ? null : run)
    if (run.status === 'running' || !isOld) rows.push(run)
  }
  const rank = (run: Run) => (run.status === 'running' ? 0 : 1)
  return rows
    .sort((a, b) => rank(a) - rank(b) || (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, MAX_ROWS)
}

function runElapsed(run: Run, now: number): string {
  return run.startedAt === null ? '?' : elapsed((run.endedAt ?? now) - run.startedAt)
}

async function newestTranscript($: $, cwd: string): Promise<string | null> {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`
  const folder = `${config}/projects/${projectSlug(cwd)}`
  const files = (await listDir($, folder)).filter(entry => entry.name.endsWith('.jsonl'))
  const newest = files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  return newest ? `${folder}/${newest.name}` : null
}

async function readTail($: $, run: Run): Promise<Tail> {
  const names = new Set((await listDir($, run.dir)).map(entry => entry.name))
  let tail: string[] = []
  if (names.has('result.jsonl')) {
    tail = codexTail(await tailFile($, `${run.dir}/result.jsonl`, TAIL_READ))
  } else if (run.status === 'running' && names.has('cwd')) {
    const transcript = await newestTranscript($, await readText($, `${run.dir}/cwd`))
    if (transcript) tail = transcriptTail(await tailFile($, transcript, TAIL_READ))
  }
  if (tail.length === 0 && names.has('stderr.log')) {
    tail = lines(await tailFile($, `${run.dir}/stderr.log`, TAIL_LINES))
  }
  let lastMessage = ''
  if (run.status !== 'running') {
    lastMessage = names.has('last-message')
      ? await readText($, `${run.dir}/last-message`)
      : resultJsonMessage(names.has('result.json') ? await readText($, `${run.dir}/result.json`) : '')
  }
  return { lines: tail, lastMessage }
}

async function resolveStateDir($: $, options: PluginOptions): Promise<string | null> {
  if (stateDir !== undefined) return stateDir
  const configured = String(options.stateDir ?? '') || (await $.env.get('AGENT_STATE_DIR')) || ''
  if (configured) return (stateDir = configured.replace(/\/+$/, ''))
  const common = await gitCommonDir($)
  const main = common?.replace(/\/\.git$/, '')
  const localMd = main ? await readText($, `${main}/.agent/orchestrate.local.md`) : ''
  stateDir = busStateDir(localMd, (await $.env.get('HOME')) ?? '')
  return stateDir
}

type Ask = { n: number; text: string }

// `n` is the ask's 1-based line number in the file: its detail file is `<n>.md`.
async function readAsks($: $, options: PluginOptions): Promise<{ asks: Ask[]; detailDir: string }> {
  const [state, sid] = await Promise.all([resolveStateDir($, options), $.session.id()])
  if (!state || !sid) return { asks: [], detailDir: '' }
  const file = `${state}/asks/${sid}`
  const asks = (await readText($, file))
    .split('\n')
    .map((text, i) => ({ n: i + 1, text: text.trim() }))
    .filter(ask => ask.text !== '')
  return { asks, detailDir: `${file}.d` }
}

async function readAskDetail($: $, detailDir: string, n: number): Promise<string> {
  return readText($, `${detailDir}/${n}.md`)
}

const PANE = 'workers'
const selectedRun = atom({ plugin: 'agent-ui', key: 'selectedRun' } as const, null)
const openAsk = atom({ plugin: 'agent-ui', key: 'openAsk' } as const, null)

const MARK = { running: '◐', done: '✓', failed: '✗', dead: '†' } as const

export const register: Register = (on, options) => {
  const periodMs = Math.min(5, Math.max(1, Number(options.refreshSeconds ?? 3))) * 1000

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'workers',
      description: "Open a pane of this session's child runs; click one for its live tail",
    })
    // One redraw tick for the pane and the band: each re-reads its files while drawn.
    $.clock.every(periodMs, () => $.ui.invalidate('ui.render'))

    return next(e)
  })

  on('command.run', { command: 'workers' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Workers' })

    return { text: 'Workers pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const now = await $.clock.now()
    const runs = await scanRuns($, options, now)
    const chosen = await read($, selectedRun)
    const shown = runs.find(run => run.dir === chosen) ?? null
    const tail = shown ? await readTail($, shown) : null

    return (
      <Box flexDirection="column">
        {runs.length === 0 && <Text dimColor>No child runs for this session.</Text>}
        {runs.map(run => (
          <Button
            key={`run:${run.dir}`}
            plain
            dimColor={run.status !== 'running'}
            label={`${MARK[run.status]} ${run.kind} ${run.label}  ${run.model}  ${runElapsed(run, now)}  ${run.status}`}
            onPress={() => update($, selectedRun, dir => (dir === run.dir ? null : run.dir))}
          />
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
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { asks, detailDir } = await readAsks($, options)
    if (asks.length === 0) return next(e)
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const open = await read($, openAsk)
    const isOpen = asks.some(ask => ask.n === open)
    const detail = isOpen && open !== null ? await readAskDetail($, detailDir, open) : ''

    return (
      <Box flexDirection="column">
        {asks.map(({ n, text }) => (
          <Box key={`ask-row-${n}`} flexDirection="column">
            <Button
              key={`ask-${n}`}
              plain
              label={`${open === n ? '▾' : '▸'} ${text}`}
              onPress={() => update($, openAsk, was => (was === n ? null : n))}
            />
            {open === n &&
              (detail ? (
                <Markdown key={`ask-detail-${n}`} text={detail} />
              ) : (
                <Text dimColor>no context recorded</Text>
              ))}
          </Box>
        ))}
      </Box>
    )
  })
}
