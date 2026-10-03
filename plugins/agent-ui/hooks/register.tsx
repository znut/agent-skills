import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, FsEntry, PluginOptions, Register } from 'claude-code'

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
  parentDir,
  resultJsonMessage,
  statusOf,
} from './lib'

type $ = EngineInterface
type Root = { dir: string; isPanel: boolean }
type Tail = { lines: string[]; lastMessage: string }
type Probe = { run: Run; pid: string; hasDone: boolean; exitCode: string }
type NativeRun = { id: string; label: string; kind: string; status: Run['status']; model: string }
type Row = { key: string; run: Run | NativeRun; native: boolean }

const REFRESH_MS = 3000
const RECENT_DONE = 5
const LIVE_WINDOW_MS = 24 * 3_600_000
const MAX_ROWS = 30
const TAIL_BYTES = 262_144
const ASK_ACCENT = '#CBA6F7'

// Probes keyed by the out-dir's listing (names + newest file mtime): a resume that
// removes `done`, or a new owner stamp, changes the key and forces a re-probe.
const probes = new Map<string, { key: string; probe: Probe | null }>()
let roots: Root[] | null = null
let stateDir: string | null | undefined
let ghStatusDir: string | null | undefined

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

async function probe($: $, dir: string, entries: FsEntry[], isPanel: boolean, sid: string, now: number): Promise<Probe | null> {
  const names = new Map(entries.map(entry => [entry.name, entry]))
  const pidEntry = names.get('pid')
  if (!pidEntry) return null
  const field = (name: string) => (names.has(name) ? readText($, `${dir}/${name}`) : Promise.resolve(''))
  const [owner, pid, provider, model, fullModel, start, end, exitCode] = await Promise.all([
    field('owner-session'),
    field('pid'),
    field('provider'),
    field('model'),
    field('full-model'),
    field('start-epoch'),
    field('end-epoch'),
    field('exit-code'),
  ])
  if (owner !== '' && sid !== '' && owner !== sid) return null
  const lastMtime = Math.max(0, ...entries.map(entry => entry.mtimeMs))
  const startMs = epochMs(start)
  if (owner === '' && (lastMtime || startMs) && now - (lastMtime || startMs || 0) > LIVE_WINDOW_MS) return null
  const evidence = names.has('result.jsonl') ? 'codex-events' : fullModel
  const inferred = kindOf(provider, isPanel, evidence)
  const providerLabel = provider || (inferred === 'gpt' ? 'gpt' : '?')
  const modelLabel = model || fullModel.replace(/^gpt-/, '') || '?'
  const hasDone = names.has('done')
  const startedAt = startMs ?? (pidEntry.mtimeMs || null)
  const endedAt = epochMs(end) ?? (lastMtime || null)
  return {
    pid,
    hasDone,
    exitCode,
    run: {
      dir,
      kind: inferred,
      label: labelOf(dir, isPanel),
      model: [providerLabel, modelLabel].join('/'),
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
  const seen = new Set<string>()
  for (const root of await resolveRoots($, options)) {
    for (const dir of await runDirs($, root)) {
      seen.add(dir)
      const entries = await listDir($, dir)
      const key = entries
        .map(entry => entry.name)
        .sort()
        .concat(String(Math.max(0, ...entries.map(entry => entry.mtimeMs))))
        .join('/')
      let cached = probes.get(dir)
      if (cached?.key !== key) {
        cached = { key, probe: await probe($, dir, entries, root.isPanel, sid, now) }
        probes.set(dir, cached)
      }
      if (cached.probe) found.push(cached.probe)
    }
  }
  for (const dir of probes.keys()) if (!seen.has(dir)) probes.delete(dir)
  // older runs without `done` read as dead: bounds the ps list and ignores reused pids
  const recent = (one: Probe) => now - (one.run.startedAt ?? 0) <= LIVE_WINDOW_MS
  const alive = await alivePids($, found.filter(one => !one.hasDone && recent(one)).map(one => one.pid))
  const running: Run[] = []
  const done: Run[] = []
  for (const one of found) {
    const run = { ...one.run, status: statusOf(one.hasDone, one.exitCode, recent(one) && alive.has(one.pid)) }
    ;(run.status === 'running' ? running : done).push(run)
  }
  const when = (run: Run) => run.endedAt ?? run.startedAt ?? 0
  done.sort((a, b) => when(b) - when(a))
  running.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  return [...running, ...done]
}

function runElapsed(run: Run, now: number): string {
  return run.startedAt === null ? '?' : elapsed(((run.status === 'running' ? now : run.endedAt) ?? now) - run.startedAt)
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

async function readNativeTail($: $, run: NativeRun): Promise<Tail> {
  const messages = await $.session.messages({ agentId: run.id }).catch(() => [])
  if (!Array.isArray(messages)) return { lines: [], lastMessage: '' }
  const linesOut = messages.flatMap(message => lines(message.text)).slice(-TAIL_LINES)
  return { lines: linesOut, lastMessage: '' }
}

type PrRow = { number: number; title: string; head: string; readyAt: string }
type PrState = { prs: PrRow[]; gates: Map<number, Record<string, unknown> | null> }

async function readReadyPrs($: $, options: PluginOptions, mainSha: string): Promise<PrState> {
  const dir = await resolveGhStatusDir($, options)
  if (!dir) return { prs: [], gates: new Map() }
  const entries = await listDir($, `${dir}/status`)
  const statusFiles = entries.filter(entry => entry.kind === 'file' && /^pr-\d+\.json$/.test(entry.name))
  const prs = (await Promise.all(statusFiles.map(async entry => {
    const value = jsonObject(await readText($, `${dir}/status/${entry.name}`))
    if (!value || value.state !== 'OPEN' || value.isDraft !== false || typeof value.number !== 'number') return null
    return {
      number: value.number,
      title: typeof value.title === 'string' ? value.title : '',
      head: typeof value.headOid === 'string' ? value.headOid : '',
      readyAt: String(value.approvedAt ?? value.readyAt ?? value.createdAt ?? value.updatedAt ?? ''),
    }
  }))).filter((pr): pr is PrRow => pr !== null)
  prs.sort((a, b) => a.readyAt.localeCompare(b.readyAt) || a.number - b.number)
  const gates = new Map<number, Record<string, unknown> | null>()
  await Promise.all(prs.map(async pr => {
    const path = `${parentDir(dir)}/gate/pr-${pr.number}/${pr.head.slice(0, 8)}-${mainSha.slice(0, 8)}.json`
    gates.set(pr.number, jsonObject(await readText($, path)))
  }))
  return { prs, gates }
}

async function readMainStrip($: $, options: PluginOptions): Promise<{ sha: string; state: string; queue: number } | null> {
  const ghDir = await resolveGhStatusDir($, options)
  if (!ghDir) return null
  const root = parentDir(ghDir)
  const [stateText, log] = await Promise.all([readText($, `${root}/main-ci/state.json`), readText($, `${root}/main-ci/run.log`)] )
  const state = jsonObject(stateText)
  if (!state || typeof state.sha !== 'string' || log === '') return null
  const main8 = state.sha.slice(0, 8)
  const linesIn = log.split('\n')
  const active = new Map<string, boolean>()
  for (const line of linesIn) {
    if (line.includes(`-${main8}: queued`)) {
      const match = /preview #\d+ ([0-9a-f]+)-([0-9a-f]+): queued/.exec(line)
      if (match) active.set(match[0].split(' ')[1].split(':')[0], true)
    } else {
      const match = /preview #\d+ ([0-9a-f]+)-([0-9a-f]+): (?:green|red|conflict)/.exec(line)
      if (match && match[2] === main8) active.delete(`${match[1]}-${match[2]}`)
    }
  }
  return { sha: main8, state: state.green === true ? 'green' : state.phase === 'done' ? 'failed' : String(state.phase ?? 'running'), queue: active.size }
}

function rowsFor(runs: Run[], agents: AgentInfo[]): Row[] {
  const disk = runs.map(run => ({ key: `disk:${run.dir}`, run, native: false }))
  const native = agents.map(asNative).map(run => ({ key: `native:${run.id}`, run, native: true }))
  const all = [...disk, ...native]
  const running = all.filter(row => row.run.status === 'running')
  const finished = all.filter(row => row.run.status !== 'running').sort((a, b) => {
    const at = a.native ? 0 : (a.run as Run).endedAt ?? (a.run as Run).startedAt ?? 0
    const bt = b.native ? 0 : (b.run as Run).endedAt ?? (b.run as Run).startedAt ?? 0
    return bt - at
  })
  return [...running, ...finished.slice(0, RECENT_DONE)].slice(0, MAX_ROWS)
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

async function resolveGhStatusDir($: $, options: PluginOptions): Promise<string | null> {
  if (ghStatusDir !== undefined) return ghStatusDir
  const configured = String(options.stateDir ?? '')
  if (configured) return (ghStatusDir = `${configured.replace(/\/+$/, '')}/gh-status`)
  const common = await gitCommonDir($)
  const main = common?.replace(/\/\.git$/, '')
  const localMd = main ? await readText($, `${main}/.agent/orchestrate.local.md`) : ''
  const match = /^- `gh_status_dir`: `([^`]*)`/m.exec(localMd)
  const value = match?.[1]?.replace(/^~(?=\/|$)/, (await $.env.get('HOME')) ?? '')
  ghStatusDir = value ? value.replace(/\/+$/, '') : null
  return ghStatusDir
}

type Ask = { n: number; text: string }

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function issueNumber(text: string): string | null {
  return /#(\d+)/.exec(text)?.[1] ?? /\/issues\/(\d+)/.exec(text)?.[1] ?? /\/pull\/(\d+)/.exec(text)?.[1] ?? null
}

function trailingLink(text: string): string | null {
  return /https?:\/\/\S+$/.exec(text)?.[0] ?? null
}

function linkLabel(href: string): string {
  const issue = issueNumber(href)
  if (issue) return `#${issue}`
  try {
    const url = new URL(href)
    return url.pathname.split('/').filter(Boolean).at(-1) || url.host
  } catch {
    return href
  }
}

function labeledLine(line: string): { label: string; value: string } | null {
  const match = /^([\p{L}][\p{L} /_-]*):\s*(.*)$/u.exec(line)
  return match ? { label: match[1], value: match[2] } : null
}

function repoSlug(options: PluginOptions): string {
  const configured = String(options.repoSlug ?? '').trim()
  return (configured || 'EZ-OPD/ez-opd-services').replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '')
}

function asNative(agent: AgentInfo): NativeRun {
  const status = agent.status === 'running' ? 'running' : agent.status === 'failed' ? 'failed' : agent.status === 'killed' ? 'dead' : 'done'
  return { id: agent.id, label: agent.description || agent.type, kind: agent.type, status, model: '?' }
}

function askOptions(detail: string): string[] {
  const line = detail.split('\n').find(text => /^options?:/i.test(text.trim()))
  return line ? line.replace(/^options?:/i, '').split(/\s*[|;]\s*/).map(text => text.trim()).filter(Boolean).slice(0, 4) : []
}

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
    const { Box, Text, Button, Markdown, Link } = $.ui.resolve(e)
    const now = await $.clock.now()
    const [runs, agents, main] = await Promise.all([scanRuns($, options, now), $.agent.list().catch(() => []), readMainStrip($, options)])
    const rows = rowsFor(runs, agents)
    const prState = await readReadyPrs($, options, main?.sha ?? '')
    const chosen = await read($, selectedRun)
    const shown = rows.find(row => row.key === chosen) ?? null
    const tail = shown
      ? shown.native
        ? await readNativeTail($, shown.run as NativeRun)
        : await readTail($, shown.run as Run)
      : null
    const repo = repoSlug(options)
    const issueUrl = (n: number) => `https://github.com/${repo}/issues/${n}`

    return (
      <Box flexDirection="column">
        {main && <Text dimColor>{`main ${main.sha} · ${main.state} · preview queue ${main.queue}`}</Text>}
        {prState.prs.length > 0 && (
          <Box key="needs-you" flexDirection="column" marginBottom={1}>
            <Text bold>Needs you</Text>
            {prState.prs.map(pr => {
              const gate = prState.gates.get(pr.number)
              const result = gate === null ? '…' : gate.green === true ? '✓' : '✗'
              return (
                <Box key={`pr:${pr.number}`}>
                  <Link key={`pr-link-${pr.number}`} href={issueUrl(pr.number)} label={`#${pr.number}`} />
                  <Text>{` ${pr.title} ${result}${gate?.conflict === true ? ' ⚡ conflict' : ''}`}</Text>
                </Box>
              )
            })}
          </Box>
        )}
        <Text bold>Workers</Text>
        {rows.length === 0 && <Text dimColor>No child runs for this session.</Text>}
        {rows.map(row => {
          const run = row.run
          const duration = row.native ? '?' : runElapsed(run as Run, now)
          const label = row.native ? (run as NativeRun).label : (run as Run).label
          const kind = row.native ? (run as NativeRun).kind : (run as Run).kind
          return (
          <Button
            key={row.key}
            plain
            dimColor={run.status !== 'running'}
            label={`${MARK[run.status]} ${kind} ${label}  ${run.model}  ${duration}  ${run.status}`}
            onPress={() => update($, selectedRun, key => (key === row.key ? null : row.key))}
          />
          )
        })}
        {shown && tail && (
          <Box key="tail" flexDirection="column" marginTop={1}>
            <Text bold>{`${shown.native ? (shown.run as NativeRun).label : (shown.run as Run).label} (${shown.run.status})`}</Text>
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
    const { Box, Text, Button, Markdown, Link } = $.ui.resolve(e)
    const open = await read($, openAsk)
    const shown = asks.find(ask => isSameAsk(open, ask))
    const detail = shown ? await readAskDetail($, detailDir, shown.n) : ''
    const detailLines = detail.split('\n').filter(line => line.trim() !== '')

    return (
      <Box flexDirection="column">
        {asks.map(ask => (
          <Box key={`ask-row-${ask.n}`} flexDirection="column">
            <Box key={`ask-line-${ask.n}`} flexDirection="row">
              {issueNumber(ask.text) ? (
                <Text color={ASK_ACCENT}>
                  <Link href={`https://github.com/${repoSlug(options)}/issues/${issueNumber(ask.text)}`} label={`#${issueNumber(ask.text)}`} />
                </Text>
              ) : trailingLink(ask.text) ? (
                <Text color={ASK_ACCENT} underline>
                  <Link href={trailingLink(ask.text) ?? ''} label={linkLabel(trailingLink(ask.text) ?? '')} />
                </Text>
              ) : null}
              <Button
                key={`ask-${ask.n}`}
                plain
                label={`${ask === shown ? '▾' : '▸'} ${ask.text.replace(/#\d+\s*/, '').replace(/\s*https?:\/\/\S+$/, '')}`}
                onPress={() => update($, openAsk, was => (isSameAsk(was, ask) ? null : { n: ask.n, text: ask.text }))}
              />
            </Box>
            {ask === shown &&
              (detail ? (
                <Box key={`ask-detail-${ask.n}`} flexDirection="column" marginLeft={2}>
                  <Box key="ask-detail-border" flexDirection="row">
                    <Text color={ASK_ACCENT}>│</Text>
                    <Box flexDirection="column" marginLeft={1}>
                      {detailLines.map((line, i) => {
                        const labeled = labeledLine(line)
                        const link = /^link:\s*(?:<([^>]+)>|(\S+))/i.exec(line.trim())
                        if (link) {
                          const href = link[1] ?? link[2]
                          return (
                            <Text key={`ask-context-${i}`} color={ASK_ACCENT} underline>
                              <Link href={href} label={linkLabel(href)} />
                            </Text>
                          )
                        }
                        if (labeled) {
                          return (
                            <Box key={`ask-context-${i}`} flexDirection="row">
                              <Text dimColor bold>{`${labeled.label}: `}</Text>
                              <Text>{labeled.value}</Text>
                            </Box>
                          )
                        }
                        return <Text key={`ask-context-${i}`}>{line}</Text>
                      })}
                    </Box>
                  </Box>
                  {askOptions(detail).length > 0 && (
                    <Box key="ask-options" flexDirection="row" marginTop={1}>
                      {askOptions(detail).map((option, i) => (
                        <Button
                          key={`ask-option-${ask.n}-${i}`}
                          plain
                          label={option}
                          onPress={() => {
                            const prefix = issueNumber(ask.text) ? `#${issueNumber(ask.text)}` : trailingLink(ask.text) ?? ''
                            return $.prompt.fill({ text: `${prefix} ${option}`.trim(), mode: 'replace' })
                          }}
                        />
                      ))}
                    </Box>
                  )}
                </Box>
              ) : (
                <Text dimColor>no context recorded</Text>
              ))}
          </Box>
        ))}
      </Box>
    )
  })
}
