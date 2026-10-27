// ── what the chats see and make, for the Visual card ──
// Everything a chat does out of sight, as one list of items told to the pages
// (type 'image'; an item told again, `again`, has changed):
// - images written where it works (the folders it works in are watched, with
//   their subfolders), rendered by Blender (blender.mjs), sent to the person,
//   looked at, or shot by the browser; an image written anew keeps its earlier
//   version, for a before/after (`prevId`);
// - files it makes that are no images (a package, an export, a download);
// - from its transcript: web searches, pages read, each step in the browser
//   (a click with where it landed on the screenshot before it), commands run in
//   the background with their state and newest output lines;
// each with the prompt it belongs to and a few words on what it is for.
// Only what was told about may be fetched (/image?id=…), nothing else.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i
export const isImage = file => typeof file === 'string' && IMAGE.test(file)
// what counts as something made: packages, exports, documents, media
const PRODUCT = /\.(scs|zip|7z|rar|pdf|docx|xlsx|pptx|csv|exe|msi|apk|glb|gltf|fbx|obj|stl|blend|mp4|webm|mov|mp3|wav|ogg|svg|ttf|otf|streamDeckPlugin)$/i
const SKIP = /[\\/](?:node_modules|\.git|\.cache|@cache|__pycache__|\.next|dist[\\/]assets|\.wrangler)[\\/]|~\$|\.tmp$|\.crdownload$|\.part$/i
const MAX_BYTES = 40 * 1024 * 1024
const KEEP_BYTES = 8 * 1024 * 1024 // an image up to this size is kept as it was (for a before/after)
const KEPT_TOTAL = 160 * 1024 * 1024
const KEEP = 80
const WATCH_FOR_MS = 30 * 60_000 // a folder no chat worked in for this long is let go
const SETTLE_MS = 700 // a file still being written: looked at once it is still
const BURST = 8 // at most this many made in 10 s (an extraction of thousands is no show)

let tell = () => {}
let promptOf = () => null
const shown = [] // items, oldest first
let nextId = 1
const watchers = new Map() // dir -> { watcher, at, sid, how }
const pending = new Map() // file -> timer
let burst = []

const out = item => { const { file, data, key, outFile, ...rest } = item; return rest }
const recent = () => shown.filter(s => Date.now() - s.at < 20 * 60_000).map(out)
export const imagesState = () => recent()
// an image as it was when told about (its kept bytes), else its file
export const imageData = id => { const s = shown.find(x => x.id === id && x.img); return s ? { data: s.data ?? null, file: s.file } : null }
const add = item => {
  shown.push(item)
  while (shown.length > KEEP) shown.shift()
  // (the kept bytes stay within bounds: the oldest let go first)
  let total = 0
  for (let i = shown.length - 1; i >= 0; i--) { const s = shown[i]; if (!s.data) continue; total += s.data.length; if (total > KEPT_TOTAL) s.data = null }
  tell(out(item))
}
const again = (item, patch) => { Object.assign(item, patch); tell({ ...out(item), again: true }) }

// ── what it is for, and which prompt ──
// Per chat: the prompt it works on and the last thing it said (from the
// transcript), and the command it runs right now (server.mjs, setDoing).
const ctx = new Map() // sid -> { prompt: { text, at }, said, saidAt, doing, doingAt, command }
const ctxOf = sid => { let c = ctx.get(sid); if (!c) ctx.set(sid, (c = {})); return c }
export const setDoing = (sid, doing, command) => { if (!sid) return; const c = ctxOf(sid); c.doing = doing || ''; c.command = command || ''; c.doingAt = Date.now() }
const firstSentence = text => {
  const t = String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/[`*_#>|]/g, '').replace(/\s+/g, ' ').trim()
  const s = t.match(/^.{8,}?[.!?:](?=\s|$)/)?.[0] ?? t
  return s.length > 140 ? s.slice(0, 137) + '…' : s
}
const contextOf = (sid, kind) => {
  const c = ctxOf(sid)
  const prompt = c.prompt ?? promptOf(sid) ?? null
  // a file appeared: the command running then made it; else what was just said
  const why = kind === 'file' && c.doing && Date.now() - c.doingAt < 3 * 60_000 ? c.doing : c.said && Date.now() - (c.saidAt ?? 0) < 5 * 60_000 ? c.said : ''
  return { prompt: prompt ? { text: String(prompt.text ?? '').slice(0, 160), at: prompt.at ?? 0 } : null, why }
}

// Something seen without a picture of its own. Each one once (its key).
const eventsSeen = new Map() // key -> item
export const noteVisual = (key, how, name, sid, extra = {}) => {
  if (!key || eventsSeen.has(key) || typeof name !== 'string' || !name.trim()) return null
  const at = extra.at ?? Date.now()
  if (Date.now() - at > 15 * 60_000) { eventsSeen.set(key, null); return null }
  const item = { id: nextId++, key, file: null, name: name.trim().slice(0, 200), url: '', how, sid, img: false, ...contextOf(sid, how), ...extra, at }
  eventsSeen.set(key, item)
  add(item)
  return item
}
export const updateVisual = (key, patch) => {
  const item = eventsSeen.get(key)
  if (item && Object.entries(patch).some(([k, v]) => item[k] !== v)) again(item, patch)
}

// One image to show. The same file, unchanged, only once; changed, the earlier
// one stays (with its bytes, if kept) as the "before" of the new one.
export const showImage = (file, how, sid = null, extra = {}) => {
  if (typeof file !== 'string' || !IMAGE.test(file)) return null
  let st
  try { st = fs.statSync(file) } catch { return null }
  if (!st.isFile() || st.size === 0 || st.size > MAX_BYTES) return null
  let known = null
  for (let i = shown.length - 1; i >= 0 && !known; i--) if (shown[i].file && shown[i].img && shown[i].file.toLowerCase() === file.toLowerCase()) known = shown[i]
  if (known && known.mtime === st.mtimeMs) {
    // (sent or framed after it was made: said so, not shown twice)
    const patch = {}
    if (how === 'sent' && known.how !== 'sent') patch.how = 'sent'
    if (extra.fw && !known.fw) Object.assign(patch, { fw: extra.fw, fh: extra.fh })
    if (Object.keys(patch).length) again(known, patch)
    return known
  }
  if (how === 'made') {
    burst = burst.filter(t => Date.now() - t < 10_000)
    if (burst.length >= BURST) return null
    burst.push(Date.now())
  }
  let data = null
  if (st.size <= KEEP_BYTES) { try { data = fs.readFileSync(file) } catch {} }
  const item = { id: nextId++, file, data, name: path.basename(file), at: Date.now(), how, sid, size: st.size, mtime: st.mtimeMs, img: true, ...contextOf(sid, how === 'browser' ? 'browser' : 'file'), ...extra }
  // its earlier version, when its bytes were kept: before and after
  if (known?.data) item.prevId = known.id
  add(item)
  return item
}
// a file made that is no image: a card with its name, size and folder
const showFile = (file, sid) => {
  let st
  try { st = fs.statSync(file) } catch { return }
  if (!st.isFile() || st.size === 0) return
  const key = `file:${file.toLowerCase()}:${st.mtimeMs}`
  if (eventsSeen.has(key)) return
  burst = burst.filter(t => Date.now() - t < 10_000)
  if (burst.length >= BURST) return
  burst.push(Date.now())
  const c = ctxOf(sid)
  const download = /\b(curl|wget|iwr|Invoke-WebRequest|Start-BitsTransfer|DownloadFile|gh\s+release\s+download)\b/i.test(c.command ?? '') && Date.now() - (c.doingAt ?? 0) < 3 * 60_000
  noteVisual(key, download ? 'download' : 'file', path.basename(file), sid, { size: st.size, dir: path.dirname(file), file })
}

// folders too wide to watch: a drive, the user's home, the temp folder itself
const tooWide = dir => {
  const d = path.resolve(dir).toLowerCase().replace(/[\\/]+$/, '')
  if (/^[a-z]:$/.test(d) || d === '') return true
  return [os.homedir(), os.tmpdir(), process.env.SystemRoot ?? 'C:\\Windows', process.env.ProgramFiles ?? 'C:\\Program Files'].some(w => w && d === path.resolve(w).toLowerCase())
}
const covered = dir => {
  const d = path.resolve(dir).toLowerCase() + path.sep
  for (const w of watchers.keys()) if (d.startsWith(w.toLowerCase() + path.sep)) return true
  return false
}
// The folders the active chats work in now (server.mjs dirsOf): each watched
// with its subfolders, unless a folder above it already is.
export const watchImageDirs = (dirs, sid, how = 'made') => {
  for (const raw of dirs) {
    if (typeof raw !== 'string' || !path.isAbsolute(raw)) continue
    const dir = path.resolve(raw)
    const w = watchers.get(dir)
    if (w) { w.at = Date.now(); w.sid = sid; continue }
    if (tooWide(dir) || covered(dir)) { for (const [d, x] of watchers) if ((dir.toLowerCase() + path.sep).startsWith(d.toLowerCase() + path.sep)) { x.at = Date.now(); x.sid = sid } continue }
    try { if (!fs.statSync(dir).isDirectory()) continue } catch { continue }
    try {
      const entry = { at: Date.now(), sid, how, watcher: null }
      entry.watcher = fs.watch(dir, { recursive: true }, (_, name) => {
        if (!name) return
        const image = IMAGE.test(name)
        // (the browser's folder: its shots only)
        if (!image && (how !== 'made' || !PRODUCT.test(name))) return
        const file = path.join(dir, name)
        if (SKIP.test(file)) return
        clearTimeout(pending.get(file))
        pending.set(file, setTimeout(() => {
          pending.delete(file)
          // (written or copied here just now, not merely looked at)
          try { const st = fs.statSync(file); if (Date.now() - Math.max(st.mtimeMs, st.birthtimeMs || 0) > 15_000) return } catch { return }
          if (image) showImage(file, entry.how, entry.sid)
          else showFile(file, entry.sid)
        }, SETTLE_MS))
      })
      entry.watcher.on('error', () => { try { entry.watcher.close() } catch {} watchers.delete(dir) })
      watchers.set(dir, entry)
      // a folder below it watched on its own until now: this one covers it
      for (const [d, x] of [...watchers]) if (d !== dir && (d.toLowerCase() + path.sep).startsWith(dir.toLowerCase() + path.sep)) { try { x.watcher.close() } catch {} watchers.delete(d) }
    } catch {}
  }
}
setInterval(() => {
  for (const [d, x] of watchers) if (Date.now() - x.at > WATCH_FOR_MS) { try { x.watcher.close() } catch {} watchers.delete(d) }
}, 60_000).unref()

// ── commands in the background: their newest output lines ──
const tailLines = (file, n) => {
  try {
    const size = fs.statSync(file).size
    const len = Math.min(size, 4096)
    const buf = Buffer.alloc(len)
    const fd = fs.openSync(file, 'r')
    fs.readSync(fd, buf, 0, len, size - len)
    fs.closeSync(fd)
    return buf.toString('utf8').split(/\r?\n/).map(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean).slice(-n).map(l => l.slice(0, 160))
  } catch { return null }
}
setInterval(() => {
  for (const item of eventsSeen.values()) {
    if (!item || item.how !== 'bg' || item.status !== 'running' || !item.outFile) continue
    const lines = tailLines(item.outFile, 3)
    if (lines && lines.join('\n') !== (item.lines ?? []).join('\n')) again(item, { lines })
    // (no word after an hour: let go)
    if (Date.now() - item.at > 60 * 60_000) again(item, { status: 'unknown' })
  }
}, 1500).unref()

// ── the transcript ──
// Read as it grows (server.mjs), oldest line first, so a click finds the
// screenshot taken before it. Each tool call once.
const BROWSER = /(?:Claude_Browser|claude-in-chrome)__(\w+)$/
const host = url => { try { return new URL(url).host } catch { return String(url ?? '') } }
const lastShot = new Map() // sid -> image item
const pendingBg = new Map() // tool_use id -> { name, command }
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
// one step in the browser (a click, a key, typing, scrolling, a form field)
const browserStep = (key, tool, input, sid, at) => {
  const a = input.action
  const shot = lastShot.get(sid)
  const where = Array.isArray(input.coordinate) && shot?.fw ? { shotId: shot.id, x: input.coordinate[0] / shot.fw, y: input.coordinate[1] / shot.fh } : shot ? { shotId: shot.id } : {}
  const said = typeof input.action_summary === 'string' ? input.action_summary : ''
  if (tool === 'computer' && /^(left|right|double|triple)_click$/.test(a)) noteVisual(key, 'click', said || `${a.replace('_', ' ')}`, sid, { at, ...where })
  else if (tool === 'computer' && a === 'type') noteVisual(key, 'type', said || `Types “${clip(input.text, 60)}”`, sid, { at, typed: clip(input.text, 80), ...where })
  else if (tool === 'computer' && a === 'key') noteVisual(key, 'key', said || `Presses ${clip(input.text, 40)}`, sid, { at, ...where })
  else if (tool === 'computer' && a === 'scroll') noteVisual(key, 'scroll', `Scrolls ${input.scroll_direction ?? ''}`.trim(), sid, { at, ...where })
  else if (tool === 'computer' && a === 'left_click_drag') noteVisual(key, 'click', said || 'Drags', sid, { at, ...where })
  else if (tool === 'form_input') noteVisual(key, 'type', said || `Fills in “${clip(input.value, 60)}”`, sid, { at, ...(shot ? { shotId: shot.id } : {}) })
  else if (tool === 'navigate' && typeof input.url === 'string' && !/^(back|forward)$/.test(input.url)) noteVisual(key, 'browse', host(/^\w+:/.test(input.url) ? input.url : `https://${input.url}`), sid, { at, url: input.url })
  else if (tool === 'preview_start' && typeof input.url === 'string') noteVisual(key, 'browse', host(input.url), sid, { at, url: input.url })
  else if (tool === 'preview_start' && typeof input.name === 'string') noteVisual(key, 'server', `Starts ${input.name}`, sid, { at })
}
const toolUse = (c, entry, sid, at) => {
  const input = c.input ?? {}
  const m = BROWSER.exec(c.name ?? '')
  if (c.name === 'SendUserFile') {
    const cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
    for (const f of Array.isArray(input.files) ? input.files : []) {
      if (typeof f !== 'string') continue
      const file = path.isAbsolute(f) ? f : path.resolve(cwd, f)
      if (isImage(file)) showImage(file, 'sent', sid)
      else noteVisual(`sent:${c.id}:${file}`, 'sent', path.basename(file), sid, { at, dir: path.dirname(file) })
    }
  } else if (c.name === 'WebSearch' && typeof input.query === 'string') noteVisual(c.id, 'search', input.query, sid, { at })
  else if (c.name === 'WebFetch' && typeof input.url === 'string') noteVisual(c.id, 'web', host(input.url), sid, { at, url: input.url })
  else if (m && m[1] === 'browser_batch' && Array.isArray(input.actions)) input.actions.forEach((s, i) => browserStep(`${c.id}:${i}`, s?.name ?? '', s?.input ?? {}, sid, at))
  else if (m) browserStep(c.id, m[1], input, sid, at)
  else if (input.run_in_background === true) pendingBg.set(c.id, { name: input.description || clip(input.command, 70) || c.name, command: clip(input.command, 300) })
}
const toolResult = (c, entry, sid, at) => {
  // a command sent to the background: from now on its state and output
  const bg = pendingBg.get(c.tool_use_id)
  const text = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.filter(x => x?.type === 'text').map(x => x.text).join('\n') : ''
  if (bg) {
    pendingBg.delete(c.tool_use_id)
    const outFile = /Output is being written to: (.+?\.output)/.exec(text)?.[1]
    noteVisual(c.tool_use_id, 'bg', bg.name, sid, { at, status: 'running', command: bg.command, outFile, lines: [] })
  }
  // a browser shot: the frame its clicks are measured in
  if (!Array.isArray(c.content)) return
  const frame = /coordinate frame: (\d+)x(\d+)/.exec(text) ?? /Screenshot size: (\d+)x(\d+)/.exec(text)
  for (const m of text.matchAll(/\[Image: source: ([^\]\n]+?\.(?:png|jpe?g|webp))\]/gi)) {
    const shot = showImage(m[1], 'browser', sid, { at, ...(frame ? { fw: Number(frame[1]), fh: Number(frame[2]) } : {}) })
    if (shot) lastShot.set(sid, shot)
  }
}
const NOTE = /<task-notification>[\s\S]*?<tool-use-id>([^<]+)<\/tool-use-id>[\s\S]*?<status>([^<]+)<\/status>(?:[\s\S]*?<summary>([^<]*)<\/summary>)?/g
export const visualsIn = (text, sid) => {
  for (let line of text.split('\n')) {
    if (line.length < 20) continue
    // (a writer that spells < and > as < and >)
    if (line.includes('\\u003ctask-notification')) line = line.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>')
    // (a background command done: its state; this line needs no reading as JSON)
    if (line.includes('<task-notification>')) for (const m of line.replace(/\\n/g, '\n').replace(/\\"/g, '"').matchAll(NOTE)) updateVisual(m[1], { status: /complet/i.test(m[2]) ? (/exit code [1-9]/.test(m[3] ?? '') ? 'failed' : 'done') : m[2], summary: m[3] ?? '' })
    if (!/"type":"(?:assistant|user)"/.test(line)) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    const at = Date.parse(entry.timestamp ?? '') || Date.now()
    const content = entry.message?.content
    const c0 = ctxOf(sid)
    // the person's prompt (no tool result, no note of the app's own)
    if (entry.type === 'user' && !entry.isMeta && !entry.isSidechain) {
      const said = typeof content === 'string' ? content : Array.isArray(content) && !content.some(x => x?.type === 'tool_result') ? content.filter(x => x?.type === 'text').map(x => x.text).join(' ') : ''
      if (said && !/^\s*</.test(said)) { c0.prompt = { text: clip(said, 160), at }; c0.said = ''; continue }
    }
    if (!Array.isArray(content) || Date.now() - at > 10 * 60_000) continue
    for (const c of content) {
      if (entry.type === 'assistant' && c?.type === 'text' && c.text?.trim()) { c0.said = firstSentence(c.text); c0.saidAt = at }
      else if (c?.type === 'tool_use') toolUse(c, entry, sid, at)
      else if (c?.type === 'tool_result') toolResult(c, entry, sid, at)
    }
  }
}

export const initImages = ({ broadcast, prompt }) => {
  tell = image => broadcast({ type: 'image', image })
  if (typeof prompt === 'function') promptOf = prompt
}
