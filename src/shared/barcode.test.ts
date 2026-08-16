import { describe, it, expect } from 'vitest'
import { createScanDetector } from './barcode'

function feedString(detector: ReturnType<typeof createScanDetector>, code: string, start: number, gapMs: number): string | null {
  let t = start
  let result: string | null = null
  for (const ch of code) {
    result = detector.feed(ch, t)
    t += gapMs
  }
  result = detector.feed('\r', t)
  return result
}

describe('createScanDetector', () => {
  it('recognizes a fast burst terminated by Enter as a scan', () => {
    const d = createScanDetector()
    expect(feedString(d, '8901030875021', 1000, 5)).toBe('8901030875021')
  })

  it('rejects human typing speed (~200ms per key)', () => {
    const d = createScanDetector()
    expect(feedString(d, '8901030875021', 1000, 200)).toBeNull()
  })

  it('rejects a fast burst shorter than minLength', () => {
    const d = createScanDetector({ minLength: 4 })
    expect(feedString(d, '12', 1000, 5)).toBeNull()
  })

  it('resets the buffer after a slow gap, keeping only the fast run since then', () => {
    const d = createScanDetector({ maxGapMs: 40, minLength: 4 })
    // Slow typed prefix, well-separated in time...
    d.feed('X', 0)
    d.feed('Y', 300)
    // ...then a genuinely fast scanner burst starts.
    d.feed('1', 500)
    d.feed('2', 505)
    d.feed('3', 510)
    d.feed('4', 515)
    d.feed('5', 520)
    const result = d.feed('\r', 525)
    expect(result).toBe('12345')
  })

  it('accepts both \\n and \\r as the terminator', () => {
    const d1 = createScanDetector()
    d1.feed('A', 0)
    d1.feed('B', 5)
    d1.feed('C', 10)
    d1.feed('D', 15)
    expect(d1.feed('\n', 20)).toBe('ABCD')
  })
})
