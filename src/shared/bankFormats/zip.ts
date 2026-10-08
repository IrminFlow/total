/**
 * Minimal ZIP reader + DEFLATE decoder — just enough to open an .xlsx (an OOXML package is a
 * ZIP of XML parts) without a dependency and without Node's zlib, so it stays pure and runs in
 * any JS context.
 *
 * - ZIP container per PKWARE's APPNOTE.TXT (sections 4.3.12 central directory header, 4.3.16
 *   end of central directory record). Only methods 0 (stored) and 8 (deflated) are supported —
 *   the two that Excel, LibreOffice, Numbers and Python's zipfile write. ZIP64 and encryption are
 *   rejected with a clear error.
 * - DEFLATE per RFC 1951 (stored / fixed Huffman / dynamic Huffman blocks).
 */

class BitReader {
  pos = 0
  bit = 0
  constructor(private readonly buf: Uint8Array) {}
  bits(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.buf.length) throw new Error('Corrupt deflate stream (unexpected end)')
      v |= ((this.buf[this.pos]! >> this.bit) & 1) << i
      if (++this.bit === 8) {
        this.bit = 0
        this.pos++
      }
    }
    return v
  }
  alignByte(): void {
    if (this.bit) {
      this.bit = 0
      this.pos++
    }
  }
}

interface Huffman {
  counts: Uint16Array
  symbols: Uint16Array
}

function buildHuffman(lengths: ArrayLike<number>): Huffman {
  const counts = new Uint16Array(16)
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]!]!++
  counts[0] = 0
  const offs = new Uint16Array(16)
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1]! + counts[i - 1]!
  const symbols = new Uint16Array(lengths.length)
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offs[lengths[i]!]!++] = i
  return { counts, symbols }
}

function decodeSym(br: BitReader, h: Huffman): number {
  let code = 0
  let first = 0
  let index = 0
  for (let len = 1; len < 16; len++) {
    code |= br.bits(1)
    const count = h.counts[len]!
    if (code - first < count) return h.symbols[index + (code - first)]!
    index += count
    first = (first + count) << 1
    code <<= 1
  }
  throw new Error('Corrupt deflate stream (bad Huffman code)')
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

let fixedLit: Huffman | null = null
let fixedDist: Huffman | null = null
function fixedTables(): [Huffman, Huffman] {
  if (!fixedLit || !fixedDist) {
    const l = new Uint8Array(288)
    l.fill(8, 0, 144)
    l.fill(9, 144, 256)
    l.fill(7, 256, 280)
    l.fill(8, 280, 288)
    fixedLit = buildHuffman(l)
    fixedDist = buildHuffman(new Uint8Array(30).fill(5))
  }
  return [fixedLit, fixedDist]
}

/** Decompress a raw DEFLATE stream (RFC 1951, no zlib/gzip wrapper). `limit` (bytes, 0 = none)
 *  stops a stream that inflates past its declared size — a zip bomb never fills memory. */
export function inflateRaw(data: Uint8Array, expectedSize = 0, limit = 0): Uint8Array {
  const br = new BitReader(data)
  let out = new Uint8Array(Math.max(expectedSize, 1024))
  let len = 0
  const ensure = (extra: number): void => {
    if (limit > 0 && len + extra > limit) throw new Error('Corrupt or oversized ZIP entry (inflates past its declared size)')
    if (len + extra <= out.length) return
    let size = out.length * 2
    while (size < len + extra) size *= 2
    const next = new Uint8Array(size)
    next.set(out.subarray(0, len))
    out = next
  }
  let final = 0
  while (!final) {
    final = br.bits(1)
    const type = br.bits(2)
    if (type === 0) {
      br.alignByte()
      const p = br.pos
      if (p + 4 > data.length) throw new Error('Corrupt deflate stream (stored block header)')
      const n = data[p]! | (data[p + 1]! << 8)
      br.pos = p + 4
      if (br.pos + n > data.length) throw new Error('Corrupt deflate stream (stored block length)')
      ensure(n)
      out.set(data.subarray(br.pos, br.pos + n), len)
      len += n
      br.pos += n
      continue
    }
    let lit: Huffman
    let dist: Huffman
    if (type === 1) {
      ;[lit, dist] = fixedTables()
    } else if (type === 2) {
      const hlit = br.bits(5) + 257
      const hdist = br.bits(5) + 1
      const hclen = br.bits(4) + 4
      const clLens = new Uint8Array(19)
      for (let i = 0; i < hclen; i++) clLens[CL_ORDER[i]!] = br.bits(3)
      const cl = buildHuffman(clLens)
      const lens = new Uint8Array(hlit + hdist)
      for (let i = 0; i < hlit + hdist; ) {
        const sym = decodeSym(br, cl)
        if (sym < 16) lens[i++] = sym
        else if (sym === 16) {
          if (i === 0) throw new Error('Corrupt deflate stream (repeat with no previous length)')
          const prev = lens[i - 1]!
          for (let r = 3 + br.bits(2); r > 0; r--) lens[i++] = prev
        } else if (sym === 17) i += 3 + br.bits(3)
        else i += 11 + br.bits(7)
      }
      lit = buildHuffman(lens.subarray(0, hlit))
      dist = buildHuffman(lens.subarray(hlit))
    } else {
      throw new Error('Corrupt deflate stream (reserved block type)')
    }
    for (;;) {
      const sym = decodeSym(br, lit)
      if (sym < 256) {
        ensure(1)
        out[len++] = sym
      } else if (sym === 256) {
        break
      } else {
        const li = sym - 257
        if (li >= LEN_BASE.length) throw new Error('Corrupt deflate stream (bad length code)')
        const length = LEN_BASE[li]! + br.bits(LEN_EXTRA[li]!)
        const di = decodeSym(br, dist)
        if (di >= DIST_BASE.length) throw new Error('Corrupt deflate stream (bad distance code)')
        const d = DIST_BASE[di]! + br.bits(DIST_EXTRA[di]!)
        if (d > len) throw new Error('Corrupt deflate stream (distance too far back)')
        ensure(length)
        for (let k = 0; k < length; k++) {
          out[len] = out[len - d]!
          len++
        }
      }
    }
  }
  return out.slice(0, len)
}

/** Largest single unpacked part accepted (a year of daily statement rows is a few MB). */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  localOffset: number
}

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8)
const u32 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0

const utf8 = new TextDecoder('utf-8')

/** Read the central directory. Throws a plain-language error on anything that isn't a ZIP. */
export function zipEntries(buf: Uint8Array): ZipEntry[] {
  // End of central directory: signature 0x06054b50, searched backwards (a comment may follow).
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (u32(buf, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP / .xlsx file')
  const count = u16(buf, eocd + 10)
  let p = u32(buf, eocd + 16)
  if (p === 0xffffffff) throw new Error('ZIP64 archives are not supported')
  const entries: ZipEntry[] = []
  for (let k = 0; k < count; k++) {
    if (u32(buf, p) !== 0x02014b50) throw new Error('Corrupt ZIP central directory')
    const flags = u16(buf, p + 8)
    const method = u16(buf, p + 10)
    const compressedSize = u32(buf, p + 20)
    const size = u32(buf, p + 24)
    const nameLen = u16(buf, p + 28)
    const extraLen = u16(buf, p + 30)
    const commentLen = u16(buf, p + 32)
    const localOffset = u32(buf, p + 42)
    const name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen))
    if (flags & 1) throw new Error('Encrypted (password-protected) files are not supported — save an unprotected copy')
    entries.push({ name, method, compressedSize, size, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Extract one entry's bytes. */
export function zipRead(buf: Uint8Array, entry: ZipEntry): Uint8Array {
  const p = entry.localOffset
  if (u32(buf, p) !== 0x04034b50) throw new Error('Corrupt ZIP local header')
  const start = p + 30 + u16(buf, p + 26) + u16(buf, p + 28)
  const raw = buf.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return raw.slice()
  if (entry.size > MAX_ENTRY_BYTES) throw new Error(`${entry.name} is ${Math.round(entry.size / 1048576)} MB unpacked — too large for a bank statement (limit ${MAX_ENTRY_BYTES / 1048576} MB)`)
  if (entry.method === 8) return inflateRaw(raw, entry.size, entry.size)
  throw new Error(`Unsupported ZIP compression method ${entry.method}`)
}

/** name → text for the entries whose name passes `want`. */
export function unzipText(buf: Uint8Array, want: (name: string) => boolean): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of zipEntries(buf)) if (want(e.name)) out.set(e.name, utf8.decode(zipRead(buf, e)))
  return out
}
