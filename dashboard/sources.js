// Live Code dashboard: what Claude takes help from, and the instructions it runs under.
// - The tile "Sources & help" (in German "Quellen & Hilfen"): every skill, design
//   reference, repository, page, search, documentation tool, helper agent,
//   package and memory Claude used (server: sources.mjs), counted for the chat
//   or range shown; opened large, all of it by prompt, filtered by kind.
// - The tile "Instructions" ("Anweisungen"): the CLAUDE.md files the chat runs
//   under (server: claudemd.mjs). A click opens them to read and edit, beside
//   what each names (skills, mods, folders, commands), whether it is there,
//   where it stands in the file and how often Claude used it.
// Words follow the browser's language: German or English.
(() => {
  if (TILE_MODE) return
  const DE = /^de/i.test(navigator.language || '')
  const T = DE ? {
    tile: 'Quellen & Hilfen', none: 'noch nichts genutzt', uses: n => `${n}×`, all: 'Alle', chats: n => `${n} ${n === 1 ? 'Chat' : 'Chats'}`,
    byPrompt: 'Nach Prompt, das Neuste zuoberst', earlier: 'früher', noneHere: 'In dieser Auswahl hat Claude noch keine Quellen oder Hilfen benutzt.',
    kinds: { skill: 'Skill', design: 'Design-Referenz', repo: 'Repository', web: 'Webseite', search: 'Websuche', docs: 'Doku', helper: 'Helfer-Agent', package: 'Paket', memory: 'Erinnerung & Anweisungen' },
    instr: 'Anweisungen', files: n => `${n} ${n === 1 ? 'Datei' : 'Dateien'}`, instrFoot: (n, l) => `${n} Verweise · ${l} Zeilen`, open: 'Klick: lesen und bearbeiten',
    sheet: 'CLAUDE.md & Anweisungen', save: 'Speichern', revert: 'Verwerfen', saved: 'Gespeichert', saving: 'Speichert…', unsaved: 'Ungespeicherte Änderungen',
    dirty: 'Erst speichern oder verwerfen', conflict: 'Die Datei wurde inzwischen ausserhalb geändert.', theirs: 'Ihre Fassung laden', mine: 'Meine trotzdem speichern',
    applies: 'Wo sie gilt', refers: 'Was sie nennt', noRefs: 'Nennt keine Skills, Mods, Ordner oder Befehle.', line: 'Zeile', lines: 'Zeilen', under: 'unter',
    used: (n, t) => `${n}× benutzt · zuletzt ${t}`, notUsed: 'noch nicht benutzt', missing: 'fehlt', there: 'vorhanden', inChats: 'in',
    scope: { global: 'Gilt für jeden Chat in jedem Projekt.', project: 'Gilt für Chats in diesem Ordner und darunter.', parent: 'Gilt hier, aus einem Ordner weiter oben.', local: 'Deine persönliche Datei für diesen Ordner (nicht geteilt).', memory: 'Claudes Erinnerungs-Index für dieses Projekt.' },
    loads: 'Claude lädt sie zu Beginn jedes Chats.', create: 'Noch nicht vorhanden: schreiben und speichern legt sie an.', chatsHere: n => `${n} ${n === 1 ? 'Chat' : 'Chats'}`,
    refKinds: { skill: 'Skills', mod: 'Mods', path: 'Ordner & Dateien', command: 'Befehle', repo: 'Repositories', link: 'Links' }, backup: 'Die vorige Fassung liegt in ~/.claude/live-code-claude-md-backups.',
    loadErr: 'Konnte die Dateien nicht laden.', tooBig: 'Zu gross zum Bearbeiten hier.', stale: 'Das Dashboard wurde inzwischen neu gestartet: Seite neu laden (F5), dein Text bleibt erhalten, dann speichern.', draft: 'Ungespeicherter Entwurf wiederhergestellt',
  } : {
    tile: 'Sources & help', none: 'nothing used yet', uses: n => `${n}×`, all: 'All', chats: n => `${n} ${n === 1 ? 'chat' : 'chats'}`,
    byPrompt: 'By prompt, the newest first', earlier: 'earlier', noneHere: 'Claude has used no sources or help in this view yet.',
    kinds: { skill: 'Skill', design: 'Design reference', repo: 'Repository', web: 'Web page', search: 'Web search', docs: 'Documentation', helper: 'Helper agent', package: 'Package', memory: 'Memory & instructions' },
    instr: 'Instructions', files: n => `${n} ${n === 1 ? 'file' : 'files'}`, instrFoot: (n, l) => `${n} references · ${l} lines`, open: 'Click: read and edit',
    sheet: 'CLAUDE.md & instructions', save: 'Save', revert: 'Discard', saved: 'Saved', saving: 'Saving…', unsaved: 'Unsaved changes',
    dirty: 'Save or discard first', conflict: 'The file was changed elsewhere meanwhile.', theirs: 'Load that version', mine: 'Save mine anyway',
    applies: 'Where it applies', refers: 'What it names', noRefs: 'It names no skills, mods, folders or commands.', line: 'line', lines: 'lines', under: 'under',
    used: (n, t) => `used ${n}× · last ${t}`, notUsed: 'not used yet', missing: 'missing', there: 'there', inChats: 'in',
    scope: { global: 'Applies to every chat in every project.', project: 'Applies to chats in this folder and below.', parent: 'Applies here, from a folder above.', local: 'Your personal file for this folder (not shared).', memory: 'Claude’s memory index for this project.' },
    loads: 'Claude loads it at the start of each chat.', create: 'Not there yet: write and save to create it.', chatsHere: n => `${n} ${n === 1 ? 'chat' : 'chats'}`,
    refKinds: { skill: 'Skills', mod: 'Mods', path: 'Folders & files', command: 'Commands', repo: 'Repositories', link: 'Links' }, backup: 'The version before is kept in ~/.claude/live-code-claude-md-backups.',
    loadErr: 'Could not load the files.', tooBig: 'Too large to edit here.', stale: 'The dashboard restarted meanwhile: reload the page (F5), your text is kept, then save.', draft: 'Unsaved draft restored',
  }
  // (the server's few words on how a thing was used, in German)
  const HOW_DE = { skill: 'Skill', read: 'gelesen', cloned: 'geklont', 'run with npx': 'mit npx ausgeführt', 'looked up': 'nachgeschlagen', 'its source read': 'Quelltext gelesen', searched: 'durchsucht', downloaded: 'heruntergeladen', 'web search': 'Websuche', memory: 'Erinnerung', 'read by a helper': 'von einem Helfer gelesen', 'given to a helper': 'einem Helfer mitgegeben', 'plugin files': 'Plugin-Dateien', command: 'Befehl', global: 'global' }
  const how = d => (DE ? HOW_DE[d] ?? d : d) ?? ''
  const ICON = { skill: '🧩', design: '🎨', repo: '📁', web: '🌐', search: '🔎', docs: '📖', helper: '🤖', package: '📦', memory: '🧠' }
  const KINDS = Object.keys(ICON)
  const short = p => String(p ?? '').replace(/\\/g, '/').split('/').slice(-3).join('/')
  const titleOf = sid => S.sessions.get(sid)?.snap?.session?.title ?? String(sid ?? '').slice(0, 8)

  // ── sources ──
  S.sources = []
  const fresh = new Set()
  const redraw = () => { drawTiles(); if (bigTile === tileKey(T.tile)) drawBigTile() }
  window.onSources = list => { S.sources = Array.isArray(list) ? list : []; redraw() }
  window.onSource = s => {
    if (!s?.id) return
    const i = S.sources.findIndex(x => x.id === s.id)
    if (i >= 0) S.sources[i] = s
    else { S.sources.push(s); fresh.add(s.id); setTimeout(() => fresh.delete(s.id), 4000); if (S.sources.length > 600) S.sources.shift() }
    redraw()
  }
  // what the tiles cover now: the chat shown (or all), today or all time as the range says
  const scopedSources = () => {
    const from = S.range === 'today' ? new Date().setHours(0, 0, 0, 0) : 0
    return S.sources.filter(s => (S.selected === 'all' || s.sid === S.view) && s.at >= from)
  }
  window.sourcesTile = () => {
    const list = scopedSources()
    const uses = list.reduce((n, s) => n + (s.count ?? 1), 0)
    const byKind = KINDS.map(k => [k, list.filter(s => s.kind === k).length]).filter(([, n]) => n)
    const newest = list.slice().sort((a, b) => b.at - a.at).slice(0, 3)
    return {
      label: T.tile,
      value: counter(`src:${S.range}:${S.selected === 'all' ? 'all' : S.view}`, list.length, 'int'),
      foot: list.length ? newest.map(s => `${ICON[s.kind]} ${esc(s.name.length > 22 ? s.name.slice(0, 21) + '…' : s.name)}`).join(' · ') : T.none,
      tip: byKind.length ? `${byKind.map(([k, n]) => `${ICON[k]} ${T.kinds[k]}: ${n}`).join('\n')}\n${uses} ${DE ? 'Verwendungen' : 'uses'}` : '',
    }
  }

  let kindFilter = null
  const rowOf = s => {
    const name = s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : `<b>${esc(s.name)}</b>`
    const chat = S.selected === 'all' ? `<span class="muted"> · ${esc(titleOf(s.sid))}</span>` : ''
    return `<div class="d-row src-row${fresh.has(s.id) ? ' fresh' : ''}" data-tip="${esc(`${T.kinds[s.kind] ?? s.kind}\n${s.name}${s.detail ? `\n${how(s.detail)}` : ''}`)}">` +
      `<span class="d-name"><span class="src-ic" aria-hidden="true">${ICON[s.kind] ?? '•'}</span>${name}<span class="muted src-det">${esc(how(s.detail))}</span>${chat}</span>` +
      `<span class="d-num num muted">${(s.count ?? 1) > 1 ? `${T.uses(s.count)} · ` : ''}${hm(s.at)}</span></div>`
  }
  const sourcesDetail = () => {
    const list = scopedSources()
    const counts = Object.fromEntries(KINDS.map(k => [k, list.filter(s => s.kind === k).length]))
    if (kindFilter && !counts[kindFilter]) kindFilter = null
    const chips = `<div class="src-chips" role="group">${[[null, T.all, list.length], ...KINDS.filter(k => counts[k]).map(k => [k, `${ICON[k]} ${T.kinds[k]}`, counts[k]])]
      .map(([k, label, n]) => `<button class="src-chip${kindFilter === k ? ' on' : ''}" data-src-kind="${k ?? ''}" aria-pressed="${kindFilter === k}">${label} <span class="num">${n}</span></button>`).join('')}</div>`
    const shown = list.filter(s => !kindFilter || s.kind === kindFilter).sort((a, b) => b.at - a.at)
    // one group per prompt (of its chat), the one used last first
    const groups = new Map()
    for (const s of shown) {
      const k = `${s.sid}|${s.prompt?.at ?? 0}`
      if (!groups.has(k)) groups.set(k, { prompt: s.prompt, sid: s.sid, items: [] })
      groups.get(k).items.push(s)
    }
    const body = groups.size ? [...groups.values()].map(g => `<div class="src-group"><div class="src-prompt">› ${esc(g.prompt?.text || T.earlier)}${S.selected === 'all' ? ` <span class="muted">· ${esc(titleOf(g.sid))}</span>` : ''}</div><div class="d-rows">${g.items.map(rowOf).join('')}</div></div>`).join('') : nothingHtml(T.noneHere)
    return stats(KINDS.filter(k => counts[k]).slice(0, 6).map(k => stat(`${ICON[k]} ${T.kinds[k]}`, String(counts[k]), plural2(list.filter(s => s.kind === k).reduce((n, s) => n + (s.count ?? 1), 0))))) + chips + section(T.byPrompt, body)
  }
  const plural2 = n => (DE ? `${n} Verwendung${n === 1 ? '' : 'en'}` : `${n} use${n === 1 ? '' : 's'}`)
  const nothingHtml = text => `<div class="d-empty">${esc(text)}</div>`
  const stat = (label, value, sub = '') => `<div class="d-stat"><div class="d-l">${label}</div><div class="d-v num">${value}</div>${sub ? `<div class="d-s">${sub}</div>` : ''}</div>`
  const stats = items => (items.length ? `<div class="d-stats">${items.join('')}</div>` : '')
  const section = (title, inner) => `<section class="d-sec"><h5>${title}</h5>${inner}</section>`
  window.extraDetail = window.extraDetail ?? {}
  window.extraDetail[tileKey(T.tile)] = sourcesDetail
  document.addEventListener('click', e => {
    const chip = e.target.closest('.src-chip')
    if (!chip) return
    kindFilter = chip.dataset.srcKind || null
    drawBigTile()
  })

  // ── the instructions: CLAUDE.md ──
  const CM = { sid: null, files: [], at: 0, busy: false }
  const loadCm = async sid => {
    if (CM.busy) return
    CM.busy = true
    try { const r = await fetch(`/claude-md?sid=${encodeURIComponent(sid)}`, { cache: 'no-store' }); const j = await r.json(); CM.files = j.files ?? []; CM.sid = sid; CM.at = Date.now() } catch {}
    CM.busy = false
    drawTiles()
  }
  window.claudeTile = () => {
    if (!S.view) return null
    if (CM.sid !== S.view || Date.now() - CM.at > 60_000) void loadCm(S.view)
    const there = CM.files.filter(f => f.exists)
    const refs = there.reduce((n, f) => n + f.refs.length, 0)
    const lines = there.reduce((n, f) => n + (f.text ? f.text.split('\n').length : 0), 0)
    return { label: T.instr, value: counter(`cm:${S.view}`, there.length, 'int') + '<small>CLAUDE.md</small>', foot: there.length ? T.instrFoot(refs, lines) : T.none, tip: `${there.map(f => `${short(f.path)} · ${T.scope[f.scope] ?? ''}`).join('\n')}\n${T.open}` }
  }
  window.tileClick = key => { if (key !== tileKey(T.instr)) return false; void openCm(); return true }

  const ed = { file: null, base: '', dirty: false }
  const fmtAt = t => (t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')
  const refHtml = r => {
    const where = `${r.lines.length > 1 ? T.lines : T.line} ${r.lines.slice(0, 6).join(', ')}${r.headings.length ? ` · ${T.under} „${esc(r.headings[0])}“` : ''}`
    const state = r.exists === true ? `<span class="cm-ok">✓ ${T.there}</span>` : r.exists === false ? `<span class="cm-miss">✗ ${T.missing}</span>` : ''
    const used = r.used ? `<span class="cm-used">${T.used(r.used.uses, fmtAt(r.used.last))}${r.used.chatCount ? ` · ${T.inChats} ${esc(r.used.chats.map(c => c.title).slice(0, 2).join(', '))}${r.used.chatCount > 2 ? ` +${r.used.chatCount - 2}` : ''}` : ''}</span>` : (r.kind === 'skill' || r.kind === 'repo') ? `<span class="muted">${T.notUsed}</span>` : ''
    const name = r.kind === 'link' ? `<a href="${esc(r.name)}" target="_blank" rel="noopener" translate="no">${esc(r.name.replace(/^https?:\/\//, ''))}</a>` : `<code translate="no">${esc(r.name)}</code>`
    return `<button class="cm-ref" data-line="${r.lines[0]}" title="${esc(where)}"><span class="cm-ref-name">${name} ${state}</span><span class="cm-ref-meta">${where}</span>${used ? `<span class="cm-ref-meta">${used}</span>` : ''}</button>`
  }
  const sideHtml = f => {
    const groups = Object.keys(T.refKinds).map(k => [k, f.refs.filter(r => r.kind === k)]).filter(([, l]) => l.length)
    return `<section><h6>${T.applies}</h6><p>${T.scope[f.scope] ?? ''} ${f.exists ? T.loads : T.create}</p>` +
      `<p class="muted">${esc(f.path)}</p>` +
      (f.chatCount ? `<p class="cm-chats">${T.chatsHere(f.chatCount)}: ${f.chats.map(c => `<span>${esc(c.title)}</span>`).join('')}${f.chatCount > f.chats.length ? ` <span>+${f.chatCount - f.chats.length}</span>` : ''}</p>` : '') +
      `</section><section><h6>${T.refers}</h6>${groups.length ? groups.map(([k, l]) => `<div class="cm-refgroup"><div class="cm-refkind">${T.refKinds[k]} <span class="num">${l.length}</span></div>${l.map(refHtml).join('')}</div>`).join('') : `<p class="muted">${T.noRefs}</p>`}</section>`
  }
  const fileTab = (f, i) => `<button class="${f.path === ed.file?.path ? 'on' : ''}" data-cm-file="${i}" title="${esc(f.path)}">${esc(f.scope === 'memory' ? 'MEMORY.md' : short(f.path).split('/').slice(-2).join('/'))}${f.exists ? '' : ' +'}</button>`
  const drawSheet = () => {
    const f = ed.file
    sheet.innerHTML = `<div class="sh"><b>${T.sheet}</b><div class="tabs">${CM.files.map(fileTab).join('')}</div><button class="x" id="cm-close" aria-label="Close">✕</button></div>` +
      `<div class="cm-body"><div class="cm-edit"><textarea id="cm-text" spellcheck="false" aria-label="${esc(f?.path ?? '')}"${f?.tooBig ? ' readonly' : ''}></textarea>` +
      `<div class="cm-bar"><span class="cm-status" id="cm-status" role="status">${f?.tooBig ? T.tooBig : ''}</span><button class="btn" id="cm-revert" disabled>${T.revert}</button><button class="btn primary" id="cm-save" disabled>${T.save}</button></div></div>` +
      `<aside class="cm-side" id="cm-side">${f ? sideHtml(f) : ''}</aside></div>`
    const ta = $('#cm-text')
    ta.value = f?.text ?? ''
    ed.base = ta.value; ed.dirty = false
    // (text not saved yet survives a reload of the page: kept in this tab until saved or discarded)
    const draft = f ? draftOf(f.path) : null
    if (draft != null && draft !== ed.base) { ta.value = draft; setDirty(true); setText($('#cm-status'), T.draft) }
    ta.addEventListener('input', () => { setDirty(ta.value !== ed.base); keepDraft(f?.path, ed.dirty ? ta.value : null) })
    ta.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void saveCm() } })
    $('#cm-save').onclick = () => void saveCm()
    $('#cm-revert').onclick = () => { ta.value = ed.base; setDirty(false); keepDraft(f?.path, null) }
    $('#cm-close').onclick = () => tryClose()
  }
  const draftOf = p => { try { return sessionStorage.getItem(`lc.cmDraft:${p}`) } catch { return null } }
  const keepDraft = (p, text) => { if (!p) return; try { text == null ? sessionStorage.removeItem(`lc.cmDraft:${p}`) : sessionStorage.setItem(`lc.cmDraft:${p}`, text) } catch {} }
  const setDirty = d => {
    ed.dirty = d
    $('#cm-save').disabled = !d
    $('#cm-revert').disabled = !d
    setText($('#cm-status'), d ? T.unsaved : '')
  }
  const saveCm = async (force = false) => {
    const f = ed.file, ta = $('#cm-text')
    if (!f || (!ed.dirty && !force)) return
    setText($('#cm-status'), T.saving)
    let j = {}
    try {
      const r = await fetch('/claude-md', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Live-Code-Secret': SECRET }, body: JSON.stringify({ sid: CM.sid, path: f.path, text: ta.value, mtime: f.mtime }) })
      // (refused: the dashboard started anew meanwhile, with a new key; the page reloads once the text is safe)
      j = r.status === 403 ? { error: T.stale } : await r.json()
    } catch (e) { j = { error: String(e) } }
    if (j.ok) {
      f.text = ta.value; f.mtime = j.mtime; f.exists = true
      ed.base = ta.value; setDirty(false); keepDraft(f.path, null)
      setText($('#cm-status'), `${T.saved} · ${T.backup}`)
      // what it names now
      const keep = f.path
      await loadCm(CM.sid)
      ed.file = CM.files.find(x => x.path === keep) ?? ed.file
      setHtml($('#cm-side'), sideHtml(ed.file))
      return
    }
    if (j.error === 'changed meanwhile') {
      const st = $('#cm-status')
      st.innerHTML = `${T.conflict} <button class="btn" id="cm-theirs">${T.theirs}</button> <button class="btn" id="cm-mine">${T.mine}</button>`
      $('#cm-theirs').onclick = () => { f.text = j.text; f.mtime = j.mtime; ta.value = j.text; ed.base = j.text; setDirty(false); keepDraft(f.path, null) }
      $('#cm-mine').onclick = () => { f.mtime = j.mtime; void saveCm(true) }
      return
    }
    setText($('#cm-status'), String(j.error ?? 'error'))
  }
  // closing with changes unsaved: said once; a second try closes
  let warned = 0
  const tryClose = () => {
    if (ed.dirty && Date.now() - warned > 4000) { warned = Date.now(); setText($('#cm-status'), T.dirty); $('#cm-text').focus(); return false }
    ed.dirty = false; ed.file = null
    closeSheet()
    return true
  }
  // (leaving the page with changes unsaved: the browser asks first; the draft is kept besides)
  addEventListener('beforeunload', e => { if (ed.file && ed.dirty) { e.preventDefault(); e.returnValue = '' } })
  sheetWrap.addEventListener('click', e => { if (e.target === sheetWrap && ed.file && !tryClose()) e.stopImmediatePropagation() }, true)
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && ed.file && !sheetWrap.hidden) { e.stopImmediatePropagation(); tryClose() } }, true)
  sheet.addEventListener('click', e => {
    const tab = e.target.closest('[data-cm-file]')
    if (tab && ed.file) {
      if (ed.dirty) { setText($('#cm-status'), T.dirty); return }
      ed.file = CM.files[Number(tab.dataset.cmFile)]
      drawSheet()
      return
    }
    const ref = e.target.closest('.cm-ref')
    if (ref && !e.target.closest('a')) goLine(Number(ref.dataset.line))
  })
  // a reference's line: selected in the text, scrolled to a third from the top
  const goLine = n => {
    const ta = $('#cm-text')
    if (!ta || !n) return
    const lines = ta.value.split('\n')
    const start = lines.slice(0, n - 1).reduce((s, l) => s + l.length + 1, 0)
    ta.focus()
    ta.setSelectionRange(start, start + (lines[n - 1]?.length ?? 0))
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 19
    ta.scrollTo({ top: Math.max(0, (n - 1) * lh - ta.clientHeight / 3), behavior: reduceMotion ? 'auto' : 'smooth' })
  }
  const openCm = async () => {
    await loadCm(S.view)
    if (!CM.files.length) { smallToast(T.loadErr, 'bad'); return }
    ed.file = CM.files.find(f => f.exists && f.scope === 'project') ?? CM.files.find(f => f.exists) ?? CM.files[0]
    sheet.classList.add('cm')
    drawSheet()
    reveal(sheetWrap, true, 'pop')
    $('#cm-text').focus()
  }
  // what the page was told before this script ran
  if (window.__srcInit) window.onSources(window.__srcInit)
  // (the sheet serves the diffs too: its look for them back once closed)
  new MutationObserver(() => { if (sheetWrap.hidden) sheet.classList.remove('cm') }).observe(sheetWrap, { attributes: true, attributeFilter: ['hidden'] })
})()
