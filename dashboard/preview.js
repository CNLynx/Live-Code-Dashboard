// ── Visual: what Claude sees and makes ──
// Fixed in the side column (the Visual card), or, popped out (⧉), a window that
// floats over the dashboard and comes by itself. While Claude works in Blender,
// the model as it is built, turning (blender.mjs, live_code_blender.py); an
// image made where a chat works, rendered, sent to the person, looked at, or a
// browser shot (images.mjs) builds up tile by tile; below, the list of all of
// it with the web searches and pages. The floating one is dragged by its head
// and sized at its corner, both kept; it goes again a while after the last
// change, unless pinned.
(() => {
  const pv = $('#pv')
  if (!pv || TILE_MODE) return
  const head = $('#pv-head'), glc = $('#pv-gl'), imc = $('#pv-img'), meta = $('#pv-meta'), strip = $('#pv-strip'), title = $('#pv-title'), list = $('#pv-list'), dock = $('#pv-dock')
  const tabs = [...pv.querySelectorAll('[data-pv]')]
  const HIDE_AFTER_MS = 45_000
  const calm = () => document.documentElement.classList.contains('calm')
  const P = { blender: null, images: [], items: [], cur: null, tab: '', pinned: store.get('lc.pvPin') === 'on', activity: 0, imageAt: 0, userTabAt: 0, hover: false, open: false, meshAt: 0, hasMesh: false, dock: store.get('lc.pvMode') !== 'float' }
  pv.classList.toggle('pinned', P.pinned)
  // on screen now: docked always, floating while open
  const visible = () => P.dock || P.open

  // ── where it sits ──
  const BOX_KEY = 'lc.pvBox'
  let box = null
  try { const b = JSON.parse(store.get(BOX_KEY) ?? 'null'); if (b && [b.x, b.y, b.w, b.h].every(Number.isFinite)) box = b } catch {}
  const defaultBox = () => { const w = Math.min(480, innerWidth - 32), h = Math.min(400, innerHeight - 32); return { x: innerWidth - w - 20, y: innerHeight - h - 20, w, h } }
  const clampBox = b => {
    const w = Math.max(280, Math.min(b.w, innerWidth - 16)), h = Math.max(220, Math.min(b.h, innerHeight - 16))
    return { w, h, x: Math.max(8, Math.min(b.x, innerWidth - w - 8)), y: Math.max(8, Math.min(b.y, innerHeight - h - 8)) }
  }
  const place = () => { pv.style.left = `${box.x}px`; pv.style.top = `${box.y}px`; pv.style.width = `${box.w}px`; pv.style.height = `${box.h}px` }
  // (until the person moves or sizes it, it sits bottom right, wherever that is now)
  let boxIsOwn = !!box
  const saveBox = () => { boxIsOwn = true; store.set(BOX_KEY, JSON.stringify(box)) }
  addEventListener('resize', () => { if (P.open && !P.dock) { box = clampBox(boxIsOwn && box ? box : defaultBox()); place() } })

  // dragged by its head (not by its buttons), while it floats
  head.addEventListener('pointerdown', e => {
    if (P.dock || e.button !== 0 || e.target.closest('button')) return
    const r = pv.getBoundingClientRect()
    const dx = e.clientX - r.left, dy = e.clientY - r.top
    head.setPointerCapture(e.pointerId)
    pv.classList.add('dragging')
    const move = ev => { box = clampBox({ ...box, x: ev.clientX - dx, y: ev.clientY - dy }); place() }
    const up = () => { pv.classList.remove('dragging'); head.removeEventListener('pointermove', move); saveBox() }
    head.addEventListener('pointermove', move)
    head.addEventListener('pointerup', up, { once: true })
    head.addEventListener('pointercancel', up, { once: true })
  })
  // sized at its corner (CSS resize): kept, and the pictures drawn anew
  let sizeDue = null
  new ResizeObserver(() => {
    if (P.dock) { if (P.tab === 'images') drawImg(performance.now()); return }
    // (only a size the person gave it: not while it is away or still coming in)
    if (!P.open || !box || pv.hidden || !pv.classList.contains('shown') || pv.classList.contains('dragging')) return
    // (its own size, not as the coming-in animation scales it)
    const r = { width: pv.offsetWidth, height: pv.offsetHeight }
    if (r.width < 50 || r.height < 50) return
    if (Math.abs(r.width - box.w) < 1 && Math.abs(r.height - box.h) < 1) return
    box = { ...box, w: r.width, h: r.height }
    clearTimeout(sizeDue); sizeDue = setTimeout(saveBox, 300)
    if (P.tab === 'images') drawImg(performance.now())
  }).observe(pv)
  pv.addEventListener('pointerenter', () => { P.hover = true })
  pv.addEventListener('pointerleave', () => { P.hover = false; P.activity = Math.max(P.activity, Date.now() - HIDE_AFTER_MS + 8000) })

  const show = () => {
    if (P.dock || store.get('lc.preview') === 'off' || P.open) return
    P.open = true
    box = clampBox(boxIsOwn && box ? box : defaultBox())
    place()
    pv.hidden = false
    requestAnimationFrame(() => requestAnimationFrame(() => pv.classList.add('shown')))
    loopGl()
  }
  const hide = () => {
    if (P.dock || !P.open) return
    P.open = false
    pv.classList.remove('shown')
    setTimeout(() => { if (!P.open && !P.dock) pv.hidden = true }, 520)
  }
  $('#pv-close').addEventListener('click', hide)
  // in the side column, or floating: the same window, moved (its pictures go with it)
  const settle = () => {
    pv.classList.toggle('docked', P.dock)
    if (P.dock) {
      pv.style.cssText = ''
      dock.append(pv)
      pv.hidden = false
      pv.classList.add('shown')
      P.open = false
    } else {
      document.body.append(pv)
      pv.classList.remove('shown')
      pv.hidden = true
      P.open = false
    }
    loopGl()
    if (P.tab === 'images') requestAnimationFrame(() => drawImg(performance.now()))
  }
  const setMode = dockIt => {
    P.dock = dockIt
    store.set('lc.pvMode', dockIt ? 'dock' : 'float')
    settle()
    if (!dockIt) { P.activity = Date.now(); show() }
  }
  $('#pv-pop').addEventListener('click', () => setMode(!P.dock))
  $('#pv-dock-here')?.addEventListener('click', () => setMode(true))
  $('#pv-pin').addEventListener('click', () => { P.pinned = !P.pinned; store.set('lc.pvPin', P.pinned ? 'on' : 'off'); pv.classList.toggle('pinned', P.pinned) })

  const setTab = (tab, byUser) => {
    if (byUser) P.userTabAt = Date.now()
    if (P.tab === tab) return
    P.tab = tab
    pv.classList.toggle('model', tab === 'model')
    pv.classList.toggle('images', tab === 'images')
    for (const b of tabs) b.classList.toggle('on', b.dataset.pv === tab)
    if (tab === 'model') loopGl()
    if (tab === 'images') drawImg(performance.now())
    drawMeta()
  }
  for (const b of tabs) b.addEventListener('click', () => { if (!b.disabled) setTab(b.dataset.pv, true) })

  // ── what it says ──
  const info = () => (P.blender?.mode === 'on' ? P.blender.info : null)
  const working = () => { const i = info(); return !!i?.running && Date.now() - i.at < 5 * 60_000 }
  const kilo = n => (n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n))
  const HOW = { made: 'made', render: 'rendered in Blender', sent: 'sent to you', looked: 'looked at', browser: 'browser', search: 'web search', web: 'page read', browse: 'browser opened', blender: 'Blender', click: 'click in the browser', type: 'typed in the browser', key: 'key in the browser', scroll: 'scrolled in the browser', server: 'dev server', bg: 'in the background', file: 'file made', download: 'downloaded' }
  const ICON = { made: '🖼️', render: '🎬', sent: '📤', looked: '👁️', browser: '📸', search: '🔎', web: '🌐', browse: '🧭', blender: '🧊', click: '🖱️', type: '⌨️', key: '⌨️', scroll: '↕️', server: '🖥️', file: '📦', download: '⬇️' }
  const drawMeta = () => {
    const i = info()
    tabs[0].disabled = !i
    tabs[1].disabled = P.images.length === 0
    pv.classList.toggle('working', working())
    pv.classList.toggle('empty', !P.hasMesh)
    // (nothing for the stage: what it will show, said once)
    // (not before the server said what there is: no flash of it on each load)
    pv.classList.toggle('nothing', P.ready && !i && P.images.length === 0)
    if (P.tab === 'model' && i) {
      setText(title, i.blend ? i.blend : 'Blender')
      // what the last step brought, while it is new
      const added = P.added?.length && Date.now() - P.addedAt < 6000 ? (P.added.length === 1 ? `+ ${P.added[0]}` : `+ ${P.added.length} parts (${P.added.at(-1)})`) : ''
      setText(meta, [added, `${i.objects} objects`, `${kilo(i.tris)} triangles${i.cut ? ' (cut)' : ''}`, working() ? `working… step ${i.seq}` : 'done', `${dur(Date.now() - i.at)} ago`, added ? '' : `Blender ${i.version}`.trim()].filter(Boolean).join(' · '))
    } else if (P.tab === 'images') {
      const it = P.images.find(x => x.id === P.cur)
      setText(title, it ? (it.how === 'browser' ? 'Browser screenshot' : it.name) : 'Images')
      // (a browser step shown on this shot: that step)
      const step = IMG.mark && IMG.mark.shotId === it?.id ? P.items.find(x => x.id === IMG.mark.id) : null
      setText(meta, it ? [step ? `${ICON[step.how] ?? ''} ${step.name}` : it.why || HOW[it.how] || it.how, it.prevId ? 'before | after: drag the line' : '', IMG.cur && IMG.item?.id === it.id ? `${IMG.cur.naturalWidth}×${IMG.cur.naturalHeight}` : '', IMG.view.z > 1.01 ? `${Math.round(IMG.view.z * 100)}%` : '', `${dur(Date.now() - (step ?? it).at)} ago`].filter(Boolean).join(' · ') : '')
    } else setText(title, 'Preview')
  }

  // ── the model: WebGL2, flat-shaded from the screen-space normal ──
  const parseMesh = buf => {
    const dv = new DataView(buf)
    if (buf.byteLength < 8 || dv.getUint32(0, true) !== 0x3142434c) return null // 'LCB1'
    let off = 4
    const n = dv.getUint32(off, true); off += 4
    const objs = []
    let nv = 0, ni = 0
    const dec = new TextDecoder()
    for (let i = 0; i < n; i++) {
      const nl = dv.getUint16(off, true)
      const name = dec.decode(new Uint8Array(buf, off + 2, nl)).replace(/\0+$/, '')
      off += 2 + nl
      const v = dv.getUint32(off, true); off += 4
      const pos = new Float32Array(buf, off, v * 3); off += v * 12
      const np = dv.getUint32(off, true); off += 4
      const parts = []
      for (let p = 0; p < np; p++) {
        const col = [dv.getFloat32(off, true), dv.getFloat32(off + 4, true), dv.getFloat32(off + 8, true)]; off += 12
        const k = dv.getUint32(off, true); off += 4
        parts.push({ col, idx: new Uint32Array(buf, off, k) }); off += k * 4
        ni += k
      }
      objs.push({ name, pos, parts }); nv += v
    }
    const pos = new Float32Array(nv * 3), idx = new Uint32Array(ni), draws = [], objects = []
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    let vb = 0, ib = 0
    for (const o of objs) {
      pos.set(o.pos, vb * 3)
      // its middle (it grows from there) and a fingerprint (to see it changed)
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < o.pos.length; i += 3) for (let a = 0; a < 3; a++) { const x = o.pos[i + a]; if (x < lo[a]) lo[a] = x; if (x > hi[a]) hi[a] = x }
      let sig = `${o.pos.length}:${o.parts.length}:${lo.join(',')}:${hi.join(',')}`
      for (let s = 0, step = Math.max(3, Math.floor(o.pos.length / 48) * 3); s < o.pos.length; s += step) sig += `:${o.pos[s].toFixed(4)}`
      const obj = { name: o.name, center: lo.map((x, a) => (x + hi[a]) / 2), sig, draws: [] }
      for (const part of o.parts) {
        for (let j = 0; j < part.idx.length; j++) idx[ib + j] = part.idx[j] + vb
        obj.draws.push({ col: part.col, first: ib, count: part.idx.length })
        draws.push(obj.draws.at(-1))
        ib += part.idx.length
      }
      objects.push(obj)
      vb += o.pos.length / 3
    }
    for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) { const x = pos[i + a]; if (x < min[a]) min[a] = x; if (x > max[a]) max[a] = x }
    return { pos, idx, draws, objects, min, max, empty: draws.length === 0 }
  }

  const GL = (() => {
    const gl = glc.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true })
    if (!gl) return null
    const shader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s }
    const prog = gl.createProgram()
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, `#version 300 es
in vec3 p; uniform mat4 mvp; uniform vec3 ctr; uniform float grow; out vec3 wp;
void main() { wp = ctr + (p - ctr) * grow; gl_Position = mvp * vec4(wp, 1.0); }`))
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
in vec3 wp; uniform vec3 col; uniform vec3 eye; uniform float lines; uniform float alpha; uniform float glow; out vec4 o;
void main() {
  if (lines > 0.5) { o = vec4(col * alpha, alpha); return; }
  vec3 n = normalize(cross(dFdx(wp), dFdy(wp)));
  vec3 v = normalize(eye - wp);
  if (dot(n, v) < 0.0) n = -n;
  float d = 0.30 + 0.56 * max(dot(n, normalize(vec3(0.45, -0.55, 0.75))), 0.0) + 0.16 * max(dot(n, normalize(vec3(-0.6, 0.5, 0.35))), 0.0) + 0.10 * (n.z * 0.5 + 0.5);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.16;
  // (a part just added or changed glows warm for a moment)
  vec3 c = mix(col * d + rim, vec3(1.0, 0.62, 0.32), glow * 0.55) + glow * 0.12;
  o = vec4(c * alpha, alpha);
}`))
    gl.bindAttribLocation(prog, 0, 'p')
    gl.linkProgram(prog)
    const U = Object.fromEntries(['mvp', 'col', 'eye', 'lines', 'alpha', 'ctr', 'grow', 'glow'].map(k => [k, gl.getUniformLocation(prog, k)]))
    const vao = gl.createVertexArray(), vbo = gl.createBuffer(), ibo = gl.createBuffer()
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo)
    const gvao = gl.createVertexArray(), gvbo = gl.createBuffer()
    gl.bindVertexArray(gvao)
    gl.bindBuffer(gl.ARRAY_BUFFER, gvbo); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    let mesh = null, gridN = 0, bornAt = 0
    // each part's moment: when it came (it grows in then), when it last changed (it glows)
    const parts = new Map() // name -> { sig, born, changed }
    const GROW_MS = 560, GLOW_MS = 1100

    const cam = { yaw: -0.9, pitch: 0.42, zoom: 1, t: [0, 0, 0], r: 1, goalT: [0, 0, 0], goalR: 1, userAt: 0 }
    // live: a step Blender just took (what is new grows in, one part after the
    // other); otherwise (the page just opened) it is simply there
    const set = (m, live) => {
      if (!m) return []
      const first = !mesh || mesh.empty
      mesh = m
      const t = performance.now(), added = []
      const fresh = m.objects.filter(o => !parts.has(o.name))
      const gap = Math.min(150, 1600 / Math.max(1, fresh.length))
      for (const o of m.objects) {
        const was = parts.get(o.name)
        if (!was) {
          parts.set(o.name, { sig: o.sig, born: live && !calm() ? t + added.length * gap : 0, changed: 0 })
          added.push(o.name)
        } else if (was.sig !== o.sig) { was.sig = o.sig; if (live) was.changed = t }
      }
      const names = new Set(m.objects.map(o => o.name))
      for (const name of parts.keys()) if (!names.has(name)) parts.delete(name)
      if (m.empty) return added
      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, m.pos, gl.STATIC_DRAW)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW)
      gl.bindVertexArray(null)
      cam.goalT = m.min.map((a, i) => (a + m.max[i]) / 2)
      cam.goalR = Math.max(0.05, Math.hypot(m.max[0] - m.min[0], m.max[1] - m.min[1], m.max[2] - m.min[2]) / 2)
      if (first) { cam.t = [...cam.goalT]; cam.r = cam.goalR; bornAt = performance.now() }
      // a floor grid under it, in steps that suit its size
      const size = cam.goalR * 2.4, step = 10 ** Math.floor(Math.log10(size / 6)) * ([1, 2, 5].find(f => size / (10 ** Math.floor(Math.log10(size / 6)) * f) <= 12) ?? 10)
      const n = Math.ceil(size / step), z = m.min[2], cx = Math.round(cam.goalT[0] / step) * step, cy = Math.round(cam.goalT[1] / step) * step
      const lines = []
      for (let i = -n; i <= n; i++) {
        lines.push(cx + i * step, cy - n * step, z, cx + i * step, cy + n * step, z)
        lines.push(cx - n * step, cy + i * step, z, cx + n * step, cy + i * step, z)
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, gvbo); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.STATIC_DRAW)
      gridN = lines.length / 3
      return added
    }
    const backOut = x => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2 }

    const mul = (a, b) => { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]; return o }
    const persp = (fy, asp, n, f) => { const t = 1 / Math.tan(fy / 2); return new Float32Array([t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]) }
    const look = (e, c) => {
      const sub = (a, b) => a.map((x, i) => x - b[i]), norm = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l) }
      const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
      const f = norm(sub(c, e)), s = norm(cross(f, [0, 0, 1])), u = cross(s, f)
      return new Float32Array([s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0, -dot(s, e), -dot(u, e), dot(f, e), 1])
    }

    let last = 0
    const draw = t => {
      const dt = Math.min(0.05, (t - (last || t)) / 1000); last = t
      const dpr = Math.min(2, devicePixelRatio || 1)
      const w = Math.max(1, Math.round(glc.clientWidth * dpr)), h = Math.max(1, Math.round(glc.clientHeight * dpr))
      if (glc.width !== w || glc.height !== h) { glc.width = w; glc.height = h }
      gl.viewport(0, 0, w, h)
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      if (!mesh || mesh.empty) return
      // (a new size of the model: the view glides to it)
      const k = 1 - Math.exp(-dt * 3.5)
      cam.t = cam.t.map((v, i) => v + (cam.goalT[i] - v) * k); cam.r += (cam.goalR - cam.r) * k
      if (!calm() && Date.now() - cam.userAt > 3500) cam.yaw += dt * 0.32
      const fy = 0.62, asp = w / h
      const dist = cam.r / Math.sin(fy / 2 * Math.min(1, asp)) * 1.08 / cam.zoom
      const eye = [cam.t[0] + dist * Math.cos(cam.pitch) * Math.cos(cam.yaw), cam.t[1] + dist * Math.cos(cam.pitch) * Math.sin(cam.yaw), cam.t[2] + dist * Math.sin(cam.pitch)]
      const mvp = mul(persp(fy, asp, Math.max(0.001, dist * 0.01), dist * 10 + cam.r * 4), look(eye, cam.t))
      const alpha = Math.min(1, (t - bornAt) / 600)
      gl.useProgram(prog)
      gl.uniformMatrix4fv(U.mvp, false, mvp); gl.uniform3fv(U.eye, eye); gl.uniform1f(U.alpha, alpha)
      gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      // the grid first, faint (it takes its colour from the page)
      const ink = getComputedStyle(pv).color.match(/\d+(\.\d+)?/g)?.map(Number) ?? [128, 128, 128]
      gl.uniform1f(U.lines, 1); gl.uniform3f(U.col, ink[0] / 255, ink[1] / 255, ink[2] / 255); gl.uniform1f(U.alpha, 0.10 * alpha)
      gl.uniform1f(U.grow, 1); gl.uniform1f(U.glow, 0); gl.uniform3f(U.ctr, 0, 0, 0)
      gl.bindVertexArray(gvao); gl.drawArrays(gl.LINES, 0, gridN)
      gl.uniform1f(U.lines, 0); gl.uniform1f(U.alpha, alpha)
      gl.bindVertexArray(vao)
      for (const o of mesh.objects) {
        const st = parts.get(o.name)
        let grow = 1, glow = 0
        if (st?.born) {
          const a = (t - st.born) / GROW_MS
          if (a <= 0) continue // (its turn is still to come)
          if (a < 1) grow = Math.max(0.001, backOut(a))
          glow = Math.max(0, 1 - (t - st.born) / GLOW_MS)
        }
        if (st?.changed) glow = Math.max(glow, 1 - (t - st.changed) / GLOW_MS)
        gl.uniform3fv(U.ctr, o.center); gl.uniform1f(U.grow, grow); gl.uniform1f(U.glow, glow)
        for (const d of o.draws) { gl.uniform3fv(U.col, d.col); gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_INT, d.first * 4) }
      }
      gl.bindVertexArray(null)
    }

    // turned by dragging, zoomed by the wheel, fitted again by a double click
    glc.addEventListener('pointerdown', e => {
      if (e.button !== 0) return
      glc.setPointerCapture(e.pointerId)
      let x = e.clientX, y = e.clientY
      const move = ev => { cam.yaw -= (ev.clientX - x) * 0.008; cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + (ev.clientY - y) * 0.008)); x = ev.clientX; y = ev.clientY; cam.userAt = Date.now() }
      glc.addEventListener('pointermove', move)
      glc.addEventListener('pointerup', () => glc.removeEventListener('pointermove', move), { once: true })
    })
    glc.addEventListener('wheel', e => { e.preventDefault(); cam.zoom = Math.max(0.3, Math.min(10, cam.zoom * Math.exp(-e.deltaY * 0.0012))); cam.userAt = Date.now() }, { passive: false })
    glc.addEventListener('dblclick', () => { cam.zoom = 1; cam.pitch = 0.42; cam.userAt = 0 })
    return { set, draw }
  })()

  let glRaf = 0
  const loopGl = () => {
    if (glRaf || !GL) return
    const step = t => {
      if (!visible() || P.tab !== 'model' || document.hidden) { glRaf = 0; return }
      GL.draw(t)
      glRaf = requestAnimationFrame(step)
    }
    glRaf = requestAnimationFrame(step)
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && visible()) loopGl() })

  let meshBusy = false, meshAgain = false
  const loadMesh = async live => {
    if (meshBusy) { meshAgain = true; return }
    meshBusy = true
    try {
      const r = await fetch('/blender/mesh', { cache: 'no-store' })
      if (r.ok) {
        const m = parseMesh(await r.arrayBuffer())
        if (m) {
          const added = GL?.set(m, live) ?? []
          P.hasMesh = !m.empty
          // what this step brought, for the line below the model
          if (live && added.length) { P.added = added; P.addedAt = Date.now() }
        }
      }
    } catch {}
    meshBusy = false
    drawMeta()
    if (meshAgain) { meshAgain = false; void loadMesh(true) }
  }

  // ── images: built up tile by tile ──
  // Zoomed by the wheel (at the pointer), moved by dragging, back by a double
  // click. An image written anew shows its earlier version beside it, split by
  // a line that can be dragged (before | after). A browser shot shows where a
  // click landed: a pulsing ring (and what was typed) on top.
  const imx = imc.getContext('2d')
  const IMG = { cur: null, prev: null, item: null, start: 0, anim: false, jitter: [], raf: 0, before: null, split: 1, splitAt: 0, mark: null, view: { z: 1, px: 0, py: 0 } }
  const markEl = Object.assign(document.createElement('div'), { className: 'pv-mark' })
  const capEl = Object.assign(document.createElement('div'), { className: 'pv-cap' })
  imc.parentElement.append(markEl, capEl)
  const ease = x => 1 - (1 - x) ** 3
  const fit = (im, W, H, pad) => {
    const s = Math.min((W - 2 * pad) / im.naturalWidth, (H - 2 * pad) / im.naturalHeight, 3 * (devicePixelRatio || 1))
    const w = im.naturalWidth * s, h = im.naturalHeight * s
    return { x: (W - w) / 2, y: (H - h) / 2, w, h }
  }
  // the fitted place, zoomed and moved as the person likes it
  const viewed = (r, W, H) => { const v = IMG.view, cx = W / 2, cy = H / 2; return { x: cx + (r.x - cx) * v.z + v.px, y: cy + (r.y - cy) * v.z + v.py, w: r.w * v.z, h: r.h * v.z } }
  const BUILD_MS = 1650, SHINE_MS = 700, SPLIT_MS = 900
  let lastRect = null
  const drawImg = t => {
    const dpr = Math.min(2, devicePixelRatio || 1)
    const W = Math.max(1, Math.round(imc.clientWidth * dpr)), H = Math.max(1, Math.round(imc.clientHeight * dpr))
    if (imc.width !== W || imc.height !== H) { imc.width = W; imc.height = H }
    imx.clearRect(0, 0, W, H)
    const e = t - IMG.start
    const pad = (P.dock ? 4 : 12) * dpr
    // the one before fades as the new one builds
    if (IMG.prev && e < 800) {
      const r = viewed(fit(IMG.prev, W, H, pad), W, H)
      imx.globalAlpha = 1 - ease(Math.min(1, e / 700))
      imx.drawImage(IMG.prev, r.x, r.y, r.w, r.h)
    }
    const im = IMG.cur
    if (!im) { imx.globalAlpha = 1; lastRect = null; placeMark(); return false }
    const r = viewed(fit(im, W, H, pad), W, H)
    lastRect = { ...r, dpr }
    imx.save()
    imx.beginPath()
    if (imx.roundRect) imx.roundRect(r.x, r.y, r.w, r.h, 8 * dpr); else imx.rect(r.x, r.y, r.w, r.h)
    imx.clip()
    let busy = false
    if (!IMG.anim || e >= BUILD_MS) {
      imx.globalAlpha = IMG.anim ? 1 : Math.min(1, e / 350)
      imx.drawImage(im, r.x, r.y, r.w, r.h)
      busy = !IMG.anim && e < 350
    } else {
      busy = true
      const cols = Math.max(6, Math.min(26, Math.round(r.w / (34 * dpr)))), rows = Math.max(4, Math.min(26, Math.round(cols * r.h / r.w)))
      const cw = r.w / cols, ch = r.h / rows, sw = im.naturalWidth / cols, sh = im.naturalHeight / rows
      if (IMG.jitter.length !== cols * rows) IMG.jitter = Array.from({ length: cols * rows }, () => Math.random())
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const delay = ((x / cols) * 0.55 + (y / rows) * 0.45) * 900 + IMG.jitter[y * cols + x] * 260
        const p = Math.max(0, Math.min(1, (e - delay) / 460))
        if (p <= 0) continue
        const q = ease(p), s = 0.45 + 0.55 * q
        imx.globalAlpha = q
        imx.drawImage(im, x * sw, y * sh, sw, sh, r.x + x * cw + cw * (1 - s) / 2, r.y + y * ch + ch * (1 - s) / 2 + (1 - q) * 16 * dpr, cw * s + 0.6, ch * s + 0.6)
      }
    }
    // done: a soft light runs across it once
    const built = IMG.anim ? BUILD_MS + SHINE_MS : 350
    if (IMG.anim && e >= BUILD_MS && e < BUILD_MS + SHINE_MS) {
      busy = true
      const p = (e - BUILD_MS) / SHINE_MS, x = r.x - r.w * 0.4 + p * r.w * 1.8
      const g = imx.createLinearGradient(x - r.w * 0.25, r.y, x + r.w * 0.25, r.y + r.h * 0.3)
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,.22)'); g.addColorStop(1, 'rgba(255,255,255,0)')
      imx.globalAlpha = 1; imx.globalCompositeOperation = 'lighter'
      imx.fillStyle = g; imx.fillRect(r.x, r.y, r.w, r.h)
      imx.globalCompositeOperation = 'source-over'
    }
    // before | after: the earlier version left of the line, the line glides in once
    if (IMG.before && e >= built) {
      if (!IMG.splitAt) IMG.splitAt = t
      const p = Math.min(1, (t - IMG.splitAt) / SPLIT_MS)
      if (IMG.split > 0.999 || p < 1) { IMG.split = 1 - 0.5 * ease(p); busy = busy || p < 1 }
      const sx = r.x + r.w * IMG.split
      imx.globalAlpha = 1
      imx.save(); imx.beginPath(); imx.rect(r.x, r.y, sx - r.x, r.h); imx.clip()
      imx.drawImage(IMG.before, r.x, r.y, r.w, r.h)
      imx.restore()
      imx.fillStyle = 'rgba(255,255,255,.9)'; imx.fillRect(sx - dpr, r.y, 2 * dpr, r.h)
      imx.beginPath(); imx.arc(sx, r.y + r.h / 2, 9 * dpr, 0, Math.PI * 2); imx.fill()
      imx.fillStyle = 'rgba(0,0,0,.55)'; imx.font = `${600} ${11 * dpr}px system-ui, sans-serif`
      imx.fillText('‹›', sx - 6 * dpr, r.y + r.h / 2 + 4 * dpr)
      const tag = (text, x, right) => { const w = imx.measureText(text).width + 12 * dpr; imx.fillStyle = 'rgba(0,0,0,.55)'; imx.fillRect(right ? x - w : x, r.y + 6 * dpr, w, 18 * dpr); imx.fillStyle = '#fff'; imx.fillText(text, (right ? x - w : x) + 6 * dpr, r.y + 19 * dpr) }
      if (sx - r.x > 60 * dpr) tag('before', r.x + 6 * dpr, false)
      if (r.x + r.w - sx > 60 * dpr) tag('after', r.x + r.w - 6 * dpr, true)
    }
    imx.restore()
    imx.globalAlpha = 1
    placeMark()
    return busy || (IMG.prev && e < 800)
  }
  // the ring where a click landed, over the picture as it is zoomed and moved
  const placeMark = () => {
    const m = IMG.mark
    const on = !!(m && lastRect && IMG.item?.id === m.shotId && Number.isFinite(m.x) && P.tab === 'images')
    markEl.classList.toggle('on', on)
    capEl.classList.toggle('on', !!(m && IMG.item?.id === m.shotId && m.text && P.tab === 'images'))
    if (m?.text) setText(capEl, m.text)
    if (!on) return
    const r = lastRect
    markEl.style.transform = `translate(${(r.x + m.x * r.w) / r.dpr}px, ${(r.y + m.y * r.h) / r.dpr}px)`
    markEl.dataset.kind = m.kind
  }
  const runImg = () => {
    cancelAnimationFrame(IMG.raf)
    const step = t => { IMG.raf = drawImg(t) ? requestAnimationFrame(step) : 0 }
    IMG.raf = requestAnimationFrame(step)
  }
  const redraw = () => { if (!IMG.raf) drawImg(performance.now()) }
  const loadImage = src => new Promise(resolve => { const im = new Image(); im.decoding = 'async'; im.onload = () => resolve(im); im.onerror = () => resolve(null); im.src = src })
  const showImg = async (item, animate) => {
    const [im, before] = await Promise.all([loadImage(`/image?id=${item.id}`), item.prevId ? loadImage(`/image?id=${item.prevId}`) : null])
    if (!im || P.cur !== item.id) return
    IMG.prev = IMG.cur; IMG.cur = im; IMG.item = item; IMG.before = before
    IMG.split = 1; IMG.splitAt = 0; IMG.view = { z: 1, px: 0, py: 0 }
    IMG.start = performance.now(); IMG.anim = animate && !calm(); IMG.jitter = []
    runImg(); drawMeta()
  }
  const pick = (item, animate, mark = null) => {
    IMG.mark = mark
    for (const t of strip.children) t.classList.toggle('on', Number(t.dataset.id) === item.id)
    for (const r of list.children) r.classList.toggle('on', r.dataset.id === String(mark?.id ?? item.id))
    // (the same picture again, a new mark on it: no new build)
    if (P.cur === item.id && IMG.item?.id === item.id) { placeMark(); drawMeta(); return }
    P.cur = item.id
    void showImg(item, animate)
    drawMeta()
  }
  // the wheel zooms at the pointer, a drag moves it (or the before|after line), a double click fits it again
  const toCanvas = e => { const b = imc.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1); return { x: (e.clientX - b.left) * dpr, y: (e.clientY - b.top) * dpr, dpr } }
  imc.addEventListener('wheel', e => {
    if (!IMG.cur) return
    e.preventDefault()
    const m = toCanvas(e), W = imc.width, H = imc.height, v = IMG.view
    const z2 = Math.max(1, Math.min(12, v.z * Math.exp(-e.deltaY * 0.0015)))
    const bx = W / 2 + (m.x - W / 2 - v.px) / v.z, by = H / 2 + (m.y - H / 2 - v.py) / v.z
    IMG.view = z2 === 1 ? { z: 1, px: 0, py: 0 } : { z: z2, px: m.x - W / 2 - (bx - W / 2) * z2, py: m.y - H / 2 - (by - H / 2) * z2 }
    redraw()
  }, { passive: false })
  imc.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !IMG.cur) return
    const m0 = toCanvas(e)
    const r = lastRect
    const onLine = IMG.before && r && Math.abs(m0.x - (r.x + r.w * IMG.split)) < 14 * m0.dpr && m0.y > r.y && m0.y < r.y + r.h
    imc.setPointerCapture(e.pointerId)
    imc.classList.add(onLine ? 'splitting' : 'panning')
    let last = m0
    const move = ev => {
      const m = toCanvas(ev)
      if (onLine) { IMG.split = Math.max(0, Math.min(1, (m.x - r.x) / r.w)); IMG.splitAt = 1 }
      else { IMG.view = { ...IMG.view, px: IMG.view.px + m.x - last.x, py: IMG.view.py + m.y - last.y } }
      last = m
      redraw()
    }
    const up = () => { imc.classList.remove('splitting', 'panning'); imc.removeEventListener('pointermove', move) }
    imc.addEventListener('pointermove', move)
    imc.addEventListener('pointerup', up, { once: true })
    imc.addEventListener('pointercancel', up, { once: true })
  })
  imc.addEventListener('pointermove', e => {
    if (imc.classList.contains('panning') || imc.classList.contains('splitting')) return
    const m = toCanvas(e), r = lastRect
    imc.classList.toggle('on-line', !!(IMG.before && r && Math.abs(m.x - (r.x + r.w * IMG.split)) < 14 * m.dpr && m.y > r.y && m.y < r.y + r.h))
  })
  imc.addEventListener('dblclick', () => { IMG.view = { z: 1, px: 0, py: 0 }; redraw() })

  const addThumb = item => {
    const t = new Image()
    t.src = `/image?id=${item.id}`; t.alt = item.name; t.title = `${item.name} · ${HOW[item.how] ?? ''}`
    t.dataset.id = item.id; t.className = 'fresh'
    t.addEventListener('click', () => { P.userTabAt = Date.now(); pick(item, true) })
    strip.append(t)
    while (strip.children.length > 24) strip.firstElementChild.remove()
    strip.classList.add('some')
    requestAnimationFrame(() => requestAnimationFrame(() => t.classList.remove('fresh')))
    strip.scrollTo({ left: strip.scrollWidth, behavior: calm() ? 'auto' : 'smooth' })
  }

  // ── the list: everything seen, newest on top, under the prompt it was for ──
  // A row: what kind (icon), its name, what it was for (or what it was) and
  // when; an image's own thumbnail (a click shows it above), a browser step's
  // shot with where it clicked, a page's link (a click opens it), a command in
  // the background with its state and newest line. The chat shown only.
  const STEP = new Set(['click', 'type', 'key', 'scroll'])
  const iconOf = item => (item.how === 'bg' ? (item.status === 'running' ? '<i class="pv-spin"></i>' : item.status === 'failed' ? '✗' : item.status === 'done' ? '✓' : '⚙️') : ICON[item.how] ?? '•')
  const subOf = item => {
    if (item.how === 'bg') return item.status === 'running' ? (item.lines?.at(-1) ?? 'running…') : item.summary || item.status
    if (item.how === 'file' || item.how === 'download') return `${kiloBytes(item.size)} · ${item.dir ?? ''}`
    if (item.why) return item.why
    if (item.how === 'search') return 'web search'
    if (item.url) return item.url.replace(/^https?:\/\//, '')
    return HOW[item.how] ?? item.how
  }
  const kiloBytes = n => (!n ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
  const nameOf = item => (item.how === 'search' ? `“${item.name}”` : item.how === 'browser' ? 'Browser screenshot' : item.prevId ? `${item.name} (new version)` : item.name)
  const rowOf = item => {
    const li = document.createElement('li')
    li.className = 'pv-row'
    li.dataset.id = String(item.id)
    li.innerHTML = `<span class="ic"></span><span class="tx"><b></b><span></span></span><span class="end"></span>`
    li.addEventListener('click', () => onRow(P.items.find(x => String(x.id) === li.dataset.id)))
    fillRow(li, item)
    return li
  }
  const fillRow = (li, item) => {
    const ic = li.querySelector('.ic'), html = iconOf(item)
    if (ic.innerHTML !== html) ic.innerHTML = html
    setText(li.querySelector('b'), nameOf(item))
    setText(li.querySelector('.tx span'), subOf(item))
    li.title = [nameOf(item), item.why, item.url, item.command, ...(item.lines ?? [])].filter(Boolean).join('\n')
    li.classList.toggle('bg-run', item.how === 'bg' && item.status === 'running')
    const end = li.querySelector('.end')
    if (item.img && !end.querySelector('img')) end.innerHTML = `<img alt="" loading="lazy" src="/image?id=${item.id}">`
    else if (!item.img && !end.dataset.since) { end.className = 'end ago num'; end.dataset.since = item.at }
  }
  const onRow = item => {
    if (!item) return
    P.userTabAt = Date.now()
    if (item.img) { setTab('images', true); pick(item, true) }
    else if (STEP.has(item.how) && item.shotId) showStep(item, false)
    else if (item.how === 'blender') setTab('model', true)
    else if (item.url && /^https?:/.test(item.url)) open(item.url, '_blank', 'noopener')
    else if (item.how === 'search') open(`https://www.bing.com/search?q=${encodeURIComponent(item.name)}`, '_blank', 'noopener')
  }
  // a step in the browser: its shot above, with where it landed
  const showStep = (item, animate) => {
    const shot = P.images.find(x => x.id === item.shotId)
    if (!shot) return
    setTab('images', !animate)
    pick(shot, animate && P.cur !== shot.id, { id: item.id, shotId: shot.id, x: item.x, y: item.y, kind: item.how, text: item.how === 'type' ? `⌨ ${item.typed ?? item.name}` : item.how === 'key' ? `⌨ ${item.name}` : '' })
  }
  // The rows, drawn from the items: the same row kept for the same item (no
  // flicker), a new one folding in; a heading for each prompt.
  const shownHere = item => S.selected === 'all' || !item.sid || item.sid === S.view
  let listView = null
  const renderList = (fresh = new Set()) => {
    listView = S.view
    const items = P.items.filter(shownHere).slice().sort((a, b) => b.at - a.at)
    const want = []
    let lastPrompt = undefined
    for (const it of items) {
      const p = it.prompt?.at ?? 0
      if (p !== lastPrompt) { want.push({ head: true, key: `h${p}`, text: it.prompt?.text ?? '' }); lastPrompt = p }
      want.push({ key: String(it.id), item: it })
    }
    const have = new Map([...list.children].map(li => [li.dataset.id ?? li.dataset.head, li]))
    for (const li of have.values()) if (!want.some(w => w.key === (li.dataset.id ?? li.dataset.head))) { li.remove(); have.delete(li.dataset.id ?? li.dataset.head) }
    let ref = list.firstElementChild
    for (const w of want) {
      let li = have.get(w.key)
      const isNew = !li
      if (li) { if (!w.head) fillRow(li, w.item) }
      else if (w.head) {
        li = document.createElement('li'); li.className = 'pv-group'; li.dataset.head = w.key
        li.textContent = w.text ? `› ${w.text}` : '› earlier'
      } else li = rowOf(w.item)
      if (li === ref) ref = ref.nextElementSibling
      else list.insertBefore(li, ref)
      // (what just happened folds in; what was there already is simply there)
      if (isNew && (fresh.has(w.key) || (w.head && fresh.size))) { li.hidden = true; reveal(li, true) }
    }
  }
  // one row for each Blender run, kept up to date (its file, parts, step)
  const blenderRow = i => {
    const id = `blender-${i.pid}`
    const known = P.items.find(x => x.id === id)
    const patch = { name: `${i.blend || 'Blender'} · ${i.objects} parts`, why: i.running ? `building · step ${i.seq}` : 'done' }
    if (known) { Object.assign(known, patch); renderList(); return }
    P.items.push({ id, how: 'blender', at: i.at, img: false, sid: null, prompt: null, ...patch })
    renderList(new Set([id]))
  }

  // ── what the server tells ──
  const activity = () => { P.activity = Date.now(); show() }
  window.onImage = (image, quiet) => {
    if (!image?.id) return
    const known = P.items.find(x => x.id === image.id)
    if (known) { Object.assign(known, image); renderList(); drawMeta(); return }
    P.items.push(image)
    if (P.items.length > 80) P.items.shift()
    renderList(quiet ? new Set() : new Set([String(image.id)]))
    if (image.img) {
      P.images.push(image)
      if (P.images.length > 40) P.images.shift()
      addThumb(image)
    }
    if (quiet) { if (image.img && !P.cur) pick(image, false); drawMeta(); return }
    if (!shownHere(image)) return
    activity()
    // a step in the browser: shown on its shot (unless the person looks at something else)
    if (STEP.has(image.how) && image.shotId) { if (Date.now() - P.userTabAt > 8000) showStep(image, true); return }
    // (a web search, a page, a command, a file: in the list only)
    if (!image.img) return
    P.imageAt = Date.now()
    // (unless the person just picked something to watch)
    if (Date.now() - P.userTabAt > 8000) {
      if (P.tab !== 'images') setTab('images')
      pick(image, true)
    }
  }
  window.onImages = list => {
    P.ready = true
    for (const image of (list ?? []).slice().sort((a, b) => a.at - b.at)) window.onImage(image, Date.now() - (image.at ?? 0) > 20_000)
  }

  const post = mode => fetch('/blender', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Live-Code-Secret': SECRET }, body: JSON.stringify({ mode }) }).catch(() => {})
  $('#bl-offer-on')?.addEventListener('click', () => post('on'))
  $('#bl-offer-no')?.addEventListener('click', () => post('never'))
  const setBox = $('#set-blender')
  setBox?.addEventListener('change', () => post(setBox.checked ? 'on' : 'off'))

  window.onBlender = state => {
    const was = P.blender?.info
    P.blender = state
    P.ready = true
    if (setBox) setBox.checked = state?.mode === 'on'
    reveal($('#bl-offer'), !!state?.spotted && !state.mode)
    const i = info()
    if (i && Date.now() - i.at < 15 * 60_000) blenderRow(i)
    if (i && (!was || i.meshAt !== was.meshAt || i.seq !== was.seq)) {
      const fresh = Date.now() - i.at < 20_000
      void loadMesh(fresh && !!was)
      if (fresh && was) {
        activity()
        if (P.tab !== 'model' && Date.now() - P.imageAt > 8000 && Date.now() - P.userTabAt > 15_000) setTab('model')
      }
    }
    // Blender at work, no model yet: the window comes anyway
    if (i && working() && Date.now() - i.at < 20_000 && was && !was.running) { activity(); if (!P.tab) setTab('model') }
    if (!P.tab) setTab(i ? 'model' : 'images')
    drawMeta()
  }

  // each tick of the page (drawNow): the time words, and away when all is calm
  window.drawBlender = () => {
    // (another chat shown: its list)
    if (listView !== S.view) renderList()
    if (!visible()) return
    drawMeta()
    if (!P.dock && !P.pinned && !P.hover && !working() && Date.now() - P.activity > HIDE_AFTER_MS) hide()
  }
  bindCheck('#set-preview', 'lc.preview', 'on', () => { if (store.get('lc.preview') === 'off') hide() })
  settle()
  drawMeta()
  // what the page was told before this script ran
  if (window.__pvInit?.images) window.onImages(window.__pvInit.images)
  if (window.__pvInit?.blender) window.onBlender(window.__pvInit.blender)
})()
