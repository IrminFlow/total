/**
 * Detects a hardware barcode-scanner "type" (a fast burst of keystrokes terminated by Enter) as
 * distinct from a human typing the same characters. Pure — feed it timestamped chars from a
 * keydown handler; it owns no timers of its own.
 */
export interface ScanDetectorOptions {
  /** Max ms between consecutive keystrokes still considered part of the same scan burst. */
  maxGapMs?: number
  /** Minimum accumulated length (excluding the terminator) to count as a scan. */
  minLength?: number
}

export interface ScanDetector {
  /**
   * Feed one character at a timestamp (ms). `'\r'`/`'\n'` are treated as the scanner's Enter
   * terminator. Returns the decoded barcode once a fast-enough, long-enough burst is terminated,
   * otherwise null. A gap slower than `maxGapMs` discards whatever was buffered and restarts the
   * buffer with just the new character (i.e. only ever recognizes the most recent fast run).
   */
  feed(char: string, atMs: number): string | null
}

export function createScanDetector(opts: ScanDetectorOptions = {}): ScanDetector {
  const maxGapMs = opts.maxGapMs ?? 40
  const minLength = opts.minLength ?? 4
  let buffer = ''
  let lastAt: number | null = null

  return {
    feed(char: string, atMs: number): string | null {
      if (char === '\r' || char === '\n') {
        const code = buffer
        buffer = ''
        lastAt = null
        return code.length >= minLength ? code : null
      }
      if (lastAt !== null && atMs - lastAt > maxGapMs) {
        buffer = char
      } else {
        buffer += char
      }
      lastAt = atMs
      return null
    }
  }
}
