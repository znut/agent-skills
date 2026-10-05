import { describe, expect, test } from 'claude-code/testing'

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
        world(on, queueFiles(log.join('\n')))
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
    const cellsOf = async (ui: { find: (q: { key: string }) => Promise<{ props: Record<string, unknown> } | undefined> }, dir: string) =>
      (await ui.find({ key: `avatar:disk:${dir}` }))?.props.cells
    const frames = (key: string, w: { blits: { key: string; cells: string }[] }) => w.blits.filter(blit => blit.key === key)

    test('terminal rows draw a sprite per status in place of the mark; other surfaces keep the mark', async ($, on) => {
      world(on, { ...RUN_FILES, ...under(`${KIDS}/f-unknown`, { pid: '110', 'owner-session': SID, 'start-epoch': epoch(5) }) })
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      const run = await cellsOf(ui, `${KIDS}/a-run`)
      const done = await cellsOf(ui, `${KIDS}/b-done`)
      const failed = await cellsOf(ui, `${KIDS}/e-failed`)
      expect(new Set([run, done, failed]).size).toBe(3)
      expect(await cellsOf(ui, `${PANEL}/0123abcdef/code`)).not.toBe(run)
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
      expect(new Set(frames(`avatar:disk:${KIDS}/a-run`, w).map(blit => blit.cells)).size).toBeGreaterThan(1)
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

  test('a non-git cwd draws no strip; a repo cwd resolves afresh; one cwd runs git once', async ($, on) => {
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
    on('ui.invalidate', () => ({ value: undefined }))
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

describe('pane auto-open', () => {
  const ROLE = `/tmp/cc-session-roles/${SID}`

  async function start([$, on]: Parameters<Parameters<typeof test>[1]>, files: Record<string, string>, isInteractive = true) {
    const w = world(on, { ...RUN_FILES, ...files })
    const opened: string[] = []
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.invalidate', () => ({ value: undefined }))
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
