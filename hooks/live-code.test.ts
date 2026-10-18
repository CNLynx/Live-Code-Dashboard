import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'live-code',
  component: 'Pane',
  requestId: 'live-code',
  props: { title: 'Live code', isFocused: false, bodyColumns: 100 } as never,
  viewport: { columns: 100, rows: 60 } as never,
} as const

const FILE = 'const a = 1\nconst b = 2\nconst c = 3\nconst d = 4\n'

// Stands in for the engine: tools answer ok, files read from `files`, usage is fixed.
const engine = (on: On, files: Record<string, string> = {}) => {
  on('tool.call', () => ({ result: undefined as never, text: 'ok' }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('fs.read', ((_: unknown, e: { path: string }) => {
    const hit = Object.keys(files).find(name => e.path.replace(/\\/g, '/').endsWith(name))

    return hit !== undefined ? { value: files[hit] } : { deny: 'ENOENT' }
  }) as never)
  on('session.usage', () =>
    ({
      value: {
        startedAt: 0,
        context: { tokens: 124_000, window: 200_000, percent: 62 },
        rateLimits: [{ kind: 'five_hour', percentUsed: 15 }],
        cost: { usd: 1.84 },
      },
    }) as never)
}

const SURFACES = ['terminal', 'desktop'] as const

// the test runtime has timers; the mod's own types leave them out
declare const setTimeout: (run: () => void, ms: number) => unknown
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 50))

// Collects what the mod writes to the feed file, newest last.
const feedWrites = (on: On) => {
  const written: string[] = []
  on('fs.write', ((_: unknown, e: { path: string; content?: string; text?: string; data?: string }) => {
    if (e.path.endsWith('live-code-feed.json')) written.push(String(e.content ?? e.text ?? e.data ?? ''))
    return { value: undefined }
  }) as never)
  return () => written.map(text => { try { return JSON.parse(text) } catch { return null } }).filter(Boolean).pop()
}

test('a Read shows its file and line range', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Read', file_path: 'src/app.ts', offset: 10, limit: 5 })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /app\.ts:10-14/ })).toBeDefined()
    await ui.unmount()
  }
})

test('an Edit marks added, removed and edited lines', async ($, on) => {
  engine(on, { 'src/x.ts': FILE })
  await $.tool.call({
    tool: 'Edit',
    file_path: 'src/x.ts',
    old_string: 'const b = 2\nconst c = 3',
    new_string: 'const b = 20\nconst bb = 21\nconst c = 3',
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /x\.ts:2-4/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\+1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /~1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /const bb = 21/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a Write of a new file is all added lines', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Write', file_path: 'notes.md', content: 'one\ntwo' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /notes\.md:1-2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\+2/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the usage bar shows context and cost', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /62%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /124\.0k \/ 200\.0k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$1\.84/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a shell command is shown as running, and joins the pipeline', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Bash', command: 'npm run build\nnpm test', description: 'Build and test' } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /RUNNING/ })).toBeDefined()
    // the desktop shows the finished command as highlighted source
    expect(await ui.find({ type: surface === 'terminal' ? 'Text' : 'Code', text: /npm run build/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Build and test/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a search shows what it looks for, and the lines it found', async ($, on) => {
  on('tool.call', { tool: 'Grep' }, () =>
    ({ result: { mode: 'content', numFiles: 0, filenames: [], content: 'src/a.ts:3:const useCart = 1\nsrc/b.ts:9:useCart()', numLines: 2 }, text: 'ok' }) as never)
  engine(on)
  await $.tool.call({ tool: 'Grep', pattern: 'useCart', path: 'src', output_mode: 'content' } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /“useCart” in src/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /src\/b\.ts:9:useCart\(\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /nothing found/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('with a dashboard open, Claude\'s question is answered from there', async ($, on) => {
  const at = 1_000_000
  on('clock.now', (() => ({ value: at + 500 })) as never)
  on('process.run', (() => ({ value: { exitCode: 0, stdout: JSON.stringify({ decision: 'answer', answers: { 'Which color?': 'Blue' } }), stderr: '' } })) as never)
  engine(on, { 'live-code-remote.json': JSON.stringify({ at }) })
  const ran = await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }],
  } as never)
  expect(ran.text).toContain('"Which color?"="Blue"')
})

test('without a dashboard, Claude\'s question goes to the usual dialog', async ($, on) => {
  engine(on)
  const ran = await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }],
  } as never)
  expect(ran.text).toBe('ok')
})

test('Claude\'s task list becomes the plan in the feed, with its progress', async ($, on) => {
  const lastFeed = feedWrites(on)
  engine(on)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
      { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
      { content: 'Run the tests', status: 'pending', activeForm: 'Running the tests' },
    ],
  } as never)
  await settle()
  const feed = lastFeed()
  expect(feed?.plan?.done).toBe(1)
  expect(feed?.plan?.total).toBe(3)
  expect(feed?.plan?.items?.[1]).toEqual({ title: 'Fixing the bug', status: 'running' })
})

test('an Edit gets a sentence on what it is for, from the change and the prompt', async ($, on) => {
  const asked: string[] = []
  on('model.complete', ((_: unknown, e: { prompt: unknown }) => {
    asked.push(JSON.stringify(e.prompt))
    return { value: { isAnswered: true, text: 'Benennt b um, damit der Test den neuen Wert sieht.', usage: { input_tokens: 1, output_tokens: 1 } } }
  }) as never)
  const lastFeed = feedWrites(on)
  engine(on, { 'src/x.ts': FILE })
  on('prompt.submit', ((_: unknown, e: { text: string }) => ({ text: e.text })) as never)
  await $.prompt.submit({ text: 'make b twenty' } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'src/x.ts', old_string: 'const b = 2', new_string: 'const b = 20' })
  await settle()

  expect(asked[0]).toContain('make b twenty')
  expect(asked[0]).toContain('+ const b = 20')
  const feed = lastFeed()
  expect(feed?.history?.at(-1)?.why).toBe('Benennt b um, damit der Test den neuen Wert sieht.')
})

test('the desktop draws the usage as a vector gauge', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Context 62%/ })).toBeDefined()
  await ui.unmount()
})

const BAND = {
  plugin: 'live-code',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100 } as never,
  viewport: { columns: 100, rows: 40 } as never,
} as const

test('the band above the prompt says what is happening, and yields to a survey', async ($, on) => {
  engine(on)
  on('prompt.submit', ((_: unknown, e: { text: string }) => ({ text: e.text })) as never)
  // the engine's own band: empty
  on('ui.render', { component: 'AbovePrompt' }, (($: { ui: { resolve: (e: unknown) => { Text: (p: object) => unknown } } }, e: unknown) =>
    $.ui.resolve(e).Text({ children: '' })) as never)
  const clock = mock.clock(on, { now: 3_000_000 })

  await $.prompt.submit({ text: 'fix the bug' } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'bug' })
  await clock.advance(400)

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: /Thinking/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /1 step/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /62%/ })).toBeDefined()
    await band.unmount()
  }

  const survey = await $.ui.mount({ ...BAND, surface: 'terminal', props: { hasSurvey: true, isWorking: true, maxRows: 10, bodyColumns: 100 } as never })
  expect(await survey.find({ type: 'Text', text: /Thinking/ })).toBeUndefined()
  await survey.unmount()
})

test('a new prompt shows Claude planning, then thinking between tools', async ($, on) => {
  engine(on)
  on('prompt.submit', ((_: unknown, e: { text: string }) => ({ text: e.text })) as never)
  const clock = mock.clock(on, { now: 2_000_000 })

  await $.prompt.submit({ text: 'make the mod faster' } as never)
  await clock.advance(500)
  const planning = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await planning.find({ type: 'Text', text: /Planning/ })).toBeDefined()
  expect(await planning.find({ type: 'Text', text: /make the mod faster/ })).toBeDefined()
  await planning.unmount()

  await $.tool.call({ tool: 'Grep', pattern: 'slow' })
  await clock.advance(300)
  const thinking = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await thinking.find({ type: 'Text', text: /Thinking/ })).toBeDefined()
  expect(await thinking.find({ type: 'Text', text: /after 1 step/ })).toBeDefined()
  await thinking.unmount()
})

test('an Edit is replayed as typing, with a cursor, then settles', async ($, on) => {
  // ui.status and fs.read as in `engine`, but clock.now is the mocked clock's
  on('tool.call', () => ({ result: undefined as never, text: 'ok' }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('fs.read', (() => ({ value: FILE })) as never)
  on('session.usage', () => ({ deny: 'none' }) as never)
  const clock = mock.clock(on, { now: 1_000_000 })

  await $.tool.call({
    tool: 'Edit',
    file_path: 'src/x.ts',
    old_string: 'const b = 2\nconst c = 3',
    new_string: 'const b = 20\nconst bb = 21\nconst c = 3',
  })
  await clock.advance(250) // part way: the new line is half typed

  const typing = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await typing.find({ type: 'Text', text: /\+ │ const[^▌]*▌/ })).toBeDefined()
  expect(await typing.find({ type: 'Text', text: /const bb = 21/ })).toBeUndefined()
  await typing.unmount()

  await clock.advance(5000) // the replay is over: the whole line, no cursor
  const settled = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await settled.find({ type: 'Text', text: /const bb = 21/ })).toBeDefined()
  expect(await settled.find({ type: 'Text', text: /▌/ })).toBeUndefined()
  await settled.unmount()
})


test('an Edit of a file with Windows line endings still finds its place', async ($, on) => {
  engine(on, { 'crlf.ts': 'const a = 1\r\nconst b = 2\r\nconst c = 3\r\n' })
  await $.tool.call({ tool: 'Edit', file_path: 'src/crlf.ts', old_string: 'const b = 2', new_string: 'const b = 20' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /crlf\.ts:2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /~1/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a Read sweeps through the whole range and stays at its end', async ($, on) => {
  const big = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')
  engine(on, { 'big.ts': big })
  const clock = mock.clock(on, { now: 5_000_000 })
  await $.tool.call({ tool: 'Read', file_path: 'src/big.ts' })
  await clock.advance(3000) // the sweep takes at most 2.5s

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /line 60/ })).toBeDefined()
  await term.unmount()
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desk.find({ type: 'Code', text: /line 60/ })).toBeDefined()
  await desk.unmount()
})

test('the pipeline shows the newest five steps, the rest as +N', async ($, on) => {
  engine(on)
  for (const pattern of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) await $.tool.call({ tool: 'Grep', pattern })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^\+2\s*$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the files tab lists what each file went through', async ($, on) => {
  engine(on, { 'src/x.ts': FILE })
  await $.tool.call({
    tool: 'Edit',
    file_path: 'src/x.ts',
    old_string: 'const b = 2\nconst c = 3',
    new_string: 'const b = 20\nconst bb = 21\nconst c = 3',
  })

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.press({ key: 'tab:files' })
  expect(await desk.find({ type: 'Text', text: /1 edit · 0 reads/ })).toBeDefined()
  await desk.unmount()
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /1e 0r/ })).toBeDefined()
  await term.unmount()
})

test('a limit that just reset and goes unreported stays, at 0%', async ($, on) => {
  let limits: object[] = [
    { kind: 'five_hour', percentUsed: 80, resetsAt: '2026-01-01T00:00:00Z' },
    { kind: 'seven_day', percentUsed: 40, resetsAt: '2099-01-01T00:00:00Z' },
  ]
  const lastFeed = feedWrites(on)
  on('tool.call', () => ({ result: undefined as never, text: 'ok' }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('fs.read', (() => ({ deny: 'ENOENT' })) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1, window: 200_000, percent: 1 }, rateLimits: limits, cost: { usd: 1 } } }) as never)
  const clock = mock.clock(on, { now: Date.parse('2026-01-01T01:00:00Z') })

  await $.tool.call({ tool: 'Grep', pattern: 'a' })
  limits = [{ kind: 'seven_day', percentUsed: 41, resetsAt: '2099-01-01T00:00:00Z' }]
  await clock.advance(60_000)
  await $.tool.call({ tool: 'Grep', pattern: 'b' })
  await settle()

  const kept = lastFeed()?.usage?.limits ?? []
  expect(kept.find((l: { kind: string }) => l.kind === 'five_hour')).toEqual({ kind: 'five_hour', percent: 0 })
  expect(kept.find((l: { kind: string }) => l.kind === 'seven_day')?.percent).toBe(41)
})

test('a limit filling up gets a projection of when it is full', async ($, on) => {
  let percent = 10
  on('tool.call', () => ({ result: undefined as never, text: 'ok' }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('fs.read', (() => ({ deny: 'ENOENT' })) as never)
  on('session.usage', () =>
    ({
      value: {
        startedAt: 0,
        context: { tokens: 1000, window: 200_000, percent: 1 },
        rateLimits: [{ kind: 'five_hour', percentUsed: percent }],
        cost: { usd: 1 },
      },
    }) as never)
  const clock = mock.clock(on, { now: 10_000_000 })

  await $.tool.call({ tool: 'Grep', pattern: 'a' })
  await clock.advance(5 * 60_000)
  percent = 20 // ten points in five minutes: the eighty left take forty
  await $.tool.call({ tool: 'Grep', pattern: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /5H full in ~40m00s/ })).toBeDefined()
  await ui.unmount()
})
