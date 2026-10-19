// How many Live Code dashboards are open right now, worldwide.
//
// Each dashboard server, while a dashboard page is open and the person has not
// switched it off, calls GET /ping?id=<random id> every few minutes; the answer
// is the number of ids seen in the last six minutes. The id is random, made on
// the person's PC, and says nothing about them; nothing else is kept, and only
// in memory (one Durable Object), so it is all gone when it idles.
const WINDOW_MS = 6 * 60_000

export class Live {
  constructor() {
    this.seen = new Map()
  }

  async fetch(request) {
    const id = new URL(request.url).searchParams.get('id') ?? ''
    const now = Date.now()
    if (/^[a-f0-9]{32}$/.test(id)) this.seen.set(id, now)
    for (const [k, at] of this.seen) if (now - at > WINDOW_MS) this.seen.delete(k)
    return Response.json({ live: this.seen.size }, { headers: { 'Cache-Control': 'no-store' } })
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname !== '/ping' || request.method !== 'GET') return new Response('Live Code live users', { status: 404 })
    return env.LIVE.get(env.LIVE.idFromName('all')).fetch(request)
  },
}
