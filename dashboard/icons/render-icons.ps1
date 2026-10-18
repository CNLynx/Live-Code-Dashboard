# Renders each icons\*.svg to PNGs (512 down to 16) and a Windows .ico holding
# them all, using headless Chrome for the drawing and System.Drawing to scale.
#   render-icons.ps1            all variants
#   render-icons.ps1 glow       one variant
param([string[]]$Names)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw 'Chrome is needed to render the icons.' }
$sizes = 256, 128, 64, 48, 32, 24, 16
$work = Join-Path $env:TEMP 'live-code-icons'
New-Item -ItemType Directory -Force $work | Out-Null

function Render-Svg($svg, $png) {
  $page = Join-Path $work 'page.html'
  $markup = [IO.File]::ReadAllText($svg)
  [IO.File]::WriteAllText($page, "<!doctype html><html><body style=`"margin:0;background:transparent`">$markup</body></html>")
  $args = @('--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000', '--window-size=512,512',
    "--user-data-dir=$work\profile", "--screenshot=$png", "file:///$($page -replace '\\', '/')")
  $p = Start-Process -FilePath $chrome -ArgumentList $args -PassThru -WindowStyle Hidden
  if (-not $p.WaitForExit(30000)) { $p.Kill(); throw "Chrome did not finish rendering $svg" }
  if (-not (Test-Path $png)) { throw "No PNG for $svg" }
}

function Scale($source, $size, $png) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($source, 0, 0, $size, $size)
  $g.Dispose()
  $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

# An .ico whose entries are PNGs, largest first (Windows Vista and later read these).
function Write-Ico($pngs, $ico) {
  $images = $pngs | ForEach-Object { [IO.File]::ReadAllBytes($_.Path) }
  $out = New-Object IO.MemoryStream
  $w = New-Object IO.BinaryWriter $out
  $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$pngs.Count)
  $offset = 6 + 16 * $pngs.Count
  for ($i = 0; $i -lt $pngs.Count; $i++) {
    $s = $pngs[$i].Size
    $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s }))); $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $w.Write([byte]0); $w.Write([byte]0); $w.Write([UInt16]1); $w.Write([UInt16]32)
    $w.Write([UInt32]$images[$i].Length); $w.Write([UInt32]$offset)
    $offset += $images[$i].Length
  }
  foreach ($bytes in $images) { $w.Write($bytes) }
  $w.Flush()
  [IO.File]::WriteAllBytes($ico, $out.ToArray())
  $w.Dispose()
}

$svgs = Get-ChildItem $here -Filter *.svg | Where-Object { -not $Names -or $Names -contains $_.BaseName }
foreach ($svg in $svgs) {
  $name = $svg.BaseName
  $big = Join-Path $here "$name-512.png"
  Remove-Item $big -ErrorAction SilentlyContinue
  Render-Svg $svg.FullName $big
  $source = [System.Drawing.Image]::FromFile($big)
  $pngs = foreach ($s in $sizes) {
    $png = Join-Path $here "$name-$s.png"
    Scale $source $s $png
    [pscustomobject]@{ Size = $s; Path = $png }
  }
  $source.Dispose()
  Write-Ico $pngs (Join-Path $here "$name.ico")
  "rendered $name"
}
