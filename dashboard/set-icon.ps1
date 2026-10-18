# Picks the dashboard's icon and (re)makes its shortcut with it.
#   set-icon.ps1 glow        Neon Glow (default)
#   set-icon.ps1 flat        Flat Gradient
#   set-icon.ps1 diff        Diff Window
#   set-icon.ps1 glow -Desktop   also put the shortcut on the desktop
# The open dashboard window shows the new icon after a reload (F5).
param([ValidateSet('glow', 'flat', 'diff')][string]$Name = 'glow', [switch]$Desktop)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ico = Join-Path $here "icons\$Name.ico"
if (-not (Test-Path $ico)) { & (Join-Path $here 'icons\render-icons.ps1') $Name }
Set-Content -Path (Join-Path $here 'icons\active.txt') -Value $Name -NoNewline -Encoding ascii

$shell = New-Object -ComObject WScript.Shell
$targets = @(Join-Path $here 'Live Code Dashboard.lnk')
if ($Desktop) { $targets += Join-Path ([Environment]::GetFolderPath('Desktop')) 'Live Code Dashboard.lnk' }
foreach ($path in $targets) {
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$here\start.ps1`""
  $link.WorkingDirectory = $here
  $link.IconLocation = "$ico,0"
  $link.WindowStyle = 7 # minimized: no console flashes up
  $link.Description = 'Live Code Dashboard: watch Claude code, with live stats'
  $link.Save()
  "shortcut: $path"
}
