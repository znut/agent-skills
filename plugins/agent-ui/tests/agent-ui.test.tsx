import { describe, expect, test } from 'claude-code/testing'

import { epoch, KIDS, PANEL, RUN_FILES, run, SID, STATE, under, world } from './world'

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
      const row = async (dir: string) => (await ui.find({ key: `run:${dir}` }))?.text ?? ''
      expect(await row(`${KIDS}/a-run`)).toContain('gpt a-run  openai/sol  5m  running')
      expect(await row(`${KIDS}/b-done`)).toContain('gpt b-done  openai/sol  4m  done')
      expect(await row(`${KIDS}/c-dead`)).toContain('kimi c-dead  kimi/opus')
      expect(await row(`${KIDS}/c-dead`)).toContain('dead')
      expect(await row(`${KIDS}/e-failed`)).toContain('failed')
      expect(await row(`${PANEL}/0123abcdef/code`)).toContain('claude-panel rev 0123abcd/code  claude/opus')
      expect(await ui.find({ key: `run:${KIDS}/d-foreign` })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a click shows the run tail, and the last message once done', async ($, on) => {
    world(on, RUN_FILES)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: `run:${KIDS}/a-run` })
      expect(await ui.find({ type: 'Text', text: 'hello from codex' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '$ git status' })).toBeDefined()
      expect(await ui.find({ key: 'last-message' })).toBeUndefined()

      await ui.press({ key: `run:${KIDS}/b-done` })
      expect(await ui.find({ type: 'Text', text: 'hello from codex' })).toBeUndefined()
      expect((await ui.find({ key: 'last-message' }))?.text).toContain('All green.')

      await ui.press({ key: `run:${KIDS}/b-done` })
      expect(await ui.find({ key: 'tail' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a resumed run (done removed) shows running again, not its old end', async ($, on) => {
    const w = world(on, RUN_FILES)
    const dir = `${KIDS}/b-done`
    const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await first.find({ key: `run:${dir}` }))?.text).toContain('4m  done')
    await first.unmount()

    delete w.files[`${dir}/done`]
    delete w.files[`${dir}/exit-code`]
    w.alive.add('102')
    const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await again.find({ key: `run:${dir}` }))?.text).toContain('5m  running')
    await again.press({ key: `run:${dir}` })
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
    const rows = (await ui.findAll({})).map(n => n.key).filter((k): k is string => !!k?.startsWith('run:'))
    expect(rows.map(k => k.slice(k.lastIndexOf('/') + 1)).slice(2)).toEqual(['done-1', 'done-2', 'done-3', 'done-4', 'done-5'])
    expect(rows).toHaveLength(7)
    expect(rows.slice(0, 2).every(k => k.includes('/run-'))).toBe(true)
    await ui.unmount()
    for (let i = 1; i <= 5; i++) for (const name of Object.keys(w.files)) if (name.startsWith(`${KIDS}/done-${i}/`)) delete w.files[name]
    const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const left = (await again.findAll({})).map(n => n.key).filter((k): k is string => !!k?.startsWith('run:'))
    expect(left.map(k => k.slice(k.lastIndexOf('/') + 1)).slice(2)).toEqual(['done-6', 'done-7'])
    await again.unmount()
  })

  test('an old run without done reads dead even if its pid is alive', async ($, on) => {
    const dir = `${KIDS}/old`
    world(on, under(dir, { ...run('openai', '401'), 'start-epoch': epoch(25 * 60) }), ['401'])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: `run:${dir}` }))?.text).toContain('dead')
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
      expect((await ui.find({ key: 'ask-1' }))?.text).toContain('#12 merge the DF fold?')
      expect((await ui.find({ key: 'ask-3' }))?.text).toContain('#13 pick the panel model?')

      await ui.press({ key: 'ask-1' })
      expect((await ui.find({ key: 'ask-detail-1' }))?.text).toContain('Recommend A.')
      expect(await ui.find({ type: 'Text', text: 'no context recorded' })).toBeUndefined()

      await ui.press({ key: 'ask-3' })
      expect(await ui.find({ key: 'ask-detail-1' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'no context recorded' })).toBeDefined()

      await ui.press({ key: 'ask-3' })
      expect(await ui.find({ type: 'Text', text: 'no context recorded' })).toBeUndefined()
      await ui.unmount()
    }
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
    expect((await again.find({ key: 'ask-1' }))?.text).toContain('▸ #12')
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
