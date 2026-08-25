// A minimal PNG reader, and a perceptual signature built from it.
//
// Dependency-free on purpose. The alternative is `sharp` or `pngjs` in devDependencies for a job
// that is one inflate and one loop, and this repo has already declined a dependency for a smaller
// reason (src/main/cli/schemaDoc.ts hand-rolls a zod → JSON-schema walk). Everything here is
// node:zlib plus arithmetic.
//
// Only the subset Playwright's screenshots actually produce is handled: 8-bit RGBA or RGB,
// non-interlaced. Anything else throws by name rather than decoding to plausible nonsense.
import { inflateSync } from 'node:zlib'

/** @returns {{ width: number, height: number, channels: number, data: Buffer }} */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')

  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const body = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body[8]
      colorType = body[9]
      if (body[12] !== 0) throw new Error('interlaced PNG not supported')
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len // length + type + data + crc
  }

  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} not supported`)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!channels) throw new Error(`colour type ${colorType} not supported`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)

  // Undo the per-scanline filters. Each row is prefixed with one filter byte; every filter but
  // None refers to the pixel to the left and/or the row above, so this has to run in order.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0 // left
      const b = prev ? prev[x] : 0 // above
      const c = prev && x >= channels ? prev[x - channels] : 0 // above-left
      let v = src[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        // Paeth: pick whichever of left/above/above-left the gradient predicts.
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) {
        throw new Error(`unknown PNG filter ${filter} on row ${y}`)
      }
      cur[x] = v & 0xff
    }
  }

  return { width, height, channels, data: out }
}

/**
 * A screen reduced to two things: a coarse grid of average colour, and a palette histogram.
 *
 * The grid was luminance-only at first, and it did not catch the accent bar being changed from
 * indigo to red — a 3px sliver and a 10% row tint move almost no luminance at 32x20. Average
 * COLOUR per cell catches a card or a column changing hue; it still does not reliably catch a
 * thin element, because a 3px bar is a rounding error inside a 45x45 cell.
 *
 * So the histogram, which is the part that catches the bar. Every pixel is dropped into one of
 * 4x4x4 colour buckets and the result is the share of the screen in each. A thin indigo bar and a
 * thin red bar land in different buckets however few pixels they are, and the count is exact
 * rather than averaged away.
 *
 * Between them: the grid answers "did anything move", the histogram answers "did anything change
 * colour". Neither is troubled by today's date in the compliance calendar or by antialiasing.
 *
 * The grid is 32x20 because that keeps the 16:10 viewport's proportions — a non-square cell would
 * smear a horizontal rule differently from a vertical one.
 */
export function signature(png, cols = 32, rows = 20) {
  const { width, height, channels, data } = png
  const grid = Buffer.alloc(cols * rows * 3)
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const x0 = Math.floor((rx * width) / cols)
      const x1 = Math.max(x0 + 1, Math.floor(((rx + 1) * width) / cols))
      const y0 = Math.floor((ry * height) / rows)
      const y1 = Math.max(y0 + 1, Math.floor(((ry + 1) * height) / rows))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * channels
          r += data[i]
          g += data[i + 1]
          b += data[i + 2]
          n++
        }
      }
      const at = (ry * cols + rx) * 3
      grid[at] = Math.round(r / n)
      grid[at + 1] = Math.round(g / n)
      grid[at + 2] = Math.round(b / n)
    }
  }
  return Buffer.concat([grid, histogram(png)])
}

/**
 * The share of the screen in each of 64 colour buckets, as a byte each (0-255 = 0-100%).
 *
 * Two bits per channel. Coarse enough that antialiasing between two shades of the same colour
 * stays in one bucket, fine enough that indigo and red are never in the same one.
 */
function histogram(png) {
  const { width, height, channels, data } = png
  const counts = new Float64Array(64)
  const total = width * height
  for (let i = 0; i < total; i++) {
    const at = i * channels
    const bucket = ((data[at] >> 6) << 4) | ((data[at + 1] >> 6) << 2) | (data[at + 2] >> 6)
    counts[bucket]++
  }
  const out = Buffer.alloc(64)
  for (let i = 0; i < 64; i++) out[i] = Math.min(255, Math.round((counts[i] / total) * 255))
  return out
}

/**
 * The largest single-byte difference and the mean, over the grid and the histogram separately.
 *
 * Separately because they fail in different shapes and share no scale: a moved card spikes one
 * grid cell and barely touches the histogram, while a recoloured accent barely touches the grid
 * and moves two histogram buckets. Averaging them together would let each hide the other.
 */
export function compare(a, b) {
  if (a.length !== b.length) return { grid: { worst: 255, mean: 255 }, hist: { worst: 255, mean: 255 } }
  const HIST = 64
  const split = a.length - HIST
  const stat = (from, to) => {
    let worst = 0
    let total = 0
    for (let i = from; i < to; i++) {
      const d = Math.abs(a[i] - b[i])
      if (d > worst) worst = d
      total += d
    }
    return { worst, mean: total / (to - from) }
  }
  return { grid: stat(0, split), hist: stat(split, a.length) }
}
