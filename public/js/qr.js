// Minimal QR code generator — byte mode, EC level M, versions 1-4
// Returns SVG string with quiet zone

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
let _v = 1
for (let i = 0; i < 255; i++) {
  EXP[i] = _v; LOG[_v] = i
  _v <<= 1; if (_v >= 256) _v ^= 0x11D
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]

function gfMul(a, b) { return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]] }

function rsEncode(data, ecLen) {
  let gen = new Uint8Array([1])
  for (let i = 0; i < ecLen; i++) {
    const next = new Uint8Array(gen.length + 1)
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j]
      next[j + 1] ^= gfMul(gen[j], EXP[i])
    }
    gen = next
  }
  const msg = new Uint8Array(data.length + ecLen)
  msg.set(data)
  for (let i = 0; i < data.length; i++) {
    if (msg[i] === 0) continue
    for (let j = 1; j < gen.length; j++) msg[i + j] ^= gfMul(gen[j], msg[i])
  }
  return msg.slice(data.length)
}

// EC-M specs: [dataPerBlock[], ecPerBlock, alignPositions[]]
const SPECS = [
  null,
  { d: [16], ec: 10, al: [] },
  { d: [28], ec: 16, al: [6, 18] },
  { d: [44], ec: 26, al: [6, 22] },
  { d: [32, 32], ec: 18, al: [6, 26] },
]

function pickVersion(len) {
  const need = Math.ceil((4 + 8 + len * 8 + 4) / 8)
  for (let v = 1; v <= 4; v++) if (SPECS[v].d.reduce((a, b) => a + b, 0) >= need) return v
  throw new Error('data too long')
}

function encode(text, version) {
  const totalData = SPECS[version].d.reduce((a, b) => a + b, 0)
  const bytes = new Uint8Array(totalData)
  let p = 0
  const w = (val, len) => { for (let i = len - 1; i >= 0; i--) { if (val & (1 << i)) bytes[p >> 3] |= 0x80 >> (p & 7); p++ } }
  w(0b0100, 4)
  w(text.length, 8)
  for (let i = 0; i < text.length; i++) w(text.charCodeAt(i), 8)
  w(0, Math.min(4, totalData * 8 - p))
  p = Math.ceil(p / 8) * 8
  let pad = 0
  while (p < totalData * 8) { w(pad ? 0x11 : 0xEC, 8); pad ^= 1 }
  return bytes
}

function buildCW(data, version) {
  const spec = SPECS[version]
  const blocks = []
  let off = 0
  for (const bLen of spec.d) {
    blocks.push({ d: data.slice(off, off + bLen), ec: rsEncode(data.slice(off, off + bLen), spec.ec) })
    off += bLen
  }
  const result = []
  const maxD = Math.max(...spec.d)
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) result.push(b.d[i])
  for (let i = 0; i < spec.ec; i++) for (const b of blocks) result.push(b.ec[i])
  return new Uint8Array(result)
}

const FP = [[1,1,1,1,1,1,1],[1,0,0,0,0,0,1],[1,0,1,1,1,0,1],[1,0,1,1,1,0,1],[1,0,1,1,1,0,1],[1,0,0,0,0,0,1],[1,1,1,1,1,1,1]]

function makeMatrix(version) {
  const sz = 17 + version * 4
  const m = Array.from({ length: sz }, () => new Uint8Array(sz))
  const place = (r, c) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr, cc = c + dc
      if (rr < 0 || rr >= sz || cc < 0 || cc >= sz) continue
      m[rr][cc] = (dr >= 0 && dr < 7 && dc >= 0 && dc < 7) ? (FP[dr][dc] ? 3 : 4) : 4
    }
  }
  place(0, 0); place(0, sz - 7); place(sz - 7, 0)
  for (let i = 8; i < sz - 8; i++) { if (!m[6][i]) m[6][i] = i % 2 === 0 ? 3 : 4; if (!m[i][6]) m[i][6] = i % 2 === 0 ? 3 : 4 }
  const al = SPECS[version].al
  if (al.length >= 2) for (const r of al) for (const c of al) {
    if ((r < 9 && c < 9) || (r < 9 && c > sz - 9) || (r > sz - 9 && c < 9)) continue
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++)
      m[r + dr][c + dc] = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 3 : 4
  }
  m[sz - 8][8] = 3
  for (let i = 0; i < 9; i++) {
    if (!m[8][i]) m[8][i] = 4; if (!m[i][8]) m[i][8] = 4
    if (i < 8) { if (!m[8][sz - 1 - i]) m[8][sz - 1 - i] = 4; if (!m[sz - 1 - i][8]) m[sz - 1 - i][8] = 4 }
  }
  return m
}

function placeData(m, cw) {
  const sz = m.length
  let bi = 0
  const total = cw.length * 8
  let x = sz - 1, up = true
  while (x >= 1) {
    if (x === 6) x--
    const start = up ? sz - 1 : 0, end = up ? -1 : sz, step = up ? -1 : 1
    for (let y = start; y !== end; y += step) for (let dx = 0; dx <= 1; dx++) {
      const col = x - dx
      if (col < 0 || m[y][col] !== 0) continue
      if (bi < total) { m[y][col] = ((cw[bi >> 3] >> (7 - (bi & 7))) & 1) ? 1 : 2; bi++ }
      else m[y][col] = 2
    }
    x -= 2; up = !up
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (~~(r / 2) + ~~(c / 3)) % 2 === 0,
  (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
  (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
]

function applyMask(m, n) {
  const r = m.map(row => new Uint8Array(row))
  const mask = MASKS[n]
  for (let y = 0; y < r.length; y++) for (let x = 0; x < r.length; x++)
    if (r[y][x] === 1 || r[y][x] === 2) { if (mask(y, x)) r[y][x] = r[y][x] === 1 ? 2 : 1 }
  return r
}

function penalty(m) {
  const sz = m.length
  let s = 0
  const dk = (r, c) => m[r][c] === 1 || m[r][c] === 3
  for (let r = 0; r < sz; r++) {
    let rr = 1, cr = 1
    for (let c = 1; c < sz; c++) {
      if (dk(r, c) === dk(r, c - 1)) rr++; else { if (rr >= 5) s += rr - 2; rr = 1 }
      if (dk(c, r) === dk(c - 1, r)) cr++; else { if (cr >= 5) s += cr - 2; cr = 1 }
    }
    if (rr >= 5) s += rr - 2; if (cr >= 5) s += cr - 2
  }
  for (let r = 0; r < sz - 1; r++) for (let c = 0; c < sz - 1; c++) {
    const d = dk(r, c); if (d === dk(r, c + 1) && d === dk(r + 1, c) && d === dk(r + 1, c + 1)) s += 3
  }
  return s
}

const FMT = [0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0]

function placeFormat(m, mask) {
  const sz = m.length, info = FMT[mask]
  const bits = []; for (let i = 0; i < 15; i++) bits.push((info >> i) & 1)
  const rc = [0, 1, 2, 3, 4, 5, 7, 8]
  for (let i = 0; i < 8; i++) m[8][rc[i]] = bits[i] ? 3 : 4
  m[7][8] = bits[8] ? 3 : 4
  for (let i = 9; i < 15; i++) m[14 - i][8] = bits[i] ? 3 : 4
  for (let i = 0; i < 7; i++) m[sz - 1 - i][8] = bits[i] ? 3 : 4
  for (let i = 7; i < 15; i++) m[8][sz - 15 + i] = bits[i] ? 3 : 4
}

export function generateQR(text) {
  const ver = pickVersion(text.length)
  const data = encode(text, ver)
  const cw = buildCW(data, ver)
  const matrix = makeMatrix(ver)
  placeData(matrix, cw)
  let best = 0, bestS = Infinity
  for (let n = 0; n < 8; n++) { const s = penalty(applyMask(matrix, n)); if (s < bestS) { bestS = s; best = n } }
  const final = applyMask(matrix, best)
  placeFormat(final, best)
  return renderSVG(final)
}

function renderSVG(m) {
  const sz = m.length, mg = 4, total = sz + mg * 2
  const dk = v => v === 1 || v === 3
  let path = ''
  for (let r = 0; r < sz; r++) {
    let c = 0
    while (c < sz) {
      if (dk(m[r][c])) {
        let run = 0; while (c + run < sz && dk(m[r][c + run])) run++
        path += `M${c + mg} ${r + mg}h${run}v1h-${run}z`
        c += run
      } else c++
    }
  }
  return `<svg viewBox="0 0 ${total} ${total}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%"><rect width="${total}" height="${total}" fill="#fff" rx="2"/><path d="${path}" fill="#000"/></svg>`
}
