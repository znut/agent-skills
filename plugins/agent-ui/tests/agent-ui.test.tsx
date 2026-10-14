import { type TestBody, type TestOptions, describe, expect, test as bareTest } from 'claude-code/testing'

import { localEnvValue } from '../hooks/lib'
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

const BAND = {
  plugin: 'agent-ui',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

const ASKS = `${STATE}/asks/${SID}`

describe('workers pane', () => {
  test('rows carry kind, label, model and status from each out-dir', async ($, on) => {
    world(on, RUN_FILES)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
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
    world(on, RUN_FILES)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
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
    const w = world(on, RUN_FILES)
    const dir = `${KIDS}/b-done`
    const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await first.find({ key: `disk:${dir}` }))?.text).toContain('4m  done')
    await first.unmount()

    delete w.files[`${dir}/done`]
    delete w.files[`${dir}/exit-code`]
    w.mtimes[`${dir}/pid`] = NOW
    w.alive.add('102')
    const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await again.find({ key: `disk:${dir}` }))?.text).toContain('5m  running')
    await again.press({ key: `disk:${dir}` })
    expect(await again.find({ key: 'last-message' })).toBeUndefined()
    await again.unmount()
  })

  test('lists running runs, then only the 5 newest done runs', async ($, on) => {
    const files: Record<string, string> = {}
    for (const i of [1, 2]) Object.assign(files, under(`${KIDS}/run-${i}`, run('openai', `20${i}`)))
    for (let i = 1; i <= 7; i++) {
      Object.assign(files, under(`${KIDS}/done-${i}`, { ...run('openai', `30${i}`), done: '', 'exit-code': '0', 'end-epoch': epoch(i) }))
    }
    const w = world(on, files, ['201', '202'])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const rows = (await ui.findAll({})).map(n => n.key).filter((k): k is string => !!k?.startsWith('disk:'))
    expect(rows.map(k => k.slice(k.lastIndexOf('/') + 1)).slice(2)).toEqual(['done-1', 'done-2', 'done-3', 'done-4', 'done-5'])
    expect(rows).toHaveLength(7)
    expect(rows.slice(0, 2).every(k => k.includes('/run-'))).toBe(true)
    await ui.unmount()
    for (let i = 1; i <= 5; i++) for (const name of Object.keys(w.files)) if (name.startsWith(`${KIDS}/done-${i}/`)) delete w.files[name]
    const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const left = (await again.findAll({})).map(n => n.key).filter((k): k is string => !!k?.startsWith('disk:'))
    expect(left.map(k => k.slice(k.lastIndexOf('/') + 1)).slice(2)).toEqual(['done-6', 'done-7'])
    await again.unmount()
  })

  test('keeps up to five finished rows from each source', async ($, on) => {
    const files: Record<string, string> = {}
    for (let i = 1; i <= 6; i++) Object.assign(files, under(`${KIDS}/disk-done-${i}`, { ...run('openai', `${800 + i}`), done: '', 'exit-code': '0', 'end-epoch': epoch(i) }))
    const agents = Array.from({ length: 6 }, (_, i) => ({ id: `finished-${i}`, description: `finished ${i}`, type: 'Explore', status: 'completed' }))
    world(on, files, [], { agents })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const keys = (await ui.findAll({})).map(node => node.key).filter((key): key is string => !!key)
    expect(keys.filter(key => key.startsWith('disk:') && key.includes('/disk-done-'))).toHaveLength(5)
    expect(keys.filter(key => key.startsWith('native:finished-'))).toHaveLength(5)
    await ui.unmount()
  })

  test('an old run without done reads dead even if its pid is alive', async ($, on) => {
    const dir = `${KIDS}/old`
    world(on, under(dir, { ...run('openai', '401'), 'start-epoch': epoch(25 * 60) }), ['401'])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: `disk:${dir}` }))?.text).toContain('dead')
    await ui.unmount()
  })

  test('finished and dead elapsed time ends at the recorded end or last file mtime', async ($, on) => {
    const done = `${KIDS}/done-no-end`
    const dead = `${KIDS}/dead-mtime`
    const mtime = NOW - 2 * 60_000
    world(on, {
      ...under(done, { ...run('openai', '601'), done: '', 'exit-code': '0' }),
      ...under(dead, { ...run('openai', '602'), 'owner-session': SID }),
    }, [], { mtimes: { [`${done}/done`]: mtime, [`${dead}/pid`]: mtime } })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: `disk:${done}` }))?.text).toContain('3m  done')
    expect((await ui.find({ key: `disk:${dead}` }))?.text).toContain('3m  dead')
    await ui.unmount()
  })

  test('native agents use their transcript for detail and omit unknown model and time', async ($, on) => {
    world(on, {}, [], {
      agents: [{ id: 'agent-1', description: 'inspect sidebar', type: 'Explore', status: 'running' }, { id: 'agent-2', description: 'finished inspect', type: 'Explore', status: 'completed' }],
      transcripts: { 'agent-1': [{ role: 'assistant', text: 'native transcript tail', toolUses: [] }] },
    })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
    world(on, {
      ...RUN_FILES,
      '/fx/repo/.agent/local.env': 'state_dir=~/state\n',
      ...pr(4391),
      ...pr(4390, { title: 'Sidebar work' }),
      ...pr(4392, { isDraft: true }),
      ...pr(4389, { state: 'MERGED' }),
    })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Link', text: '#4390' }))?.props.href).toBe('https://github.com/acme/widgets/pull/4390')
    expect((await ui.find({ key: 'pr:4390' }))?.text).toContain('Sidebar work')
    const order = (await ui.findAll({})).map(node => /^pr:(\d+)$/.exec(node.key ?? '')?.[1]).filter(Boolean)
    expect(order).toEqual(['4390', '4391'])
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
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.unmount()
    const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await again.unmount()
    expect(w.reads.filter(path => path === p1)).toHaveLength(1)
    expect(w.reads.filter(path => path === p2)).toHaveLength(1)

    w.files[p1] = JSON.stringify({ number: 4420, state: 'OPEN', isDraft: false, title: 'updated', headOid: '11111111abcdef' })
    w.mtimes[p1] = 1
    const changed = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await changed.find({ key: 'pr:4420' }))?.text).toContain('updated')
    await changed.unmount()
    expect(w.reads.filter(path => path === p1)).toHaveLength(2)
    expect(w.reads.filter(path => path === p2)).toHaveLength(1)
  })

  test('a done run is not listed or re-probed on the next tick', async ($, on) => {
    const w = world(on, RUN_FILES)
    const dir = `${KIDS}/b-done`
    const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await first.unmount()
    expect(w.lists.filter(path => path === dir)).toHaveLength(1)
    const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await again.find({ key: `disk:${dir}` }))?.text).toContain('4m  done')
    await again.unmount()
    expect(w.lists.filter(path => path === dir)).toHaveLength(1)
    expect(w.reads.filter(path => path === `${dir}/pid`)).toHaveLength(1)
    expect(w.lists.filter(path => path === `${KIDS}/a-run`)).toHaveLength(2)
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
      world(on, { ...RUN_FILES, ...under(`${KIDS}/f-unknown`, { pid: '110', provider: 'gemini', 'owner-session': SID, 'start-epoch': epoch(5) }) })
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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

      const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
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
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      await w.clock.advance(1000)
      const keys = new Set(w.blits.map(blit => blit.key))
      expect([...keys].sort()).toEqual([`avatar:disk:${KIDS}/a-run`, `avatar:disk:${PANEL}/0123abcdef/code`].sort())
      expect(frames(`avatar:disk:${KIDS}/a-run`, w)).toHaveLength(4)
      expect(new Set(frames(`avatar:disk:${KIDS}/a-run`, w).map(blit => blit.rgba)).size).toBeGreaterThan(1)
      await ui.unmount()

      w.alive.clear()
      const settled = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      await w.clock.advance(1000)
      expect(w.blits).toHaveLength(80)
      await ui.unmount()
    })

    test('after unmount the engine denies blits and the timer stands down', async ($, on) => {
      const w = world(on, RUN_FILES)
      w.blitOk = true
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
      world(on, {}, [], {
        agents: [
          { id: 'p', description: 'parent', type: 'general-purpose', status: 'running' },
          { id: 'r', description: 'reviewer', type: 'reviewer', status: 'running', parentId: 'p' },
        ],
        transcripts: {
          p: [{ role: 'assistant', text: 'worker transcript', toolUses: [] }],
          r: [{ role: 'assistant', text: 'reviewer transcript', toolUses: [] }],
        },
      })
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
      const w = `${KIDS}/w-1`
      const linked = `${KIDS}/rev-linked`
      const loose = `${KIDS}/rev-loose`
      world(
        on,
        {
          ...under(w, child({ pid: '901', cwd: '/wt/x', agent: 'worker-high' })),
          ...under(linked, child({ cwd: '/wt/x', agent: 'reviewer', 'last-message': 'linked verdict', done: '', 'exit-code': '0' })),
          ...under(loose, child({ pid: '903', cwd: '/wt/other', agent: 'reviewer' })),
          ...under(`${PANEL}/0123abcdef/code`, { ...run('claude', '904'), cwd: '.', agent: 'reviewer' }),
        },
        ['901', '903', '904'],
      )
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      const top = await rowKeys(ui)
      expect(top).toContain(`disk:${w}`)
      expect(top).toContain(`disk:${loose}`)
      expect(top).toContain(`disk:${PANEL}/0123abcdef/code`)
      expect(top).not.toContain(`disk:${linked}`)

      await ui.press({ key: `disk:${w}` })
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
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
    world(on, {})
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'No child runs for this session.' })).toBeDefined()
    await ui.unmount()
  })
})

describe('asks band', () => {
  test('one row per ask; a click expands its context; an ask without a detail file says none was recorded', async ($, on) => {
    world(on, {
      ...RUN_FILES,
      [ASKS]: '#12 merge the fold?\n\n#13 pick the panel model?\n',
      [`${ASKS}.d/1.md`]: 'Fold: options A or B. Recommend A.',
    })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.findAll({ type: 'Client' })).toHaveLength(2)
      expect(await ui.find({ key: 'ask-1', in: 'ask-client-1' })).toBeDefined()
      expect(await ui.find({ type: 'Link' })).toBeDefined()
      expect(await ui.find({ key: 'ask-3', in: 'ask-client-3' })).toBeDefined()

      await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'ask-client-1' })
      expect(await ui.find({ key: 'ask-detail-1' })).toBeDefined()

      await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'ask-client-3' })
      expect(await ui.find({ key: 'ask-detail-1' })).toBeUndefined()
      expect(await ui.find({ key: 'ask-detail-3' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'no context recorded' })).toBeDefined()

      await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'ask-client-3' })
      expect(await ui.find({ type: 'Text', text: 'no context recorded' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('ticket and context links render, and options only prefill the prompt', async ($, on) => {
    const w = world(on, {
      '/fx/repo/.agent/local.env': 'state_dir=~/state\n',
      [ASKS]: 'Ship this? #4390\nReview design https://example.com/brief\n',
      [`${ASKS}.d/1.md`]: 'options: go | wait\nlink: https://example.com/mock',
      [`${ASKS}.d/2.md`]: 'options: inspect',
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'ask-client-1' })
    expect(await ui.find({ key: 'ask-detail-border' })).toBeDefined()
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    await ui.press({ key: 'ask-option-1-0' })
    expect(w.filled).toEqual(['#4390 go'])
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'ask-client-2' })
    await ui.press({ key: 'ask-option-2-0' })
    expect(w.filled).toEqual(['#4390 go', 'https://example.com/brief inspect'])
    expect(w.modes).toEqual(['insert', 'insert'])
    await ui.unmount()
  })

  test('every ask row leads with its own toggle, a ticketless ask included', async ($, on) => {
    world(on, {
      '/fx/repo/.agent/local.env': 'state_dir=~/state\n',
      [ASKS]: '#123 merge the fold?\npick the panel model?\n',
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const line = async (n: number) =>
      `${(await ui.find({ key: `ask-${n}`, in: `ask-client-${n}` }))?.text ?? ''}${(await ui.find({ key: `ask-line-${n}` }))?.text ?? ''}`
    expect(await line(1)).toMatch(/^▸ merge the fold\? *#123$/)
    expect(await line(2)).toBe('▸ pick the panel model?')
    await ui.unmount()
  })

  test('a mid-sentence #N keeps the sentence whole and links the ticket beside it', async ($, on) => {
    world(on, {
      '/fx/repo/.agent/local.env': 'state_dir=~/state\n',
      [ASKS]: 'for #123, should I send it back?\n',
      ...GIT_CONFIG,
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ key: 'ask-1', in: 'ask-client-1' }))?.text).toBe('▸ for #123, should I send it back?')
    expect((await ui.find({ type: 'Link', text: '#123' }))?.props.href).toBe('https://github.com/acme/widgets/issues/123')
    await ui.unmount()
  })

  test('only the linked #N leaves the label; any other #N stays', async ($, on) => {
    world(on, {
      '/fx/repo/.agent/local.env': 'state_dir=~/state\n',
      [ASKS]: 'see #12 and #13\n#12 merge #13\n',
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ key: 'ask-1', in: 'ask-client-1' }))?.text).toBe('▸ see #12 and #13')
    expect((await ui.find({ key: 'ask-2', in: 'ask-client-2' }))?.text).toBe('▸ merge #13')
    await ui.unmount()
  })

  describe('ticket link repository', () => {
    const files = (config?: string) => ({
      '/fx/repo/.agent/local.env': 'state_dir=~/state\n',
      [ASKS]: '#123 merge the fold?\n',
      ...(config === undefined ? {} : { '/fx/repo/.git/config': config }),
    })
    const href = async (ui: { find: (q: { type: string }) => Promise<{ props: Record<string, unknown> } | undefined> }) => (await ui.find({ type: 'Link' }))?.props.href

    test('an https origin remote names the repository; origin wins over other remotes', async ($, on) => {
      world(on, files('[remote "fork"]\n\turl = git@github.com:me/widgets.git\n[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n'))
      const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
      expect(await href(ui)).toBe('https://github.com/acme/widgets/issues/123')
      await ui.unmount()
    })

    for (const [name, config] of [['no config file', undefined], ['a non-GitHub remote', '[remote "origin"]\n\turl = git@example.com:acme/widgets.git\n']] as const) {
      test(`${name} leaves #N as plain text`, async ($, on) => {
        world(on, files(config))
        const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
        expect(await ui.find({ type: 'Link' })).toBeUndefined()
        expect((await ui.find({ key: 'ask-line-1' }))?.text).toContain('#123')
        await ui.unmount()
      })
    }

  })

  test('the childrenDir option names the child-runs directory', { options: { childrenDir: '/fx/runs/' } }, async ($, on) => {
    world(on, under('/fx/runs/x-run', run('openai', '101')))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: 'disk:/fx/runs/x-run' })).toBeDefined()
    await ui.unmount()
  })

  test('an empty childrenDir draws one hint row in place of the disk runs; native agents still list', { options: { childrenDir: '' } }, async ($, on) => {
    world(on, RUN_FILES, undefined, { agents: [{ id: 'agent-1', description: 'inspect sidebar', type: 'Explore', status: 'running' }] })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'no-children-dir' }))?.text).toBe('set childrenDir in /config')
    expect(await ui.find({ key: `disk:${KIDS}/a-run` })).toBeUndefined()
    expect(await ui.find({ key: 'native:agent-1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'No child runs for this session.' })).toBeUndefined()
    await ui.unmount()
  })

  test('unsafe http links render the asks band as plain text', async ($, on) => {
    world(on, {
      '/fx/repo/.agent/local.env': 'state_dir=~/state\n',
      [ASKS]: 'Read this http://example.com/brief\n',
      [`${ASKS}.d/1.md`]: 'link: http://example.com/context',
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ key: 'ask-1', in: 'ask-client-1' })).toBeDefined()
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'ask-client-1' })
    expect(await ui.find({ key: 'ask-detail-1' })).toBeDefined()
    expect((await ui.find({ key: 'ask-detail-1' }))?.text).toContain('http://example.com/context')
    await ui.unmount()
  })

  test('the detail shows three text lines (options among them) and the link line', async ($, on) => {
    world(on, {
      '/fx/repo/.agent/local.env': 'state_dir=~/state\n',
      [ASKS]: '#4390 review the UI?\n',
      [`${ASKS}.d/1.md`]: 'one\ntwo\noptions: go | wait\nfour\nlink: https://example.com/mock\nsix',
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'ask-client-1' })
    const detail = (await ui.find({ key: 'ask-detail-1' }))?.text ?? ''
    expect(detail).toContain('two')
    expect(detail).not.toContain('four')
    expect(detail).not.toContain('six')
    expect(await ui.find({ type: 'Link', text: 'mock' })).toBeDefined()
    expect(await ui.find({ key: 'ask-option-1-1' })).toBeDefined()
    await ui.unmount()
  })

  test('an expanded ask draws links and its context border', async ($, on) => {
    world(on, {
      '/fx/repo/.agent/local.env': 'state_dir=~/state\n',
      [ASKS]: '#4390 review the UI?\n',
      [`${ASKS}.d/1.md`]: 'Problem: layout needs hierarchy\nlink: https://github.com/acme/widgets/pull/4390\n',
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'ask-client-1' })
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    expect(await ui.find({ key: 'ask-detail-border' })).toBeDefined()
    await ui.unmount()
  })

  test('an expanded ask closes once its line is gone', async ($, on) => {
    const w = world(on, { ...RUN_FILES, [ASKS]: '#12 merge the fold?\n', [`${ASKS}.d/1.md`]: 'Recommend A.' })
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/fx/repo', surface: 'terminal', isInteractive: true })

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'ask-client-1' })
    expect((await ui.find({ key: 'ask-detail-1' }))?.text).toContain('Recommend A.')
    await ui.unmount()

    w.files[ASKS] = ''
    await w.clock.advance(3000)
    w.files[ASKS] = '#12 merge the fold?\n'
    const again = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await again.find({ key: 'ask-1', in: 'ask-client-1' })).toBeDefined()
    expect(await again.find({ key: 'ask-detail-1' })).toBeUndefined()
    await again.unmount()
  })

  test('a right-click on an ask line drops it, its detail file and the later numbering with it', async ($, on) => {
    const w = world(on, {
      ...RUN_FILES,
      [ASKS]: '#11 first?\n#12 second?\n#13 third?\n',
      [`${ASKS}.d/1.md`]: 'one',
      [`${ASKS}.d/3.md`]: 'three',
    })
    w.redraws = true
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    // The terminal's hit test never reaches a Client's pointer listener past a pressable inside it.
    expect(await ui.findAll({ type: 'Button', in: 'ask-client-2' })).toHaveLength(0)
    await ui.pointer({ type: 'up', x: 2, y: 0, button: 'right', in: 'ask-client-2' })
    await ui.pointer({ type: 'down', x: 2, y: 0, button: 'middle', in: 'ask-client-2' })
    expect(w.dismissed).toEqual([])
    await ui.pointer({ type: 'down', x: 2, y: 0, button: 'right', in: 'ask-client-2' })
    expect(w.dismissed).toEqual(['#12 second?'])
    expect(w.files[ASKS]).toBe('#11 first?\n#13 third?\n')
    expect(w.files[`${ASKS}.d/1.md`]).toBe('one')
    expect(w.files[`${ASKS}.d/2.md`]).toBe('three')
    expect(w.files[`${ASKS}.d/3.md`]).toBeUndefined()
    expect(await ui.find({ key: 'ask-client-3' })).toBeUndefined()
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'ask-client-2' })
    expect((await ui.find({ key: 'ask-detail-2' }))?.text).toContain('three')
    await ui.unmount()
  })

  test('a right-click on the only ask empties the file and hides the band', async ($, on) => {
    const w = world(on, { ...RUN_FILES, [ASKS]: '#12 merge the fold?\n', [`${ASKS}.d/1.md`]: 'Recommend A.' })
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine band</Text>
    })
    w.redraws = true
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'ask-client-1' })
    expect(await ui.find({ key: 'ask-detail-1' })).toBeDefined()
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'right', in: 'ask-client-1' })
    expect(w.files[ASKS]).toBe('')
    expect(w.files[`${ASKS}.d/1.md`]).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    // The dismissed ask was the open one: pinned again, it draws closed.
    w.files[ASKS] = '#12 merge the fold?\n'
    await ui.redraw()
    expect(await ui.find({ key: 'ask-client-1' })).toBeDefined()
    expect(await ui.find({ key: 'ask-detail-1' })).toBeUndefined()
    await ui.unmount()
  })

  for (const [name, asks] of [
    ['empty', ''],
    ['absent', undefined],
  ] as const) {
    test(`an ${name} asks file draws nothing of its own`, async ($, on) => {
      world(on, asks === undefined ? RUN_FILES : { ...RUN_FILES, [ASKS]: asks })
      on('ui.render', ($, e) => {
        const { Text } = $.ui.resolve(e)
        return <Text>engine band</Text>
      })
      for (const surface of SURFACES) {
        const ui = await $.ui.mount({ ...BAND, surface })
        expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
        expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
        await ui.unmount()
      }
    })
  }
})

describe('local.env', () => {
  test('a value is everything after the first =; # lines are skipped; ~/ is HOME', () => {
    const text = '# state_dir=/wrong\nother=x\nstate_dir=~/a=b/\n'
    expect(localEnvValue(text, 'state_dir', '/home/me')).toBe('/home/me/a=b')
    expect(localEnvValue(text, 'worktrees_dir', '/home/me')).toBeNull()
    expect(localEnvValue('state_dir=\n', 'state_dir', '/home/me')).toBeNull()
  })

  for (const [name, env] of [['no state_dir key', 'worktrees_dir=~/wt\n'], ['no local.env', undefined]] as const) {
    test(`${name} draws no asks`, async ($, on) => {
      const files: Record<string, string> = { ...RUN_FILES, [ASKS]: '#12 merge the fold?\n' }
      delete files['/fx/repo/.agent/local.env']
      world(on, env === undefined ? files : { ...files, '/fx/repo/.agent/local.env': env })
      on('ui.render', ($, e) => {
        const { Text } = $.ui.resolve(e)
        return <Text>engine band</Text>
      })
      const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
      expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
      await ui.unmount()
    })
  }
})

describe('asks band: done tickets', () => {
  const MD = '/fx/repo/.agent/local.env'
  const CONFIG = 'state_dir=~/state\n'
  const pr = (n: number, state: string) => ({ [`${STATE}/gh-status/status/pr-${n}.json`]: JSON.stringify({ number: n, state, isDraft: false }) })
  const board = (...rows: [number, string][]) => ({
    [`${STATE}/board-snapshot.md`]: ['| # | Title | Status | Service | Tier | Week | Milestone | Blocked-by |', ...rows.map(([n, status]) => `| #${n} | a \\| Done \\| title | ${status} | Web | Free | Week 16 | M7 | — |`)].join('\n'),
  })
  const shown = async (ui: { find: (query: { key: string }) => Promise<unknown> }, lines: number[]) =>
    Promise.all(lines.map(async n => (await ui.find({ key: `ask-client-${n}` })) !== undefined))

  test('hides asks keyed by a merged or closed PR or a Done issue; keeps open, unknown and ticketless asks', async ($, on) => {
    world(on, {
      ...RUN_FILES,
      [MD]: CONFIG,
      [ASKS]: '#4460 merged pr?\n#4461 closed pr?\n#4462 done issue?\n#4463 open pr?\n#4464 no status file?\n#4465 backlog issue?\nticketless ask?\n',
      ...pr(4460, 'MERGED'),
      ...pr(4461, 'CLOSED'),
      ...pr(4463, 'OPEN'),
      ...board([4462, 'Done'], [4465, 'Backlog']),
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await shown(ui, [1, 2, 3, 4, 5, 6, 7])).toEqual([false, false, false, true, true, true, true])
    await ui.unmount()
  })

  test('a merge after the band was drawn hides the ask on the next render', async ($, on) => {
    const file = `${STATE}/gh-status/status/pr-4470.json`
    const w = world(on, { ...RUN_FILES, [MD]: CONFIG, [ASKS]: '#4470 run the bake-off once it merges?\n', ...pr(4470, 'OPEN') })
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine band</Text>
    })
    const first = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await shown(first, [1])).toEqual([true])
    await first.unmount()
    w.files[file] = JSON.stringify({ number: 4470, state: 'MERGED', isDraft: false })
    w.mtimes[file] = 1
    const second = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await shown(second, [1])).toEqual([false])
    expect(await second.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await second.unmount()
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
    world(on, chainFiles('4545 4549 4552 4560\n\n#4570\n'), undefined, { agents })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
    world(on, chainFiles('4545 4549 4552\n'), undefined, { agents })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
      world(on, files)
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
