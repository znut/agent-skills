import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, PluginOptions, Register } from 'claude-code'

import type { OpenAsk, Run } from '../types'
import {
  TAIL_LINES,
  busStateDir,
  codexTail,
  elapsed,
  epochMs,
  kindOf,
  labelOf,
  lines,
  resultJsonMessage,
  statusOf,
} from './lib'

type $ = EngineInterface
type Root = { dir: string; isPanel: boolean }
type Tail = { lines: string[]; lastMessage: string }
type Probe = { run: Run; pid: string; hasDone: boolean; exitCode: string; changedAt: number }

const REFRESH_MS = 3000
const MAX_AGE_MS = 12 * 3_600_000
const MAX_ROWS = 30
const TAIL_BYTES = 262_144

// Probes keyed by the out-dir's listing (names + newest file mtime): a resume that
// removes `done`, or a new owner stamp, changes the key and forces a re-probe.
const probes = new Map<string, { key: string; probe: Probe | null }>()
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

async function tailBytes($: $, path: string): Promise<string> {
  const ran = await $.process.run(['tail', '-c', String(TAIL_BYTES), path]).catch(() => null)
  return ran?.exitCode === 0 ? ran.stdout : ''
}

async function gitCommonDir($: $): Promise<string | null> {
  const ran = await $.process
    .run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    .catch(() => null)
  return ran?.exitCode === 0 ? ran.stdout.trim() : null
}

async function resolveRoots($: $, options: PluginOptions): Promise<Root[]> {
  if (roots) return roots
  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
  const runtime = (await $.env.get('EZOPD_RUNTIME_DIR')) || `${tmp}/ez-opd`
  const children = String(options.childrenDir ?? '') || `${runtime}/kimi-children`
  const common = await gitCommonDir($)
  roots = [{ dir: children, isPanel: false }, ...(common ? [{ dir: `${common}/.review-panel`, isPanel: true }] : [])]
  return roots
}

async function runDirs($: $, root: Root): Promise<string[]> {
  const top = (await listDir($, root.dir)).filter(entry => entry.kind === 'dir').map(entry => `${root.dir}/${entry.name}`)
  if (!root.isPanel) return top
  const nested = await Promise.all(
    top.map(async shaDir =>
      (await listDir($, shaDir)).filter(entry => entry.kind === 'dir').map(entry => `${shaDir}/${entry.name}`),
    ),
  )
  return nested.flat()
}

async function probe($: $, dir: string, entries: FsEntry[], isPanel: boolean, sid: string): Promise<Probe | null> {
  const names = new Map(entries.map(entry => [entry.name, entry]))
  const pidEntry = names.get('pid')
  if (!pidEntry) return null
  const field = (name: string) => (names.has(name) ? readText($, `${dir}/${name}`) : Promise.resolve(''))
  const [owner, pid, provider, model, start, end, exitCode] = await Promise.all([
    field('owner-session'),
    field('pid'),
    field('provider'),
    field('model'),
    field('start-epoch'),
    field('end-epoch'),
    field('exit-code'),
  ])
  if (owner !== '' && sid !== '' && owner !== sid) return null
  const hasDone = names.has('done')
  const startedAt = epochMs(start) ?? (pidEntry.mtimeMs || null)
  // end-epoch survives a resume; only a present `done` makes it this run's end.
  const endedAt = hasDone ? (epochMs(end) ?? (names.get('done')?.mtimeMs || null)) : null
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
  const found: Probe[] = []
  for (const root of await resolveRoots($, options)) {
    for (const dir of await runDirs($, root)) {
      const entries = await listDir($, dir)
      const key = entries
        .map(entry => entry.name)
        .sort()
        .concat(String(Math.max(0, ...entries.map(entry => entry.mtimeMs))))
        .join('/')
      let cached = probes.get(dir)
      if (cached?.key !== key) {
        cached = { key, probe: await probe($, dir, entries, root.isPanel, sid) }
        probes.set(dir, cached)
      }
      if (cached.probe) found.push(cached.probe)
    }
  }
  const alive = await alivePids($, found.filter(one => !one.hasDone).map(one => one.pid))
  const rows: Run[] = []
  for (const one of found) {
    const run = { ...one.run, status: statusOf(one.hasDone, one.exitCode, alive.has(one.pid)) }
    if (run.status === 'running') rows.push(run)
    else if (now - one.changedAt <= MAX_AGE_MS) rows.push(run)
    // finished or dead past the age limit: settle so later ticks skip the reads
    else probes.set(run.dir, { key: probes.get(run.dir)?.key ?? '', probe: null })
  }
  const rank = (run: Run) => (run.status === 'running' ? 0 : 1)
  return rows
    .sort((a, b) => rank(a) - rank(b) || (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, MAX_ROWS)
}

function runElapsed(run: Run, now: number): string {
  return run.startedAt === null ? '?' : elapsed((run.endedAt ?? now) - run.startedAt)
}

// GPT runs stream codex events to result.jsonl; Claude and Kimi runs only stderr.log.
async function readTail($: $, run: Run): Promise<Tail> {
  const names = new Set((await listDir($, run.dir)).map(entry => entry.name))
  const tail = names.has('result.jsonl')
    ? codexTail(await tailBytes($, `${run.dir}/result.jsonl`))
    : names.has('stderr.log')
      ? lines(await tailBytes($, `${run.dir}/stderr.log`)).slice(-TAIL_LINES)
      : []
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
  const configured = String(options.stateDir ?? '')
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

const isSameAsk = (open: OpenAsk | null, ask: Ask) => open?.n === ask.n && open.text === ask.text

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'workers',
      description: "Open a pane of this session's child runs; click one for its live tail",
    })
    // One tick redraws the pane and the band (each re-reads its files while drawn)
    // and drops an expanded ask whose line is gone, so a later ask at that line opens closed.
    $.clock.every(REFRESH_MS, async () => {
      $.ui.invalidate('ui.render')
      const open = await read($, openAsk)
      if (open === null) return
      const { asks } = await readAsks($, options)
      if (!asks.some(ask => isSameAsk(open, ask))) await update($, openAsk, () => null)
    })

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
    const shown = asks.find(ask => isSameAsk(open, ask))
    const detail = shown ? await readAskDetail($, detailDir, shown.n) : ''

    return (
      <Box flexDirection="column">
        {asks.map(ask => {
          const { n, text } = ask
          const isOpen = ask === shown

          return (
          <Box key={`ask-row-${n}`} flexDirection="column">
            <Button
              key={`ask-${n}`}
              plain
              label={`${isOpen ? '▾' : '▸'} ${text}`}
              onPress={() => update($, openAsk, was => (isSameAsk(was, ask) ? null : { n, text }))}
            />
            {isOpen &&
              (detail ? (
                <Markdown key={`ask-detail-${n}`} text={detail} />
              ) : (
                <Text dimColor>no context recorded</Text>
              ))}
          </Box>
          )
        })}
      </Box>
    )
  })
}
