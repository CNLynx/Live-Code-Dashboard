// The builds of the site a chat works on, as its host reports them to GitHub:
// Cloudflare (Workers and Pages) puts a check such as "Workers Builds: <name>"
// on each commit it builds, and Vercel and Netlify do the same. Read through
// the GitHub CLI (gh) the person is signed in with: no key of the host needed.
// Without gh, or for a folder that is no GitHub repository, there is nothing.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const PROVIDERS = [
  { test: /cloudflare/i, name: 'Cloudflare' },
  { test: /vercel/i, name: 'Vercel' },
  { test: /netlify/i, name: 'Netlify' },
]
const ACTIVE_MS = 30 * 60_000 // a chat quiet for longer is not followed
const FAST_MS = 20_000 // while a build runs, or just after one
const SLOW_MS = 90_000
const RECENT_MS = 10 * 60_000

// gh: on the PATH, or where its installer puts it on Windows
let ghPath
const findGh = () =>
  new Promise(resolve => {
    if (ghPath !== undefined) return resolve(ghPath)
    const tries = ['gh', ...(process.platform === 'win32' ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI', 'gh.exe')] : [])]
    const next = () => {
      const exe = tries.shift()
      if (!exe) { ghPath = null; return resolve(null) }
      execFile(exe, ['--version'], { windowsHide: true, timeout: 8000 }, error => { if (error) next(); else { ghPath = exe; resolve(exe) } })
    }
    next()
  })
const ghJson = async args => {
  const exe = await findGh()
  if (!exe) return null
  return new Promise(resolve => {
    execFile(exe, ['api', ...args], { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (error, out) => {
      if (error) return resolve(null)
      try { resolve(JSON.parse(out)) } catch { resolve(null) }
    })
  })
}

// the repository a folder belongs to: its GitHub "owner/name" and the branch checked out
const repoCache = new Map() // cwd -> { at, repo }
const repoOf = cwd => {
  const known = repoCache.get(cwd)
  if (known && Date.now() - known.at < 60_000) return known.repo
  let repo = null
  try {
    let dir = path.resolve(cwd)
    for (let i = 0; i < 12 && !repo; i++) {
      const dotGit = path.join(dir, '.git')
      if (fs.existsSync(dotGit)) {
        let gitDir = dotGit
        if (fs.statSync(dotGit).isFile()) gitDir = path.resolve(dir, fs.readFileSync(dotGit, 'utf8').replace(/^gitdir:\s*/, '').trim())
        // a worktree's own folder names the shared one in "commondir"
        let common = gitDir
        try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()) } catch {}
        const config = fs.readFileSync(path.join(common, 'config'), 'utf8')
        const origin = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config)?.[1] ?? ''
        const slug = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(origin)
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
        repo = slug ? { slug: `${slug[1]}/${slug[2]}`, branch: /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? null } : null
        break
      }
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
  } catch {
    repo = null
  }
  repoCache.set(cwd, { at: Date.now(), repo })
  return repo
}

const repos = new Map() // slug -> { defaultBranch, runs, nextAt, changedAt, busy, typicalMs, heads }

// How long the host usually takes: from a commit to its check, over the
// newest commits of the default branch (the host reports a build only once it
// is done, so the bar in between runs on this). Learned once an hour.
const LEARN_MS = 3600e3
const learnTypical = async (slug, st) => {
  if (st.learnedAt && Date.now() - st.learnedAt < LEARN_MS) return
  st.learnedAt = Date.now()
  const commits = await ghJson([`repos/${slug}/commits?sha=${encodeURIComponent(st.defaultBranch)}&per_page=8`])
  const took = []
  for (const c of commits ?? []) {
    const at = Date.parse(c.commit?.committer?.date) || 0
    const runs = await runsOf(slug, c.sha)
    const done = runs.find(r => r.status === 'completed' && r.completedAt)
    const ms = done ? done.completedAt - at : 0
    if (ms > 5000 && ms < 20 * 60_000) took.push(ms)
  }
  took.sort((a, b) => a - b)
  if (took.length) st.typicalMs = took[Math.floor(took.length / 2)]
}

const runsOf = async (slug, ref) => {
  const j = await ghJson([`repos/${slug}/commits/${encodeURIComponent(ref)}/check-runs?per_page=50`])
  const out = []
  for (const r of j?.check_runs ?? []) {
    const provider = PROVIDERS.find(p => p.test.test(r.app?.slug ?? '') || p.test.test(r.name ?? ''))
    if (!provider) continue
    out.push({
      provider: provider.name, name: r.name, ref, sha: String(r.head_sha ?? '').slice(0, 7),
      status: r.status, conclusion: r.conclusion,
      startedAt: Date.parse(r.started_at) || 0, completedAt: Date.parse(r.completed_at) || 0,
      url: r.details_url || r.html_url || '',
    })
  }
  return out
}

const refresh = async (slug, branch) => {
  const st = repos.get(slug) ?? { defaultBranch: null, runs: [], nextAt: 0, changedAt: 0, busy: false, typicalMs: 0, heads: new Map() }
  repos.set(slug, st)
  if (st.busy) return false
  st.busy = true
  try {
    if (!st.defaultBranch) st.defaultBranch = (await ghJson([`repos/${slug}`]))?.default_branch ?? null
    if (!st.defaultBranch) { st.nextAt = Date.now() + 10 * 60_000; return false }
    await learnTypical(slug, st)
    const refs = [...new Set([st.defaultBranch, branch].filter(Boolean))]
    const runs = []
    for (const ref of refs) {
      // the branch's newest commit, and what the host said about it
      const head = await ghJson([`repos/${slug}/branches/${encodeURIComponent(ref)}`])
      const sha = String(head?.commit?.sha ?? '')
      if (!sha) continue
      const said = await runsOf(slug, sha)
      for (const r of said) runs.push({ ...r, ref })
      // nothing said yet about a commit of a repository the host builds: it builds now
      const builds = st.runs.length > 0 || st.typicalMs > 0
      if (said.length === 0 && builds) {
        const seen = st.heads.get(ref)
        if (seen?.sha !== sha) st.heads.set(ref, { sha, at: Date.now() })
        const committed = Date.parse(head.commit?.commit?.committer?.date) || 0
        // (from the commit, when it is fresh; else from when it was first seen here)
        const from = Date.now() - committed < 15 * 60_000 ? committed : st.heads.get(ref).at
        // (a host that never says anything about it: given up after a while)
        if (Date.now() - from < Math.max(5 * 60_000, (st.typicalMs || 60_000) * 5)) {
          const provider = st.runs[0]?.provider ?? 'Cloudflare'
          runs.push({ provider, name: st.runs[0]?.name ?? 'Build', ref, sha: sha.slice(0, 7), status: 'in_progress', conclusion: null, startedAt: from, completedAt: 0, url: '', estimated: true })
        }
      }
    }
    for (const r of runs) { r.preview = r.ref !== st.defaultBranch; r.typicalMs = st.typicalMs }
    const key = JSON.stringify(runs.map(r => [r.name, r.ref, r.sha, r.status, r.conclusion]))
    const changed = key !== JSON.stringify(st.runs.map(r => [r.name, r.ref, r.sha, r.status, r.conclusion]))
    st.runs = runs
    if (changed) st.changedAt = Date.now()
    const running = runs.some(r => r.status !== 'completed')
    st.nextAt = Date.now() + (running || Date.now() - st.changedAt < RECENT_MS ? FAST_MS : SLOW_MS)
    return changed
  } finally {
    st.busy = false
  }
}

// What a chat's site is doing: its repository's builds (none: an empty list).
export const deploysFor = cwd => {
  const repo = cwd ? repoOf(cwd) : null
  const st = repo ? repos.get(repo.slug) : null
  return st ? st.runs.filter(r => !r.preview || r.ref === repo.branch).map(r => ({ ...r, repo: repo.slug })) : []
}

// Follows the repositories of the chats that were active lately; calls
// changed(sid) for each chat whose builds changed. `busyAt(sid)`: when it last worked.
export const followDeploys = (list, changed) => {
  const tick = async () => {
    const now = Date.now()
    const bySlug = new Map()
    for (const { sid, cwd, at } of list()) {
      if (!cwd || now - at > ACTIVE_MS) continue
      const repo = repoOf(cwd)
      if (!repo) continue
      const e = bySlug.get(repo.slug) ?? { branches: new Set(), sids: [] }
      if (repo.branch) e.branches.add(repo.branch)
      e.sids.push(sid)
      bySlug.set(repo.slug, e)
    }
    for (const [slug, e] of bySlug) {
      const st = repos.get(slug)
      if (st && st.nextAt > now) continue
      // (one branch besides the default: the one checked out most recently asked)
      if (await refresh(slug, [...e.branches][0])) for (const sid of e.sids) changed(sid)
    }
  }
  setInterval(() => { void tick() }, 5000)
  void tick()
}
// A chat just pushed or merged: look again soon.
export const pokeDeploys = cwd => {
  const repo = cwd ? repoOf(cwd) : null
  const st = repo ? repos.get(repo.slug) : null
  if (st) { st.nextAt = Math.min(st.nextAt, Date.now() + 4000); st.changedAt = Date.now() }
}
