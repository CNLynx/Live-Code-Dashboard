// Builds the Stream Deck side of Live Code:
//   1. com.cnlynx.livecode.sdPlugin/Live Code.streamDeckProfile, the
//      fifteen-key page (every key a "Live Code key"), and
//   2. dist/com.cnlynx.livecode.streamDeckPlugin, the package a double-click
//      installs in the Stream Deck app.
// No dependencies: `node build.mjs`.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, 'com.cnlynx.livecode.sdPlugin')
const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'manifest.json'), 'utf8').replace(/^﻿/, ''))

// ── a zip, stored with forward slashes as the Stream Deck expects ──
// (Folders get no entries of their own: the Stream Deck's importer makes the
// folders from the files' paths, and stumbles over folder entries.)
const zip = all => {
  const entries = all.filter(e => !e.name.endsWith('/') && !e.name.endsWith('\\'))
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const isDir = name.endsWith('/') || name.endsWith('\\')
    const body = isDir ? Buffer.alloc(0) : zlib.deflateRawSync(data)
    const crc = isDir ? 0 : zlib.crc32(data)
    const method = isDir ? 0 : 8
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc >>> 0, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(isDir ? 0 : data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(method, 10)
    central.writeUInt32LE(0, 12); central.writeUInt32LE(crc >>> 0, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(isDir ? 0 : data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36)
    central.writeUInt32LE(isDir ? 0x10 : 0, 38); central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

// The Stream Deck names a page's folder by its UUID in base32hex, plus "Z".
const base32hex = bytes => {
  const ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUV'
  let bits = 0, value = 0, out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) { out += ALPHA[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += ALPHA[(value << (5 - bits)) & 31]
  return out
}
// The ids of Elgato's own bundled profiles: the importer takes these (it gives
// the profile new ones as it imports), where ids of our own left it without pages.
const PROFILE_ID = '13C678B3-D699-4EDE-9E5B-836C930FD5F0'
const PAGE_UUID = 'b22efbb6-20d8-4c72-9609-edad1d93aaa8'
const pageFolder = base32hex(Buffer.from(PAGE_UUID.replace(/-/g, ''), 'hex')) + 'Z'

const actions = {}
for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 5; col++) {
    // shaped as Elgato's own bundled profiles write a key
    actions[`${col},${row}`] = {
      Name: 'Live Code key',
      Settings: null,
      State: 0,
      States: [{ Image: '', ShowTitle: false, TitleAlignment: 'middle' }],
      UUID: 'com.cnlynx.livecode.slot',
    }
  }
}
// the profile archive's paths use backslashes, as the Stream Deck's own do
const root = `${PROFILE_ID}.sdProfile\\`
const profile = zip([
  { name: root, data: null },
  { name: `${root}manifest.json`, data: Buffer.from(JSON.stringify({
    Device: { Model: '20GAA9902', UUID: '' },
    InstalledByPluginUUID: manifest.UUID,
    Name: 'Live Code',
    Pages: { Current: PAGE_UUID, Pages: [PAGE_UUID] },
    PreconfiguredName: 'Live Code',
    Version: '2.0',
  })) },
  { name: `${root}Profiles\\`, data: null },
  { name: `${root}Profiles\\${pageFolder}\\`, data: null },
  { name: `${root}Profiles\\${pageFolder}\\Images\\`, data: null },
  { name: `${root}Profiles\\${pageFolder}\\manifest.json`, data: Buffer.from(JSON.stringify({ Controllers: [{ Actions: actions, Type: 'Keypad' }] })) },
])
fs.writeFileSync(path.join(PLUGIN, 'Live Code.streamDeckProfile'), profile)
console.log('profile:', path.join(PLUGIN, 'Live Code.streamDeckProfile'), profile.length, 'bytes')

// ── the installer package: the plugin folder, zipped ──
const files = []
const walk = (dir, rel) => {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'plugin.log') continue
    const full = path.join(dir, name)
    const r = `${rel}${name}`
    if (fs.statSync(full).isDirectory()) { files.push({ name: `${r}/`, data: null }); walk(full, `${r}/`) }
    else files.push({ name: r, data: fs.readFileSync(full) })
  }
}
files.push({ name: 'com.cnlynx.livecode.sdPlugin/', data: null })
walk(PLUGIN, 'com.cnlynx.livecode.sdPlugin/')
// (the setup builds it into a folder of its own: node build.mjs <folder>)
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, 'dist')
fs.mkdirSync(OUT, { recursive: true })
const pkg = path.join(OUT, 'com.cnlynx.livecode.streamDeckPlugin')
fs.writeFileSync(pkg, zip(files))
console.log('package:', pkg, fs.statSync(pkg).size, 'bytes')
