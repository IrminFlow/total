// WP 7.3 — atomic "write a temp file, rename it over the real one" on Windows. A rename onto a
// file that another process holds open for a moment (Defender or the Search indexer scanning the
// file just written, a sync client) fails with EPERM / EACCES / EBUSY on Windows, where macOS
// would simply replace it. The same retry graceful-fs applies: a few short synchronous waits, then
// the error. Elsewhere the first attempt is the only one (those codes are real errors there).
import { renameSync } from 'fs'

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function renameReplacing(
  from: string,
  to: string,
  opts: { platform?: NodeJS.Platform; rename?: (a: string, b: string) => void; sleep?: (ms: number) => void; totalMs?: number } = {}
): void {
  const rename = opts.rename ?? renameSync
  const sleep = opts.sleep ?? sleepMs
  const retry = (opts.platform ?? process.platform) === 'win32'
  const budget = opts.totalMs ?? 1000
  let waited = 0
  for (let delay = 10; ; delay = Math.min(delay * 2, 200)) {
    try {
      rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (!retry || !RETRY_CODES.has(code) || waited >= budget) throw err
      sleep(delay)
      waited += delay
    }
  }
}
