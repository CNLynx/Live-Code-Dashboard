// ── what Claude takes help from, for the "Sources & help" tile ──
// From each tool call in a chat's transcript (images.mjs reads it): the skills
// it loads and the files of skills it reads, design references (awesome-design-md,
// the taste library), repositories it clones or reads on GitHub, pages it fetches
// and what it searches the web for, documentation tools and guide agents, other
// helper agents, packages it runs or looks up, and its own memories and
// CLAUDE.md. One entry per thing and prompt, with how often it was used; kept in
// ~/.claude/live-code-sources.json over restarts, the newest 600.
import fs from 'node:fs'
import path from 'node:path'

const KEEP = 600
let tell = () => {}
let file = null
let list = [] // entries, oldest first
let nextId = 1
let saveDue = null

const norm = p => String(p ?? '').replace(/\\/g, '/')
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const host = url => { try { return new URL(url).host.replace(/^www\./, '') } catch { return '' } }
const ghRepo = url => /github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/i.exec(url) ?? /raw\.githubusercontent\.com\/([\w.-]+)\/([\w.-]+)\//i.exec(url)
const URLS = /https?:\/\/[^\s"'<>)\]]+/g

// A path read, searched or listed: what kind of help it is, if any.
const fromPath = raw => {
  const p = norm(raw)
  const brand = /design-md\/design-md\/([^/]+)\//.exec(p)
  if (brand) return { kind: 'design', name: brand[1], detail: 'awesome-design-md' }
  if (/\.claude\/design-md(\/|$)/.test(p)) return { kind: 'design', name: 'awesome-design-md', detail: 'searched' }
  const taste = /skills\/design-taste-frontend\/(library|references)\/([^/]+)$/.exec(p)
  if (taste) return { kind: 'design', name: `taste ${taste[1] === 'library' ? 'library' : 'rules'}: ${taste[2]}`, detail: 'design-taste-frontend' }
  const skill = /(?:\/skills\/|bundled-skills\/[^/]+\/[^/]+\/)([\w.-]+)\/(.+)$/.exec(p)
  if (skill && !/\.claude\/projects\//.test(p)) return { kind: 'skill', name: skill[1], detail: skill[2] }
  const mem = /\.claude\/projects\/[^/]+\/memory\/([^/]+)\.md$/.exec(p)
  if (mem) return { kind: 'memory', name: mem[1] === 'MEMORY' ? 'memory index' : mem[1], detail: 'memory' }
  if (/(^|\/)CLAUDE\.md$/i.test(p)) return { kind: 'memory', name: 'CLAUDE.md', detail: p.includes('/.claude/CLAUDE.md') ? 'global' : path.posix.dirname(p).split('/').pop() }
  const mod = /\/node_modules\/((?:@[\w.-]+\/)?[\w.-]+)\//.exec(p)
  if (mod) return { kind: 'package', name: mod[1], detail: 'its source read' }
  const plugin = /\.claude\/plugins\/(?:cache|marketplaces)\/[^/]+\/([\w.-]+)\//.exec(p)
  if (plugin) return { kind: 'skill', name: plugin[1], detail: 'plugin files' }
  return null
}

// A shell command: what it clones, runs or looks up.
const fromCommand = cmd => {
  const c = norm(cmd)
  const out = []
  for (const m of c.matchAll(/\bgit\s+clone\s+(?:--?[\w-]+(?:[= ]\S+)?\s+)*(\S+)/g)) {
    const r = ghRepo(m[1])
    out.push({ kind: 'repo', name: r ? `${r[1]}/${r[2]}` : clip(m[1], 60), detail: 'cloned', url: r ? `https://github.com/${r[1]}/${r[2]}` : '' })
  }
  for (const m of c.matchAll(/\bgh\s+(?:repo\s+(?:view|clone)|api\s+repos\/)\s*([\w.-]+\/[\w.-]+)/g)) out.push({ kind: 'repo', name: m[1], detail: 'GitHub CLI', url: `https://github.com/${m[1]}` })
  for (const m of c.matchAll(/\bnpx\s+(?:-y\s+|--yes\s+)?(?:-p\s+(\S+)\s+)?(@?[\w./-]+(?:@[\w.-]+)?)/g)) {
    const pkg = (m[1] ?? m[2]).replace(/^(@?[^@]+)@.*$/, '$1')
    if (pkg && !pkg.startsWith('-')) out.push({ kind: 'package', name: pkg, detail: 'run with npx', url: `https://www.npmjs.com/package/${pkg}` })
  }
  for (const m of c.matchAll(/\bnpm\s+(?:view|info|show|docs)\s+(@?[\w./-]+)/g)) out.push({ kind: 'package', name: m[1], detail: 'looked up', url: `https://www.npmjs.com/package/${m[1]}` })
  for (const m of c.matchAll(/\bpip3?\s+(?:show|download)\s+([\w.-]+)/g)) out.push({ kind: 'package', name: m[1], detail: 'looked up', url: `https://pypi.org/project/${m[1]}/` })
  const script = /design-taste-frontend\/scripts\/([\w.-]+\.mjs)/.exec(c)
  if (script) out.push({ kind: 'design', name: `taste script: ${script[1]}`, detail: 'design-taste-frontend' })
  if (/\bplaywright-cli\b/.test(c)) out.push({ kind: 'skill', name: 'playwright-cli', detail: 'command' })
  if (/\.claude\/design-md/.test(c)) out.push({ kind: 'design', name: 'awesome-design-md', detail: 'searched' })
  for (const url of c.match(URLS) ?? []) if (/\b(curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod)\b/i.test(c)) out.push(fromUrl(url, 'downloaded'))
  return out
}

const fromUrl = (url, how) => {
  const r = ghRepo(url)
  if (r && !/^(orgs|settings|login|marketplace|features)$/i.test(r[1])) return { kind: 'repo', name: `${r[1]}/${r[2]}`, detail: how, url: `https://github.com/${r[1]}/${r[2]}` }
  return { kind: 'web', name: host(url) || clip(url, 60), detail: clip(url.replace(/^https?:\/\/(www\.)?/, ''), 120), url }
}

const DOCS = /doc|knowledge|guide|reference|manual/i
// One tool call (a `tool_use` block of the transcript): the help in it.
export const sourcesOf = (c, cwd = '') => {
  const input = c?.input ?? {}
  const name = String(c?.name ?? '')
  const abs = p => (path.isAbsolute(p) || !cwd ? p : path.resolve(cwd, p))
  if (name === 'Skill' && typeof input.skill === 'string') return [{ kind: 'skill', name: input.skill.replace(/^.*:/, ''), detail: input.skill.includes(':') ? input.skill.split(':')[0] : 'skill' }]
  if ((name === 'Read' || name === 'NotebookRead') && typeof input.file_path === 'string') return [fromPath(abs(input.file_path))].filter(Boolean)
  if ((name === 'Grep' || name === 'Glob') && typeof input.path === 'string') return [fromPath(abs(input.path) + '/')].filter(Boolean)
  if ((name === 'Bash' || name === 'PowerShell') && typeof input.command === 'string') return fromCommand(input.command)
  if (name === 'WebFetch' && typeof input.url === 'string') return [fromUrl(input.url, 'read')]
  if (name === 'WebSearch' && typeof input.query === 'string') return [{ kind: 'search', name: clip(input.query, 120), detail: 'web search' }]
  if (name === 'Agent' || name === 'Task') {
    const type = String(input.subagent_type ?? 'general-purpose')
    const what = clip(input.description ?? input.prompt, 100)
    const urls = String(input.prompt ?? '').match(URLS) ?? []
    if (type === 'web-fetch' && urls.length) return urls.slice(0, 4).map(u => fromUrl(u, 'read by a helper'))
    if (type === 'claude-code-guide') return [{ kind: 'docs', name: 'Claude Code guide', detail: what }]
    if (type === 'fork') return []
    return [{ kind: 'helper', name: type, detail: what }, ...urls.slice(0, 3).map(u => fromUrl(u, 'given to a helper'))]
  }
  // a tool of a connected server whose job is documentation
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  // (a server named by an id alone: named by its tool, "search_cloudflare_documentation" → "cloudflare documentation")
  if (mcp && DOCS.test(mcp[2])) return [{ kind: 'docs', name: /^[0-9a-f-]{20,}$/.test(mcp[1]) ? mcp[2].replace(/^(search|get|query|read|answer)_/, '').replace(/_/g, ' ') : mcp[1].replace(/^plugin_[^_]+_/, ''), detail: clip(input.query ?? input.question ?? input.prompt ?? mcp[2].replace(/_/g, ' '), 100) }]
  if (mcp && /fetch|read_url|scrape/i.test(mcp[2]) && typeof input.url === 'string') return [fromUrl(input.url, 'read')]
  return []
}

const out = e => { const { uses, ...rest } = e; return { ...rest, count: uses.length } }
export const sourcesState = () => list.slice(-400).map(out)
// every entry, with its uses (claudemd.mjs: what an instruction led to)
export const sourcesAll = () => list

// One use: the entry of this thing in this chat's prompt is counted up, or made.
export const noteSources = (found, { sid, at, prompt, toolId }) => {
  for (const s of found) {
    if (!s?.name) continue
    const key = `${sid}|${s.kind}|${s.name.toLowerCase()}|${prompt?.at ?? 0}`
    let e = list.find(x => x.key === key)
    if (e) {
      if (e.uses.includes(toolId)) continue
      e.uses = [...e.uses, toolId].slice(-50)
      e.at = Math.max(e.at, at)
      if (s.detail && s.detail !== e.detail) e.detail = s.detail
    } else {
      e = { id: nextId++, key, sid, kind: s.kind, name: s.name, detail: s.detail ?? '', url: s.url ?? '', at, first: at, prompt: prompt ? { text: clip(prompt.text, 160), at: prompt.at ?? 0 } : null, uses: [toolId] }
      list.push(e)
      while (list.length > KEEP) list.shift()
    }
    tell(out(e))
    saveSoon()
  }
}

const saveSoon = () => { if (file && !saveDue) saveDue = setTimeout(save, 3000) }
const save = () => {
  saveDue = null
  try { fs.writeFileSync(`${file}.tmp`, JSON.stringify({ nextId, list })); fs.renameSync(`${file}.tmp`, file) } catch {}
}
process.on('exit', () => { if (saveDue) { clearTimeout(saveDue); save() } })

export const initSources = ({ broadcast, home }) => {
  tell = source => broadcast({ type: 'source', source })
  file = path.join(home, 'live-code-sources.json')
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    list = (Array.isArray(saved?.list) ? saved.list : []).filter(e => e && e.key && Array.isArray(e.uses)).slice(-KEEP)
    nextId = Math.max(Number(saved?.nextId) || 1, ...list.map(e => e.id + 1))
  } catch {}
}
