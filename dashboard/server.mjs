// Live Code dashboard server.
//
// Each Claude Code session running the live-code mod writes its own feed,
// ~/.claude/live-code-session-<id>.json. This server reads them all, keeps every
// finished action and a time series of each session's token usage in
// ~/.claude/live-code-log.jsonl, each tagged with its session, and streams
// them to the dashboard page over server-sent events. No dependencies:
// `node server.mjs`. Listens on 127.0.0.1 only, and exits once no window has
// been open for a while.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { hueAlarm, hueAsks, hueConfig, hueDone, huePair, hueRooms, pairing, hueTest, setHueOptions } from './hue.mjs'
import { ensureWebView2, hasWebView2 } from './webview2.mjs'

const HOME = process.env.LIVE_CODE_HOME ?? path.join(os.homedir(), '.claude')
const LEGACY_FEED = path.join(HOME, 'live-code-feed.json') // an older mod's one shared feed
const SESSION_FILE = /^live-code-session-([A-Za-z0-9_-]+)\.json$/
const LOG = process.env.LIVE_CODE_LOG ?? path.join(HOME, 'live-code-log.jsonl')
const PORT = Number(process.env.LIVE_CODE_PORT ?? 4477)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version } catch { return '' } })()
// the newest published version (GitHub), looked up at most every 6 hours, for the dashboard to offer
const latest = { version: '', at: 0 }
const checkLatest = async () => {
  if (Date.now() - latest.at < 6 * 3600e3) return
  latest.at = Date.now()
  try {
    const r = await fetch('https://raw.githubusercontent.com/CNLynx/Live-Code-Dashboard/main/.claude-plugin/plugin.json', { signal: AbortSignal.timeout(5000) })
    if (r.ok) latest.version = String((await r.json()).version ?? '')
  } catch {}
}
const KEEP_ACTIONS = 6000
const KEEP_ROWS = 400 // the newest actions keep their code, for a replay
const KEEP_SAMPLES = 50000
const INIT_SAMPLES = 15000
const INIT_ROWS = 40 // actions sent with their code when a window connects
const SAMPLE_EVERY_MS = 60_000 // an unchanged usage is still sampled this often
const SESSION_MAX_AGE_MS = 3 * 86400e3 // older session files are not listed
const SCAN_MS = 300
const IDLE_EXIT_MS = 15 * 60_000

const sessions = new Map() // id -> { id, snapshot, mtime }
const actions = new Map() // action id -> action, with `sid`
let samples = [] // { sid, t, ctx, ... }
const clients = new Set()
let lastClientAt = Date.now()

const rowCount = a => (Array.isArray(a?.rows) ? a.rows.length : 0)
const lean = a => ({ ...a, rows: [] })
const append = entry => fs.appendFile(LOG, `${JSON.stringify(entry)}\n`, () => undefined)

// Reads the log back, keeping the fullest copy of each action, and rewrites
// it trimmed, so it never grows without bound.
const loadLog = () => {
  if (!fs.existsSync(LOG)) return
  for (const line of fs.readFileSync(LOG, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const entry = JSON.parse(line)
      if (entry.k === 'a' && entry.d?.id) {
        const was = actions.get(entry.d.id)
        actions.set(entry.d.id, rowCount(was) > rowCount(entry.d) ? { ...entry.d, rows: was.rows } : entry.d)
      } else if (entry.k === 's' && entry.d) samples.push(entry.d)
    } catch {
      // a torn line from a crash: skip it
    }
  }
  const list = [...actions.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-KEEP_ACTIONS)
  actions.clear()
  list.forEach((a, i) => actions.set(a.id, i < list.length - KEEP_ROWS ? lean(a) : a))
  samples = samples.slice(-KEEP_SAMPLES)
  const lines = [...actions.values()].map(d => JSON.stringify({ k: 'a', d })).concat(samples.map(d => JSON.stringify({ k: 's', d })))
  fs.writeFileSync(LOG, lines.length === 0 ? '' : `${lines.join('\n')}\n`)
}

const send = (res, msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`)
const broadcast = msg => {
  for (const res of clients) send(res, msg)
}

// ── the pages reload themselves when their files change ──
// A change to a page or its script (not to this server) is told to every
// open page, which reloads when nothing would be lost by it.
const PAGE_FILE = /\.(html|js|css)$/
let pageChangeDue = null
try {
  fs.watch(HERE, (_, name) => {
    if (!name || !PAGE_FILE.test(name)) return
    clearTimeout(pageChangeDue)
    pageChangeDue = setTimeout(() => broadcast({ type: 'reload', file: name }), 400)
  })
} catch {
  // no watching: the pages reload by hand
}

// ── chat titles ──
// Claude Code keeps each chat as ~/.claude/projects/<folder>/<session id>.jsonl,
// and writes its title (as the sidebar shows it, renames included) as
// {"type":"custom-title","customTitle":"…"} lines. The newest such line names
// the session; the end of the file is read, the whole only when it has none.
const PROJECTS = path.join(HOME, 'projects')
const TITLE_EVERY_MS = 10_000
const TAIL_BYTES = 768 * 1024
const titles = new Map() // sid -> title
const transcripts = new Map() // sid -> transcript path
const TITLE_RE = /"customTitle":"((?:[^"\\]|\\.)*)"|"type":"summary","summary":"((?:[^"\\]|\\.)*)"/g

const lastTitleIn = text => {
  let found
  for (const m of text.matchAll(TITLE_RE)) found = m[1] ?? m[2]
  if (found === undefined) return undefined
  try { return JSON.parse(`"${found}"`) } catch { return found }
}

const transcriptOf = sid => {
  if (transcripts.has(sid)) return transcripts.get(sid)
  let found = null
  try {
    for (const dir of fs.readdirSync(PROJECTS)) {
      const file = path.join(PROJECTS, dir, `${sid}.jsonl`)
      if (fs.existsSync(file)) { found = file; break }
    }
  } catch {
    // no projects folder: no titles
  }
  transcripts.set(sid, found)
  return found
}

const readTail = (file, bytes) => {
  const size = fs.statSync(file).size
  const len = Math.min(size, bytes)
  const buf = Buffer.alloc(len)
  const fd = fs.openSync(file, 'r')
  fs.readSync(fd, buf, 0, len, size - len)
  fs.closeSync(fd)
  return { text: buf.toString('utf8'), isWhole: len === size }
}

const readTitle = sid => {
  const file = transcriptOf(sid)
  if (!file) return undefined
  try {
    const tail = readTail(file, TAIL_BYTES)
    return lastTitleIn(tail.text) ?? (tail.isWhole ? undefined : lastTitleIn(fs.readFileSync(file, 'utf8')))
  } catch {
    return undefined
  }
}

// ── the person's prompts ──
// Their messages in the transcript: user lines whose content is text, not a
// tool result, and not one of the engine's wrappers (commands, reminders).
const PROMPTS_KEPT = 12
const PROMPT_TAIL_BYTES = 3 * 1024 * 1024
const prompts = new Map() // sid -> [{ text, at }]
const promptsRead = new Map() // sid -> transcript mtime read
const promptsIn = text => {
  const out = []
  for (const line of text.split('\n')) {
    // typed mid-turn: an attachment the running turn took in
    if (line.includes('"queued_command"')) {
      let entry
      try { entry = JSON.parse(line) } catch { continue }
      const a = entry.attachment
      if (entry.isSidechain || a?.type !== 'queued_command' || a.origin?.kind !== 'human' || typeof a.prompt !== 'string') continue
      const said = a.prompt.trim()
      if (said === '' || said.startsWith('<')) continue
      const at = Date.parse(a.timestamp ?? entry.timestamp) || 0
      // the same words as a prompt of their own a moment apart: one entry
      if (out.some(p => p.text === said.slice(0, 800) && Math.abs(p.at - at) < 10 * 60_000)) continue
      out.push({ text: said.slice(0, 800), at, midTurn: true })
      continue
    }
    if (!line.includes('"type":"user"')) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (entry.type !== 'user' || entry.isMeta || entry.isSidechain || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) continue
    const content = entry.message?.content
    const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    if (parts.some(p => p.type === 'tool_result')) continue
    const said = parts.filter(p => p.type === 'text').map(p => p.text).join('\n').trim()
    if (said === '' || said.startsWith('<') || said.startsWith('[Request interrupted')) continue
    const at = Date.parse(entry.timestamp) || 0
    if (out.some(p => p.midTurn && p.text === said.slice(0, 800) && Math.abs(p.at - at) < 10 * 60_000)) continue
    out.push({ text: said.slice(0, 800), at })
  }
  return out
}
const readPrompts = sid => {
  const file = transcriptOf(sid)
  if (!file) return false
  try {
    const mtime = fs.statSync(file).mtimeMs
    if (promptsRead.get(sid) === mtime) return false
    promptsRead.set(sid, mtime)
    // tool output can fill the end of a long chat: read further back when it holds too few
    let tail = readTail(file, PROMPT_TAIL_BYTES)
    let found = promptsIn(tail.text)
    if (found.length < PROMPTS_KEPT && !tail.isWhole) {
      tail = readTail(file, PROMPT_TAIL_BYTES * 8)
      found = promptsIn(tail.text)
    }
    // what was written in the dashboard mid-turn reaches Claude with a tool
    // result, not as a prompt of the chat's own: the inbox has it
    try {
      for (const m of JSON.parse(fs.readFileSync(path.join(HOME, `live-code-inbox-${sid}.json`), 'utf8'))) {
        if (typeof m?.text !== 'string' || m.kind === 'stop') continue
        const said = m.text.trim().slice(0, 800)
        if (!found.some(p => p.text === said && Math.abs(p.at - m.at) < 10 * 60_000)) found.push({ text: said, at: m.at, midTurn: true, viaDashboard: true })
      }
      found.sort((a, b) => a.at - b.at)
    } catch {
      // no inbox
    }
    const list = found.slice(-PROMPTS_KEPT)
    const was = prompts.get(sid) ?? []
    if (list.length === was.length && list.every((p, i) => p.text === was[i].text)) return false
    prompts.set(sid, list)
    return true
  } catch {
    return false
  }
}

// ── today's prompts, over every chat ──
// How many prompts the person sent today and with how many words: every
// transcript written today is read once, then followed from where it was left.
// A message typed mid-turn shows twice (queued, then as a prompt): counted once.
const today = { day: '', files: new Map(), prompts: 0, words: 0, chats: new Set(), at: 0, busy: null }
const dayOf = t => new Date(t).toDateString()
const countLine = (state, line, dayStart) => {
  if (!line.includes('"type":"user"') && !line.includes('"queued_command"')) return
  let entry
  try { entry = JSON.parse(line) } catch { return }
  let said, at
  if (entry.attachment?.type === 'queued_command') {
    const a = entry.attachment
    if (entry.isSidechain || a.origin?.kind !== 'human' || typeof a.prompt !== 'string') return
    said = a.prompt.trim()
    at = Date.parse(a.timestamp ?? entry.timestamp) || 0
    if (said === '' || said.startsWith('<')) return
  } else {
    if (!isPromptLine(entry)) return
    const content = entry.message?.content
    const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content
    said = parts.filter(p => p.type === 'text').map(p => p.text).join('\n').trim()
    at = Date.parse(entry.timestamp) || 0
  }
  if (at < dayStart) return
  const key = said.slice(0, 200)
  if (state.recent.some(r => r.key === key && Math.abs(r.at - at) < 10 * 60_000)) return
  state.recent.push({ key, at })
  if (state.recent.length > 20) state.recent.shift()
  state.prompts++
  state.words += said.split(/\s+/).filter(Boolean).length
}
const countToday = async () => {
  const now = Date.now()
  if (today.day !== dayOf(now)) Object.assign(today, { day: dayOf(now), files: new Map(), prompts: 0, words: 0, chats: new Set() })
  const dayStart = new Date(new Date(now).toDateString()).getTime()
  let dirs = []
  try { dirs = fs.readdirSync(PROJECTS) } catch { return }
  for (const dir of dirs) {
    let names = []
    try { names = fs.readdirSync(path.join(PROJECTS, dir)).filter(n => n.endsWith('.jsonl')) } catch { continue }
    for (const name of names) {
      const file = path.join(PROJECTS, dir, name)
      let st
      try { st = fs.statSync(file) } catch { continue }
      if (st.mtimeMs < dayStart) continue
      // (a decoder of its own: a piece may end inside a character)
      const state = today.files.get(file) ?? { offset: 0, rest: '', prompts: 0, words: 0, recent: [], decoder: new StringDecoder('utf8') }
      if (st.size <= state.offset) continue
      // read on from where it was left, a piece at a time
      const fd = fs.openSync(file, 'r')
      try {
        const CHUNK = 4 * 1024 * 1024
        while (state.offset < st.size) {
          const len = Math.min(CHUNK, st.size - state.offset)
          const buf = Buffer.alloc(len)
          fs.readSync(fd, buf, 0, len, state.offset)
          state.offset += len
          const lines = (state.rest + state.decoder.write(buf)).split('\n')
          state.rest = lines.pop()
          const before = state.prompts
          for (const line of lines) countLine(state, line, dayStart)
          if (state.prompts > before) today.chats.add(name)
          await new Promise(r => setImmediate(r))
        }
      } finally {
        fs.closeSync(fd)
      }
      today.files.set(file, state)
    }
  }
  today.prompts = [...today.files.values()].reduce((n, s) => n + s.prompts, 0)
  today.words = [...today.files.values()].reduce((n, s) => n + s.words, 0)
  today.at = Date.now()
}
const todayCounts = async () => {
  if (Date.now() - today.at > 5000) { today.busy ??= countToday().finally(() => { today.busy = null }); await today.busy }
  return { prompts: today.prompts, words: today.words, chats: today.chats.size, day: today.day }
}

// ── what Claude says ──
// Claude's own words in the chat (the text between and after its tool calls),
// as the app shows them: the notes of the newest turn, the last one being its
// summary once the turn ends. The transcript is followed from where it was last
// read, so a busy chat costs only its new lines.
const NOTES_KEPT = 12
const NOTE_CHARS = 4000
const notes = new Map() // sid -> { at, list: [{ text, at }] } for the newest prompt
const follow = new Map() // sid -> { offset, rest }
const isPromptLine = entry => {
  // the summary a compacted chat starts over from is not the person's
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) return false
  const content = entry.message?.content
  const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  if (parts.some(p => p.type === 'tool_result')) return false
  const said = parts.filter(p => p.type === 'text').map(p => p.text).join('\n').trim()
  return said !== '' && !said.startsWith('<') && !said.startsWith('[Request interrupted')
}
const takeNotes = (sid, text) => {
  let cur = notes.get(sid) ?? { at: 0, list: [] }
  let changed = false
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (entry.isSidechain) continue
    const at = Date.parse(entry.timestamp) || 0
    if (entry.type === 'user') {
      if (isPromptLine(entry)) { cur = { at, list: [] }; changed = true }
      continue
    }
    if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue
    const said = entry.message.content.filter(p => p.type === 'text').map(p => p.text).join('\n').trim()
    if (said === '' || said === '(no content)') continue
    cur.list.push({ text: said.slice(0, NOTE_CHARS), at })
    if (cur.list.length > NOTES_KEPT) cur.list.shift()
    changed = true
  }
  if (changed) notes.set(sid, { at: cur.at, list: [...cur.list] })
  return changed
}
const readNotes = sid => {
  const file = transcriptOf(sid)
  if (!file) return false
  try {
    const size = fs.statSync(file).size
    let f = follow.get(sid)
    if (f && f.offset === size) return false
    // first look, or the file was rewritten: start over from its end
    if (!f || size < f.offset) {
      const len = Math.min(size, PROMPT_TAIL_BYTES)
      f = { offset: size - len, rest: '' }
      notes.delete(sid)
    }
    const len = size - f.offset
    const buf = Buffer.alloc(len)
    const fd = fs.openSync(file, 'r')
    fs.readSync(fd, buf, 0, len, f.offset)
    fs.closeSync(fd)
    const text = f.rest + buf.toString('utf8')
    const cut = text.lastIndexOf('\n')
    follow.set(sid, { offset: size, rest: cut < 0 ? text : text.slice(cut + 1) })
    return takeNotes(sid, cut < 0 ? '' : text.slice(0, cut))
  } catch {
    return false
  }
}
// busy chats are followed every second, the rest with the titles
const NOTES_EVERY_MS = 1000
const refreshNotes = () => {
  for (const s of sessions.values()) {
    if (s.id === 'legacy' || Date.now() - s.mtime > 10 * 60_000) continue
    if (readNotes(s.id)) broadcast({ type: 'feed', now: Date.now(), sid: s.id, snapshot: titled(s.id, s.snapshot), actions: [], samples: [] })
  }
}

// The snapshot as sent: its session carries the chat's title, its last prompts
// and what Claude said for the newest one.
const titled = (sid, snapshot) => {
  const title = titles.get(sid)
  const said = prompts.get(sid)
  const told = notes.get(sid)
  if (!snapshot || (!title && !said && !told)) return snapshot
  return { ...snapshot, session: { ...(snapshot.session ?? {}), ...(title ? { title } : {}), ...(said ? { prompts: said } : {}), ...(told ? { notes: told } : {}) } }
}

const refreshTitles = () => {
  for (const s of sessions.values()) {
    if (s.id === 'legacy') continue
    const title = readTitle(s.id)
    const isRenamed = title !== undefined && title !== titles.get(s.id)
    if (isRenamed) titles.set(s.id, title)
    const hasNewPrompts = readPrompts(s.id)
    if (isRenamed || hasNewPrompts) broadcast({ type: 'feed', now: Date.now(), sid: s.id, snapshot: titled(s.id, s.snapshot), actions: [], samples: [] })
  }
}

const sessionList = () =>
  [...sessions.values()]
    .filter(s => Date.now() - s.mtime < SESSION_MAX_AGE_MS)
    .map(s => ({ id: s.id, snapshot: titled(s.id, s.snapshot) }))

const initPayload = () => {
  const list = [...actions.values()].sort((a, b) => a.startedAt - b.startedAt)

  return {
    type: 'init',
    run: RUN,
    prefs,
    now: Date.now(),
    sessions: sessionList(),
    actions: list.map((a, i) => (i < list.length - INIT_ROWS ? lean(a) : a)),
    samples: samples.slice(-INIT_SAMPLES),
  }
}

// One new state of one session's feed: new or completed actions, maybe a usage sample.
const ingest = (sid, feed) => {
  const fresh = []
  const items = [...(Array.isArray(feed.history) ? feed.history : []), ...(feed.current ? [feed.current] : [])]
  for (const item of items) {
    if (!item?.id || !item.isDone) continue
    const was = actions.get(item.id)
    // its explanation can land after it was done: kept, without replaying it again
    if (was !== undefined && item.why && !was.why) was.why = item.why
    // known already, with its session and at least this much code: nothing new
    if (was !== undefined && was.sid !== undefined && rowCount(was) >= rowCount(item)) continue
    const a = { ...item, sid, rows: rowCount(was) > rowCount(item) ? was.rows : item.rows }
    actions.set(a.id, a)
    fresh.push(a)
    append({ k: 'a', d: a })
  }

  const fresher = []
  const u = feed.usage
  if (u) {
    const sample = {
      sid,
      t: Date.now(),
      ctx: u.percent ?? null,
      tokens: u.tokens ?? null,
      window: u.window ?? null,
      usd: u.usd ?? null,
      input: u.input ?? 0,
      output: u.output ?? 0,
      limits: Object.fromEntries((u.limits ?? []).map(l => [l.kind, l.percent])),
    }
    let last
    for (let i = samples.length - 1; i >= 0 && last === undefined; i--) if (samples[i].sid === sid) last = samples[i]
    const isSame =
      last !== undefined &&
      last.ctx === sample.ctx &&
      last.usd === sample.usd &&
      last.output === sample.output &&
      JSON.stringify(last.limits) === JSON.stringify(sample.limits)
    if (!isSame || sample.t - last.t > SAMPLE_EVERY_MS) {
      samples.push(sample)
      fresher.push(sample)
      append({ k: 's', d: sample })
    }
  }

  const isNew = !sessions.has(sid)
  const s = sessions.get(sid) ?? { id: sid, mtime: Date.now() }
  const promptChanged = s.snapshot?.prompt !== feed.prompt
  // the lights: a turn that was running and now has ended pulses them green;
  // Claude's questions waiting in any chat hold them violet
  const isLive = snap => { const th = snap?.thinking; return !!th?.turnStartedAt && (th.turnEndedAt ?? 0) < th.turnStartedAt }
  if (s.snapshot && isLive(s.snapshot) && !isLive(feed) && (feed.thinking?.turnEndedAt ?? 0) > 0) hueDone()
  s.snapshot = feed
  // (a chat closed with a question open, quiet for half an hour, counts no more)
  const all = sessions.has(sid) ? [...sessions.values()] : [...sessions.values(), s]
  hueAsks(all.filter(x => x === s || Date.now() - x.mtime < 30 * 60e3).reduce((n, x) => n + (x.snapshot?.asks ?? []).filter(a => a.kind === 'question').length, 0))
  s.mtime = Date.now()
  sessions.set(sid, s)
  noteMeta(sid, feed)
  if (isNew && sid !== 'legacy' && !titles.has(sid)) {
    const title = readTitle(sid)
    if (title !== undefined) titles.set(sid, title)
  }
  // a new prompt: the transcript has it (or will in a moment); read it now
  if (sid !== 'legacy' && (isNew || promptChanged)) {
    readPrompts(sid)
    if (promptChanged) setTimeout(() => { if (readPrompts(sid)) broadcast({ type: 'feed', now: Date.now(), sid, snapshot: titled(sid, s.snapshot), actions: [], samples: [] }) }, 1500)
  }
  broadcast({ type: 'feed', now: Date.now(), sid, snapshot: titled(sid, feed), actions: fresh, samples: fresher })
}

// The mod rewrites a whole file at once; a read mid-write fails to parse, and
// the next scan reads it again, since its time stays unrecorded.
const seen = new Map() // file -> mtimeMs read
const readSession = (file, sid) => {
  fs.readFile(path.join(HOME, file), 'utf8', (error, text) => {
    if (error) return
    try {
      const feed = JSON.parse(text)
      // the shared feed of a mod that knows its session repeats that session's own file
      if (sid === 'legacy' && feed?.session?.id) return
      ingest(feed?.session?.id || sid, feed)
    } catch {
      seen.delete(file)
    }
  })
}

const scan = () => {
  fs.readdir(HOME, (error, names) => {
    if (error) return
    for (const name of names) {
      const m = SESSION_FILE.exec(name)
      const sid = m ? m[1] : name === path.basename(LEGACY_FEED) ? 'legacy' : null
      if (sid === null) continue
      fs.stat(path.join(HOME, name), (err, st) => {
        if (err || seen.get(name) === st.mtimeMs) return
        // a session file not touched for days only fills the list on the first scan
        if (!seen.has(name) && Date.now() - st.mtimeMs > SESSION_MAX_AGE_MS) { seen.set(name, st.mtimeMs); return }
        seen.set(name, st.mtimeMs)
        readSession(name, sid)
      })
    }
  })
}

// ── messages to a chat ──
// The page may write to a chat: POST /send { sid, text } appends the message to
// ~/.claude/live-code-inbox-<sid>.json, which that chat's mod submits as the
// person's prompt. A prompt can make Claude run code, so only the dashboard
// page may send: it must carry this run's secret (handed to the page alone,
// inside its HTML), come from this server's own origin, and name this host;
// another site in the browser can neither read the secret nor pass the checks.
const SECRET = crypto.randomBytes(24).toString('hex')
// names this run to the pages, not secret: a page from an earlier run reloads for the new secret
const RUN = crypto.randomBytes(6).toString('hex')
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`])
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
const INBOX_KEEP_MS = 60 * 60_000
const MAX_TEXT = 20_000

const readBody = (req, limit) =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > limit) { reject(new Error('too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

// The Stream Deck plugin is no page: it reads this run's secret from a file
// only this user can read, and sends without an Origin (a browser always sends
// one with a POST, so a site still cannot pass).
const KEY_FILE = path.join(HOME, 'live-code-dashboard.json')
const isTrusted = req =>
  HOSTS.has(req.headers.host ?? '') &&
  (req.headers.origin === undefined || ORIGINS.has(req.headers.origin)) &&
  req.headers['x-live-code-secret'] === SECRET

const writeAtomic = (file, text) => {
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, text)
  fs.renameSync(temp, file)
}

// What one answer may hold: a decision, a reason, the picked labels per question.
const cleanAnswer = raw => {
  const decision = ['allow', 'deny', 'dialog', 'answer'].includes(raw?.decision) ? raw.decision : null
  if (decision === null) return null
  const out = { decision }
  if (typeof raw.reason === 'string' && raw.reason.trim() !== '') out.reason = raw.reason.trim().slice(0, 500)
  if (decision === 'answer') {
    const answers = {}
    for (const [q, v] of Object.entries(raw.answers ?? {}).slice(0, 8)) if (typeof v === 'string') answers[String(q).slice(0, 1000)] = v.slice(0, 2000)
    out.answers = answers
    if (typeof raw.response === 'string' && raw.response.trim() !== '') out.response = raw.response.trim().slice(0, 4000)
  }
  return out
}

const handleSend = async (req, res) => {
  const reply = (code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  if (!isTrusted(req)) {
    reply(403, { error: 'not from the dashboard' })
    return
  }
  let body
  try {
    body = JSON.parse(await readBody(req, MAX_TEXT * 4 + 1000))
  } catch {
    reply(400, { error: 'bad request' })
    return
  }
  const sid = typeof body?.sid === 'string' ? body.sid : ''
  const kind = body?.kind ?? 'prompt'
  if (!/^[A-Za-z0-9_-]+$/.test(sid) || !sessions.has(sid) || sid === 'legacy') { reply(404, { error: 'no such chat' }); return }

  // the Stream Deck picked a chat: open windows show it
  if (kind === 'view') {
    broadcast({ type: 'view', now: Date.now(), sid })
    reply(200, { ok: true })
    return
  }

  // an answer to something that waits: written where that chat's mod waits for it
  if (kind === 'answer') {
    const askId = typeof body.askId === 'string' ? body.askId : ''
    const waiting = sessions.get(sid)?.snapshot?.asks ?? []
    if (!/^[A-Za-z0-9_-]+$/.test(askId) || !waiting.some(a => a.id === askId)) { reply(404, { error: 'nothing waits for that answer' }); return }
    const answer = cleanAnswer(body.answer)
    if (answer === null) { reply(400, { error: 'bad answer' }); return }
    writeAtomic(path.join(HOME, `live-code-answer-${askId}.json`), JSON.stringify(answer))
    reply(200, { ok: true })
    return
  }

  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (kind === 'prompt' && (text === '' || text.length > MAX_TEXT)) { reply(400, { error: 'empty or too long' }); return }
  if (kind !== 'prompt' && kind !== 'stop') { reply(400, { error: 'unknown kind' }); return }
  const file = path.join(HOME, `live-code-inbox-${sid}.json`)
  let list = []
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { list = [] }
  if (!Array.isArray(list)) list = []
  const message = kind === 'stop' ? { id: crypto.randomUUID(), kind: 'stop', at: Date.now() } : { id: crypto.randomUUID(), text, at: Date.now() }
  list = [...list.filter(m => Date.now() - (m.at ?? 0) < INBOX_KEEP_MS), message]
  writeAtomic(file, JSON.stringify(list))
  reply(200, { ok: true, id: message.id })
  // the prompt list shows it at once
  if (kind === 'prompt') {
    promptsRead.delete(sid)
    if (readPrompts(sid)) broadcast({ type: 'feed', now: Date.now(), sid, snapshot: titled(sid, sessions.get(sid)?.snapshot), actions: [], samples: [] })
  }
}

// ── a dashboard is here ──
// While a window (or the Stream Deck) that answers questions is connected, the
// mods let questions wait for it: ~/.claude/live-code-remote.json says when it
// was last seen. Without one, every question goes to the usual dialog at once.
const REMOTE_FILE = path.join(HOME, 'live-code-remote.json')
const answerers = new Set()
const markRemote = () => {
  try {
    if (answerers.size > 0) writeAtomic(REMOTE_FILE, JSON.stringify({ at: Date.now(), windows: answerers.size }))
    else if (fs.existsSync(REMOTE_FILE)) fs.rmSync(REMOTE_FILE, { force: true })
  } catch {
    // the next beat tries again
  }
}

// ── a real voice: ElevenLabs ──
// ~/.claude/live-code-voice.json holds the person's API key (they put it there
// themselves), the voice and the model. The text of a finished turn is sent to
// ElevenLabs only when the page asks to have it read; each clip is kept, so
// hearing it again costs nothing.
const VOICE_FILE = path.join(HOME, 'live-code-voice.json')
const VOICE_CACHE = path.join(os.tmpdir(), 'live-code-voice')
const DEFAULT_VOICE = { apiKey: '', voiceId: 'JBFqnCBsd6RMkjVDRZzb', modelId: 'eleven_multilingual_v2', stability: 0.45, similarity: 0.8, style: 0.15 }
const readVoice = () => {
  try { return { ...DEFAULT_VOICE, ...JSON.parse(fs.readFileSync(VOICE_FILE, 'utf8')) } } catch { return { ...DEFAULT_VOICE } }
}
if (!fs.existsSync(VOICE_FILE)) {
  try {
    fs.writeFileSync(VOICE_FILE, `${JSON.stringify({ ...DEFAULT_VOICE, _help: 'Put your ElevenLabs API key in apiKey (elevenlabs.io → Profile → API Keys). The voice is picked in the dashboard.' }, null, 2)}\n`)
  } catch {
    // no voice until the file exists
  }
}
let voicesCache = { at: 0, key: '', list: [] }
const listVoices = async () => {
  const v = readVoice()
  if (!v.apiKey) return []
  if (voicesCache.key === v.apiKey && Date.now() - voicesCache.at < 10 * 60_000) return voicesCache.list
  const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': v.apiKey } })
  if (!r.ok) throw new Error(`ElevenLabs answered ${r.status}`)
  const list = ((await r.json()).voices ?? []).map(x => ({ id: x.voice_id, name: x.name, category: x.category, labels: x.labels ?? {}, preview: x.preview_url }))
  voicesCache = { at: Date.now(), key: v.apiKey, list }
  return list
}
const speak = async text => {
  const v = readVoice()
  if (!v.apiKey) throw new Error('no API key in ~/.claude/live-code-voice.json')
  const key = crypto.createHash('sha1').update(`${v.voiceId}|${v.modelId}|${v.stability}|${v.similarity}|${v.style}|${text}`).digest('hex')
  const file = path.join(VOICE_CACHE, `${key}.mp3`)
  if (fs.existsSync(file)) return fs.readFileSync(file)
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(v.voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': v.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: v.modelId, voice_settings: { stability: v.stability, similarity_boost: v.similarity, style: v.style, use_speaker_boost: true } }),
  })
  if (!r.ok) throw new Error(`ElevenLabs answered ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const audio = Buffer.from(await r.arrayBuffer())
  fs.mkdirSync(VOICE_CACHE, { recursive: true })
  fs.writeFileSync(file, audio)
  return audio
}
const handleVoice = async (req, res, url) => {
  const reply = (code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  if (!isTrusted(req)) { reply(403, { error: 'not from the dashboard' }); return }
  if (url.pathname === '/voice' && req.method === 'GET') {
    const v = readVoice()
    let voices = []
    let error
    try { voices = await listVoices() } catch (e) { error = e.message }
    reply(200, { configured: !!v.apiKey, voiceId: v.voiceId, modelId: v.modelId, voices, error, file: VOICE_FILE })
  } else if (url.pathname === '/voice' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req, 2000))
    const v = readVoice()
    if (typeof body.voiceId === 'string' && /^[A-Za-z0-9]{8,40}$/.test(body.voiceId)) v.voiceId = body.voiceId
    writeAtomic(VOICE_FILE, `${JSON.stringify(v, null, 2)}\n`)
    reply(200, { ok: true })
  } else if (url.pathname === '/speak' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req, 20_000))
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2500) : ''
    if (text === '') { reply(400, { error: 'nothing to say' }); return }
    try {
      const audio = await speak(text)
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }).end(audio)
    } catch (e) {
      reply(502, { error: e.message })
    }
  } else reply(404, { error: 'not found' })
}

// ── what every session was, for the report ──
// Kept across restarts in ~/.claude/live-code-sessions.json: each session's
// name, folder, first and last activity, cost, and its turns.
const META_FILE = path.join(HOME, 'live-code-sessions.json')
let meta = {}
try { meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8')) } catch { meta = {} }
let metaDirty = false
const noteMeta = (sid, feed) => {
  if (sid === 'legacy' || !feed) return
  const m = meta[sid] ?? { first: Date.now(), turns: [] }
  m.last = Date.now()
  if (feed.session?.cwd) m.cwd = feed.session.cwd
  const title = titles.get(sid) ?? feed.session?.title
  if (title) m.title = title
  if (typeof feed.usage?.usd === 'number') m.usd = Math.max(m.usd ?? 0, feed.usage.usd)
  if (typeof feed.session?.startedAt === 'number' && feed.session.startedAt > 0) m.first = Math.min(m.first, feed.session.startedAt)
  const byNo = new Map((m.turns ?? []).map(t => [t.no, t]))
  for (const t of feed.turnStats ?? []) {
    const end = feed.thinking?.turnNo === t.no ? feed.thinking.turnEndedAt : undefined
    byNo.set(t.no, { ...byNo.get(t.no), ...t, ...(end ? { endedAt: end } : {}) })
  }
  m.turns = [...byNo.values()].sort((a, b) => a.no - b.no).slice(-400)
  meta[sid] = m
  metaDirty = true
}
setInterval(() => {
  if (!metaDirty) return
  metaDirty = false
  try { writeAtomic(META_FILE, JSON.stringify(meta)) } catch { metaDirty = true }
}, 5000)
const reportData = () => ({
  now: Date.now(),
  // the record, filled in from the session files for what it has not seen yet
  sessions: {
    ...Object.fromEntries(
      [...sessions.values()].filter(s => s.id !== 'legacy').map(s => [s.id, {
        cwd: s.snapshot?.session?.cwd, title: titles.get(s.id) ?? s.snapshot?.session?.title, first: s.snapshot?.session?.startedAt || s.mtime,
        last: s.mtime, usd: s.snapshot?.usage?.usd, turns: s.snapshot?.turnStats ?? [],
      }]),
    ),
    ...meta,
  },
  actions: [...actions.values()].map(a => ({ id: a.id, sid: a.sid, action: a.action, file: a.file, startedAt: a.startedAt, doneAt: a.doneAt, isError: a.isError, stats: a.stats, detail: a.action === 'running' ? a.detail : undefined })),
  samples: samples.filter((s, i) => i % 3 === 0 || i === samples.length - 1).map(s => ({ sid: s.sid, t: s.t, usd: s.usd, ctx: s.ctx, output: s.output })),
})

const sendFile = (res, file, type) =>
  fs.readFile(file, (error, body) => {
    if (error) res.writeHead(404).end()
    else res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body)
  })

// ── tiles in frameless windows of their own ──
// One window per tile, run by tilewin/tile-window.ps1 (WebView2). Started as
// this server's hidden child: Windows PowerShell quits at once when started
// apart from any console.
// the look and the coloring steps the tile windows share with the main window
const SHARED_PREFS = ['lc.warnAt', 'lc.critAt', 'lc.style', 'lc.theme']
const PREFS_FILE = path.join(HOME, 'live-code-prefs.json')
const prefs = (() => { try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) } catch { return {} } })()
const tileWindows = new Map() // "tile" or "tile@detail" -> its process
let lastHueAlarm = 0
const openTileWindow = (key, b) => {
  // minimal (the tile) or detailed (as it opens large)
  const view = b?.view === 'detail' ? 'detail' : 'mini'
  const name = view === 'detail' ? `${key}@detail` : key
  if (tileWindows.has(name)) return true
  const script = path.join(HERE, 'tilewin', 'tile-window.ps1')
  if (process.platform !== 'win32' || !fs.existsSync(script)) return false
  // the first time: WebView2's files fetched first, then the window
  if (!hasWebView2() && !fs.existsSync(path.join(HERE, 'tilewin', 'Microsoft.Web.WebView2.Core.dll'))) {
    void ensureWebView2().then(ok => ok && openTileWindow(key, b))
    return true
  }
  const n = (v, d) => String(Number.isFinite(Number(v)) ? Math.round(Number(v)) : d)
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Key', key, '-View', view,
    // through the frame ('/'), which swaps in a new version of it without a blank moment
    '-Url', `http://127.0.0.1:${PORT}/?tile=${key}&view=${view}`, '-X', n(b?.x, 200), '-Y', n(b?.y, 200), '-W', n(b?.w, 380), '-H', n(b?.h, 240), ...(b?.top ? ['-Top'] : [])]
  try {
    const child = spawn('powershell.exe', args, { cwd: HERE, stdio: 'ignore', windowsHide: true })
    tileWindows.set(name, child)
    child.on('exit', () => { if (tileWindows.get(name) === child) tileWindows.delete(name) })
    child.unref()
    return true
  } catch {
    return false
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  // only this machine's own name for the server: a foreign name pointed here
  // (DNS rebinding) reads nothing
  if (!HOSTS.has(req.headers.host ?? '')) {
    res.writeHead(403).end('forbidden')
    return
  }
  // '/' is the frame that swaps in a new version of the dashboard ('/app') without a blank moment
  const PAGES = { '/': 'shell.html', '/app': 'index.html', '/index.html': 'index.html', '/wall': 'wall.html', '/report': 'report.html' }
  if (PAGES[url.pathname]) {
    // each page gets this run's secret, which lets it write to a chat
    fs.readFile(path.join(HERE, PAGES[url.pathname]), 'utf8', (error, html) => {
      if (error) { res.writeHead(500).end(`${PAGES[url.pathname]} missing`); return }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html.replace('__LIVE_CODE_SECRET__', SECRET).replace('__LIVE_CODE_RUN__', RUN))
    })
  } else if (url.pathname === '/send' && req.method === 'POST') {
    handleSend(req, res).catch(() => res.writeHead(500).end('{}'))
  } else if (url.pathname === '/voice' || url.pathname === '/speak') {
    handleVoice(req, res, url).catch(e => res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message })))
  } else if (url.pathname === '/extras.js' || url.pathname === '/shared.js' || url.pathname === '/details.js') {
    sendFile(res, path.join(HERE, url.pathname.slice(1)), 'text/javascript; charset=utf-8')
  } else if (url.pathname === '/hue') {
    // the settings: whether the lights join in, and a try of each effect
    if (!isTrusted(req)) { res.writeHead(403).end('{}'); return }
    if (req.method === 'POST') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        let msg = {}
        try { msg = JSON.parse(body) } catch {}
        if (msg.pair) void huePair(msg.address)
        else if (msg.test === 'done' || msg.test === 'ask' || msg.test === 'alarm') hueTest(msg.test)
        // the stuck-alarm is the dashboard's to see; it tells the lights
        // (once, however many dashboard windows saw it)
        else if (msg.event === 'alarm') { if (Date.now() - lastHueAlarm > 10_000) { lastHueAlarm = Date.now(); hueAlarm() } }
        else setHueOptions(msg)
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
      })
      return
    }
    const cfg = hueConfig()
    hueRooms().catch(() => []).then(rooms => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({
        paired: !!cfg?.appKey, enabled: cfg?.enabled !== false, onDone: cfg?.onDone !== false, onAsk: cfg?.onAsk !== false, onAlarm: cfg?.onAlarm !== false,
        doneColor: cfg?.doneColor ?? '#8cf0be', askColor: cfg?.askColor ?? '#a78bfa', alarmColor: cfg?.alarmColor ?? '#f87171', style: cfg?.style ?? 'glow', pulses: cfg?.pulses ?? 2,
        chosen: cfg?.lights ?? [], rooms, pairing,
      }))
    })
  } else if (url.pathname === '/tile-window' && req.method === 'POST') {
    // a tile in a frameless window of its own (tilewin/tile-window.ps1, WebView2)
    if (!isTrusted(req)) { res.writeHead(403).end('{}'); return }
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      let m = {}
      try { m = JSON.parse(body) } catch {}
      const int = (v, d) => (Number.isFinite(v) ? Math.round(v) : d)
      const script = path.join(HERE, 'tilewin', 'tile-window.ps1')
      if (typeof m.key !== 'string' || !/^[a-z0-9-]{1,40}$/.test(m.key) || process.platform !== 'win32' || !fs.existsSync(script)) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"ok":false}')
        return
      }
      const ok = openTileWindow(m.key, { x: int(m.x, 200), y: int(m.y, 200), w: int(m.w, 380), h: int(m.h, 240), top: false, view: m.view })
      res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok }))
    })
  } else if (url.pathname === '/prefs' && req.method === 'POST') {
    // the main window's look and coloring steps, for the tile windows
    if (!isTrusted(req)) { res.writeHead(403).end('{}'); return }
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      let m = {}
      try { m = JSON.parse(body) } catch {}
      let changed = false
      for (const k of SHARED_PREFS) {
        const v = m[k]
        if ((typeof v === 'string' && v.length <= 24) || v === null) { if (prefs[k] !== v) { prefs[k] = v; changed = true } }
      }
      if (changed) { writeAtomic(PREFS_FILE, `${JSON.stringify(prefs)}\n`); broadcast({ type: 'prefs', prefs }) }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
    })
  } else if (url.pathname === '/tiles-restore' && req.method === 'POST') {
    // the dashboard opened: the tile windows that were open come back where they were
    if (!isTrusted(req)) { res.writeHead(403).end('{}'); return }
    let saved = {}
    try { saved = JSON.parse(fs.readFileSync(path.join(HOME, 'live-code-tiles.json'), 'utf8')) } catch {}
    let opened = 0
    for (const [name, b] of Object.entries(saved)) {
      const [key, view] = name.split('@')
      if (/^[a-z0-9-]{1,40}$/.test(key) && !tileWindows.has(name) && openTileWindow(key, { ...b, view: view ?? b?.view })) opened++
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ opened }))
  } else if (url.pathname === '/today') {
    todayCounts().then(
      c => res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(c)),
      () => res.writeHead(500).end('{}'))
  } else if (url.pathname === '/report-data') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(reportData()))
  } else if (url.pathname === '/icon.png') {
    // the variant set-icon.ps1 picked (icons/active.txt), the diff one by default
    fs.readFile(path.join(HERE, 'icons', 'active.txt'), 'utf8', (_, picked) => {
      const name = /^[a-z]+$/.test((picked ?? '').trim()) ? picked.trim() : 'diff'
      sendFile(res, path.join(HERE, 'icons', `${name}-256.png`), 'image/png')
    })
  } else if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok')
  } else if (url.pathname === '/about') {
    // which copy runs: the mod starts its own one in its place after an update
    void checkLatest()
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ pid: process.pid, server: fileURLToPath(import.meta.url), version: VERSION, latest: latest.version }))
  } else if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    res.write('retry: 2000\n\n')
    send(res, initPayload())
    clients.add(res)
    // a window that answers questions (the dashboard unless switched off, the Stream Deck)
    const answers = url.searchParams.get('answers') === '1'
    if (answers) { answerers.add(res); markRemote() }
    req.on('close', () => {
      clients.delete(res)
      answerers.delete(res)
      if (answers) markRemote()
      lastClientAt = Date.now()
    })
  } else if (url.pathname.startsWith('/action/')) {
    const action = actions.get(decodeURIComponent(url.pathname.slice('/action/'.length)))
    if (action === undefined) res.writeHead(404).end('{}')
    else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(action))
  } else {
    res.writeHead(404).end('not found')
  }
})

server.on('error', error => {
  // another copy already serves this port: nothing to do
  if (error.code === 'EADDRINUSE') process.exit(0)
  throw error
})

loadLog()
scan()
setInterval(scan, SCAN_MS)
setInterval(refreshTitles, TITLE_EVERY_MS)
setInterval(refreshNotes, NOTES_EVERY_MS)
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n')
  if (clients.size === 0 && Date.now() - lastClientAt > IDLE_EXIT_MS) process.exit(0)
}, 15_000)
setInterval(markRemote, 2000)
server.listen(PORT, '127.0.0.1', () => {
  // the Stream Deck plugin finds the server and this run's secret here
  try { writeAtomic(KEY_FILE, JSON.stringify({ port: PORT, secret: SECRET, pid: process.pid, at: Date.now() })) } catch {}
  console.log(`live-code dashboard on http://127.0.0.1:${PORT}`)
})
const cleanUp = () => {
  try { fs.rmSync(REMOTE_FILE, { force: true }) } catch {}
  try { if (JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).pid === process.pid) fs.rmSync(KEY_FILE, { force: true }) } catch {}
}
process.on('exit', cleanUp)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(0))
