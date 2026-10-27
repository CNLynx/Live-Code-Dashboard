// ── Blender, live ──
// A chat that runs Blender (blender.exe -b … --python …, as Claude does) is
// spotted by its command. Once the person switches "Blender live" on, a small
// startup script (bin/blender/live_code_blender.py) goes into that Blender's
// startup scripts; from then on every Blender run writes its visible meshes and
// the names of its renders to ~/.claude/live-code-blender, and the pages are
// told each time (type 'blender'). Off again: the script is taken away, the
// folder cleared. Nothing of it leaves this PC.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { showImage } from './images.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, '..', 'bin', 'blender', 'live_code_blender.py')
const SCRIPT_NAME = 'live_code_blender.py'
const IMAGE = /\.(png|jpe?g|webp|bmp|gif)$/i

let OUT = ''
let CFG = ''
let tell = () => {}
let cfg = { mode: '', spotted: [], installed: [] }
let info = null // the newest info.json

const readCfg = () => {
  try {
    const c = JSON.parse(fs.readFileSync(CFG, 'utf8'))
    cfg = { mode: ['on', 'off', 'never'].includes(c.mode) ? c.mode : '', spotted: Array.isArray(c.spotted) ? c.spotted.filter(s => typeof s === 'string') : [], installed: Array.isArray(c.installed) ? c.installed.filter(s => typeof s === 'string') : [] }
  } catch {}
}
const writeCfg = () => { try { fs.writeFileSync(CFG, `${JSON.stringify(cfg, null, 1)}\n`) } catch {} }

// Where a Blender keeps its startup scripts: beside it (<version>/scripts/startup,
// a portable one, or one the person may write to), else the person's own
// (%APPDATA%\Blender Foundation\Blender\<version>), which an installed one reads too.
const versionsOf = exe => { try { return fs.readdirSync(path.dirname(exe)).filter(d => /^\d+\.\d+$/.test(d)) } catch { return [] } }
const install = exe => {
  let ok = false
  for (const ver of versionsOf(exe)) {
    const targets = [path.join(path.dirname(exe), ver, 'scripts', 'startup')]
    if (process.env.APPDATA) targets.push(path.join(process.env.APPDATA, 'Blender Foundation', 'Blender', ver, 'scripts', 'startup'))
    for (const dir of targets) {
      try {
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, SCRIPT_NAME)
        fs.copyFileSync(SCRIPT, file)
        if (!cfg.installed.includes(file)) cfg.installed.push(file)
        ok = true
        break
      } catch {
        // (Program Files: not for us to write; the person's own folder then)
      }
    }
  }
  return ok
}
const uninstall = () => {
  for (const file of cfg.installed) { try { if (path.basename(file) === SCRIPT_NAME) fs.rmSync(file, { force: true }) } catch {} }
  cfg.installed = []
  try { fs.rmSync(OUT, { recursive: true, force: true }) } catch {}
  info = null
}
// a newer script (an update of Live Code) replaces the copies laid out before
const refresh = () => {
  let want = ''
  try { want = fs.readFileSync(SCRIPT, 'utf8') } catch { return }
  for (const file of cfg.installed) {
    try { if (fs.existsSync(path.dirname(file)) && fs.readFileSync(file, 'utf8') !== want) fs.writeFileSync(file, want) } catch {}
  }
}

export const blenderState = () => ({ mode: cfg.mode, spotted: cfg.spotted.length > 0, versions: [...new Set(cfg.spotted.flatMap(versionsOf))], info })

export const setBlenderMode = mode => {
  if (!['on', 'off', 'never'].includes(mode)) return false
  cfg.mode = mode
  if (mode === 'on') {
    fs.mkdirSync(OUT, { recursive: true })
    for (const exe of cfg.spotted) install(exe)
    watch()
  } else uninstall()
  writeCfg()
  tell(blenderState())
  return true
}

// ── spotting it in a command ──
// a path to blender.exe (quoted or not), or "blender" itself run with options
const EXE = /"([^"\n]*?blender\.exe)"|'([^'\n]*?blender\.exe)'|([A-Za-z]:[\\/][^\s"'|;&<>]*?blender\.exe)/gi
const BARE = /(?:^|[\s;&|(])blender(?:\.exe)?\s+(?:-|--)[a-zA-Z]/m
let whereAsked = 0
const spot = exe => {
  const file = path.resolve(exe)
  if (cfg.spotted.some(s => s.toLowerCase() === file.toLowerCase())) return
  if (!fs.existsSync(file)) return
  cfg.spotted.push(file)
  if (cfg.mode === 'on') { install(file); watch() }
  writeCfg()
  tell(blenderState())
}
export const spotBlender = text => {
  if (typeof text !== 'string' || !/blender/i.test(text)) return
  for (const m of text.matchAll(EXE)) spot(m[1] ?? m[2] ?? m[3])
  // just "blender": the one on the PATH (asked now and then, not with each command)
  if (BARE.test(text) && process.platform === 'win32' && Date.now() - whereAsked > 60_000) {
    whereAsked = Date.now()
    execFile('where.exe', ['blender'], { windowsHide: true, timeout: 4000, encoding: 'utf8' }, (error, out) => {
      if (!error) for (const line of String(out).split(/\r?\n/)) if (/blender\.exe$/i.test(line.trim())) spot(line.trim())
    })
  }
}

// ── what Blender wrote ──
// A render's file is only on disk a moment after Blender says it is done: the
// candidates it named are looked at again a few times; the one written goes to
// the images (images.mjs), which show each file once.
const resolve = raw => {
  let n = 0
  for (const r of Array.isArray(raw?.renders) ? raw.renders : []) {
    for (const c of Array.isArray(r.cands) ? r.cands : []) {
      if (typeof c !== 'string' || !IMAGE.test(c)) continue
      try { if (fs.statSync(c).mtimeMs >= (Number(r.at) || 0) - 2000) { showImage(c, 'render'); n++; break } } catch {}
    }
  }
  return n
}
let meshAt = 0
const reread = () => {
  let raw
  try { raw = JSON.parse(fs.readFileSync(path.join(OUT, 'info.json'), 'utf8')) } catch { return false }
  try { meshAt = fs.statSync(path.join(OUT, 'mesh.bin')).mtimeMs } catch {}
  const renders = resolve(raw)
  const next = { at: Number(raw.at) || 0, seq: raw.seq ?? 0, pid: raw.pid ?? 0, running: raw.running !== false, endedAt: raw.endedAt ?? null, blend: String(raw.blend ?? ''), version: String(raw.version ?? ''), objects: raw.objects ?? 0, tris: raw.tris ?? 0, cut: !!raw.cut, meshAt, renders }
  // (Blender ended without a word: not "working" any longer)
  if (next.running && next.pid) { try { process.kill(next.pid, 0) } catch { next.running = false } }
  const was = JSON.stringify(info)
  info = next
  if (JSON.stringify(info) !== was) tell(blenderState())
  return true
}
let watcher = null
let due = null
let again = []
const watch = () => {
  if (watcher || cfg.mode !== 'on') return
  try {
    fs.mkdirSync(OUT, { recursive: true })
    watcher = fs.watch(OUT, (_, name) => {
      if (name && !/^(info\.json|mesh\.bin)$/.test(name)) return
      clearTimeout(due)
      due = setTimeout(() => {
        reread()
        // (renders still on their way to the disk)
        for (const t of again) clearTimeout(t)
        again = [600, 1800, 4500].map(ms => setTimeout(reread, ms))
      }, 120)
    })
  } catch {}
}

export const blenderMesh = () => (cfg.mode === 'on' ? path.join(OUT, 'mesh.bin') : null)

export const initBlender = ({ home, broadcast }) => {
  OUT = path.join(home, 'live-code-blender')
  CFG = path.join(home, 'live-code-blender.json')
  tell = state => broadcast({ type: 'blender', blender: state })
  readCfg()
  if (cfg.mode === 'on') {
    refresh()
    watch()
    reread()
  }
}
