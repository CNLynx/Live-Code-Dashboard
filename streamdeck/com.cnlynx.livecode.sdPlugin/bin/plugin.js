// Live Code for the Stream Deck (15 keys, 5 × 3).
//
// It follows the Live Code dashboard server (~/.claude/live-code-dashboard.json
// says where, and its secret) over the same event stream the dashboard reads,
// and draws every key itself as an SVG, a few times a second where something
// moves. No dependencies: the Stream Deck's own Node 20 runs it, with a small
// WebSocket client of its own for the Stream Deck's side.
//
//            col 0        col 1        col 2        col 3        col 4
//   row 0    chat         chat         chat         chat         ⌂ back
//   row 1    now          turn         context      5h limit     cost
//   row 2    prompt       prompt       prompt       ■ stop       dashboard
//
// When Claude asks something, rows 1 and 2 turn into the question and its
// answers; when a task is done, the deck glows.
'use strict'
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const HOME = process.env.LIVE_CODE_HOME ?? path.join(os.homedir(), '.claude')
const KEY_FILE = path.join(HOME, 'live-code-dashboard.json')
const CONFIG_FILE = path.join(HOME, 'live-code-deck.json')
const LOG = path.join(__dirname, 'plugin.log')
const PROFILE = 'Live Code'
const SLOT = 'com.cnlynx.livecode.slot'
const OPEN = 'com.cnlynx.livecode.open'

const log = (...parts) => {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 512 * 1024) fs.rmSync(LOG)
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${parts.join(' ')}\n`)
  } catch {}
}
process.on('uncaughtException', e => log('uncaught', e.stack || e))
process.on('unhandledRejection', e => log('unhandled', e && e.stack || e))

// ── settings: the prompt keys and where things are ──
// (server and dashboard: the mod writes where they are each time a chat starts)
const GERMAN = /^de\b/i.test((() => { try { return Intl.DateTimeFormat().resolvedOptions().locale } catch { return '' } })())
const DEFAULT_CONFIG = {
  prompts: GERMAN ? [
    { label: 'Weiter', icon: '▶', text: 'Mach weiter.' },
    { label: 'Teste es', icon: '✓', text: 'Teste das bitte gründlich und zeig mir, was dabei herauskam.' },
    { label: 'Fazit', icon: '≡', text: 'Fasse kurz zusammen, was du gemacht hast und was noch offen ist.' },
  ] : [
    { label: 'Go on', icon: '▶', text: 'Go on.' },
    { label: 'Test it', icon: '✓', text: 'Please test this thoroughly and show me what came out.' },
    { label: 'Sum up', icon: '≡', text: 'Sum up briefly what you did and what is still open.' },
  ],
  server: '',
  dashboard: '',
}
const config = () => {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } } catch { return DEFAULT_CONFIG }
}
if (!fs.existsSync(CONFIG_FILE)) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...DEFAULT_CONFIG, _help: 'prompts: the three prompt keys, bottom left (label, icon: one character, text: what is sent). Changes apply within a few seconds.' }, null, 2)) } catch {}
}

// ════════════════════════════════════════════════════════════════════════════
// the Stream Deck's side: a WebSocket client, enough for its protocol
// ════════════════════════════════════════════════════════════════════════════
const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }
const SD_PORT = Number(arg('-port'))
const PLUGIN_UUID = arg('-pluginUUID')
const REGISTER = arg('-registerEvent')

let sdSend = () => {}
const frameOf = (opcode, payload) => {
  const mask = crypto.randomBytes(4)
  const len = payload.length
  let head
  if (len < 126) head = Buffer.from([0x80 | opcode, 0x80 | len])
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2) }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2) }
  const body = Buffer.alloc(len)
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([head, mask, body])
}
const connectDeck = () => {
  const req = http.request({
    host: '127.0.0.1', port: SD_PORT, path: '/',
    headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' },
  })
  req.on('upgrade', (_res, socket, head) => {
    let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0)
    let parts = []
    sdSend = obj => { try { socket.write(frameOf(0x1, Buffer.from(JSON.stringify(obj)))) } catch (e) { log('send failed', e.message) } }
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (buf.length < 2) return
        const fin = buf[0] & 0x80
        const op = buf[0] & 0x0f
        const masked = buf[1] & 0x80
        let len = buf[1] & 0x7f
        let off = 2
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
        let mask = null
        if (masked) { if (buf.length < off + 4) return; mask = buf.subarray(off, off + 4); off += 4 }
        if (buf.length < off + len) return
        const payload = Buffer.from(buf.subarray(off, off + len))
        if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3]
        buf = buf.subarray(off + len)
        if (op === 0x8) { log('deck closed'); process.exit(0) }
        if (op === 0x9) { socket.write(frameOf(0xA, payload)); continue }
        if (op === 0x1 || op === 0x2 || op === 0x0) {
          parts.push(payload)
          if (fin) {
            const text = Buffer.concat(parts).toString('utf8')
            parts = []
            try { onDeck(JSON.parse(text)) } catch (e) { log('deck message', e.stack || e) }
          }
        }
      }
    })
    socket.on('close', () => { log('deck socket closed'); process.exit(0) })
    socket.on('error', e => log('deck socket', e.message))
    sdSend({ event: REGISTER, uuid: PLUGIN_UUID })
    log('registered')
  })
  req.on('error', e => { log('deck connect', e.message); setTimeout(connectDeck, 1000) })
  req.end()
}

// ════════════════════════════════════════════════════════════════════════════
// the Live Code side: the dashboard server's event stream
// ════════════════════════════════════════════════════════════════════════════
const live = { sessions: new Map(), latest: new Map(), actions: new Map(), connected: false, key: null }
// each chat's recent finished actions, for the More page's files and counts
const keepAction = (sid, a) => {
  if (!sid || !a?.id) return
  const list = live.actions.get(sid) ?? []
  const at = list.findIndex(x => x.id === a.id)
  const lean = { id: a.id, action: a.action, file: a.file, detail: a.detail, stats: a.stats, isError: a.isError, startedAt: a.startedAt, agentId: a.agentId }
  if (at >= 0) list[at] = lean; else list.push(lean)
  if (list.length > 400) list.splice(0, list.length - 400)
  live.actions.set(sid, list)
}
let liveReq = null
let liveAnswers = false
let startedServerAt = 0
const readKey = () => { try { return JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')) } catch { return null } }
const ensureServer = () => {
  if (Date.now() - startedServerAt < 20_000) return
  startedServerAt = Date.now()
  const server = config().server
  if (!server || !fs.existsSync(server)) return
  log('starting the dashboard server')
  // run in the server's own folder: one inside the plugin's would hold it, and block its updates
  try { spawn(process.execPath, [server], { cwd: path.dirname(server), detached: true, stdio: 'ignore', windowsHide: true }).unref() } catch (e) { log('start server', e.message) }
}
const connectLive = () => {
  const key = readKey()
  live.key = key
  if (!key) { ensureServer(); setTimeout(connectLive, 2500); return }
  // while the Live Code page is on the deck, it answers questions too
  liveAnswers = slots.size > 0
  const retry = () => { if (liveReq !== req) return; live.connected = false; liveReq = null; setTimeout(connectLive, 2500) }
  const req = http.get({ host: '127.0.0.1', port: key.port, path: `/events${liveAnswers ? '?answers=1' : ''}`, headers: { Host: `127.0.0.1:${key.port}`, Accept: 'text/event-stream' } }, res => {
    if (res.statusCode !== 200) { res.resume(); retry(); return }
    live.connected = true
    res.setEncoding('utf8')
    let buf = ''
    res.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const data = block.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n')
        if (data) { try { onLive(JSON.parse(data)) } catch (e) { log('live message', e.message) } }
      }
    })
    res.on('end', retry)
    res.on('error', retry)
  })
  // nobody listens there: the server is not running, so start it
  req.on('error', e => { if (e.code === 'ECONNREFUSED') ensureServer(); retry() })
  liveReq = req
}
// the page came or went: reconnect, saying whether this deck answers
const syncAnswering = () => {
  if ((slots.size > 0) === liveAnswers || !liveReq) return
  const old = liveReq
  liveReq = null
  old.destroy()
  connectLive()
}
const post = body => new Promise(resolve => {
  const key = live.key ?? readKey()
  if (!key) { resolve(false); return }
  const text = JSON.stringify(body)
  const req = http.request({ host: '127.0.0.1', port: key.port, path: '/send', method: 'POST', headers: { Host: `127.0.0.1:${key.port}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'X-Live-Code-Secret': key.secret } }, res => {
    res.resume()
    if (res.statusCode === 403) live.key = readKey() // the server restarted: a new secret
    resolve(res.statusCode === 200)
  })
  req.on('error', () => resolve(false))
  req.end(text)
})

const doneAt = new Map() // sid -> when its last turn ended, as seen here
let flashAt = 0
const onLive = msg => {
  if (msg.type === 'init') {
    live.sessions.clear()
    for (const s of msg.sessions ?? []) live.sessions.set(s.id, s.snapshot)
    for (const s of live.sessions.values()) if (s?.session?.id) doneAt.set(s.session.id, s.thinking?.turnEndedAt ?? 0)
    live.actions.clear()
    for (const a of msg.actions ?? []) keepAction(a.sid, a)
  } else if (msg.type === 'feed') {
    const before = live.sessions.get(msg.sid)
    live.sessions.set(msg.sid, msg.snapshot)
    for (const a of msg.actions ?? []) { if (a.rows?.length || a.action) live.latest.set(msg.sid, a); keepAction(msg.sid, a) }
    // a turn that was running ended: the deck glows
    const ended = msg.snapshot?.thinking?.turnEndedAt ?? 0
    if (before && isLive(before) && !isLive(msg.snapshot) && ended > (doneAt.get(msg.sid) ?? 0)) {
      doneAt.set(msg.sid, ended)
      flashAt = Date.now()
      celebrated.set(msg.sid, Date.now())
    }
  } else if (msg.type === 'view') {
    if (live.sessions.has(msg.sid)) focus = msg.sid
  }
}

// ════════════════════════════════════════════════════════════════════════════
// what the keys show
// ════════════════════════════════════════════════════════════════════════════
const isLive = snap => { const th = snap?.thinking; return !!(th?.turnStartedAt && (th.turnEndedAt ?? 0) < th.turnStartedAt) }
const isBusy = snap => !!snap && !snap.session?.isEnded && (isLive(snap) || (snap.current && !snap.current.isDone))
const baseName = p => String(p ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop()
const nameOf = snap => snap?.session?.title || baseName(snap?.session?.cwd) || 'Session'
const dur = ms => { const s = Math.max(0, ms) / 1000; if (s < 60) return `${Math.floor(s)}s`; const m = Math.floor(s / 60); return m < 60 ? `${m}m${String(Math.floor(s % 60)).padStart(2, '0')}` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` }
const money = v => '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2))
const ACTION = { reading: ['READING', '#8b9cff'], editing: ['EDITING', '#f5a97f'], writing: ['WRITING', '#5ed6c0'], searching: ['SEARCHING', '#b6a4ff'], running: ['RUNNING', '#f2cc7a'] }
const GOOD = '#7ddcae', BAD = '#f87171', ASK_P = '#ffb84d', ASK_Q = '#a78bfa', INK = '#eceef4', INK2 = '#a9adbf', MUTED = '#71768a'

let focus = null // the chat the deck follows; null: whoever works
const celebrated = new Map() // sid -> when its glow began
const pressedAt = new Map() // context -> when its key went down
const flashKey = new Map() // context -> { until, text, color }
let stopArmedUntil = 0
const alarmed = new Map() // sid -> when it looked stuck

const chatsByRecent = () => [...live.sessions.entries()]
  .filter(([id, s]) => id !== 'legacy' && s && !s.session?.isEnded && (isBusy(s) || Date.now() - (s.session?.updatedAt ?? 0) < 12 * 3600e3))
  .sort((a, b) => (isBusy(b[1]) - isBusy(a[1])) || (b[1].session?.updatedAt ?? 0) - (a[1].session?.updatedAt ?? 0))
const focusId = () => {
  if (focus && live.sessions.has(focus)) return focus
  return chatsByRecent()[0]?.[0] ?? null
}
const pendingAsk = () => {
  // the followed chat's question first, then any other's
  const all = []
  for (const [sid, s] of live.sessions) for (const a of s?.asks ?? []) if (s.session?.canAnswer) all.push({ ...a, sid, chat: nameOf(s) })
  all.sort((a, b) => (b.sid === focusId()) - (a.sid === focusId()) || a.at - b.at)
  return all[0] ?? null
}

// ── drawing: SVG Tiny, as the Stream Deck renders it (no filters, no CSS) ──
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])
const FONT = "Segoe UI, Arial, sans-serif"
const text = (x, y, str, { size = 18, weight = 600, fill = INK, anchor = 'middle', opacity = 1 } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" fill-opacity="${opacity}" text-anchor="${anchor}">${esc(str)}</text>`
// words into at most `lines` lines of about `width` characters
// (a word too long for a line is split over lines, at its hyphens if it has any)
const wrap = (str, width, lines) => {
  const words = []
  for (const w of String(str ?? '').replace(/\s+/g, ' ').trim().split(' ')) {
    if (w.length <= width) { words.push(w); continue }
    // at its hyphens if it has any, else in even pieces with a hyphen of their own
    let rest = w
    while (rest.length > width) {
      const cut = Math.max(...['-', '.', ':', '_', '/', '\\'].map(c => rest.lastIndexOf(c, width - 1)))
      if (cut >= 3) { words.push(rest.slice(0, cut + 1)); rest = rest.slice(cut + 1); continue }
      const pieces = Math.ceil(rest.length / (width - 1))
      const size = Math.ceil(rest.length / pieces)
      words.push(rest.slice(0, size) + '-')
      rest = rest.slice(size)
    }
    if (rest) words.push(rest)
  }
  const out = []
  let line = ''
  for (const word of words) {
    const joined = line === '' ? word : line.endsWith('-') ? line + word : `${line} ${word}`
    if (joined.length <= width) line = joined
    else { out.push(line); line = word }
  }
  if (line) out.push(line)
  if (out.length > lines) { const kept = out.slice(0, lines); kept[lines - 1] = kept[lines - 1].slice(0, width - 1) + '…'; return kept }
  return out.filter(Boolean)
}
const lines = (arr, x, y, step, opts) => arr.map((l, i) => text(x, y + i * step, l, opts)).join('')
// A key: dark glass, a coloured edge, and a glow that can breathe.
const key = (inner, { accent = '#8b9cff', glow = 0, edge = 0.35, dim = false } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
  `<defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${dim ? '#0f1016' : '#171a29'}"/><stop offset="1" stop-color="#090a10"/></linearGradient>` +
  `<radialGradient id="g" cx="0.5" cy="0.5" r="0.62"><stop offset="0" stop-color="${accent}" stop-opacity="${(0.62 * glow).toFixed(2)}"/><stop offset="0.7" stop-color="${accent}" stop-opacity="${(0.22 * glow).toFixed(2)}"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient></defs>` +
  `<rect width="144" height="144" fill="url(#b)"/>` +
  (glow > 0.01 ? `<rect width="144" height="144" fill="url(#g)"/>` : '') +
  `<rect x="3" y="3" width="138" height="138" rx="20" fill="none" stroke="${accent}" stroke-opacity="${Math.min(1, edge + glow * 0.6).toFixed(2)}" stroke-width="${(3 + glow * 4).toFixed(1)}"/>` +
  inner + `</svg>`
const ring = (cx, cy, r, pct, color, width = 10) => {
  const c = 2 * Math.PI * r
  const on = Math.max(0, Math.min(1, pct / 100)) * c
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="${width}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-dasharray="${on.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>`
}
const heat = p => p >= 90 ? '#f87171' : p >= 75 ? '#fb923c' : p >= 50 ? '#f2cc7a' : GOOD
// a slow breath, in a few steps, so a pulsing key is redrawn a few times a second only
const breath = (period = 1600) => Math.round((0.5 + 0.5 * Math.sin((Date.now() / period) * 2 * Math.PI)) * 14) / 14
// the done-glow sweeping across the deck, column by column
const sweep = col => { const t = Date.now() - flashAt - col * 90; return t < 0 || t > 1400 ? 0 : Math.round((1 - t / 1400) * 16) / 16 }

// a moment ahead: the time today, with the weekday on another day ("Fr 03:00")
const whenHm = t => {
  const d = new Date(t)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(undefined, { weekday: 'short' }).replace('.', '')} ${time}`
}
const limitInfo = l => {
  if (!l) return null
  const resetIn = l.resetsAt ? Math.max(0, Date.parse(l.resetsAt) - Date.now()) : null
  const safe = l.etaMs == null || resetIn == null || l.etaMs >= resetIn
  return { resetIn, safe, pause: safe ? 0 : resetIn - l.etaMs }
}

const draw = (col, row) => {
  const sid = focusId()
  const snap = sid ? live.sessions.get(sid) : null
  const ask = pendingAsk()
  const g = sweep(col)

  if (!live.connected) {
    if (col === 4 && row === 0) return backKey(g)
    if (row === 1 && col === 2) return key(text(72, 66, 'Live Code', { size: 20 }) + text(72, 94, 'connecting…', { size: 15, fill: MUTED, weight: 400 }), { dim: true })
    return key('', { dim: true, edge: 0.12 })
  }

  // a question takes the main page, wherever the deck was
  if (ask && page !== 'main') page = 'main'
  if (page === 'chats') return chatsPage(col, row, g, sid)
  if (page === 'more') return morePage(col, row, g, sid, snap)

  // ── top row: the three busiest chats, the folder of all, the way back ──
  if (row === 0) {
    if (col === 4) return backKey(g)
    if (col === 3) return folderKey(g)
    return chatKey(chatsByRecent()[col], sid, g)
  }

  // ── a question waits: rows 1 and 2 are it and its answers ──
  if (ask) return askKey(ask, col, row, g)

  // ── middle row: what happens now ──
  if (row === 1) {
    if (!snap) return key(text(72, 80, 'No chat', { size: 18, fill: MUTED }), { dim: true })
    const u = snap.usage ?? {}
    if (col === 0) {
      const a = snap.current ?? live.latest.get(sid)
      if (!a) return key(text(72, 80, 'No file yet', { size: 16, fill: MUTED }), { dim: true })
      const [label, color] = ACTION[a.action] ?? ['DOING', '#8b9cff']
      const running = !a.isDone
      const what = a.action === 'running' ? (a.detail || a.file) : a.action === 'searching' ? (a.detail || '…') : baseName(a.file)
      const where = a.action === 'running' ? a.file : a.action === 'searching' ? `in ${a.file === '.' ? 'project' : baseName(a.file)}` : a.line != null ? `line ${a.line}${a.endLine && a.endLine !== a.line ? '–' + a.endLine : ''}` : ''
      // the action's progress, as the dashboard replays it: typed or scanned in
      // percent; a command that runs has a light moving along instead
      const prog = actionProgress(a)
      const hasPlan = planActive(snap)
      const barY = hasPlan ? 112 : 122
      const pctText = prog === null ? '' : prog >= 1 ? (a.action === 'reading' ? 'read' : a.action === 'running' ? 'done' : '✓') : `${Math.round(prog * 100)}%`
      const progress = prog === null ? runningBar(14, barY, 116, 8, color) : bar(14, barY, 116, 8, prog, prog >= 1 && a.action !== 'reading' ? GOOD : color)
      // under it, the task list: one segment per task, and how many are done
      const p = snap.plan
      const planBar = hasPlan
        ? segments(p.items, p.total, p.done, 14, 128, 86, 7) + text(130, 135, `${p.done}/${p.total}`, { size: 12, weight: 750, fill: p.done >= p.total ? GOOD : '#f2cc7a', anchor: 'end' })
        : ''
      return key(
        text(16, 30, label, { size: 14, weight: 750, fill: color, anchor: 'start' }) + text(128, 30, pctText, { size: 14, weight: 700, fill: prog !== null && prog >= 1 ? GOOD : INK, anchor: 'end' }) +
        lines(wrap(what, 12, hasPlan ? 2 : 3), 72, 58, 21, { size: 17, weight: 650 }) +
        text(72, hasPlan ? 102 : 110, where, { size: 12, weight: 400, fill: INK2 }) + progress + planBar,
        { accent: color, glow: Math.max(g, running ? 0.2 + 0.2 * breath(900) : 0), edge: running ? 0.6 : 0.3 })
    }
    if (col === 1) {
      const th = snap.thinking ?? {}
      const liveTurn = isLive(snap)
      const last = (snap.turnStats ?? []).slice(-1)[0]
      const glowDone = Math.max(0, 1 - (Date.now() - (celebrated.get(sid) ?? 0)) / 4000)
      const stuck = alarmed.has(sid) && Date.now() - alarmed.get(sid) < 60_000
      const steps = (snap.steps ?? []).filter(s => !s.agentId)
      if (liveTurn) {
        const color = stuck ? BAD : th.active ? '#b6a4ff' : '#8b9cff'
        return key(text(72, 32, stuck ? 'STUCK?' : th.active ? 'THINKING' : 'WORKING', { size: 14, weight: 750, fill: color }) + text(72, 80, dur(Date.now() - th.turnStartedAt), { size: 32, weight: 650 }) + text(72, 116, `${steps.length} steps · turn ${snap.turnNo ?? ''}`, { size: 13, weight: 400, fill: INK2 }),
          { accent: color, glow: Math.max(g, stuck ? 0.4 + 0.5 * breath(500) : 0.15 + 0.25 * breath(1600)), edge: 0.55 })
      }
      return key(text(72, 32, glowDone > 0 ? 'DONE ✓' : 'IDLE', { size: 14, weight: 750, fill: glowDone > 0 ? GOOD : MUTED }) + text(72, 80, last ? dur(last.ms) : '—', { size: 30, weight: 650, fill: glowDone > 0 ? INK : INK2 }) + text(72, 116, last ? `${last.steps} steps${last.usd != null ? ' · ' + money(last.usd) : ''}` : 'waiting for you', { size: 13, weight: 400, fill: INK2 }),
        { accent: GOOD, glow: Math.max(g, glowDone), edge: glowDone > 0 ? 0.7 : 0.2 })
    }
    if (col === 2) {
      const p = u.percent
      if (p == null) return key(text(72, 80, 'Context', { size: 16, fill: MUTED }), { dim: true })
      return key(ring(72, 66, 40, p, heat(p)) + text(72, 74, `${Math.round(p)}%`, { size: 24, weight: 700 }) + text(72, 130, 'Context', { size: 14, weight: 500, fill: INK2 }), { accent: heat(p), glow: g, edge: 0.3 })
    }
    if (col === 3) {
      const l = (u.limits ?? []).find(x => x.kind === 'five_hour') ?? (u.limits ?? [])[0]
      if (!l) return key(text(72, 80, 'Limits', { size: 16, fill: MUTED }), { dim: true })
      const info = limitInfo(l)
      const color = info.safe ? heat(l.percent) : '#fb923c'
      const note = info.safe ? (info.resetIn != null ? `safe · ${dur(info.resetIn)}` : '') : `pause ${dur(info.pause)}`
      return key(ring(72, 60, 36, l.percent, color, 9) + text(72, 68, `${Math.round(l.percent)}%`, { size: 22, weight: 700 }) + text(72, 116, l.kind === 'five_hour' ? '5h limit' : l.kind === 'seven_day' ? '7d limit' : 'limit', { size: 13, weight: 500, fill: INK2 }) + text(72, 134, note, { size: 13, weight: 650, fill: info.safe ? GOOD : '#fb923c' }),
        { accent: color, glow: Math.max(g, info.safe ? 0 : 0.2 + 0.3 * breath(1400)), edge: 0.3 })
    }
    if (col === 4) {
      const th = snap.thinking ?? {}
      const turnUsd = u.usd != null && th.usdAtStart != null && isLive(snap) ? u.usd - th.usdAtStart : (snap.turnStats ?? []).slice(-1)[0]?.usd
      return key(text(72, 32, 'COST', { size: 14, weight: 750, fill: '#f2cc7a' }) + text(72, 78, u.usd != null ? money(u.usd) : '—', { size: 28, weight: 700 }) + text(72, 112, turnUsd != null ? `turn ${money(turnUsd)}` : 'this chat', { size: 14, weight: 400, fill: INK2 }), { accent: '#f2cc7a', glow: g, edge: 0.3 })
    }
  }

  // ── bottom row: prompts, stop, dashboard ──
  if (row === 2) {
    if (col <= 2) {
      const p = config().prompts?.[col]
      if (!p) return key('', { dim: true, edge: 0.1 })
      const fl = flashKey.get(`p${col}`)
      if (fl && Date.now() < fl.until) return key(text(72, 70, fl.text, { size: 20, weight: 700, fill: fl.color }) + text(72, 98, fl.sub ?? '', { size: 13, weight: 400, fill: INK2 }), { accent: fl.color, glow: 0.7 })
      const can = !!snap?.session?.canReceive
      return key(text(72, 66, p.icon ?? '▶', { size: 40, weight: 700, fill: can ? '#8b9cff' : MUTED }) + lines(wrap(p.label, 11, 2), 72, 108, 20, { size: 17, weight: 650, fill: can ? INK : MUTED }),
        { accent: '#8b9cff', glow: g, edge: can ? 0.35 : 0.12, dim: !can })
    }
    if (col === 3) {
      const busy = isBusy(snap)
      const armed = Date.now() < stopArmedUntil
      const stuck = sid && alarmed.has(sid) && Date.now() - alarmed.get(sid) < 60_000
      if (!busy || !snap?.session?.canStop) return key(`<rect x="52" y="40" width="40" height="40" rx="6" fill="${MUTED}" fill-opacity="0.5"/>` + text(72, 116, 'Stop', { size: 16, weight: 600, fill: MUTED }), { dim: true, edge: 0.12 })
      return key(`<rect x="50" y="34" width="44" height="44" rx="7" fill="${BAD}"/>` + text(72, 112, armed ? 'Press again' : stuck ? 'Stuck: stop?' : 'Stop', { size: armed ? 15 : 17, weight: 700, fill: armed || stuck ? '#ffd5d5' : INK }),
        { accent: BAD, glow: Math.max(g, armed ? breath(300) : stuck ? 0.3 + 0.6 * breath(500) : 0.1), edge: 0.6 })
    }
    if (col === 4) {
      // the More page, its bars previewed: context, limit, the running step
      const u = snap?.usage ?? {}
      const l5 = (u.limits ?? []).find(l => l.kind === 'five_hour')
      const running = (snap?.steps ?? []).some(s => s.status === 'running' && !s.agentId)
      return key(
        bar(24, 30, 96, 9, (u.percent ?? 0) / 100, heat(u.percent ?? 0)) + bar(24, 48, 96, 9, (l5?.percent ?? 0) / 100, heat(l5?.percent ?? 0)) +
        (running ? runningBar(24, 66, 96, 9, '#f2cc7a') : bar(24, 66, 96, 9, 0, '#f2cc7a')) +
        text(72, 112, 'More', { size: 18, weight: 700 }) + text(72, 132, 'bars · steps · files', { size: 12, weight: 400, fill: INK2 }),
        { accent: '#8b9cff', glow: g, edge: 0.35 })
    }
  }
  return key('', { dim: true })
}

// ── an action's progress, timed as the dashboard replays it ──
// Typing an edit takes its changed characters at 45 per second or more, about
// 4.5 s in all; reading sweeps its lines in at most 2.5 s. From when this deck
// first saw the action. null: a command still running, with no end to measure.
const firstSeen = new Map() // action id -> when the deck first drew it
const actionProgress = a => {
  if (!firstSeen.has(a.id)) { firstSeen.set(a.id, Date.now()); if (firstSeen.size > 500) firstSeen.delete(firstSeen.keys().next().value) }
  if (a.action === 'running' || a.action === 'searching') return a.isDone ? 1 : null
  const rows = a.rows ?? []
  let ms
  if (a.action === 'reading') ms = rows.length * Math.min(45, 2500 / Math.max(1, rows.length))
  else {
    const cost = rows.reduce((n, r) => n + (r.kind === 'add' ? r.text.length + 3 : r.kind === 'del' ? r.text.length / 3 + 2 : r.kind === 'mod' ? Math.max(0, ((r.beforeSpan?.[1] ?? 0) - (r.beforeSpan?.[0] ?? 0))) / 3 + Math.max(0, ((r.span?.[1] ?? 0) - (r.span?.[0] ?? 0))) + 3 : 0), 0)
    ms = (cost * 1000) / Math.max(45, (cost * 1000) / 4500)
  }
  if (!(ms > 0)) return 1
  return Math.min(1, (Date.now() - firstSeen.get(a.id)) / ms)
}

// ── the task's plan: one segment per task, the running one breathing ──
const planActive = snap => {
  const p = snap?.plan
  return !!p && p.total > 0 && (!p.isFinished || Date.now() - p.updatedAt < 120_000)
}
const segments = (items, total, done, x, y, w, h) => {
  const n = Math.max(1, Math.min(14, total || items.length))
  const gap = n > 8 ? 3 : 4
  const sw = (w - gap * (n - 1)) / n
  let out = ''
  for (let i = 0; i < n; i++) {
    // more tasks than segments: each segment stands for a share of them
    const at = Math.floor((i * (total || items.length)) / n)
    const st = items[at]?.status ?? (at < done ? 'done' : 'pending')
    const color = st === 'done' ? GOOD : st === 'running' ? '#f2cc7a' : '#ffffff'
    const op = st === 'done' ? 1 : st === 'running' ? 0.45 + 0.55 * breath(900) : 0.12
    out += `<rect x="${(x + i * (sw + gap)).toFixed(1)}" y="${y}" width="${sw.toFixed(1)}" height="${h}" rx="${Math.min(h / 2, sw / 2).toFixed(1)}" fill="${color}" fill-opacity="${op.toFixed(2)}"/>`
  }
  return out
}

// One chat: its name, what it does, and a glow when it is done or asks.
const chatKey = (entry, sid, g) => {
  if (!entry) return key(text(72, 80, '—', { size: 24, fill: MUTED }), { dim: true, edge: 0.1 })
  const [id, s] = entry
  const busy = isBusy(s)
  const asks = (s.asks ?? []).length > 0
  const cur = s.current
  const color = asks ? ASK_Q : busy ? (cur && !cur.isDone ? ACTION[cur.action]?.[1] : '#b6a4ff') ?? '#8b9cff' : MUTED
  const glowDone = Math.max(0, 1 - (Date.now() - (celebrated.get(id) ?? 0)) / 4000)
  const glow = asks ? 0.35 + 0.55 * breath(1200) : glowDone > 0 ? glowDone : busy ? 0.15 + 0.25 * breath(2200) : 0
  const state = asks ? '❓ waits' : s.session?.isEnded ? 'ended' : busy ? (s.thinking?.active && isLive(s) ? `thinking ${dur(Date.now() - s.thinking.since)}` : `working ${dur(Date.now() - (s.thinking?.turnStartedAt ?? Date.now()))}`) : glowDone > 0 ? '✓ done' : idleFor(s)
  const isFocus = id === sid
  return key(
    `<circle cx="22" cy="22" r="7" fill="${busy || asks ? color : MUTED}"/>` +
    (isFocus ? text(124, 28, '●', { size: 14, fill: '#8b9cff', anchor: 'end' }) : '') +
    lines(wrap(nameOf(s), 11, 3), 72, 56, 22, { size: 19, weight: 650 }) +
    text(72, 128, state, { size: 15, weight: 500, fill: glowDone > 0 ? GOOD : asks ? ASK_Q : busy ? color : MUTED }),
    { accent: glowDone > 0 ? GOOD : color, glow: Math.max(glow, g), edge: isFocus ? 0.75 : busy ? 0.45 : 0.18 },
  )
}
const idleFor = s => {
  const ago = Date.now() - (s.session?.updatedAt ?? 0)
  return ago < 60_000 ? 'idle' : ago < 3600e3 ? `idle ${Math.floor(ago / 60_000)}m` : ago < 86400e3 ? `idle ${Math.floor(ago / 3600e3)}h` : `${Math.floor(ago / 86400e3)}d ago`
}

// ── pages: the deck switches what its keys show, no Stream Deck pages needed ──
let page = 'main' // 'main' | 'chats' | 'more'
let chatOffset = 0
const CHATS_PER_PAGE = 13 // fifteen keys, less "back" and "next"
const allChats = () => [...live.sessions.entries()]
  .filter(([id, s]) => id !== 'legacy' && s && !s.session?.isEnded && (isBusy(s) || Date.now() - (s.session?.updatedAt ?? 0) < 7 * 86400e3))
  .sort((a, b) => (isBusy(b[1]) - isBusy(a[1])) || (b[1].session?.updatedAt ?? 0) - (a[1].session?.updatedAt ?? 0))

// The folder: every chat, busy ones glowing through it.
const folderKey = g => {
  const list = allChats()
  const busy = list.filter(([, s]) => isBusy(s)).length
  const waiting = list.some(([, s]) => (s.asks ?? []).length > 0)
  const done = list.some(([id]) => Date.now() - (celebrated.get(id) ?? 0) < 4000)
  const accent = waiting ? ASK_Q : done ? GOOD : busy ? '#8b9cff' : '#a9adbf'
  // the folder's dots: one per chat (up to nine), lit while it works
  const dots = list.slice(0, 9).map(([, s], i) => `<circle cx="${50 + (i % 3) * 22}" cy="${54 + Math.floor(i / 3) * 16}" r="5" fill="${isBusy(s) ? '#8b9cff' : (s.asks ?? []).length ? ASK_Q : MUTED}"/>`).join('')
  return key(
    `<path d="M26 34 h30 l8 9 h54 v60 h-92 z" fill="#ffffff" fill-opacity="0.06" stroke="${accent}" stroke-width="4" stroke-linejoin="round"/>` + dots +
    text(72, 128, `Chats · ${list.length}`, { size: 16, weight: 650 }),
    { accent, glow: Math.max(g, waiting ? 0.3 + 0.5 * breath(1200) : done ? 0.6 : busy ? 0.1 + 0.2 * breath(2200) : 0), edge: 0.4 })
}
const pageBack = (label, g) => key(
  `<path d="M86 44 L58 72 L86 100" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>` + text(72, 132, label, { size: 15, weight: 600, fill: INK2 }),
  { accent: '#a9adbf', glow: g, edge: 0.3 })

// Every chat, thirteen to a page; the last key turns the page when there are more.
const chatsPage = (col, row, g, sid) => {
  if (col === 4 && row === 0) return pageBack('Main', g)
  const list = allChats()
  const pages = Math.max(1, Math.ceil(list.length / CHATS_PER_PAGE))
  if (chatOffset >= pages) chatOffset = 0
  if (col === 4 && row === 2 && pages > 1) {
    return key(text(72, 76, '›', { size: 64, weight: 300 }) + text(72, 126, `page ${chatOffset + 1}/${pages}`, { size: 14, weight: 500, fill: INK2 }), { accent: '#8b9cff', glow: g, edge: 0.35 })
  }
  // keys in reading order, without the back key
  const slot = row * 5 + col - (row > 0 || col > 4 ? 1 : 0)
  return chatKey(list[chatOffset * CHATS_PER_PAGE + slot], sid, g)
}

// ── the More page: bars ──
const bar = (x, y, w, h, frac, color, track = 0.1) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="#ffffff" fill-opacity="${track}"/>` +
  (frac > 0 ? `<rect x="${x}" y="${y}" width="${Math.max(h, w * Math.min(1, frac)).toFixed(1)}" height="${h}" rx="${h / 2}" fill="${color}"/>` : '')
// a light sweeping along a bar that has no end to measure (something runs)
const runningBar = (x, y, w, h, color) => {
  const span = w * 0.35
  const at = ((Date.now() / 6) % (w + span)) - span
  const from = Math.max(x, x + at), to = Math.min(x + w, x + at + span)
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="#ffffff" fill-opacity="0.1"/>` + (to > from ? `<rect x="${from.toFixed(1)}" y="${y}" width="${(to - from).toFixed(1)}" height="${h}" rx="${h / 2}" fill="${color}"/>` : '')
}
const LIMIT_SPAN = { five_hour: 5 * 3600e3, seven_day: 7 * 86400e3, seven_day_opus: 7 * 86400e3 }
const STEP = { read: ['READ', '#8b9cff'], edit: ['EDIT', '#f5a97f'], write: ['WRITE', '#5ed6c0'], search: ['SEARCH', '#b6a4ff'], bash: ['RUN', '#f2cc7a'], web: ['WEB', '#5ed6c0'], agent: ['AGENT', '#f29bc0'], other: ['TOOL', '#a9adbf'] }

// what a step did, in words: a command by its description, as its action keeps it
const stepWords = (st, sid) => {
  const a = (live.actions.get(sid) ?? []).find(x => x.id === st.id) ?? (live.sessions.get(sid)?.current?.id === st.id ? live.sessions.get(sid).current : null)
  if (st.kind === 'bash' && a?.detail) return a.detail
  return String(st.label ?? '').replace(/^[\w.-]+: /, '')
}
const limitKey = (l, label, g) => {
  if (!l) return key(text(72, 66, label, { size: 16, fill: MUTED }) + text(72, 92, 'no data', { size: 13, fill: MUTED, weight: 400 }), { dim: true })
  const info = limitInfo(l)
  const color = info.safe ? heat(l.percent) : '#fb923c'
  const span = LIMIT_SPAN[l.kind]
  // how far through its window the limit is: the time bar under the usage bar
  const elapsed = span && info.resetIn != null ? 1 - info.resetIn / span : null
  return key(
    text(16, 30, label, { size: 15, weight: 750, fill: color, anchor: 'start' }) + text(128, 30, `${Math.round(l.percent)}%`, { size: 20, weight: 700, anchor: 'end' }) +
    bar(16, 44, 112, 14, l.percent / 100, color) +
    text(16, 82, info.resetIn != null ? `reset ${whenHm(Date.now() + info.resetIn)}` : 'reset', { size: 12, weight: 400, fill: INK2, anchor: 'start' }) + text(128, 82, info.resetIn != null ? dur(info.resetIn) : '—', { size: 13, weight: 650, anchor: 'end' }) +
    (elapsed != null ? bar(16, 90, 112, 6, elapsed, '#8b9cff') : '') +
    text(72, 126, info.safe ? '✓ safe' : `pause ${dur(info.pause)}`, { size: 15, weight: 700, fill: info.safe ? GOOD : '#fb923c' }),
    { accent: color, glow: Math.max(g, info.safe ? 0 : 0.2 + 0.3 * breath(1400)), edge: 0.35 })
}

const morePage = (col, row, g, sid, snap) => {
  if (col === 4 && row === 0) return pageBack('Main', g)
  if (!snap) return key(text(72, 80, 'No chat', { size: 16, fill: MUTED }), { dim: true })
  const u = snap.usage ?? {}
  const limits = u.limits ?? []
  if (row === 0) {
    if (col === 0) {
      const p = u.percent ?? 0
      return key(text(16, 30, 'CONTEXT', { size: 15, weight: 750, fill: heat(p), anchor: 'start' }) + text(128, 30, `${Math.round(p)}%`, { size: 20, weight: 700, anchor: 'end' }) +
        bar(16, 44, 112, 14, p / 100, heat(p)) +
        text(72, 92, u.tokens != null ? `${Math.round(u.tokens / 1000)}k of ${Math.round((u.window ?? 0) / 1000)}k` : '', { size: 14, weight: 500, fill: INK2 }) +
        text(72, 126, p >= 80 ? 'compact soon' : 'tokens', { size: 13, weight: 500, fill: p >= 80 ? '#fb923c' : MUTED }), { accent: heat(p), glow: g, edge: 0.35 })
    }
    if (col === 1) return limitKey(limits.find(l => l.kind === 'five_hour'), '5H', g)
    if (col === 2) return limitKey(limits.find(l => l.kind === 'seven_day'), '7D', g)
    // cost: the session's, and this turn's share of it as a bar
    const th = snap.thinking ?? {}
    const turnUsd = u.usd != null && th.usdAtStart != null && isLive(snap) ? u.usd - th.usdAtStart : (snap.turnStats ?? []).slice(-1)[0]?.usd
    return key(text(16, 30, 'COST', { size: 15, weight: 750, fill: '#f2cc7a', anchor: 'start' }) + text(72, 72, u.usd != null ? money(u.usd) : '—', { size: 28, weight: 700 }) +
      bar(16, 92, 112, 8, u.usd ? (turnUsd ?? 0) / u.usd : 0, '#f2cc7a') + text(72, 126, turnUsd != null ? `turn ${money(turnUsd)}` : 'this chat', { size: 14, weight: 500, fill: INK2 }),
      { accent: '#f2cc7a', glow: g, edge: 0.3 })
  }
  if (row === 1) {
    // the newest five steps of the turn, each with its bar
    const steps = (snap.steps ?? []).filter(s => !s.agentId).slice(-5)
    const st = steps[col]
    if (!st) return key(text(72, 80, col === 0 && steps.length === 0 ? 'No steps yet' : '', { size: 14, fill: MUTED }), { dim: true, edge: 0.1 })
    const [label, color] = STEP[st.kind] ?? STEP.other
    const ink = st.status === 'error' ? BAD : st.status === 'done' ? GOOD : color
    const took = (st.doneAt ?? Date.now()) - st.startedAt
    return key(text(16, 30, label, { size: 14, weight: 800, fill: color, anchor: 'start' }) + text(128, 30, st.status === 'error' ? '✗' : st.status === 'done' ? '✓' : '', { size: 18, weight: 800, fill: ink, anchor: 'end' }) +
      lines(wrap(stepWords(st, sid), 12, 3), 72, 62, 20, { size: 16, weight: 600 }) +
      (st.status === 'running' ? runningBar(16, 116, 112, 8, color) : bar(16, 116, 112, 8, 1, ink, 0.1)) +
      text(128, 140, dur(took), { size: 11, weight: 500, fill: INK2, anchor: 'end' }),
      { accent: color, glow: Math.max(g, st.status === 'running' ? 0.15 + 0.3 * breath(900) : 0), edge: st.status === 'running' ? 0.6 : 0.3 })
  }
  // row 2: the files this turn changed most, tool calls and errors, the dashboard
  if (col === 4) {
    return key(`<rect x="40" y="30" width="28" height="22" rx="4" fill="#8b9cff"/><rect x="76" y="30" width="28" height="22" rx="4" fill="#5ed6c0"/><rect x="40" y="58" width="28" height="22" rx="4" fill="#f5a97f"/><rect x="76" y="58" width="28" height="22" rx="4" fill="#b6a4ff"/>` +
      text(72, 116, 'Dashboard', { size: 16, weight: 650 }) + text(72, 136, 'hold: wall', { size: 12, weight: 400, fill: MUTED }), { accent: '#8b9cff', glow: g, edge: 0.3 })
  }
  const acts = (live.actions.get(sid) ?? []).filter(a => !a.agentId)
  const from = snap.thinking?.turnStartedAt ?? 0
  if (col === 3) {
    const turn = acts.filter(a => a.startedAt >= from)
    const errs = turn.filter(a => a.isError).length
    return key(text(16, 30, 'THIS TURN', { size: 14, weight: 800, fill: '#8b9cff', anchor: 'start' }) + text(72, 74, String(turn.length), { size: 34, weight: 700 }) + text(72, 98, 'tool calls', { size: 13, weight: 500, fill: INK2 }) +
      bar(16, 112, 112, 8, turn.length ? errs / turn.length : 0, BAD) + text(72, 138, errs ? `${errs} failed` : 'none failed', { size: 12, weight: 600, fill: errs ? BAD : GOOD }),
      { accent: errs ? BAD : '#8b9cff', glow: g, edge: 0.3 })
  }
  const byFile = new Map()
  for (const a of acts) {
    if (a.startedAt < from || (a.action !== 'editing' && a.action !== 'writing')) continue
    const f = byFile.get(a.file) ?? { file: a.file, add: 0, del: 0, mod: 0, n: 0 }
    f.add += a.stats?.add ?? 0; f.del += a.stats?.del ?? 0; f.mod += a.stats?.mod ?? 0; f.n++
    byFile.set(a.file, f)
  }
  const files = [...byFile.values()].sort((a, b) => (b.add + b.del + b.mod) - (a.add + a.del + a.mod))
  const f = files[col]
  if (!f) return key(text(72, 80, col === 0 ? 'No file changed' : '', { size: 13, fill: MUTED }), { dim: true, edge: 0.1 })
  const most = Math.max(1, ...files.map(x => x.add + x.del + x.mod))
  const w = 112 * ((f.add + f.del + f.mod) / most)
  const tot = Math.max(1, f.add + f.del + f.mod)
  return key(text(16, 30, `FILE ${col + 1}`, { size: 13, weight: 800, fill: '#f5a97f', anchor: 'start' }) + text(128, 30, `${f.n}×`, { size: 14, weight: 700, fill: INK2, anchor: 'end' }) +
    lines(wrap(baseName(f.file), 12, 2), 72, 62, 20, { size: 16, weight: 650 }) +
    // one bar, split by added, changed and removed lines
    `<rect x="16" y="100" width="112" height="10" rx="5" fill="#ffffff" fill-opacity="0.08"/>` +
    `<rect x="16" y="100" width="${(w * f.add / tot).toFixed(1)}" height="10" fill="${GOOD}"/><rect x="${(16 + w * f.add / tot).toFixed(1)}" y="100" width="${(w * f.mod / tot).toFixed(1)}" height="10" fill="#f5b48a"/><rect x="${(16 + w * (f.add + f.mod) / tot).toFixed(1)}" y="100" width="${(w * f.del / tot).toFixed(1)}" height="10" fill="${BAD}"/>` +
    text(72, 134, `+${f.add} ~${f.mod} −${f.del}`, { size: 14, weight: 650, fill: INK2 }),
    { accent: '#f5a97f', glow: g, edge: 0.3 })
}

const backKey = g => key(
  `<path d="M42 74 L72 46 L102 74" fill="none" stroke="${INK}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><rect x="52" y="72" width="40" height="30" rx="4" fill="none" stroke="${INK}" stroke-width="8"/>` +
  text(72, 130, 'Back', { size: 16, weight: 600, fill: INK2 }),
  { accent: '#a9adbf', glow: g, edge: 0.25 })

// The question across the middle row, its answers along the bottom.
const askKey = (ask, col, row, g) => {
  const isPerm = ask.kind === 'permission'
  const accent = isPerm ? ASK_P : ASK_Q
  const pulse = 0.3 + 0.55 * breath(1100)
  const q = ask.questions?.[0]
  if (row === 1) {
    // the first key says what it is and whose; the words flow evenly over the other four
    const all = wrap(isPerm ? ask.title : q?.question ?? ask.title, 11, 16)
    const per = Math.max(1, Math.min(4, Math.ceil(all.length / 4)))
    const mine = col === 0 ? [] : all.slice((col - 1) * per, col * per)
    const size = per <= 2 ? 20 : per === 3 ? 18 : 16
    const step = size + 5
    const top = 72 - ((mine.length - 1) * step) / 2 + size / 3
    if (col === 0) {
      return key(text(72, 50, isPerm ? 'ALLOW?' : 'CLAUDE', { size: 20, weight: 800, fill: accent }) + (isPerm ? '' : text(72, 74, 'ASKS', { size: 20, weight: 800, fill: accent })) +
        lines(wrap(ask.chat, 12, 2), 72, 104, 17, { size: 13, weight: 400, fill: INK2 }), { accent, glow: Math.max(g, pulse), edge: 0.75 })
    }
    return key(lines(mine, 72, top, step, { size, weight: 650 }), { accent, glow: Math.max(g, pulse * 0.5), edge: 0.5 })
  }
  // row 2: the answers
  if (isPerm) {
    if (col === 0) return key(text(72, 76, '✓', { size: 54, weight: 800, fill: GOOD }) + text(72, 120, 'Allow', { size: 18, weight: 700 }), { accent: GOOD, glow: Math.max(g, pulse), edge: 0.7 })
    if (col === 1) return key(text(72, 76, '✗', { size: 54, weight: 800, fill: BAD }) + text(72, 120, 'Deny', { size: 18, weight: 700 }), { accent: BAD, glow: g, edge: 0.6 })
    if (col === 2) return key(lines(wrap(ask.detail || ask.title, 14, 5), 72, 34, 20, { size: 13, weight: 400, fill: INK2 }), { accent, glow: g, edge: 0.3, dim: true })
    if (col === 3) return key(text(72, 66, '⧉', { size: 34, fill: INK2 }) + text(72, 110, 'Usual', { size: 15, weight: 600, fill: INK2 }) + text(72, 128, 'dialog', { size: 15, weight: 600, fill: INK2 }), { accent: MUTED, glow: g, edge: 0.25 })
    return dashboardAnswerKey(accent, g)
  }
  const simple = q && ask.questions.length === 1 && !q.multiSelect && (q.kind ?? 'choice') === 'choice'
  if (simple && col < Math.min(4, q.options.length)) {
    const o = q.options[col]
    return key(text(26, 30, String(col + 1), { size: 16, weight: 800, fill: accent, anchor: 'start' }) + lines(wrap(o.label, 11, 3), 72, 64, 22, { size: 18, weight: 700 }), { accent, glow: Math.max(g, pulse * 0.7), edge: 0.65 })
  }
  if (col === 4 || (!simple && col === 0)) return dashboardAnswerKey(accent, g)
  if (col === 3 || (!simple && col === 1)) return key(text(72, 66, '⧉', { size: 34, fill: INK2 }) + text(72, 110, 'Usual', { size: 15, weight: 600, fill: INK2 }) + text(72, 128, 'dialog', { size: 15, weight: 600, fill: INK2 }), { accent: MUTED, glow: g, edge: 0.25 })
  return key('', { dim: true, edge: 0.1 })
}
const dashboardAnswerKey = (accent, g) => key(text(72, 64, '↗', { size: 38, weight: 700, fill: accent }) + text(72, 106, 'Answer in', { size: 14, weight: 600 }) + text(72, 124, 'dashboard', { size: 14, weight: 600 }), { accent, glow: g, edge: 0.4 })

// The key on the main page: Claude at a glance, a press away.
const openKey = () => {
  const list = chatsByRecent()
  const busy = list.filter(([, s]) => isBusy(s)).length
  const waiting = [...live.sessions.values()].reduce((n, s) => n + (s?.asks?.length ?? 0), 0)
  const done = Math.max(0, 1 - (Date.now() - flashAt) / 5000)
  const accent = waiting ? ASK_Q : done > 0 ? GOOD : busy ? '#8b9cff' : MUTED
  return key(
    `<rect x="36" y="26" width="72" height="54" rx="9" fill="none" stroke="${accent}" stroke-width="6"/><path d="M50 44 h22 M50 56 h34 M50 66 h16" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>` +
    text(72, 108, 'Live Code', { size: 17, weight: 700 }) +
    text(72, 130, !live.connected ? 'offline' : waiting ? `❓ ${waiting} waiting` : busy ? `${busy} working` : done > 0 ? '✓ done' : 'idle', { size: 14, weight: 500, fill: accent }),
    { accent, glow: waiting ? 0.3 + 0.6 * breath(1100) : done > 0 ? done : busy ? 0.15 + 0.2 * breath(2200) : 0, edge: 0.45 })
}

// ════════════════════════════════════════════════════════════════════════════
// the keys on the deck, and pressing them
// ════════════════════════════════════════════════════════════════════════════
const slots = new Map() // context -> { col, row, device }
const opens = new Map() // context -> { device }
const shown = new Map() // context -> the last image sent
let lastDevice = null

const setImage = (context, svg) => {
  if (shown.get(context) === svg) return
  shown.set(context, svg)
  sdSend({ event: 'setImage', context, payload: { image: 'data:image/svg+xml;charset=utf8,' + encodeURIComponent(svg), target: 0 } })
}
const paint = () => {
  for (const [context, s] of slots) { try { setImage(context, draw(s.col, s.row)) } catch (e) { log('draw', s.col, s.row, e.stack || e) } }
  for (const context of opens.keys()) { try { setImage(context, openKey()) } catch (e) { log('draw open', e.stack || e) } }
}

const openDashboard = () => {
  const { dashboard: lnk, server } = config()
  try {
    if (lnk && fs.existsSync(lnk)) spawn('cmd.exe', ['/c', 'start', '', lnk], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    else if (server) spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', path.join(path.dirname(server), 'start.ps1')], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } catch (e) { log('open dashboard', e.message) }
}
const flash = (id, text, color, sub, ms = 1600) => flashKey.set(id, { until: Date.now() + ms, text, color, sub })

const press = async (context, s, long) => {
  const sid = focusId()
  const snap = sid ? live.sessions.get(sid) : null
  const ask = pendingAsk()
  const { col, row } = s
  // the deck follows a chat, and so do open dashboards; held: opens the dashboard on it
  const follow = async entry => {
    if (!entry) return
    focus = entry[0]
    await post({ sid: entry[0], kind: 'view' })
    if (long) openDashboard()
  }

  // ── the chats folder ──
  if (page === 'chats' && !ask) {
    if (row === 0 && col === 4) { page = 'main'; return }
    const list = allChats()
    const pages = Math.max(1, Math.ceil(list.length / CHATS_PER_PAGE))
    if (row === 2 && col === 4 && pages > 1) { chatOffset = (chatOffset + 1) % pages; return }
    const slot = row * 5 + col - (row > 0 ? 1 : 0)
    const entry = list[chatOffset * CHATS_PER_PAGE + slot]
    if (!entry) return
    await follow(entry)
    page = 'main'
    return
  }
  // ── the More page ──
  if (page === 'more' && !ask) {
    if (row === 0 && col === 4) { page = 'main'; return }
    if (row === 2 && col === 4) { if (long) openWall(); else openDashboard(); return }
    if (sid) await post({ sid, kind: 'view' })
    return
  }

  // ⌂ Back: no profile named sends the deck back to the one shown before (the main page)
  if (row === 0 && col === 4) { log('back to the previous profile on', s.device); sdSend({ event: 'switchToProfile', context: PLUGIN_UUID, device: s.device, payload: {} }); return }
  if (row === 0 && col === 3) { page = 'chats'; chatOffset = 0; return }
  if (row === 0) { await follow(chatsByRecent()[col]); return }
  if (row === 2 && col === 4 && !ask) { page = 'more'; return }
  if (ask && row >= 1) {
    const answer = a => post({ sid: ask.sid, kind: 'answer', askId: ask.id, answer: a }).then(ok => { if (!ok) sdSend({ event: 'showAlert', context }) })
    if (row === 1) { openDashboard(); return }
    const isPerm = ask.kind === 'permission'
    const q = ask.questions?.[0]
    const simple = q && ask.questions.length === 1 && !q.multiSelect && (q.kind ?? 'choice') === 'choice'
    if (isPerm) {
      if (col === 0) return answer({ decision: 'allow' })
      if (col === 1) return answer({ decision: 'deny' })
      if (col === 3) return answer({ decision: 'dialog' })
      if (col === 4) return openDashboard()
      return
    }
    if (simple && col < Math.min(4, q.options.length)) return answer({ decision: 'answer', answers: { [q.question]: q.options[col].label } })
    if (col === 4 || (!simple && col === 0)) return openDashboard()
    if (col === 3 || (!simple && col === 1)) return answer({ decision: 'dialog' })
    return
  }
  if (row === 1) { if (long) openDashboard(); else if (sid) await post({ sid, kind: 'view' }); return }
  if (row === 2 && col <= 2) {
    const p = config().prompts?.[col]
    if (!p || !sid || !snap?.session?.canReceive) { sdSend({ event: 'showAlert', context }); return }
    const ok = await post({ sid, kind: 'prompt', text: p.text })
    if (ok) flash(`p${col}`, '✓ sent', GOOD, isBusy(snap) ? 'with the next step' : nameOf(snap).slice(0, 14))
    else { flash(`p${col}`, 'not sent', BAD, 'server?'); sdSend({ event: 'showAlert', context }) }
    return
  }
  if (row === 2 && col === 3) {
    if (!sid || !isBusy(snap)) return
    // two presses within three seconds: one stray press stops nothing
    if (Date.now() > stopArmedUntil) { stopArmedUntil = Date.now() + 3000; return }
    stopArmedUntil = 0
    const ok = await post({ sid, kind: 'stop' })
    sdSend({ event: ok ? 'showOk' : 'showAlert', context })
    return
  }
}
const openWall = () => {
  const key = live.key ?? readKey()
  try { spawn('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${key?.port ?? 4477}/wall`], { detached: true, stdio: 'ignore', windowsHide: true }).unref() } catch (e) { log('open wall', e.message) }
}

const onDeck = msg => {
  const { event, context, action, device, payload } = msg
  if (event === 'willAppear') {
    lastDevice = device
    shown.delete(context)
    if (action === SLOT) {
      const c = payload?.coordinates ?? { column: 0, row: 0 }
      slots.set(context, { col: c.column, row: c.row, device })
      sdSend({ event: 'setTitle', context, payload: { title: '', target: 0 } })
      syncAnswering()
    } else if (action === OPEN) opens.set(context, { device })
    paint()
  } else if (event === 'willDisappear') {
    slots.delete(context); opens.delete(context); shown.delete(context)
    syncAnswering()
  } else if (event === 'keyDown') {
    pressedAt.set(context, Date.now())
  } else if (event === 'keyUp') {
    const long = Date.now() - (pressedAt.get(context) ?? Date.now()) > 600
    pressedAt.delete(context)
    if (action === OPEN) { log('to the Live Code profile on', device); sdSend({ event: 'switchToProfile', context: PLUGIN_UUID, device, payload: { profile: PROFILE } }); return }
    const s = slots.get(context)
    if (s) press(context, s, long).catch(e => log('press', e.stack || e))
  } else if (event === 'deviceDidConnect') {
    lastDevice = device
  } else if (event === 'systemDidWakeUp') {
    shown.clear()
  }
}

// ── stuck: the same thing failing again and again, as the dashboard tells it ──
const errors = new Map() // sid -> recent failed actions
const watchStuck = () => {
  for (const [sid, s] of live.sessions) {
    const a = live.latest.get(sid)
    if (!a?.isDone) continue
    const list = errors.get(sid) ?? []
    if (list.at(-1)?.id === a.id) continue
    list.push({ id: a.id, isError: !!a.isError, at: Date.now() })
    while (list.length > 4) list.shift()
    errors.set(sid, list)
    if (isBusy(s) && list.length >= 3 && list.slice(-3).every(x => x.isError)) alarmed.set(sid, Date.now())
    if (!a.isError) alarmed.delete(sid)
  }
}

connectDeck()
connectLive()
// about 14 frames a second; only keys whose picture changed are sent
setInterval(() => { watchStuck(); paint() }, 70)
log('started', process.version)
