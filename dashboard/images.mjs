// ── images, as they are made or sent ──
// The folders the chats work in are watched (with their subfolders) while a
// chat was active there lately: an image written there (a render, a texture a
// script painted, a screenshot) is told to the pages (type 'image'), as is one
// Claude sends the person (SendUserFile, read from the chat's transcript) and a
// Blender render (blender.mjs). The page builds it up in its preview window.
// Only the files told about may be fetched (/image?id=…), nothing else.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i
export const isImage = file => typeof file === 'string' && IMAGE.test(file)
const SKIP = /[\\/](?:node_modules|\.git|\.cache|@cache|__pycache__|\.next|dist[\\/]assets|\.wrangler)[\\/]/i
const MAX_BYTES = 40 * 1024 * 1024
const KEEP = 40
const WATCH_FOR_MS = 30 * 60_000 // a folder no chat worked in for this long is let go
const SETTLE_MS = 700 // a file still being written: looked at once it is still
const BURST = 8 // at most this many images in 10 s (an extraction of thousands is no show)

let tell = () => {}
const shown = [] // { id, file, name, at, how, sid, size, mtime }
let nextId = 1
const watchers = new Map() // dir -> { watcher, at }
const pending = new Map() // file -> timer
let burst = []

const recent = () => shown.filter(s => Date.now() - s.at < 15 * 60_000).map(({ file, ...s }) => s)
export const imagesState = () => recent()
export const imageFile = id => shown.find(s => s.id === id)?.file ?? null

// Something seen without a picture of its own: a web search, a page fetched,
// the browser sent somewhere. Each tool call once (its id).
const eventsSeen = new Set()
export const noteVisual = (key, how, name, url, sid, at = Date.now()) => {
  if (!key || eventsSeen.has(key) || typeof name !== 'string' || !name.trim()) return
  eventsSeen.add(key)
  if (Date.now() - at > 15 * 60_000) return
  const item = { id: nextId++, file: null, name: name.trim().slice(0, 200), url: typeof url === 'string' ? url.slice(0, 500) : '', at, how, sid, img: false }
  shown.push(item)
  while (shown.length > KEEP) shown.shift()
  const { file: _, ...out } = item
  tell(out)
}

// One image to show. The same file, unchanged, only once.
export const showImage = (file, how, sid = null) => {
  if (typeof file !== 'string' || !IMAGE.test(file)) return
  let st
  try { st = fs.statSync(file) } catch { return }
  if (!st.isFile() || st.size === 0 || st.size > MAX_BYTES) return
  const known = shown.find(s => s.file && s.file.toLowerCase() === file.toLowerCase())
  if (known && known.mtime === st.mtimeMs) {
    // (sent after it was made: said so, not shown twice)
    if (how === 'sent' && known.how !== 'sent') { known.how = 'sent'; tell({ ...known, file: undefined, again: true }) }
    return
  }
  if (how === 'made') {
    burst = burst.filter(t => Date.now() - t < 10_000)
    if (burst.length >= BURST) return
    burst.push(Date.now())
  }
  const item = { id: nextId++, file, name: path.basename(file), at: Date.now(), how, sid, size: st.size, mtime: st.mtimeMs, img: true }
  if (known) shown.splice(shown.indexOf(known), 1)
  shown.push(item)
  while (shown.length > KEEP) shown.shift()
  const { file: _, ...out } = item
  tell(out)
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
        if (!name || !IMAGE.test(name)) return
        const file = path.join(dir, name)
        if (SKIP.test(file)) return
        clearTimeout(pending.get(file))
        pending.set(file, setTimeout(() => {
          pending.delete(file)
          // (written or copied here just now, not merely looked at)
          try { const st = fs.statSync(file); if (Date.now() - Math.max(st.mtimeMs, st.birthtimeMs || 0) > 15_000) return } catch { return }
          showImage(file, entry.how, entry.sid)
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

// What a chat looked at and showed, from its transcript (the newest part of
// it, as read for the prompts), each tool call once: files sent to the person
// (SendUserFile), web searches, pages fetched, the browser sent to a page.
const sentSeen = new Set()
const BROWSE = /(?:Claude_Browser|claude-in-chrome)__(?:navigate|preview_start)$/
const host = url => { try { return new URL(url).host } catch { return String(url ?? '') } }
export const visualsIn = (text, sid) => {
  if (!/"(?:SendUserFile|WebSearch|WebFetch|mcp__[^"]*?(?:navigate|preview_start))"/.test(text)) return
  for (const line of text.split('\n')) {
    if (!line.includes('"tool_use"')) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    const at = Date.parse(entry.timestamp ?? '') || 0
    if (Date.now() - at > 10 * 60_000) continue
    for (const c of entry.message?.content ?? []) {
      if (c?.type !== 'tool_use' || sentSeen.has(c.id)) continue
      const input = c.input ?? {}
      if (c.name === 'SendUserFile') {
        sentSeen.add(c.id)
        const cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
        for (const f of Array.isArray(input.files) ? input.files : []) {
          if (typeof f === 'string') showImage(path.isAbsolute(f) ? f : path.resolve(cwd, f), 'sent', sid)
        }
      } else if (c.name === 'WebSearch' && typeof input.query === 'string') {
        sentSeen.add(c.id); noteVisual(c.id, 'search', input.query, '', sid, at)
      } else if (c.name === 'WebFetch' && typeof input.url === 'string') {
        sentSeen.add(c.id); noteVisual(c.id, 'web', host(input.url), input.url, sid, at)
      } else if (BROWSE.test(c.name ?? '') && typeof input.url === 'string' && /^(https?:|file:|[\w.-]+\.\w)/.test(input.url)) {
        sentSeen.add(c.id); noteVisual(c.id, 'browse', host(/^\w+:/.test(input.url) ? input.url : `https://${input.url}`), input.url, sid, at)
      }
    }
  }
}

export const initImages = ({ broadcast }) => {
  tell = image => broadcast({ type: 'image', image })
}
