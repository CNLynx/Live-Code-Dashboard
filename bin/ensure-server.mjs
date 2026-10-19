// Starts the dashboard server unless it already runs: the mod runs it when a
// chat starts, so the dashboard (and Hue, and the Stream Deck) works whenever
// Claude does. The server runs on, hidden and apart, after this exits.
//
// After an update of the mod the server of the old version is swapped for the
// new one, and where it is now is written down for the Stream Deck and the
// dashboard's shortcut (~/.claude/live-code-deck.json). The rest of the setup
// (bin/setup.mjs --auto) follows once per version.
//
//   node ensure-server.mjs [server.mjs] [--session=<id>]
import { execFileSync, spawn } from 'node:child_process'
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
// what each start decided, the newest 60 lines, for finding out why the dashboard did (not) open
const LOG = path.join(HOME, 'live-code-ensure.log')
const log = line => {
  try {
    const old = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).slice(-59) : []
    fs.writeFileSync(LOG, [...old, `${new Date().toISOString()} ${line}`].join('\n') + '\n')
  } catch {}
}
// PowerShell by its full path: a process started by Claude may not have it on its PATH
const POWERSHELL = process.platform === 'win32' ? path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell'
// Claude ends what a chat's helper started once the helper is done, detached or
// not (on Windows its processes share a job): so the server and the window are
// started by Windows itself (WMI), apart from Claude, hidden. true: started.
const startApart = commandLine => {
  try {
    const out = execFileSync(POWERSHELL, ['-NoProfile', '-Command',
      `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; ` +
      `(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}'; ProcessStartupInformation = $si }).ReturnValue`],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim()
    if (out !== '0') log(`not started apart (${out}): ${commandLine.slice(0, 120)}`)
    return out === '0'
  } catch (e) {
    log(`not started apart: ${String(e?.message ?? e).split('\n')[0]}`)
    return false
  }
}
const deck = readJson(DECK_FILE) ?? {}
const here = path.join(BIN, '..', 'dashboard', 'server.mjs')
// a copy a session hot-reloads while the mod is worked on is not the one to keep
const isDevCopy = p => /[\\/]dev-mods[\\/]/i.test(p)
const usable = p => p && fs.existsSync(p)
const args = process.argv.slice(2)
const sessionId = args.find(a => a.startsWith('--session='))?.slice(10) ?? ''
// A developer's working copy (a git checkout of the mod, as new as this copy or
// newer) keeps serving: Claude runs the copy in its plugin cache, but the pages
// should come from the folder being worked on, so a change shows at once.
const versionAt = serverFile => readJson(path.join(path.dirname(serverFile), '..', '.claude-plugin', 'plugin.json'))?.version ?? ''
const atLeast = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return true }
const isWorkingCopy = p => usable(p) && fs.existsSync(path.join(path.dirname(p), '..', '.git')) && atLeast(versionAt(p), versionAt(here))
const server = [args.find(a => !a.startsWith('--')), (isDevCopy(here) || isWorkingCopy(deck.server)) && usable(deck.server) ? deck.server : here, deck.server].find(usable)
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
  // (on Windows apart from Claude, see startApart; on the usual port, which needs no setting)
  if (process.platform === 'win32' && port === 4477 && startApart(`"${process.execPath}" "${server}"`)) return
  // its own folder as the working one, so it holds no other folder open
  spawn(process.execPath, [server], { cwd: path.dirname(server), detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, LIVE_CODE_PORT: String(port) } }).unref()
}

log(`ran | session ${sessionId.slice(0, 8) || '?'}`)
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

// Claude starting: the dashboard opens, unless switched off in its settings or
// already open (that one stays where it is). The Claude app starts its chats
// only as they are opened, maybe long after the app itself: so the first chat
// after each start of the app opens it, once; closed by hand, it stays closed
// for the rest of that run. Without the app (Claude in a terminal): when no
// other chat was busy in the last 5 minutes (this chat's own file, written as
// it starts, does not count).
const prefs = readJson(path.join(HOME, 'live-code-prefs.json')) ?? {}
const OPENED_FILE = path.join(HOME, 'live-code-opened.json')
// when the Claude app (not a Claude Code process) started, as a number; 0: not running
const appStartedAt = () => {
  try {
    const out = execFileSync(POWERSHELL, ['-NoProfile', '-Command',
      "$p = Get-Process -Name Claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -notmatch 'claude-code' } | Sort-Object StartTime | Select-Object -First 1; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }"],
    { encoding: 'utf8', windowsHide: true, timeout: 6000 }).trim()
    return Date.parse(out) || 0
  } catch (e) { log(`app start not read: ${String(e?.message ?? e).split('\n')[0]}`); return 0 }
}
const othersBusy = () => {
  try {
    const own = sessionId.replace(/[^A-Za-z0-9_-]/g, '')
    return fs.readdirSync(HOME)
      .filter(n => /^live-code-session-.+\.json$/.test(n) && !(own && n === `live-code-session-${own}.json`))
      .some(n => Date.now() - fs.statSync(path.join(HOME, n)).mtimeMs < 5 * 60_000)
  } catch { return false }
}
if (process.platform === 'win32' && server && prefs['lc.openWithClaude'] !== 'off' && !isDevCopy(BIN)) {
  const app = appStartedAt()
  // (in seconds, give or take two: the start time Windows reports can differ a little between reads)
  const run = app ? Math.floor(app / 1000) : 0
  const opened = readJson(OPENED_FILE)?.appRun
  const due = run ? !(typeof opened === 'number' && Math.abs(opened - run) <= 2) : !othersBusy()
  log(`session ${sessionId.slice(0, 8) || '?'} | app run ${run || 'none'} | opened for ${opened ?? 'none'} | ${due ? 'opens' : 'stays'}`)
  if (due) {
    if (run) { try { fs.writeFileSync(OPENED_FILE, `${JSON.stringify({ appRun: run, at: Date.now() })}\n`) } catch {} }
    const script = path.join(path.dirname(server), 'start.ps1')
    if (startApart(`"${POWERSHELL}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}" -IfClosed`)) log('window asked for, apart from Claude')
    else {
      const child = spawn(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-IfClosed'], { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', e => log(`start.ps1 not started: ${e.message}`))
      child.unref()
    }
  }
} else log(`not opened: ${process.platform !== 'win32' ? 'not Windows' : !server ? 'no server' : prefs['lc.openWithClaude'] === 'off' ? 'switched off' : 'dev copy'}`)

// once per version: shortcuts, WebView2, the Stream Deck plugin brought up to date
const version = readJson(path.join(BIN, '..', '.claude-plugin', 'plugin.json'))?.version
if (process.platform === 'win32' && !isDevCopy(BIN) && version && readJson(path.join(HOME, 'live-code-setup.json'))?.version !== version) {
  spawn(process.execPath, [path.join(BIN, 'setup.mjs'), '--auto'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}
