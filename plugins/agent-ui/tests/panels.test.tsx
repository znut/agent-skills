import { describe, expect, test } from 'claude-code/testing'

import { TONES, placeBeside } from '../hooks/ci'
import { BAR_TRACK, INK_ON_FILL, INK_ON_TRACK, barSegments, headerSegments, parsePanelOutput, parseSpecs, rowSegments } from '../hooks/panels'
import { GIT_CONFIG, KIDS, type PanelResult, RUN_FILES, STATE, type World, world } from './world'

const CONFIG = '/fx/repo/.agent/pane-panels.json'
const CMD = ['acme-panel', 'report', '--json']
const SPECS = [{ id: 'acme', title: 'Acme', cmd: CMD, refresh_s: 30 }]

const OUTPUT = {
  summary: 'north  alpha 75%',
  tab: 'north',
  tabs: [
    {
      id: 'north',
      label: 'north',
      columns: [
        { key: 'name', label: 'name', width: 8 },
        { key: 'n', label: 'n', width: 3, align: 'right' },
        { key: 'pass', label: 'pass', width: 10, kind: 'bar' },
      ],
      rows: [
        { id: 'r1', cells: { name: 'alpha', n: '9', pass: { frac: 0.75, text: '75%', tone: 'good' } }, hover: ['alpha · north', 'pass 6 / fail 2'] },
        { id: 'r2', dim: true, cells: { name: 'beta-long-name', n: '12', pass: { frac: 0.25, text: '25%', tone: 'bad' } }, hover: ['beta · pooled'] },
      ],
      note: 'dim = few runs',
    },
    { id: 'south', label: 'south', columns: [{ key: 'name', label: 'name', width: 8 }], rows: [{ id: 's1', cells: { name: 'gamma' } }] },
  ],
}

const ok = (output: unknown = OUTPUT): PanelResult => ({ stdout: JSON.stringify(output) })

const PANE = (bodyColumns = 60, bodyRows = 40, surface: 'terminal' | 'desktop' = 'terminal') => ({
  plugin: 'agent-ui',
  component: 'Pane',
  requestId: 'workers',
  surface,
  props: { title: 'Workers', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
} as const)

// The drawn tree in document order; `find` leaves out an element's hover, the tree keeps it.
type Drawn = { type?: string; props?: Record<string, unknown>; hover?: { scope?: string; display?: string; backgroundColor?: string }; children?: unknown[] }
const walk = (node: unknown, out: Drawn[] = []): Drawn[] => {
  if (typeof node !== 'object' || node === null) return out
  out.push(node as Drawn)
  for (const child of (node as Drawn).children ?? []) walk(child, out)
  return out
}
const textOf = (node: unknown): string =>
  typeof node === 'string' ? node : typeof node === 'object' && node !== null ? ((node as Drawn).children ?? []).map(textOf).join('') : ''
const keyed = (all: Drawn[], key: string) => all.find(node => node.props?.key === key)
const plain = (segments: { text: string }[]) => segments.map(segment => segment.text).join('')

// The test's world: a render only schedules panel runs, on a 1 ms module timer
let current: World

function setup(on: Parameters<typeof world>[0], answer: () => PanelResult | Promise<PanelResult> = () => ok()) {
  const w = world(on, { ...GIT_CONFIG, [CONFIG]: JSON.stringify(SPECS) }, [])
  w.panel = answer
  w.redraws = true
  current = w
  return w
}

// Mounts, then lets the panel timer the render set fire: the runs it starts land and redraw.
async function shown<T>(mounting: Promise<T>): Promise<T> {
  const ui = await mounting
  await current.clock.advance(1)
  return ui
}

describe('repo panels', () => {
  test('no pane-panels.json: no panel and no command run', async ($, on) => {
    const w = world(on, GIT_CONFIG, [])
    current = w
    const ui = await shown($.ui.mount(PANE()))
    expect(await ui.find({ key: 'panel:acme' })).toBeUndefined()
    expect(w.panelRuns).toHaveLength(0)
    await ui.unmount()
  })

  test('the list skips entries without an id or an argv; refresh defaults to 60 s, never under 5 s', () => {
    const specs = parseSpecs(JSON.stringify([
      { id: 'acme', cmd: ['acme-panel'] },
      { id: 'fast', title: 'Fast', cmd: ['acme-panel', 'fast'], refresh_s: 1 },
      { id: 'no-cmd' },
      { id: 'shell', cmd: 'acme-panel --json' },
      { cmd: ['acme-panel'] },
      { id: 'acme', cmd: ['acme-panel', 'again'] },
    ]))
    expect(specs).toEqual([
      { id: 'acme', title: 'acme', cmd: ['acme-panel'], refreshMs: 60_000 },
      { id: 'fast', title: 'Fast', cmd: ['acme-panel', 'fast'], refreshMs: 5_000 },
    ])
    expect(parseSpecs('{"id":"acme"}')).toEqual([])
    expect(parseSpecs('not json')).toEqual([])
  })

  test('collapsed: the summary runs by argv in the repo root with stdin closed and a 10 s limit, again only after refresh_s', async ($, on) => {
    const w = setup(on)
    const ui = await shown($.ui.mount(PANE()))
    expect((await ui.find({ key: 'panel:acme' }))?.text).toBe('▸ Acme  north  alpha 75%')
    expect(w.panelRuns).toEqual([{ argv: CMD, cwd: '/fx/repo', stdin: '', timeoutMs: 10_000 }])
    expect(await ui.find({ key: 'panel-columns' })).toBeUndefined()
    await ui.unmount()
    await w.clock.advance(29_000)
    const early = await shown($.ui.mount(PANE()))
    await early.unmount()
    expect(w.panelRuns).toHaveLength(1)
    w.panel = () => ok({ ...OUTPUT, summary: 'north  alpha 80%' })
    await w.clock.advance(1_000)
    const due = await shown($.ui.mount(PANE()))
    expect(w.panelRuns).toHaveLength(2)
    expect((await due.find({ key: 'panel:acme' }))?.text).toBe('▸ Acme  north  alpha 80%')
    await due.unmount()
  })

  test('a render never waits for a panel: a run that never ends leaves the strip and workers drawn; an end redraws', async ($, on) => {
    const w = world(on, {
      ...RUN_FILES,
      '/fx/repo/.agent/orchestrate.local.md': '- `session_bus_dir`: `~/state/bus`\n- `gh_status_dir`: `~/state/gh-status`\n',
      [`${STATE}/main-ci/state.json`]: JSON.stringify({ sha: 'cafe0001aaaa', green: true, phase: 'done' }),
      [CONFIG]: JSON.stringify(SPECS),
    })
    let release = () => {}
    w.panel = () => new Promise(done => { release = () => done(ok()) })
    const ui = await $.ui.mount(PANE())
    await w.clock.advance(1)
    expect(w.panelRuns).toHaveLength(1)
    expect((await ui.find({ key: 'main-strip' }))?.text).toContain('main cafe0001')
    expect(await ui.find({ key: `disk:${KIDS}/a-run` })).toBeDefined()
    expect((await ui.find({ key: 'panel:acme' }))?.text).toBe('▸ Acme')
    expect(w.invalidated).toBe(0)
    release()
    await w.clock.settle()
    expect(w.invalidated).toBe(1)
    await ui.unmount()
  })

  test('a render starts no run itself: the module timer it sets does, once however many renders ask', async ($, on) => {
    const w = setup(on)
    const ui = await $.ui.mount(PANE())
    const desktop = await $.ui.mount(PANE(60, 40, 'desktop'))
    // the renders have returned, and no command started inside them
    expect(w.panelRuns).toHaveLength(0)
    expect((await ui.find({ key: 'panel:acme' }))?.text).toBe('▸ Acme')
    await w.clock.advance(1)
    expect(w.panelRuns).toHaveLength(1)
    expect((await ui.find({ key: 'panel:acme' }))?.text).toBe('▸ Acme  north  alpha 75%')
    await ui.unmount()
    await desktop.unmount()
  })

  test('control characters in the output and in stderr become spaces', async ($, on) => {
    const esc = '\u001b[31m'
    const data = parsePanelOutput(JSON.stringify({
      summary: `one\ntwo${esc}`,
      tabs: [{ id: 't', label: `tab${esc}`, note: `a\nb`, columns: [{ key: 'c', label: `c\n`, width: 12 }], rows: [{ id: 'r', cells: { c: `x${esc}y\tz` }, hover: [`h\n${esc}`] }] }],
    }))
    const all = JSON.stringify(data)
    expect(all).not.toMatch(/\\u001b|\\n|\\t/)
    expect(data?.summary).toBe('one two [31m')
    expect(data?.tabs[0]?.rows[0]?.cells.c).toBe('x [31my z')
    const w = setup(on, () => ({ exitCode: 1, stderr: `${esc}boom\tnow` }))
    const ui = await shown($.ui.mount(PANE()))
    expect(textOf(keyed(walk(await ui.drawn()), 'panel-error'))).toBe('panel error: [31mboom now')
    expect(w.panelRuns).toHaveLength(1)
    await ui.unmount()
  })

  test('a panel draws at most 12 tabs, 12 columns 200 wide, 100 rows of 6 hover lines', () => {
    const column = (k: number) => ({ key: `c${k}`, width: 1e9 })
    const row = (k: number) => ({ id: `r${k}`, cells: {}, hover: Array.from({ length: 9 }, () => 'h') })
    const tab = (k: number) => ({ id: `t${k}`, columns: Array.from({ length: 20 }, (_, c) => column(c)), rows: Array.from({ length: 10_000 }, (_, r) => row(r)) })
    const data = parsePanelOutput(JSON.stringify({ tabs: Array.from({ length: 20 }, (_, k) => tab(k)) }))
    expect(data?.tabs).toHaveLength(12)
    expect(data?.tabs[0]?.columns).toHaveLength(12)
    expect(data?.tabs[0]?.columns[0]?.width).toBe(200)
    expect(data?.tabs[0]?.rows).toHaveLength(100)
    expect(data?.tabs[0]?.rows[0]?.hover).toHaveLength(6)
  })

  test('a panel dropped from the list loses its kept output: listed again, it runs afresh', async ($, on) => {
    const w = setup(on)
    const ui = await shown($.ui.mount(PANE()))
    await ui.unmount()
    w.files[CONFIG] = JSON.stringify([{ id: 'other', cmd: ['acme-panel', 'other'] }])
    const without = await shown($.ui.mount(PANE()))
    expect(await without.find({ key: 'panel:acme' })).toBeUndefined()
    await without.unmount()
    w.files[CONFIG] = JSON.stringify(SPECS)
    const back = await shown($.ui.mount(PANE()))
    await back.unmount()
    expect(w.panelRuns.map(run => run.argv.join(' '))).toEqual([CMD.join(' '), 'acme-panel other', CMD.join(' ')])
  })

  test('expanded: at most one run per refresh_s', async ($, on) => {
    const w = setup(on)
    const ui = await shown($.ui.mount(PANE()))
    await ui.press({ key: 'panel-toggle:acme' })
    expect((await ui.find({ key: 'panel:acme' }))?.text).toContain('▾ Acme')
    expect(w.panelRuns).toHaveLength(1)
    await ui.unmount()
    await w.clock.advance(29_000)
    const early = await shown($.ui.mount(PANE()))
    await early.unmount()
    expect(w.panelRuns).toHaveLength(1)
    await w.clock.advance(1_000)
    const due = await shown($.ui.mount(PANE()))
    await due.unmount()
    expect(w.panelRuns).toHaveLength(2)
  })

  test('a panel never runs twice at once: a render meanwhile draws the last data', async ($, on) => {
    const w = setup(on)
    const first = await shown($.ui.mount(PANE()))
    await first.press({ key: 'panel-toggle:acme' })
    await first.unmount()
    await w.clock.advance(30_000)
    let release = () => {}
    let called = () => {}
    const calledOnce = new Promise<void>(done => { called = done })
    w.panel = () => {
      called()
      return new Promise(done => { release = () => done(ok({ ...OUTPUT, summary: 'fresh' })) })
    }
    const one = await shown($.ui.mount(PANE()))
    await calledOnce
    // the run outlasts its refresh: a render now still starts none, and draws the rows it had
    await w.clock.advance(30_000)
    const two = await shown($.ui.mount(PANE(60, 40, 'desktop')))
    expect(await two.find({ key: 'panel-row:acme:r1' })).toBeDefined()
    expect(w.panelRuns).toHaveLength(2)
    await two.unmount()
    release()
    await w.clock.settle()
    await one.unmount()
    expect(w.panelRuns).toHaveLength(2)
  })

  test('a failed run says panel error with its first stderr line and keeps the last rows', async ($, on) => {
    const w = setup(on)
    const ui = await shown($.ui.mount(PANE()))
    await ui.press({ key: 'panel-toggle:acme' })
    await ui.unmount()
    const cases: [PanelResult, string | RegExp][] = [
      [{ exitCode: 1, stderr: '\nacme: store locked\nat line 2' }, 'panel error: acme: store locked'],
      [{ stdout: 'not json', stderr: 'acme: warn only' }, 'panel error: acme: warn only'],
      [{ stdout: '{"summary":"no tabs"}' }, 'panel error: stdout is not one panel JSON object'],
      [{ exitCode: 3 }, 'panel error: exit 3'],
      [{ deny: 'timed out' }, /^panel error: .*timed out$/],
    ]
    for (const [answer, error] of cases) {
      w.panel = () => answer
      await w.clock.advance(30_000)
      const again = await shown($.ui.mount(PANE()))
      const all = walk(await again.drawn())
      const line = keyed(all, 'panel-error')
      if (typeof error === 'string') expect(textOf(line)).toBe(error)
      else expect(textOf(line)).toMatch(error)
      expect((line?.children?.[0] as Drawn | undefined)?.props?.dimColor).toBe(true)
      expect(await again.find({ key: 'panel-row:acme:r1' })).toBeDefined()
      await again.unmount()
    }
    w.panel = () => ok()
    await w.clock.advance(30_000)
    const healed = await shown($.ui.mount(PANE()))
    expect(await healed.find({ key: 'panel-error' })).toBeUndefined()
    await healed.unmount()
  })

  test('tab chips switch the rows; the pick persists and outlives the output default', async ($, on) => {
    const w = setup(on)
    const ui = await shown($.ui.mount(PANE()))
    await ui.press({ key: 'panel-toggle:acme' })
    expect((await ui.find({ key: 'panel-tab:acme:north' }))?.props.dimColor).toBe(false)
    expect((await ui.find({ key: 'panel-tab:acme:south' }))?.props.dimColor).toBe(true)
    expect(await ui.find({ key: 'panel-row:acme:r1' })).toBeDefined()
    await ui.press({ key: 'panel-tab:acme:south' })
    expect(await ui.find({ key: 'panel-row:acme:r1' })).toBeUndefined()
    expect((await ui.find({ key: 'panel-row:acme:s1' }))?.text).toContain('gamma')
    await ui.unmount()
    w.panel = () => ok({ ...OUTPUT, tab: 'north' })
    await w.clock.advance(30_000)
    const again = await shown($.ui.mount(PANE()))
    expect(await again.find({ key: 'panel-row:acme:s1' })).toBeDefined()
    await again.unmount()
  })

  test('one tab draws no chips; the default tab is the output tab, else the first', async ($, on) => {
    setup(on, () => ok({ ...OUTPUT, tab: 'south', tabs: [OUTPUT.tabs[1]] }))
    const ui = await shown($.ui.mount(PANE()))
    await ui.press({ key: 'panel-toggle:acme' })
    expect(await ui.find({ key: 'panel-tabs' })).toBeUndefined()
    expect(await ui.find({ key: 'panel-row:acme:s1' })).toBeDefined()
    await ui.unmount()
    const data = parsePanelOutput(JSON.stringify({ ...OUTPUT, tab: 'gone' }))
    expect(data?.tabs.map(tab => tab.id)).toEqual(['north', 'south'])
  })

  test('columns take their width and alignment, one space apart; a bar fills its column, its text inside', () => {
    const tab = parsePanelOutput(JSON.stringify(OUTPUT))?.tabs[0]
    if (!tab) throw new Error('no tab')
    const [alpha, beta] = tab.rows
    if (!alpha || !beta) throw new Error('no rows')
    expect(plain(headerSegments(tab, 80))).toBe('name       n pass      ')
    expect(plain(rowSegments(tab, alpha, 80))).toBe('alpha      9       75% ')
    expect(plain(rowSegments(tab, beta, 80))).toBe('beta-lon  12       25% ')
    expect(plain(rowSegments(tab, alpha, 15))).toBe('alpha      9   ')
  })

  test('a bar is the column wide; its text sits at one place whatever the fill; each character is inked by what is under it', () => {
    const good = TONES.good as number
    const bar = (frac: number, width = 10, text = '64%') => barSegments({ frac, text, tone: 'good' }, width, false)
    for (const frac of [0, 0.3, 0.75, 1]) {
      expect(plain(bar(frac))).toBe('      64% ')
      expect(bar(frac).filter(segment => segment.background === good).reduce((sum, segment) => sum + segment.text.length, 0)).toBe(Math.round(frac * 10))
    }
    // the fill edge between the 6 and the 4: dark ink on the tone, light ink on the track
    expect(bar(0.7)).toEqual([
      { text: '      6', color: INK_ON_FILL, background: good },
      { text: '4% ', color: INK_ON_TRACK, background: BAR_TRACK },
    ])
    expect(bar(0)).toEqual([{ text: '      64% ', color: INK_ON_TRACK, background: BAR_TRACK }])
    // a sliver of work still fills one cell
    expect(bar(0.04).filter(segment => segment.background === good).map(segment => segment.text.length)).toEqual([1])
    expect(bar(1)).toEqual([{ text: '      64% ', color: INK_ON_FILL, background: good }])
    // no room for the margin: the text runs to the edge; no room for the text: it is cut
    expect(plain(bar(0.5, 4, '100%'))).toBe('100%')
    expect(plain(bar(0.5, 3, '100%'))).toBe('100')
  })

  test('bar tones map to the chart palette; an unknown tone is dim', () => {
    const tab = parsePanelOutput(JSON.stringify({
      tabs: [{
        id: 't',
        columns: [{ key: 'b', width: 6, kind: 'bar' }],
        rows: ['good', 'mid', 'bad', 'dim', 'loud'].map(tone => ({ id: tone, cells: { b: { frac: 0.5, text: '', tone } } })),
      }],
    }))?.tabs[0]
    if (!tab) throw new Error('no tab')
    expect(tab.rows.map(row => rowSegments(tab, row, 80)[0]?.background)).toEqual([TONES.good, TONES.mid, TONES.bad, TONES.dim, TONES.dim])
    // a dim row's bar is grey whatever its tone; a name every object inherits is no tone
    expect(barSegments({ frac: 1, text: '', tone: 'good' }, 6, true)[0]?.background).toBe(TONES.dim)
    for (const tone of ['constructor', 'toString', '__proto__']) expect(barSegments({ frac: 1, text: '', tone }, 6, false)[0]?.background).toBe(TONES.dim)
  })

  test('rows draw truncated to the pane, bars in their tone, dim rows dimmed, then the note', async ($, on) => {
    setup(on)
    const ui = await shown($.ui.mount(PANE(16)))
    await ui.press({ key: 'panel-toggle:acme' })
    const all = walk(await ui.drawn())
    for (const key of ['panel-columns', 'panel-row:acme:r1', 'panel-row:acme:r2']) expect(textOf(keyed(all, key)).length).toBeLessThanOrEqual(14)
    expect(textOf(keyed(all, 'panel-row:acme:r1'))).toBe('alpha      9  ')
    const cells = (key: string) => (keyed(all, key)?.children ?? []) as Drawn[]
    const hex = (rgb: number | undefined) => `#${(rgb ?? 0).toString(16).padStart(6, '0')}`
    expect(cells('panel-row:acme:r1').map(cell => cell.props?.dimColor)).toEqual([false, false, false, false, false])
    expect(cells('panel-row:acme:r1')[4]?.props).toMatchObject({ backgroundColor: hex(TONES.good), color: hex(INK_ON_FILL) })
    // a dim row dims its text; its bar keeps its ink, on the grey tone
    const dimRow = cells('panel-row:acme:r2')
    for (const cell of dimRow) expect(cell.props?.dimColor).toBe(cell.props?.backgroundColor === undefined)
    expect(dimRow.at(-1)?.props?.backgroundColor).toBe(hex(TONES.dim))
    expect(cells('panel-columns').every(cell => cell.props?.dimColor === true)).toBe(true)
    expect((await ui.find({ type: 'Text', text: 'dim = few runs' }))?.props.dimColor).toBe(true)
    await ui.unmount()
  })

  test('a hovered row lights and reveals its card, painted last, below the row or else above it', async ($, on) => {
    setup(on)
    const ui = await shown($.ui.mount(PANE(60, 40)))
    await ui.press({ key: 'panel-toggle:acme' })
    const all = walk(await ui.drawn())
    const row = keyed(all, 'panel-row:acme:r1')
    expect(row?.hover?.backgroundColor).toMatch(/^#[0-9a-f]{6}$/)
    const card = keyed(all, 'panel-card:acme:r1')
    expect(card?.props).toMatchObject({ position: 'absolute', display: 'none', borderStyle: 'round', left: 2 })
    expect(card?.hover).toMatchObject({ display: 'flex', scope: row?.hover?.scope })
    expect(textOf(card)).toBe('alpha · northpass 6 / fail 2')
    // the panel's lines: head 0, chips 1, columns 2, r1 3, r2 4; r1's card (2 lines + border) below it
    expect(card?.props?.top).toBe(4)
    expect(Number(card?.props?.width)).toBe('pass 6 / fail 2'.length + 4)
    expect(all.indexOf(card as Drawn)).toBeGreaterThan(all.indexOf(keyed(all, 'panel:acme') as Drawn))
    expect(all.slice(all.indexOf(card as Drawn) + 1).every(node => !(node.props?.key as string | undefined)?.startsWith('panel-row:'))).toBe(true)
    expect(keyed(all, 'panel-row:acme:r2')?.hover?.scope).not.toBe(row?.hover?.scope)
    await ui.unmount()
    // six rows of pane: r2 at line 4 has one line below, so its 3-line card goes above it
    const short = await shown($.ui.mount(PANE(60, 6)))
    expect(keyed(walk(await short.drawn()), 'panel-card:acme:r2')?.props?.top).toBe(1)
    await short.unmount()
    expect(placeBeside(4, 1, 3, 6)).toEqual({ x: 1, width: 3 })
  })

  test('with the main-ci chart open, a row card counts the strip, the bars, the metric chips and the legend above the panels', async ($, on) => {
    const metric = (i: number) => JSON.stringify({ run: `20260101T00000${i}Z-acme`, sha: `acme000${i}aaaa`, job: 'lint', attempt: 1, wall_s: 10, exit: 0 })
    const w = world(on, {
      ...GIT_CONFIG,
      '/fx/repo/.agent/orchestrate.local.md': '- `session_bus_dir`: `~/state/bus`\n- `gh_status_dir`: `~/state/gh-status`\n',
      [`${STATE}/main-ci/state.json`]: JSON.stringify({ sha: 'acme0002aaaa', green: true, phase: 'done' }),
      [`${STATE}/main-ci/metrics.jsonl`]: `${metric(1)}\n${metric(2)}\n`,
      [CONFIG]: JSON.stringify(SPECS),
    }, [])
    w.panel = () => ok()
    w.redraws = true
    current = w
    const ui = await shown($.ui.mount(PANE()))
    await ui.press({ key: 'ci-toggle' })
    await ui.press({ key: 'panel-toggle:acme' })
    // strip 0, bars 1-6, chips 7, legend 8; the panel: head 9, tabs 10, columns 11, r1 12, its card 13
    expect(keyed(walk(await ui.drawn()), 'panel-card:acme:r1')?.props?.top).toBe(13)
    await ui.unmount()
  })

  test('a card fits a narrow pane', async ($, on) => {
    setup(on, () => ok({ ...OUTPUT, tabs: [{ ...OUTPUT.tabs[0], rows: [{ id: 'r1', cells: {}, hover: ['x'.repeat(80)] }] }] }))
    const ui = await shown($.ui.mount(PANE(30)))
    await ui.press({ key: 'panel-toggle:acme' })
    const card = keyed(walk(await ui.drawn()), 'panel-card:acme:r1')
    expect(Number(card?.props?.left) + Number(card?.props?.width)).toBeLessThanOrEqual(30)
    expect(textOf(card).length).toBeLessThanOrEqual(24)
    await ui.unmount()
  })
})
