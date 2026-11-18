import { type TestBody, type TestOptions, describe, expect, test as bareTest } from 'claude-code/testing'

import { localEnvValue, prMark } from '../hooks/lib'
import { avatarPicture, dim } from '../hooks/sprites'
import { epoch, GIT_CONFIG, KIDS, NOW, PANEL, RUN_FILES, run, SID, STATE, under, world } from './world'

// Each test runs as a configured install, childrenDir set, unless it passes its own options.
const test = (name: string, ...rest: [TestBody] | [TestOptions, TestBody]) =>
  rest.length === 1 ? bareTest(name, { options: { childrenDir: KIDS } }, rest[0]) : bareTest(name, ...rest)

const SURFACES = ['terminal', 'desktop'] as const

const PANE = {
  plugin: 'agent-ui',
  component: 'Pane',
  requestId: 'workers',
  props: {
    title: 'Workers',
    isFocused: false,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

async function mountWorkers($: Parameters<TestBody>[0], clock: ReturnType<typeof world>['clock'], request: Parameters<Parameters<TestBody>[0]['ui']['mount']>[0], tick = 1) {
  const ui = await $.ui.mount(request)
  // Mock time starts the timer scheduled by the first render.
  await clock.advance(tick)
  return ui
}

describe('workers pane', () => {
  test('rows carry kind, label, model and status from each out-dir', async ($, on) => {
    const w = world(on, RUN_FILES)
    for (const surface of SURFACES) {
      const ui = await mountWorkers($, w.clock, { ...PANE, surface })
      const row = async (dir: string) => (await ui.find({ key: `disk:${dir}` }))?.text ?? ''
      expect(await row(`${KIDS}/a-run`)).toContain('gpt a-run  openai/sol  5m  running')
      expect(await row(`${KIDS}/b-done`)).toContain('gpt b-done  openai/sol  4m  done')
      expect(await row(`${KIDS}/c-dead`)).toContain('claude c-dead  claude/opus')
      expect(await row(`${KIDS}/c-dead`)).toContain('dead')
      expect(await row(`${KIDS}/e-failed`)).toContain('failed')
      expect(await row(`${PANEL}/0123abcdef/code`)).toContain('claude-panel rev 0123abcd/code  claude/opus')
      expect(await ui.find({ key: `disk:${KIDS}/d-foreign` })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a click shows the run tail, and the last message once done', async ($, on) => {
    const w = world(on, RUN_FILES)
    for (const surface of SURFACES) {
      const ui = await mountWorkers($, w.clock, { ...PANE, surface })
      await ui.press({ key: `disk:${KIDS}/a-run` })
      expect(await ui.find({ type: 'Text', text: 'hello from codex' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '$ git status' })).toBeDefined()
      expect(await ui.find({ key: 'last-message' })).toBeUndefined()

      await ui.press({ key: `disk:${KIDS}/b-done` })
      expect(await ui.find({ type: 'Text', text: 'hello from codex' })).toBeUndefined()
      expect((await ui.find({ key: 'last-message' }))?.text).toContain('All green.')

      await ui.press({ key: `disk:${KIDS}/b-done` })
      expect(await ui.find({ key: 'tail' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a resumed run (done removed) shows running again, not its old end', async ($, on) => {
    const dir = `${KIDS}/b-done`
    const w = world(on, RUN_FILES, undefined, { mtimes: { [`${dir}/done`]: NOW - 600_000 } })
    const first = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
    expect((await first.find({ key: `disk:${dir}` }))?.text).toContain('4m  done')
    await first.unmount()

    delete w.files[`${dir}/done`]
    delete w.files[`${dir}/exit-code`]
    w.mtimes[`${dir}/pid`] = NOW
    w.alive.add('102')
    const again = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' }, 3000)
    expect((await again.find({ key: `disk:${dir}` }))?.text).toContain('5m  running')
    await again.press({ key: `disk:${dir}` })
    expect(await again.find({ key: 'last-message' })).toBeUndefined()
    await again.unmount()
  })

  test('a panel run dir that appears under a known sha dir is listed on the next tick', async ($, on) => {
    const sha = `${PANEL}/0123abcdef`
    const w = world(on, RUN_FILES, ['106', '107'], { mtimes: { [`${sha}/code/pid`]: NOW - 60_000 } })
    const first = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
    expect(await first.find({ key: `disk:${sha}/writing` })).toBeUndefined()
    await first.unmount()

    Object.assign(w.files, under(`${sha}/writing`, run('claude', '107')))
    w.mtimes[`${sha}/writing/pid`] = NOW
    const again = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' }, 3000)
    expect(await again.find({ key: `disk:${sha}/writing` })).toBeDefined()
    await again.unmount()
  })

  test('lists running runs, then only the 5 newest done runs', async ($, on) => {
    const files: Record<string, string> = {}
    for (const i of [1, 2]) Object.assign(files, under(`${KIDS}/run-${i}`, run('openai', `20${i}`)))
    for (let i = 1; i <= 7; i++) {
      Object.assign(files, under(`${KIDS}/done-${i}`, { ...run('openai', `30${i}`), done: '', 'exit-code': '0', 'end-epoch': epoch(i) }))
    }
    const w = world(on, files, ['201', '202'])
    const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
    const rows = (await ui.findAll({})).map(n => n.key).filter((k): k is string => !!k?.startsWith('disk:'))
    expect(rows.map(k => k.slice(k.lastIndexOf('/') + 1)).slice(2)).toEqual(['done-1', 'done-2', 'done-3', 'done-4', 'done-5'])
    expect(rows).toHaveLength(7)
    expect(rows.slice(0, 2).every(k => k.includes('/run-'))).toBe(true)
    await ui.unmount()
    for (let i = 1; i <= 5; i++) for (const name of Object.keys(w.files)) if (name.startsWith(`${KIDS}/done-${i}/`)) delete w.files[name]
    const again = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' }, 3000)
    const left = (await again.findAll({})).map(n => n.key).filter((k): k is string => !!k?.startsWith('disk:'))
    expect(left.map(k => k.slice(k.lastIndexOf('/') + 1)).slice(2)).toEqual(['done-6', 'done-7'])
    await again.unmount()
  })

  test('keeps up to five finished rows from each source', async ($, on) => {
    const files: Record<string, string> = {}
    for (let i = 1; i <= 6; i++) Object.assign(files, under(`${KIDS}/disk-done-${i}`, { ...run('openai', `${800 + i}`), done: '', 'exit-code': '0', 'end-epoch': epoch(i) }))
    const agents = Array.from({ length: 6 }, (_, i) => ({ id: `finished-${i}`, description: `finished ${i}`, type: 'Explore', status: 'completed' }))
    const w = world(on, files, [], { agents })
    const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
    const keys = (await ui.findAll({})).map(node => node.key).filter((key): key is string => !!key)
    expect(keys.filter(key => key.startsWith('disk:') && key.includes('/disk-done-'))).toHaveLength(5)
    expect(keys.filter(key => key.startsWith('native:finished-'))).toHaveLength(5)
    await ui.unmount()
  })

  test('an old run without done reads dead even if its pid is alive', async ($, on) => {
    const dir = `${KIDS}/old`
    const w = world(on, under(dir, { ...run('openai', '401'), 'start-epoch': epoch(25 * 60) }), ['401'])
    const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: `disk:${dir}` }))?.text).toContain('dead')
    await ui.unmount()
  })

  test('finished and dead elapsed time ends at the recorded end or last file mtime', async ($, on) => {
    const done = `${KIDS}/done-no-end`
    const dead = `${KIDS}/dead-mtime`
    const mtime = NOW - 2 * 60_000
    const w = world(on, {
      ...under(done, { ...run('openai', '601'), done: '', 'exit-code': '0' }),
      ...under(dead, { ...run('openai', '602'), 'owner-session': SID }),
    }, [], { mtimes: { [`${done}/done`]: mtime, [`${dead}/pid`]: mtime } })
    const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: `disk:${done}` }))?.text).toContain('3m  done')
    expect((await ui.find({ key: `disk:${dead}` }))?.text).toContain('3m  dead')
    await ui.unmount()
  })

  test('a dead run follows its log mtime even when the folder mtime is unchanged', async ($, on) => {
    const dir = `${KIDS}/dead`
    const log = `${dir}/stderr.log`
    const start = NOW - 5 * 60_000
    const w = world(on, under(dir, { ...run('claude', '701'), 'stderr.log': 'started' }), [], {
      mtimes: { [dir]: start, [log]: start },
    })
    const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
    const row = () => ui.find({ key: `disk:${dir}` })
    expect((await row())?.text).toContain('0m  dead')

    w.files[log] += '\nlast output'
    w.mtimes[log] = NOW - 60_000
    await w.clock.advance(3000)
    expect((await row())?.text).toContain('4m  dead')
    await ui.unmount()
  })

  test('a tick with the same pane key does not invalidate', async ($, on) => {
    const dir = `${KIDS}/done`
    const w = world(on, under(dir, { ...run('openai', '702'), done: '', 'exit-code': '0', 'end-epoch': epoch(1) }), [])
    const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: `disk:${dir}` })).toBeDefined()
    const { discoveries, invalidated } = w

    await w.clock.advance(3000)
    expect(w.discoveries).toBeGreaterThan(discoveries)
    expect(w.invalidated).toBe(invalidated)
    await ui.unmount()
  })

  test('the pane skips scans while hidden and refreshes on a timer when reopened stale', async ($, on) => {
    const dir = `${KIDS}/new`
    const w = world(on, {}, [])
    const request = { ...PANE, surface: 'terminal' } as const
    const first = await mountWorkers($, w.clock, request)
    await first.unmount()
    w.paneShown = false
    const { discoveries } = w

    Object.assign(w.files, under(dir, run('claude', '703')))
    await w.clock.advance(12_125)
    expect(w.discoveries).toBe(discoveries)

    w.paneShown = true
    const reopened = await $.ui.mount(request)
    expect(w.discoveries).toBe(discoveries)
    await w.clock.advance(1)
    expect(await reopened.find({ key: `disk:${dir}` })).toBeDefined()
    await reopened.unmount()
  })

  test('native agents use their transcript for detail and omit unknown model and time', async ($, on) => {
    const w = world(on, {}, [], {
      agents: [{ id: 'agent-1', description: 'inspect sidebar', type: 'Explore', status: 'running' }, { id: 'agent-2', description: 'finished inspect', type: 'Explore', status: 'completed' }],
      transcripts: { 'agent-1': [{ role: 'assistant', text: 'native transcript tail', toolUses: [] }] },
    })
    const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'native:agent-1' }))?.text).toBe('Explore inspect sidebar  running')
    expect((await ui.find({ key: 'native:agent-2' }))?.text).toContain('Explore finished inspect')
    await ui.press({ key: 'native:agent-1' })
    expect(await ui.find({ type: 'Text', text: 'native transcript tail' })).toBeDefined()
    await ui.unmount()
  })

  test('ready PRs come from local status files, oldest number first', async ($, on) => {
    const root = '/fx/home/state'
    const pr = (n: number, extra: Record<string, unknown> = {}) => ({
      [`${root}/gh-status/status/pr-${n}.json`]: JSON.stringify({ number: n, state: 'OPEN', isDraft: false, title: `t${n}`, ...extra }),
    })
    const w = world(on, {
      ...RUN_FILES,
      '/fx/repo/.agent/local.env': 'state_dir=~/state\n',
      ...pr(4391),
      ...pr(4390, { title: 'Sidebar work' }),
      ...pr(4392, { isDraft: true }),
      ...pr(4389, { state: 'MERGED' }),
    })
    const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Link', text: '#4390' }))?.props.href).toBe('https://github.com/acme/widgets/pull/4390')
    expect((await ui.find({ key: 'pr:4390' }))?.text).toContain('Sidebar work')
    const order = (await ui.findAll({})).map(node => /^pr:(\d+)$/.exec(node.key ?? '')?.[1]).filter(Boolean)
    expect(order).toEqual(['4390', '4391'])
    await ui.unmount()
  })

  test('a PR mark comes from its mergeable and checks values', () => {
    expect(prMark('MERGEABLE', 'SUCCESS')).toBe('✓')
    expect(prMark('MERGEABLE', 'FAILURE')).toBe('✗')
    expect(prMark('MERGEABLE', 'ERROR')).toBe('✗')
    expect(prMark('UNKNOWN', 'PENDING')).toBe('⋯')
    expect(prMark('MERGEABLE', null)).toBe('⋯')
    expect(prMark('CONFLICTING', 'SUCCESS')).toBe('⚡')
  })

  test('ready PRs sort green, running, red, conflict, then by number', async ($, on) => {
    const root = '/fx/home/state'
    const pr = (n: number, extra: Record<string, unknown>) => ({
      [`${root}/gh-status/status/pr-${n}.json`]: JSON.stringify({ number: n, state: 'OPEN', isDraft: false, title: `t${n}`, ...extra }),
    })
    const w = world(on, {
      ...RUN_FILES,
      '/fx/repo/.agent/local.env': 'state_dir=~/state\n',
      ...pr(1, { mergeable: 'CONFLICTING', checks: 'SUCCESS' }),
      ...pr(2, { checks: 'FAILURE' }),
      ...pr(3, { checks: 'PENDING' }),
      ...pr(4, { checks: 'SUCCESS' }),
      ...pr(5, { checks: 'SUCCESS' }),
    })
    const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
    const order = (await ui.findAll({})).map(node => /^pr:(\d+)$/.exec(node.key ?? '')?.[1]).filter(Boolean)
    expect(order).toEqual(['4', '5', '3', '2', '1'])
    expect((await ui.find({ key: 'pr:1' }))?.text).toContain('⚡')
    await ui.unmount()
  })

  test('the status cache reads only changed PR files', async ($, on) => {
    const root = '/fx/home/state'
    const p1 = `${root}/gh-status/status/pr-4420.json`
    const p2 = `${root}/gh-status/status/pr-4421.json`
    const w = world(on, {
      '/fx/repo/.agent/local.env': 'state_dir=~/state\n',
      [p1]: JSON.stringify({ number: 4420, state: 'OPEN', isDraft: false, title: 'one', headOid: '11111111abcdef' }),
      [p2]: JSON.stringify({ number: 4421, state: 'OPEN', isDraft: false, title: 'two', headOid: '22222222abcdef' }),
    })
    const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
    await ui.unmount()
    const again = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' }, 3000)
    await again.unmount()
    expect(w.reads.filter(path => path === p1)).toHaveLength(1)
    expect(w.reads.filter(path => path === p2)).toHaveLength(1)

    w.files[p1] = JSON.stringify({ number: 4420, state: 'OPEN', isDraft: false, title: 'updated', headOid: '11111111abcdef' })
    w.mtimes[p1] = 1
    const changed = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' }, 3000)
    expect((await changed.find({ key: 'pr:4420' }))?.text).toContain('updated')
    await changed.unmount()
    expect(w.reads.filter(path => path === p1)).toHaveLength(2)
    expect(w.reads.filter(path => path === p2)).toHaveLength(1)
  })

  test('a done run is not listed or re-probed on the next tick', async ($, on) => {
    const dir = `${KIDS}/b-done`
    const w = world(on, RUN_FILES, undefined, { mtimes: { [`${dir}/done`]: NOW - 60_000 } })
    const first = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
    await first.unmount()
    expect(w.lists.filter(path => path === dir)).toHaveLength(1)
    const again = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' }, 3000)
    expect((await again.find({ key: `disk:${dir}` }))?.text).toContain('4m  done')
    await again.unmount()
    expect(w.lists.filter(path => path === dir)).toHaveLength(1)
    expect(w.reads.filter(path => path === `${dir}/pid`)).toHaveLength(1)
    expect(w.lists.filter(path => path === `${KIDS}/a-run`)).toHaveLength(2)
    expect(w.lists.filter(path => path === `${KIDS}/d-foreign`)).toHaveLength(1)
  })

  describe('avatars', () => {
    type Found = { type: string; props: Record<string, unknown> }
    const avatarOf = async (ui: { find: (q: { key: string }) => Promise<Found | undefined> }, dir: string) => ui.find({ key: `avatar:disk:${dir}` })
    const pictureOf = async (ui: { find: (q: { key: string }) => Promise<Found | undefined> }, dir: string) =>
      ((await avatarOf(ui, dir))?.props.source as { rgba?: string } | undefined)?.rgba
    const frames = (key: string, w: { blits: { key: string; rgba: string }[] }) => w.blits.filter(blit => blit.key === key)
    const bytes = (base64: string) => Uint8Array.from(atob(base64), ch => ch.charCodeAt(0))
    const pixel = (rgba: string, x: number, y: number) => [...bytes(rgba).slice((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)]
    const rgb = (n: number) => [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]

    test('a sprite frame is 16x16 RGBA in its palette; done dims it, failed turns it red', () => {
      const run = avatarPicture('claude', 'running', 0)
      expect(run).toMatchObject({ width: 16, height: 16 })
      expect(bytes(run.rgba)).toHaveLength(16 * 16 * 4)
      expect(pixel(run.rgba, 3, 2)).toEqual(rgb(0xd97757))
      expect(pixel(run.rgba, 5, 4)).toEqual(rgb(0x1a1a1a))
      expect(pixel(run.rgba, 0, 0)[3]).toBe(0)
      expect(pixel(avatarPicture('claude', 'done', 0).rgba, 3, 2)).toEqual(rgb(dim(0xd97757)))
      expect(pixel(avatarPicture('claude', 'failed', 0).rgba, 3, 2)).toEqual(rgb(0xe06c75))
      expect(avatarPicture('claude', 'running', 1).rgba).not.toBe(run.rgba)
    })

    test('the gpt knot is 32x32 and spins through four frames that loop', () => {
      const frames = [0, 1, 2, 3, 4].map(tick => avatarPicture('gpt', 'running', tick))
      expect(frames[0]).toMatchObject({ width: 32, height: 32 })
      expect(bytes(frames[0]?.rgba ?? '')).toHaveLength(32 * 32 * 4)
      expect(new Set(frames.slice(0, 4).map(frame => frame.rgba)).size).toBe(4)
      expect(frames[4]?.rgba).toBe(frames[0]?.rgba)
      expect(bytes(avatarPicture('gpt', 'done', 0).rgba)).toHaveLength(32 * 32 * 4)
    })

    test('terminal rows draw a picture per status in place of the mark; other surfaces keep the mark', async ($, on) => {
      const w = world(on, { ...RUN_FILES, ...under(`${KIDS}/f-unknown`, { pid: '110', provider: 'gemini', 'owner-session': SID, 'start-epoch': epoch(5) }) })
      const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
      expect((await avatarOf(ui, `${KIDS}/a-run`))?.type).toBe('Image')
      expect((await avatarOf(ui, `${KIDS}/a-run`))?.props).toMatchObject({ columns: 2, rows: 1 })
      const run = await pictureOf(ui, `${KIDS}/a-run`)
      const done = await pictureOf(ui, `${KIDS}/b-done`)
      const failed = await pictureOf(ui, `${KIDS}/e-failed`)
      expect(new Set([run, done, failed]).size).toBe(3)
      expect(await pictureOf(ui, `${PANEL}/0123abcdef/code`)).not.toBe(run)
      expect(await ui.find({ key: `mark:disk:${KIDS}/a-run` })).toBeUndefined()
      expect((await ui.find({ key: `mark:disk:${KIDS}/f-unknown` }))?.text).toContain('†')
      expect((await ui.find({ key: `disk:${KIDS}/f-unknown` }))?.text).toContain('gemini f-unknown  gemini  5m  dead')
      await ui.unmount()

      const desktop = await mountWorkers($, w.clock, { ...PANE, surface: 'desktop' })
      expect(await desktop.find({ key: `avatar:disk:${KIDS}/a-run` })).toBeUndefined()
      const mark = async (dir: string) => (await desktop.find({ key: `mark:disk:${dir}` }))?.text
      expect(await mark(`${KIDS}/a-run`)).toContain('◐')
      expect(await mark(`${KIDS}/b-done`)).toContain('✓')
      expect(await mark(`${KIDS}/e-failed`)).toContain('✗')
      await desktop.unmount()
    })

    test('only running rows blit, a frame per tick; the timer is off with no running row', async ($, on) => {
      const w = world(on, RUN_FILES)
      w.blitOk = true
      const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
      await w.clock.advance(1000)
      const keys = new Set(w.blits.map(blit => blit.key))
      expect([...keys].sort()).toEqual([`avatar:disk:${KIDS}/a-run`, `avatar:disk:${PANEL}/0123abcdef/code`].sort())
      expect(frames(`avatar:disk:${KIDS}/a-run`, w)).toHaveLength(4)
      expect(new Set(frames(`avatar:disk:${KIDS}/a-run`, w).map(blit => blit.rgba)).size).toBeGreaterThan(1)
      await ui.unmount()

      w.alive.clear()
      const settled = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' }, 3000)
      await w.clock.advance(1000)
      const before = w.blits.length
      await w.clock.advance(5000)
      expect(w.blits).toHaveLength(before)
      await settled.unmount()
    })

    test('31 running rows are all listed; animation still stops at 20', async ($, on) => {
      const files: Record<string, string> = {}
      for (let i = 0; i < 31; i++) Object.assign(files, under(`${KIDS}/m-${i}`, run('openai', `70${i}`)))
      const w = world(on, files, Array.from({ length: 31 }, (_, i) => `70${i}`))
      w.blitOk = true
      const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
      expect((await avatarOf(ui, `${KIDS}/m-0`))?.type).toBe('Image')
      expect((await ui.findAll({})).filter(node => node.key?.startsWith('disk:'))).toHaveLength(31)
      await w.clock.advance(1000)
      expect(new Set(w.blits.map(blit => blit.key)).size).toBe(20)
      await ui.unmount()
    })

    test('animation stays under the blit limit however many rows run', async ($, on) => {
      const files: Record<string, string> = {}
      for (let i = 0; i < 25; i++) Object.assign(files, under(`${KIDS}/m-${i}`, run('openai', `70${i}`)))
      const w = world(on, files, Array.from({ length: 25 }, (_, i) => `70${i}`))
      w.blitOk = true
      const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
      await w.clock.advance(1000)
      expect(w.blits).toHaveLength(80)
      await ui.unmount()
    })

    test('after unmount the engine denies blits and the timer stands down', async ($, on) => {
      const w = world(on, RUN_FILES)
      w.blitOk = true
      const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
      await w.clock.advance(250)
      const flowing = w.blits.length
      expect(flowing).toBeGreaterThan(0)
      await ui.unmount()

      w.blitOk = false
      await w.clock.advance(250)
      expect(w.denied).toBeGreaterThan(0)
      const denied = w.denied
      await w.clock.advance(5000)
      expect(w.denied).toBe(denied)
      expect(w.blits).toHaveLength(flowing)
    })
  })

  describe('worker hierarchy', () => {
    const rowKeys = async (ui: { findAll: (q: object) => Promise<{ key?: string }[]> }) =>
      (await ui.findAll({})).map(node => node.key ?? '').filter(key => /^(disk|native):/.test(key))
    const child = (extra: Record<string, string>) => ({ ...run('openai', '902'), ...extra })

    test('a native subagent nests under its parent; a click toggles expansion and shows each transcript', async ($, on) => {
      const w = world(on, {}, [], {
        agents: [
          { id: 'p', description: 'parent', type: 'general-purpose', status: 'running' },
          { id: 'r', description: 'reviewer', type: 'reviewer', status: 'running', parentId: 'p' },
        ],
        transcripts: {
          p: [{ role: 'assistant', text: 'worker transcript', toolUses: [] }],
          r: [{ role: 'assistant', text: 'reviewer transcript', toolUses: [] }],
        },
      })
      const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
      expect(await rowKeys(ui)).toEqual(['native:p'])

      await ui.press({ key: 'native:p' })
      expect(await rowKeys(ui)).toEqual(['native:p', 'native:r'])
      expect(await ui.find({ type: 'Text', text: '  └ ' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'worker transcript' })).toBeDefined()

      await ui.press({ key: 'native:r' })
      expect(await ui.find({ type: 'Text', text: 'reviewer transcript' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'worker transcript' })).toBeUndefined()
      expect(await rowKeys(ui)).toEqual(['native:p', 'native:r'])

      await ui.press({ key: 'native:p' })
      expect(await ui.find({ type: 'Text', text: 'worker transcript' })).toBeDefined()
      await ui.press({ key: 'native:p' })
      expect(await rowKeys(ui)).toEqual(['native:p'])
      expect(await ui.find({ key: 'tail' })).toBeUndefined()
      await ui.unmount()
    })

    test('a disk reviewer links to the worker in its cwd; an unlinked reviewer stays top-level', async ($, on) => {
      const worker = `${KIDS}/w-1`
      const linked = `${KIDS}/rev-linked`
      const loose = `${KIDS}/rev-loose`
      const w = world(
        on,
        {
          ...under(worker, child({ pid: '901', cwd: '/wt/x', agent: 'worker-high' })),
          ...under(linked, child({ cwd: '/wt/x', agent: 'reviewer', 'last-message': 'linked verdict', done: '', 'exit-code': '0' })),
          ...under(loose, child({ pid: '903', cwd: '/wt/other', agent: 'reviewer' })),
          ...under(`${PANEL}/0123abcdef/code`, { ...run('claude', '904'), cwd: '.', agent: 'reviewer' }),
        },
        ['901', '903', '904'],
      )
      const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
      const top = await rowKeys(ui)
      expect(top).toContain(`disk:${worker}`)
      expect(top).toContain(`disk:${loose}`)
      expect(top).toContain(`disk:${PANEL}/0123abcdef/code`)
      expect(top).not.toContain(`disk:${linked}`)

      await ui.press({ key: `disk:${worker}` })
      expect(await rowKeys(ui)).toContain(`disk:${linked}`)
      await ui.press({ key: `disk:${linked}` })
      expect((await ui.find({ key: 'last-message' }))?.text).toContain('linked verdict')
      await ui.unmount()
    })
  })

  test('a non-git root draws no PR row; a repo root resolves afresh; a shell cwd runs no git; one root runs git once', async ($, on) => {
    const root = '/fx/home/state'
    const w = world(on, {
      '/fx/repo/.agent/local.env': 'state_dir=~/state\n',
      [`${root}/gh-status/status/pr-4390.json`]: JSON.stringify({ number: 4390, state: 'OPEN', isDraft: false, title: 'Sidebar work' }),
    })
    const strip = async () => {
      const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
      await w.clock.advance(3000)
      const found = await ui.find({ key: 'pr:4390' })
      await ui.unmount()
      return found
    }
    w.root = '/fx/elsewhere'
    expect(await strip()).toBeUndefined()
    expect(await strip()).toBeUndefined()
    expect(w.gitRuns).toBe(1)

    w.root = '/fx/repo'
    expect((await strip())?.text).toContain('Sidebar work')
    const inRepo = w.gitRuns
    w.cwd = '/fx/elsewhere'
    expect(await strip()).toBeDefined()
    expect(w.gitRuns).toBe(inRepo)

    w.root = '/fx/elsewhere'
    expect(await strip()).toBeUndefined()
    expect(w.gitRuns).toBe(inRepo + 1)
  })

  test('no runs for the session draws the empty line', async ($, on) => {
    const w = world(on, {})
    const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'No child runs for this session.' })).toBeDefined()
    await ui.unmount()
  })
})

describe('local.env', () => {
  test('a value is everything after the first =; # lines are skipped; ~/ is HOME', () => {
    const text = '# state_dir=/wrong\nother=x\nstate_dir=~/a=b/\n'
    expect(localEnvValue(text, 'state_dir', '/home/me')).toBe('/home/me/a=b')
    expect(localEnvValue(text, 'worktrees_dir', '/home/me')).toBeNull()
    expect(localEnvValue('state_dir=\n', 'state_dir', '/home/me')).toBeNull()
  })

})

describe('chain row', () => {
  const CHAINS = `${STATE}/chains/${SID}`
  const board = (...rows: [number, string, string][]) => ({
    [`${STATE}/board-snapshot.md`]: ['| # | Title | Status | Service | Tier | Week | Milestone | Blocked-by |', ...rows.map(([n, title, status]) => `| #${n} | ${title} | ${status} | Web | Free | Week 16 | M7 | — |`)].join('\n'),
  })
  type Drawn = { type?: string; props?: Record<string, unknown>; hover?: { scope?: string; display?: string }; children?: unknown[] }
  const walk = (node: unknown, out: Drawn[] = []): Drawn[] => {
    if (typeof node !== 'object' || node === null) return out
    out.push(node as Drawn)
    for (const child of (node as Drawn).children ?? []) walk(child, out)
    return out
  }
  const textOf = (node: unknown): string =>
    typeof node === 'string' ? node : typeof node === 'object' && node !== null ? ((node as Drawn).children ?? []).map(textOf).join('') : ''
  const chainFiles = (chains: string) => ({
    ...RUN_FILES,
    [CHAINS]: chains,
    ...board([4545, 'first', 'Done'], [4549, 'second \\| part', 'Done'], [4552, 'third', 'In progress'], [4560, 'fourth', 'Ready'], [4570, 'other', 'Ready']),
  })
  const agents = [{ id: 'agent-1', description: 'worker #4552 build it', type: 'worker-high', status: 'running' }]

  test('one line per chain: the newest merged issue with its tick, the running one lit, the rest plain', async ($, on) => {
    const w = world(on, chainFiles('4545 4549 4552 4560\n\n#4570\n'), undefined, { agents })
    const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
    // the line as drawn: its #N cells, the hidden titles left out
    const line = async (i: number) => (await ui.findAll({})).filter(node => node.key?.startsWith(`chain-issue:${i}:`)).map(node => node.text).join('')
    expect(await line(0)).toBe('#4549 ✓ → #4552 → #4560')
    expect(await line(1)).toBe('#4570')
    const colorOf = async (i: number, k: number) => walk(walk(await ui.drawn()).find(node => node.props?.key === `chain-issue:${i}:${k}`)).filter(node => node.type === 'Text').at(-1)?.props
    expect(await colorOf(0, 0)).toMatchObject({ color: 'green', dimColor: true })
    expect((await colorOf(0, 1))?.color).toBe('#CBA6F7')
    expect((await colorOf(0, 2))?.color).toBeUndefined()
    const all = walk(await ui.drawn())
    const at = (key: string) => all.findIndex(node => node.props?.key === key)
    expect(at('chains')).toBeLessThan(all.findIndex(node => node.type === 'Text' && textOf(node) === 'Workers'))
    await ui.unmount()
  })

  test('each #N links its issue; hovering it reveals a card of its board title', async ($, on) => {
    const w = world(on, chainFiles('4545 4549 4552\n'), undefined, { agents })
    const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Link', text: '#4552' }))?.props.href).toBe('https://github.com/acme/widgets/issues/4552')
    const all = walk(await ui.drawn())
    expect(all.find(node => node.props?.key === 'chain-issue:0:0')?.hover?.scope).toBe('chain:0:4549')
    expect(all.find(node => node.props?.key === 'chain-issue:0:0')?.props?.flexShrink).toBe(0)
    expect(all.some(node => String(node.props?.key ?? '').startsWith('chain-title:'))).toBe(false)
    const card = all.find(node => node.props?.key === 'chain-card:0:0')
    expect(card?.props).toMatchObject({ position: 'absolute', display: 'none' })
    expect(card?.hover).toMatchObject({ display: 'flex', scope: 'chain:0:4549' })
    expect(textOf(card)).toBe('#4549 ✓ · second | part')
    // drawn after the rest of the pane, just below its row (the pane's first line here)
    expect(all.indexOf(card as Drawn)).toBeGreaterThan(all.findIndex(node => node.props?.key === 'chains'))
    expect(all.findLastIndex(node => node.props?.key != null && !String(node.props.key).startsWith('chain-card'))).toBeLessThan(all.indexOf(card as Drawn))
    expect(card?.props?.top).toBe(1)
    await ui.unmount()
  })

  for (const [name, text] of [['a missing', undefined], ['an empty', '\n']] as const) {
    test(`${name} chains file draws no chain row`, async ($, on) => {
      const files: Record<string, string> = chainFiles('')
      if (text === undefined) delete files[CHAINS]
      else files[CHAINS] = text
      const w = world(on, files)
      const ui = await mountWorkers($, w.clock, { ...PANE, surface: 'terminal' })
      expect(await ui.find({ key: 'chains' })).toBeUndefined()
      await ui.unmount()
    })
  }
})

describe('pane auto-open', () => {
  const ROLE = `/tmp/cc-session-roles/${SID}`

  async function start([$, on]: Parameters<TestBody>, files: Record<string, string>, isInteractive = true) {
    const w = world(on, { ...RUN_FILES, ...files })
    const opened: string[] = []
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.open', ($, e) => {
      opened.push(e.id)
      return { value: {} }
    })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/fx/repo', surface: 'terminal', isInteractive })
    return { w, opened }
  }

  for (const role of ['pm', 'tl-widgets']) {
    test(`opens the pane at start for a ${role} session`, async ($, on) => {
      const { opened } = await start([$, on], { [ROLE]: role })
      expect(opened).toEqual(['workers'])
    })
  }

  for (const role of ['worker', 'tl-', 'pm-x']) {
    test(`leaves the pane closed for a ${role} session`, async ($, on) => {
      const { w, opened } = await start([$, on], { [ROLE]: role })
      await w.clock.advance(3000)
      expect(opened).toEqual([])
    })
  }

  test('opens once when the marker is written after start', async ($, on) => {
    const { w, opened } = await start([$, on], {})
    expect(opened).toEqual([])
    w.files[ROLE] = 'tl-widgets'
    await w.clock.advance(3000)
    await w.clock.advance(3000)
    expect(opened).toEqual(['workers'])
  })

  test('a headless session never opens a pane', async ($, on) => {
    const { opened } = await start([$, on], { [ROLE]: 'pm' }, false)
    expect(opened).toEqual([])
  })
})
