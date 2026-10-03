import { describe, expect, test } from 'claude-code/testing'

import { epoch, KIDS, NOW, PANEL, RUN_FILES, run, SID, STATE, under, world } from './world'

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

  test('native agents use their transcript for detail', async ($, on) => {
    world(on, {}, [], {
      agents: [{ id: 'agent-1', description: 'inspect sidebar', type: 'Explore', status: 'running' }],
      transcripts: { 'agent-1': [{ role: 'assistant', text: 'native transcript tail', toolUses: [] }] },
    })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'native:agent-1' }))?.text).toContain('◐ Explore inspect sidebar  ?  ?  running')
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
      [`${root}/main-ci/run.log`]: `preview #4390 ${head.slice(0, 8)}-${mainSha.slice(0, 8)}: queued (ready)\n`,
      [`${root}/gh-status/status/pr-4390.json`]: JSON.stringify({ number: 4390, state: 'OPEN', isDraft: false, title: 'Sidebar work', headOid: head, createdAt: '2026-01-01' }),
      [`${root}/gate/pr-4390/${head.slice(0, 8)}-${mainSha.slice(0, 8)}.json`]: JSON.stringify({ green: false, conflict: true }),
    })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.findAll({ type: 'Text' })).map(node => node.text).join(' ')).toContain('main abcdef01 · green · preview queue 1')
    expect((await ui.find({ type: 'Link', text: '#4390' }))?.text).toBe('#4390')
    expect((await ui.find({ key: 'pr:4390' }))?.text).toContain('Sidebar work ✗ ⚡ conflict')
    await ui.unmount()
  })

  test('no runs for the session draws the empty line', async ($, on) => {
    world(on, {})
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'No child runs for this session.' })).toBeDefined()
    await ui.unmount()
  })
})

describe('asks band', () => {
  test('one row per ask; a click expands its context or says none was recorded', async ($, on) => {
    world(on, {
      ...RUN_FILES,
      [ASKS]: '#12 merge the DF fold?\n\n#13 pick the panel model?\n',
      [`${ASKS}.d/1.md`]: 'DF fold: options A or B. Recommend A.',
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

      await ui.press({ key: 'ask-3' })
      expect(await ui.find({ key: 'ask-detail-3' })).toBeUndefined()
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
    await ui.unmount()
  })

  test('an expanded ask draws links and its context border', async ($, on) => {
    world(on, {
      '/fx/repo/.agent/orchestrate.local.md': '- `session_bus_dir`: `~/state/bus`\n',
      [ASKS]: '#4390 review the UI?\n',
      [`${ASKS}.d/1.md`]: 'Problem: layout needs hierarchy\nlink: https://github.com/EZ-OPD/ez-opd-services/pull/4390\n',
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'ask-1' })
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    expect(await ui.find({ key: 'ask-detail-border' })).toBeDefined()
    await ui.unmount()
  })

  test('an expanded ask closes once its line is gone', async ($, on) => {
    const w = world(on, { ...RUN_FILES, [ASKS]: '#12 merge the DF fold?\n', [`${ASKS}.d/1.md`]: 'Recommend A.' })
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
    w.files[ASKS] = '#12 merge the DF fold?\n'
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
