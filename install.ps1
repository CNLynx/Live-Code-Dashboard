# Live Code Dashboard - one-click install for Windows.
# Run in PowerShell:
#   irm https://raw.githubusercontent.com/CNLynx/Live-Code-Dashboard/main/install.ps1 | iex
# It installs the Claude Code mod, then sets up the dashboard: Start menu and
# desktop shortcut, the frameless tile windows, the Stream Deck plugin (when
# the Stream Deck app is installed), and opens the dashboard.

$ErrorActionPreference = 'Stop'
Write-Host ''
Write-Host '  Live Code Dashboard - setup' -ForegroundColor Magenta
Write-Host ''

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '  Node.js is missing. Install it from https://nodejs.org (LTS), then run this again.' -ForegroundColor Yellow
  Write-Host '  (or: winget install OpenJS.NodeJS.LTS)'
  return
}
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host '  Claude Code is missing. Install it from https://claude.com/claude-code, then run this again.' -ForegroundColor Yellow
  return
}

Write-Host '  1/2  Installing the Claude Code mod...'
& claude plugin install live-code --marketplace CNLynx/Live-Code-Dashboard
if ($LASTEXITCODE -ne 0) { Write-Host '  The install did not finish. In Claude Code type:  /plugin install live-code --marketplace CNLynx/Live-Code-Dashboard' -ForegroundColor Yellow; return }

$setup = Get-ChildItem (Join-Path $env:USERPROFILE '.claude\plugins\cache') -Recurse -Filter setup.mjs -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '[\\/]live-code[\\/]' -and $_.Directory.Name -eq 'bin' } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { Write-Host '  Installed. Start Claude Code and type /live-code-setup to finish.' -ForegroundColor Yellow; return }

Write-Host '  2/2  Setting up the dashboard...'
& node $setup.FullName
Write-Host ''
Write-Host '  Done. Restart Claude Code (or start a new chat): the dashboard fills as soon as Claude works.' -ForegroundColor Green
Write-Host ''
