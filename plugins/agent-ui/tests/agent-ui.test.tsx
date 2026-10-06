import { describe, expect, test } from 'claude-code/testing'

import { type Metric, axisLabels, barMax, barParts, cardPlace, cardTable, chartBytes, chartTiles, jobColor, markCancelled, parseRows, runCell, runsFit, summarize, withPending } from '../hooks/ci'
import { avatarCells, avatarPicture, dim } from '../hooks/sprites'
import { epoch, GIT_CONFIG, KIDS, NOW, PANEL, RUN_FILES, run, SID, STATE, under, world } from './world'

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
      expect(await row(`${KIDS}/c-dead`)).toContain('kimi c-dead  kimi/opus')
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

  test('missing provider is inferred only from Codex run evidence', async ($, on) => {
    const codex = `${KIDS}/codex-evidence`
    const model = `${KIDS}/model-evidence`
    const unknown = `${KIDS}/unknown`
    world(on, {
      ...under(codex, { pid: '501', 'owner-session': SID, 'start-epoch': epoch(5), 'result.jsonl': '{}' }),
      ...under(model, { pid: '502', 'owner-session': SID, 'start-epoch': epoch(5), 'full-model': 'gpt-5.1-codex' }),
      ...under(unknown, { pid: '503', 'owner-session': SID, 'start-epoch': epoch(5) }),
    }, ['501', '502', '503'])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: `disk:${codex}` }))?.text).toContain('gpt codex-evidence  gpt/?')
    expect((await ui.find({ key: `disk:${model}` }))?.text).toContain('gpt model-evidence  gpt/5.1-codex')
    expect((await ui.find({ key: `disk:${unknown}` }))?.text).toContain('? unknown  ?/?')
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

  test('old runs without an owner session are hidden', async ($, on) => {
    const dir = `${KIDS}/old-unowned`
    world(on, under(dir, { pid: '701', provider: 'kimi', 'start-epoch': epoch(25 * 60) }), ['701'])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: `disk:${dir}` })).toBeUndefined()
    await ui.unmount()
  })

  test('checks an unowned run age against the current clock after probe caching', async ($, on) => {
    const dir = `${KIDS}/ages-out`
    const w = world(on, under(dir, { pid: '702', provider: 'kimi', 'start-epoch': epoch(20 * 60) }), ['702'])
    const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await first.find({ key: `disk:${dir}` })).toBeDefined()
    await first.unmount()
    await w.clock.advance(5 * 3_600_000)
    const later = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await later.find({ key: `disk:${dir}` })).toBeUndefined()
    await later.unmount()
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

  test('ready PRs and main CI state come from local status files', async ($, on) => {
    const root = '/fx/home/state'
    const mainSha = 'abcdef0123456789'
    const head = '12345678abcdef00'
    world(on, {
      ...RUN_FILES,
      '/fx/repo/.agent/orchestrate.local.md': '- `session_bus_dir`: `~/state/bus`\n- `gh_status_dir`: `~/state/gh-status`\n',
      [`${root}/main-ci/state.json`]: JSON.stringify({ sha: mainSha, green: true, phase: 'done' }),
      [`${root}/main-ci/run.log`]: `preview #4390 ${head.slice(0, 8)}-${mainSha.slice(0, 8)}: queued (ready)\npreview #4390 ${head.slice(0, 8)}-${mainSha.slice(0, 8)}: green\n`,
      [`${root}/gh-status/status/pr-4390.json`]: JSON.stringify({ number: 4390, state: 'OPEN', isDraft: false, title: 'Sidebar work', headOid: head, createdAt: '2026-01-01' }),
      [`${root}/gate/pr-4390/${head.slice(0, 8)}-${mainSha.slice(0, 8)}.json`]: JSON.stringify({ green: false, conflict: true }),
    })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(/preview (\d+\/\d+)/.exec((await ui.find({ key: 'main-strip' }))?.text ?? '')?.[1]).toBe('0/0')
    expect((await ui.find({ type: 'Link', text: '#4390' }))?.props.href).toBe('https://github.com/acme/widgets/pull/4390')
    expect((await ui.find({ type: 'Text', text: 'green' }))?.props.color).toBe('green')
    expect((await ui.find({ key: 'pr:4390' }))?.text).toContain('Sidebar work ✗ ⚡ conflict')
    await ui.unmount()
  })

  test('main strip uses state with an empty log; status cache reads only changed PR files', async ($, on) => {
    const root = '/fx/home/state'
    const p1 = `${root}/gh-status/status/pr-4420.json`
    const p2 = `${root}/gh-status/status/pr-4421.json`
    const w = world(on, {
      '/fx/repo/.agent/orchestrate.local.md': '- `session_bus_dir`: `~/state/bus`\n- `gh_status_dir`: `~/state/gh-status`\n',
      [`${root}/main-ci/state.json`]: JSON.stringify({ sha: 'feedbeef12345678', phase: 'running' }),
      [`${root}/main-ci/run.log`]: '',
      [p1]: JSON.stringify({ number: 4420, state: 'OPEN', isDraft: false, title: 'one', headOid: '11111111abcdef' }),
      [p2]: JSON.stringify({ number: 4421, state: 'OPEN', isDraft: false, title: 'two', headOid: '22222222abcdef' }),
    })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(/preview (\d+\/\d+)/.exec((await ui.find({ key: 'main-strip' }))?.text ?? '')?.[1]).toBe('0/0')
    expect((await ui.find({ type: 'Text', text: 'running' }))?.props.color).toBeUndefined()
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

  describe('preview queue', () => {
    const root = '/fx/home/state'
    const MAIN = 'abcdef01'
    const queued = (n: number) => `preview #${n} 1111111${n % 10}-${MAIN}: queued (ready)`
    const start = (n: number) => `preview #${n} 1111111${n % 10}-${MAIN}: start`
    const queueFiles = (log: string) => ({
      '/fx/repo/.agent/orchestrate.local.md': '- `session_bus_dir`: `~/state/bus`\n- `gh_status_dir`: `~/state/gh-status`\n',
      [`${root}/main-ci/state.json`]: JSON.stringify({ sha: `${MAIN}23456789`, green: true }),
      [`${root}/main-ci/run.log`]: log,
    })
    for (const [name, log, expected] of [
      ['queued only', [queued(4390)], '0/1'],
      ['queued then start', [queued(4390), start(4390)], '1/0'],
      ['one running and one queued', [start(4390), queued(4391)], '1/1'],
      ['start then green', [start(4390), `preview #4390 11111110-${MAIN}: green`], '0/0'],
      ['red result drains a queued preview', [queued(4390), `preview #4390 11111110-${MAIN}: RED — /x/pr-4390/log`], '0/0'],
      ['conflict drains a queued preview', [queued(4390), `preview #4390 11111110-${MAIN}: CONFLICT`], '0/0'],
      ['cancel without a sha pair drains it', [queued(4390), 'preview #4390: cancelled'], '0/0'],
      ['head move without a sha pair drains it', [queued(4390), 'preview #4390: head moved 11111110 -> 22222222; cancelling its preview'], '0/0'],
      ['requeue on a new head replaces the running state', [start(4390), `preview #4390 22222222-${MAIN}: queued (ready)`], '0/1'],
      ['an older main is excluded', ['preview #4390 11111110-ffffffff: queued (ready)'], '0/0'],
    ] as const) {
      test(name, async ($, on) => {
        world(on, queueFiles(`${log.join('\n')}\n`))
        const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
        expect(/preview (\d+\/\d+)/.exec((await ui.find({ key: 'main-strip' }))?.text ?? '')?.[1]).toBe(expected)
        await ui.unmount()
      })
    }
  })

  test('Needs you sorts green, pending, then red or conflict; oldest number first within a group', async ($, on) => {
    const root = '/fx/home/state'
    const main = 'abcdef0123456789'
    const pr = (n: number) => ({
      [`${root}/gh-status/status/pr-${n}.json`]: JSON.stringify({ number: n, state: 'OPEN', isDraft: false, title: `t${n}`, headOid: `${n}0000abcdef` }),
    })
    const gate = (n: number, result: Record<string, boolean>) => ({
      [`${root}/gate/pr-${n}/${n}0000-${main.slice(0, 8)}.json`]: JSON.stringify(result),
    })
    world(on, {
      '/fx/repo/.agent/orchestrate.local.md': '- `session_bus_dir`: `~/state/bus`\n- `gh_status_dir`: `~/state/gh-status`\n',
      [`${root}/main-ci/state.json`]: JSON.stringify({ sha: main, green: true }),
      ...[4404, 4403, 4402, 4401, 4400, 4399].reduce((all, n) => ({ ...all, ...pr(n) }), {}),
      ...gate(4404, { green: true }),
      ...gate(4403, { green: false }),
      ...gate(4402, { green: false, conflict: true }),
      ...gate(4400, { green: true }),
    })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const order = (await ui.findAll({})).map(node => /^pr:(\d+)$/.exec(node.key ?? '')?.[1]).filter(Boolean)
    expect(order).toEqual(['4400', '4404', '4399', '4401', '4402', '4403'])
    await ui.unmount()
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
    const frames = (key: string, w: { blits: { key: string; cells?: string; rgba?: string }[] }) => w.blits.filter(blit => blit.key === key)
    const bytes = (base64: string) => Uint8Array.from(atob(base64), ch => ch.charCodeAt(0))
    const pixel = (rgba: string, x: number, y: number) => [...bytes(rgba).slice((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)]
    const rgb = (n: number) => [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]

    test('a sprite frame is 16x16 RGBA in its palette; done dims it, failed turns it red', () => {
      const run = avatarPicture('claude', 'running', 0)
      expect(run.source).toMatchObject({ width: 16, height: 16 })
      expect(bytes(run.source.rgba)).toHaveLength(16 * 16 * 4)
      expect(pixel(run.source.rgba, 3, 2)).toEqual(rgb(0xd97757))
      expect(pixel(run.source.rgba, 5, 4)).toEqual(rgb(0x1a1a1a))
      expect(pixel(run.source.rgba, 0, 0)[3]).toBe(0)
      expect(pixel(avatarPicture('claude', 'done', 0).source.rgba, 3, 2)).toEqual(rgb(dim(0xd97757)))
      expect(pixel(avatarPicture('claude', 'failed', 0).source.rgba, 3, 2)).toEqual(rgb(0xe06c75))
      expect(pixel(avatarPicture('kimi', 'running', 0).source.rgba, 13, 2)).toEqual(rgb(0x5b7fff))
      expect(avatarPicture('claude', 'running', 1).source.rgba).not.toBe(run.source.rgba)
    })

    test('the gpt knot is 32x32 and spins through four frames that loop', () => {
      const frames = [0, 1, 2, 3, 4].map(tick => avatarPicture('gpt', 'running', tick))
      expect(frames[0]?.source).toMatchObject({ width: 32, height: 32 })
      expect(bytes(frames[0]?.source.rgba ?? '')).toHaveLength(32 * 32 * 4)
      expect(new Set(frames.slice(0, 4).map(frame => frame.source.rgba)).size).toBe(4)
      expect(frames[4]?.source.rgba).toBe(frames[0]?.source.rgba)
      expect(bytes(avatarPicture('gpt', 'done', 0).source.rgba)).toHaveLength(32 * 32 * 4)
    })

    test('the alt text is the braille the Raster draws at the same tick, two cells wide', () => {
      for (const avatar of ['claude', 'gpt', 'kimi'] as const) {
        for (const tick of [0, 1, 2, 3]) {
          const words = new Uint32Array(bytes(avatarCells(avatar, 'running', tick)).buffer)
          expect(words).toHaveLength(2 * 3)
          expect(avatarPicture(avatar, 'running', tick).alt).toBe(String.fromCodePoint(words[0] ?? 0, words[3] ?? 0))
        }
      }
    })

    test('terminal rows draw a picture per status in place of the mark; other surfaces keep the mark', async ($, on) => {
      world(on, { ...RUN_FILES, ...under(`${KIDS}/f-unknown`, { pid: '110', 'owner-session': SID, 'start-epoch': epoch(5) }) })
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
      expect(frames(`avatar:disk:${KIDS}/a-run`, w).every(blit => blit.rgba && !blit.cells)).toBe(true)
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

    test('a terminal that draws the alt switches the pane to braille Rasters', async ($, on) => {
      const w = world(on, RUN_FILES)
      w.blitOk = true
      w.imageDeny = 'the Image draws its alt here'
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      await w.clock.advance(250)
      await w.clock.advance(1000)
      // one redraw, no loop: the Raster pane's blits are cells, which never read as alt
      expect(w.invalidated).toBe(1)
      await ui.unmount()

      w.imageDeny = undefined
      const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
      expect((await avatarOf(again, `${KIDS}/a-run`))?.type).toBe('Raster')
      await w.clock.advance(250)
      expect(frames(`avatar:disk:${KIDS}/a-run`, w).every(blit => blit.cells && !blit.rgba)).toBe(true)
      expect(frames(`avatar:disk:${KIDS}/a-run`, w)).toHaveLength(1)
      await again.unmount()
    })

    test('31 running rows are all listed; animation still stops at 20', async ($, on) => {
      const files: Record<string, string> = {}
      for (let i = 0; i < 31; i++) Object.assign(files, under(`${KIDS}/m-${i}`, run('openai', `70${i}`)))
      const w = world(on, files, Array.from({ length: 31 }, (_, i) => `70${i}`))
      w.blitOk = true
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      // the plugin loads afresh per test: the alt switch above does not carry over
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

  test('a non-git cwd and root draw no strip; a repo cwd resolves afresh; one cwd runs git once', async ($, on) => {
    const root = '/fx/home/state'
    const w = world(on, {
      '/fx/repo/.agent/orchestrate.local.md': '- `session_bus_dir`: `~/state/bus`\n- `gh_status_dir`: `~/state/gh-status`\n',
      [`${root}/main-ci/state.json`]: JSON.stringify({ sha: 'abcdef0123456789', green: true }),
    })
    const strip = async () => {
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      const found = await ui.find({ key: 'main-strip' })
      await ui.unmount()
      return found
    }
    w.cwd = '/fx/elsewhere'
    w.root = '/fx/elsewhere'
    expect(await strip()).toBeUndefined()
    expect(await strip()).toBeUndefined()
    expect(w.gitRuns).toBe(1)

    w.cwd = '/fx/repo'
    expect((await strip())?.text).toContain('main abcdef01')
    const inRepo = w.gitRuns
    expect(await strip()).toBeDefined()
    expect(w.gitRuns).toBe(inRepo)

    w.cwd = '/fx/elsewhere'
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
      expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
      expect(await ui.find({ key: 'ask-1' })).toBeDefined()
      expect(await ui.find({ type: 'Link' })).toBeDefined()
      expect(await ui.find({ key: 'ask-3' })).toBeDefined()

      await ui.press({ key: 'ask-1' })
      expect(await ui.find({ key: 'ask-detail-1' })).toBeDefined()

      await ui.press({ key: 'ask-3' })
      expect(await ui.find({ key: 'ask-detail-1' })).toBeUndefined()
      expect(await ui.find({ key: 'ask-detail-3' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'no context recorded' })).toBeDefined()

      await ui.press({ key: 'ask-3' })
      expect(await ui.find({ type: 'Text', text: 'no context recorded' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('ticket and context links render, and options only prefill the prompt', async ($, on) => {
    const w = world(on, {
      '/fx/repo/.agent/orchestrate.local.md': '- `session_bus_dir`: `~/state/bus`\n',
      [ASKS]: 'Ship this? #4390\nReview design https://example.com/brief\n',
      [`${ASKS}.d/1.md`]: 'options: go | wait\nlink: https://example.com/mock',
      [`${ASKS}.d/2.md`]: 'options: inspect',
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    await ui.press({ key: 'ask-1' })
    expect(await ui.find({ key: 'ask-detail-border' })).toBeDefined()
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    await ui.press({ key: 'ask-option-1-0' })
    expect(w.filled).toEqual(['#4390 go'])
    await ui.press({ key: 'ask-2' })
    await ui.press({ key: 'ask-option-2-0' })
    expect(w.filled).toEqual(['#4390 go', 'https://example.com/brief inspect'])
    expect(w.modes).toEqual(['insert', 'insert'])
    await ui.unmount()
  })

  test('every ask row leads with its own toggle, a ticketless ask included', async ($, on) => {
    world(on, {
      '/fx/repo/.agent/orchestrate.local.md': '- `session_bus_dir`: `~/state/bus`\n',
      [ASKS]: '#123 merge the fold?\npick the panel model?\n',
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const line = async (n: number) => (await ui.find({ key: `ask-line-${n}` }))?.text ?? ''
    expect(await line(1)).toMatch(/^▸ merge the fold\? *#123$/)
    expect(await line(2)).toBe('▸ pick the panel model?')
    await ui.unmount()
  })

  test('a mid-sentence #N keeps the sentence whole and links the ticket beside it', async ($, on) => {
    world(on, {
      '/fx/repo/.agent/orchestrate.local.md': '- `session_bus_dir`: `~/state/bus`\n',
      [ASKS]: 'for #123, should I send it back?\n',
      ...GIT_CONFIG,
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ key: 'ask-1' }))?.text).toBe('▸ for #123, should I send it back?')
    expect((await ui.find({ type: 'Link', text: '#123' }))?.props.href).toBe('https://github.com/acme/widgets/issues/123')
    await ui.unmount()
  })

  test('only the linked #N leaves the label; any other #N stays', async ($, on) => {
    world(on, {
      '/fx/repo/.agent/orchestrate.local.md': '- `session_bus_dir`: `~/state/bus`\n',
      [ASKS]: 'see #12 and #13\n#12 merge #13\n',
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ key: 'ask-1' }))?.text).toBe('▸ see #12 and #13')
    expect((await ui.find({ key: 'ask-2' }))?.text).toBe('▸ merge #13')
    await ui.unmount()
  })

  describe('ticket link repository', () => {
    const files = (config?: string) => ({
      '/fx/repo/.agent/orchestrate.local.md': '- `session_bus_dir`: `~/state/bus`\n',
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

    test('the repoSlug option wins over the remote', { options: { repoSlug: 'other/thing' } }, async ($, on) => {
      world(on, files(GIT_CONFIG['/fx/repo/.git/config']))
      const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
      expect(await href(ui)).toBe('https://github.com/other/thing/issues/123')
      await ui.unmount()
    })
  })

  test('the childrenDir option replaces the default child-runs directory', { options: { childrenDir: '/fx/runs/' } }, async ($, on) => {
    world(on, under('/fx/runs/x-run', run('openai', '101')))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: 'disk:/fx/runs/x-run' })).toBeDefined()
    await ui.unmount()
  })

  test('unsafe http links render the asks band as plain text', async ($, on) => {
    world(on, {
      '/fx/repo/.agent/orchestrate.local.md': '- `session_bus_dir`: `~/state/bus`\n',
      [ASKS]: 'Read this http://example.com/brief\n',
      [`${ASKS}.d/1.md`]: 'link: http://example.com/context',
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ key: 'ask-1' })).toBeDefined()
    await ui.press({ key: 'ask-1' })
    expect(await ui.find({ key: 'ask-detail-1' })).toBeDefined()
    expect((await ui.find({ key: 'ask-detail-1' }))?.text).toContain('http://example.com/context')
    await ui.unmount()
  })

  test('the detail shows three text lines (options among them) and the link line', async ($, on) => {
    world(on, {
      '/fx/repo/.agent/orchestrate.local.md': '- `session_bus_dir`: `~/state/bus`\n',
      [ASKS]: '#4390 review the UI?\n',
      [`${ASKS}.d/1.md`]: 'one\ntwo\noptions: go | wait\nfour\nlink: https://example.com/mock\nsix',
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'ask-1' })
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
      '/fx/repo/.agent/orchestrate.local.md': '- `session_bus_dir`: `~/state/bus`\n',
      [ASKS]: '#4390 review the UI?\n',
      [`${ASKS}.d/1.md`]: 'Problem: layout needs hierarchy\nlink: https://github.com/acme/widgets/pull/4390\n',
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'ask-1' })
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
    await ui.press({ key: 'ask-1' })
    expect((await ui.find({ key: 'ask-detail-1' }))?.text).toContain('Recommend A.')
    await ui.unmount()

    w.files[ASKS] = ''
    await w.clock.advance(3000)
    w.files[ASKS] = '#12 merge the fold?\n'
    const again = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await again.find({ key: 'ask-1' })).toBeDefined()
    expect(await again.find({ key: 'ask-detail-1' })).toBeUndefined()
    await again.unmount()
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

describe('asks band: done tickets', () => {
  const MD = '/fx/repo/.agent/orchestrate.local.md'
  const CONFIG = '- `session_bus_dir`: `~/state/bus`\n- `gh_status_dir`: `~/state/gh-status`\n- `board_snapshot_file`: `~/state/board-snapshot.md`\n'
  const pr = (n: number, state: string) => ({ [`${STATE}/gh-status/status/pr-${n}.json`]: JSON.stringify({ number: n, state, isDraft: false }) })
  const board = (...rows: [number, string][]) => ({
    [`${STATE}/board-snapshot.md`]: ['| # | Title | Status | Service | Tier | Week | Milestone | Blocked-by |', ...rows.map(([n, status]) => `| #${n} | a \\| Done \\| title | ${status} | Web | Free | Week 16 | M7 | — |`)].join('\n'),
  })
  const shown = async (ui: { find: (query: { key: string }) => Promise<unknown> }, lines: number[]) =>
    Promise.all(lines.map(async n => (await ui.find({ key: `ask-${n}` })) !== undefined))

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

describe('main-ci chart', () => {
  const CI = `${STATE}/main-ci`
  const METRICS = `${CI}/metrics.jsonl`
  const MD = { '/fx/repo/.agent/orchestrate.local.md': '- `session_bus_dir`: `~/state/bus`\n- `gh_status_dir`: `~/state/gh-status`\n' }
  const name = (i: number) => `20260101T0000${String(i).padStart(2, '0')}Z-cafe00${String(i).padStart(2, '0')}`
  const sha = (i: number) => `cafe00${String(i).padStart(2, '0')}0123456789abcdef0123456789abcdef`
  const row = (i: number, job: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ run: name(i), sha: sha(i), job, kind: 'core', attempt: 1, wall_s: 10, cpu_user_s: 2, cpu_sys_s: 1, max_rss_mb: 100, exit: 0, load1_start: 2, ...extra })
  const runRows = (i: number, jobs = ['lint', 'test']) => jobs.map(job => row(i, job)).join('\n')
  const metrics = (count: number) => `${Array.from({ length: count }, (_, i) => runRows(i + 1)).join('\n')}\n`
  const files = (text: string, state: Record<string, unknown> = { sha: sha(3), green: true, phase: 'done' }) => ({
    ...MD,
    [`${CI}/state.json`]: JSON.stringify(state),
    [METRICS]: text,
  })
  const pane = (bodyColumns = 120, surface: 'terminal' | 'desktop' = 'terminal') => ({ ...PANE, surface, props: { ...PANE.props, bodyColumns } })
  const cards = async (ui: { findAll: (q: object) => Promise<{ key?: string }[]> }) =>
    (await ui.findAll({})).map(node => node.key ?? '').filter(key => key.startsWith('ci-run:'))
  // The drawn tree in document order; `find` leaves out an element's hover, the tree keeps it.
  type Drawn = { type?: string; props?: Record<string, unknown>; hover?: { scope?: string; display?: string }; children?: unknown[] }
  const walk = (node: unknown, out: Drawn[] = []): Drawn[] => {
    if (typeof node !== 'object' || node === null) return out
    out.push(node as Drawn)
    for (const child of (node as Drawn).children ?? []) walk(child, out)
    return out
  }
  const textOf = (node: unknown): string =>
    typeof node === 'string' ? node : typeof node === 'object' && node !== null ? ((node as Drawn).children ?? []).map(textOf).join('') : ''
  // a run's card: the hidden Box its run column's hover scope reveals
  const cardOf = async (ui: { drawn: () => Promise<unknown> }, run: string) =>
    walk(await ui.drawn()).find(node => node.hover?.scope === `ci:${run}` && node.props?.display === 'none')

  test('a run keeps each job at its final attempt and counts its retries', () => {
    const rows = parseRows([
      row(1, 'lint'),
      row(1, 'test', { exit: 1 }),
      row(1, 'test', { attempt: 2, wall_s: 30 }),
      JSON.stringify({ run: name(1), job: 'preview-7', kind: 'preview', wall_s: 99 }),
      'not json',
    ].join('\n'))
    expect(rows).toHaveLength(3)
    const run = summarize(name(1), rows)
    expect(run.jobs.map(job => [job.job, job.wall, job.retries])).toEqual([['lint', 10, 0], ['test', 30, 1]])
    expect(run).toMatchObject({ sha8: 'cafe0001', green: true, retries: 1, load: 2, peak: 100, pending: false })
    expect(summarize(name(2), parseRows(row(2, 'lint', { exit: 2 }))).green).toBe(false)
  })

  test('the run main-ci is on is pending; an unstarted one is an empty slot', () => {
    const runs = [1, 2].map(i => summarize(name(i), parseRows(runRows(i))))
    expect(withPending(runs, { sha: sha(2), phase: 'done' }).map(run => run.pending)).toEqual([false, false])
    expect(withPending(runs, { sha: sha(2), phase: 'builds' }).map(run => run.pending)).toEqual([false, true])
    expect(withPending(runs, { sha: sha(1), phase: 'done' }).map(run => run.pending)).toEqual([false, true])
    const slot = withPending(runs, { sha: sha(9), phase: 'builds' })
    expect(slot.map(run => [run.sha8, run.pending, run.jobs.length])).toEqual([['cafe0001', false, 2], ['cafe0002', false, 2], ['cafe0009', true, 0]])
  })

  test('a job keeps its color whatever other jobs exist', () => {
    expect(jobColor('test')).toBe(jobColor('test'))
    const pixelOf = (jobs: string[]) => {
      const { bytes } = chartBytes([summarize(name(1), parseRows(jobs.map(job => row(1, job)).join('\n')))])
      return [...bytes.slice((67 * 12 + 5) * 4, (67 * 12 + 5) * 4 + 3)]
    }
    const rgb = (n: number) => [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    expect(pixelOf(['aaa'])).toEqual(rgb(jobColor('aaa')))
    expect(pixelOf(['aaa', 'zzz'])).toEqual(rgb(jobColor('aaa')))
  })

  test('the picture is 12x72 pixels a run; a red run is underlined, a retry counted in red', () => {
    const red = summarize(name(1), parseRows([row(1, 'lint', { exit: 1 }), row(1, 'lint', { attempt: 2, exit: 1 })].join('\n')))
    const { bytes, width, height } = chartBytes([red, summarize(name(2), parseRows(runRows(2)))])
    expect([width, height]).toEqual([24, 72])
    const at = (x: number, y: number) => [...bytes.slice((y * 24 + x) * 4, (y * 24 + x) * 4 + 4)]
    expect(at(5, 70)).toEqual([0xe6, 0x5a, 0x50, 255])
    expect(at(17, 70)[3]).toBe(0)
    const redAbove = Array.from({ length: 40 }, (_, y) => at(5, y)).some(px => px[0] === 0xe6 && px[1] === 0x5a)
    expect(redAbove).toBe(true)
  })

  test('collapsed by default; the toggle opens the chart and stays open', async ($, on) => {
    world(on, files(metrics(3)))
    const ui = await $.ui.mount(pane())
    expect((await ui.find({ key: 'main-strip' }))?.text).toContain('▸ main cafe0003')
    expect(await ui.find({ key: 'ci' })).toBeUndefined()
    await ui.press({ key: 'ci-toggle' })
    expect(await ui.find({ key: 'ci' })).toBeDefined()
    expect((await ui.find({ key: 'ci' }))?.text).toContain('last 3 runs')
    await ui.unmount()
    const again = await $.ui.mount(pane())
    expect(await again.find({ key: 'ci' })).toBeDefined()
    await again.unmount()
  })

  test('the pane width sets how many runs show, two columns each past the axis', async ($, on) => {
    expect(runsFit(50)).toBe(22)
    expect(runsFit(5)).toBe(0)
    world(on, files(metrics(15)))
    const ui = await $.ui.mount(pane(26))
    await ui.press({ key: 'ci-toggle' })
    expect(await cards(ui)).toHaveLength(10)
    expect((await ui.find({ key: `ci-bar:${name(15)}` }))?.props).toMatchObject({ columns: 2, rows: 6 })
    expect((await cards(ui)).at(-1)).toBe(`ci-run:${name(15)}`)
    await ui.unmount()
  })

  test('metrics.jsonl is read once, then only its appended lines; a partial line is read again whole', async ($, on) => {
    const w = world(on, files(metrics(2)))
    const ui = await $.ui.mount(pane())
    await ui.press({ key: 'ci-toggle' })
    await ui.unmount()
    const size = w.files[METRICS]?.length ?? 0
    expect(w.tails).toEqual([`+1 ${METRICS}`])

    const again = await $.ui.mount(pane())
    await again.unmount()
    expect(w.tails).toHaveLength(1)

    const half = row(3, 'lint')
    w.files[METRICS] += half.slice(0, 20)
    const partial = await $.ui.mount(pane())
    expect(await cards(partial)).toHaveLength(2)
    await partial.unmount()
    expect(w.tails.at(-1)).toBe(`+${size + 1} ${METRICS}`)

    w.files[METRICS] += `${half.slice(20)}\n`
    const whole = await $.ui.mount(pane())
    expect(await cards(whole)).toHaveLength(3)
    await whole.unmount()
    expect(w.tails.at(-1)).toBe(`+${size + 1} ${METRICS}`)
  })

  test("a run's card lists its 8 slowest jobs and stays inside the pane", async ($, on) => {
    const jobs = Array.from({ length: 10 }, (_, k) => `job-${k}`)
    const text = `${[1, 2, 3].map(i => jobs.map((job, k) => row(i, job, { wall_s: k + 1 })).join('\n')).join('\n')}\n`
    world(on, files(text))
    const ui = await $.ui.mount(pane(60))
    await ui.press({ key: 'ci-toggle' })
    const card = await cardOf(ui, name(3))
    const cardText = textOf(card)
    expect(walk(await ui.drawn()).find(node => node.props?.key === `ci-run:${name(3)}`)?.hover).toMatchObject({ scope: `ci:${name(3)}` })
    const lines = (card?.children ?? []).filter(child => typeof child === 'object' && child !== null)
    expect(lines).toHaveLength(2 + 8)
    const slowest = (await ui.findAll({ type: 'Text', text: 'job-9' })).at(-1)
    expect(slowest?.props.color).toBe(`#${jobColor('job-9').toString(16).padStart(6, '0')}`)
    expect(cardText).toContain('cafe0003 · load 2.0 · peak 100 MB')
    expect(cardText).toContain('job-9')
    expect(cardText).not.toContain('job-0 ')
    const width = Number(card?.props?.width)
    for (const key of [name(1), name(3)]) {
      const left = Number((await cardOf(ui, key))?.props?.left)
      expect(left).toBeGreaterThanOrEqual(0)
      expect(left + width).toBeLessThanOrEqual(60)
    }
    await ui.unmount()
  })

  test('without pictures the chart is block glyphs: a Raster after an alt deny, Text on desktop', async ($, on) => {
    const w = world(on, { ...RUN_FILES, ...files(metrics(3)) })
    w.blitOk = true
    w.imageDeny = 'the Image draws its alt here'
    const ui = await $.ui.mount(pane())
    await ui.press({ key: 'ci-toggle' })
    expect((await ui.find({ key: `ci-bar:${name(3)}` }))?.type).toBe('Image')
    await w.clock.advance(250)
    await ui.unmount()
    const again = await $.ui.mount(pane())
    expect((await again.find({ key: `ci-bar:${name(3)}` }))?.type).toBe('Raster')
    await again.unmount()

    const desktop = await $.ui.mount(pane(120, 'desktop'))
    expect(await desktop.find({ key: `ci-bar:${name(3)}` })).toBeUndefined()
    expect((await desktop.find({ key: `ci-run:${name(3)}` }))?.text).toContain('█')
    await desktop.unmount()
  })

  test('a file cut to other runs is read afresh, never served from the old chart', async ($, on) => {
    const w = world(on, files(metrics(3)))
    const ui = await $.ui.mount(pane())
    await ui.press({ key: 'ci-toggle' })
    expect(await cards(ui)).toHaveLength(3)
    await ui.unmount()
    w.files[METRICS] = `${runRows(7)}\n${runRows(8)}\n`
    const again = await $.ui.mount(pane())
    expect(await cards(again)).toEqual([`ci-run:${name(7)}`, `ci-run:${name(8)}`])
    await again.unmount()
  })

  test('two renders reading at once take the appended rows once', async ($, on) => {
    const w = world(on, files(metrics(3)))
    const ui = await $.ui.mount(pane(120, 'desktop'))
    await ui.press({ key: 'ci-toggle' })
    await ui.unmount()
    w.files[METRICS] += `${row(3, 'test', { attempt: 2 })}\n`
    const [one, two] = await Promise.all([$.ui.mount(pane(120, 'terminal')), $.ui.mount(pane(120, 'desktop'))])
    await one.unmount()
    await two.unmount()
    expect(w.tails).toHaveLength(3)
    const after = await $.ui.mount(pane(120, 'desktop'))
    const chartText = (await Promise.all([1, 2, 3].map(async i => (await after.find({ key: `ci-run:${name(i)}` }))?.text ?? ''))).join('')
    expect(chartText.match(/[0-9+]/g)).toEqual(['1'])
    await after.unmount()
  })

  test('a first read from mid-file drops the run it began inside', async ($, on) => {
    // runs of about 20 KB: the first read (2 runs' worth, 32 KiB) begins inside run 2
    const jobs = Array.from({ length: 60 }, (_, k) => `job-${String(k).padStart(3, '0')}-${'x'.repeat(120)}`)
    world(on, files(`${[1, 2, 3].map(i => runRows(i, jobs)).join('\n')}\n`))
    const ui = await $.ui.mount(pane(10))
    await ui.press({ key: 'ci-toggle' })
    expect(await cards(ui)).toEqual([`ci-run:${name(3)}`])
    await ui.unmount()
  })

  test('in a narrow pane the card and its lines fit the pane width', async ($, on) => {
    world(on, files(`${runRows(1, ['a-very-long-job-name-indeed', 'test'])}\n`))
    const ui = await $.ui.mount(pane(30))
    await ui.press({ key: 'ci-toggle' })
    const card = await cardOf(ui, name(1))
    expect(Number(card?.props?.width)).toBeLessThanOrEqual(30)
    for (const line of card?.children ?? []) expect(textOf(line).length).toBeLessThanOrEqual(26)
    expect(Number(card?.props?.left) + Number(card?.props?.width)).toBeLessThanOrEqual(30)
    await ui.unmount()
  })

  for (const bodyColumns of [30, 50]) {
    test(`at ${bodyColumns} columns each run's bar is drawn inside its own hover column`, async ($, on) => {
      world(on, files(metrics(30)))
      const ui = await $.ui.mount(pane(bodyColumns))
      await ui.press({ key: 'ci-toggle' })
      const keys = await cards(ui)
      const shown = keys.map(key => key.slice('ci-run:'.length))
      expect(shown).toHaveLength(runsFit(bodyColumns))
      const tiles = chartTiles(shown.map(run => summarize(run, parseRows(runRows(Number(run.slice(13, 15)))))))
      const row = walk(await ui.drawn()).find(node => node.props?.key === 'ci')?.children?.[0] as Drawn
      const columns = (row.children ?? []) as Drawn[]
      // the axis, then one 2-cell column per run, in order: column i starts at runCell(i)
      expect(columns[0]?.props?.width).toBe(6)
      let at = Number(columns[0]?.props?.width)
      for (const [i, run] of shown.entries()) {
        const column = columns[i + 1] as Drawn
        expect(column.props?.key).toBe(`ci-run:${run}`)
        expect(at).toBe(runCell(i))
        at += Number(column.props?.width)
        const bar = (column.children ?? [])[0] as Drawn
        expect(bar.props).toMatchObject({ key: `ci-bar:${run}`, columns: 2, rows: 6, source: tiles[i] })
      }
      await ui.unmount()
    })
  }

  test('a hovered run column lights its background', async ($, on) => {
    world(on, files(metrics(3)))
    const ui = await $.ui.mount(pane())
    await ui.press({ key: 'ci-toggle' })
    const column = walk(await ui.drawn()).find(node => node.props?.key === `ci-run:${name(2)}`)
    expect(column?.hover?.scope).toBe(`ci:${name(2)}`)
    expect((column?.hover as { backgroundColor?: string } | undefined)?.backgroundColor).toMatch(/^#[0-9a-f]{6}$/)
    await ui.unmount()
  })

  test('a run cancelled when the tip moved draws faded, with no red underline, and says so on its card', async ($, on) => {
    const log = `2026-01-01T00:00:30.000Z cancel run sha=${sha(2)} groups=123\n`
    world(on, { ...files(`${runRows(1)}\n${row(2, 'lint', { exit: 1 })}\n${runRows(3)}\n`), [`${CI}/run.log`]: log })
    const ui = await $.ui.mount(pane())
    await ui.press({ key: 'ci-toggle' })
    const card = await cardOf(ui, name(2))
    expect(textOf(card)).toContain('cafe0002 · cancelled (tip moved) · load 2.0 · peak 100 MB')
    expect(textOf(await cardOf(ui, name(3)))).not.toContain('cancelled')
    await ui.unmount()

    const runs = markCancelled([1, 2].map(i => summarize(name(i), parseRows(row(i, 'lint', { exit: 1 })))), [{ sha8: 'cafe0002', at: '20260101T000030' }])
    expect(runs.map(run => run.cancelled)).toEqual([false, true])
    const { bytes } = chartBytes(runs)
    const at = (x: number, y: number) => [...bytes.slice((y * 24 + x) * 4, (y * 24 + x) * 4 + 4)]
    expect(at(5, 70)).toEqual([0xe6, 0x5a, 0x50, 255])
    expect(at(17, 70)[3]).toBe(0)
    expect(at(17, 60)[3]).toBe(128)
    // a cancel before a run started is not that run's
    expect(markCancelled(runs.slice(0, 1), [{ sha8: 'cafe0001', at: '20251231T235959' }])[0]?.cancelled).toBe(false)
  })

  for (const bodyColumns of [30, 50]) {
    test(`at ${bodyColumns} columns a card never covers its own run column`, () => {
      const fit = runsFit(bodyColumns)
      for (const column of [0, Math.floor(fit / 2), fit - 1]) {
        for (const width of [12, 41, bodyColumns]) {
          const place = cardPlace(column, width, bodyColumns)
          const at = runCell(column)
          expect(place.x).toBeGreaterThanOrEqual(0)
          expect(place.x + place.width).toBeLessThanOrEqual(bodyColumns)
          expect(place.x >= at + 2 || place.x + place.width <= at).toBe(true)
          expect(place.width).toBeGreaterThan(0)
        }
      }
    })
  }

  test('the cards are drawn after the rest of the pane, so they paint over it', async ($, on) => {
    world(on, {
      ...RUN_FILES,
      ...files(metrics(3)),
      [`${STATE}/gh-status/status/pr-123.json`]: JSON.stringify({ number: 123, state: 'OPEN', isDraft: false, title: 'widgets', headOid: '12345678abcdef' }),
    })
    const ui = await $.ui.mount(pane())
    await ui.press({ key: 'ci-toggle' })
    const all = walk(await ui.drawn())
    const needsYou = all.findIndex(node => node.props?.key === 'needs-you')
    const lastRow = all.findIndex(node => node.props?.key === `disk:${KIDS}/e-failed`)
    const cardAt = all.findIndex(node => node.props?.display === 'none' && node.hover?.scope === `ci:${name(3)}`)
    expect(needsYou).toBeGreaterThan(-1)
    expect(lastRow).toBeGreaterThan(-1)
    expect(cardAt).toBeGreaterThan(needsYou)
    expect(cardAt).toBeGreaterThan(lastRow)
    // keyed by run, rows by line, so a run window that shifts keeps each card with its run
    const card = all[cardAt]
    expect(card?.props?.key).toBe(`ci-card:${name(3)}`)
    expect(((card?.children ?? []) as Drawn[]).map(line => line.props?.key)).toEqual(Array.from({ length: 4 }, (_, k) => `ci-line-${k}`))
    expect(all.filter(node => typeof node.props?.key === 'string' && (node.props.key as string).startsWith('ci-card:')).map(node => node.props?.key)).toEqual([1, 2, 3].map(i => `ci-card:${name(i)}`))
    await ui.unmount()
  })

  for (const bodyColumns of [30, 50, 80]) {
    test(`at ${bodyColumns} columns each card table row is one row Box no wider than the card`, async ($, on) => {
      const jobs = ['a-very-long-job-name-indeed', 'test', 'lint']
      world(on, files(`${[1, 2, 3].map(i => jobs.map(job => row(i, job, { wall_s: 70.4, cpu_user_s: 100, cpu_sys_s: 38.5, max_rss_mb: 1994 })).join('\n')).join('\n')}\n`))
      const ui = await $.ui.mount(pane(bodyColumns))
      await ui.press({ key: 'ci-toggle' })
      for (const i of [1, 2, 3]) {
        const card = await cardOf(ui, name(i))
        const content = Number(card?.props?.width) - 4
        const lines = (card?.children ?? []) as Drawn[]
        expect(lines).toHaveLength(2 + jobs.length)
        for (const line of lines) {
          expect(line.type).toBe('Box')
          expect(line.props?.flexDirection).toBe('row')
          expect(((line.children ?? []) as Drawn[]).every(cell => cell.type === 'Text')).toBe(true)
          expect(textOf(line).length).toBeLessThanOrEqual(content)
        }
        // a job row: its name cell, then its numbers cell, side by side
        const test = (lines.find(line => textOf(line).startsWith('test'))?.children ?? []) as Drawn[]
        expect(test).toHaveLength(2)
        expect(textOf(test[0]).trim()).toBe('test')
        expect(Number(card?.props?.left) + Number(card?.props?.width)).toBeLessThanOrEqual(bodyColumns)
      }
      await ui.unmount()
    })
  }

  test('a narrow card shortens the job name to 8 first, then drops re, then cpu', () => {
    const run = summarize(name(1), parseRows(row(1, 'a-very-long-job-name-indeed')))
    const shape = (width: number) => {
      const table = cardTable(run, width)
      return [table.nameWidth, `${table.header.name}${table.header.nums}`.replace(/ +/g, ' ').trim(), table.width]
    }
    expect(shape(80)).toEqual([16, 'job wall cpu MB re', 37])
    expect(shape(29)).toEqual([8, 'job wall cpu MB re', 29])
    expect(shape(28)).toEqual([10, 'job wall cpu MB', 28])
    expect(shape(23)).toEqual([11, 'job wall MB', 23])
    expect(shape(22)).toEqual([10, 'job wall MB', 22])
    expect(shape(20)).toEqual([8, 'job wall MB', 20])
    for (const width of [12, 20, 29, 37]) {
      const table = cardTable(run, width)
      for (const line of [table.header, ...table.rows]) expect(line.name.length + line.nums.length).toBeLessThanOrEqual(width)
      expect(table.head.length).toBeLessThanOrEqual(width)
    }
  })

  test('cpu stacks each job, mem is one bar at the peak in the colour of the job that hit it', () => {
    const run = summarize(name(1), parseRows([
      row(1, 'lint', { wall_s: 10, cpu_user_s: 4, cpu_sys_s: 1, max_rss_mb: 300 }),
      row(1, 'test', { wall_s: 20, cpu_user_s: 30, cpu_sys_s: 2, max_rss_mb: 2458 }),
    ].join('\n')))
    expect(barParts(run, 'wall')).toEqual([{ job: 'lint', value: 10 }, { job: 'test', value: 20 }])
    expect(barParts(run, 'cpu')).toEqual([{ job: 'lint', value: 5 }, { job: 'test', value: 32 }])
    expect(barParts(run, 'mem')).toEqual([{ job: 'test', value: 2458 }])
    // a retried job's first attempt may hold the peak: the bar takes that job, not the final rows' top
    const retried = summarize(name(3), parseRows([
      row(3, 'build', { attempt: 1, exit: 1, max_rss_mb: 3000 }),
      row(3, 'build', { attempt: 2, max_rss_mb: 500 }),
      row(3, 'test', { max_rss_mb: 2000 }),
    ].join('\n')))
    expect(barParts(retried, 'mem')).toEqual([{ job: 'build', value: 3000 }])
    expect(axisLabels(497.4, 'wall')).toEqual({ top: '497s', bottom: '0s' })
    expect(axisLabels(612, 'cpu')).toEqual({ top: '612s', bottom: '0s' })
    expect(axisLabels(2458, 'mem')).toEqual({ top: '2.4G', bottom: '0' })
    expect(axisLabels(900, 'mem')).toEqual({ top: '900M', bottom: '0' })
    // the mem bar fills from the base to the top in one colour; a red run keeps its underline and retry digit
    const red = summarize(name(2), parseRows([row(2, 'lint', { exit: 1, max_rss_mb: 50 }), row(2, 'lint', { attempt: 2, exit: 1, max_rss_mb: 50 })].join('\n')))
    const { bytes } = chartBytes([run, red], 'mem')
    const at = (x: number, y: number) => [...bytes.slice((y * 24 + x) * 4, (y * 24 + x) * 4 + 4)]
    const rgb = (n: number) => [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]
    expect(at(5, 67)).toEqual(rgb(jobColor('test')))
    expect(at(5, 9)).toEqual(rgb(jobColor('test')))
    expect(at(17, 70)).toEqual([0xe6, 0x5a, 0x50, 255])
    expect(Array.from({ length: 67 }, (_, y) => at(17, y)).some(px => px[0] === 0xe6 && px[1] === 0x5a)).toBe(true)
  })

  test('the metric chips switch the bars and the axis; the pick persists', async ($, on) => {
    world(on, files(metrics(3)))
    const runs = [1, 2, 3].map(i => summarize(name(i), parseRows(runRows(i))))
    // the bar row: the axis box, then one column per run holding its bar
    const drawnAs = async (ui: { drawn: () => Promise<unknown>; find: (q: object) => Promise<{ props: Record<string, unknown> } | undefined> }, metric: Metric) => {
      const labels = axisLabels(barMax(runs, metric), metric)
      const bars = walk(await ui.drawn()).find(node => node.props?.key === 'ci')?.children?.[0] as Drawn
      expect(textOf(bars.children?.[0])).toBe(`${labels.top}${labels.bottom}`)
      expect((await ui.find({ key: `ci-bar:${name(2)}` }))?.props.source).toEqual(chartTiles(runs, metric)[1])
      for (const one of ['wall', 'cpu', 'mem']) expect((await ui.find({ key: `ci-metric:${one}` }))?.props.dimColor).toBe(one !== metric)
    }
    const ui = await $.ui.mount(pane())
    await ui.press({ key: 'ci-toggle' })
    await drawnAs(ui, 'wall')
    await ui.press({ key: 'ci-metric:cpu' })
    await drawnAs(ui, 'cpu')
    await ui.unmount()
    const again = await $.ui.mount(pane())
    await drawnAs(again, 'cpu')
    await again.press({ key: 'ci-metric:mem' })
    await drawnAs(again, 'mem')
    await again.unmount()
  })

})

describe('pane auto-open', () => {
  const ROLE = `/tmp/cc-session-roles/${SID}`

  async function start([$, on]: Parameters<Parameters<typeof test>[1]>, files: Record<string, string>, isInteractive = true) {
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
