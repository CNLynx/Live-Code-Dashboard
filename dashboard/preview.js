// ── the preview window ──
// Floats over the dashboard and comes by itself: while Claude works in Blender,
// the model as it is built, turning (blender.mjs, live_code_blender.py); an
// image made where a chat works, rendered by Blender or sent to the person
// (images.mjs) builds up in it tile by tile. Dragged by its head, sized at its
// corner, both kept; it goes again a while after the last change, unless pinned.
(() => {
  const pv = $('#pv')
  if (!pv || TILE_MODE) return
  const head = $('#pv-head'), glc = $('#pv-gl'), imc = $('#pv-img'), meta = $('#pv-meta'), strip = $('#pv-strip'), title = $('#pv-title')
  const tabs = [...pv.querySelectorAll('[data-pv]')]
  const HIDE_AFTER_MS = 45_000
  const calm = () => document.documentElement.classList.contains('calm')
  const P = { blender: null, images: [], cur: null, tab: '', pinned: store.get('lc.pvPin') === 'on', activity: 0, imageAt: 0, userTabAt: 0, hover: false, open: false, meshAt: 0, hasMesh: false }
  pv.classList.toggle('pinned', P.pinned)

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
  const saveBox = () => store.set(BOX_KEY, JSON.stringify(box))
  addEventListener('resize', () => { if (box && P.open) { box = clampBox(box); place() } })

  // dragged by its head (not by its buttons)
  head.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return
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
    if (store.get('lc.preview') === 'off' || P.open) return
    P.open = true
    box = clampBox(box ?? defaultBox())
    place()
    pv.hidden = false
    requestAnimationFrame(() => requestAnimationFrame(() => pv.classList.add('shown')))
    loopGl()
  }
  const hide = () => {
    if (!P.open) return
    P.open = false
    pv.classList.remove('shown')
    setTimeout(() => { if (!P.open) pv.hidden = true }, 520)
  }
  $('#pv-close').addEventListener('click', hide)
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
  const HOW = { made: 'made', render: 'rendered in Blender', sent: 'sent to you' }
  const drawMeta = () => {
    const i = info()
    tabs[0].disabled = !i
    tabs[1].disabled = P.images.length === 0
    pv.classList.toggle('working', working())
    pv.classList.toggle('empty', !P.hasMesh)
    if (P.tab === 'model' && i) {
      setText(title, i.blend ? i.blend : 'Blender')
      setText(meta, [`Blender ${i.version}`.trim(), `${i.objects} objects`, `${kilo(i.tris)} triangles${i.cut ? ' (cut)' : ''}`, working() ? 'working…' : 'done', `${dur(Date.now() - i.at)} ago`].join(' · '))
    } else if (P.tab === 'images') {
      const it = P.images.find(x => x.id === P.cur)
      setText(title, it ? it.name : 'Images')
      setText(meta, it ? [HOW[it.how] ?? it.how, IMG.cur && IMG.item?.id === it.id ? `${IMG.cur.naturalWidth}×${IMG.cur.naturalHeight}` : '', `${dur(Date.now() - it.at)} ago`].filter(Boolean).join(' · ') : '')
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
    for (let i = 0; i < n; i++) {
      off += 2 + dv.getUint16(off, true)
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
      objs.push({ pos, parts }); nv += v
    }
    const pos = new Float32Array(nv * 3), idx = new Uint32Array(ni), draws = []
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    let vb = 0, ib = 0
    for (const o of objs) {
      pos.set(o.pos, vb * 3)
      for (const part of o.parts) {
        for (let j = 0; j < part.idx.length; j++) idx[ib + j] = part.idx[j] + vb
        draws.push({ col: part.col, first: ib, count: part.idx.length })
        ib += part.idx.length
      }
      vb += o.pos.length / 3
    }
    for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) { const x = pos[i + a]; if (x < min[a]) min[a] = x; if (x > max[a]) max[a] = x }
    return { pos, idx, draws, min, max, empty: draws.length === 0 }
  }

  const GL = (() => {
    const gl = glc.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true })
    if (!gl) return null
    const shader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s }
    const prog = gl.createProgram()
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, `#version 300 es
in vec3 p; uniform mat4 mvp; out vec3 wp;
void main() { wp = p; gl_Position = mvp * vec4(p, 1.0); }`))
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
in vec3 wp; uniform vec3 col; uniform vec3 eye; uniform float lines; uniform float alpha; out vec4 o;
void main() {
  if (lines > 0.5) { o = vec4(col * alpha, alpha); return; }
  vec3 n = normalize(cross(dFdx(wp), dFdy(wp)));
  vec3 v = normalize(eye - wp);
  if (dot(n, v) < 0.0) n = -n;
  float d = 0.30 + 0.56 * max(dot(n, normalize(vec3(0.45, -0.55, 0.75))), 0.0) + 0.16 * max(dot(n, normalize(vec3(-0.6, 0.5, 0.35))), 0.0) + 0.10 * (n.z * 0.5 + 0.5);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.16;
  o = vec4((col * d + rim) * alpha, alpha);
}`))
    gl.bindAttribLocation(prog, 0, 'p')
    gl.linkProgram(prog)
    const U = Object.fromEntries(['mvp', 'col', 'eye', 'lines', 'alpha'].map(k => [k, gl.getUniformLocation(prog, k)]))
    const vao = gl.createVertexArray(), vbo = gl.createBuffer(), ibo = gl.createBuffer()
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo)
    const gvao = gl.createVertexArray(), gvbo = gl.createBuffer()
    gl.bindVertexArray(gvao)
    gl.bindBuffer(gl.ARRAY_BUFFER, gvbo); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    let mesh = null, gridN = 0, bornAt = 0

    const cam = { yaw: -0.9, pitch: 0.42, zoom: 1, t: [0, 0, 0], r: 1, goalT: [0, 0, 0], goalR: 1, userAt: 0 }
    const set = m => {
      if (!m) return
      const first = !mesh || mesh.empty
      mesh = m
      if (m.empty) return
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
    }

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
      gl.bindVertexArray(gvao); gl.drawArrays(gl.LINES, 0, gridN)
      gl.uniform1f(U.lines, 0); gl.uniform1f(U.alpha, alpha)
      gl.bindVertexArray(vao)
      for (const d of mesh.draws) { gl.uniform3fv(U.col, d.col); gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_INT, d.first * 4) }
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
      if (!P.open || P.tab !== 'model' || document.hidden) { glRaf = 0; return }
      GL.draw(t)
      glRaf = requestAnimationFrame(step)
    }
    glRaf = requestAnimationFrame(step)
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && P.open) loopGl() })

  let meshBusy = false, meshAgain = false
  const loadMesh = async () => {
    if (meshBusy) { meshAgain = true; return }
    meshBusy = true
    try {
      const r = await fetch('/blender/mesh', { cache: 'no-store' })
      if (r.ok) { const m = parseMesh(await r.arrayBuffer()); if (m) { GL?.set(m); P.hasMesh = !m.empty } }
    } catch {}
    meshBusy = false
    drawMeta()
    if (meshAgain) { meshAgain = false; void loadMesh() }
  }

  // ── images: built up tile by tile ──
  const imx = imc.getContext('2d')
  const IMG = { cur: null, prev: null, item: null, start: 0, anim: false, jitter: [], raf: 0 }
  const ease = x => 1 - (1 - x) ** 3
  const fit = (im, W, H, pad) => {
    const s = Math.min((W - 2 * pad) / im.naturalWidth, (H - 2 * pad) / im.naturalHeight, 3 * (devicePixelRatio || 1))
    const w = im.naturalWidth * s, h = im.naturalHeight * s
    return { x: (W - w) / 2, y: (H - h) / 2, w, h }
  }
  const BUILD_MS = 1650, SHINE_MS = 700
  const drawImg = t => {
    const dpr = Math.min(2, devicePixelRatio || 1)
    const W = Math.max(1, Math.round(imc.clientWidth * dpr)), H = Math.max(1, Math.round(imc.clientHeight * dpr))
    if (imc.width !== W || imc.height !== H) { imc.width = W; imc.height = H }
    imx.clearRect(0, 0, W, H)
    const e = t - IMG.start
    const pad = 12 * dpr
    // the one before fades as the new one builds
    if (IMG.prev && e < 800) {
      const r = fit(IMG.prev, W, H, pad)
      imx.globalAlpha = 1 - ease(Math.min(1, e / 700))
      imx.drawImage(IMG.prev, r.x, r.y, r.w, r.h)
    }
    const im = IMG.cur
    if (!im) { imx.globalAlpha = 1; return false }
    const r = fit(im, W, H, pad)
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
    if (IMG.anim && e >= BUILD_MS && e < BUILD_MS + SHINE_MS) {
      busy = true
      const p = (e - BUILD_MS) / SHINE_MS, x = r.x - r.w * 0.4 + p * r.w * 1.8
      const g = imx.createLinearGradient(x - r.w * 0.25, r.y, x + r.w * 0.25, r.y + r.h * 0.3)
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,.22)'); g.addColorStop(1, 'rgba(255,255,255,0)')
      imx.globalAlpha = 1; imx.globalCompositeOperation = 'lighter'
      imx.fillStyle = g; imx.fillRect(r.x, r.y, r.w, r.h)
      imx.globalCompositeOperation = 'source-over'
    }
    imx.restore()
    imx.globalAlpha = 1
    return busy || (IMG.prev && e < 800)
  }
  const runImg = () => {
    cancelAnimationFrame(IMG.raf)
    const step = t => { IMG.raf = drawImg(t) ? requestAnimationFrame(step) : 0 }
    IMG.raf = requestAnimationFrame(step)
  }
  const showImg = (item, animate) => {
    const im = new Image()
    im.decoding = 'async'
    im.onload = () => {
      IMG.prev = IMG.cur; IMG.cur = im; IMG.item = item
      IMG.start = performance.now(); IMG.anim = animate && !calm(); IMG.jitter = []
      runImg(); drawMeta()
    }
    im.src = `/image?id=${item.id}`
  }
  const pick = (item, animate) => {
    P.cur = item.id
    for (const t of strip.children) t.classList.toggle('on', Number(t.dataset.id) === item.id)
    showImg(item, animate)
    drawMeta()
  }
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

  // ── what the server tells ──
  const activity = () => { P.activity = Date.now(); show() }
  window.onImage = (image, quiet) => {
    if (!image?.id) return
    const known = P.images.find(x => x.id === image.id)
    if (known) { Object.assign(known, image); drawMeta(); return }
    P.images.push(image)
    if (P.images.length > 40) P.images.shift()
    addThumb(image)
    if (quiet) { if (!P.cur) pick(image, false); drawMeta(); return }
    P.imageAt = Date.now()
    activity()
    // (unless the person just picked the model to watch)
    if (P.tab !== 'images' && Date.now() - P.userTabAt > 15_000) setTab('images')
    pick(image, true)
  }
  window.onImages = list => {
    for (const image of list ?? []) window.onImage(image, Date.now() - (image.at ?? 0) > 20_000)
  }

  const post = mode => fetch('/blender', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Live-Code-Secret': SECRET }, body: JSON.stringify({ mode }) }).catch(() => {})
  $('#bl-offer-on')?.addEventListener('click', () => post('on'))
  $('#bl-offer-no')?.addEventListener('click', () => post('never'))
  const setBox = $('#set-blender')
  setBox?.addEventListener('change', () => post(setBox.checked ? 'on' : 'off'))

  window.onBlender = state => {
    const was = P.blender?.info
    P.blender = state
    if (setBox) setBox.checked = state?.mode === 'on'
    reveal($('#bl-offer'), !!state?.spotted && !state.mode)
    const i = info()
    if (i && (!was || i.meshAt !== was.meshAt || i.seq !== was.seq)) {
      const fresh = Date.now() - i.at < 20_000
      void loadMesh()
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
    if (!P.open) return
    drawMeta()
    if (!P.pinned && !P.hover && !working() && Date.now() - P.activity > HIDE_AFTER_MS) hide()
  }
  bindCheck('#set-preview', 'lc.preview', 'on', () => { if (store.get('lc.preview') === 'off') hide() })
  // what the page was told before this script ran
  if (window.__pvInit?.images) window.onImages(window.__pvInit.images)
  if (window.__pvInit?.blender) window.onBlender(window.__pvInit.blender)
})()
