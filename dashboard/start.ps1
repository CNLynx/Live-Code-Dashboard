# Opens the Live Code dashboard in a window of its own.
# Starts the dashboard server (hidden) unless it already runs, then opens the
# dashboard: in Edge's app mode (no tabs, no address bar, a profile of its
# own, so it keeps its size and place, a second screen included). Edge first,
# for its natural voices that read the summaries aloud; then Chrome, then
# Opera GX as a new window, then the default browser.
#   start.ps1                  Edge first
#   start.ps1 -Browser chrome  Chrome first
#   start.ps1 -Browser opera   Opera GX first
#   start.ps1 -IfClosed        only when no dashboard window is open (Claude starting)
param([int]$Port = 4477, [ValidateSet('chrome', 'opera', 'edge')][string]$Browser = 'edge', [switch]$IfClosed)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = "http://127.0.0.1:$Port"

function Test-Up {
  try { return (Invoke-WebRequest "$url/health" -UseBasicParsing -TimeoutSec 1).StatusCode -eq 200 } catch { return $false }
}

if (-not (Test-Up)) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw 'Node.js was not found. Install it from https://nodejs.org and try again.' }
  $env:LIVE_CODE_PORT = "$Port"
  Start-Process -FilePath $node -ArgumentList "`"$here\server.mjs`"" -WindowStyle Hidden
  foreach ($i in 1..40) { Start-Sleep -Milliseconds 150; if (Test-Up) { break } }
}

# Already open (an app window of the dashboard's own profile): that one comes
# forward, restored if minimized, instead of a second window opening.
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class LcWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static bool Raise(uint[] pids) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (Array.IndexOf(pids, p) < 0 || !IsWindowVisible(h)) return true;
      var s = new StringBuilder(256); GetWindowText(h, s, 256);
      if (s.ToString().IndexOf("Live Code", StringComparison.OrdinalIgnoreCase) < 0) return true;
      found = h; return false;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return false;
    if (IsIconic(found)) ShowWindow(found, 9);
    // a press of Alt lets a window come forward when another program has the focus
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(found);
    return true;
  }
}
'@
$open = @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe' OR Name = 'chrome.exe'" | Where-Object { $_.CommandLine -match 'live-code-dashboard' } | ForEach-Object { [uint32]$_.ProcessId })
if ($IfClosed -and $open.Count -gt 0) { return }
if ($open.Count -gt 0 -and [LcWin]::Raise($open)) { return }

function First-Existing($paths) { $paths | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1 }
$found = @{
  chrome = First-Existing @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
  opera  = First-Existing @("$env:LOCALAPPDATA\Programs\Opera GX\opera.exe", "$env:ProgramFiles\Opera GX\opera.exe")
  edge   = First-Existing @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
}
$order = @($Browser) + (@('edge', 'chrome', 'opera') | Where-Object { $_ -ne $Browser })
$pick = $order | Where-Object { $found[$_] } | Select-Object -First 1

# Chrome and Edge: an app window with a profile of its own, apart from the everyday one.
# That profile may play the done-sound before the first click; it opens nothing but the dashboard.
$profileDir = Join-Path $env:LOCALAPPDATA 'live-code-dashboard'
switch ($pick) {
  'chrome' { Start-Process -FilePath $found.chrome -ArgumentList "--app=$url", "--user-data-dir=`"$profileDir\chrome`"", '--window-size=1680,1050', '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required' }
  'edge'   { Start-Process -FilePath $found.edge -ArgumentList "--app=$url", "--user-data-dir=`"$profileDir\edge`"", '--window-size=1680,1050', '--no-first-run', '--autoplay-policy=no-user-gesture-required' }
  'opera'  { Start-Process -FilePath $found.opera -ArgumentList '--new-window', $url }
  default  { Start-Process $url }
}
