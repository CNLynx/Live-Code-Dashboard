// Live Code dashboard, the extras: Claude's questions answered here, stopping a
// turn, a turn played back as a film, every change to a file in one view, the
// summary read aloud by a natural voice (Edge's, or ElevenLabs'), and an alarm when Claude
// seems stuck. Loaded after the page's main script, whose globals it uses
// (S, R, $, esc, store, start, projectOf, notesOf, …).
'use strict'

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Live-Code-Secret': SECRET }, body: JSON.stringify(body) })

// beside the byline: the version installed, and the newest on GitHub
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false }
let versions = { version: '', latest: '' }
let updateState = { state: 'idle' }
const showVersion = () => fetch('/about').then(r => r.json()).then(a => {
  if (!a.version) return
  versions = a
  const up = a.latest && newer(a.latest, a.version)
  const checked = a.latestCheckedAt ? new Date(a.latestCheckedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
  $('#ver-installed').textContent = `installed v${a.version}`
  const el = $('#ver-latest')
  // (newer than GitHub: a version not released yet, or one GitHub does not show yet)
  const ahead = a.latest && newer(a.version, a.latest)
  el.textContent = !a.latest ? 'latest: checking…' : up ? `v${a.latest} available ↑` : ahead ? `GitHub v${a.latest} · yours is newer` : `latest v${a.latest} ✓`
  el.className = `v-latest${up ? ' update' : ahead ? ' ahead' : !a.latest ? ' unknown' : ''}`
  el.title = `Newest on GitHub: ${a.latest ? `v${a.latest}` : 'not known yet'}${checked ? ` (checked ${checked})` : ''}${up ? '\nClick to install it' : ''}`
  el.onclick = up ? () => startUpdate() : null
  drawTiles()
}).catch(() => {})
showVersion()
// (the first answer may come before GitHub's), then now and then
setTimeout(showVersion, 8000)
setInterval(showVersion, 10 * 60_000)

// The update tile: there while a newer version is out, or while one installs.
window.updateTile = () => {
  const up = versions.latest && newer(versions.latest, versions.version)
  const st = updateState.state
  if (!up && st !== 'running' && st !== 'done' && st !== 'failed') return ''
  const [cls, label, value, foot] =
    st === 'running' ? ['busy', 'Updating', `v${versions.latest}`, esc(updateState.step || 'Working…')]
    : st === 'done' ? ['busy', 'Updated', `v${updateState.version || versions.latest}`, `${esc(updateState.step || 'Restarting…')}<br>Restart Claude for the mod`]
    : st === 'failed' ? ['failed', 'Update failed', '✗ Try again', esc(updateState.error || 'Something went wrong')]
    : ['', 'Update available', `v${versions.latest}`, `installed v${esc(versions.version)} · click to install`]
  return `<div class="card tile update-tile ${cls}" title="${st === 'idle' || st === 'failed' ? 'Install the newest version from GitHub' : ''}"><div class="label">⬆ ${label}</div><div class="value">${value}</div><div class="foot">${foot}</div></div>`
}
window.onUpdateState = u => {
  updateState = u ?? { state: 'idle' }
  drawTiles()
}
window.startUpdate = () => {
  if (updateState.state === 'running' || updateState.state === 'done') return
  updateState = { state: 'running', step: 'Starting…' }
  drawTiles()
  post('/update', {}).then(r => r.json()).then(j => window.onUpdateState(j.update)).catch(() => window.onUpdateState({ state: 'failed', error: 'The dashboard server did not answer' }))
}
fetch('/update').then(r => r.json()).then(j => { if (j.update?.state !== 'idle') window.onUpdateState(j.update) }).catch(() => {})

// A few notes, as the chime is made: a question rings brighter, the alarm lower.
const playNotes = (notes, { type = 'sine', vol = 0.5, decay = 0.7, force = false } = {}) => {
  if (!soundOn && !force) return
  const ac = audioCtx()
  if (!ac) return
  const t0 = ac.currentTime + 0.03
  const out = ac.createGain()
  out.gain.value = toneGain()
  out.connect(ac.destination)
  for (const [freq, delay] of notes) {
    const osc = ac.createOscillator()
    const env = ac.createGain()
    osc.type = type
    osc.frequency.value = freq
    env.gain.setValueAtTime(0.0001, t0 + delay)
    env.gain.exponentialRampToValueAtTime(vol, t0 + delay + 0.015)
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + decay)
    osc.connect(env).connect(out)
    osc.start(t0 + delay)
    osc.stop(t0 + delay + decay + 0.05)
  }
}
const QUESTION_TONE = [[784, 0], [1175, 0.14], [1568, 0.28]]
const PERMISSION_TONE = [[988, 0], [740, 0.16], [988, 0.32]]
const ALARM_TONE = [[392, 0], [330, 0.2], [392, 0.4], [330, 0.6]]

const smallToast = (text, cls = '') => {
  const t = document.createElement('div')
  t.className = `done-toast ${cls}`
  t.innerHTML = `<span class="tick">${cls === 'bad' ? '!' : '✓'}</span><b>${esc(text)}</b><span></span>`
  toasts.prepend(t)
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 500) }, 3500)
}

// ════════════════════════════════════════════════════════════════════════════
// a usage limit resets: a chime of its own, a toast, the tile lit green
// ════════════════════════════════════════════════════════════════════════════
// a bright run up two octaves (C5 E5 G5 C6 E6), rounder than the done-chime
const RESET_TONE = [[523.25, 0], [659.25, 0.08], [783.99, 0.16], [1046.5, 0.24], [1318.5, 0.36]]
window.limitFlash = {}
const resetArmed = new Map()
// the limits are the account's: any chat that knows them will do
const limitsNow = () => S.snap?.usage?.limits ?? [...S.sessions.values()].find(s => s.snap?.usage?.limits?.length)?.snap.usage.limits ?? []
const limitReset = l => {
  if (toneOn('lc.toneReset')) playNotes(RESET_TONE, { type: 'triangle', vol: 0.5, decay: 1.2 })
  smallToast(`${limitName(l.kind)} limit reset · back to 0%`)
  window.limitFlash[l.kind] = Date.now() + 8000
  drawTiles()
}
// armed while its reset lies ahead; rings once when the clock passes it
setInterval(() => {
  const t = Date.now()
  for (const l of limitsNow()) {
    const at = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    if (!Number.isFinite(at)) continue
    if (at > t) resetArmed.set(l.kind, at)
    else if (resetArmed.get(l.kind) === at) { resetArmed.delete(l.kind); limitReset(l) }
  }
}, 1000)

// ════════════════════════════════════════════════════════════════════════════
// Claude's questions and permission prompts, answered here
// ════════════════════════════════════════════════════════════════════════════
const askWrap = $('#ask-wrap')
const askBox = $('#ask')
const askPill = $('#ask-pill')
const answersOn = () => store.get('lc.answers') !== 'off'
const askKey = a => `${a.sid}|${a.id}`
let shown = null // the ask in the popup
const later = new Set() // asks put aside with "Later"
const answered = new Map() // ask key -> when it was answered here: not shown again while its chat catches up
const picks = new Map() // ask key -> per question: { set: Set of labels, other: text }
let rang = { key: '', at: 0, times: 0 }
let titleBlink = 0
const baseTitle = document.title

const allAsks = () => {
  const out = []
  for (const s of S.sessions.values()) {
    if (!s.snap?.session?.canAnswer || s.snap.session.isEnded) continue
    for (const a of s.snap.asks ?? []) out.push({ ...a, sid: s.id, chat: projectOf(s) })
  }
  return out.sort((a, b) => a.at - b.at)
}

const askHtml = (a, index, count) => {
  const head = `<div class="top"><span class="badge">${a.kind === 'permission' ? '⚠ Allow?' : '? Claude asks'}</span><span>${esc(a.chat)}${a.agentId ? ' · subagent' : ''}</span>` +
    `<span class="spacer"></span><span class="num" data-since="${a.at}"></span>${count > 1 ? `<span>· ${index + 1} of ${count}</span>` : ''}</div>`
  if (a.kind === 'permission') {
    return head +
      `<h3 id="ask-title">${esc(a.title)}</h3>` +
      (a.detail && a.detail !== a.title ? `<pre>${esc(a.detail)}</pre>` : '') +
      (a.reason ? `<div class="why">${esc(a.reason)}</div>` : '') +
      `<div class="acts"><button class="bt yes" data-a="allow">✓ Allow<kbd>A</kbd></button><button class="bt no" data-a="deny">✗ Deny<kbd>D</kbd></button>` +
      `<input type="text" id="ask-why" placeholder="Why not? (optional, Claude reads it)" style="flex:1;min-width:170px"></div>` +
      `<div class="acts"><span class="note">Allows only this one call.</span><span class="grow"></span><button class="bt plain" data-a="dialog" title="Answer it in the Claude window instead">Usual dialog</button><button class="bt plain" data-a="later">Later<kbd>Esc</kbd></button></div>`
  }
  const state = picks.get(askKey(a)) ?? []
  const qs = (a.questions ?? []).map((q, qi) => {
    const st = state[qi] ?? { set: new Set(), other: '' }
    let body
    if (q.kind === 'text') body = `<textarea data-text="${qi}" placeholder="${esc(q.placeholder ?? 'Your answer…')}">${esc(st.other)}</textarea>`
    else if (q.kind === 'number') body = `<input type="number" data-text="${qi}" ${q.min != null ? `min="${q.min}"` : ''} ${q.max != null ? `max="${q.max}"` : ''} ${q.step != null ? `step="${q.step}"` : ''} value="${esc(st.other)}"> ${esc(q.unit ?? '')}`
    else {
      body = `<div class="opts">${q.options.map((o, oi) => `<button class="opt${st.set.has(o.label) ? ' on' : ''}" data-q="${qi}" data-o="${oi}"><span class="k">${q.multiSelect ? (st.set.has(o.label) ? '✓' : '') : oi + 1}</span><b>${esc(o.label)}</b>${o.description ? `<span class="d">${esc(o.description)}</span>` : ''}</button>`).join('')}</div>` +
        `<input type="text" class="other" data-text="${qi}" placeholder="Or type your own answer…" value="${esc(st.other)}">`
    }
    return `<div class="q"><span class="hd">${esc(q.header || 'Question')}${q.multiSelect ? ' · pick any' : ''}</span><div class="qt"${qi === 0 ? ' id="ask-title"' : ''}>${esc(q.question)}</div>${body}</div>`
  }).join('')
  return head + qs +
    `<div class="acts"><button class="bt go" data-a="answer">Send answer<kbd>Enter</kbd></button><span class="grow"></span>` +
    `<button class="bt plain" data-a="dialog" title="Answer it in the Claude window instead">Usual dialog</button><button class="bt plain" data-a="later">Later<kbd>Esc</kbd></button></div>`
}

const stateOf = a => {
  const key = askKey(a)
  if (!picks.has(key)) picks.set(key, (a.questions ?? []).map(() => ({ set: new Set(), other: '' })))
  return picks.get(key)
}

const openAsk = (a, index, count) => {
  const isNew = shown === null || askKey(shown) !== askKey(a)
  shown = a
  askBox.className = `ask ${a.kind}`
  askBox.innerHTML = askHtml(a, index, count)
  askWrap.hidden = false
  if (isNew) {
    if (rang.key !== askKey(a)) {
      rang = { key: askKey(a), at: Date.now(), times: 1 }
      if (toneOn('lc.toneAsk')) playNotes(a.kind === 'permission' ? PERMISSION_TONE : QUESTION_TONE, { force: true })
    }
    const first = askBox.querySelector(a.kind === 'permission' ? '.bt.yes' : '.opt, textarea, input[type=number]')
    first?.focus({ preventScroll: true })
  }
}
const closeAsk = () => {
  shown = null
  askWrap.hidden = true
  askBox.innerHTML = ''
}

const sendAnswer = async (a, answer) => {
  for (const b of askBox.querySelectorAll('button')) b.disabled = true
  try {
    const r = await post('/send', { sid: a.sid, kind: 'answer', askId: a.id, answer })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.status)
    later.delete(askKey(a))
    picks.delete(askKey(a))
    answered.set(askKey(a), Date.now())
    closeAsk()
    smallToast(answer.decision === 'allow' ? `Allowed in “${a.chat}”` : answer.decision === 'deny' ? `Denied in “${a.chat}”` : answer.decision === 'dialog' ? `Now in the Claude window of “${a.chat}”` : `Answer sent to “${a.chat}”`)
  } catch (error) {
    for (const b of askBox.querySelectorAll('button')) b.disabled = false
    smallToast(`Not sent: ${error.message}`, 'bad')
  }
}

const answerOf = a => {
  const st = stateOf(a)
  const answers = {}
  ;(a.questions ?? []).forEach((q, qi) => {
    const s = st[qi]
    const other = s.other.trim()
    const chosen = [...s.set]
    const value = q.kind === 'text' || q.kind === 'number' ? other : [...chosen, ...(other ? [other] : [])].join(', ')
    if (value !== '') answers[q.question] = value
  })
  return { decision: 'answer', answers }
}

askBox.addEventListener('click', e => {
  const a = shown
  if (!a) return
  const opt = e.target.closest('.opt')
  if (opt) {
    const q = a.questions[Number(opt.dataset.q)]
    const s = stateOf(a)[Number(opt.dataset.q)]
    const label = q.options[Number(opt.dataset.o)].label
    if (q.multiSelect) { if (s.set.has(label)) s.set.delete(label); else s.set.add(label) } else { s.set = new Set([label]); s.other = '' }
    const keepFocus = { q: opt.dataset.q, o: opt.dataset.o }
    drawAsks(true)
    askBox.querySelector(`.opt[data-q="${keepFocus.q}"][data-o="${keepFocus.o}"]`)?.focus({ preventScroll: true })
    // one simple question: a pick is the answer
    if (!q.multiSelect && a.questions.length === 1) sendAnswer(a, answerOf(a))
    return
  }
  const act = e.target.closest('[data-a]')?.dataset.a
  if (!act) return
  if (act === 'later') { later.add(askKey(a)); closeAsk(); return }
  if (act === 'answer') { sendAnswer(a, answerOf(a)); return }
  if (act === 'deny') { sendAnswer(a, { decision: 'deny', reason: $('#ask-why')?.value ?? '' }); return }
  sendAnswer(a, { decision: act })
})
askBox.addEventListener('input', e => {
  const qi = e.target.dataset?.text
  if (qi === undefined || !shown) return
  const s = stateOf(shown)[Number(qi)]
  s.other = e.target.value
  const q = shown.questions[Number(qi)]
  // typing your own answer replaces a single pick
  if (!q.multiSelect && s.other.trim() !== '' && s.set.size > 0) { s.set = new Set(); for (const o of askBox.querySelectorAll(`.opt[data-q="${qi}"]`)) o.classList.remove('on') }
})
document.addEventListener('keydown', e => {
  if (!shown || askWrap.hidden) return
  const typing = e.target.matches?.('input, textarea')
  if (e.key === 'Escape') { e.preventDefault(); later.add(askKey(shown)); closeAsk(); return }
  if (typing && !(e.key === 'Enter' && !e.shiftKey && e.target.tagName === 'INPUT' && shown.kind === 'question')) return
  if (shown.kind === 'permission') {
    if (e.key === 'a' || e.key === 'A') { e.preventDefault(); sendAnswer(shown, { decision: 'allow' }) }
    else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); sendAnswer(shown, { decision: 'deny', reason: '' }) }
    return
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAnswer(shown, answerOf(shown)); return }
  const n = Number(e.key)
  if (n >= 1 && n <= 9) {
    // the number picks in the first question that has no pick yet
    const st = stateOf(shown)
    const qi = Math.max(0, st.findIndex((s, i) => s.set.size === 0 && (shown.questions[i].kind ?? 'choice') === 'choice'))
    askBox.querySelector(`.opt[data-q="${qi}"][data-o="${n - 1}"]`)?.click()
  }
})
askWrap.addEventListener('click', e => { if (e.target === askWrap && shown) { later.add(askKey(shown)); closeAsk() } })
askPill.onclick = () => { later.clear(); drawAsks(true) }

const drawAsks = (force = false) => {
  const list = answersOn() ? allAsks() : []
  const keys = new Set(list.map(askKey))
  for (const k of later) if (!keys.has(k)) later.delete(k)
  for (const k of picks.keys()) if (!keys.has(k)) picks.delete(k)
  for (const [k, at] of answered) if (!keys.has(k) || Date.now() - at > 60_000) answered.delete(k)
  // answered elsewhere (the Claude window, the Stream Deck): it goes away
  if (shown && !keys.has(askKey(shown))) closeAsk()
  const open = list.filter(a => !later.has(askKey(a)) && !answered.has(askKey(a)))
  if (!shown && open.length > 0) openAsk(open[0], list.indexOf(open[0]), list.length)
  else if (shown && force) openAsk(shown, list.findIndex(a => askKey(a) === askKey(shown)), list.length)
  // a gentle reminder now and then while it waits
  if (shown && Date.now() - rang.at > 45_000 && rang.times < 3 && toneOn('lc.toneAsk') && store.get('lc.askRemind') !== 'off') { rang.at = Date.now(); rang.times++; playNotes(shown.kind === 'permission' ? PERMISSION_TONE : QUESTION_TONE, { force: true, vol: 0.3 }) }
  for (const el of askBox.querySelectorAll('[data-since]')) setText(el, `waiting ${dur(Date.now() - Number(el.dataset.since))}`)
  const aside = list.filter(a => !answered.has(askKey(a))).length - (shown ? 1 : 0)
  if (askPill.hidden !== aside <= 0) askPill.hidden = aside <= 0
  setText(askPill, `❓ ${aside} ${aside === 1 ? 'question waits' : 'questions wait'}`)
  // the tab says it too
  titleBlink++
  const title = list.length > 0 && titleBlink % 4 < 2 ? `❓ ${list.length} waiting · Live Code` : baseTitle
  // (a tile in its own window is named after the tile)
  if (document.title !== title && !TILE_MODE) document.title = title
}
setInterval(drawAsks, 250)

// ════════════════════════════════════════════════════════════════════════════
// the task's plan: a segmented bar under the prompt, as on the Stream Deck
// ════════════════════════════════════════════════════════════════════════════
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: `
.pc-plan { margin-top: 10px; display: grid; gap: 6px; }
.pc-plan[hidden] { display: none; }
.pc-plan .ph { display: flex; align-items: baseline; gap: 10px; font-size: 12px; color: var(--ink-2); }
.pc-plan .ph b { color: var(--s4); letter-spacing: .6px; text-transform: uppercase; font-size: 11px; }
.pc-plan .ph .n { margin-left: auto; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
.pc-plan .ph .now { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc-plan .segs { display: flex; gap: 4px; height: 10px; }
.pc-plan .seg { flex: 1; border-radius: 5px; background: var(--surface-3); transition: background-color .5s, box-shadow .5s; }
.pc-plan .seg.done { background: var(--good); }
.pc-plan .seg.running { background: var(--s4); box-shadow: 0 0 10px color-mix(in srgb, var(--s4) 60%, transparent); animation: pulse 1.2s ease-in-out infinite; }
.pc-plan.finished .ph b { color: var(--good-ink); }
:root.calm .pc-plan .seg.running { animation: none; }
` }))
const planBox = Object.assign(document.createElement('div'), { className: 'pc-plan', hidden: true })
$('#pc-text').after(planBox)
let planKey = ''
setInterval(() => {
  const p = S.snap?.plan
  const active = !!p && p.total > 0 && (!p.isFinished || Date.now() - p.updatedAt < 120_000)
  if (planBox.hidden !== !active) planBox.hidden = !active
  if (!active) { planKey = ''; return }
  const key = JSON.stringify([S.view, p])
  if (key === planKey) return
  planKey = key
  const finished = p.isFinished || p.done >= p.total
  const running = p.items.find(x => x.status === 'running')
  const label = p.source === 'flow' ? `${p.phase ?? 'flow'} · ${p.title}` : p.source === 'tasks' ? 'tasks' : 'task list'
  const n = Math.max(p.total, p.items.length)
  const segs = Array.from({ length: n }, (_, i) => {
    const it = p.items[i]
    const st = it?.status ?? (i < p.done ? 'done' : 'pending')
    return `<span class="seg ${st}" title="${esc(`${i + 1}. ${it?.title ?? ''} (${st})`)}"></span>`
  }).join('')
  planBox.className = `pc-plan${finished ? ' finished' : ''}`
  planBox.innerHTML = `<div class="ph"><b>${esc(label)}</b><span class="now">${esc(finished ? '✓ all done' : running?.title ?? '')}</span><span class="n">${p.done} / ${p.total}</span></div><div class="segs">${segs}</div>`
}, 300)

// ════════════════════════════════════════════════════════════════════════════
// stop the running turn
// ════════════════════════════════════════════════════════════════════════════
const stopBtn = $('#pc-stop')
let stopArmed = 0
setInterval(() => {
  const s = S.sessions.get(S.view)
  const can = !!s?.snap?.session?.canStop && isBusy(s.snap)
  stopBtn.hidden = !can
  if (Date.now() > stopArmed && stopBtn.textContent !== '■ Stop') stopBtn.textContent = '■ Stop'
}, 300)
stopBtn.onclick = async () => {
  // a second click within three seconds stops: one stray click does not
  if (Date.now() > stopArmed) { stopArmed = Date.now() + 3000; stopBtn.textContent = '■ Really stop?'; return }
  stopArmed = 0
  const sid = S.view
  const r = await post('/send', { sid, kind: 'stop' }).catch(() => null)
  smallToast(r?.ok ? `Stopping “${projectOf(S.sessions.get(sid))}”…` : 'Could not stop it', r?.ok ? '' : 'bad')
}

// ════════════════════════════════════════════════════════════════════════════
// a turn as a film
// ════════════════════════════════════════════════════════════════════════════
const filmBar = $('#film-bar')
const withRows = async list => {
  await Promise.all(list.map(async a => {
    if (a.rows?.length || a.action === 'searching') return
    try { const r = await fetch('/action/' + encodeURIComponent(a.id)); if (r.ok) Object.assign(a, await r.json()) } catch {}
  }))
  return list
}
const turnActions = (sid, from, to) => S.actions.filter(a => a.sid === sid && a.startedAt >= from && a.startedAt <= to).sort((a, b) => a.startedAt - b.startedAt)

window.playFilm = async (sid, from, to, label) => {
  const list = await withRows(turnActions(sid, from, to))
  if (list.length === 0) { smallToast('Nothing recorded for that turn', 'bad'); return }
  R.film = { sid, list, label, index: 0, from: list[0].startedAt, to: list[list.length - 1].doneAt ?? list[list.length - 1].startedAt }
  R.follow = false; R.paused = false
  $('#pause').textContent = 'Pause'
  $('#golive').hidden = false
  R.queue = list.slice(1)
  start(list[0])
  drawFilm()
  $('.live').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
}
window.onReplayStart = f => {
  if (!R.film) return
  const i = R.film.list.findIndex(x => x.id === f.id)
  if (i < 0) { R.film = null }
  else R.film.index = i
  drawFilm()
}
const jumpFilm = i => {
  const fl = R.film
  if (!fl) return
  i = clamp(i, 0, fl.list.length - 1)
  R.queue = fl.list.slice(i + 1)
  R.paused = false
  start(fl.list[i])
}
const drawFilm = () => {
  const fl = R.film
  filmBar.hidden = !fl
  if (!fl) return
  const span = Math.max(1, fl.to - fl.from)
  const at = a => clamp(((a.startedAt - fl.from) / span) * 100, 0, 100)
  $('#film-label').textContent = `🎬 ${fl.label}`
  $('#film-track').innerHTML = fl.list.map((a, i) =>
    `<span class="mk${i < fl.index ? ' past' : i === fl.index ? ' now' : ''}" data-i="${i}" title="${esc(`${ACTION_LABEL[a.action] ?? a.action} ${a.action === 'running' ? a.file : where(a)}`)}" style="left:${at(a)}%;background:${kindVar(ACTION_KIND[a.action] ?? 'other')};color:${kindVar(ACTION_KIND[a.action] ?? 'other')}"></span>`).join('') +
    `<span class="head" style="left:${at(fl.list[fl.index])}%"></span>`
  const a = fl.list[fl.index]
  $('#film-pos').textContent = `${fl.index + 1} / ${fl.list.length} · ${clock(a.startedAt)}`
  $('#film-play').textContent = R.paused ? '▶' : '⏸'
}
$('#film-track').onclick = e => {
  const mk = e.target.closest('.mk')
  if (mk) { jumpFilm(Number(mk.dataset.i)); return }
  // a click on the line: the step nearest to that moment
  const fl = R.film
  const box = $('#film-track').getBoundingClientRect()
  const t = fl.from + ((e.clientX - box.left) / box.width) * (fl.to - fl.from)
  let best = 0
  fl.list.forEach((a, i) => { if (Math.abs(a.startedAt - t) < Math.abs(fl.list[best].startedAt - t)) best = i })
  jumpFilm(best)
}
$('#film-prev').onclick = () => jumpFilm((R.film?.index ?? 0) - 1)
$('#film-next').onclick = () => jumpFilm((R.film?.index ?? 0) + 1)
$('#film-play').onclick = () => { R.paused = !R.paused; $('#pause').textContent = R.paused ? 'Resume' : 'Pause'; drawFilm() }
const endFilm = () => { if (!R.film) return; R.film = null; drawFilm() }
$('#film-close').onclick = () => { endFilm(); $('#golive').click() }
$('#golive').addEventListener('click', endFilm)
$('#pause').addEventListener('click', () => setTimeout(drawFilm, 0))

// ════════════════════════════════════════════════════════════════════════════
// every change to a file in one view
// ════════════════════════════════════════════════════════════════════════════
const sheetWrap = $('#sheet-wrap')
const sheet = $('#sheet')
const closeSheet = () => { sheetWrap.hidden = true; sheet.innerHTML = '' }
sheetWrap.addEventListener('click', e => { if (e.target === sheetWrap) closeSheet() })
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !sheetWrap.hidden) closeSheet() })

const diffLines = (rows, lang) => rows.map(r => {
  const line = (cls, oldNo, newNo, sign, text, raw = false) =>
    `<div class="dl ${cls}"><span class="n">${oldNo ?? ''}</span><span class="n">${newNo ?? ''}</span><span>${sign}</span><span class="t">${raw ? esc(text) : hl(text, lang)}</span></div>`
  switch (r.kind) {
    case 'add': return line('add', '', r.newNo, '+', r.text)
    case 'del': return line('del', r.oldNo, '', '−', r.text)
    case 'mod': return line('del', r.oldNo, '', '−', r.before ?? '') + line('add', '', r.newNo, '+', r.text)
    case 'gap': return line('gap', '', '', '⋯', r.text, true)
    default: return line('', r.oldNo, r.newNo, '', r.text)
  }
}).join('')

window.showDiff = async (sid, from, to, file) => {
  const acts = await withRows(turnActions(sid, from, to).filter(a => a.action === 'editing' || a.action === 'writing'))
  if (acts.length === 0) { smallToast('No file was changed in that turn', 'bad'); return }
  const files = [...new Set(acts.map(a => a.file))]
  let pick = files.includes(file) ? file : files[0]
  const draw = () => {
    const mine = acts.filter(a => a.file === pick)
    const tot = mine.reduce((t, a) => ({ add: t.add + (a.stats?.add ?? 0), mod: t.mod + (a.stats?.mod ?? 0), del: t.del + (a.stats?.del ?? 0) }), { add: 0, mod: 0, del: 0 })
    const lang = langOf(pick)
    sheet.innerHTML =
      `<div class="sh"><b>± ${esc(baseName(pick))}</b><span class="muted" title="${esc(pick)}">${esc(dirName(pick))}</span>` +
      `<span class="stat-add">+${tot.add}</span><span class="stat-mod">~${tot.mod}</span><span class="stat-del">−${tot.del}</span><span class="muted">${plural(mine.length, 'change')}</span>` +
      `<button class="x" title="Close (Esc)">✕</button>` +
      (files.length > 1 ? `<div class="tabs" style="flex-basis:100%">${files.map(f => `<button data-f="${esc(f)}" class="${f === pick ? 'on' : ''}">${esc(baseName(f))}</button>`).join('')}</div>` : '') +
      `</div><div class="body">` +
      mine.map((a, i) => {
        const st = a.stats ?? {}
        const lines = a.line != null ? ` · line${a.endLine && a.endLine !== a.line ? `s ${a.line}–${a.endLine}` : ` ${a.line}`}` : ''
        return `<div class="hunk"><div class="hh"><b>${i + 1}.</b><span>${clock(a.startedAt)}</span><span>${a.action === 'writing' ? (a.detail === 'new file' ? 'New file' : 'Rewritten') : 'Edit'}${lines}</span>` +
          `<span class="stat-add">+${st.add ?? 0}</span><span class="stat-mod">~${st.mod ?? 0}</span><span class="stat-del">−${st.del ?? 0}</span>` +
          `<span style="flex:1"></span><button data-replay="${esc(a.id)}" class="x" style="margin:0;padding:0 8px">▶ replay</button></div>` +
          (a.rows?.length ? diffLines(a.rows, lang) : '<div class="dl gap"><span></span><span></span><span></span><span class="t">The code of this older change was not kept.</span></div>') + '</div>'
      }).join('') + '</div>'
    sheet.querySelector('.x').onclick = closeSheet
    for (const b of sheet.querySelectorAll('[data-f]')) b.onclick = () => { pick = b.dataset.f; draw() }
    for (const b of sheet.querySelectorAll('[data-replay]')) b.onclick = () => { closeSheet(); replayAction(b.dataset.replay) }
  }
  draw()
  sheetWrap.hidden = false
}

// the result box's buttons
$('#pc-said').addEventListener('click', e => {
  const box = e.target.closest('.result')
  if (!box) return
  const from = Number(box.dataset.from)
  const to = Number(box.dataset.to)
  if (e.target.closest('[data-film]')) playFilm(S.view, from, to, 'This turn')
  else if (e.target.closest('[data-diff]')) { e.stopPropagation(); showDiff(S.view, from, to, e.target.closest('[data-diff]').dataset.diff) }
  else if (e.target.closest('[data-speak]')) { if (speaking) stopSpeech(); else speakSummary(S.view, true) }
})

// ════════════════════════════════════════════════════════════════════════════
// a real voice reads the summary
// ════════════════════════════════════════════════════════════════════════════
const voice = {
  on: () => store.get('lc.voice') !== 'off',
  all: () => store.get('lc.voiceAll') === 'on',
  len: () => store.get('lc.voiceLen') || 'short',
}
// What reads well aloud: no code, no links, no tables, no markup.
const speechText = (raw, len) => {
  let t = String(raw ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\|.*\|\s*$/gm, '')
    .replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_]{1,3}([^*_\n]+)[*_]{1,3}/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .trim()
  if (len === 'short') {
    const paras = t.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
    let out = ''
    for (const p of paras) { out += (out ? '\n\n' : '') + p; if (out.length >= 140) break }
    t = out
  }
  t = t.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ')
  if (t.length > 2500) { const cut = t.slice(0, 2500); const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? ')); t = end > 1200 ? cut.slice(0, end + 1) : cut }
  return t
}
const speakQueue = []
let speaking = false
const eq = on => {
  $('#voice-eq').innerHTML = on ? '<span class="speaking"><i></i><i></i><i></i></span>' : ''
  $('#set-voice-test').textContent = on ? '■ Stop' : '▶ Test'
  window.speechOn = on
  for (const b of document.querySelectorAll('[data-speak]')) b.textContent = on ? '■ Stop reading' : '🗣 Read aloud'
}
// Esc stops the reading too, unless a question waits for its answer
document.addEventListener('keydown', e => { if (e.key === 'Escape' && speaking && $('#ask-wrap').hidden) stopSpeech() })
// What plays now, to stop it: the queue, the browser's voice, an ElevenLabs clip.
let endClip = null
let playing = null
const stopSpeech = () => {
  speakQueue.length = 0
  window.speechSynthesis?.cancel()
  playing?.pause()
  endClip?.()
}
const voiceVolume = () => volumeOf('lc.voiceVol', 100)
const speak = (text, sid = S.view) => {
  if (!text) return
  speakQueue.push({ text, sid })
  if (!speaking) nextSpeech()
}
// The browser's own voices, the most natural first: Edge brings Microsoft's
// neural voices ("… Online (Natural)"), free and without an account. Those of
// the person's own language (the browser's), and the multilingual ones, which
// speak it without an accent.
const isNatural = v => /natural/i.test(v.name)
const MY_LANG = new RegExp(`^${((navigator.language || 'en').slice(0, 2)).replace(/[^a-z]/gi, '') || 'en'}`, 'i')
const voiceRank = v => (isNatural(v) ? 0 : /online|google/i.test(v.name) ? 1 : 2) * 2 + (MY_LANG.test(v.lang) ? 0 : 1)
const browserVoices = () => {
  const all = window.speechSynthesis?.getVoices() ?? []
  const mine = all.filter(v => MY_LANG.test(v.lang) || /multilingual/i.test(v.name))
  return (mine.length ? mine : all.filter(v => /^en/i.test(v.lang)))
    .sort((a, b) => voiceRank(a) - voiceRank(b) || a.name.localeCompare(b.name))
}
const pickedVoice = () => {
  const name = store.get('lc.voiceName')
  if (name?.startsWith('eleven:')) return name
  const list = browserVoices()
  return list.find(v => v.name === name) ?? list[0] ?? null
}
// Each chat its own voice: kept per chat, a new chat gets one no other chat has.
const chatVoices = () => { try { return JSON.parse(store.get('lc.chatVoices') || '{}') } catch { return {} } }
const voiceFor = sid => {
  const main = pickedVoice()
  if (store.get('lc.voicePerChat') !== 'on' || !sid || typeof main === 'string') return main
  const list = browserVoices()
  const pool = list.filter(isNatural).length >= 2 ? list.filter(isNatural) : list
  const map = chatVoices()
  const kept = pool.find(v => v.name === map[sid])
  if (kept) return kept
  const taken = new Set(Object.entries(map).filter(([id]) => S.sessions.has(id) && id !== sid).map(([, n]) => n))
  const free = [main, ...pool].filter(Boolean).find(v => !taken.has(v.name)) ?? pool[Object.keys(map).length % Math.max(1, pool.length)] ?? main
  if (free) { map[sid] = free.name; store.set('lc.chatVoices', JSON.stringify(map)) }
  return free
}
// Spoken a sentence group at a time: long utterances stop halfway in Chromium.
const sayInBrowser = (text, v) => new Promise(done => {
  const parts = text.match(/[^.!?]+[.!?]*\s*/g)?.reduce((acc, s) => { if (acc.length && (acc.at(-1) + s).length < 220) acc[acc.length - 1] += s; else acc.push(s); return acc }, []) ?? [text]
  let left = parts.length
  for (const p of parts) {
    const u = new SpeechSynthesisUtterance(p.trim())
    u.voice = v; u.lang = v.lang; u.rate = (Number(store.get('lc.voiceRate')) || 100) / 100; u.volume = voiceVolume()
    u.onend = u.onerror = () => { if (--left === 0) done() }
    speechSynthesis.speak(u)
  }
})
const nextSpeech = async () => {
  const item = speakQueue.shift()
  if (item === undefined) { speaking = false; eq(false); return }
  const { text, sid } = item
  speaking = true
  eq(true)
  try {
    const v = voiceFor(sid)
    if (v && typeof v !== 'string') { await sayInBrowser(text, v); nextSpeech(); return }
    if (!v) throw new Error('this browser has no voice')
    const r = await post('/speak', { text })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.status)
    const url = URL.createObjectURL(await r.blob())
    const audio = playing = new Audio(url)
    audio.volume = voiceVolume()
    await new Promise(done => { endClip = done; audio.onended = done; audio.onerror = done; audio.play().catch(done) })
    playing = endClip = null
    URL.revokeObjectURL(url)
  } catch (error) {
    $('#voice-hint').textContent = `The voice failed: ${error.message}`
    smallToast(`Voice: ${error.message}`, 'bad')
  }
  nextSpeech()
}
// the closing words of a chat's newest turn
const closingOf = sid => {
  const snap = S.sessions.get(sid)?.snap
  const prompts = promptsOf(snap)
  return notesOf(snap, turnPromptOf(snap)).at(-1)?.text
}
const speakSummary = (sid, now = false) => {
  const s = S.sessions.get(sid)
  const text = speechText(closingOf(sid), voice.len())
  if (!text) { if (now) smallToast('No summary to read yet', 'bad'); return }
  speak(sid !== S.view && !now ? `${projectOf(s)}: ${text}` : text, sid)
}
window.afterDone = (sid, snap) => {
  if (!voice.on() || (sid !== S.view && !voice.all())) return
  // the closing message reaches the transcript a moment after the turn ends
  const endedAt = snap?.thinking?.turnEndedAt ?? Date.now()
  let tries = 0
  const wait = () => {
    const last = notesOf(S.sessions.get(sid)?.snap, turnPromptOf(S.sessions.get(sid)?.snap)).at(-1)
    if ((last && last.at >= endedAt - 120_000) || tries++ > 16) { if (last) setTimeout(() => speakSummary(sid), 600) }
    else setTimeout(wait, 500)
  }
  wait()
}

// ════════════════════════════════════════════════════════════════════════════
// the settings popover
// ════════════════════════════════════════════════════════════════════════════
const setPop = $('#set-pop')
// one category at a time; the last one opened comes back
const showTab = tab => {
  store.set('lc.setTab', tab)
  for (const b of $('#set-tabs').children) b.classList.toggle('on', b.dataset.tab === tab)
  for (const p of setPop.querySelectorAll('.set-pane')) p.hidden = p.dataset.pane !== tab
  if (tab === 'voice') loadVoices()
  if (tab === 'lights') loadHue()
}
$('#set-tabs').onclick = e => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab) }
$('#set-btn').onclick = e => { e.stopPropagation(); setPop.hidden = !setPop.hidden; if (!setPop.hidden) showTab(store.get('lc.setTab') || 'sound') }
document.addEventListener('click', e => { if (!setPop.hidden && !e.target.closest('.set-wrap')) setPop.hidden = true })
const bindCheck = (id, key, def, after) => {
  const el = $(id)
  el.checked = (store.get(key) ?? def) === 'on'
  el.onchange = () => { store.set(key, el.checked ? 'on' : 'off'); after?.() }
}
bindCheck('#set-answers', 'lc.answers', 'on', () => { connect(); if (!answersOn()) closeAsk() })
bindCheck('#set-voice', 'lc.voice', 'on')
bindCheck('#set-voice-all', 'lc.voiceAll', 'off')
bindCheck('#set-voice-per-chat', 'lc.voicePerChat', 'off', () => loadVoices())
bindCheck('#set-alarm', 'lc.alarm', 'on')
// the sliders: the voice changes from its next sentence on, a tone plays at the new volume
const bindVolume = (id, key, def, after) => {
  const el = $(id), n = $(`${id}-n`)
  el.value = Math.round(volumeOf(key, def) * 100)
  n.textContent = `${el.value}%`
  el.oninput = () => { store.set(key, el.value); n.textContent = `${el.value}%` }
  el.onchange = () => after?.()
}
bindVolume('#set-voice-vol', 'lc.voiceVol', 100)
bindVolume('#set-sound-vol', 'lc.soundVol', 70, () => chime(true))
// a slider of plain numbers: a unit of its own, a default, a hook after
const bindNumber = (id, key, def, unit, after) => {
  const el = $(id), n = $(`${id}-n`)
  el.value = Number(store.get(key)) || def
  n.textContent = `${el.value}${unit}`
  el.oninput = () => { store.set(key, el.value); n.textContent = `${el.value}${unit}`; after?.() }
}
bindNumber('#set-voice-rate', 'lc.voiceRate', 100, '%')
bindCheck('#set-open-with-claude', 'lc.openWithClaude', 'on')
// animations: like Windows, always, never (index.html's applyMotion); the tile windows follow
$('#set-motion').value = store.get('lc.motion') || 'system'
$('#set-motion').onchange = e => { store.set('lc.motion', e.target.value); applyMotion(); sendPrefs() }
bindCheck('#set-think', 'lc.think', 'on')
bindNumber('#set-think-after', 'lc.thinkAfter', 2.5, ' s')
bindNumber('#set-warn-at', 'lc.warnAt', 70, '%', () => drawTiles())
bindNumber('#set-crit-at', 'lc.critAt', 85, '%', () => drawTiles())
// the tones, each on its own
bindCheck('#set-tone-done-on', 'lc.toneDone', 'on')
bindCheck('#set-tone-reset-on', 'lc.toneReset', 'on')
bindCheck('#set-tone-ask-on', 'lc.toneAsk', 'on')
bindCheck('#set-ask-remind', 'lc.askRemind', 'on')
$('#set-tone-done').onclick = () => chime(true)
$('#set-tone-reset').onclick = () => playNotes(RESET_TONE, { type: 'triangle', vol: 0.5, decay: 1.2, force: true })
$('#set-tone-ask').onclick = () => playNotes(QUESTION_TONE, { force: true })

// the Hue lights: kept by the server, which works them even with no window open
const hueSet = body => post('/hue', body)
const loadHue = async () => {
  try {
    const h = await (await fetch('/hue', { headers: { 'X-Live-Code-Secret': SECRET } })).json()
    $('#set-hue').checked = h.paired && h.enabled
    $('#set-hue').disabled = !h.paired
    $('#set-hue-on-done').checked = h.onDone
    $('#set-hue-on-ask').checked = h.onAsk
    $('#set-hue-done-color').value = h.doneColor
    $('#set-hue-ask-color').value = h.askColor
    $('#set-hue-on-alarm').checked = h.onAlarm
    $('#set-hue-alarm-color').value = h.alarmColor
    $('#set-hue-on-build').checked = h.onBuild !== false
    $('#set-hue-build-color').value = h.buildColor ?? '#f38020'
    $('#set-hue-build-reverse').checked = h.buildReverse === true
    $('#set-hue-style').value = h.style
    $('#hue-pulses-row').hidden = h.style !== 'pulse'
    $('#set-hue-pulses').value = h.pulses
    $('#set-hue-pulses-n').textContent = `${h.pulses}×`
    const chosen = new Set(h.chosen)
    $('#hue-lights').innerHTML = (h.rooms ?? []).map(r => `<div class="room">${esc(r.name)}</div>` +
      r.lights.map(l => `<label><input type="checkbox" data-light="${esc(l.id)}"${chosen.has(l.id) ? ' checked' : ''}${l.color ? '' : ' disabled title="No color: it can only be dimmed"'}> ${esc(l.name)}${l.color ? '' : ' <span class="muted">(white only)</span>'}</label>`).join('')).join('')
    const p = h.pairing ?? {}
    const pairingNow = p.state === 'searching' || p.state === 'press'
    $('#hue-pair-row').hidden = h.paired && !pairingNow
    $('[data-pane="lights"]').classList.toggle('unpaired', !h.paired)
    $('#hue-pair').disabled = pairingNow
    $('#hue-hint').textContent = p.state === 'searching' ? 'Looking for your Hue Bridge…'
      : p.state === 'press' ? `Found ${p.name} (${p.bridge}). Now press the round link button on top of the bridge (45 s).`
      : p.state === 'failed' ? p.error
      : h.paired ? (h.chosen?.length ? 'Each light keeps its own brightness; lights that are off stay off, and each goes back to how it was.' : 'Paired. Pick the lights that should answer.')
      : 'Not paired with a Hue Bridge yet: click "Pair bridge", then press the button on the bridge.'
    // while pairing, asked again until it is done
    clearTimeout(loadHue.timer)
    if (pairingNow) loadHue.timer = setTimeout(loadHue, 1200)
  } catch {}
}
$('#hue-pair').onclick = async () => { await hueSet({ pair: true, address: $('#hue-address').value }); setTimeout(loadHue, 300) }
$('#set-hue').onchange = e => hueSet({ enabled: e.target.checked })
$('#set-hue-on-done').onchange = e => hueSet({ onDone: e.target.checked })
$('#set-hue-on-ask').onchange = e => hueSet({ onAsk: e.target.checked })
$('#set-hue-done-color').onchange = e => hueSet({ doneColor: e.target.value })
$('#set-hue-ask-color').onchange = e => hueSet({ askColor: e.target.value })
$('#set-hue-pulses').oninput = e => { $('#set-hue-pulses-n').textContent = `${e.target.value}×` }
$('#set-hue-pulses').onchange = e => hueSet({ pulses: Number(e.target.value) })
$('#hue-lights').onchange = () => hueSet({ lights: [...$('#hue-lights').querySelectorAll('input:checked')].map(i => i.dataset.light) })
$('#set-hue-on-alarm').onchange = e => hueSet({ onAlarm: e.target.checked })
$('#set-hue-alarm-color').onchange = e => hueSet({ alarmColor: e.target.value })
$('#set-hue-style').onchange = e => { hueSet({ style: e.target.value }); $('#hue-pulses-row').hidden = e.target.value !== 'pulse' }
$('#set-hue-alarm').onclick = () => hueSet({ test: 'alarm' })
$('#set-hue-on-build').onchange = e => hueSet({ onBuild: e.target.checked })
$('#set-hue-build-color').onchange = e => hueSet({ buildColor: e.target.value })
$('#set-hue-build').onclick = () => hueSet({ test: 'build' })
$('#set-hue-build-reverse').onchange = e => hueSet({ buildReverse: e.target.checked })
$('#set-hue-done').onclick = () => hueSet({ test: 'done' })
$('#set-hue-ask').onclick = () => hueSet({ test: 'ask' })
$('#set-voice-len').value = voice.len()
$('#set-voice-len').onchange = e => store.set('lc.voiceLen', e.target.value)
$('#set-voice-test').onclick = () => {
  if (speaking) { stopSpeech(); return }
  const text = speechText(closingOf(S.view), voice.len()) || (MY_LANG.test('de') ? 'Hallo! So klinge ich, wenn eine Aufgabe fertig ist.' : 'Hello! This is how I sound when a task is done.')
  speak(text)
}
// The voices to pick from: the browser's, and ElevenLabs' where a key is set.
const loadVoices = async () => {
  const sel = $('#set-voice-id')
  const hint = $('#voice-hint')
  const picked = pickedVoice()
  const pickedName = typeof picked === 'string' ? picked : picked?.name
  const option = (value, label) => `<option value="${esc(value)}"${value === pickedName ? ' selected' : ''}>${esc(label)}</option>`
  const nice = v => v.name.replace(/^Microsoft\s+/, '').replace(/\s*\(Natural\)/, '').replace(/\s+Online/, '')
  const list = browserVoices()
  const natural = list.filter(isNatural)
  const voiceGroups = (pick, opt) => [
    natural.length ? `<optgroup label="Natural voices">${natural.map(v => opt(v.name, nice(v), pick)).join('')}</optgroup>` : '',
    list.length > natural.length ? `<optgroup label="Other voices">${list.filter(v => !natural.includes(v)).map(v => opt(v.name, nice(v), pick)).join('')}</optgroup>` : '',
  ]
  const groups = voiceGroups(pickedName, option)
  // with a voice per chat: each open chat, its voice, to change and to hear
  const rows = $('#voice-chats')
  if (store.get('lc.voicePerChat') === 'on' && typeof picked !== 'string' && list.length) {
    const opt = (value, label, pick) => `<option value="${esc(value)}"${value === pick ? ' selected' : ''}>${esc(label)}</option>`
    rows.innerHTML = shownSessions().map(s => {
      const v = voiceFor(s.id)
      return `<div class="row voice-chat" data-sid="${esc(s.id)}"><span style="flex:0 0 96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(projectOf(s))}">${esc(projectOf(s))}</span><select style="flex:1;min-width:0">${voiceGroups(v?.name, opt).join('')}</select><button title="Hear it">▶</button></div>`
    }).join('')
    for (const row of rows.children) {
      const sid = row.dataset.sid
      row.querySelector('select').onchange = e => { const map = chatVoices(); map[sid] = e.target.value; store.set('lc.chatVoices', JSON.stringify(map)) }
      row.querySelector('button').onclick = () => speaking ? stopSpeech() : speak(`Hallo, ich bin die Stimme von ${projectOf(S.sessions.get(sid))}.`, sid)
    }
  } else rows.innerHTML = ''
  try {
    const v = await (await fetch('/voice', { headers: { 'X-Live-Code-Secret': SECRET } })).json()
    if (v.configured && !v.error) groups.push(`<optgroup label="ElevenLabs">${v.voices.map(x => option(`eleven:${x.id}`, x.name)).join('')}</optgroup>`)
  } catch {}
  sel.innerHTML = groups.join('') || '<option>No voice in this browser</option>'
  sel.disabled = !groups.join('')
  hint.textContent = natural.length
    ? 'Microsoft\'s neural voices: they sound like a person, are free and need no account.'
    : 'This browser has no natural voices. Open the dashboard in Microsoft Edge (the desktop shortcut does): it brings Microsoft\'s neural voices, free.'
}
window.speechSynthesis?.addEventListener('voiceschanged', () => { if (!setPop.hidden) loadVoices() })
$('#set-voice-id').onchange = e => {
  store.set('lc.voiceName', e.target.value)
  if (e.target.value.startsWith('eleven:')) post('/voice', { voiceId: e.target.value.slice(7) })
}

// ════════════════════════════════════════════════════════════════════════════
// stuck: the same thing failing again and again
// ════════════════════════════════════════════════════════════════════════════
const alarmed = new Set()
const stuckOf = sid => {
  const acts = S.actions.filter(a => a.sid === sid && !a.agentId && a.isDone !== false).sort((a, b) => a.startedAt - b.startedAt).slice(-8)
  if (acts.length < 3) return null
  const last3 = acts.slice(-3)
  if (last3.every(a => a.isError)) return { key: last3[2].id, text: `The last ${last3.length} steps all failed: ${last3.map(a => a.action === 'running' ? a.detail || a.file : baseName(a.file)).join(', ')}` }
  // the same call failing three times in four minutes
  const recent = acts.filter(a => a.isError && Date.now() - a.startedAt < 4 * 60_000)
  const byKey = new Map()
  for (const a of recent) { const k = `${a.action}|${a.file}|${a.action === 'running' ? (a.rows?.[0]?.text ?? a.detail) : ''}`; byKey.set(k, [...(byKey.get(k) ?? []), a]) }
  for (const list of byKey.values()) if (list.length >= 3) return { key: list[list.length - 1].id, text: `${list[0].action === 'running' ? `“${list[0].detail || list[0].file}”` : baseName(list[0].file)} failed ${list.length}× in a few minutes` }
  return null
}
const raiseAlarm = (sid, stuck) => {
  const s = S.sessions.get(sid)
  playNotes(ALARM_TONE, { type: 'triangle', vol: 0.45, decay: 0.35 })
  // the lights glow red with it (the server keeps whether they do)
  post('/hue', { event: 'alarm' }).catch(() => {})
  if (sid === S.view) for (const el of [$('#prompt-card'), $('.live')]) { el.classList.remove('alarm'); void el.offsetWidth; el.classList.add('alarm'); setTimeout(() => el.classList.remove('alarm'), 4600) }
  const t = document.createElement('div')
  t.className = 'done-toast bad'
  t.innerHTML = `<span class="tick">!</span><b>${esc(projectOf(s))} seems stuck</b><span>${esc(stuck.text)}</span>` +
    `<div class="acts"><button data-k="hint">Send a hint</button><button data-k="stop">■ Stop</button>${sid !== S.view ? '<button data-k="show">Watch</button>' : ''}<button data-k="x">Dismiss</button></div>`
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 500) }
  t.onclick = async e => {
    const k = e.target.closest('[data-k]')?.dataset.k
    if (!k) return
    if (k === 'stop') { await post('/send', { sid, kind: 'stop' }); smallToast('Stopping…') }
    if (k === 'show' || k === 'hint') selectSession(sid)
    if (k === 'hint') { const input = $('#pc-input'); input.value = 'Stop and tell me what keeps failing, and why, before you try it again.'; input.focus(); input.dispatchEvent(new Event('input')) }
    close()
  }
  toasts.prepend(t)
  setTimeout(close, 20_000)
}
setInterval(() => {
  if (store.get('lc.alarm') === 'off') return
  for (const s of S.sessions.values()) {
    if (!isBusy(s.snap)) continue
    const stuck = stuckOf(s.id)
    if (!stuck || alarmed.has(stuck.key)) continue
    alarmed.add(stuck.key)
    raiseAlarm(s.id, stuck)
  }
}, 1000)

// ── dictation: speech into a prompt ──
// Edge's (and Chrome's) speech recognition, in the person's language. The
// Stream Deck's talk key: held, this window listens and the deck shows what it
// hears; let go, the server sends it to the chat. The 🎤 beside "Send" types
// into the box instead, for a look before sending.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
const listen = ({ onText, onEnd, onError }) => {
  const r = new Recognition()
  r.lang = navigator.language || 'en-US'
  r.interimResults = true
  r.continuous = true
  let done = '', heard = ''
  r.onresult = e => {
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript
      if (e.results[i].isFinal) done += (done && !/\s$/.test(done) ? ' ' : '') + t.trim()
      else interim += t
    }
    heard = `${done} ${interim}`.replace(/\s+/g, ' ').trim()
    onText?.(heard)
  }
  r.onerror = e => { if (e.error !== 'no-speech' && e.error !== 'aborted') onError?.(e.error) }
  // the last words still being worked out count too, when the key is let go
  r.onend = () => onEnd?.(heard || done)
  r.start()
  return r
}

// what the deck's talk key hears, shown here too
const dictationBox = (() => {
  const el = document.createElement('div')
  el.className = 'dictation'
  el.innerHTML = '<span class="dot"></span><div><div class="what"></div><div class="heard"></div></div>'
  document.body.append(el)
  let hideAt = 0
  return (state, text, chat) => {
    if (TILE_MODE) return
    el.className = `dictation show ${state}`
    el.querySelector('.what').textContent = state === 'listening' ? `🎤 Listening · to ${chat}` : state === 'finishing' ? 'Finishing…' : state === 'sent' ? `✓ Sent to ${chat}` : state === 'failed' ? 'Microphone' : 'Nothing heard'
    el.querySelector('.heard').textContent = text || (state === 'listening' ? 'Speak now…' : '')
    clearTimeout(hideAt)
    if (state !== 'listening' && state !== 'finishing') hideAt = setTimeout(() => el.classList.remove('show'), state === 'sent' ? 2600 : 3200)
  }
})()

let deckEar = null // { id, rec }
const chatTitle = sid => S.sessions.get(sid)?.snap?.session?.title || 'the chat'
window.onDictation = msg => {
  if (msg.type === 'dictation') { dictationBox(msg.state, msg.text, chatTitle(msg.sid)); return }
  if (!Recognition) return
  if (msg.state === 'start') {
    try { deckEar?.rec.abort() } catch {}
    const id = msg.id
    let last = 0, pending = null
    const tell = (text, extra = {}) => post('/dictation', { id, text, ...extra }).catch(() => {})
    try {
      const rec = listen({
        // at most every 150 ms, the newest words to the deck
        onText: text => { pending = text; const now = Date.now(); if (now - last > 150) { last = now; tell(text); pending = null } },
        onEnd: text => { tell(text ?? pending ?? '', { final: true }); if (deckEar?.id === id) deckEar = null },
        onError: error => tell('', { error: error === 'not-allowed' ? 'Allow the microphone for the dashboard' : error }),
      })
      deckEar = { id, rec }
    } catch (e) { tell('', { error: String(e.message || e) }) }
  } else if (msg.state === 'stop' && deckEar?.id === msg.id) {
    try { deckEar.rec.stop() } catch {}
  }
}

// the 🎤 beside "Send": into the box, to look over before sending
if (Recognition && !TILE_MODE) {
  const mic = $('#pc-mic'), input = $('#pc-input')
  mic.hidden = false
  let rec = null, before = ''
  mic.onclick = () => {
    if (rec) { rec.stop(); return }
    before = input.value.trim()
    mic.classList.add('on')
    const show = text => { input.value = [before, text].filter(Boolean).join(' '); input.dispatchEvent(new Event('input', { bubbles: true })) }
    try {
      rec = listen({
        onText: show,
        onEnd: text => { show(text); rec = null; mic.classList.remove('on'); input.focus() },
        onError: error => { if (error === 'not-allowed') dictationBox('failed', 'Allow the microphone for the dashboard (the lock icon in the address bar, or Edge settings → Site permissions).', '') },
      })
    } catch { rec = null; mic.classList.remove('on') }
  }
}

// ── the Stream Deck's prompt keys, edited here (kept by the server in live-code-deck.json) ──
const DECK_MAX = 14
let deckPrompts = []
const drawDeckPrompts = () => {
  const box = $('#deck-prompts')
  box.innerHTML = deckPrompts.map((p, i) => `<div class="deck-prompt" data-i="${i}">
    <div class="num">Key ${i + 1}${i === 0 ? ' · also on the main page' : ''}</div>
    <input class="icon" data-f="icon" maxlength="2" value="${esc(p.icon ?? '▶')}" title="One character or emoji">
    <input data-f="label" maxlength="24" placeholder="Label on the key" value="${esc(p.label ?? '')}">
    <span class="tools"><button data-m="up" title="Earlier">↑</button><button data-m="down" title="Later">↓</button><button data-m="del" title="Remove">✕</button></span>
    <textarea data-f="text" placeholder="What the key sends to Claude">${esc(p.text ?? '')}</textarea>
  </div>`).join('')
  $('#deck-add').disabled = deckPrompts.length >= DECK_MAX
}
let deckSaveAt = 0
const saveDeckPrompts = () => {
  clearTimeout(deckSaveAt)
  deckSaveAt = setTimeout(() => post('/deck-prompts', { prompts: deckPrompts }).catch(() => {}), 500)
}
const loadDeckPrompts = async () => {
  try { deckPrompts = (await (await fetch('/deck-prompts', { headers: { 'X-Live-Code-Secret': SECRET } })).json()).prompts ?? [] } catch { deckPrompts = [] }
  drawDeckPrompts()
}
if (!TILE_MODE) {
  $('#deck-prompts').addEventListener('input', e => {
    const row = e.target.closest('.deck-prompt'), f = e.target.dataset.f
    if (!row || !f) return
    deckPrompts[Number(row.dataset.i)][f] = e.target.value
    saveDeckPrompts()
  })
  $('#deck-prompts').addEventListener('click', e => {
    const m = e.target.dataset?.m, row = e.target.closest('.deck-prompt')
    if (!m || !row) return
    const i = Number(row.dataset.i)
    if (m === 'del') deckPrompts.splice(i, 1)
    else { const j = m === 'up' ? i - 1 : i + 1; if (j < 0 || j >= deckPrompts.length) return; [deckPrompts[i], deckPrompts[j]] = [deckPrompts[j], deckPrompts[i]] }
    drawDeckPrompts()
    saveDeckPrompts()
  })
  $('#deck-add').onclick = () => {
    if (deckPrompts.length >= DECK_MAX) return
    deckPrompts.push({ icon: '▶', label: '', text: '' })
    drawDeckPrompts()
    $('#deck-prompts').lastElementChild?.querySelector('[data-f="label"]')?.focus()
  }
  void loadDeckPrompts()
}

// ── the site's host building it ──
// What the chat shown pushed is built by its host (Cloudflare, Vercel, Netlify):
// the server reads the host's checks on GitHub (deploys.mjs). The host tells
// only when a build is done, so the bar in between runs on how long its builds
// usually take; a build done shows for a while, then the bar goes.
{
  const SHOW_DONE_MS = 15 * 60_000
  const cloud = spin => `<svg class="${spin ? 'spin-cloud' : ''}" viewBox="0 0 32 22" width="22" height="16" aria-hidden="true"><path fill="#f38020" d="M25.6 21H7.2A6.2 6.2 0 0 1 6.4 8.7 8.4 8.4 0 0 1 22.3 6.1 6.5 6.5 0 0 1 25.6 21z"/><path fill="#faae40" d="M27.2 21h-5.4l.7-2.2a3 3 0 0 0-2-3.9l.8-.2a5.2 5.2 0 0 1 5.9 6.3z"/></svg>`
  const mark = p => (p === 'Cloudflare' ? cloud : () => '◆')
  const was = new Map() // sid|name|ref -> status, to flash a build that just finished
  const flashUntil = new Map()
  const draw = () => {
    const box = $('#deploy-bar')
    if (!box) return
    const n = Date.now()
    const list = (S.snap?.session?.deploys ?? [])
      .filter(d => d.status !== 'completed' || n - (d.completedAt || 0) < SHOW_DONE_MS)
      .sort((a, b) => (a.status === 'completed') - (b.status === 'completed') || (b.completedAt || b.startedAt) - (a.completedAt || a.startedAt))
      .slice(0, 2)
    // each row: what stays (its shape, drawn once) and what moves (time, fill)
    const rows = list.map(d => {
      const key = `${S.view}|${d.name}|${d.ref}|${d.sha}`
      const before = was.get(key)
      was.set(key, d.status)
      if (before && before !== 'completed' && d.status === 'completed') flashUntil.set(key, n + 1600)
      const site = esc(d.name.replace(/^[^:]*:\s*/, '') || d.repo)
      const where = d.preview ? `preview of <b>${esc(d.ref)}</b>` : 'live'
      const log = d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${d.conclusion === 'failure' ? 'Open the log ↗' : 'Details ↗'}</a>` : '<span></span>'
      if (d.status !== 'completed') {
        const elapsed = Math.max(0, n - d.startedAt)
        const typical = d.typicalMs || 60_000
        const over = elapsed > typical * 1.15
        return {
          key, cls: `dp${over ? ' over' : ''}`, pct: Math.min(96, (elapsed / typical) * 100),
          time: `${dur(elapsed)} · ${over ? 'taking longer than usual' : `~${dur(Math.max(1000, typical - elapsed))} left`}`,
          shape: `<span class="dp-logo">${mark(d.provider)(true)}</span><span class="dp-text"><b>${esc(d.provider)}</b> builds ${site} · ${where} · ${esc(d.sha)}</span><span class="dp-time"></span>${log}<div class="dp-track"><i></i></div>`,
          tip: `${d.provider} tells only when a build is done: the bar follows how long its builds usually take (${dur(typical)})`,
        }
      }
      const ok = d.conclusion === 'success'
      return {
        key, cls: `dp ${ok ? 'ok' : 'fail'}${(flashUntil.get(key) ?? 0) > n ? ' just' : ''}`, pct: null,
        time: d.completedAt ? `${dur(Math.max(0, n - d.completedAt))} ago` : '',
        shape: `<span class="dp-logo">${mark(d.provider)(false)}</span><span class="dp-text">${ok ? '✓' : '✗'} <b>${esc(d.provider)}</b> ${ok ? 'deployed' : d.conclusion === 'cancelled' ? 'cancelled' : 'build failed'} · ${site} · ${where} · ${esc(d.sha)}</span><span class="dp-time"></span>${log}`,
        tip: '',
      }
    })
    // the same rows as before: only their time and fill change, so the bar glides
    const keys = rows.map(r => `${r.key}|${r.pct === null}`).join('\n')
    if (box.dataset.keys !== keys) {
      box.dataset.keys = keys
      box.innerHTML = rows.map(r => `<div class="${r.cls}" title="${esc(r.tip)}">${r.shape}</div>`).join('')
    }
    rows.forEach((r, i) => {
      const el = box.children[i]
      if (el.className !== r.cls) el.className = r.cls
      setText(el.querySelector('.dp-time'), r.time)
      const fill = el.querySelector('.dp-track i')
      if (fill && r.pct !== null) fill.style.width = `${r.pct.toFixed(1)}%`
    })
    box.hidden = rows.length === 0
  }
  setInterval(draw, 1000)
  window.drawDeploys = draw
}
