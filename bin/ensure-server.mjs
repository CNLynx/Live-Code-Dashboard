// Starts the dashboard server unless it already runs: the mod runs it when a
// chat starts, so the dashboard (and Hue, and the Stream Deck) works whenever
// Claude does. The server runs on, hidden and apart, after this exits.
//
// After an update of the mod the server of the old version is swapped for the
// new one, and where it is now is written down for the Stream Deck and the
// dashboard's shortcut (~/.claude/live-code-deck.json). The rest of the setup
// (bin/setup.mjs --auto) follows once per version.
//
//   node ensure-server.mjs [server.mjs]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = process.env.LIVE_CODE_HOME || path.join(os.homedir(), '.claude')
const port = Number(process.env.LIVE_CODE_PORT) || 4477
const BIN = path.dirname(fileURLToPath(import.meta.url))
const DECK_FILE = path.join(HOME, 'live-code-deck.json')

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return undefined } }
const deck = readJson(DECK_FILE) ?? {}
const here = path.join(BIN, '..', 'dashboard', 'server.mjs')
// a copy a session hot-reloads while the mod is worked on is not the one to keep
const isDevCopy = p => /[\\/]dev-mods[\\/]/i.test(p)
const usable = p => p && fs.existsSync(p)
const server = [process.argv[2], isDevCopy(here) && usable(deck.server) ? deck.server : here, deck.server].find(usable)
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

const get = p => new Promise(resolve => {
  const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 1500 }, res => {
    let d = ''
    res.on('data', c => { d += c })
    res.on('end', () => resolve(res.statusCode === 200 ? d : undefined))
  })
  req.on('error', () => resolve(undefined))
  req.on('timeout', () => { req.destroy(); resolve(undefined) })
})
const start = () => {
  // its own folder as the working one, so it holds no other folder open
  spawn(process.execPath, [server], { cwd: path.dirname(server), detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, LIVE_CODE_PORT: String(port) } }).unref()
}

if (server && !isDevCopy(server) && !same(deck.server, server)) {
  try { fs.writeFileSync(DECK_FILE, `${JSON.stringify({ ...deck, server, dashboard: usable(deck.dashboard) ? deck.dashboard : '' }, null, 2)}\n`) } catch {}
}

const about = await get('/about').then(d => { try { return JSON.parse(d) } catch { return undefined } })
if (await get('/health')) {
  // an older copy runs (a server from before /about, or another folder's): this one in its place
  if (server && about?.server && !same(about.server, server) && !isDevCopy(server)) {
    try { process.kill(about.pid) } catch {}
    await new Promise(r => setTimeout(r, 600))
    start()
    process.stdout.write(`restarted ${server}`)
  } else process.stdout.write('running')
} else if (!server) {
  process.stdout.write('no server found')
} else {
  start()
  process.stdout.write(`started ${server}`)
}

// once per version: shortcuts, WebView2, the Stream Deck plugin brought up to date
const version = readJson(path.join(BIN, '..', '.claude-plugin', 'plugin.json'))?.version
if (process.platform === 'win32' && !isDevCopy(BIN) && version && readJson(path.join(HOME, 'live-code-setup.json'))?.version !== version) {
  spawn(process.execPath, [path.join(BIN, 'setup.mjs'), '--auto'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}
