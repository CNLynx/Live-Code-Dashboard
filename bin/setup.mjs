// Sets Live Code up on this PC, the one-click part after the mod is installed:
//   - the "Live Code Dashboard" shortcut in the Start menu (and on the desktop),
//     through a launcher that stays put while updates of the mod move it;
//   - WebView2's files for the frameless tile windows (webview2.mjs);
//   - the Stream Deck plugin, where the Stream Deck app is installed;
//   - the dashboard opened.
//
//   node setup.mjs           all of it (install.ps1, /live-code-setup)
//   node setup.mjs --auto    what an update needs, quietly (ensure-server.mjs, once per version):
//                            the shortcut's launcher, WebView2, the Stream Deck plugin only where it is installed and older
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const AUTO = process.argv.includes('--auto')
const BIN = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(BIN, '..')
const DASH = path.join(ROOT, 'dashboard')
const HOME = process.env.LIVE_CODE_HOME || path.join(os.homedir(), '.claude')
const LOCAL = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'live-code-dashboard')
const DECK_FILE = path.join(HOME, 'live-code-deck.json')
const say = (...a) => { if (!AUTO) console.log(...a) }
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) } catch { return undefined } }
const ps = script => new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true }, (e, out) => resolve(e ? undefined : String(out).trim())))
const version = readJson(path.join(ROOT, '.claude-plugin', 'plugin.json'))?.version ?? ''

if (process.platform !== 'win32') { say('The dashboard runs anywhere at http://127.0.0.1:4477; this setup (shortcuts, Stream Deck, tile windows) is for Windows.'); process.exit(0) }
fs.mkdirSync(LOCAL, { recursive: true })

// ── where the server is now, for the launcher and the Stream Deck ──
const deck = readJson(DECK_FILE) ?? {}
const server = path.join(DASH, 'server.mjs')
if (!/[\\/]dev-mods[\\/]/i.test(server)) fs.writeFileSync(DECK_FILE, `${JSON.stringify({ ...deck, server }, null, 2)}\n`)

// ── the launcher and its shortcuts ──
// The shortcut points at a launcher in %LOCALAPPDATA% that reads where the
// server is: so it, and a taskbar pin made of it, keep working after updates.
const launcher = path.join(LOCAL, 'open-dashboard.ps1')
fs.writeFileSync(launcher, `# Opens the Live Code dashboard, wherever the mod is now (written by the mod's setup)
$deck = Get-Content (Join-Path $env:USERPROFILE '.claude\\live-code-deck.json') -Raw | ConvertFrom-Json
& (Join-Path (Split-Path -Parent $deck.server) 'start.ps1') @args
`)
// the shortcut's icon: a Windows .ico made here from the PNGs (each size kept as PNG inside)
const ico = sizes => {
  const pngs = sizes.map(s => fs.readFileSync(path.join(DASH, 'icons', `diff-${s}.png`)))
  const head = Buffer.alloc(6 + 16 * pngs.length)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(pngs.length, 4)
  let offset = head.length
  pngs.forEach((png, i) => {
    const e = 6 + 16 * i, s = sizes[i]
    head[e] = s >= 256 ? 0 : s
    head[e + 1] = s >= 256 ? 0 : s
    head.writeUInt16LE(1, e + 4)
    head.writeUInt16LE(32, e + 6)
    head.writeUInt32LE(png.length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += png.length
  })
  return Buffer.concat([head, ...pngs])
}
fs.writeFileSync(path.join(LOCAL, 'live-code.ico'), ico([16, 24, 32, 48, 64, 256]))
const shortcut = async where => ps(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${where.replace(/'/g, "''")}')
$s.TargetPath = "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
$s.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${launcher}"'
$s.WorkingDirectory = '${LOCAL}'
$s.IconLocation = '${path.join(LOCAL, 'live-code.ico')},0'
$s.WindowStyle = 7
$s.Description = 'Live Code Dashboard: watch Claude code, live'
$s.Save()`)
const startMenu = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Live Code Dashboard.lnk')
await shortcut(startMenu)
say('✓ Start menu: Live Code Dashboard')
if (!AUTO) {
  const desktop = await ps("[Environment]::GetFolderPath('Desktop')")
  if (desktop) { await shortcut(path.join(desktop, 'Live Code Dashboard.lnk')); say('✓ Desktop shortcut') }
}
// the Stream Deck's dashboard key opens it through the same launcher
const now = readJson(DECK_FILE) ?? {}
if (!now.dashboard || !fs.existsSync(now.dashboard)) fs.writeFileSync(DECK_FILE, `${JSON.stringify({ ...now, dashboard: startMenu }, null, 2)}\n`)

// ── WebView2, for tiles in windows of their own ──
const { ensureWebView2 } = await import('../dashboard/webview2.mjs')
say((await ensureWebView2()) ? '✓ WebView2 for the tile windows' : '! WebView2 could not be fetched now; it is tried again when a tile window opens')

// ── the Stream Deck plugin ──
const sdApp = ['ProgramFiles', 'ProgramFiles(x86)'].map(v => process.env[v] && path.join(process.env[v], 'Elgato', 'StreamDeck', 'StreamDeck.exe')).find(p => p && fs.existsSync(p))
const installed = readJson(path.join(process.env.APPDATA ?? '', 'Elgato', 'StreamDeck', 'Plugins', 'com.cnlynx.livecode.sdPlugin', 'manifest.json'))?.Version
const ours = readJson(path.join(ROOT, 'streamdeck', 'com.cnlynx.livecode.sdPlugin', 'manifest.json'))?.Version
const older = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0); return false }
if (sdApp && ours && (installed ? older(installed, ours) : !AUTO)) {
  const out = path.join(LOCAL, 'streamdeck')
  await new Promise(resolve => execFile(process.execPath, [path.join(ROOT, 'streamdeck', 'build.mjs'), out], { windowsHide: true }, resolve))
  const pkg = path.join(out, 'com.cnlynx.livecode.streamDeckPlugin')
  // the Stream Deck app asks whether to install it
  if (fs.existsSync(pkg)) { spawn('cmd.exe', ['/c', 'start', '', pkg], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); say(`✓ Stream Deck plugin ${ours}: confirm the install in the Stream Deck app`) }
} else if (!AUTO) say(sdApp ? `✓ Stream Deck plugin ${installed} is up to date` : '- No Stream Deck app found (elgato.com/downloads); run this setup again after installing it')

fs.writeFileSync(path.join(HOME, 'live-code-setup.json'), `${JSON.stringify({ version, at: new Date().toISOString() })}\n`)

if (!AUTO) {
  spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', path.join(DASH, 'start.ps1')], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  say('✓ Dashboard opening. Philips Hue: Settings (gear) → Lights → Pair bridge.')
}
