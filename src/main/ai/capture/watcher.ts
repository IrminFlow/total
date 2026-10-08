// WP 5.4 — the watched drop folder <company>/capture-inbox/ (the WP 5.7 inbox pattern): a bill
// dropped there is QUEUED (status 'queued' — nothing is sent until the user approves the cost
// estimate on the Capture screen) and moved to capture-inbox/processed/<stamp>-<name>; a file
// that cannot be captured is moved to capture-inbox/failed/<stamp>-<name> with
// <stamp>-<name>.reason.txt. Intake is local only, so the folder works while AI is off.
//
// Safety: symlinks and non-files are skipped; a file is taken only once its size and mtime are
// the same on two scans (a writer still copying it is left alone) and it is at least a second
// old; the size is checked BEFORE the file is read; a file that cannot be moved is retried a few
// times, then left (logged once) — never an endless rescan.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'fs'
import { join } from 'path'
import type { DB } from '../../db/connection'
import { CAPTURE_MAX_BYTES } from '@shared/capture/types'
import { runAsAuditUser } from '../../services/audit'
import { log } from '../../log'
import { captureFilesDir, captureInboxDir, cleanName } from './files'
import { checkCaptureFile, insertCaptureFile } from './store'

export const CAPTURE_INBOX_USER = 'capture-inbox'
export const INBOX_MAX_ATTEMPTS = 5

export interface InboxScanOutcome {
  file: string
  ok: boolean
  detail: string
  movedTo: string
}

/** Per-company scan memory: last seen size+mtime per file, failed move attempts, given-up files. */
export interface InboxScanState {
  seen: Map<string, string>
  attempts: Map<string, number>
  gaveUp: Set<string>
}
export const newScanState = (): InboxScanState => ({ seen: new Map(), attempts: new Map(), gaveUp: new Set() })

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')
const skip = (name: string): boolean => name.startsWith('.') || /\.(crdownload|part|tmp|download)$/i.test(name) || /\.reason\.txt$/i.test(name)

/** Queue every settled file sitting directly in the inbox. Returns what it did, and whether
 *  files are still waiting (to settle, or to be retried). */
export async function scanCaptureInbox(
  db: DB,
  companyDir: string,
  state: InboxScanState = newScanState(),
  opts: { now?: number; minAgeMs?: number; requireStable?: boolean } = {}
): Promise<{ outcomes: InboxScanOutcome[]; waiting: number }> {
  const inbox = captureInboxDir(companyDir)
  if (!existsSync(inbox)) return { outcomes: [], waiting: 0 }
  const now = opts.now ?? Date.now()
  const minAge = opts.minAgeMs ?? 1000
  const outcomes: InboxScanOutcome[] = []
  let waiting = 0
  const processed = join(inbox, 'processed')
  const failedDir = join(inbox, 'failed')
  for (const name of readdirSync(inbox).sort()) {
    if (skip(name) || state.gaveUp.has(name)) continue
    const full = join(inbox, name)
    let st
    try {
      st = lstatSync(full)
    } catch {
      continue
    }
    if (st.isSymbolicLink() || !st.isFile()) continue
    const sig = `${st.size}:${st.mtimeMs}`
    const stable = state.seen.get(name) === sig
    state.seen.set(name, sig)
    if (now - st.mtimeMs < minAge || (opts.requireStable !== false && !stable)) {
      waiting++
      continue
    }
    mkdirSync(processed, { recursive: true })
    mkdirSync(failedDir, { recursive: true })
    const move = (to: string): boolean => {
      try {
        renameSync(full, to)
        state.seen.delete(name)
        state.attempts.delete(name)
        return true
      } catch (err) {
        const n = (state.attempts.get(name) ?? 0) + 1
        state.attempts.set(name, n)
        if (n >= INBOX_MAX_ATTEMPTS) {
          state.gaveUp.add(name)
          log('warn', 'capture-inbox-move-gave-up', { file: name, error: err instanceof Error ? err.message : String(err) })
        } else waiting++
        return false
      }
    }
    const fail = (reason: string): void => {
      const dest = join(failedDir, `${stamp()}-${cleanName(name)}`)
      if (!move(dest)) return
      writeFileSync(`${dest}.reason.txt`, `${reason}\n`)
      outcomes.push({ file: name, ok: false, detail: reason, movedTo: dest })
    }
    // Size first — an oversized file is never read into memory.
    if (st.size > CAPTURE_MAX_BYTES) {
      fail(`${cleanName(name)} is ${(st.size / 1048576).toFixed(1)} MB — capture takes files up to ${CAPTURE_MAX_BYTES / 1048576} MB`)
      continue
    }
    try {
      const bytes = readFileSync(full)
      const checked = await checkCaptureFile(name, bytes)
      const r = runAsAuditUser(CAPTURE_INBOX_USER, () => insertCaptureFile(db, captureFilesDir(companyDir), checked, { bytes, origin: 'folder', addedBy: CAPTURE_INBOX_USER }))
      if (r.refusal || !r.item) fail(r.refusal ?? 'not captured')
      else {
        const dest = join(processed, `${stamp()}-${cleanName(name)}`)
        if (move(dest)) outcomes.push({ file: name, ok: true, detail: `queued as capture item #${r.item.id}`, movedTo: dest })
      }
    } catch (err) {
      fail((err as Error).message)
    }
  }
  return { outcomes, waiting }
}

let watcher: FSWatcher | null = null
let watched: string | null = null
let timer: NodeJS.Timeout | null = null
let scanning = false
let state = newScanState()

/** Watch the open company's capture inbox (null = stop). One initial scan picks up files dropped
 *  while the app was closed. */
export function syncCaptureWatcher(company: { slug: string; db: DB; dir: string } | null): void {
  if (watcher && (!company || company.slug !== watched)) {
    watcher.close()
    watcher = null
    watched = null
    state = newScanState()
  }
  if (timer && !company) {
    clearTimeout(timer)
    timer = null
  }
  if (!company || watcher) return
  const inbox = captureInboxDir(company.dir)
  mkdirSync(inbox, { recursive: true })
  const scan = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (scanning) return scan()
      scanning = true
      scanCaptureInbox(company.db, company.dir, state)
        .then(({ outcomes, waiting }) => {
          if (outcomes.length) log('info', 'capture-inbox-scan', { queued: outcomes.filter((r) => r.ok).length, failed: outcomes.filter((r) => !r.ok).length })
          // Files still settling (or a move to retry) are looked at again shortly.
          if (waiting > 0 && watched === company.slug) scan()
        })
        .catch((err: unknown) => log('warn', 'capture-inbox-scan-failed', { error: err instanceof Error ? err.message : String(err) }))
        .finally(() => {
          scanning = false
        })
    }, 1200)
    timer.unref?.()
  }
  try {
    watcher = watch(inbox, scan)
    watched = company.slug
  } catch (err) {
    log('warn', 'capture-inbox-watch-failed', { error: err instanceof Error ? err.message : String(err) })
    return
  }
  scan()
}
