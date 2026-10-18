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
