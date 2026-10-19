# Keeps one change on this machine only, as a step of its own on the branch
# "lokal" (the folder the mod runs from), until release.ps1 publishes it.
#   .\change.ps1 "Glowing live dot"
param([Parameter(Mandatory)][string]$Name)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

# (git writes notes such as line-ending warnings to stderr: not errors)
function G {
  $ErrorActionPreference = 'Continue'
  $out = & git.exe @args 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed:`n$($out -join "`n")" }
  $out
}

# the first time: the local branch starts where main is
if ((G rev-parse --abbrev-ref HEAD) -ne 'lokal') {
  if (G branch --list lokal) { G checkout -q lokal } else { G checkout -q -b lokal }
}
G add -A | Out-Null
if (-not (G status --porcelain)) { Write-Host 'Nothing changed.'; exit 0 }
G commit -q -m $Name | Out-Null
Write-Host "Kept locally: $Name" -ForegroundColor Cyan

# Claude runs the mod from its plugin cache, copied from this folder at install
# and refreshed only when the version number changes: the copy of this version
# takes the change now, so Claude's next start runs it.
$version = ([regex]::Match([IO.File]::ReadAllText("$PWD\.claude-plugin\plugin.json"), '"version":\s*"([^"]+)"')).Groups[1].Value
$cache = Join-Path $env:USERPROFILE ".claude\plugins\cache\cnlynx\live-code\$version"
if ($version -and (Test-Path $cache)) {
  robocopy $PWD $cache /MIR /XD .git node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -lt 8) { Write-Host "Claude's copy ($version) brought up to date: restart Claude to run it" -ForegroundColor Cyan }
  else { Write-Host "Claude's copy could not be brought up to date (robocopy $LASTEXITCODE)" -ForegroundColor Yellow }
}
# (robocopy's 1 means "files copied", not a failure)
exit 0
