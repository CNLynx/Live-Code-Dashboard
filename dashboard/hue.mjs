// Philips Hue: the lights answer what the dashboard shows. A task done pulses
// them green, in the tone of the dashboard's done-glow; a question of Claude's
// turns them violet until it is answered. Afterwards each light goes back to
// what it was, and lights that were off stay off.
//
// ~/.claude/live-code-hue.json holds the bridge, the key the bridge gave this
// dashboard when its link button was pressed, and the lights to use.
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

const FILE = path.join(process.env.LIVE_CODE_HOME ?? path.join(os.homedir(), '.claude'), 'live-code-hue.json')
// what the settings can change, and its defaults
// (the colors are the dashboard's own: its done-glow mint, its question violet, its alarm red)
const DEFAULTS = { enabled: true, onDone: true, onAsk: true, onAlarm: true, doneColor: '#8cf0be', askColor: '#a78bfa', alarmColor: '#f87171', style: 'glow', pulses: 2 }
const readRaw = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return null } }
const readConfig = () => { const raw = readRaw(); return raw ? { ...DEFAULTS, ...raw } : null }
export const hueConfig = readConfig
const HEX = /^#[0-9a-f]{6}$/i
// Takes what the settings sent, each value checked, and keeps only that: what
// was never set follows the defaults.
export const setHueOptions = msg => {
  const raw = readRaw()
  if (!raw) return false
  const next = { ...raw }
  for (const k of ['enabled', 'onDone', 'onAsk', 'onAlarm']) if (typeof msg[k] === 'boolean') next[k] = msg[k]
  for (const k of ['doneColor', 'askColor', 'alarmColor']) if (typeof msg[k] === 'string' && HEX.test(msg[k])) next[k] = msg[k]
  if (Number.isInteger(msg.pulses) && msg.pulses >= 1 && msg.pulses <= 5) next.pulses = msg.pulses
  if (msg.style === 'glow' || msg.style === 'pulse') next.style = msg.style
  if (Array.isArray(msg.lights) && msg.lights.every(id => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id))) {
    next.lights = msg.lights
    next.lightNames = msg.lights.map(id => roomsCache?.flatMap(r => r.lights).find(l => l.id === id)?.name ?? id)
  }
  fs.writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`)
  return true
}

// The bridge's rooms with their lights, for the settings to pick from.
let roomsCache = null
export const hueRooms = async () => {
  const cfg = readConfig()
  if (!cfg?.appKey) return []
  const [rooms, lights, devices] = await Promise.all(['room', 'light', 'device'].map(r => call(cfg, 'GET', `/clip/v2/resource/${r}`)))
  if (!rooms?.data || !lights?.data || !devices?.data) return roomsCache ?? []
  const lightOf = new Map()
  for (const d of devices.data) for (const s of d.services) if (s.rtype === 'light') lightOf.set(d.id, s.rid)
  const seen = new Set()
  const out = rooms.data.map(r => ({
    name: r.metadata.name,
    lights: r.children.map(c => (c.rtype === 'device' ? lightOf.get(c.rid) : c.rtype === 'light' ? c.rid : null)).filter(Boolean).map(id => {
      seen.add(id)
      const l = lights.data.find(x => x.id === id)
      return l ? { id, name: l.metadata.name, color: !!l.color } : null
    }).filter(Boolean),
  })).filter(r => r.lights.length)
  const rest = lights.data.filter(l => !seen.has(l.id))
  if (rest.length) out.push({ name: 'Other', lights: rest.map(l => ({ id: l.id, name: l.metadata.name, color: !!l.color })) })
  roomsCache = out
  return out
}

const call = (cfg, method, p, body) => new Promise(resolve => {
  const data = body === undefined ? undefined : JSON.stringify(body)
  const req = https.request({
    host: cfg.bridge, path: p, method, rejectUnauthorized: false, timeout: 4000,
    headers: { 'hue-application-key': cfg.appKey, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
  }, res => { let d = ''; res.on('data', c => { d += c }); res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve(null) } }) })
  req.on('error', () => resolve(null))
  req.on('timeout', () => { req.destroy(); resolve(null) })
  req.end(data)
})
const put = (cfg, id, body) => call(cfg, 'PUT', `/clip/v2/resource/light/${id}`, body)
const sleep = ms => new Promise(r => setTimeout(r, ms))

// sRGB to the CIE xy a Hue light takes
const xyOf = hex => {
  const lin = c => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92 }
  const [r, g, b] = [1, 3, 5].map(i => lin(parseInt(hex.slice(i, i + 2), 16)))
  const X = r * 0.4124 + g * 0.3576 + b * 0.1805, Y = r * 0.2126 + g * 0.7152 + b * 0.0722, Z = r * 0.0193 + g * 0.1192 + b * 0.9505
  const sum = X + Y + Z || 1
  return { x: +(X / sum).toFixed(4), y: +(Y / sum).toFixed(4) }
}

// What a light was before it was taken over, to give it back.
const saved = new Map()
// just given back, and still fading there: read now, a light reports the fade
// half done, so the state given back stands for it a few seconds
const givenBack = new Map() // id -> { state, until }
const take = async cfg => {
  const ids = []
  for (const id of cfg.lights ?? []) {
    if (saved.has(id)) { ids.push(id); continue }
    const recent = givenBack.get(id)
    if (recent && recent.until > Date.now()) { saved.set(id, recent.state); ids.push(id); continue }
    const l = (await call(cfg, 'GET', `/clip/v2/resource/light/${id}`))?.data?.[0]
    if (!l?.on?.on) continue
    saved.set(id, {
      brightness: l.dimming?.brightness ?? 100,
      ...(l.color_temperature?.mirek_valid ? { mirek: l.color_temperature.mirek } : { xy: l.color?.xy }),
      ...(l.gradient?.points?.length ? { gradient: l.gradient.points } : {}),
    })
    ids.push(id)
  }
  return ids
}
const giveBack = async (cfg, ids, ms = 900) => {
  await Promise.all(ids.map(id => {
    const was = saved.get(id)
    saved.delete(id)
    if (!was) return null
    givenBack.set(id, { state: was, until: Date.now() + ms + 3000 })
    return put(cfg, id, {
      dimming: { brightness: was.brightness },
      ...(was.mirek ? { color_temperature: { mirek: was.mirek } } : was.xy ? { color: { xy: was.xy } } : {}),
      ...(was.gradient ? { gradient: { points: was.gradient } } : {}),
      dynamics: { duration: ms },
    })
  }))
}
// Each light keeps its own brightness, as it is set right now; a pulse dips it
// to a quarter of that and back.
const pulse = async (cfg, ids, xy, times) => {
  const level = id => saved.get(id)?.brightness ?? 60
  const each = (dim, ms) => Promise.all(ids.map(id => put(cfg, id, { color: { xy }, dimming: { brightness: Math.max(1, level(id) * dim) }, dynamics: { duration: ms } })))
  await each(1, 350)
  for (let i = 0; i < times; i++) {
    await sleep(500)
    await each(0.25, 350)
    await sleep(450)
    await each(1, 350)
  }
}
const sameLevel = (cfg, ids, xy, dim, ms) =>
  Promise.all(ids.map(id => put(cfg, id, { color: { xy }, dimming: { brightness: Math.max(1, (saved.get(id)?.brightness ?? 60) * dim) }, dynamics: { duration: ms } })))
// waits, but only while `still()` holds: a question answered ends its breathing at once
const sleepWhile = async (ms, still) => { for (const end = Date.now() + ms; Date.now() < end && still();) await sleep(100) }

// One effect at a time, in order.
let queue = Promise.resolve()
let asking = false
const run = job => { queue = queue.then(job).catch(() => {}); return queue }
const usable = () => { const cfg = readConfig(); return cfg?.enabled !== false && cfg?.appKey && cfg?.lights?.length ? cfg : null }

// A task is done. As the dashboard's done-glow (3 s): up to its color in a
// third of a second, then fading back to the light as it was over the rest.
// Or, set so, pulsed. While a question holds the lights, the question wins.
const doneEffect = async (force = false) => {
  const cfg = usable()
  if (!cfg || (!cfg.onDone && !force) || asking) return
  const ids = await take(cfg)
  if (ids.length === 0) return
  const xy = xyOf(cfg.doneColor)
  if (cfg.style === 'pulse') {
    await pulse(cfg, ids, xy, cfg.pulses)
    await sleep(700)
    await giveBack(cfg, ids)
    return
  }
  await sameLevel(cfg, ids, xy, 1, 360)
  await sleep(450)
  await giveBack(cfg, ids, 2600)
  await sleep(2600)
}
export const hueDone = () => run(() => doneEffect())

// As the dashboard's question popup: the color comes in, then breathes, a
// breath every 2.6 s, until `still()` ends.
const breathe = async (cfg, ids, xy, still) => {
  await sameLevel(cfg, ids, xy, 1, 400)
  await sleepWhile(500, still)
  while (still()) {
    await sameLevel(cfg, ids, xy, 0.4, 1300)
    await sleepWhile(1300, still)
    if (!still()) break
    await sameLevel(cfg, ids, xy, 1, 1300)
    await sleepWhile(1300, still)
  }
}

// How many of Claude's questions wait: from none to some, the lights take the
// question color and breathe until none waits; then they are given back.
export const hueAsks = count => {
  const want = count > 0
  if (want === asking) return queue
  asking = want
  if (!want) return queue // the breathing sees it, ends and gives the lights back
  return run(async () => {
    const cfg = usable()
    if (!cfg || !cfg.onAsk) return
    const ids = await take(cfg)
    if (!ids.length) return
    const xy = xyOf(cfg.askColor)
    if (cfg.style === 'pulse') {
      await pulse(cfg, ids, xy, cfg.pulses)
      await sleepWhile(24 * 3600e3, () => asking)
    } else {
      await breathe(cfg, ids, xy, () => asking)
    }
    await giveBack(cfg, ids, 900)
  })
}

// Claude seems stuck. As the dashboard's alarm: red, glowing up and down four
// times, 1.1 s each; then back. It wins over a question's breathing for its few seconds.
const alarmEffect = async (force = false) => {
  const cfg = usable()
  if (!cfg || (!cfg.onAlarm && !force)) return
  const ids = await take(cfg)
  if (!ids.length) return
  const xy = xyOf(cfg.alarmColor)
  await sameLevel(cfg, ids, xy, 0.5, 300)
  for (let i = 0; i < 4; i++) {
    await sameLevel(cfg, ids, xy, 1, 550)
    await sleep(550)
    await sameLevel(cfg, ids, xy, 0.5, 550)
    await sleep(550)
  }
  if (!asking) await giveBack(cfg, ids, 900)
}
// (a question's breathing holds the queue, so the alarm runs beside it)
export const hueAlarm = () => (asking ? alarmEffect() : run(() => alarmEffect()))

// to try each from the settings, switched on or not: a question breathes 6 s
export const hueTest = kind => run(async () => {
  if (kind === 'alarm') return alarmEffect(true)
  if (kind !== 'ask') return doneEffect(true)
  const cfg = usable()
  if (!cfg || asking) return
  const ids = await take(cfg)
  if (!ids.length) return
  const xy = xyOf(cfg.askColor)
  const until = Date.now() + 6000
  if (cfg.style === 'pulse') await pulse(cfg, ids, xy, cfg.pulses)
  else await breathe(cfg, ids, xy, () => Date.now() < until)
  await giveBack(cfg, ids, 900)
})

// ── pairing, from the settings ──
// The bridge is found in the home network (Philips' discovery service, then
// the address typed in, if any); then its round link button is pressed within
// 45 s, and it hands this dashboard a key of its own, kept in FILE.
const raw = (host, method, p, body) => new Promise(resolve => {
  const data = body === undefined ? undefined : JSON.stringify(body)
  const req = https.request({ host, path: p, method, rejectUnauthorized: false, timeout: 4000, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
    res => { let d = ''; res.on('data', c => { d += c }); res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve(null) } }) })
  req.on('error', () => resolve(null))
  req.on('timeout', () => { req.destroy(); resolve(null) })
  req.end(data)
})
const IP = /^\d{1,3}(\.\d{1,3}){3}$/
export const pairing = { state: 'idle', bridge: '', name: '', error: '' }
export const huePair = async typed => {
  if (pairing.state === 'searching' || pairing.state === 'press') return pairing
  Object.assign(pairing, { state: 'searching', bridge: '', name: '', error: '' })
  void (async () => {
    let hosts = typeof typed === 'string' && IP.test(typed.trim()) ? [typed.trim()] : []
    if (!hosts.length) {
      try { hosts = (await (await fetch('https://discovery.meethue.com/', { signal: AbortSignal.timeout(6000) })).json()).map(b => b.internalipaddress).filter(ip => IP.test(ip)) } catch {}
    }
    let bridge = ''
    for (const h of hosts) { const c = await raw(h, 'GET', '/api/config'); if (c?.bridgeid) { bridge = h; pairing.name = c.name ?? 'Hue Bridge'; break } }
    if (!bridge) { Object.assign(pairing, { state: 'failed', error: 'No Hue Bridge found. Type its address (Hue app → Settings → My Hue system → Bridge → IP).' }); return }
    Object.assign(pairing, { state: 'press', bridge })
    const until = Date.now() + 45_000
    while (Date.now() < until) {
      const r = await raw(bridge, 'POST', '/api', { devicetype: 'live-code#dashboard', generateclientkey: true })
      const ok = Array.isArray(r) ? r.find(x => x.success)?.success : null
      if (ok?.username) {
        const prev = readRaw() ?? {}
        fs.writeFileSync(FILE, `${JSON.stringify({ ...prev, bridge, bridgeName: pairing.name, appKey: ok.username }, null, 2)}\n`)
        roomsCache = null
        pairing.state = 'paired'
        return
      }
      await sleep(1500)
    }
    Object.assign(pairing, { state: 'failed', error: 'The link button was not pressed in time. Try again.' })
  })()
  return pairing
}

