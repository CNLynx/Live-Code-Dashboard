// The three files of Microsoft's WebView2 SDK the frameless tile windows run
// on (tilewin/tile-window.ps1): fetched once from nuget.org, Microsoft's own
// package, into %LOCALAPPDATA%\live-code-dashboard\webview2, where updates of
// the mod leave them. The browser engine itself is Edge's, already on Windows.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '1.0.2365.46'
const PACKAGE = `https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/${VERSION}`
export const WEBVIEW2_DIR = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'live-code-dashboard', 'webview2')
const FILES = { 'lib/net45/Microsoft.Web.WebView2.Core.dll': 'Microsoft.Web.WebView2.Core.dll', 'lib/net45/Microsoft.Web.WebView2.WinForms.dll': 'Microsoft.Web.WebView2.WinForms.dll', 'runtimes/win-x64/native/WebView2Loader.dll': 'WebView2Loader.dll' }

export const hasWebView2 = () => Object.values(FILES).every(f => fs.existsSync(path.join(WEBVIEW2_DIR, f)))

let busy = null
export const ensureWebView2 = () => {
  if (process.platform !== 'win32' || hasWebView2()) return Promise.resolve(true)
  busy ??= (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-code-webview2-'))
    try {
      const r = await fetch(PACKAGE, { redirect: 'follow' })
      if (!r.ok) return false
      const zip = path.join(tmp, 'webview2.zip')
      fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()))
      const out = path.join(tmp, 'x')
      await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${out}' -Force`], { windowsHide: true }, e => (e ? reject(e) : resolve())))
      fs.mkdirSync(WEBVIEW2_DIR, { recursive: true })
      for (const [from, to] of Object.entries(FILES)) fs.copyFileSync(path.join(out, from), path.join(WEBVIEW2_DIR, to))
      return true
    } catch {
      return false
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
      busy = null
    }
  })()
  return busy
}

// run by itself (the setup): fetch them now
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureWebView2().then(ok => { process.stdout.write(ok ? `WebView2: ${WEBVIEW2_DIR}\n` : 'WebView2: could not fetch\n'); process.exit(ok ? 0 : 1) })
}
