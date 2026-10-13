// Regenerates the WP 5.4 capture fixtures (e2e 45):
//   bharat-steel-bill.pdf        — a one-page bill with a real (Flate-compressed) text layer
//   bharat-steel-bill-photo.png  — a small "photo" of the same bill (TOTAL_AI_MOCK reads photos by
//                                   file name, so the pixels are only a placeholder)
// Usage: node scripts/e2e/fixtures/make-capture-fixtures.mjs   (Node ≥ 22.18: imports the TS
// fixture builder with type stripping).
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { makeTestPdf, FIXTURE_BILL_LINES } from '../../../src/shared/capture/pdfFixture.testutil.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const deflate = (b) => new Uint8Array(zlib.deflateSync(b))
fs.writeFileSync(path.join(here, 'bharat-steel-bill.pdf'), makeTestPdf(FIXTURE_BILL_LINES, { deflate }))

// A 120×80 off-white PNG with a darker band (8-bit greyscale).
const w = 120
const h = 80
const raw = Buffer.alloc((w + 1) * h)
for (let y = 0; y < h; y++) {
  raw[y * (w + 1)] = 0
  for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = y > 10 && y < 20 ? 90 : 235
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const c = Buffer.alloc(4)
  c.writeUInt32BE(crc(td))
  return Buffer.concat([len, td, c])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(w, 0)
ihdr.writeUInt32BE(h, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 0 // greyscale
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
fs.writeFileSync(path.join(here, 'bharat-steel-bill-photo.png'), png)
console.log('wrote', fs.readdirSync(here).filter((f) => !f.endsWith('.mjs')).join(', '))
