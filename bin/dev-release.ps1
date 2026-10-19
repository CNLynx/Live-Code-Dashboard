# The dashboard's Publish, for the mod's author only (dashboard/server.mjs, with
# ~/.claude/live-code-dev.json): runs release.ps1 with what was picked there.
# What to publish is read from the state file, how it went is written back to it.
param([string]$StateFile)

$req = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$splat = @{ Pick = @($req.picks); Message = [string]$req.message }
if ($req.minor) { $splat.Minor = $true }
# (a try that builds and checks it all, publishing nothing)
if ($req.dryRun) { $splat.DryRun = $true }

$out = @()
try {
  $out = @(& (Join-Path $repo 'release.ps1') @splat *>&1 | ForEach-Object { "$_" })
} catch {
  $out += $_.Exception.Message
}
$text = $out -join "`n"
$version = [regex]::Match($text, 'Released v(\d+\.\d+\.\d+)').Groups[1].Value
$state = [ordered]@{
  state   = $(if ($version) { 'done' } else { 'failed' })
  at      = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  version = $version
  out     = @($out | Select-Object -Last 14)
}
[IO.File]::WriteAllText($StateFile, ($state | ConvertTo-Json -Depth 3), (New-Object Text.UTF8Encoding $false))
