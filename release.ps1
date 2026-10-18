# Publishes a new version to GitHub: every user gets it with their next update.
#   .\release.ps1 "What changed"            1.0.0 -> 1.0.1
#   .\release.ps1 "Big new thing" -Minor    1.0.1 -> 1.1.0
# Checks the mod first (validate + tests); stops if anything fails.
param([Parameter(Mandatory)][string]$Message, [switch]$Minor, [switch]$Major)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

& claude plugin validate .
if ($LASTEXITCODE -ne 0) { throw 'validate failed' }
& claude plugin test .
if ($LASTEXITCODE -ne 0) { throw 'tests failed' }

# the new version number: Claude Code only offers an update when it changes
$file = '.claude-plugin\plugin.json'
$json = Get-Content $file -Raw
$old = [regex]::Match($json, '"version":\s*"(\d+)\.(\d+)\.(\d+)"')
$v = @([int]$old.Groups[1].Value, [int]$old.Groups[2].Value, [int]$old.Groups[3].Value)
if ($Major) { $v = @(($v[0] + 1), 0, 0) } elseif ($Minor) { $v = @($v[0], ($v[1] + 1), 0) } else { $v[2]++ }
$new = $v -join '.'
$json = $json.Replace($old.Value, "`"version`": `"$new`"")
[IO.File]::WriteAllText((Resolve-Path $file), $json, (New-Object Text.UTF8Encoding $false))

# (git writes notes such as line-ending warnings to stderr: not errors)
$ErrorActionPreference = 'Continue'
git add -A 2>$null
git commit -q -m "v$new - $Message"
if ($LASTEXITCODE -ne 0) { throw 'commit failed' }
git tag "v$new"
cmd /c "git push origin main --tags 2>&1"
if ($LASTEXITCODE -ne 0) { throw "push failed: run 'git push origin main --tags' here" }
Write-Host "Released v$new" -ForegroundColor Green
