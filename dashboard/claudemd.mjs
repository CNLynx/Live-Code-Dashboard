// ── the instructions a chat runs under: its CLAUDE.md files ──
// For one chat: the global ~/.claude/CLAUDE.md, the CLAUDE.md (and
// CLAUDE.local.md, .claude/CLAUDE.md) of its folder and each folder above it,
// and its project's memory index (MEMORY.md), as Claude Code loads them. For
// each: where it applies, the chats it applies to, and what it refers to (the
// skills, mods, folders, files, commands and pages it names, at which line and
// under which heading), whether each is there, and how often Claude used it
// (sources.mjs). Saved from the dashboard: only a file of this list, only when
// it is still as it was read, the version before kept in
// ~/.claude/live-code-claude-md-backups (the newest 40).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sourcesAll } from './sources.mjs'

const MAX_BYTES = 512 * 1024
const BACKUPS_KEPT = 40

const stat = f => { try { return fs.statSync(f) } catch { return null } }
const read = f => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
const expand = (p, cwd) => {
  let x = p.replace(/^~(?=[\\/]|$)/, os.homedir()).replace(/%USERPROFILE%/gi, os.homedir())
  if (!path.isAbsolute(x) && cwd) x = path.resolve(cwd, x)
  return x
}
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

// The files, in the order Claude Code reads them: global first, then from the
// drive down to the chat's folder, its memory last.
export const instructionFiles = ({ cwd, transcript, home }) => {
  const out = []
  const add = (file, scope, create = false) => {
    if (out.some(f => same(f.path, file))) return
    const st = stat(file)
    if (!st && !create) return
    out.push({ path: file, scope, exists: !!st })
  }
  add(path.join(home, 'CLAUDE.md'), 'global', true)
  if (cwd && path.isAbsolute(cwd)) {
    const chain = []
    for (let d = path.resolve(cwd); ; d = path.dirname(d)) { chain.unshift(d); if (path.dirname(d) === d) break }
    for (const d of chain) {
      if (same(d, os.homedir())) continue
      const here = same(d, cwd)
      add(path.join(d, 'CLAUDE.md'), here ? 'project' : 'parent', here)
      add(path.join(d, '.claude', 'CLAUDE.md'), here ? 'project' : 'parent')
      add(path.join(d, 'CLAUDE.local.md'), 'local')
    }
  }
  if (transcript) add(path.join(path.dirname(transcript), 'memory', 'MEMORY.md'), 'memory')
  return out
}

// What a text names, each with the lines it stands on and its heading.
const refsIn = (text, { cwd, home }) => {
  const skills = new Set()
  for (const dir of [path.join(home, 'skills')]) { try { for (const d of fs.readdirSync(dir)) skills.add(d.toLowerCase()) } catch {} }
  const mods = new Set()
  try { for (const d of fs.readdirSync(path.join(home, 'my-mods'))) mods.add(d.toLowerCase()) } catch {}
  const refs = new Map()
  let heading = ''
  const note = (kind, name, line, extra = {}) => {
    const key = `${kind}|${name.toLowerCase()}`
    const r = refs.get(key) ?? { kind, name, lines: [], headings: [], ...extra }
    if (!r.lines.includes(line)) r.lines.push(line)
    if (heading && !r.headings.includes(heading)) r.headings.push(heading)
    refs.set(key, r)
  }
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1
    const h = /^#{1,6}\s+(.+)/.exec(raw)
    if (h) { heading = h[1].replace(/[*_`]/g, '').trim(); return }
    for (const m of raw.matchAll(/`([^`\n]{2,160})`/g)) {
      const t = m[1].trim()
      const low = t.toLowerCase()
      if (skills.has(low)) note('skill', t, line, { exists: true })
      else if (mods.has(low)) note('mod', t, line, { exists: true })
      else if (/^\/[\w:-]+$/.test(t)) note('command', t, line, {})
      else if (/^(~|[A-Za-z]:[\\/]|\.{0,2}[\\/]|%\w+%)/.test(t) || (/[\\/]/.test(t) && !/\s/.test(t) && /\.\w{1,6}$|[\\/]$/.test(t))) {
        const p = expand(t.replace(/[\\/]<[^>]+>.*$/, ''), cwd)
        note('path', t, line, { exists: !!stat(p) })
      } else if (/^(\/[\w:-]+)$/.test(t)) note('command', t, line, {})
      else if (/^(npx|npm|git|node|claude|gh|pip|python)\b/.test(t)) note('command', t.split(/\s+/).slice(0, 3).join(' '), line, {})
      else if (/^[\w.-]+\/[\w.-]+$/.test(t) && !/\.(md|js|ts|json)$/i.test(t)) note('repo', t, line, {})
    }
    for (const m of raw.matchAll(/«([^»]{2,60})»/g)) if (mods.has(m[1].toLowerCase())) note('mod', m[1], line, { exists: true })
    for (const m of raw.matchAll(/https?:\/\/[^\s)>\]]+/g)) note('link', m[0], line, {})
  })
  return [...refs.values()]
}

// How often Claude used what a reference names (sources.mjs), over all chats.
const usageOf = (ref, titleOf) => {
  const low = ref.name.toLowerCase()
  const hit = sourcesAll().filter(e => {
    const n = e.name.toLowerCase()
    if (ref.kind === 'skill' || ref.kind === 'mod') return (e.kind === 'skill' || e.kind === 'design') && (n === low || String(e.detail).toLowerCase() === low)
    if (ref.kind === 'repo') return e.kind === 'repo' && n === low
    if (ref.kind === 'path') return (/design-md/.test(low) && e.kind === 'design' && e.detail === 'awesome-design-md') || ((e.kind === 'memory' || e.kind === 'skill') && low.includes(n))
    if (ref.kind === 'command') return (e.kind === 'package' || e.kind === 'skill') && low.includes(n)
    return false
  })
  if (hit.length === 0) return null
  const chats = [...new Set(hit.map(e => e.sid))]
  return { uses: hit.reduce((s, e) => s + e.uses.length, 0), last: Math.max(...hit.map(e => e.at)), chats: chats.slice(0, 6).map(sid => ({ sid, title: titleOf(sid) })), chatCount: chats.length }
}

export const claudeMdFor = ({ sid, cwd, transcript, home, sessions, titleOf }) =>
  instructionFiles({ cwd, transcript, home }).map(f => {
    const st = stat(f.path)
    const text = st && st.size <= MAX_BYTES ? read(f.path) ?? '' : ''
    const dir = path.dirname(f.path)
    // the chats it applies to: all for the global file, else those working at or below its folder
    const applies = f.scope === 'global' ? sessions : f.scope === 'memory' ? sessions.filter(s => s.transcript && same(path.dirname(s.transcript), path.dirname(transcript))) : sessions.filter(s => s.cwd && (path.resolve(s.cwd) + path.sep).toLowerCase().startsWith((same(path.basename(dir), '.claude') ? path.dirname(dir) : dir).toLowerCase() + path.sep))
    const refs = refsIn(text, { cwd, home }).map(r => ({ ...r, used: usageOf(r, titleOf) }))
    // read on purpose (a Read of this very file), beside being loaded each turn
    const reads = sourcesAll().filter(e => e.kind === 'memory' && (e.name === 'CLAUDE.md' || e.name === 'memory index') && e.sid === sid)
    return {
      path: f.path, scope: f.scope, exists: f.exists, sid,
      size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0, tooBig: !!st && st.size > MAX_BYTES,
      text, refs,
      chats: applies.slice(0, 12).map(s => ({ sid: s.sid, title: s.title })), chatCount: applies.length,
      readAt: reads.length ? Math.max(...reads.map(e => e.at)) : 0,
    }
  })

// Saving: one of this chat's files, unchanged since it was read; the earlier text kept.
export const saveClaudeMd = ({ allowed, file, text, mtime, home }) => {
  if (typeof file !== 'string' || typeof text !== 'string') return { error: 'bad request' }
  if (!allowed.some(f => same(f.path, file))) return { error: 'not one of this chat’s instruction files' }
  if (Buffer.byteLength(text) > MAX_BYTES) return { error: 'too large' }
  const st = stat(file)
  if (st && Math.abs(st.mtimeMs - (Number(mtime) || 0)) > 1) return { error: 'changed meanwhile', mtime: st.mtimeMs, text: read(file) ?? '' }
  const backups = path.join(home, 'live-code-claude-md-backups')
  try {
    if (st) {
      fs.mkdirSync(backups, { recursive: true })
      const name = `${path.basename(path.dirname(file)).replace(/[^\w.-]+/g, '_')}-${path.basename(file)}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`
      fs.copyFileSync(file, path.join(backups, name))
      const all = fs.readdirSync(backups).map(n => ({ n, t: stat(path.join(backups, n))?.mtimeMs ?? 0 })).sort((a, b) => b.t - a.t)
      for (const old of all.slice(BACKUPS_KEPT)) fs.rmSync(path.join(backups, old.n), { force: true })
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, text)
    fs.renameSync(temp, file)
    return { ok: true, mtime: stat(file)?.mtimeMs ?? 0 }
  } catch (e) { return { error: String(e?.message ?? e) } }
}
