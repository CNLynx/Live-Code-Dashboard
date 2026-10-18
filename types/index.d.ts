export type Action = 'reading' | 'editing' | 'writing' | 'searching' | 'running'

// ctx: unchanged context, add/del/mod: diff lines, gap: elided lines, hit: a search match
export type RowKind = 'ctx' | 'add' | 'del' | 'mod' | 'gap' | 'hit'

export type Row = {
  kind: RowKind
  oldNo?: number
  newNo?: number
  text: string
  // for `mod`: the line as it was, and the changed character span of each side
  before?: string
  span?: [number, number]
  beforeSpan?: [number, number]
}

export type Stats = { add: number; del: number; mod: number }

export type Focus = {
  id: string
  action: Action
  file: string
  line?: number
  endLine?: number
  detail?: string
  rows: Row[]
  stats: Stats
  startedAt: number
  doneAt?: number
  isDone: boolean
  isError: boolean
  // the subagent whose loop ran it; absent on the main loop
  agentId?: string
  // what it is for, in one sentence: written by a small model while it runs
  why?: string
}

export type Totals = {
  files: number
  add: number
  del: number
  mod: number
  reads: number
  edits: number
  searches: number
  commands?: number
}

export type Limit = {
  kind: string
  percent: number
  resetsAt?: string
  // at the pace of the last half hour: percent per hour, and ms until 100%
  ratePerHour?: number
  etaMs?: number
}

export type Usage = {
  tokens?: number
  window: number
  percent?: number
  usd?: number
  limits: Limit[]
  output: number
  input: number
  turns: number
}

export type ThinkingState = {
  active: boolean
  since: number
  turnNo: number
  turnStartedAt?: number
  turnEndedAt?: number
  // the session cost when the turn began, to tell what the turn cost
  usdAtStart?: number
}

export type TurnStep = {
  id: string
  kind: 'read' | 'edit' | 'write' | 'search' | 'bash' | 'web' | 'agent' | 'other'
  label: string
  status: 'running' | 'done' | 'error'
  startedAt: number
  doneAt?: number
  agentId?: string
}

// What one file went through this session.
export type FileStat = {
  file: string
  reads: number
  edits: number
  add: number
  del: number
  mod: number
  lastAt: number
}

// What one finished turn took.
export type TurnStat = {
  no: number
  ms: number
  tokensIn: number
  tokensOut: number
  usd?: number
  steps: number
  failed: number
  // when it ended
  at?: number
}

// One subagent of the current turn, as a lane of its own.
export type AgentLane = {
  id: string
  name: string
  type: string
  status: 'running' | 'done' | 'error'
  startedAt: number
  doneAt?: number
}

// One question of Claude's, as the dashboard shows it to answer.
export type AskQuestion = {
  question: string
  header: string
  options: { label: string; description?: string }[]
  multiSelect: boolean
  kind?: 'choice' | 'text' | 'number'
  placeholder?: string
  min?: number
  max?: number
  step?: number
  unit?: string
}

// Something waiting for the person: a tool call to allow, or Claude's
// questions; answerable from the band, the dashboard or the Stream Deck.
export type Ask = {
  id: string
  kind: 'permission' | 'question'
  tool: string
  title: string
  detail: string
  reason?: string
  questions?: AskQuestion[]
  at: number
  agentId?: string
}

// A task's plan and how far it is: Claude's own task list (TodoWrite, or
// TaskCreate/TaskUpdate), or a savvy-flow's progress report.
export type PlanItem = { title: string; status: 'pending' | 'running' | 'done' }
export type Plan = {
  source: 'todos' | 'tasks' | 'flow'
  title: string
  phase?: string
  done: number
  total: number
  items: PlanItem[]
  isFinished: boolean
  updatedAt: number
}

// The tab the pane's bottom panel shows.
export type PanelTab = 'recent' | 'files' | 'turns' | 'agents'

declare module 'claude-code' {
  interface PluginState {
    'live-code': {
      current: Focus | null
      history: Focus[]
      replayQueue: Focus[]
      totals: Totals
      usage: Usage | null
      tick: number
      beat: number
      thinking: ThinkingState
      turnSteps: TurnStep[]
      turnNo: number
      lastPrompt: string
      fileStats: FileStat[]
      turnStats: TurnStat[]
      agents: AgentLane[]
      recentFilter: string | null
      panelTab: PanelTab
      // when this session began, for the dashboard's "this session" range
      sessionStart: number
      // ids of the dashboard messages already submitted as prompts
      inboxHandled: string[]
      // what waits for the person's answer right now
      asks: Ask[]
      // the plan of the task at hand, with its progress
      plan: Plan | null
    }
  }
}
