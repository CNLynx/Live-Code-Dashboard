// Live Code dashboard, the tiles in detail: a tile opened large shows what
// lies behind its number, as charts whose every point, bar and stretch says on
// hover what it is. Loaded after the page's main script and extras.js, whose
// globals it uses (S, R, $, esc, money, dur, human, plural, hm, whenFull, …).
'use strict'
;(() => {

// ── small pieces ──
const exact = n => Math.round(n).toLocaleString()
const usd2 = v => '$' + (v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const at = t => (t ? new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '')
const stat = (label, value, sub = '') => `<div class="d-stat"><div class="d-l">${label}</div><div class="d-v num">${value}</div>${sub ? `<div class="d-s">${sub}</div>` : ''}</div>`
const stats = items => `<div class="d-stats">${items.join('')}</div>`
const section = (title, inner, note = '') => `<section class="d-sec"><h5>${title}${note ? `<span>${note}</span>` : ''}</h5>${inner}</section>`
const nothing = text => `<div class="d-empty">${esc(text)}</div>`
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0 }

// A chart for the large view: a line (each stretch its own color if asked) or
// bars, with a value scale, time or turn labels below, and for every point a
// hover band that names it exactly.
let chartNo = 0 // gradient ids, the same each redraw so the markup holds still
const W = 860, H = 210, PAD = { l: 52, r: 14, t: 12, b: 26 }
const chart = ({ points, kind = 'line', yFmt = v => String(v), xLabels = [], color = 'var(--s1)', stretchColor, area = true, extra = '', yMax, yMin = 0, guides = [] }) => {
  if (!points.length) return nothing('Nothing yet')
  const n = points.length
  const ys = points.map(p => p.y)
  const lo = Math.min(yMin, ...ys), hi = Math.max(yMax ?? 0, ...ys, lo + 1e-9)
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b
  const x = i => PAD.l + (kind === 'bars' ? (i + 0.5) * (iw / n) : n === 1 ? iw / 2 : (i / (n - 1)) * iw)
  const y = v => PAD.t + ih - ((v - lo) / (hi - lo)) * ih
  let s = '<g class="d-ax">'
  for (const f of [0, 0.5, 1]) { const v = lo + (hi - lo) * f; s += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${PAD.l - 8}" y="${y(v) + 4}" text-anchor="end">${esc(yFmt(v))}</text>` }
  for (const [i, label] of xLabels) s += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(label)}</text>`
  s += '</g>'
  for (const g of guides) s += `<line class="d-guide" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(g.v)}" y2="${y(g.v)}" style="stroke:${g.color}"/><text class="d-guide-t" x="${W - PAD.r}" y="${y(g.v) - 4}" text-anchor="end" style="fill:${g.color}">${esc(g.label)}</text>`
  if (kind === 'bars') {
    const bw = Math.max(2, (iw / n) * 0.7)
    points.forEach((p, i) => { const top = y(Math.max(p.y, lo)); s += `<rect x="${x(i) - bw / 2}" y="${top}" width="${bw}" height="${Math.max(1, y(lo) - top)}" rx="3" style="fill:${p.color ?? color}"/>` })
  } else {
    const id = `dg${++chartNo}`
    let stops = ''
    if (stretchColor) for (let i = 1; i < n; i++) { const c = stretchColor(points[i - 1], points[i]); stops += `<stop offset="${(x(i - 1) / W) * 100}%" style="stop-color:${c}"/><stop offset="${(x(i) / W) * 100}%" style="stop-color:${c}"/>` }
    const paint = stretchColor ? `url(#${id})` : color
    const line = 'M' + points.map((p, i) => `${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join('L')
    if (stretchColor) s += `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" x2="${W}" y1="0" y2="0">${stops}</linearGradient></defs>`
    if (area) s += `<path d="${line}L${x(n - 1)},${y(lo)}L${x(0)},${y(lo)}Z" fill="${paint}" fill-opacity=".13"/>`
    s += `<path d="${line}" fill="none" stroke="${paint}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`
    points.forEach((p, i) => { s += `<circle class="d-dot" cx="${x(i)}" cy="${y(p.y)}" r="${n > 60 ? 1.6 : 3}" style="fill:${p.color ?? (stretchColor && i ? stretchColor(points[i - 1], p) : color)}"/>` })
  }
  s += extra
  // the hover bands: one per point, as wide as its share of the chart
  const band = iw / (kind === 'bars' ? n : Math.max(1, n - 1))
  points.forEach((p, i) => { s += `<rect class="d-hit" x="${x(i) - band / 2}" y="${PAD.t}" width="${band}" height="${ih}" data-tip="${esc(p.tip)}"/>` })
  return `<svg class="d-chart" viewBox="0 0 ${W} ${H}">${s}</svg>`
}
// one horizontal bar of parts, each part its own hover text
const parts = (items, height = 18) => {
  const total = items.reduce((a, p) => a + p.value, 0) || 1
  return `<div class="d-parts" style="height:${height}px">${items.filter(p => p.value > 0).map(p => `<div style="flex:${p.value / total};background:${p.color}" data-tip="${esc(p.tip)}"></div>`).join('')}</div>`
}
const xTimes = (list, key = 'at', n = 5) => {
  const out = []
  if (!list.length) return out
  for (let k = 0; k < n; k++) { const i = Math.round((k / (n - 1)) * (list.length - 1)); if (list[i]?.[key] && !out.some(o => o[0] === i)) out.push([i, hm(list[i][key])]) }
  return out
}

// ── each tile ──
const DETAIL = {}

DETAIL.cost = snap => {
  const u = snap.usage ?? {}
  const turns = (snap.turnStats ?? []).filter(t => t.usd != null)
  const costs = turns.map(t => t.usd)
  const top = turns.reduce((m, t) => (!m || t.usd > m.usd ? t : m), null)
  const last = turns.at(-1)
  // since the session's first sign: its first turn, sample or action seen
  const first = Math.min(
    snap.sessionStart || Infinity,
    ...turns.filter(t => t.at).map(t => t.at - t.ms),
    ...S.samples.filter(s => s.sid === S.view).map(s => s.t),
    ...S.actions.filter(a => a.sid === S.view).map(a => a.startedAt),
  )
  const hours = Math.max(1 / 60, (Date.now() - (Number.isFinite(first) ? first : Date.now())) / 3600e3)
  const all = sum([...S.sessions.values()], s => s.snap?.usage?.usd)
  const points = turns.map((t, i) => ({
    y: t.usd,
    tip: `Turn ${t.no}${t.at ? `\nended ${at(t.at)}` : ''}\n${usd2(t.usd)}${i ? ` (${t.usd >= turns[i - 1].usd ? '▲' : '▼'} ${usd2(Math.abs(t.usd - turns[i - 1].usd))} vs the turn before)` : ''}\n${dur(t.ms)} · ${plural(t.steps, 'step')}${t.failed ? ` · ${t.failed} failed` : ''}\n${human(t.tokensIn)} tokens in · ${human(t.tokensOut)} out`,
  }))
  return stats([
    stat('This session', usd2(u.usd)),
    stat('Per turn', usd2(costs.length ? sum(costs, c => c) / costs.length : 0), `median ${usd2(median(costs))}`),
    stat('Per hour', usd2((u.usd ?? 0) / hours), `over ${dur(hours * 3600e3)}`),
    stat('Last turn', last ? usd2(last.usd) : '—', last?.at ? hm(last.at) : ''),
    stat('Most expensive', top ? usd2(top.usd) : '—', top ? `turn ${top.no}${top.at ? ' · ' + hm(top.at) : ''}` : ''),
    stat('All chats', usd2(all), plural(S.sessions.size, 'chat')),
  ]) + section('Cost of each turn', chart({
    points, yFmt: v => usd2(v), xLabels: turns.some(t => t.at) ? xTimes(turns) : turns.map((t, i) => [i, `T${t.no}`]).filter((_, i, a) => i % Math.ceil(a.length / 8) === 0),
    stretchColor: (a, b) => (b.y > a.y ? 'var(--crit)' : b.y < a.y ? 'var(--good)' : 'var(--axis)'),
    guides: costs.length ? [{ v: sum(costs, c => c) / costs.length, label: `Ø ${usd2(sum(costs, c => c) / costs.length)}`, color: 'var(--muted)' }] : [],
  }), 'red: dearer than the turn before · green: cheaper · hover a point for the turn')
}

DETAIL['context-window'] = snap => {
  const u = snap.usage ?? {}
  const sid = S.view
  const samples = S.samples.filter(s => s.sid === sid && s.ctx != null).slice(-240)
  const points = samples.map((s, i) => ({
    y: s.ctx,
    tip: `${at(s.t)}\n${Math.round(s.ctx)}% of the window${s.tokens ? ` · ${exact(s.tokens)} tokens` : ''}${i && samples[i - 1].ctx - s.ctx > 15 ? '\n↓ compacted here' : ''}`,
    color: i && samples[i - 1].ctx - s.ctx > 15 ? 'var(--s5)' : undefined,
  }))
  const compactions = samples.filter((s, i) => i && samples[i - 1].ctx - s.ctx > 15).length
  // how fast it fills: over the turns that ended, the context each added
  const turns = (snap.turnStats ?? []).filter(t => t.at)
  const ctxAt = t => samples.reduce((m, s) => (s.t <= t ? s : m), null)?.ctx
  const grows = turns.slice(-8).map((t, i, a) => (i ? (ctxAt(t.at) ?? 0) - (ctxAt(a[i - 1].at) ?? 0) : null)).filter(v => v != null && v > 0)
  const perTurn = grows.length ? sum(grows, g => g) / grows.length : null
  const left = Math.max(0, (u.window ?? 0) - (u.tokens ?? 0))
  return stats([
    stat('Used', `${Math.round(u.percent ?? 0)}%`, `${exact(u.tokens ?? 0)} of ${exact(u.window ?? 0)} tokens`),
    stat('Left', exact(left), 'tokens'),
    stat('Per turn', perTurn != null ? `+${perTurn.toFixed(1)}%` : '—', 'the last turns, on average'),
    stat('Full in', perTurn ? `~${Math.max(0, Math.floor((100 - (u.percent ?? 0)) / perTurn))} turns` : '—', 'at that pace'),
    stat('Compacted', String(compactions), 'times in this view'),
  ]) + section('The context window over time', chart({
    points, yFmt: v => `${Math.round(v)}%`, yMax: 100, xLabels: xTimes(samples, 't'), color: 'var(--s1)',
    guides: [{ v: warnAt(), label: `${warnAt()}%`, color: 'var(--warn)' }, { v: critAt(), label: `${critAt()}%`, color: 'var(--crit)' }],
  }), 'a drop is a compaction')
}

const limitDetail = kind => snap => {
  const l = (snap.usage?.limits ?? []).find(x => x.kind === kind)
  if (!l) return nothing('No data for this limit yet')
  const safe = limitSafety(l)
  // the chat shown, within the limit's present window: a quiet chat keeps
  // reporting what it last saw, and would zigzag the line with old values
  const SPAN = { five_hour: 5 * 3600e3, seven_day: 7 * 86400e3, seven_day_opus: 7 * 86400e3, seven_day_sonnet: 7 * 86400e3 }
  const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : null
  const from = resetsAt && SPAN[kind] ? resetsAt - SPAN[kind] : 0
  const samples = S.samples.filter(s => s.sid === S.view && s.t >= from && s.limits?.[kind] != null).sort((a, b) => a.t - b.t)
  const keep = samples.filter((s, i) => i === 0 || s.limits[kind] !== samples[i - 1].limits[kind] || i === samples.length - 1).slice(-200)
  const points = keep.map((s, i) => ({ y: s.limits[kind], tip: `${at(s.t)}\n${Math.round(s.limits[kind])}% used${i && s.limits[kind] < keep[i - 1].limits[kind] - 5 ? '\n↺ reset before this' : ''}` }))
  const resetAt = safe.resetIn != null ? Date.now() + safe.resetIn : null
  return stats([
    stat('Used', `${Math.round(l.percent)}%`, `${100 - Math.round(l.percent)}% left`),
    stat('Resets', resetAt ? whenHm(resetAt) : '—', resetAt ? `${at(resetAt)} · in ${dur(safe.resetIn)}` : ''),
    stat('Pace now', l.ratePerHour != null ? `+${l.ratePerHour.toFixed(1)}%/h` : '—', 'over the last half hour'),
    stat('Safe pace', safe.safeRate != null ? `≤ ${safe.safeRate.toFixed(1)}%/h` : '—', 'lasts until the reset'),
    stat(safe.isSafe ? 'Status' : 'Full at', safe.isSafe ? '✓ safe' : whenHm(Date.now() + safe.etaMs), safe.isSafe ? 'at this pace it lasts' : `pause ~${dur(safe.pauseMs)} to stay under 100%`),
  ]) + section(`${limitName(kind)} limit over time`, chart({
    points, yFmt: v => `${Math.round(v)}%`, yMax: 100, xLabels: xTimes(keep, 't'), color: 'var(--s2)',
    guides: [{ v: warnAt(), label: `${warnAt()}%`, color: 'var(--warn)' }, { v: critAt(), label: `${critAt()}%`, color: 'var(--crit)' }],
  }), 'the share used, as each request reported it')
}
DETAIL['5h-limit'] = limitDetail('five_hour')
DETAIL['7d-limit'] = limitDetail('seven_day')

DETAIL.tokens = snap => {
  const u = snap.usage ?? {}
  const turns = (snap.turnStats ?? []).slice(-40)
  return stats([
    stat('Out', exact(u.output ?? 0), 'written by Claude'),
    stat('In', exact(u.input ?? 0), 'read, the cache included'),
    stat('Ratio', u.output ? `${Math.round(u.input / u.output)}:1` : '—', 'in per token out'),
    stat('Per turn out', turns.length ? exact(sum(turns, t => t.tokensOut) / turns.length) : '—', 'on average'),
  ]) + section('Tokens out per turn', chart({
    kind: 'bars', points: turns.map(t => ({ y: t.tokensOut, tip: `Turn ${t.no}${t.at ? ' · ' + at(t.at) : ''}\n${exact(t.tokensOut)} out · ${exact(t.tokensIn)} in\n${dur(t.ms)}${t.usd != null ? ' · ' + usd2(t.usd) : ''}` })),
    yFmt: v => human(v), xLabels: xTimes(turns), color: 'var(--s3)',
  })) + section('Tokens in per turn', chart({
    kind: 'bars', points: turns.map(t => ({ y: t.tokensIn, tip: `Turn ${t.no}\n${exact(t.tokensIn)} in (the cache included)` })),
    yFmt: v => human(v), xLabels: xTimes(turns), color: 'var(--s4)',
  }), 'every request reads the whole conversation again, mostly from the cache')
}

DETAIL['lines-changed'] = () => {
  const acts = inRange()
  const add = sum(acts, a => a.stats?.add), mod = sum(acts, a => a.stats?.mod), del = sum(acts, a => a.stats?.del)
  const byFile = new Map()
  for (const a of acts) {
    if (a.action !== 'editing' && a.action !== 'writing') continue
    const f = byFile.get(a.file) ?? { file: a.file, add: 0, mod: 0, del: 0, edits: 0, last: 0 }
    f.add += a.stats?.add ?? 0; f.mod += a.stats?.mod ?? 0; f.del += a.stats?.del ?? 0; f.edits++; f.last = Math.max(f.last, a.startedAt)
    byFile.set(a.file, f)
  }
  const files = [...byFile.values()].sort((a, b) => b.add + b.mod + b.del - (a.add + a.mod + a.del)).slice(0, 14)
  // each file's bar as long as its share of the most changed one
  const most = files.length ? files[0].add + files[0].mod + files[0].del : 1
  const lineParts = f => `<div style="width:${Math.max(2, ((f.add + f.mod + f.del) / most) * 100)}%">` + parts([
    { value: f.add, color: 'var(--add)', tip: `${baseName(f.file)}\n+${exact(f.add)} added: lines that were not there before` },
    { value: f.mod, color: 'var(--mod)', tip: `${baseName(f.file)}\n~${exact(f.mod)} changed: lines rewritten in place` },
    { value: f.del, color: 'var(--del)', tip: `${baseName(f.file)}\n−${exact(f.del)} removed: lines taken out` },
  ], 10) + '</div>'
  return stats([
    stat('In all', exact(add + mod + del), 'lines touched'),
    stat('Added', `+${exact(add)}`, 'new lines'),
    stat('Changed', `~${exact(mod)}`, 'rewritten in place'),
    stat('Removed', `−${exact(del)}`, 'taken out'),
    stat('Files', String(byFile.size), 'edited or written'),
  ]) + section('All of it', parts([
    { value: add, color: 'var(--add)', tip: `Added: ${exact(add)} lines\nlines that did not exist before: new code, new files` },
    { value: mod, color: 'var(--mod)', tip: `Changed: ${exact(mod)} lines\nlines that were there and were rewritten in place` },
    { value: del, color: 'var(--del)', tip: `Removed: ${exact(del)} lines\nlines taken out without a replacement` },
  ], 22), 'hover a part') + section('Most changed files', files.length ? `<div class="d-rows">${files.map(f => `<div class="d-row" data-tip="${esc(`${f.file}\n${plural(f.edits, 'edit')} · last ${at(f.last)}\n+${f.add} ~${f.mod} −${f.del}`)}"><span class="d-name">${esc(baseName(f.file))}</span><span class="d-bar">${lineParts(f)}</span><span class="d-num num"><b class="stat-add">+${exact(f.add)}</b> <b class="stat-mod">~${exact(f.mod)}</b> <b class="stat-del">−${exact(f.del)}</b></span></div>`).join('')}</div>` : nothing('No file changed yet'))
}

DETAIL.files = snap => {
  const list = [...(snap.fileStats ?? [])].sort((a, b) => b.lastAt - a.lastAt).slice(0, 30)
  const edited = list.filter(f => f.edits > 0).length
  return stats([
    stat('Files', String((snap.fileStats ?? []).length), 'touched this session'),
    stat('Edited', String(edited), 'changed at least once'),
    stat('Only read', String(list.length - edited), 'looked at, left as they were'),
    stat('Reads', exact(sum(snap.fileStats ?? [], f => f.reads)), 'in all'),
  ]) + section('Each file, the newest first', list.length ? `<table class="d-table"><thead><tr><th>File</th><th>Folder</th><th class="r">Reads</th><th class="r">Edits</th><th class="r">Lines</th><th class="r">Last</th></tr></thead><tbody>${list.map(f => `<tr data-tip="${esc(f.file)}"><td><b>${esc(baseName(f.file))}</b></td><td class="muted">${esc(dirName(f.file).split(/[\\/]/).filter(Boolean).slice(-2).join('/'))}</td><td class="r num">${f.reads}</td><td class="r num">${f.edits}</td><td class="r num"><span class="stat-add">+${f.add}</span> <span class="stat-mod">~${f.mod}</span> <span class="stat-del">−${f.del}</span></td><td class="r num muted">${hm(f.lastAt)}</td></tr>`).join('')}</tbody></table>` : nothing('No file yet'))
}

DETAIL['tool-calls'] = () => {
  const acts = inRange()
  // per minute, the last hour that saw work
  const end = Math.max(...acts.map(a => a.startedAt), Date.now())
  const from = Math.max(end - 60 * 60e3, acts[0]?.startedAt ?? end)
  const minutes = Math.max(1, Math.ceil((end - from) / 60e3))
  const buckets = Array.from({ length: minutes }, (_, i) => ({ t: from + i * 60e3, n: 0, kinds: {} }))
  for (const a of acts) { const i = Math.floor((a.startedAt - from) / 60e3); if (i >= 0 && i < minutes) { buckets[i].n++; const k = KIND[kindOf(a)]?.label ?? 'Other'; buckets[i].kinds[k] = (buckets[i].kinds[k] ?? 0) + 1 } }
  const kinds = new Map()
  for (const a of acts) { const k = kindOf(a); const e = kinds.get(k) ?? { k, n: 0, ms: 0, timed: 0, failed: 0 }; e.n++; if (tookOf(a) != null) { e.ms += tookOf(a); e.timed++ } if (a.isError) e.failed++; kinds.set(k, e) }
  const rows = [...kinds.values()].sort((a, b) => b.n - a.n)
  const most = rows[0]?.n || 1
  return stats([
    stat('Tool calls', exact(acts.length), 'in the range shown'),
    stat('Per minute', (acts.length / Math.max(1, (Date.now() - rangeStart()) / 60e3)).toFixed(1), 'on average'),
    stat('Busiest minute', String(Math.max(0, ...buckets.map(b => b.n))), buckets.length ? hm(buckets.reduce((m, b) => (b.n > m.n ? b : m), buckets[0]).t) : ''),
  ]) + section('Calls per minute', chart({
    kind: 'bars', points: buckets.map(b => ({ y: b.n, tip: `${hm(b.t)}–${hm(b.t + 60e3)}\n${plural(b.n, 'call')}${b.n ? '\n' + Object.entries(b.kinds).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · ') : ''}` })),
    yFmt: v => String(Math.round(v)), xLabels: xTimes(buckets, 't'), color: 'var(--s2)',
  }), 'the last hour with work') + section('By kind', `<div class="d-rows">${rows.map(r => `<div class="d-row" data-tip="${esc(`${KIND[r.k]?.label ?? r.k}: ${r.n} calls\n${r.timed ? `Ø ${dur(r.ms / r.timed)} each` : ''}${r.failed ? `\n${r.failed} failed` : ''}`)}"><span class="d-name"><span class="dot" style="background:${kindVar(r.k)}"></span>${esc(KIND[r.k]?.label ?? r.k)}</span><span class="d-bar"><div class="d-parts" style="height:10px"><div style="flex:${r.n / most};background:${kindVar(r.k)}"></div><div style="flex:${1 - r.n / most}"></div></div></span><span class="d-num num">${r.n}${r.timed ? ` · Ø ${dur(r.ms / r.timed)}` : ''}</span></div>`).join('')}</div>`)
}

DETAIL.turn = snap => {
  const th = snap.thinking ?? {}
  const live = th.turnStartedAt && (th.turnEndedAt ?? 0) < th.turnStartedAt
  const turns = (snap.turnStats ?? []).slice(-40)
  const steps = (snap.steps ?? []).filter(s => !s.agentId)
  const ms = turns.map(t => t.ms)
  return stats([
    stat(live ? 'This turn' : 'Last turn', live ? `<span data-since="${th.turnStartedAt}"></span>` : turns.length ? dur(turns.at(-1).ms) : '—', live ? `since ${hm(th.turnStartedAt)} · ${plural(steps.length, 'step')}` : turns.at(-1)?.at ? `ended ${hm(turns.at(-1).at)}` : ''),
    stat('Ø a turn', ms.length ? dur(sum(ms, m => m) / ms.length) : '—', `median ${dur(median(ms))}`),
    stat('Longest', ms.length ? dur(Math.max(...ms)) : '—', ms.length ? `turn ${turns[ms.indexOf(Math.max(...ms))].no}` : ''),
    stat('Turns', String((snap.turnStats ?? []).length), 'this session'),
  ]) + section('How long each turn took', chart({
    kind: 'bars', points: turns.map(t => ({ y: t.ms / 60e3, tip: `Turn ${t.no}${t.at ? `\nended ${at(t.at)}` : ''}\n${dur(t.ms)} · ${plural(t.steps, 'step')}${t.usd != null ? ' · ' + usd2(t.usd) : ''}`, color: t.failed ? 'var(--serious)' : undefined })),
    yFmt: v => `${v.toFixed(v < 10 ? 1 : 0)}m`, xLabels: xTimes(turns), color: 'var(--s1)',
  }), 'orange: a turn with failed steps') + (live && steps.length ? section('This turn, step by step', `<div class="d-rows">${steps.slice(-14).map(s => `<div class="d-row"><span class="d-name"><span class="dot" style="background:${s.status === 'error' ? 'var(--crit)' : kindVar(s.kind in KIND ? s.kind : 'other')}"></span>${esc(s.label)}</span><span class="d-num num muted">${hm(s.startedAt)} · ${s.doneAt ? dur(s.doneAt - s.startedAt) : 'running'}</span></div>`).join('')}</div>`) : '')
}

DETAIL.errors = () => {
  const acts = inRange()
  const failed = acts.filter(a => a.isError).slice(-30).reverse()
  const byKind = new Map()
  for (const a of acts) { const k = kindOf(a); const e = byKind.get(k) ?? { n: 0, bad: 0 }; e.n++; if (a.isError) e.bad++; byKind.set(k, e) }
  return stats([
    stat('Failed', String(acts.filter(a => a.isError).length), `of ${exact(acts.length)} tool calls`),
    stat('Rate', acts.length ? `${((acts.filter(a => a.isError).length / acts.length) * 100).toFixed(1)}%` : '—', 'failed'),
    ...[...byKind.entries()].filter(([, e]) => e.bad).map(([k, e]) => stat(KIND[k]?.label ?? k, `${e.bad}`, `of ${e.n} · ${((e.bad / e.n) * 100).toFixed(0)}%`)),
  ]) + section('Each failure, the newest first', failed.length ? `<div class="d-rows">${failed.map(a => `<div class="d-row" data-tip="${esc(`${a.file}\n${a.detail ?? a.rows?.[0]?.text ?? ''}`)}"><span class="d-name"><span class="dot" style="background:var(--crit)"></span>${esc(ACTION_LABEL[a.action] ?? a.action)} <b>${esc(a.action === 'running' ? (a.detail ?? a.file) : where(a))}</b></span><span class="d-num num muted">${at(a.startedAt)}</span></div>`).join('')}</div>` : nothing('Nothing failed'))
}

// What the large view shows for a tile: its detail, under the tile's own head.
window.bigDetail = key => {
  chartNo = 0
  // any other limit Claude Code reports (7D Opus, …) by the name its tile has
  const other = !DETAIL[key] && (S.snap?.usage?.limits ?? []).find(l => tileKey(`${limitName(l.kind)} limit`) === key)
  const make = DETAIL[key] ?? (other ? limitDetail(other.kind) : undefined)
  const snap = S.snap ?? {}
  const src = document.querySelector(`#tiles [data-tile="${key}"]`)
  const label = src?.querySelector('.label')?.innerHTML ?? key
  const value = src?.querySelector('.value')?.innerHTML ?? ''
  // amber, red or just-reset as the tile is: the panel wears the same edge
  const level = ['lvl-warn', 'lvl-crit', 'lvl-reset'].find(c => src?.classList.contains(c)) ?? ''
  return `<div class="d-panel ${level}"><div class="d-head"><div class="d-title">${label}</div><div class="d-value">${value}</div></div>${make ? make(snap) : ''}</div>`
}
})()
