import { atom, read, update } from 'claude-code'
import type { Elements, Hook, Register, Timer, ToolCallResult } from 'claude-code'

import type { Action, AgentLane, Ask, AskQuestion, FileStat, Plan, PlanItem, Focus, Limit, PanelTab, Row, Stats, ThinkingState, Totals, TurnStat, TurnStep, Usage } from '../types'

type Engine = Parameters<Hook<'tool.call'>>[0]
type Op = { kind: 'ctx' | 'add' | 'del'; text: string }
// A styled run of text within one drawn code line.
type Seg = { text: string; color?: string; bg?: string; bold?: boolean; dim?: boolean; strike?: boolean }
// One drawn code line: its gutter, its runs, and whether the cursor is on it.
type View = { sign: string; ink?: string; no?: number; segs: Seg[]; isActive: boolean; isChange: boolean }

const PANE = 'live-code'
const TITLE = 'Live code'
const CONTEXT = 5 // unchanged lines shown around a change
const MAX_ROWS = 500
const KEEP_ROWS = 10 // history entries that keep their rows, for the viewer's replay queue
const HISTORY = 60
const MAX_RECENT = 20 // entries the recent list shows at most
const FLASH_MS = 1800 // how long a fresh change glows
const FRAME_MS = 70 // frame rate while something types or glows
const IDLE_EVERY = 4 // while only spinners move, redraw every 4th frame
const USAGE_MS = 3000
const THINK_MAX_MS = 10 * 60_000 // an interrupted turn stops animating after this
const TREND_MS = 30 * 60_000 // the window a limit's pace is measured over
const TREND_MIN_MS = 3 * 60_000 // and the least of it worth a projection
const LIMIT_WARN = [80, 95] // percents a toast warns at, once each until the limit resets
const MAX_FILES = 8 // files the heatmap shows
const MAX_STEPS = 5 // steps a pipeline row shows, the newest; older ones count as +N
const MAX_TURNS = 40 // turns the cost chart keeps

const NO_TOTALS: Totals = { files: 0, add: 0, del: 0, mod: 0, reads: 0, edits: 0, searches: 0, commands: 0 }
const NO_THINKING: ThinkingState = { active: false, since: 0, turnNo: 0 }

const current = atom({ plugin: 'live-code', key: 'current' } as const, null)
const history = atom({ plugin: 'live-code', key: 'history' } as const, [])
const totals = atom({ plugin: 'live-code', key: 'totals' } as const, NO_TOTALS)
const usage = atom({ plugin: 'live-code', key: 'usage' } as const, null)
const tick = atom({ plugin: 'live-code', key: 'tick' } as const, 0)
const thinking = atom({ plugin: 'live-code', key: 'thinking' } as const, NO_THINKING)
const turnSteps = atom({ plugin: 'live-code', key: 'turnSteps' } as const, [] as TurnStep[])
const turnNo = atom({ plugin: 'live-code', key: 'turnNo' } as const, 0)
const lastPrompt = atom({ plugin: 'live-code', key: 'lastPrompt' } as const, '')
// slow clock (timers, spinners) every drawing reads; `tick` is the fast one only a replay reads
const beat = atom({ plugin: 'live-code', key: 'beat' } as const, 0)
// the history entries that keep their rows, for the viewer's replay; no drawing reads it
const replayQueue = atom({ plugin: 'live-code', key: 'replayQueue' } as const, [] as Focus[])
const fileStats = atom({ plugin: 'live-code', key: 'fileStats' } as const, [] as FileStat[])
const turnStats = atom({ plugin: 'live-code', key: 'turnStats' } as const, [] as TurnStat[])
const agents = atom({ plugin: 'live-code', key: 'agents' } as const, [] as AgentLane[])
const recentFilter = atom({ plugin: 'live-code', key: 'recentFilter' } as const, null as string | null)
const panelTab = atom({ plugin: 'live-code', key: 'panelTab' } as const, 'recent' as PanelTab)
const sessionStart = atom({ plugin: 'live-code', key: 'sessionStart' } as const, 0)

// ── palette ──────────────────────────────────────────────────────────────────
const INK = { add: '#4ade80', del: '#f87171', mod: '#fb923c', gap: '#64748b', hit: '#c084fc' }
// glow backgrounds, brightest first; the last one stays as the resting tint
const GLOW = {
  add: ['#22c55e', '#15803d', '#14532d', '#0c2e1a'],
  del: ['#ef4444', '#b91c1c', '#7f1d1d', '#3b1111'],
  mod: ['#f97316', '#c2410c', '#7c2d12', '#3a1a08'],
}
const ACTION: Record<Action, { label: string; icon: string; color: string }> = {
  reading: { label: 'READING', icon: '👁', color: '#38bdf8' },
  editing: { label: 'EDITING', icon: '✎', color: '#fb923c' },
  writing: { label: 'WRITING', icon: '✚', color: '#4ade80' },
  searching: { label: 'SEARCHING', icon: '⌕', color: '#c084fc' },
  running: { label: 'RUNNING', icon: '$', color: '#facc15' },
}
const STEP_ICON: Record<TurnStep['kind'], string> = {
  read: '👁', edit: '✎', write: '✚', search: '⌕', bash: '$', web: '🌐', agent: '◈', other: '·',
}
const STEP_COLOR: Record<TurnStep['kind'], string> = {
  read: '#38bdf8', edit: '#fb923c', write: '#4ade80', search: '#c084fc',
  bash: '#facc15', web: '#2dd4bf', agent: '#f472b6', other: '#94a3b8',
}
const BAR_STOPS: [number, string][] = [[0.5, '#4ade80'], [0.7, '#facc15'], [0.85, '#fb923c'], [1, '#f87171']]
const WAVE_CHARS = ' ░▒▓█'
const WAVE_INK = ['#1e1b4b', '#3730a3', '#4f46e5', '#818cf8', '#c7d2fe']
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const THINK_SPIN = '◐◓◑◒'

const HANDLED = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'Grep', 'Glob'])
const SHELLS = new Set(['Bash', 'PowerShell'])

// ── text helpers ─────────────────────────────────────────────────────────────
// Tabs become two spaces here, so character offsets match what is drawn.
const splitLines = (text: string) =>
  text.split('\n').map(line => line.replace(/\r$/, '').replace(/\t/g, '  '))
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path
const dirName = (path: string) => path.slice(0, path.length - baseName(path).length)
const clip = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text
const pad = (n: number | undefined, width: number) =>
  (n === undefined ? '' : String(n)).padStart(width)
const human = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)
const clock = (ms: number) => {
  const d = new Date(ms)

  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':')
}
const dur = (ms: number) => {
  const s = Math.max(0, ms) / 1000

  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s`
}

// a search reads as what it looks for and where: "/useState/ in src"
const searchPlace = (file: string) => (file === '.' || file === '' ? 'project' : baseName(file.replace(/[\\/]+$/, '')) || file)
const where = (focus: Focus) =>
  focus.action === 'searching'
    ? `${focus.detail ?? '…'} in ${searchPlace(focus.file)}`
    : focus.line === undefined
    ? baseName(focus.file)
    : focus.endLine !== undefined && focus.endLine !== focus.line
      ? `${baseName(focus.file)}:${focus.line}-${focus.endLine}`
      : `${baseName(focus.file)}:${focus.line}`

// The subagent loop an event ran in; absent on the main loop.
const agentOf = (e: unknown) => {
  const id = (e as { agentId?: unknown }).agentId

  return typeof id === 'string' && id !== '' ? id : undefined
}

const stepKindOf = (tool: string): TurnStep['kind'] =>
  SHELLS.has(tool) ? 'bash' : /^Web/.test(tool) ? 'web' : tool === 'Agent' || tool === 'Task' ? 'agent' : 'other'

const stepLabelOf = (tool: string, input: Record<string, unknown>) => {
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined)
  const url = str('url')
  if (url !== undefined) return url.replace(/^https?:\/\//, '').split('/')[0] ?? url
  const named = str('description') ?? str('query') ?? str('skill') ?? str('prompt')
  const short = tool.startsWith('mcp__') ? tool.split('__').pop() ?? tool : tool

  return named === undefined ? short : `${short}: ${named.replace(/\s+/g, ' ')}`
}

// ── diffing ──────────────────────────────────────────────────────────────────
// Line diff by longest common subsequence; very large inputs fall back to
// "all removed, then all added", which pairs into edited lines below.
const diffLines = (a: string[], b: string[]): Op[] => {
  if (a.length * b.length > 250_000) {
    return [
      ...a.map(text => ({ kind: 'del' as const, text })),
      ...b.map(text => ({ kind: 'add' as const, text })),
    ]
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'ctx', text: a[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: 'del', text: a[i++]! })
    } else {
      ops.push({ kind: 'add', text: b[j++]! })
    }
  }
  while (i < a.length) ops.push({ kind: 'del', text: a[i++]! })
  while (j < b.length) ops.push({ kind: 'add', text: b[j++]! })

  return ops
}

// The characters that differ between two versions of a line.
const changedSpans = (was: string, now: string) => {
  let start = 0
  while (start < was.length && start < now.length && was[start] === now[start]) start++
  let end = 0
  while (
    end < was.length - start &&
    end < now.length - start &&
    was[was.length - 1 - end] === now[now.length - 1 - end]
  ) end++

  return {
    beforeSpan: [start, was.length - end] as [number, number],
    span: [start, now.length - end] as [number, number],
  }
}

// Numbers the ops and pairs each run of removed lines with the added lines
// after it: a pair is one edited (orange) line, the rest stay red or green.
const toRows = (ops: Op[], oldStart?: number, newStart?: number): Row[] => {
  const rows: Row[] = []
  let oldNo = oldStart
  let newNo = newStart
  const next = (n: number | undefined) => (n === undefined ? undefined : n + 1)
  for (let k = 0; k < ops.length; ) {
    if (ops[k]!.kind === 'ctx') {
      rows.push({ kind: 'ctx', oldNo, newNo, text: ops[k]!.text })
      oldNo = next(oldNo)
      newNo = next(newNo)
      k++
      continue
    }
    const dels: string[] = []
    const adds: string[] = []
    while (k < ops.length && ops[k]!.kind !== 'ctx') {
      ;(ops[k]!.kind === 'del' ? dels : adds).push(ops[k]!.text)
      k++
    }
    const paired = Math.min(dels.length, adds.length)
    for (let p = 0; p < paired; p++) {
      rows.push({ kind: 'mod', oldNo, newNo, text: adds[p]!, before: dels[p]!, ...changedSpans(dels[p]!, adds[p]!) })
      oldNo = next(oldNo)
      newNo = next(newNo)
    }
    for (const text of dels.slice(paired)) {
      rows.push({ kind: 'del', oldNo, text })
      oldNo = next(oldNo)
    }
    for (const text of adds.slice(paired)) {
      rows.push({ kind: 'add', newNo, text })
      newNo = next(newNo)
    }
  }

  return rows
}

// Keeps changes and CONTEXT lines around them; the rest folds into gap rows.
const hunks = (rows: Row[]): Row[] => {
  const keep = rows.map(() => false)
  rows.forEach((row, i) => {
    if (row.kind === 'ctx') return
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) keep[k] = true
  })
  const out: Row[] = []
  let skipped = 0
  rows.forEach((row, i) => {
    if (keep[i]) {
      if (skipped > 0) out.push({ kind: 'gap', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}` })
      skipped = 0
      out.push(row)
    } else skipped++
  })
  if (skipped > 0 && out.length > 0) out.push({ kind: 'gap', text: `${skipped} unchanged lines` })

  return cap(out)
}

const cap = (rows: Row[]): Row[] =>
  rows.length <= MAX_ROWS
    ? rows
    : [...rows.slice(0, MAX_ROWS - 1), { kind: 'gap', text: `… ${rows.length - MAX_ROWS + 1} more lines` }]

const statsOf = (rows: Row[]): Stats => ({
  add: rows.filter(r => r.kind === 'add').length,
  del: rows.filter(r => r.kind === 'del').length,
  mod: rows.filter(r => r.kind === 'mod').length,
})

// ── typing replay ────────────────────────────────────────────────────────────
// An edit is replayed as if someone typed it: removed text is backspaced away,
// new text typed in with a cursor, row by row in file order, at a pace that
// fits the whole edit into TYPE_MS at most.
const MIN_CPS = 45
const TYPE_MS = 4500
const BACKSPACE = 3
const SCAN_MS = 45

const SCAN_TOTAL_MS = 2500 // the longest a read's sweep may take, however long the read
// Per line of a read: SCAN_MS, quicker for a long read so the sweep reaches its end.
const scanStep = (focus: Focus) => Math.min(SCAN_MS, SCAN_TOTAL_MS / Math.max(1, focus.rows.length))

const spanLength = (span?: [number, number]) => (span === undefined ? 0 : Math.max(0, span[1] - span[0]))

const costOf = (row: Row) =>
  row.kind === 'add'
    ? row.text.length + 3
    : row.kind === 'del'
      ? row.text.length / BACKSPACE + 2
      : row.kind === 'mod'
        ? spanLength(row.beforeSpan) / BACKSPACE + spanLength(row.span) + 3
        : 0

const playback = (focus: Focus) => {
  const isTyped = focus.action === 'editing' || focus.action === 'writing'
  const costs = focus.rows.map(row => (isTyped ? costOf(row) : 0))
  const total = costs.reduce((a, b) => a + b, 0)
  const cps = Math.max(MIN_CPS, (total * 1000) / TYPE_MS)
  const ms = focus.action === 'reading' ? focus.rows.length * scanStep(focus) : (total * 1000) / cps

  return { costs, cps, ms }
}

// ── engine glue ──────────────────────────────────────────────────────────────
const clockNow = ($: Engine) => $.clock.now().catch(() => 0)
const readText = ($: Engine, path: string) =>
  $.fs.read(path).then(
    text => (typeof text === 'string' ? text : undefined),
    () => undefined,
  )

// ~/.claude, from the plugin's own folder somewhere beneath it
const claudeHome = (root: string) => {
  const parts = root.split(/[\\/]/)
  const home = parts.lastIndexOf('.claude')

  return (home >= 0 ? parts.slice(0, home + 1) : parts.slice(0, -1)).join('/')
}

// This session, as the dashboard tells sessions apart; set at session.start.
let sessionId = ''
let sessionCwd = ''
let isEnded = false
// the chat's title as the sidebar shows it; the classic prompt and start events carry it
let sessionTitle = ''

// ── the dashboard's messages ──
// The dashboard server appends what the person types there to
// ~/.claude/live-code-inbox-<session>.json; each second this session reads it
// and submits every message it has not yet, as the person's own prompt, which
// runs once Claude is free. Only the server writes the file, so nothing races.
const inboxHandled = atom({ plugin: 'live-code', key: 'inboxHandled' } as const, [] as string[])
let inboxTimer: Timer | undefined
// What was handled is kept with the session, which Claude starting again does
// not bring back: a message older than this session's start (a minute's grace)
// was sent long ago, and is only marked, never sent again.
let inboxSince = 0
const checkInbox = async ($: Engine) => {
  if (sessionId === '' || isEnded) return
  const text = await readText($, `${claudeHome($.plugin.root)}/live-code-inbox-${sessionId.replace(/[^A-Za-z0-9_-]/g, '')}.json`)
  if (text === undefined) return
  let list: unknown
  try {
    list = JSON.parse(text)
  } catch {
    return
  }
  if (!Array.isArray(list)) return
  const done = await read($, inboxHandled)
  for (const message of list as { id?: unknown; kind?: unknown; text?: unknown; at?: unknown }[]) {
    if (typeof message?.id !== 'string' || done.includes(message.id)) continue
    const id = message.id
    if (typeof message.at !== 'number' || message.at < inboxSince) {
      await update($, inboxHandled, was => [...was, id].slice(-300))
      continue
    }
    // stop: ends the running turn, as Esc does
    if (message.kind === 'stop') {
      await update($, inboxHandled, was => [...was, id].slice(-300))
      if (mainTurnId !== '') void $.turn.abort({ turnId: mainTurnId }).catch(() => undefined)
      continue
    }
    if (typeof message.text !== 'string' || message.text.trim() === '') continue
    await update($, inboxHandled, was => [...was, id].slice(-300))
    // mid-turn it rides along with Claude's next step, as a message typed
    // into a running chat does; idle, it is a prompt of its own
    if (inTurn) midTurn.push(message.text)
    else void $.prompt.submit({ text: message.text, asUser: true }).catch(() => undefined)
  }
}

// Messages from the dashboard that came while Claude worked. A plugin cannot
// add a message to a running turn, so each rides along with the result of
// Claude's next tool call; what no tool call carried is sent once the turn ends.
const midTurn: string[] = []
const midTurnBlock = (texts: string[]) =>
  '\n\n<live-code-dashboard-message>\n' +
  'The person typed this into the Live Code dashboard while you were working. A plugin cannot add a message to a running turn, so it arrives with this tool result; it is theirs, as if typed into this chat:\n\n' +
  texts.join('\n\n---\n\n') +
  '\n</live-code-dashboard-message>'
// The main loop's tool result, with what waits riding along; a refused call
// carries no result, so the next one takes it.
const carry = (e: unknown, ran: ToolCallResult): ToolCallResult => {
  if (midTurn.length === 0 || (e as { agentId?: string }).agentId !== undefined || ran.deny !== undefined) return ran

  return { ...ran, text: `${ran.text ?? ''}${midTurnBlock(midTurn.splice(0))}` } as ToolCallResult
}

// ── the task's plan and its progress ──
// Read off the tool calls that carry it: Claude's task list (TodoWrite, or
// TaskCreate/TaskUpdate) and savvy-flow's progress reports.
const plan = atom({ plugin: 'live-code', key: 'plan' } as const, null as Plan | null)
const taskList = new Map<string, PlanItem>() // TaskCreate/TaskUpdate, by task id
const planStatus = (s: unknown): PlanItem['status'] => (s === 'completed' ? 'done' : s === 'in_progress' ? 'running' : 'pending')
const notePlan = async ($: Engine, tool: string, input: Record<string, unknown>, ran: ToolCallResult) => {
  if (ran.deny !== undefined || ran.isError === true) return
  const t = await clockNow($)
  let next: Plan | null | undefined
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    const items = (input.todos as Record<string, unknown>[]).map(x => ({
      title: String(x.status === 'in_progress' ? x.activeForm ?? x.content ?? '' : x.content ?? ''),
      status: planStatus(x.status),
    }))
    const done = items.filter(x => x.status === 'done').length
    next = { source: 'todos', title: 'Task list', done, total: items.length, items, isFinished: items.length > 0 && done === items.length, updatedAt: t }
  } else if (tool === 'TaskCreate' || tool === 'TaskUpdate') {
    const result = (ran.result ?? {}) as { task?: { id?: string }; taskId?: string }
    const id = String(tool === 'TaskCreate' ? result.task?.id ?? '' : input.taskId ?? result.taskId ?? '')
    if (id === '') return
    const was = taskList.get(id)
    if (input.status === 'deleted') taskList.delete(id)
    else {
      taskList.set(id, {
        title: String(input.status === 'in_progress' && typeof input.activeForm === 'string' ? input.activeForm : input.subject ?? was?.title ?? `Task ${id}`),
        status: input.status === undefined ? was?.status ?? 'pending' : planStatus(input.status),
      })
    }
    const items = [...taskList.values()]
    const done = items.filter(x => x.status === 'done').length
    next = items.length === 0 ? null : { source: 'tasks', title: 'Tasks', done, total: items.length, items, isFinished: done === items.length, updatedAt: t }
  } else if (tool.endsWith('savvy-progress__progress')) {
    const was = await read($, plan)
    const base = was?.source === 'flow' ? was : null
    const tasks = Array.isArray(input.tasks) ? (input.tasks as Record<string, unknown>[]).map(x => String(x.title ?? '')) : base?.items.map(x => x.title) ?? []
    const total = typeof input.total === 'number' ? input.total : base?.total ?? tasks.length
    const done = typeof input.done === 'number' ? input.done : base?.done ?? 0
    next = {
      source: 'flow',
      title: typeof input.title === 'string' ? input.title : base?.title ?? 'Flow',
      phase: typeof input.phase === 'string' ? input.phase : base?.phase,
      done,
      total,
      items: tasks.map((title, i) => ({ title, status: i < done ? 'done' : i === done ? 'running' : 'pending' })),
      isFinished: typeof input.finished === 'boolean' ? input.finished : base?.isFinished ?? false,
      updatedAt: t,
    }
  }
  if (next === undefined) return
  await update($, plan, () => next ?? null)
  void publish($)
}

// The main loop's running turn, which a stop from the dashboard ends.
let mainTurnId = ''

// ── questions answered from elsewhere ──
// While the dashboard (or the Stream Deck through it) is open, a tool call that
// needs the person's yes and Claude's own questions wait for an answer from
// there, from the band's buttons, or from the usual dialog when the person
// picks it. The answer arrives as ~/.claude/live-code-answer-<id>.json.
const asks = atom({ plugin: 'live-code', key: 'asks' } as const, [] as Ask[])
type Answer = { decision?: 'allow' | 'deny' | 'dialog' | 'answer'; reason?: string; answers?: Record<string, string>; response?: string }
const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '')
const answerPath = ($: Engine, id: string) => `${claudeHome($.plugin.root)}/live-code-answer-${safeId(id)}.json`
// the server marks the file every two seconds while a dashboard is connected
const remoteActive = async ($: Engine) => {
  const text = await readText($, `${claudeHome($.plugin.root)}/live-code-remote.json`)
  if (text === undefined) return false
  try {
    const at = (JSON.parse(text) as { at?: unknown }).at
    return typeof at === 'number' && Math.abs((await clockNow($)) - at) < 7000
  } catch {
    return false
  }
}
const answerFrom = ($: Engine, id: string, answer: Answer) => () => $.fs.write(answerPath($, id), JSON.stringify(answer)).catch(() => undefined)
const awaitAnswer = async ($: Engine, ask: Ask, signal?: AbortSignal): Promise<Answer | undefined> => {
  await update($, asks, list => [...list.filter(a => a.id !== ask.id), ask])
  void publish($)
  try {
    // each wait is a process of its own, up to 20 s; the hook's own time stays small
    for (let round = 0; round < 720; round++) {
      if (signal?.aborted) return undefined
      if (!(await remoteActive($))) return { decision: 'dialog' }
      const ran = await $.process.run(['node', `${$.plugin.root}/bin/wait-answer.mjs`, answerPath($, ask.id), '20'], { timeoutMs: 40_000 }).catch(() => undefined)
      // no node to wait with: the dialog asks as always
      if (ran === undefined || ran.exitCode !== 0) return { decision: 'dialog' }
      if (ran.stdout.trim() === '') continue
      try {
        return JSON.parse(ran.stdout) as Answer
      } catch {
        return { decision: 'dialog' }
      }
    }
    return { decision: 'dialog' }
  } finally {
    await update($, asks, list => list.filter(a => a.id !== ask.id))
    void publish($)
  }
}

// (Tool permissions are not routed here: the session's own mode decides them,
// and in auto mode it decides most without asking. Only Claude's questions are.)

// Mirrors the state to two files: ~/.claude/live-code-feed.json, the newest
// session's, for viewer.ps1; and ~/.claude/live-code-session-<id>.json, this
// session's own, for the dashboard. Writes are serialized and coalesced: at
// most one runs and one waits, so a burst of calls costs two writes and each
// file always ends on the newest state.
let publishing: Promise<void> = Promise.resolve()
let publishWaiting = false
const publish = ($: Engine) => {
  if (publishWaiting) return publishing
  publishWaiting = true
  publishing = publishing
    .then(async () => {
      publishWaiting = false
      const [live, past, full, sum, use, think, steps, tNo, prompt, lanes, files, turns, started, waiting, planned] = await Promise.all([
        read($, current),
        read($, history),
        read($, replayQueue),
        read($, totals),
        read($, usage),
        read($, thinking),
        read($, turnSteps),
        read($, turnNo),
        read($, lastPrompt),
        read($, agents),
        read($, fileStats),
        read($, turnStats),
        read($, sessionStart),
        read($, asks),
        read($, plan),
      ])
      // the viewer replays from rows: the newest entries get theirs back
      const rowsOf = new Map(full.map(one => [one.id, one.rows]))
      const feed = {
        current: live,
        history: past.map(one => ({ ...one, rows: rowsOf.get(one.id) ?? one.rows })),
        totals: sum,
        usage: use,
        thinking: think,
        steps,
        turnNo: tNo,
        prompt,
        agents: lanes,
        fileStats: files,
        turnStats: turns,
        asks: waiting,
        plan: planned,
        session: { id: sessionId, cwd: sessionCwd, title: sessionTitle, startedAt: started, updatedAt: await clockNow($), isEnded, canReceive: true, canStop: true, canAnswer: true },
      }
      const home = claudeHome($.plugin.root)
      const text = JSON.stringify(feed)
      await $.fs.write(`${home}/live-code-feed.json`, text)
      if (sessionId !== '') await $.fs.write(`${home}/live-code-session-${sessionId.replace(/[^A-Za-z0-9_-]/g, '')}.json`, text)
    })
    .catch(() => undefined)

  return publishing
}

// A limit in a few words: the time to its reset, and whether the pace lasts
// until then; if not, how long a pause would keep it under 100%.
const limitNote = (l: Limit) => {
  if (l.resetsAt === undefined) return ''
  const resetIn = Math.max(0, Date.parse(l.resetsAt) - Date.now())
  const span = (ms: number) => {
    const m = Math.round(ms / 60_000)
    return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}m`
  }
  if (l.etaMs !== undefined && l.etaMs < resetIn) return `pause ${span(resetIn - l.etaMs)} · reset ${span(resetIn)}`

  return `safe · reset in ${span(resetIn)}`
}

// Each limit's recent readings, to tell its pace; and the warnings already given.
const samples = new Map<string, { t: number; p: number }[]>()
const warned = new Map<string, number>()

// Where a limit is heading at the pace of the last TREND_MS: percent per hour,
// and the time until it is full, if it fills before it resets.
const project = (kind: string, p: number, t: number, resetsAt?: string): Pick<Limit, 'ratePerHour' | 'etaMs'> => {
  const was = samples.get(kind) ?? []
  // a drop means the limit reset: the pace starts over
  const kept = was.length > 0 && p < was[was.length - 1]!.p ? [] : was.filter(s => t - s.t <= TREND_MS)
  if (kept.length === 0 || kept[kept.length - 1]!.p !== p || t - kept[kept.length - 1]!.t > 60_000) kept.push({ t, p })
  samples.set(kind, kept)
  const first = kept[0]!
  const span = t - first.t
  if (span < TREND_MIN_MS || p <= first.p) return {}
  const perMs = (p - first.p) / span
  const etaMs = (100 - p) / perMs
  const resetIn = resetsAt === undefined ? Infinity : Date.parse(resetsAt) - t

  return { ratePerHour: perMs * 3_600_000, etaMs: etaMs < resetIn ? etaMs : undefined }
}

const warnLimits = ($: Engine, limits: Limit[]) => {
  for (const limit of limits) {
    const last = warned.get(limit.kind) ?? 0
    if (limit.percent < last - 5) warned.set(limit.kind, 0) // reset: warn again next time
    const due = LIMIT_WARN.filter(level => limit.percent >= level && level > (warned.get(limit.kind) ?? 0)).pop()
    if (due === undefined) continue
    warned.set(limit.kind, due)
    const pace = limit.etaMs === undefined ? '' : ` — at this pace full in ~${dur(limit.etaMs)}`
    $.ui.toast(`${limitName(limit.kind)} limit at ${Math.round(limit.percent)}%${pace}`)
  }
}

const refreshUsage = async ($: Engine) => {
  const live = await $.session.usage().catch(() => undefined)
  if (live === undefined) return
  const t = await clockNow($)
  const limits: Limit[] = live.rateLimits.map(limit => ({
    kind: limit.kind,
    percent: limit.percentUsed,
    resetsAt: limit.resetsAt,
    ...(t > 0 ? project(limit.kind, limit.percentUsed, t, limit.resetsAt) : {}),
  }))
  await update($, usage, was => {
    // A limit that just reset goes unreported until the next request opens its
    // new window: it stays, at 0% with no reset time, rather than vanish.
    for (const old of was?.limits ?? []) {
      if (limits.some(l => l.kind === old.kind)) continue
      const isPast = old.resetsAt === undefined || Date.parse(old.resetsAt) <= t
      limits.push(isPast ? { kind: old.kind, percent: 0 } : old)
    }
    return {
      output: was?.output ?? 0,
      input: was?.input ?? 0,
      turns: was?.turns ?? 0,
      tokens: live.context.tokens,
      window: live.context.window,
      percent: live.context.percent,
      usd: live.cost?.usd,
      limits,
    }
  })
  warnLimits($, limits)
}

// ── the frame clock ──────────────────────────────────────────────────────────
// Full rate while text types or glows; a quarter of that while only spinners
// turn (a tool running, Claude thinking); stopped once nothing moves.
let ticker: Timer | undefined
let animateUntil = 0
let running = 0
let frames = 0
let usageAt = 0
let inTurn = false
let thinkingOn = false
let thinkingSince = 0
// Text props newer engines draw (mono, weight, size, tabular); older ones refuse the tree.
let richText = false
const touched = new Set<string>()

// Two clocks: `tick` at the full rate, read only by a pane mid-replay; `beat`
// at a quarter of it, read by every drawing for its timers and spinners. So
// the band and an idle pane redraw a few times a second, never every frame.
const animate = async ($: Engine, ms = 0) => {
  const t = await clockNow($)
  animateUntil = Math.max(animateUntil, t + ms + FLASH_MS)
  await Promise.all([update($, tick, () => t), update($, beat, () => t)])
  if (ticker !== undefined) return
  try {
    ticker = $.clock.every(FRAME_MS, () => {
      void (async () => {
        const at = await clockNow($)
        frames++
        const isFast = at < animateUntil
        const isSlow = running > 0 || (thinkingOn && at - thinkingSince < THINK_MAX_MS)
        if (!isFast && !isSlow) {
          ticker?.cancel()
          ticker = undefined
          await Promise.all([update($, tick, () => at), update($, beat, () => at)])
          void publish($)

          return
        }
        if (isFast) await update($, tick, () => at)
        if (frames % IDLE_EVERY === 0) await update($, beat, () => at)
        if (at - usageAt > USAGE_MS) {
          usageAt = at
          await refreshUsage($)
        }
      })().catch(() => undefined)
    })
  } catch {
    ticker = undefined
  }
}

const setThinking = async ($: Engine, active: boolean) => {
  const at = await clockNow($)
  thinkingOn = active
  thinkingSince = at
  await update($, thinking, th => ({ ...th, active, since: active ? at : th.since }))
}

const addStep = ($: Engine, step: TurnStep) => update($, turnSteps, list => [...list.filter(s => s.id !== step.id), step])

const finishStep = async ($: Engine, id: string, status: 'done' | 'error') => {
  const at = await clockNow($)
  await update($, turnSteps, list => list.map(s => (s.id === id ? { ...s, status, doneAt: at } : s)))
}

// Marks a tool as started: thinking pauses, the step joins the pipeline.
const toolStart = async ($: Engine, step: TurnStep) => {
  running++
  try {
    await setThinking($, false)
    await addStep($, step)
  } catch {
    // the tool runs whatever the feed does
  }
}

// Marks a tool as finished: the step settles and Claude reads the result.
const toolDone = async ($: Engine, id: string, isError: boolean) => {
  running--
  try {
    await finishStep($, id, isError ? 'error' : 'done')
    if (inTurn) await setThinking($, true)
    await refreshUsage($)
    await animate($)
    void publish($)
  } catch {
    // never fail a tool that already ran
  }
}

const isFailed = (ran: ToolCallResult) => ran.deny !== undefined || ran.isError === true

// What an action is for, in one sentence in the person's own language, by a
// small model while the tool runs: from the person's prompt, the steps before
// it, and the change itself. A command brings its own description and needs none.
const WHY_SYSTEM =
  "You watch an AI coding agent work and tell its user, in ONE short sentence (max 18 words) in the language of the user's request " +
  '(English when there is none), ' +
  'what the current action does and what it is for. Be concrete: name the feature or the problem, not the tool. ' +
  'For an edit say what changes ("Redraws the limit tiles every second, so the reset countdown runs live"). ' +
  'For a read or search say what is looked for and why. No preamble, no quotes, no file name unless it helps.'
let explaining = 0
// more at once than run at a time wait their turn (the newest dozen), rather than go without
const EXPLAIN_AT_ONCE = 3
const explainLater: Focus[] = []
const rowsForWhy = (rows: Row[]) => {
  const lines: string[] = []
  for (const r of rows) {
    if (r.kind === 'add') lines.push(`+ ${r.text}`)
    else if (r.kind === 'del') lines.push(`- ${r.text}`)
    else if (r.kind === 'mod') lines.push(`- ${r.before ?? ''}`, `+ ${r.text}`)
    else if (r.kind === 'hit') lines.push(`> ${r.text}`)
  }
  return clip(lines.slice(0, 40).join('\n'), 2400)
}
const explain = async ($: Engine, focus: Focus) => {
  if (focus.action === 'running') return
  if (explaining >= EXPLAIN_AT_ONCE) {
    explainLater.push(focus)
    if (explainLater.length > 12) explainLater.shift()
    return
  }
  explaining++
  try {
    const [prompt, steps] = await Promise.all([read($, lastPrompt), read($, turnSteps)])
    const before = steps.filter(s => s.id !== focus.id).slice(-6).map(s => `- ${s.label}`).join('\n')
    const doing =
      focus.action === 'searching'
        ? `searches for ${focus.detail ?? '?'} in ${focus.file}`
        : `${focus.action} ${focus.file}${focus.line ? ` lines ${focus.line}-${focus.endLine ?? focus.line}` : ''}`
    const diff = focus.action === 'editing' || focus.action === 'writing' ? rowsForWhy(focus.rows) : ''
    const r = await $.model.complete({
      model: 'haiku',
      system: WHY_SYSTEM,
      prompt: `The user's request:\n${prompt || '(unknown)'}\n\nSteps just before:\n${before || '(none)'}\n\nCurrent action: the agent ${doing}${diff ? `\n\nThe change:\n${diff}` : ''}`,
      maxTokens: 80,
      effort: 'low',
      timeoutMs: 15_000,
    })
    if (!r.isAnswered) return
    const why = clip(r.text.replace(/\s+/g, ' ').replace(/^["„»]|["“«]$/g, '').trim(), 180)
    if (!why) return
    const put = (f: Focus) => (f.id === focus.id ? { ...f, why } : f)
    await Promise.all([
      update($, current, was => (was ? put(was) : was)),
      update($, history, list => list.map(put)),
      update($, replayQueue, list => list.map(put)),
    ])
    void publish($)
  } catch {
    // no explanation then; the work goes on
  } finally {
    explaining--
    const next = explainLater.shift()
    if (next) void explain($, next)
  }
}

// Shows `focus` as the live spot while the tool runs, then files it into history.
type Draft = Omit<Focus, 'startedAt' | 'isDone' | 'isError' | 'stats'>
const track = async ($: Engine, draft: Draft, stepKind: TurnStep['kind'], run: () => Promise<ToolCallResult>, after?: (ran: ToolCallResult) => Partial<Focus>): Promise<ToolCallResult> => {
  const t = await clockNow($)
  const focus: Focus = { ...draft, stats: statsOf(draft.rows), startedAt: t, isDone: false, isError: false }
  await toolStart($, { id: draft.id, kind: stepKind, label: where(focus), status: 'running', startedAt: t, agentId: draft.agentId })
  try {
    await update($, current, () => focus)
    void explain($, focus)
    $.ui.status(`${ACTION[focus.action].icon} ${where(focus)}`)
    await animate($, playback(focus).ms)
    void publish($)
  } catch {
    // the tool runs whatever the feed does
  }

  let ran: ToolCallResult
  try {
    ran = await run()
  } catch (error) {
    await toolDone($, draft.id, true)
    throw error
  }

  try {
    const extra = after?.(ran) ?? {}
    // the explanation may have landed while the tool ran
    const seen = await read($, current)
    const done: Focus = {
      ...focus,
      ...(seen?.id === focus.id && seen.why ? { why: seen.why } : {}),
      ...extra,
      stats: statsOf(extra.rows ?? focus.rows),
      doneAt: await clockNow($),
      isDone: true,
      isError: isFailed(ran),
    }
    await update($, current, was => (was?.id === focus.id ? done : was))
    // drawings read the history every frame, so it carries no code: a command
    // keeps its first line, as its label; the full rows go to the replay queue
    const light: Focus = { ...done, rows: done.action === 'running' ? done.rows.slice(0, 1) : [] }
    await Promise.all([
      update($, history, list => [...list, light].slice(-HISTORY)),
      update($, replayQueue, list => [...list, done].slice(-KEEP_ROWS)),
    ])
    if (!done.isError) {
      const isFile = done.action === 'reading' || done.action === 'editing' || done.action === 'writing'
      if (isFile) {
        touched.add(done.file)
        await update($, fileStats, list => {
          const was = list.find(f => f.file === done.file) ?? { file: done.file, reads: 0, edits: 0, add: 0, del: 0, mod: 0, lastAt: 0 }
          const next: FileStat = {
            ...was,
            reads: was.reads + (done.action === 'reading' ? 1 : 0),
            edits: was.edits + (done.action === 'reading' ? 0 : 1),
            add: was.add + done.stats.add,
            del: was.del + done.stats.del,
            mod: was.mod + done.stats.mod,
            lastAt: done.doneAt ?? done.startedAt,
          }

          return [...list.filter(f => f.file !== done.file), next]
        })
      }
      await update($, totals, sum => ({
        files: touched.size,
        add: sum.add + done.stats.add,
        del: sum.del + done.stats.del,
        mod: sum.mod + done.stats.mod,
        reads: sum.reads + (done.action === 'reading' ? 1 : 0),
        edits: sum.edits + (done.action === 'editing' || done.action === 'writing' ? 1 : 0),
        searches: sum.searches + (done.action === 'searching' ? 1 : 0),
        commands: (sum.commands ?? 0) + (done.action === 'running' ? 1 : 0),
      }))
    }
  } catch {
    // never fail a tool that already ran
  }
  await toolDone($, draft.id, isFailed(ran))

  return ran
}

type TextLook = { size?: 'caption' | 'footnote' | 'body' | 'heading' | 'title'; weight?: 'regular' | 'medium' | 'semibold' | 'bold'; tabular?: boolean; mono?: boolean }
// The newer Text props where the engine draws them; on an older one, bold for a heavy weight.
const T = (look: TextLook): TextLook | { bold?: boolean } =>
  richText ? look : look.weight === 'bold' || look.weight === 'semibold' ? { bold: true } : {}
// ── what every drawing reads ─────────────────────────────────────────────────
// Every value at once (the reads run side by side). The fast clock is read,
// and so subscribed to, only while the live spot still types or glows: the
// write that starts a replay changes `current`, which redraws and subscribes.
const snapshot = async ($: Parameters<typeof read>[0], wantsFast: boolean) => {
  const [live, past, sum, use, slow, think, steps, tNo, prompt, files, turns, lanes, filter, tab] = await Promise.all([
    read($, current),
    read($, history),
    read($, totals),
    read($, usage),
    read($, beat),
    read($, thinking),
    read($, turnSteps),
    read($, turnNo),
    read($, lastPrompt),
    read($, fileStats),
    read($, turnStats),
    read($, agents),
    read($, recentFilter),
    read($, panelTab),
  ])
  const isMoving = live !== null && live.startedAt > 0 && slow < live.startedAt + playback(live).ms + FLASH_MS + 500
  const fast = wantsFast && isMoving ? await read($, tick) : 0

  return { live, past, sum, use, t: Math.max(slow, fast), think, steps, tNo, prompt, files, turns, lanes, filter, tab }
}

const turnInfo = (think: ThinkingState, steps: TurnStep[], tNo: number, t: number) => {
  const isLive = (think.turnEndedAt ?? 0) < (think.turnStartedAt ?? 0)
  const start = think.turnStartedAt ?? think.since
  const ms = t <= 0 || start <= 0 ? 0 : (isLive ? t : think.turnEndedAt ?? t) - start

  return {
    isLive,
    ms,
    showThinking: think.active && t > 0,
    showSummary: !isLive && tNo > 0 && think.turnEndedAt !== undefined,
    failed: steps.filter(s => s.status === 'error').length,
  }
}

const limitName = (kind: string) =>
  kind === 'five_hour' ? '5H' : kind === 'seven_day' ? '7D' : kind.slice(0, 7)
const clampPct = (p: number) => Math.min(100, Math.max(0, p))
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// ── the typing replay, as it stands at a moment ──────────────────────────────
// How one surface paints the replay: the runs' styles, the cursor, the gutter.
type Style = Omit<Seg, 'text'>
type Paint = {
  add: Style
  del: Style
  modSpan: Style
  modRest: Style
  scan: Style
  cursor: Seg
  sign: { add: string; del: string; mod: string; scan: string; gap: string; hit: string }
}

const terminalPaint = (level: number, blink: boolean): Paint => ({
  add: { color: INK.add, bg: GLOW.add[level] },
  del: { color: '#ffffff', bg: GLOW.del[1] },
  modSpan: { color: '#ffffff', bold: true, bg: GLOW.mod[level] },
  modRest: { color: INK.mod },
  scan: { color: '#ffffff', bg: '#1e3a5f' },
  cursor: { text: blink ? '▌' : ' ', color: '#ffffff' },
  sign: { add: INK.add, del: INK.del, mod: INK.mod, scan: '#38bdf8', gap: INK.gap, hit: INK.hit },
})

// Translucent tints read on a light and a dark theme alike.
const TINT = ['8c', '66', '40', '26']
const richPaint = (level: number, blink: boolean): Paint => ({
  add: { bg: `#22c55e${TINT[level]}` },
  del: { bg: '#ef444473', strike: true },
  modSpan: { bold: true, bg: `#f97316${TINT[level]}` },
  modRest: { color: '#ea580c' },
  scan: { bg: '#38bdf840', bold: true },
  cursor: { text: blink ? '▌' : ' ', color: 'claude' },
  sign: { add: '#16a34a', del: '#dc2626', mod: '#ea580c', scan: '#0284c7', gap: '#64748b', hit: '#9333ea' },
})

const replayAt = (live: Focus | null, t: number) => {
  const replay = live === null ? undefined : playback(live)
  // no clock (a test): every edit shows finished
  const elapsedMs = live !== null && t > 0 && live.startedAt > 0 ? t - live.startedAt : Infinity
  const isReplaying = replay !== undefined && elapsedMs < replay.ms
  const age = replay === undefined || !Number.isFinite(elapsedMs) ? Infinity : elapsedMs - replay.ms
  const level = isReplaying ? 1 : Math.min(3, Math.max(0, Math.floor(age / (FLASH_MS / 3))))

  return {
    replay,
    elapsedMs,
    isReplaying,
    level,
    typed: replay === undefined ? 0 : (elapsedMs / 1000) * replay.cps,
    scanAt: live?.action === 'reading' && Number.isFinite(elapsedMs) ? Math.floor(elapsedMs / scanStep(live)) : Infinity,
  }
}

// One row at `k` characters into its replay (of `cost`); null while not on screen.
const viewOf = (row: Row, i: number, k: number, cost: number, scanAt: number, paint: Paint): View | null => {
  const isDone = cost === 0 || k >= cost
  const cursor = isDone ? [] : [paint.cursor]
  switch (row.kind) {
    case 'ctx': {
      const isScanned = i === scanAt

      return {
        sign: isScanned ? '▸' : ' ',
        ink: isScanned ? paint.sign.scan : undefined,
        no: row.newNo ?? row.oldNo,
        segs: [{ text: row.text, ...(isScanned ? paint.scan : {}), dim: i > scanAt }],
        isActive: isScanned,
        isChange: false,
      }
    }
    case 'add': {
      if (k <= 0 && cost > 0) return null // not typed yet
      const n = isDone ? row.text.length : Math.min(row.text.length, Math.floor(k))

      return {
        sign: '+',
        ink: paint.sign.add,
        no: row.newNo,
        segs: [{ text: row.text.slice(0, n), ...paint.add }, ...cursor],
        isActive: !isDone,
        isChange: true,
      }
    }
    case 'del': {
      if (isDone) return null // backspaced away
      if (k <= 0) return { sign: ' ', no: row.oldNo, segs: [{ text: row.text }], isActive: false, isChange: true }
      const n = Math.min(row.text.length, Math.floor(k * BACKSPACE))

      return {
        sign: '−',
        ink: paint.sign.del,
        no: row.oldNo,
        segs: [{ text: row.text.slice(0, row.text.length - n), ...paint.del }, paint.cursor],
        isActive: true,
        isChange: true,
      }
    }
    case 'mod': {
      const before = row.before ?? ''
      const [b0, b1] = row.beforeSpan ?? [0, before.length]
      const [s0, s1] = row.span ?? [0, row.text.length]
      const erase = (b1 - b0) / BACKSPACE
      if (k <= 0 && cost > 0) return { sign: ' ', no: row.oldNo, segs: [{ text: before }], isActive: false, isChange: true }
      if (!isDone && k < erase) {
        const n = Math.min(b1 - b0, Math.floor(k * BACKSPACE))

        return {
          sign: '~',
          ink: paint.sign.mod,
          no: row.oldNo,
          segs: [{ text: before.slice(0, b0) }, { text: before.slice(b0, b1 - n), ...paint.del }, paint.cursor, { text: before.slice(b1) }],
          isActive: true,
          isChange: true,
        }
      }
      const n = isDone ? s1 - s0 : Math.min(s1 - s0, Math.floor(k - erase))

      return {
        sign: '~',
        ink: paint.sign.mod,
        no: row.newNo,
        segs: [
          { text: row.text.slice(0, s0), ...paint.modRest },
          { text: row.text.slice(s0, s0 + n), ...paint.modSpan },
          ...cursor,
          { text: row.text.slice(s1), ...paint.modRest },
        ],
        isActive: !isDone,
        isChange: true,
      }
    }
    case 'gap':
      return { sign: '⋯', ink: paint.sign.gap, segs: [{ text: row.text, color: paint.sign.gap }], isActive: false, isChange: false }
    case 'hit':
      return { sign: '◆', ink: paint.sign.hit, segs: [{ text: row.text, color: paint.sign.hit }], isActive: false, isChange: false }
  }
}

// Every row as it stands, and a window of them that follows the cursor.
const codeWindow = (live: Focus | null, at: ReturnType<typeof replayAt>, paint: Paint, room: number) => {
  const views: View[] = []
  let spent = 0
  let activeAt = -1
  ;(live?.rows ?? []).forEach((row, i) => {
    const cost = at.replay?.costs[i] ?? 0
    const k = cost === 0 ? 0 : Math.min(cost, Math.max(0, at.typed - spent))
    spent += cost
    const view = viewOf(row, i, k, cost, at.scanAt, paint)
    if (view === null) return
    if (view.isActive && activeAt < 0) activeAt = views.length
    views.push(view)
  })
  // Follows the cursor (or the read's sweep) a third of the way down; once the
  // replay is over it stays where the replay ended (the last change of an
  // edit, the end of anything else), so finishing moves nothing.
  const lastChange = views.reduce((at, v, i) => (v.isChange ? i : at), -1)
  const followAt = activeAt >= 0 ? activeAt : live?.action === 'editing' && lastChange >= 0 ? lastChange : views.length - 1
  const top = views.length <= room ? 0 : Math.min(views.length - room, Math.max(0, followAt - Math.floor(room / 3)))
  const visible = views.slice(top, top + room)

  return { views, visible, top, below: views.length - top - visible.length }
}

// Once a replay is over, the window's lines as highlighted source, where they
// are plain lines of a file or a command (a read, a new file, a command): the
// same lines in the same rows, so settling only adds colour. Edits keep the diff.
const windowCode = (live: Focus, visible: View[]) => {
  const isPlain =
    live.action === 'reading' ||
    live.action === 'running' ||
    (live.action === 'writing' && live.rows.every(r => r.kind === 'add' || r.kind === 'gap'))
  if (!isPlain || visible.length === 0 || visible.some(v => v.sign === '⋯' || v.sign === '◆')) return undefined
  const source = visible.map(v => v.segs.map(s => s.text).join('')).join('\n')

  return live.action === 'running'
    ? { source, language: live.file === 'PowerShell' ? 'powershell' : 'bash' }
    : { source, path: live.file, startLine: visible[0]!.no ?? 1 }
}

// ── vector pieces, for the surfaces that draw Svg ────────────────────────────
// Each source depends only on slow-changing values, never on the frame, so a
// redraw hands the surface the same markup and its SMIL animation runs on.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const svgOpen = (w: number, ht: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${ht}" viewBox="0 0 ${w} ${ht}">`
const FONT = 'font-family="ui-sans-serif,system-ui,Segoe UI,sans-serif"'
const heat = (p: number) => (p < 50 ? '#22c55e' : p < 70 ? '#eab308' : p < 85 ? '#f97316' : '#ef4444')
const DESK_ACTION: Record<Action, string> = {
  reading: '#0284c7', editing: '#ea580c', writing: '#16a34a', searching: '#9333ea', running: '#ca8a04',
}
const DESK_STEP: Record<TurnStep['kind'], string> = {
  read: '#0284c7', edit: '#ea580c', write: '#16a34a', search: '#9333ea',
  bash: '#ca8a04', web: '#0d9488', agent: '#db2777', other: '#64748b',
}

const dotSvg = (color: string) => `${svgOpen(14, 14)}<circle cx="7" cy="7" r="4" fill="${color}"/></svg>`

// A ring for the context window, a gradient bar for it and each rate limit.
const usageSvg = (use: Usage, width: number) => {
  const rows = [
    { label: 'Context', p: use.percent ?? 0, note: `${human(use.tokens ?? 0)} / ${human(use.window)}` },
    ...use.limits.map(l => ({
      label: limitName(l.kind),
      p: l.percent,
      note: limitNote(l),
    })),
  ]
  const ctx = clampPct(use.percent ?? 0)
  const ht = Math.max(68, rows.length * 22 + 12)
  const cy = ht / 2
  const r = 25
  const c = 2 * Math.PI * r
  const x0 = 80
  const barX = x0 + 58
  const barW = Math.max(40, width - barX - 140)
  const top = (ht - rows.length * 22) / 2
  let out =
    svgOpen(width, ht) +
    `<defs><linearGradient id="heat" gradientUnits="userSpaceOnUse" x1="${barX}" x2="${barX + barW}">` +
    `<stop offset="0" stop-color="#22c55e"/><stop offset=".5" stop-color="#22c55e"/><stop offset=".62" stop-color="#eab308"/>` +
    `<stop offset=".78" stop-color="#f97316"/><stop offset=".92" stop-color="#ef4444"/></linearGradient></defs>` +
    `<circle cx="34" cy="${cy}" r="${r}" fill="none" stroke="#94a3b8" stroke-opacity=".22" stroke-width="7"/>` +
    `<circle cx="34" cy="${cy}" r="${r}" fill="none" stroke="${heat(ctx)}" stroke-width="7" stroke-linecap="round" ` +
    `stroke-dasharray="${((c * ctx) / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 34 ${cy})"/>` +
    `<text x="34" y="${cy + 5}" text-anchor="middle" ${FONT} font-size="14" font-weight="700" fill="${heat(ctx)}">${Math.round(ctx)}%</text>`
  rows.forEach((row, i) => {
    const y = top + i * 22 + 11
    const p = clampPct(row.p)
    out +=
      `<text x="${x0}" y="${y + 4}" ${FONT} font-size="11" font-weight="600" fill="#94a3b8">${esc(row.label)}</text>` +
      `<rect x="${barX}" y="${y - 4}" width="${barW}" height="8" rx="4" fill="#94a3b8" fill-opacity=".2"/>` +
      (p > 0 ? `<rect x="${barX}" y="${y - 4}" width="${Math.max(8, (barW * p) / 100).toFixed(1)}" height="8" rx="4" fill="url(#heat)"/>` : '') +
      `<text x="${barX + barW + 10}" y="${y + 4}" ${FONT} font-size="11" font-weight="700" fill="${heat(p)}">${Math.round(p)}%</text>` +
      (row.note === '' ? '' : `<text x="${barX + barW + 48}" y="${y + 4}" ${FONT} font-size="10" fill="#94a3b8">${esc(row.note)}</text>`)
  })

  return `${out}</svg>`
}

// One row tall: while Claude thinks, three slow sine waves scrolling a period
// forever, faded at both ends; otherwise a still, faint line of the same size,
// so the row never changes height.
const waveSvg = (width: number, isMoving: boolean) => {
  const ht = 16
  const period = 64
  if (!isMoving) {
    return `${svgOpen(width, ht)}<line x1="0" y1="${ht / 2}" x2="${width}" y2="${ht / 2}" stroke="#94a3b8" stroke-opacity=".25" stroke-width="1"/></svg>`
  }
  const path = (amp: number, phase: number) => {
    let d = ''
    for (let x = 0; x <= width + period; x += 4) {
      d += `${d === '' ? 'M' : ' L'}${x} ${(ht / 2 + amp * Math.sin((x / period) * 2 * Math.PI + phase)).toFixed(1)}`
    }

    return d
  }
  const scroll = (seconds: number) =>
    `<animateTransform attributeName="transform" type="translate" from="0 0" to="-${period} 0" dur="${seconds}s" repeatCount="indefinite"/>`

  return (
    svgOpen(width, ht) +
    `<defs><linearGradient id="fade" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".12" stop-color="#fff"/>` +
    `<stop offset=".88" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    `<mask id="m"><rect width="${width}" height="${ht}" fill="url(#fade)"/></mask></defs>` +
    `<g mask="url(#m)" fill="none" stroke-linecap="round">` +
    `<path d="${path(2.5, 2)}" stroke="#818cf8" stroke-opacity=".45" stroke-width="1.2">${scroll(3.4)}</path>` +
    `<path d="${path(5, 0)}" stroke="#a78bfa" stroke-width="2">${scroll(2.4)}</path>` +
    `<path d="${path(2, 4)}" stroke="#c084fc" stroke-opacity=".7" stroke-width="1">${scroll(1.8)}</path>` +
    `</g></svg>`
  )
}

const miniBarSvg = (p: number, width: number) => {
  const v = clampPct(p)

  return (
    svgOpen(width, 8) +
    `<rect y="1" width="${width}" height="6" rx="3" fill="#94a3b8" fill-opacity=".25"/>` +
    (v > 0 ? `<rect y="1" width="${Math.max(6, (width * v) / 100).toFixed(1)}" height="6" rx="3" fill="${heat(v)}"/>` : '') +
    `</svg>`
  )
}

// How much a file went through: changed lines count most, then edits, then reads.
const fileWeight = (f: FileStat) => (f.add + f.del + f.mod) * 2 + f.edits * 3 + f.reads

// One file's changed lines as a stacked bar, scaled to the busiest file.
const fileBarSvg = (f: FileStat, most: number, width: number) => {
  const per = most === 0 ? 0 : width / most
  let x = 0
  let out = `${svgOpen(width, 10)}<rect y="2" width="${width}" height="6" rx="3" fill="#94a3b8" fill-opacity=".15"/>`
  for (const [n, color] of [[f.add, '#22c55e'], [f.mod, '#f97316'], [f.del, '#ef4444']] as const) {
    if (n <= 0) continue
    const w = Math.max(3, n * per)
    out += `<rect x="${x.toFixed(1)}" y="2" width="${w.toFixed(1)}" height="6" rx="2" fill="${color}"/>`
    x += w + 1
  }

  return `${out}</svg>`
}

// The turns as columns by what they cost (or their tokens, where no cost is
// known); hovering a column names its turn.
const turnsSvg = (turns: TurnStat[], width: number) => {
  const ht = 56
  const value = (s: TurnStat) => s.usd ?? (s.tokensIn + s.tokensOut) / 1e6
  const most = Math.max(...turns.map(value), 1e-9)
  const slot = width / Math.max(turns.length, 12)
  const w = Math.max(3, slot - 3)
  const top = turns.reduce((a, b) => (value(b) > value(a) ? b : a), turns[0]!)
  let out = `${svgOpen(width, ht)}<line x1="0" y1="${ht - 0.5}" x2="${width}" y2="${ht - 0.5}" stroke="#94a3b8" stroke-opacity=".35"/>`
  turns.forEach((s, i) => {
    const bh = Math.max(2, (value(s) / most) * (ht - 6))
    const color = s === top && turns.length > 1 ? '#f97316' : s.failed > 0 ? '#ef4444' : '#8b5cf6'
    const label = `Turn ${s.no}: ${s.usd === undefined ? '' : `$${s.usd.toFixed(2)} · `}${human(s.tokensIn + s.tokensOut)} tokens · ${dur(s.ms)} · ${plural(s.steps, 'step')}`
    out += `<rect x="${(i * slot).toFixed(1)}" y="${(ht - bh).toFixed(1)}" width="${w.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${color}"><title>${esc(label)}</title></rect>`
  })

  return `${out}</svg>`
}

const SPARK = '▁▂▃▄▅▆▇█'
const sparkline = (values: number[]) => {
  const most = Math.max(...values, 1e-9)

  return values.map(v => SPARK[Math.min(SPARK.length - 1, Math.floor((v / most) * (SPARK.length - 1)))]).join('')
}

const turnSummary = (turns: TurnStat[]) => {
  const costs = turns.filter(s => s.usd !== undefined)
  const top = turns.reduce((a, b) => ((b.usd ?? 0) > (a.usd ?? 0) ? b : a), turns[0]!)
  const avg = costs.length === 0 ? undefined : costs.reduce((a, s) => a + (s.usd ?? 0), 0) / costs.length

  return { avg, top }
}

// What a search found. Grep answers with file names, matching lines (content
// mode) or counts per file (count mode); Glob with file names.
const hitsOf = (ran: ToolCallResult): Row[] => {
  const r = (ran.result ?? {}) as { filenames?: string[]; content?: string; mode?: string; numMatches?: number; numLines?: number; totalMatches?: number }
  const lines = typeof r.content === 'string' && r.content.trim() !== '' ? r.content.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim() !== '') : []
  const found = lines.length > 0 ? lines : r.filenames ?? []
  const total = r.mode === 'count' ? r.numMatches ?? found.length : r.numLines ?? r.totalMatches ?? found.length
  const unit = lines.length > 0 && r.mode !== 'count' ? 'matching line' : 'file'
  if (found.length === 0) return [{ kind: 'gap', text: 'nothing found' }]

  return [
    { kind: 'gap', text: plural(total, unit) + (r.mode === 'count' ? ` · ${r.numMatches ?? 0} ${r.numMatches === 1 ? 'match' : 'matches'}}` : '') },
    ...found.slice(0, 12).map(name => ({ kind: 'hit' as const, text: name.length > 240 ? `${name.slice(0, 240)}…` : name })),
    ...(found.length > 12 ? [{ kind: 'gap' as const, text: `${found.length - 12} more` }] : []),
  ]
}

// A new message: a new turn begins and Claude starts thinking. Both prompt
// hooks call it; the second one, moments later, is the same turn.
const beginTurn = async ($: Engine, text: string) => {
  const t = await clockNow($)
  if (inTurn && t - ((await read($, thinking)).turnStartedAt ?? 0) < 10_000) return
  const n = (await read($, turnNo)) + 1
  const usdAtStart = (await read($, usage))?.usd
  inTurn = true
  thinkingOn = true
  thinkingSince = t
  await Promise.all([
    update($, turnNo, () => n),
    update($, turnSteps, () => []),
    // agents still working in the background keep their lane
    update($, agents, list => list.filter(a => a.status === 'running')),
    update($, lastPrompt, () => clip(text.replace(/\s+/g, ' ').trim(), 200)),
    update($, thinking, () => ({ active: true, since: t, turnNo: n, turnStartedAt: t, usdAtStart })),
  ])
  await animate($)
  void publish($)
}

// Runs bin/ensure-server.mjs, told this chat (its own feed, written as it
// starts, is not taken for another chat at work); how it went is kept in
// ~/.claude/live-code-ensure-run.json, for finding out why the dashboard did (not) open.
const runEnsure = async ($: Engine) => {
  const at = await clockNow($)
  const ran = await $.process.run(['node', `${$.plugin.root}/bin/ensure-server.mjs`, `--session=${sessionId}`], { timeoutMs: 15_000 }).then(
    r => ({ exitCode: r.exitCode, stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 1500) }),
    (e: unknown) => ({ error: String(e).slice(0, 1500) }),
  )
  await $.fs.write(`${claudeHome($.plugin.root)}/live-code-ensure-run.json`, JSON.stringify({ at, session: sessionId, ...ran }, null, 1)).catch(() => undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'live-code',
      description: 'Show the file and line Claude is working on, live',
    })
    await $.command.register({
      name: 'live-code-setup',
      description: 'Set up the Live Code dashboard: shortcuts, Stream Deck plugin, tile windows',
    })
    // (the pane opens on /live-code: the dashboard shows it all, outside Claude)
    void refreshUsage($)
    // a reload fires session.start again: the session's first start stays
    const t = await clockNow($)
    await update($, sessionStart, was => (was > 0 ? was : t)).catch(() => undefined)
    if (inboxSince === 0) inboxSince = t - 60_000
    sessionCwd = e.cwd
    isEnded = false
    sessionId = await $.session.id().then(id => (typeof id === 'string' ? id : ''), () => '')
    // the dashboard server starts with Claude: unless it runs, it is started, hidden
    void runEnsure($)
    void publish($)
    inboxTimer?.cancel()
    try {
      inboxTimer = $.clock.every(1000, () => void checkInbox($).catch(() => undefined))
    } catch {
      inboxTimer = undefined
    }
    try {
      const at = (await $.session.version()).version.split(/[.-]/).map(Number)
      richText = (at[0] ?? 0) * 1e6 + (at[1] ?? 0) * 1e3 + (at[2] ?? 0) >= 2_001_299
    } catch {
      richText = false
    }

    return next(e)
  })

  // The chat's title, which names the session in the dashboard's picker; it can
  // change (an automatic title after the first message, a rename), so each
  // prompt reads it again. Only read: the event goes on unchanged.
  const keepTitle = (title: unknown) => {
    if (typeof title === 'string' && title.trim() !== '') sessionTitle = title.trim().slice(0, 120)
  }
  // Some prompts (the first after /compact) reach only this classic hook: it
  // starts the turn too, and whichever of the two comes second does nothing.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    keepTitle((e as { session_title?: unknown }).session_title)
    const said = (e as { prompt?: unknown }).prompt
    await beginTurn($, typeof said === 'string' ? said : '').catch(() => undefined)

    return next(e)
  })
  on('classic.SessionStart', ($, e, next) => {
    keepTitle((e as { session_title?: unknown }).session_title)

    return next(e)
  })

  // The session ends: its file says so, and the dashboard shows it as ended.
  on('session.end', async ($, e, next) => {
    isEnded = true
    inTurn = false
    thinkingOn = false
    await publish($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'live-code' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Live code pane opened.' }
  })

  // the one-click setup: shortcuts, Stream Deck plugin, tile windows, the dashboard opened
  on('command.run', { command: 'live-code-setup' }, async $ => {
    const ran = await $.process.run(['node', `${$.plugin.root}/bin/setup.mjs`], { timeoutMs: 120_000 }).catch(() => undefined)
    return { text: ran?.stdout.trim() || 'Live Code setup ran.' }
  })

  on('prompt.submit', async ($, e, next) => {
    await beginTurn($, (e as { text?: string }).text ?? '')

    return next(e)
  }).catch(($, e, next) => next(e))

  // a dashboard message waiting mid-turn rides along with the main loop's next tool result

  // the main loop's turn, for a stop from the dashboard
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) mainTurnId = e.turnId

    return next(e)
  })

  // Claude's questions: with a dashboard open, answerable there too.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (!(await remoteActive($))) return next(e)
    const raw = ((e as { questions?: unknown }).questions ?? []) as Record<string, unknown>[]
    const questions: AskQuestion[] = raw.map(q => ({
      question: String(q.question ?? ''),
      header: String(q.header ?? ''),
      options: (Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : []).map(o => ({
        label: String(o.label ?? ''),
        ...(typeof o.description === 'string' ? { description: o.description } : {}),
      })),
      multiSelect: q.multiSelect === true,
      ...(q.kind === 'text' || q.kind === 'number' ? { kind: q.kind } : {}),
      ...(typeof q.placeholder === 'string' ? { placeholder: q.placeholder } : {}),
      ...(typeof q.min === 'number' ? { min: q.min } : {}),
      ...(typeof q.max === 'number' ? { max: q.max } : {}),
      ...(typeof q.step === 'number' ? { step: q.step } : {}),
      ...(typeof q.unit === 'string' ? { unit: q.unit } : {}),
    }))
    if (questions.length === 0) return next(e)
    const answer = await awaitAnswer(
      $,
      { id: e.tool_use_id, kind: 'question', tool: 'AskUserQuestion', title: questions[0]!.question, detail: '', questions, at: await clockNow($), agentId: agentOf(e) },
      next.signal,
    )
    if (answer?.decision !== 'answer' || answer.answers === undefined) return next(e)
    const given = Object.fromEntries(
      Object.entries(answer.answers)
        .filter(([q, v]) => typeof v === 'string' && v.trim() !== '' && questions.some(one => one.question === q))
        .map(([q, v]) => [q, v.slice(0, 2000)]),
    )
    const said = Object.entries(given).map(([q, v]) => `"${q}"="${v}"`).join(', ')
    const free = typeof answer.response === 'string' && answer.response.trim() !== '' ? answer.response.trim().slice(0, 4000) : undefined

    return {
      result: { questions: raw, answers: given, ...(free !== undefined ? { response: free } : {}) },
      text:
        (said === '' ? 'User did not pick any option.' : `User has answered your questions: ${said}.`) +
        (free !== undefined ? ` The user also wrote: ${free}` : '') +
        ' You can now continue with the user\'s answers in mind.',
    } as never
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    try {
      const t = await clockNow($)
      // a subagent's turn ends its lane, not the main turn
      const agentId = agentOf(e)
      if (agentId !== undefined) {
        await update($, agents, list =>
          list.map(a => (a.id === agentId ? { ...a, status: 'done' as const, doneAt: t } : a)),
        )
        await animate($)
        void publish($)

        return ran
      }
      inTurn = false
      thinkingOn = false
      // dashboard messages no tool call carried: a prompt of their own now
      if (midTurn.length > 0) void $.prompt.submit({ text: midTurn.splice(0).join('\n\n'), asUser: true }).catch(() => undefined)
      const used = e.usage
      if (used !== undefined) {
        await update($, usage, was => ({
          window: 0,
          limits: [],
          ...was,
          output: (was?.output ?? 0) + used.output_tokens,
          input:
            (was?.input ?? 0) +
            used.input_tokens +
            used.cache_read_input_tokens +
            used.cache_creation_input_tokens,
          turns: (was?.turns ?? 0) + 1,
        }))
      }
      await refreshUsage($)
      const [th, steps, use] = await Promise.all([read($, thinking), read($, turnSteps), read($, usage)])
      const stat: TurnStat = {
        no: th.turnNo,
        ms: th.turnStartedAt === undefined ? 0 : t - th.turnStartedAt,
        tokensIn: used === undefined ? 0 : used.input_tokens + used.cache_read_input_tokens + used.cache_creation_input_tokens,
        tokensOut: used?.output_tokens ?? 0,
        usd: use?.usd !== undefined && th.usdAtStart !== undefined ? Math.max(0, use.usd - th.usdAtStart) : undefined,
        steps: steps.filter(s => s.agentId === undefined).length,
        failed: steps.filter(s => s.status === 'error').length,
        at: t,
      }
      await Promise.all([
        update($, thinking, was => ({ ...was, active: false, turnEndedAt: t })),
        update($, turnStats, list => [...list.filter(s => s.no !== stat.no), stat].slice(-MAX_TURNS)),
      ])
      await animate($)
      void publish($)
    } catch {
      // the turn is over whatever the feed does
    }

    return ran
  })

  // A subagent starting: it gets a lane, which its own tool calls fill.
  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    try {
      const agentId = 'agentId' in ran ? ran.agentId : undefined
      if (agentId !== undefined) {
        const lane: AgentLane = {
          id: agentId,
          name: e.name ?? e.description,
          type: e.subagentType,
          status: 'running',
          startedAt: await clockNow($),
        }
        await update($, agents, list => [...list.filter(a => a.id !== agentId), lane])
        await animate($)
        void publish($)
      }
    } catch {
      // the agent runs whatever the feed does
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Every tool without a hook of its own: shells become a live spot with the
  // command, the rest a step in the turn pipeline.
  on('tool.call', async ($, e, next) => {
    const tool = (e as { tool: string }).tool
    if (HANDLED.has(tool)) return carry(e, await next(e))
    const input = e as unknown as Record<string, unknown>
    const id = String(input.tool_use_id ?? `${tool}-${Date.now()}`)

    if (SHELLS.has(tool)) {
      const command = typeof input.command === 'string' ? input.command : ''
      const rows: Row[] = cap(
        splitLines(command)
          .filter(line => line.trim() !== '')
          .map((text, i) => ({ kind: 'ctx' as const, newNo: i + 1, text })),
      )
      const description = typeof input.description === 'string' ? input.description : undefined

      return carry(e, await track($, { id, agentId: agentOf(e), action: 'running', file: tool, detail: description, rows }, 'bash', () => next(e)))
    }

    const t = await clockNow($)
    await toolStart($, { id, kind: stepKindOf(tool), label: stepLabelOf(tool, input), status: 'running', startedAt: t, agentId: agentOf(e) })
    await animate($)
    let ran: ToolCallResult
    try {
      ran = await next(e)
    } catch (error) {
      await toolDone($, id, true)
      throw error
    }
    await toolDone($, id, isFailed(ran))
    await notePlan($, tool, input, ran).catch(() => undefined)

    return carry(e, ran)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const text = await readText($, e.file_path)
    const all = text === undefined ? [] : splitLines(text)
    const line = e.offset ?? 1
    const endLine = Math.min(all.length || Infinity, line + (e.limit ?? 2000) - 1)
    // the whole range read, up to MAX_ROWS lines; the sweep runs through all of it
    const last = Math.min(all.length, endLine)
    const rows: Row[] = all
      .slice(line - 1, Math.min(last, line - 1 + MAX_ROWS))
      .map((one, i) => ({ kind: 'ctx', oldNo: line + i, newNo: line + i, text: one }))
    if (last - (line - 1) > MAX_ROWS) rows.push({ kind: 'gap', text: `${last - (line - 1) - MAX_ROWS} more lines read` })

    return track($, {
      id: e.tool_use_id,
      agentId: agentOf(e),
      action:'reading',
      file: e.file_path,
      line,
      endLine: Number.isFinite(endLine) ? endLine : undefined,
      rows,
    }, 'read', () => next(e))
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    // Compared with Windows line endings taken out of all three: a CRLF file and
    // an LF old_string still find each other, so the diff gets its place.
    const lf = (text: string) => text.replace(/\r\n/g, '\n')
    const raw = await readText($, e.file_path)
    const before = raw === undefined ? undefined : lf(raw)
    const oldString = lf(e.old_string)
    const newString = lf(e.new_string)
    const index = before === undefined ? -1 : before.indexOf(oldString)
    let rows: Row[]
    let line: number | undefined
    let endLine: number | undefined
    if (before !== undefined && index >= 0) {
      // Widen the replaced text to whole lines, so the diff shows real lines.
      const lineStart = index === 0 ? 0 : before.lastIndexOf('\n', index - 1) + 1
      const stop = before.indexOf('\n', index + oldString.length)
      const lineEnd = stop < 0 ? before.length : stop
      const oldBlock = before.slice(lineStart, lineEnd)
      const at = index - lineStart
      const newBlock = oldBlock.slice(0, at) + newString + oldBlock.slice(at + oldString.length)
      const all = splitLines(before)
      const oldLines = splitLines(oldBlock)
      const newLines = splitLines(newBlock)
      line = splitLines(before.slice(0, lineStart)).length
      const lead = all.slice(Math.max(0, line - 1 - CONTEXT), line - 1)
      const tail = all.slice(line - 1 + oldLines.length, line - 1 + oldLines.length + CONTEXT)
      const ops: Op[] = [
        ...lead.map(text => ({ kind: 'ctx' as const, text })),
        ...diffLines(oldLines, newLines),
        ...tail.map(text => ({ kind: 'ctx' as const, text })),
      ]
      rows = cap(toRows(ops, line - lead.length, line - lead.length))
      endLine = line + Math.max(newLines.length, 1) - 1
    } else {
      rows = cap(toRows(diffLines(splitLines(oldString), splitLines(newString))))
    }

    return track($, {
      id: e.tool_use_id,
      agentId: agentOf(e),
      action:'editing',
      file: e.file_path,
      line,
      endLine,
      detail: e.replace_all === true ? 'every match' : undefined,
      rows,
    }, 'edit', () => next(e))
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const before = await readText($, e.file_path)
    const newLines = splitLines(e.content)
    const rows =
      before === undefined
        ? cap(newLines.map((text, i) => ({ kind: 'add' as const, newNo: i + 1, text })))
        : hunks(toRows(diffLines(splitLines(before), newLines), 1, 1))
    const first = rows.find(row => row.kind !== 'ctx' && row.kind !== 'gap')

    return track($, {
      id: e.tool_use_id,
      agentId: agentOf(e),
      action:'writing',
      file: e.file_path,
      line: first?.newNo ?? first?.oldNo ?? 1,
      endLine: before === undefined ? newLines.length : undefined,
      detail: before === undefined ? 'new file' : 'rewrite',
      rows,
    }, 'write', () => next(e))
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const focus: Draft = {
      id: e.tool_use_id,
      agentId: agentOf(e),
      action: 'editing',
      file: e.notebook_path,
      detail: e.cell_id !== undefined ? `cell ${e.cell_id}` : 'notebook',
      rows: cap(splitLines(e.new_source).map(text => ({ kind: 'add' as const, text }))),
    }
    return track($, focus, 'edit', () => next(e))
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Grep' }, async ($, e, next) => {
    const focus: Draft = { id: e.tool_use_id, agentId: agentOf(e), action: 'searching', file: e.path ?? '.', detail: `“${e.pattern}”${e.glob ? ` (${e.glob})` : e.type ? ` (${e.type})` : ''}`, rows: [] }
    return track($, focus, 'search', () => next(e), ran => ({ rows: hitsOf(ran) }))
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Glob' }, async ($, e, next) => {
    const focus: Draft = { id: e.tool_use_id, agentId: agentOf(e), action: 'searching', file: e.path ?? '.', detail: e.pattern, rows: [] }
    return track($, focus, 'search', () => next(e), ran => ({ rows: hitsOf(ran) }))
  }).catch(($, e, next) => next(e))

  // ── the pane ───────────────────────────────────────────────────────────────
  // A fixed layout: every section keeps its height whatever happens, so nothing
  // jumps; only what is inside a slot changes. The status slot is always there
  // (planning, thinking, a tool, done), the code window always has `room` rows,
  // and the history, files, turns and agents share one tabbed panel.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const { live, past, sum, use, t, think, steps: allSteps, tNo, prompt, files, turns, lanes, filter, tab } = await snapshot($, true)
    const steps = allSteps.filter(s => s.agentId === undefined)
    const isRich = e.surface !== 'terminal'
    const cols = Math.max(30, (e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 80)
    const height = e.viewport?.rows ?? 40
    const slow = Math.floor(t / FRAME_MS / IDLE_EVERY)
    const turn = turnInfo(think, steps, tNo, t)
    const at = replayAt(live, t)
    const paint = isRich ? richPaint(at.level, true) : terminalPaint(at.level, true)

    // ── the slots: their heights depend on the pane's size alone ──
    const usageRows = use === null ? 0 : isRich ? 8 : 4 + use.limits.length
    const bodyRows = height >= 52 ? 8 : height >= 36 ? 5 : 0 // the tabbed panel; none on a short pane
    const reserved = 2 + usageRows + 5 + 2 + 6 + (bodyRows > 0 ? bodyRows + 3 : 0)
    const room = Math.max(6, Math.min(40, height - reserved))
    const code = codeWindow(live, at, paint, room)
    const tag = live === null ? undefined : ACTION[live.action]
    const isWorking = turn.isLive || (live !== null && !live.isDone)
    const typedPct =
      live !== null && at.isReplaying && at.replay !== undefined && live.action !== 'reading'
        ? Math.min(100, Math.round((100 * at.elapsedMs) / at.replay.ms))
        : undefined
    const liveFor =
      live === null ? '' : live.isDone && live.doneAt !== undefined ? dur(live.doneAt - live.startedAt) : t > live.startedAt ? dur(t - live.startedAt) : ''
    const mark = live === null ? '' : typedPct !== undefined ? `⌨ ${typedPct}%` : !live.isDone ? '…' : live.isError ? '✗' : '✓'
    const scroll = `${code.top > 0 ? `↑${code.top} ` : ''}${code.below > 0 ? `↓${code.below}` : ''}`.trim()
    const settled = live !== null && !at.isReplaying ? windowCode(live, code.visible) : undefined

    const status: { kind: 'think' | 'tool' | 'work' | 'done' | 'idle'; title: string; info: string } = turn.showThinking
      ? {
          kind: 'think',
          title: steps.length === 0 ? 'Planning' : 'Thinking',
          info: `${dur(t - think.since)}${steps.length > 0 ? ` · after ${plural(steps.length, 'step')}` : ''}`,
        }
      : live !== null && !live.isDone && tag !== undefined
        ? { kind: 'tool', title: `${tag.label} ${where(live)}`, info: liveFor }
        : turn.isLive
          ? { kind: 'work', title: 'Working', info: dur(turn.ms) }
          : turn.showSummary
            ? {
                kind: 'done',
                title: `Turn ${tNo} done`,
                info: `${dur(turn.ms)} · ${plural(steps.length, 'step')}${turn.failed > 0 ? ` · ${turn.failed} failed` : ''}`,
              }
            : { kind: 'idle', title: 'Waiting for your first message', info: '' }

    const shownSteps = steps.slice(-MAX_STEPS)
    const earlier = steps.length - shownSteps.length
    const runningLanes = lanes.filter(l => l.status === 'running').length
    const topFiles = [...files].sort((a, b) => fileWeight(b) - fileWeight(a)).slice(0, Math.min(MAX_FILES, bodyRows))
    const mostLines = Math.max(0, ...topFiles.map(f => f.add + f.del + f.mod))
    const recent = past
      .filter(one => one.id !== live?.id && (filter === null || one.file === filter))
      .slice(-Math.min(MAX_RECENT, bodyRows))
      .reverse()
    const tabs: [PanelTab, string][] = [
      ['recent', filter === null ? 'Recent' : `Recent: ${baseName(filter)}`],
      ['files', `Files ${files.length}`],
      ['turns', `Turns ${turns.length}`],
      ...(lanes.length > 0 ? [['agents', `Agents ${runningLanes > 0 ? `${runningLanes}/` : ''}${lanes.length}`] as [PanelTab, string]] : []),
    ]
    const shownTab: PanelTab = tabs.some(([id]) => id === tab) ? tab : 'recent'
    const setTab = (id: PanelTab) => () => update($, panelTab, () => id)
    const toggleFilter = (file: string) => () =>
      Promise.all([update($, recentFilter, was => (was === file ? null : file)), update($, panelTab, () => 'recent' as PanelTab)])
    const clearFilter = () => update($, recentFilter, () => null)
    const recentLabel = (one: Focus) =>
      one.action === 'running' ? `${one.file}: ${one.detail ?? one.rows[0]?.text ?? ''}` : where(one)

    const codeWidth = Math.max(10, cols - 11)
    const fit = (segs: Seg[]) => {
      let left = codeWidth
      const out: Seg[] = []
      for (const seg of segs) {
        if (left <= 0) break
        const text = seg.text.length > left ? `${seg.text.slice(0, Math.max(0, left - 1))}…` : seg.text
        left -= text.length
        if (text.length > 0) out.push({ ...seg, text })
      }

      return out
    }
    const monoProps = isRich ? T({ mono: true }) : {}
    const drawView = (view: View) => (
      <Text {...monoProps} wrap="truncate-end">
        <Text color={view.ink ?? (isRich ? 'inactive' : undefined)} dimColor={!isRich && view.ink === undefined}>
          {pad(view.no, 5)} {view.sign} │{' '}
        </Text>
        {fit(view.segs).map(seg => (
          <Text color={seg.color} backgroundColor={seg.bg} bold={seg.bold} dimColor={seg.dim} strikethrough={seg.strike}>
            {seg.text}
          </Text>
        ))}
      </Text>
    )

    // ── the graphical surfaces: cards, vector gauges, highlighted code ──
    if (isRich) {
      const { Svg, Code } = ui as unknown as Elements['desktop']
      const px = Math.min(620, Math.max(240, cols * 7))
      const color = live === null ? '#64748b' : live.isError ? '#dc2626' : DESK_ACTION[live.action]
      const statusInk =
        status.kind === 'think'
          ? '#7c3aed'
          : status.kind === 'tool'
            ? color
            : status.kind === 'work'
              ? 'claude'
              : status.kind === 'done'
                ? turn.failed > 0
                  ? '#ea580c'
                  : '#16a34a'
                : 'inactive'
      const chip = (text: string, ink: string, isSolid = false) => (
        <Box backgroundColor={isSolid ? ink : `${ink}26`} paddingX={1}>
          <Text color={isSolid ? '#ffffff' : ink} {...T({ weight: 'semibold' })} {...T({ tabular: true })} wrap="truncate-end">
            {text}
          </Text>
        </Box>
      )
      const statChips = (stats: Stats) => (
        <Box flexDirection="row" gap={1}>
          {stats.add > 0 && chip(`+${stats.add}`, '#16a34a')}
          {stats.del > 0 && chip(`−${stats.del}`, '#dc2626')}
          {stats.mod > 0 && chip(`~${stats.mod}`, '#ea580c')}
        </Box>
      )
      const paces = use?.limits.filter(l => l.ratePerHour !== undefined) ?? []

      const panel =
        shownTab === 'files' ? (
          topFiles.length === 0 ? (
            <Text color="inactive">No file touched yet</Text>
          ) : (
            topFiles.map(f => (
              <Box flexDirection="row" gap={1} alignItems="center" height={1} overflow="hidden">
                <Box width={24}>
                  <Button key={`file:${f.file}`} plain onPress={toggleFilter(f.file)}>
                    <Text color={filter === f.file ? 'claude' : undefined} {...T({ weight: filter === f.file ? 'bold' : 'medium' })} wrap="truncate-end">
                      {baseName(f.file)}
                    </Text>
                  </Button>
                </Box>
                <Svg source={fileBarSvg(f, mostLines, 140)} alt={`${f.add} added, ${f.mod} edited, ${f.del} removed`} width={140} height={10} />
                <Text color="inactive" {...T({ tabular: true })} wrap="truncate-end">
                  {f.add > 0 ? `+${f.add} ` : ''}
                  {f.mod > 0 ? `~${f.mod} ` : ''}
                  {f.del > 0 ? `−${f.del} ` : ''}· {plural(f.edits, 'edit')} · {plural(f.reads, 'read')}
                </Text>
              </Box>
            ))
          )
        ) : shownTab === 'turns' ? (
          turns.length === 0 ? (
            <Text color="inactive">No finished turn yet</Text>
          ) : (
            (() => {
              const { avg, top } = turnSummary(turns)

              return (
                <Box flexDirection="column">
                  <Svg source={turnsSvg(turns, px)} alt={`${plural(turns.length, 'turn')} by cost`} width={px} height={56} isInteractive />
                  <Box flexDirection="row" gap={2} height={1} overflow="hidden">
                    {avg !== undefined && <Text color="inactive" {...T({ tabular: true })}>Ø ${avg.toFixed(2)} / turn</Text>}
                    {turns.length > 1 && (
                      <Text color="#ea580c" {...T({ tabular: true })}>
                        most: Turn {top.no}
                        {top.usd !== undefined ? ` $${top.usd.toFixed(2)}` : ''} · {human(top.tokensIn + top.tokensOut)} tokens
                      </Text>
                    )}
                    <Text color="inactive" {...T({ tabular: true })}>last: {dur(turns[turns.length - 1]!.ms)}</Text>
                  </Box>
                </Box>
              )
            })()
          )
        ) : shownTab === 'agents' ? (
          lanes.slice(-bodyRows).map(lane => {
            const own = allSteps.filter(s => s.agentId === lane.id)
            const isRunning = lane.status === 'running'

            return (
              <Box flexDirection="row" gap={1} alignItems="center" height={1} overflow="hidden">
                {chip(`◈ ${clip(lane.name, 28)}${isRunning ? ' …' : lane.status === 'done' ? ' ✓' : ' ✗'}`, lane.status === 'error' ? '#dc2626' : DESK_STEP.agent, isRunning)}
                <Text color="inactive">{lane.type}</Text>
                <Text>
                  {own.slice(-MAX_STEPS).map(step => (
                    <Text color={step.status === 'error' ? '#dc2626' : DESK_STEP[step.kind]}>{STEP_ICON[step.kind]} </Text>
                  ))}
                </Text>
                <Box flexGrow={1} />
                <Text color="inactive" {...T({ tabular: true })}>
                  {plural(own.length, 'step')} · {dur((lane.doneAt ?? t) - lane.startedAt)}
                </Text>
              </Box>
            )
          })
        ) : recent.length === 0 ? (
          <Text color="inactive">{filter === null ? 'Nothing yet' : `Nothing for ${baseName(filter)} yet`}</Text>
        ) : (
          recent.map(one => (
            <Box flexDirection="row" gap={1} alignItems="center" height={1} overflow="hidden">
              <Text color="inactive" {...T({ tabular: true })}>{clock(one.startedAt)}</Text>
              <Text color={one.isError ? '#dc2626' : DESK_ACTION[one.action]} wrap="truncate-end">
                {one.isError ? '✗' : ACTION[one.action].icon} {recentLabel(one)}
              </Text>
              {statChips(one.stats)}
              <Box flexGrow={1} />
              {one.doneAt !== undefined && <Text color="inactive" {...T({ tabular: true })}>{dur(one.doneAt - one.startedAt)}</Text>}
            </Box>
          ))
        )

      return (
        <Box flexDirection="column" gap={1}>
          {/* header: one row; says plainly whether Claude works or waits */}
          <Box flexDirection="row" alignItems="center" gap={1} height={1} overflow="hidden">
            <Svg source={dotSvg(isWorking ? '#ef4444' : '#94a3b8')} alt={isWorking ? 'working' : 'idle'} width={14} height={14} />
            <Text {...T({ weight: 'bold' })} color="claude">Live Code</Text>
            {chip(isWorking ? 'Working' : 'Idle · waiting for you', isWorking ? '#dc2626' : '#64748b')}
            {tNo > 0 && <Text color="inactive" {...T({ tabular: true })}>Turn {tNo} · {dur(turn.ms)}</Text>}
            <Box flexGrow={1} />
            {chip(plural(sum.files, 'file'), '#64748b')}
            {statChips(sum)}
            {chip(`👁 ${sum.reads}  ✎ ${sum.edits}  ⌕ ${sum.searches}  $ ${sum.commands ?? 0}`, '#64748b')}
          </Box>

          {/* usage: a ring, gradient bars, and where each limit is heading */}
          {use !== null && (
            <Box borderStyle="round" borderColor="subtle" paddingX={1} flexDirection="column">
              <Svg source={usageSvg(use, px)} alt={`Context ${use.percent ?? 0}% used`} width={px} />
              <Box flexDirection="row" gap={2} height={1} overflow="hidden">
                <Text {...T({ weight: 'semibold' })} color={heat(use.percent ?? 0)} {...T({ tabular: true })}>
                  Context {use.percent ?? 0}%
                </Text>
                <Text color="inactive" {...T({ tabular: true })}>
                  {human(use.tokens ?? 0)} / {human(use.window)}
                </Text>
                <Text color="#0284c7" {...T({ tabular: true })}>↑ {human(use.input)} in</Text>
                <Text color="#7c3aed" {...T({ tabular: true })}>↓ {human(use.output)} out</Text>
                {use.usd !== undefined && (
                  <Text color="#ca8a04" {...T({ weight: 'semibold' })} {...T({ tabular: true })}>${use.usd.toFixed(2)}</Text>
                )}
                <Text color="inactive">{plural(use.turns, 'turn')}</Text>
              </Box>
              <Box flexDirection="row" gap={1} height={1} overflow="hidden">
                {paces.length === 0 ? (
                  <Text color="inactive">Limit pace: measuring (needs a few minutes)</Text>
                ) : (
                  paces.map(l =>
                    chip(
                      l.etaMs !== undefined
                        ? `${limitName(l.kind)} full in ~${dur(l.etaMs)} · +${l.ratePerHour!.toFixed(1)}%/h`
                        : `${limitName(l.kind)} +${l.ratePerHour!.toFixed(1)}%/h · safe until reset`,
                      l.etaMs !== undefined && l.etaMs < 60 * 60_000 ? '#dc2626' : l.etaMs !== undefined ? '#ea580c' : '#16a34a',
                    ),
                  )
                )}
              </Box>
            </Box>
          )}

          {/* status: always three rows, whatever Claude is doing */}
          <Box borderStyle="round" borderColor={status.kind === 'think' ? '#8b5cf6' : 'subtle'} paddingX={1} flexDirection="column" height={5}>
            <Box flexDirection="row" gap={1} height={1} overflow="hidden">
              <Text color={statusInk} {...T({ weight: 'bold' })} wrap="truncate-end">
                {status.kind === 'done' ? '✓ ' : isWorking ? `${SPINNER[slow % SPINNER.length]} ` : ''}
                {status.title}
              </Text>
              <Text color="inactive" {...T({ tabular: true })}>{status.info}</Text>
            </Box>
            <Svg
              source={waveSvg(px, status.kind === 'think')}
              alt={status.kind === 'think' ? 'Claude is thinking' : 'divider'}
              width={px}
              height={16}
              isInteractive={status.kind === 'think'}
            />
            <Text color="inactive" italic wrap="truncate-end">{prompt.length > 0 ? `“${prompt}”` : ' '}</Text>
          </Box>

          {/* the last steps of the turn, one row */}
          <Box flexDirection="row" gap={1} alignItems="center" height={1} overflow="hidden">
            <Text color="inactive">{tNo > 0 ? `T${tNo}` : 'Steps'}</Text>
            {earlier > 0 && <Text color="inactive">+{earlier}</Text>}
            {shownSteps.length === 0 && <Text color="inactive">none yet</Text>}
            {shownSteps.map(step => {
              const ink = step.status === 'error' ? '#dc2626' : DESK_STEP[step.kind]

              return step.status === 'running'
                ? chip(`${STEP_ICON[step.kind]} ${clip(step.label, 26)} …`, ink, true)
                : chip(`${STEP_ICON[step.kind]}${step.status === 'error' ? ' ✗' : ''}${step.doneAt === undefined ? '' : ` ${dur(step.doneAt - step.startedAt)}`}`, ink)
            })}
            <Box flexGrow={1} />
            {runningLanes > 0 && chip(`◈ ${plural(runningLanes, 'agent')} working`, DESK_STEP.agent, true)}
          </Box>

          {/* the live spot: always `room` rows of code */}
          <Box borderStyle="round" borderColor={color} paddingX={1} flexDirection="column" height={room + 4}>
            <Box flexDirection="row" gap={1} alignItems="center" height={1} overflow="hidden">
              {live === null || tag === undefined ? (
                <Text color="inactive">No file touched yet</Text>
              ) : (
                <Box flexDirection="row" gap={1} alignItems="center" flexGrow={1}>
                  {chip(`${tag.icon} ${tag.label}`, color, true)}
                  <Text {...T({ weight: 'bold' })} color={color} wrap="truncate-end">{where(live)}</Text>
                  {statChips(live.stats)}
                  {live.detail !== undefined && live.action !== 'searching' && <Text color="inactive" wrap="truncate-end">{live.detail}</Text>}
                  <Box flexGrow={1} />
                  {scroll !== '' && <Text color="inactive" {...T({ tabular: true })}>{scroll}</Text>}
                  <Text color="inactive" {...T({ tabular: true })}>{mark} {liveFor}</Text>
                </Box>
              )}
            </Box>
            <Text color="inactive" wrap="truncate-start">{live === null || dirName(live.file) === '' ? ' ' : dirName(live.file)}</Text>
            <Box flexDirection="column" height={room} overflow="hidden">
              {settled !== undefined ? (
                <Code
                  source={settled.source}
                  language={'language' in settled ? settled.language : undefined}
                  path={'path' in settled ? settled.path : undefined}
                  startLine={'startLine' in settled ? settled.startLine : undefined}
                  wrap="truncate-end"
                />
              ) : (
                code.visible.map(drawView)
              )}
            </Box>
          </Box>

          {/* recent, files, turns, agents: one panel of fixed height, by tab */}
          {bodyRows > 0 && (
            <Box flexDirection="column">
              <Box flexDirection="row" gap={2} height={1} overflow="hidden">
                {tabs.map(([id, label]) => (
                  <Button key={`tab:${id}`} plain onPress={setTab(id)}>
                    <Text color={id === shownTab ? 'claude' : 'inactive'} {...T({ weight: id === shownTab ? 'bold' : 'medium' })}>
                      {label}
                    </Text>
                  </Button>
                ))}
                {filter !== null && (
                  <Button key="clear-filter" plain onPress={clearFilter}>
                    <Text color="inactive">✕ filter</Text>
                  </Button>
                )}
              </Box>
              <Box flexDirection="column" height={bodyRows} overflow="hidden">
                {panel}
              </Box>
            </Box>
          )}
        </Box>
      )
    }

    // ── the terminal: one grid of styled characters ──
    const barWidth = Math.max(10, Math.min(36, cols - 34))
    const bar = (percent: number, width: number) => {
      const p = clampPct(percent)
      const filled = Math.round((p / 100) * width)
      const runs: [number, string][] = []
      let from = 0
      for (const [stop, color] of BAR_STOPS) {
        const to = Math.min(filled, Math.ceil(stop * width))
        if (to > from) runs.push([to - from, color])
        from = Math.max(from, to)
      }

      return (
        <Text>
          {runs.map(([n, color]) => (
            <Text color={color}>{'█'.repeat(n)}</Text>
          ))}
          <Text dimColor>{'░'.repeat(Math.max(0, width - filled))}</Text>
        </Text>
      )
    }
    const wave = (width: number) => {
      const runs: [string, number][] = []
      for (let i = 0; i < width; i++) {
        const level = Math.max(0, Math.min(4, Math.round(2 + 2 * Math.sin((i - slow * 1.2) / 2.6))))
        const ch = WAVE_CHARS[level]!
        const last = runs[runs.length - 1]
        if (last !== undefined && last[1] === level) last[0] += ch
        else runs.push([ch, level])
      }

      return (
        <Text>
          {runs.map(([text, level]) => (
            <Text color={WAVE_INK[level]}>{text}</Text>
          ))}
        </Text>
      )
    }
    const counts = (stats: Stats) => (
      <Text>
        {stats.add > 0 && <Text color={INK.add}> +{stats.add}</Text>}
        {stats.del > 0 && <Text color={INK.del}> −{stats.del}</Text>}
        {stats.mod > 0 && <Text color={INK.mod}> ~{stats.mod}</Text>}
      </Text>
    )
    const rule = (width: number) => '─'.repeat(Math.max(4, Math.min(64, width)))
    const statusInk =
      status.kind === 'think' ? '#a5b4fc' : status.kind === 'tool' && tag !== undefined ? tag.color : status.kind === 'done' ? (turn.failed > 0 ? INK.mod : INK.add) : status.kind === 'work' ? '#a78bfa' : undefined
    const termBar = (f: FileStat) => {
      const per = mostLines === 0 ? 0 : 16 / mostLines
      const cells = (n: number) => (n <= 0 ? '' : '█'.repeat(Math.max(1, Math.round(n * per))))

      return (
        <Text>
          <Text color={INK.add}>{cells(f.add)}</Text>
          <Text color={INK.mod}>{cells(f.mod)}</Text>
          <Text color={INK.del}>{cells(f.del)}</Text>
        </Text>
      )
    }
    const termPanel =
      shownTab === 'files' ? (
        topFiles.length === 0 ? (
          <Text dimColor>No file touched yet</Text>
        ) : (
          topFiles.map(f => (
            <Box flexDirection="row" height={1} overflow="hidden">
              <Button key={`file:${f.file}`} plain onPress={toggleFilter(f.file)}>
                <Text color={filter === f.file ? '#a78bfa' : undefined} bold={filter === f.file}>
                  {clip(baseName(f.file), 22).padEnd(23)}
                </Text>
              </Button>
              {termBar(f)}
              <Text dimColor>
                {'  '}
                {f.add > 0 ? `+${f.add} ` : ''}
                {f.mod > 0 ? `~${f.mod} ` : ''}
                {f.del > 0 ? `−${f.del} ` : ''}· {f.edits}e {f.reads}r
              </Text>
            </Box>
          ))
        )
      ) : shownTab === 'turns' ? (
        turns.length === 0 ? (
          <Text dimColor>No finished turn yet</Text>
        ) : (
          (() => {
            const { avg, top } = turnSummary(turns)

            return (
              <Box flexDirection="column">
                <Text>
                  <Text color="#a78bfa">{sparkline(turns.map(s => s.usd ?? (s.tokensIn + s.tokensOut) / 1e6))}</Text>
                  {avg !== undefined && <Text dimColor>{'  '}Ø ${avg.toFixed(2)}/turn</Text>}
                  {turns.length > 1 && (
                    <Text color={INK.mod}>
                      {'  '}most T{top.no}
                      {top.usd !== undefined ? ` $${top.usd.toFixed(2)}` : ''}
                    </Text>
                  )}
                </Text>
                {turns
                  .slice(-(bodyRows - 1))
                  .reverse()
                  .map(s => (
                    <Text dimColor wrap="truncate-end">
                      T{String(s.no).padEnd(4)} {s.usd !== undefined ? `$${s.usd.toFixed(2)}`.padEnd(7) : '       '} {human(s.tokensIn + s.tokensOut).padStart(6)} tok {dur(s.ms).padStart(7)} {plural(s.steps, 'step')}
                    </Text>
                  ))}
              </Box>
            )
          })()
        )
      ) : shownTab === 'agents' ? (
        lanes.slice(-bodyRows).map(lane => {
          const own = allSteps.filter(s => s.agentId === lane.id)

          return (
            <Text wrap="truncate-end">
              <Text color={lane.status === 'error' ? INK.del : '#f472b6'} bold={lane.status === 'running'}>
                ◈ {clip(lane.name, 28)} {lane.status === 'running' ? '…' : lane.status === 'done' ? '✓' : '✗'}
              </Text>
              <Text dimColor> {lane.type} </Text>
              {own.slice(-MAX_STEPS).map(step => (
                <Text color={step.status === 'error' ? INK.del : STEP_COLOR[step.kind]}>{STEP_ICON[step.kind]} </Text>
              ))}
              <Text dimColor> {dur((lane.doneAt ?? t) - lane.startedAt)}</Text>
            </Text>
          )
        })
      ) : recent.length === 0 ? (
        <Text dimColor>{filter === null ? 'Nothing yet' : `Nothing for ${baseName(filter)} yet`}</Text>
      ) : (
        recent.map(one => (
          <Text wrap="truncate-end">
            <Text dimColor>{clock(one.startedAt)} </Text>
            <Text color={one.isError ? INK.del : ACTION[one.action].color}>
              {one.isError ? '✗' : ACTION[one.action].icon} {clip(recentLabel(one), Math.max(10, cols - 40))}
            </Text>
            {counts(one.stats)}
            {one.doneAt !== undefined && <Text dimColor>  {dur(one.doneAt - one.startedAt)}</Text>}
          </Text>
        ))
      )

    return (
      <Box flexDirection="column">
        {/* header */}
        <Text wrap="truncate-end">
          <Text color={isWorking ? '#f87171' : '#475569'}>● </Text>
          <Text bold color="#0b0b0f" backgroundColor="#a78bfa">{' ◆ LIVE CODE '}</Text>
          <Text color={isWorking ? '#f87171' : undefined} dimColor={!isWorking}>
            {'  '}
            {isWorking ? 'Working' : 'Idle · waiting for you'}
          </Text>
          {tNo > 0 && <Text dimColor>{'  '}T{tNo} {dur(turn.ms)}</Text>}
          <Text dimColor>{'  '}{sum.files} files</Text>
          {counts(sum)}
          <Text dimColor>
            {'  '}👁 {sum.reads}{'  '}✎ {sum.edits}{'  '}⌕ {sum.searches}{'  '}$ {sum.commands ?? 0}
          </Text>
        </Text>

        {/* usage */}
        {use !== null && (
          <Box flexDirection="column" marginTop={1}>
            <Text wrap="truncate-end">
              <Text bold>{'CONTEXT '}</Text>
              {bar(use.percent ?? 0, barWidth)}
              <Text bold> {String(use.percent ?? 0).padStart(3)}%</Text>
              <Text dimColor>
                {'  '}
                {human(use.tokens ?? 0)} / {human(use.window)}
              </Text>
            </Text>
            {use.limits.map(limit => (
              <Text wrap="truncate-end">
                <Text bold>{limitName(limit.kind).padEnd(8)}</Text>
                {bar(limit.percent, barWidth)}
                <Text bold> {String(Math.round(limit.percent)).padStart(3)}%</Text>
                {limit.etaMs !== undefined ? (
                  <Text color={limit.etaMs < 60 * 60_000 ? INK.del : INK.mod}>{'  '}full in ~{dur(limit.etaMs)}</Text>
                ) : limit.ratePerHour !== undefined ? (
                  <Text color={INK.add}>{'  '}+{limit.ratePerHour.toFixed(1)}%/h</Text>
                ) : null}
                {limit.resetsAt !== undefined && <Text dimColor>{'  '}resets {clock(Date.parse(limit.resetsAt)).slice(0, 5)}</Text>}
              </Text>
            ))}
            <Text wrap="truncate-end">
              <Text color="#38bdf8">↑ {human(use.input)} in</Text>
              <Text color="#a78bfa">{'   '}↓ {human(use.output)} out</Text>
              {use.usd !== undefined && <Text color="#facc15">{'   '}${use.usd.toFixed(2)}</Text>}
              <Text dimColor>{'   '}{use.turns} turns</Text>
            </Text>
          </Box>
        )}

        {/* status: always three rows */}
        <Box flexDirection="column" marginTop={1} height={3} overflow="hidden">
          <Text wrap="truncate-end">
            <Text color={statusInk}>
              {status.kind === 'done' ? '✓' : status.kind === 'think' ? THINK_SPIN[slow % THINK_SPIN.length] : isWorking ? SPINNER[slow % SPINNER.length] : '·'}{' '}
            </Text>
            <Text bold color={statusInk}>{status.title}</Text>
            <Text dimColor>{'  '}{status.info}</Text>
          </Text>
          {status.kind === 'think' ? (
            <Text>{'  '}{wave(Math.max(8, Math.min(60, cols - 4)))}</Text>
          ) : (
            <Text dimColor>{'  '}{'╌'.repeat(Math.max(8, Math.min(60, cols - 4)))}</Text>
          )}
          <Text dimColor wrap="truncate-end">{prompt.length > 0 ? `  ❝ ${prompt}` : ' '}</Text>
        </Box>

        {/* the last steps, one row */}
        <Text wrap="truncate-end">
          <Text dimColor>{tNo > 0 ? `T${tNo} ` : 'Steps '}</Text>
          {earlier > 0 && <Text dimColor>+{earlier} </Text>}
          {shownSteps.length === 0 && <Text dimColor>none yet</Text>}
          {shownSteps.map((step, i) => (
            <Text>
              {i > 0 && <Text dimColor> › </Text>}
              {step.status === 'running' ? (
                <Text bold color="#0b0b0f" backgroundColor={STEP_COLOR[step.kind]}>
                  {` ${STEP_ICON[step.kind]} ${clip(step.label, 22)} … `}
                </Text>
              ) : (
                <Text color={step.status === 'error' ? INK.del : STEP_COLOR[step.kind]}>
                  {STEP_ICON[step.kind]}
                  {step.status === 'error' ? '✗' : ''}
                </Text>
              )}
              {step.status !== 'running' && step.doneAt !== undefined && <Text dimColor>{` ${dur(step.doneAt - step.startedAt)}`}</Text>}
            </Text>
          ))}
          {runningLanes > 0 && <Text color="#f472b6">{'   '}◈ {plural(runningLanes, 'agent')} working</Text>}
        </Text>

        {/* the live spot: always `room` rows of code */}
        <Box flexDirection="column" marginTop={1}>
          <Text wrap="truncate-end">
            {live === null || tag === undefined ? (
              <Text dimColor>No file touched yet</Text>
            ) : (
              <Text>
                <Text bold color="#0b0b0f" backgroundColor={live.isError ? INK.del : tag.color}>{` ${tag.icon} ${tag.label} `}</Text>
                <Text bold color={tag.color}> {where(live)}</Text>
                {counts(live.stats)}
                {live.detail !== undefined && live.action !== 'searching' && <Text dimColor>  {clip(live.detail, Math.max(10, cols - 50))}</Text>}
                <Text dimColor>
                  {'  '}
                  {mark} {liveFor}
                  {scroll !== '' ? `  ${scroll}` : ''}
                </Text>
              </Text>
            )}
          </Text>
          <Text dimColor wrap="truncate-start">{live === null || dirName(live.file) === '' ? ' ' : dirName(live.file)}</Text>
          <Text dimColor>{'        ┌'}{rule(cols - 10)}</Text>
          <Box flexDirection="column" height={room} overflow="hidden">
            {code.visible.map(drawView)}
          </Box>
          <Text dimColor>{'        └'}{rule(cols - 10)}</Text>
        </Box>

        {/* recent, files, turns, agents: one panel of fixed height, by tab */}
        {bodyRows > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row" height={1} overflow="hidden">
              {tabs.map(([id, label]) => (
                <Button key={`tab:${id}`} plain onPress={setTab(id)}>
                  <Text color={id === shownTab ? '#a78bfa' : undefined} bold={id === shownTab} dimColor={id !== shownTab}>
                    {id === shownTab ? `[${label}]` : ` ${label} `}{' '}
                  </Text>
                </Button>
              ))}
              {filter !== null && (
                <Button key="clear-filter" plain onPress={clearFilter}>
                  <Text dimColor>✕ filter</Text>
                </Button>
              )}
            </Box>
            <Box flexDirection="column" height={bodyRows} overflow="hidden">
              {termPanel}
            </Box>
          </Box>
        )}
      </Box>
    )
  })

  // ── the band above the prompt: one row of what is happening now ────────────
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // something waits for the person: it takes the band, with its answers as buttons
    const waiting = await read($, asks)
    const ask = waiting[0]
    if (ask !== undefined) {
      const { Box, Text, Button } = $.ui.resolve(e)
      const q = ask.questions?.[0]
      const isSimple = ask.kind === 'permission' || (q !== undefined && ask.questions!.length === 1 && !q.multiSelect && (q.kind ?? 'choice') === 'choice')
      const more = waiting.length > 1 ? ` (+${waiting.length - 1} more)` : ''
      const color = ask.kind === 'permission' ? '#d97706' : '#7c3aed'

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color={color} bold>{ask.kind === 'permission' ? '⚠ Allow?' : '? Claude asks'}</Text>
            <Text wrap="truncate-end">{clip(ask.title, 140)}{more}</Text>
          </Box>
          {e.surface === 'terminal' ? (
            <Text dimColor>Answer it in the Live Code dashboard, or on the Stream Deck.</Text>
          ) : (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {ask.kind === 'permission' ? (
                <>
                  <Button key="allow" onPress={answerFrom($, ask.id, { decision: 'allow' })}><Text color="#16a34a" bold>✓ Allow</Text></Button>
                  <Button key="deny" onPress={answerFrom($, ask.id, { decision: 'deny' })}><Text color="#dc2626" bold>✗ Deny</Text></Button>
                </>
              ) : isSimple ? (
                q!.options.map(o => (
                  <Button key={`o:${o.label}`} onPress={answerFrom($, ask.id, { decision: 'answer', answers: { [q!.question]: o.label } })}>
                    <Text>{o.label}</Text>
                  </Button>
                ))
              ) : (
                <Text color="inactive">This one is answered in the dashboard, or in the usual dialog:</Text>
              )}
              <Button key="dialog" plain onPress={answerFrom($, ask.id, { decision: 'dialog' })}><Text color="inactive">Show the usual dialog</Text></Button>
            </Box>
          )}
        </Box>
      )
    }
    const { live, use, t, think, steps: allSteps, tNo, lanes } = await snapshot($, false)
    if (tNo === 0 && live === null) return next(e)
    const steps = allSteps.filter(s => s.agentId === undefined)
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const turn = turnInfo(think, steps, tNo, t)
    const slow = Math.floor(t / FRAME_MS / IDLE_EVERY)
    const working = live !== null && !live.isDone ? live : undefined
    const pct = use?.percent
    const runningLanes = lanes.filter(l => l.status === 'running').length
    // the limit nearest to full, when its pace says it fills before it resets
    const soonest = use?.limits.filter(l => l.etaMs !== undefined).sort((a, b) => a.etaMs! - b.etaMs!)[0]

    const state =
      working !== undefined
        ? {
            kind: 'tool' as const,
            text: `${ACTION[working.action].label} ${working.action === 'running' ? clip(working.rows[0]?.text ?? working.file, 40) : where(working)}`,
            time: t > working.startedAt ? dur(t - working.startedAt) : '',
          }
        : turn.showThinking
          ? { kind: 'think' as const, text: steps.length === 0 ? 'Planning' : 'Thinking', time: dur(t - think.since) }
          : turn.isLive
            ? { kind: 'think' as const, text: 'Working', time: dur(turn.ms) }
            : { kind: 'done' as const, text: `Turn ${tNo} done`, time: dur(turn.ms) }
    const icons = steps.slice(-MAX_STEPS)

    if (e.surface !== 'terminal') {
      const { Svg } = ui as unknown as Elements['desktop']
      const color =
        state.kind === 'tool' && working !== undefined
          ? DESK_ACTION[working.action]
          : state.kind === 'think'
            ? '#7c3aed'
            : turn.failed > 0
              ? '#ea580c'
              : '#16a34a'

      return (
        <Box flexDirection="row" gap={1} alignItems="center" height={1} overflow="hidden">
          <Svg source={dotSvg(color)} alt={state.text} width={14} height={14} />
          <Box backgroundColor={state.kind === 'tool' ? color : `${color}26`} paddingX={1}>
            <Text {...T({ weight: 'semibold' })} color={state.kind === 'tool' ? '#ffffff' : color} wrap="truncate-end">
              {state.kind === 'tool' && working !== undefined ? `${ACTION[working.action].icon} ` : state.kind === 'done' ? '✓ ' : ''}
              {state.text}
            </Text>
          </Box>
          <Text color="inactive" {...T({ tabular: true })}>{state.time}</Text>
          {steps.length > 0 && (
            <Text>
              {icons.map(step => (
                <Text color={step.status === 'error' ? '#dc2626' : DESK_STEP[step.kind]}>{STEP_ICON[step.kind]} </Text>
              ))}
              <Text color="inactive">{plural(steps.length, 'step')}</Text>
            </Text>
          )}
          {runningLanes > 0 && <Text color={DESK_STEP.agent}>◈ {runningLanes}</Text>}
          <Box flexGrow={1} />
          {soonest !== undefined && (
            <Text color={soonest.etaMs! < 60 * 60_000 ? '#dc2626' : '#ea580c'} {...T({ tabular: true })}>
              {limitName(soonest.kind)} full in ~{dur(soonest.etaMs!)}
            </Text>
          )}
          {pct !== undefined && (
            <Box flexDirection="row" gap={1} alignItems="center">
              <Svg source={miniBarSvg(pct, 64)} alt={`Context ${pct}%`} width={64} height={8} />
              <Text color={heat(pct)} {...T({ weight: 'semibold' })} {...T({ tabular: true })}>{pct}%</Text>
            </Box>
          )}
          {use?.usd !== undefined && <Text color="#ca8a04" {...T({ tabular: true })}>${use.usd.toFixed(2)}</Text>}
        </Box>
      )
    }

    const ink =
      state.kind === 'tool' && working !== undefined ? ACTION[working.action].color : state.kind === 'think' ? '#a5b4fc' : '#4ade80'

    return (
      <Text wrap="truncate-end">
        <Text color={ink}>
          {state.kind === 'done' ? '✓' : state.kind === 'think' ? THINK_SPIN[slow % THINK_SPIN.length] : SPINNER[slow % SPINNER.length]}{' '}
        </Text>
        <Text bold color={ink}>{state.text}</Text>
        <Text dimColor> {state.time}</Text>
        {steps.length > 0 && (
          <Text>
            {'  '}
            {icons.map(step => (
              <Text color={step.status === 'error' ? INK.del : STEP_COLOR[step.kind]}>{STEP_ICON[step.kind]}</Text>
            ))}
            <Text dimColor> {plural(steps.length, 'step')}</Text>
          </Text>
        )}
        {runningLanes > 0 && <Text color="#f472b6">{'  '}◈ {runningLanes}</Text>}
        {soonest !== undefined && <Text color={INK.mod}>{'  '}{limitName(soonest.kind)} full ~{dur(soonest.etaMs!)}</Text>}
        {pct !== undefined && <Text color={heat(pct)}>{'  '}ctx {pct}%</Text>}
      </Text>
    )
  })
}
