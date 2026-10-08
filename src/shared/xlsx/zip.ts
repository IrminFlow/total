/**
 * Minimal ZIP container reader/writer (PKWARE APPNOTE 6.3.x, the subset an .xlsx needs) — pure:
 * no Node, no zlib. Compression is injected: the main process passes `zlib.inflateRawSync` /
 * `deflateRawSync` (src/main/services/xlsxFile.ts); tests pass the same from `node:zlib`.
 *
 * Reader: walks the central directory from the End Of Central Directory record (the only
 * reliable index — local headers may carry zero sizes when bit 3 "data descriptor" is set).
 * Methods 0 (stored) and 8 (deflate). ZIP64 and encryption are refused with a clear error.
 *
 * Writer: one local header + data per entry, a central directory and the EOCD. Timestamps are
 * fixed (1980-01-01 00:00) so the same input always produces the same bytes.
 */

/** Raw-DEFLATE decoder; `expectedSize` is the entry's declared size — implementations must not
 *  produce more (a zip bomb stops at the cap instead of eating memory). */
export type Inflate = (data: Uint8Array, expectedSize: number) => Uint8Array

/** Largest total uncompressed size readZip accepts (an .xlsx this big is not a ledger). */
export const MAX_ZIP_TOTAL_BYTES = 512 * 1024 * 1024
export type Deflate = (data: Uint8Array) => Uint8Array

export interface ZipEntry {
  name: string
  /** Uncompressed bytes. */
  data: Uint8Array
}

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

function u16(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8)
}
function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0
}

const utf8 = new TextDecoder('utf-8')
// Pre-UTF-8 ZIP names are CP437; every name an .xlsx uses is ASCII, so latin1 is close enough.
const latin1 = new TextDecoder('latin1')

/** True when the bytes start like a ZIP (an .xlsx) — "PK\x03\x04". */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && u32(bytes, 0) === SIG_LOCAL
}

/** Reads every entry's uncompressed bytes, keyed by name. Throws on anything that is not a ZIP. */
export function readZip(bytes: Uint8Array, inflate: Inflate): Map<string, Uint8Array> {
  if (bytes.length < 22) throw new Error('Not a ZIP file (too short)')
  // EOCD: last 22 bytes + up to 65535 of comment.
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (u32(bytes, i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (no end-of-central-directory record) — is this really an .xlsx?')
  const count = u16(bytes, eocd + 10)
  const cdOffset = u32(bytes, eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported')
  const out = new Map<string, Uint8Array>()
  let total = 0
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || u32(bytes, p) !== SIG_CENTRAL) throw new Error('Corrupt ZIP central directory')
    const flags = u16(bytes, p + 8)
    const method = u16(bytes, p + 10)
    const crc = u32(bytes, p + 16)
    const compSize = u32(bytes, p + 20)
    const size = u32(bytes, p + 24)
    const nameLen = u16(bytes, p + 28)
    const extraLen = u16(bytes, p + 30)
    const commentLen = u16(bytes, p + 32)
    const localOffset = u32(bytes, p + 42)
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen)
    const name = (flags & 0x800 ? utf8 : latin1).decode(nameBytes)
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue // directory entry
    if (flags & 0x1) throw new Error(`"${name}" is encrypted — remove the workbook password and try again`)
    if (u32(bytes, localOffset) !== SIG_LOCAL) throw new Error('Corrupt ZIP local header')
    const dataStart = localOffset + 30 + u16(bytes, localOffset + 26) + u16(bytes, localOffset + 28)
    const raw = bytes.subarray(dataStart, dataStart + compSize)
    total += size
    if (total > MAX_ZIP_TOTAL_BYTES) throw new Error('The file unpacks to more than 512 MB — too large to import')
    let data: Uint8Array
    if (method === 0) data = raw
    else if (method === 8) data = inflate(raw, size)
    else throw new Error(`"${name}" uses unsupported ZIP compression method ${method}`)
    if (data.length !== size) throw new Error(`"${name}" is truncated (${data.length} of ${size} bytes)`)
    if (crc32(data) !== crc) throw new Error(`"${name}" failed its CRC check — the file is damaged`)
    out.set(name, data)
  }
  return out
}

/** Builds a ZIP. With `deflate`, entries are compressed (method 8) unless that makes them bigger. */
export function writeZip(entries: ZipEntry[], deflate?: Deflate): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const name = enc.encode(e.name)
    const crc = crc32(e.data)
    let method = 0
    let body = e.data
    if (deflate && e.data.length > 64) {
      const c = deflate(e.data)
      if (c.length < e.data.length) {
        method = 8
        body = c
      }
    }
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, SIG_LOCAL, true)
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0x800, true) // UTF-8 names
    lv.setUint16(8, method, true)
    lv.setUint16(10, 0, true) // time
    lv.setUint16(12, 0x21, true) // date 1980-01-01
    lv.setUint32(14, crc, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, e.data.length, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)
    local.set(name, 30)
    parts.push(local, body)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, SIG_CENTRAL, true)
    cv.setUint16(4, 20, true) // made by
    cv.setUint16(6, 20, true) // needed
    cv.setUint16(8, 0x800, true)
    cv.setUint16(10, method, true)
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0x21, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, e.data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)
    centrals.push(central)
    offset += local.length + body.length
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, SIG_EOCD, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  const out = new Uint8Array(offset + cdSize + 22)
  let p = 0
  for (const part of [...parts, ...centrals, eocd]) {
    out.set(part, p)
    p += part.length
  }
  return out
}
