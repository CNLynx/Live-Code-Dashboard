# Publishes chosen changes to GitHub: every user gets them with their next update.
# Changes are first kept locally, one step each (change.ps1, branch "lokal");
# a release takes the ones picked onto main, what is on GitHub, and leaves the
# rest here for later.
#   .\release.ps1 -List                                 the changes not published yet
#   .\release.ps1 -Pick 1a2b3c4,5d6e7f8 "What changed"  these, 1.0.0 -> 1.0.1
#   .\release.ps1 "Big new thing" -Minor                all of them, 1.0.1 -> 1.1.0
# The release is checked first (validate + tests) as it will be published; it
# stops if anything fails, or if a picked change needs one not picked.
#   .\release.ps1 -Pick 1a2b3c4 "Test" -DryRun          builds and checks it, publishes nothing
param([string]$Message, [string[]]$Pick, [switch]$Minor, [switch]$Major, [switch]$List, [switch]$DryRun)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repo

# (git writes notes such as line-ending warnings to stderr: not errors)
function G {
  $ErrorActionPreference = 'Continue'
  $out = & git.exe @args 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed:`n$($out -join "`n")" }
  $out
}

if ((G rev-parse --abbrev-ref HEAD) -ne 'lokal') {
  if (G branch --list lokal) { G checkout -q lokal } else { G checkout -q -b lokal }
}
if (G status --porcelain) { throw 'Unsaved changes: keep them first with .\change.ps1 "Name"' }

# main as it is on GitHub
G fetch -q origin main:main | Out-Null
$pending = @(G log --reverse --format=%h%x09%s main..lokal | Where-Object { $_ })
if ($List -or $pending.Count -eq 0) {
  if ($pending.Count -eq 0) { Write-Host 'Nothing to publish.' } else { $pending | ForEach-Object { Write-Host $_ } }
  exit 0
}

# the picked ones, in the order they were made
$all = $pending | ForEach-Object { ($_ -split "`t")[0] }
$picks = if ($Pick) { @($Pick | ForEach-Object { $_ -split ',' } | Where-Object { $_ } | ForEach-Object { $_.Trim() }) } else { $all }
$chosen = @($pending | Where-Object { $sha = ($_ -split "`t")[0]; $picks | Where-Object { $sha.StartsWith($_) -or $_.StartsWith($sha) } })
if ($chosen.Count -ne $picks.Count) { throw "Not among the changes to publish: $($picks -join ', ')" }
if (-not $Message) { $Message = ($chosen | ForEach-Object { ($_ -split "`t", 2)[1] }) -join '; ' }

# built apart, in a folder of its own: main plus the picked changes (main
# itself moves only once GitHub has the release)
$wt = Join-Path ([IO.Path]::GetTempPath()) "live-code-release-$PID"
G worktree add -q --detach $wt main | Out-Null
try {
  foreach ($line in $chosen) {
    $sha, $name = $line -split "`t", 2
    try { G -C $wt cherry-pick $sha | Out-Null }
    catch {
      try { G -C $wt cherry-pick --abort | Out-Null } catch {}
      throw "`"$name`" needs a change that is not picked (or one picked before it): pick that one too."
    }
  }
  & claude plugin validate $wt
  if ($LASTEXITCODE -ne 0) { throw 'validate failed' }
  & claude plugin test $wt
  if ($LASTEXITCODE -ne 0) { throw 'tests failed' }

  # the new version number: Claude Code only offers an update when it changes
  $file = Join-Path $wt '.claude-plugin\plugin.json'
  $json = [IO.File]::ReadAllText($file)
  $old = [regex]::Match($json, '"version":\s*"(\d+)\.(\d+)\.(\d+)"')
  $v = @([int]$old.Groups[1].Value, [int]$old.Groups[2].Value, [int]$old.Groups[3].Value)
  if ($Major) { $v = @(($v[0] + 1), 0, 0) } elseif ($Minor) { $v = @($v[0], ($v[1] + 1), 0) } else { $v[2]++ }
  $new = $v -join '.'
  [IO.File]::WriteAllText($file, $json.Replace($old.Value, "`"version`": `"$new`""), (New-Object Text.UTF8Encoding $false))

  G -C $wt add -A | Out-Null
  G -C $wt commit -q -m "v$new - $Message" | Out-Null
  if ($DryRun) {
    Write-Host "Dry run: v$new would hold" -ForegroundColor Cyan
    G -C $wt log --reverse --format=%h%x09%s main..HEAD | ForEach-Object { Write-Host "  $_" }
  } else {
    G -C $wt tag "v$new" | Out-Null
    try { G -C $wt push -q origin HEAD:main "v$new" | Out-Null }
    catch {
      try { G tag -d "v$new" | Out-Null } catch {}
      throw "push failed, nothing published: $($_.Exception.Message)"
    }
  }
} finally {
  try { G worktree remove --force $wt | Out-Null } catch {}
}
if ($DryRun) { exit 0 }
G fetch -q origin main:main | Out-Null

# here again: the published changes now come from main, the rest stay on top
try { G rebase -q main | Out-Null }
catch {
  try { G rebase --abort | Out-Null } catch {}
  Write-Host "Published v$new, but the local changes could not be laid onto it: run 'git rebase main' in $repo" -ForegroundColor Yellow
  exit 1
}
Write-Host "Released v$new" -ForegroundColor Green
$left = @(G log --reverse --format=%h%x09%s main..lokal | Where-Object { $_ })
if ($left.Count) { Write-Host 'Still only here:'; $left | ForEach-Object { Write-Host "  $_" } }
