# Live code viewer: watch Claude code as if looking over a programmer's shoulder.
# Each edit is replayed as typing: the existing code around it, old text
# backspaced away, new text typed in with a cursor. Edits are queued and played
# one after another, so none is missed. Also shows token usage.
# Run it in its own Windows Terminal window, drag it to the other monitor.
# Ctrl+C quits.
param([string]$Feed = "$env:USERPROFILE\.claude\live-code-feed.json")

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try { [Console]::CursorVisible = $false } catch {}
$host.UI.RawUI.WindowTitle = 'Claude - live code'

$E = [char]27
$script:Ansi = @{}
function Rgb($layer, $hex) {
  $key = "$layer$hex"
  $code = $script:Ansi[$key]
  if ($null -eq $code) {
    $code = "$E[$layer;2;$([Convert]::ToInt32($hex.Substring(1, 2), 16));$([Convert]::ToInt32($hex.Substring(3, 2), 16));$([Convert]::ToInt32($hex.Substring(5, 2), 16))m"
    $script:Ansi[$key] = $code
  }
  $code
}
function Fg($hex) { Rgb 38 $hex }
function Bg($hex) { Rgb 48 $hex }
$RESET = "$E[0m"; $BOLD = "$E[1m"; $DIM = "$E[2m"

$INK = @{ add = '#4ade80'; del = '#f87171'; mod = '#fb923c'; gap = '#64748b'; hit = '#c084fc'; scan = '#38bdf8' }
$GLOW = @{
  add = @('#22c55e', '#15803d', '#14532d', '#0c2e1a')
  del = @('#ef4444', '#b91c1c', '#7f1d1d', '#3b1111')
  mod = @('#f97316', '#c2410c', '#7c2d12', '#3a1a08')
}
$ACTION = @{
  reading   = @{ label = 'READING'; icon = 'R'; color = '#38bdf8' }
  editing   = @{ label = 'EDITING'; icon = 'E'; color = '#fb923c' }
  writing   = @{ label = 'WRITING'; icon = 'W'; color = '#4ade80' }
  searching = @{ label = 'SEARCHING'; icon = 'S'; color = '#c084fc' }
  running   = @{ label = 'RUNNING'; icon = '$'; color = '#facc15' }
}
$STEP_LOOK = @{
  read = @('R', '#38bdf8'); edit = @('E', '#fb923c'); write = @('W', '#4ade80'); search = @('S', '#c084fc')
  bash = @('$', '#facc15'); web = @('@', '#2dd4bf'); agent = @('A', '#f472b6'); other = @('.', '#94a3b8')
}
$THINK_SPIN = @([char]0x25D0, [char]0x25D3, [char]0x25D1, [char]0x25D2)
$WAVE_CHARS = @(' ', [char]0x2591, [char]0x2592, [char]0x2593, [char]0x2588)
$WAVE_INK = @('#1e1b4b', '#3730a3', '#4f46e5', '#818cf8', '#c7d2fe')
function Dur($ms) { $s = [Math]::Max(0, $ms) / 1000; if ($s -lt 60) { '{0:0.0}s' -f $s } else { '{0}m{1:00}s' -f [Math]::Floor($s / 60), [Math]::Floor($s % 60) } }

function Wave($width, $frame) {
  $sb = New-Object System.Text.StringBuilder
  $last = -1
  for ($i = 0; $i -lt $width; $i++) {
    $level = [Math]::Max(0, [Math]::Min(4, [Math]::Round(2 + 2 * [Math]::Sin(($i - $frame * 0.8) / 2.6))))
    if ($level -ne $last) { [void]$sb.Append((Fg $WAVE_INK[$level])); $last = $level }
    [void]$sb.Append($WAVE_CHARS[$level])
  }
  "$($sb.ToString())$RESET"
}
$SPINNER = '|/-\'
$CURSOR = [string][char]0x258C
$FLASH_MS = 1800
$HOLD_MS = 1200     # how long a finished replay stays before the next one starts
$MIN_CPS = 45       # typing speed, characters per second, at the least
$TYPE_MS = 4500     # the longest one replay may take
$BACKSPACE = 3      # backspacing runs this many times faster than typing
$SCAN_MS = 45       # per line, for the sweep over a file being read

function Now { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function Human($n) { if ($n -ge 1e6) { '{0:0.0}M' -f ($n / 1e6) } elseif ($n -ge 1e3) { '{0:0.0}k' -f ($n / 1e3) } else { "$n" } }
function Pad($n, $w) { if ($null -eq $n) { ' ' * $w } else { "$n".PadLeft($w) } }
function Clock($ms) { [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$ms).ToLocalTime().ToString('HH:mm:ss') }
function Clip($text, $width) { $t = "$text"; if ($t.Length -gt $width) { $t.Substring(0, [Math]::Max(0, $width - 1)) + '~' } else { $t } }
function Sub($text, $from, $to) { $s = "$text"; $a = [Math]::Max(0, [Math]::Min($s.Length, $from)); $b = [Math]::Max($a, [Math]::Min($s.Length, $to)); $s.Substring($a, $b - $a) }
function SpanLen($span) { if ($null -eq $span) { 0 } else { [Math]::Max(0, $span[1] - $span[0]) } }

function Where-Of($f) {
  $name = Split-Path $f.file -Leaf
  if ($null -eq $f.line) { return $name }
  if ($null -ne $f.endLine -and $f.endLine -ne $f.line) { return "${name}:$($f.line)-$($f.endLine)" }
  "${name}:$($f.line)"
}

function Counts($s) {
  $out = ''
  if ($s.add -gt 0) { $out += " $(Fg $INK.add)+$($s.add)$RESET" }
  if ($s.del -gt 0) { $out += " $(Fg $INK.del)-$($s.del)$RESET" }
  if ($s.mod -gt 0) { $out += " $(Fg $INK.mod)~$($s.mod)$RESET" }
  $out
}

function Spark($s) {
  $total = $s.add + $s.del + $s.mod
  if ($total -eq 0) { return '' }
  $scale = [Math]::Min(1, 10 / $total)
  $cells = { param($n) if ($n -eq 0) { '' } else { [string][char]0x25AE * [Math]::Max(1, [Math]::Round($n * $scale)) } }
  " $(Fg $INK.add)$(& $cells $s.add)$(Fg $INK.mod)$(& $cells $s.mod)$(Fg $INK.del)$(& $cells $s.del)$RESET"
}

$BAR_STOPS = @(@(0.5, '#4ade80'), @(0.7, '#facc15'), @(0.85, '#fb923c'), @(1.0, '#f87171'))
function Bar($percent, $width, $frame) {
  $p = [Math]::Min(100, [Math]::Max(0, $percent))
  $filled = [int][Math]::Round($p / 100 * $width)
  $out = ''; $from = 0
  foreach ($stop in $BAR_STOPS) {
    $to = [Math]::Min($filled, [int][Math]::Ceiling($stop[0] * $width))
    if ($to -gt $from) {
      $color = if ($p -ge 85 -and $to -eq $filled -and ($frame % 12) -lt 6) { '#fecaca' } else { $stop[1] }
      $out += "$(Fg $color)$([string][char]0x2588 * ($to - $from))"
    }
    $from = [Math]::Max($from, $to)
  }
  "$out$RESET$DIM$([string][char]0x2591 * [Math]::Max(0, $width - $filled))$RESET"
}

# ── the typing replay ─────────────────────────────────────────────────────────
function CostOf($row) {
  switch ($row.kind) {
    'add' { return "$($row.text)".Length + 3 }
    'del' { return "$($row.text)".Length / $BACKSPACE + 2 }
    'mod' { return (SpanLen $row.beforeSpan) / $BACKSPACE + (SpanLen $row.span) + 3 }
    default { return 0 }
  }
}

# per line of a read: quicker for a long read, so the sweep reaches its end within 2.5s
function ScanStep($focus) { [Math]::Min($SCAN_MS, 2500 / [Math]::Max(1, @($focus.rows).Count)) }

function Playback($focus) {
  $typed = $focus.action -eq 'editing' -or $focus.action -eq 'writing'
  $costs = @(foreach ($row in @($focus.rows)) { if ($typed) { CostOf $row } else { 0 } })
  $total = ($costs | Measure-Object -Sum).Sum
  if ($null -eq $total) { $total = 0 }
  $cps = [Math]::Max($MIN_CPS, $total * 1000 / $TYPE_MS)
  $ms = if ($focus.action -eq 'reading') { @($focus.rows).Count * (ScanStep $focus) } else { $total * 1000 / $cps }
  @{ costs = $costs; cps = $cps; ms = $ms }
}

# A styled run: text plus its ANSI style.
function Seg($text, $style = '') { @{ text = "$text"; style = $style } }

# One row at k characters into its replay; $null while not on screen.
function ViewOf($row, $i, $k, $cost, $ctx) {
  $isDone = $cost -eq 0 -or $k -ge $cost
  $cur = Seg $(if (($ctx.frame % 6) -lt 4) { $CURSOR } else { ' ' }) (Fg '#ffffff')
  switch ($row.kind) {
    'ctx' {
      $isScan = $i -eq $ctx.scanAt
      $style = if ($isScan) { "$(Fg '#ffffff')$(Bg '#1e3a5f')" } elseif ($i -gt $ctx.scanAt) { $DIM } else { '' }
      $sign = if ($isScan) { '>' } else { ' ' }
      $ink = if ($isScan) { $INK.scan } else { $null }
      $no = if ($null -ne $row.newNo) { $row.newNo } else { $row.oldNo }
      return @{ sign = $sign; ink = $ink; no = $no; segs = @(Seg $row.text $style); active = $isScan }
    }
    'add' {
      if ($k -le 0 -and $cost -gt 0) { return $null }
      $n = if ($isDone) { "$($row.text)".Length } else { [Math]::Floor($k) }
      $segs = @(Seg (Sub $row.text 0 $n) "$(Fg $INK.add)$(Bg $ctx.glowAdd)")
      if (-not $isDone) { $segs += $cur }
      return @{ sign = '+'; ink = $INK.add; no = $row.newNo; segs = $segs; active = -not $isDone }
    }
    'del' {
      if ($isDone) { return $null }
      if ($k -le 0) { return @{ sign = ' '; no = $row.oldNo; segs = @(Seg $row.text); active = $false } }
      $len = "$($row.text)".Length
      $n = [Math]::Min($len, [Math]::Floor($k * $BACKSPACE))
      return @{ sign = '-'; ink = $INK.del; no = $row.oldNo; segs = @((Seg (Sub $row.text 0 ($len - $n)) "$(Fg '#ffffff')$(Bg $GLOW.del[1])"), $cur); active = $true }
    }
    'mod' {
      $before = "$($row.before)"
      $b0 = 0; $b1 = $before.Length; if ($null -ne $row.beforeSpan) { $b0 = $row.beforeSpan[0]; $b1 = $row.beforeSpan[1] }
      $s0 = 0; $s1 = "$($row.text)".Length; if ($null -ne $row.span) { $s0 = $row.span[0]; $s1 = $row.span[1] }
      $erase = ($b1 - $b0) / $BACKSPACE
      if ($k -le 0 -and $cost -gt 0) { return @{ sign = ' '; no = $row.oldNo; segs = @(Seg $before); active = $false } }
      if (-not $isDone -and $k -lt $erase) {
        $n = [Math]::Min($b1 - $b0, [Math]::Floor($k * $BACKSPACE))
        return @{ sign = '~'; ink = $INK.mod; no = $row.oldNo; active = $true; segs = @(
            (Seg (Sub $before 0 $b0)), (Seg (Sub $before $b0 ($b1 - $n)) "$(Fg '#ffffff')$(Bg $GLOW.del[1])"), $cur, (Seg (Sub $before $b1 $before.Length))) }
      }
      $n = if ($isDone) { $s1 - $s0 } else { [Math]::Min($s1 - $s0, [Math]::Floor($k - $erase)) }
      $segs = @((Seg (Sub $row.text 0 $s0) (Fg $INK.mod)), (Seg (Sub $row.text $s0 ($s0 + $n)) "$BOLD$(Fg '#ffffff')$(Bg $ctx.glowMod)"))
      if (-not $isDone) { $segs += $cur }
      $segs += Seg (Sub $row.text $s1 "$($row.text)".Length) (Fg $INK.mod)
      return @{ sign = '~'; ink = $INK.mod; no = $row.newNo; segs = $segs; active = -not $isDone }
    }
    'gap' { return @{ sign = '.'; ink = $INK.gap; segs = @(Seg $row.text (Fg $INK.gap)); active = $false } }
    'hit' { return @{ sign = '*'; ink = $INK.hit; segs = @(Seg $row.text (Fg $INK.hit)); active = $false } }
  }
}

function DrawView($view, $width) {
  $gutter = if ($view.ink) { Fg $view.ink } else { $DIM }
  $out = "$gutter$(Pad $view.no 5) $($view.sign) |$RESET "
  $room = $width
  foreach ($seg in $view.segs) {
    if ($room -le 0) { break }
    $t = Clip $seg.text $room
    $room -= $t.Length
    if ($t.Length -gt 0) { $out += "$($seg.style)$t$RESET" }
  }
  $out
}

# ── one frame ─────────────────────────────────────────────────────────────────
function Draw($data, $show, $playedAt, $queued, $t, $frame) {
  $cols = [Math]::Max(40, $host.UI.RawUI.WindowSize.Width)
  $rowsMax = [Math]::Max(20, $host.UI.RawUI.WindowSize.Height)
  $lines = New-Object System.Collections.Generic.List[string]
  $sum = $data.totals; $use = $data.usage

  $head = "$BOLD$(Fg '#0b0b0f')$(Bg '#a78bfa') * LIVE CODE $RESET"
  $th = $data.thinking
  $steps = @($data.steps | Where-Object { $null -ne $_ })
  $slow = [Math]::Floor($frame / 4)
  $turnLive = $null -ne $th -and $null -ne $th.turnStartedAt -and ($null -eq $th.turnEndedAt -or $th.turnEndedAt -lt $th.turnStartedAt)
  $isBusy = $turnLive -or ($null -ne $show -and -not $show.isDone)
  $dot = if ($isBusy) { if ($slow % 2 -eq 0) { Fg '#f87171' } else { Fg '#7f1d1d' } } else { Fg '#475569' }
  $head = "$dot$([char]0x25CF)$RESET $head"
  if ($null -ne $sum) {
    $cmds = if ($null -ne $sum.commands) { $sum.commands } else { 0 }
    $head += "  $DIM$($sum.files) files$RESET$(Counts $sum)  $DIM R $($sum.reads)  E $($sum.edits)  S $($sum.searches)  `$ $cmds$RESET"
  }
  if ($null -ne $th -and $null -ne $th.turnStartedAt -and $data.turnNo -gt 0) {
    $turnEnd = if ($turnLive) { $t } else { $th.turnEndedAt }
    $turnInk = if ($turnLive) { Fg '#a78bfa' } else { $DIM }
    $head += "  ${turnInk}T$($data.turnNo) $(Dur ($turnEnd - $th.turnStartedAt))$RESET"
  }
  if ($queued -gt 0) { $head += "  $(Fg '#facc15')+$queued queued$RESET" }
  $lines.Add($head)

  if ($null -ne $use) {
    $w = [Math]::Max(10, [Math]::Min(40, $cols - 36))
    $pct = if ($null -ne $use.percent) { $use.percent } else { 0 }
    $lines.Add("${BOLD}CONTEXT $RESET$(Bar $pct $w $frame)$BOLD $("$pct".PadLeft(3))%$RESET  $DIM$(Human $use.tokens) / $(Human $use.window)$RESET")
    foreach ($l in $use.limits) {
      $name = switch ($l.kind) { 'five_hour' { '5H' } 'seven_day' { '7D' } default { $l.kind.Substring(0, [Math]::Min(7, $l.kind.Length)) } }
      $reset = if ($l.resetsAt) { "  ${DIM}resets $(([DateTimeOffset]::Parse($l.resetsAt)).ToLocalTime().ToString('HH:mm'))$RESET" } else { '' }
      $lines.Add("$BOLD$($name.PadRight(8))$RESET$(Bar $l.percent $w $frame)$BOLD $("$([Math]::Round($l.percent))".PadLeft(3))%$RESET$reset")
    }
    $cost = if ($null -ne $use.usd) { "   $(Fg '#facc15')`$$('{0:0.00}' -f $use.usd)$RESET" } else { '' }
    $lines.Add("$(Fg '#38bdf8')^ $(Human $use.input) in$RESET   $(Fg '#a78bfa')v $(Human $use.output) out$RESET$cost   $DIM$($use.turns) turns$RESET")
  }

  # thinking: between tools, and before the first one
  if ($null -ne $th -and $th.active) {
    $word = if ($steps.Count -eq 0) { 'Planning' } else { 'Thinking' }
    $after = if ($steps.Count -gt 0) { "  $DIM- after $($steps.Count) step$(if ($steps.Count -ne 1) { 's' })$RESET" } else { '' }
    $lines.Add('')
    $lines.Add("$(Fg '#818cf8')$($THINK_SPIN[$slow % 4]) $BOLD$(Fg '#a5b4fc')$word$RESET$(Fg '#818cf8')$(('.' * ($slow % 4)).PadRight(3))$RESET  $DIM$(Dur ($t - $th.since))$RESET$after")
    $lines.Add("  $(Wave ([Math]::Min(60, $cols - 4)) $frame)")
    if ($data.prompt) { $lines.Add("  $DIM> $(Clip $data.prompt ($cols - 6))$RESET") }
  } elseif (-not $turnLive -and $steps.Count -gt 0 -and $null -ne $th.turnEndedAt) {
    $failed = @($steps | Where-Object { $_.status -eq 'error' }).Count
    $lines.Add('')
    $lines.Add("$(Fg '#4ade80')v $RESET${BOLD}Turn $($data.turnNo) done$RESET  $DIM$(Dur ($th.turnEndedAt - $th.turnStartedAt))  -  $($steps.Count) steps$(if ($failed -gt 0) { "  -  $failed failed" })$RESET")
  }

  # the turn pipeline
  if ($steps.Count -gt 0) {
    $fit = 5
    $chips = @($steps | Select-Object -Last $fit)
    $row = if ($steps.Count -gt $chips.Count) { "$DIM+$($steps.Count - $chips.Count) $RESET" } else { '' }
    $n = 0
    foreach ($step in $chips) {
      $look = $STEP_LOOK[$step.kind]; if ($null -eq $look) { $look = $STEP_LOOK.other }
      if ($n -gt 0) { $row += "$DIM > $RESET" }
      if ($step.status -eq 'running') {
        $row += "$BOLD$(Fg '#0b0b0f')$(Bg $look[1]) $($look[0]) $(Clip $step.label 22) $($SPINNER[$slow % 4]) $RESET"
      } else {
        $chipInk = if ($step.status -eq 'error') { $INK.del } else { $look[1] }
        $row += "$(Fg $chipInk)$($look[0])$(if ($step.status -eq 'error') { 'x' })$RESET"
        if ($null -ne $step.doneAt) { $row += " $DIM$(Dur ($step.doneAt - $step.startedAt))$RESET" }
      }
      $n++
    }
    $lines.Add('')
    $lines.Add($row)
  }
  $lines.Add('')

  if ($null -eq $show) {
    $lines.Add("$DIM$($SPINNER[$frame % 4]) Waiting for Claude to touch a file...$RESET")
  } else {
    $play = Playback $show
    $elapsed = $t - $playedAt
    $typed = $elapsed / 1000 * $play.cps
    $replaying = $elapsed -lt $play.ms
    $age = $elapsed - $play.ms
    $level = if ($replaying) { 1 } else { [int][Math]::Min(3.0, [Math]::Max(0.0, [Math]::Floor($age / ($FLASH_MS / 3)))) }
    $ctx = @{
      frame = $frame
      scanAt = $(if ($show.action -eq 'reading') { [Math]::Floor($elapsed / (ScanStep $show)) } else { [int]::MaxValue })
      glowAdd = $GLOW.add[$level]; glowMod = $GLOW.mod[$level]
    }

    $tag = $ACTION[$show.action]
    $mark = if ($replaying -and $show.action -ne 'reading') { "$(Fg '#ffffff')typing$RESET" } elseif (-not $show.isDone) { "$(Fg '#facc15')$($SPINNER[[Math]::Floor($frame / 4) % 4]) $(Dur ($t - $show.startedAt))$RESET" } elseif ($show.isError) { 'x' } else { 'v' }
    $detail = if ($show.detail) { "  $DIM$($show.detail)$RESET" } else { '' }
    $lines.Add("$BOLD$(Fg '#0b0b0f')$(Bg $tag.color) $($tag.label) $RESET $BOLD$(Fg $tag.color)$(Where-Of $show)$RESET$(Counts $show.stats)$detail  $DIM$(Clock $show.startedAt)$RESET  $mark")
    $lines.Add("$DIM$(Clip (Split-Path $show.file -Parent) ($cols - 2))$RESET")

    # every row as it stands, then a window of them that follows the cursor
    $views = New-Object System.Collections.Generic.List[object]
    $spent = 0; $activeAt = -1; $firstChange = -1; $i = 0
    foreach ($row in @($show.rows)) {
      $cost = if ($i -lt $play.costs.Count) { $play.costs[$i] } else { 0 }
      $k = if ($cost -eq 0) { 0 } else { [Math]::Min($cost, [Math]::Max(0, $typed - $spent)) }
      $spent += $cost
      $view = ViewOf $row $i $k $cost $ctx
      if ($null -ne $view) {
        if ($view.active -and $activeAt -lt 0) { $activeAt = $views.Count }
        if ($firstChange -lt 0 -and $row.kind -in @('add', 'del', 'mod')) { $firstChange = $views.Count }
        $views.Add($view)
      }
      $i++
    }
    $room = [Math]::Max(6, $rowsMax - $lines.Count - 9)
    $follow = if ($activeAt -ge 0) { $activeAt } else { [Math]::Max(0, $firstChange) }
    $top = if ($views.Count -le $room) { 0 } else { [Math]::Min($views.Count - $room, [Math]::Max(0, $follow - [Math]::Floor($room / 3))) }
    $rule = [string][char]0x2500 * [Math]::Min(70, $cols - 10)
    $firstNo = if ($views.Count -gt 0 -and $null -ne $views[0].no) { $views[0].no } else { '?' }
    $UP = [char]0x25B2; $DN = [char]0x25BC; $TL = [char]0x250C; $BL = [char]0x2514
    if ($views.Count -gt 0) { $lines.Add("$DIM        $TL$rule$(if ($top -gt 0) { "  $(Fg '#facc15')$UP $top more (line $firstNo)$RESET" })$RESET") }
    $width = $cols - 11
    for ($v = $top; $v -lt [Math]::Min($views.Count, $top + $room); $v++) { $lines.Add((DrawView $views[$v] $width)) }
    $below = $views.Count - [Math]::Min($views.Count, $top + $room)
    if ($views.Count -gt 0) { $lines.Add("$DIM        $BL$rule$(if ($below -gt 0) { "  $(Fg '#facc15')$DN $below more$RESET" })$RESET") }
    # replay progress bar
    if ($replaying -and $show.action -ne 'reading') {
      $pctDone = [Math]::Min(100, [Math]::Round(100 * $elapsed / [Math]::Max(1, $play.ms)))
      $barW = 20; $barFilled = [Math]::Floor($barW * $pctDone / 100)
      $pbar = "$(Fg '#facc15')$([char]0x25B6) "
      for ($bi = 0; $bi -lt $barW; $bi++) { if ($bi -lt $barFilled) { $pbar += "$(Fg '#facc15')$([char]0x2501)" } else { $pbar += "$DIM$([char]0x254C)" } }
      $pbar += " $(Fg '#facc15')$pctDone%$RESET  ${DIM}$('{0:0.0}' -f ($elapsed / 1000))s$RESET"
      $lines.Add("        $pbar")
    }
  }

  $recent = @($data.history | Where-Object { $_.id -ne $show.id })
  $left = [Math]::Min(20, $rowsMax - $lines.Count - 3)
  if ($recent.Count -gt 0 -and $left -gt 0) {
    $lines.Add('')
    $lines.Add("$DIM-- recent ----------$RESET")
    [array]::Reverse($recent)
    foreach ($one in ($recent | Select-Object -First $left)) {
      $tag = $ACTION[$one.action]
      $c = if ($one.isError) { $INK.del } else { $tag.color }
      $icon = if ($one.isError) { 'x' } else { $tag.icon }
      $lines.Add("$DIM$(Clock $one.startedAt)$RESET $(Fg $c)$icon $(Clip (Where-Of $one) ($cols - 40))$RESET$(Counts $one.stats)$(Spark $one.stats)")
    }
  }

  [Console]::Write("$E[H" + (($lines | Select-Object -First ($rowsMax - 1)) -join "$E[K`n") + "$E[K$E[J")
}

# ── the loop: read the feed, queue new actions, play them one by one ─────────
Clear-Host
$last = $null; $data = $null; $frame = 0
$seen = New-Object 'System.Collections.Generic.HashSet[string]'
$queue = New-Object System.Collections.Generic.Queue[object]
$show = $null; $playedAt = 0; $first = $true
try {
  while ($true) {
    $stamp = (Get-Item $Feed).LastWriteTimeUtc
    if ($null -ne $stamp -and $stamp -ne $last) {
      $fresh = Get-Content $Feed -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($null -ne $fresh) {
        $data = $fresh; $last = $stamp
        # every finished action not seen yet joins the queue, oldest first;
        # on the first read the backlog is only marked seen, not replayed
        $items = @(@($data.history) + @($data.current) | Where-Object { $null -ne $_ -and $_.isDone } | Sort-Object startedAt)
        foreach ($item in $items) {
          if ($seen.Add($item.id) -and -not $first -and @($item.rows).Count -gt 0) { $queue.Enqueue($item) }
        }
        if ($first) { $show = $data.current; $playedAt = 0; $first = $false }
      }
    }
    $t = Now
    # the next queued action starts once the shown one has played and held;
    # a long queue skips the hold so the viewer catches up
    if ($queue.Count -gt 0) {
      $done = $null -eq $show -or ($t - $playedAt) -ge ((Playback $show).ms + $(if ($queue.Count -gt 2) { 150 } else { $HOLD_MS }))
      if ($done) { $show = $queue.Dequeue(); $playedAt = $t }
    }
    if ($null -eq $data) {
      [Console]::Write("$E[H$DIM$($SPINNER[$frame % 4]) Waiting for $Feed ...$RESET$E[K$E[J")
    } else {
      Draw $data $show $playedAt $queue.Count $t $frame
    }
    $frame++
    Start-Sleep -Milliseconds 50
  }
} finally {
  try { [Console]::CursorVisible = $true } catch {}
  [Console]::Write($RESET)
}
