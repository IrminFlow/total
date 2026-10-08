// WP 5.4 — the watched drop folder <company>/capture-inbox/ (the WP 5.7 inbox pattern): a bill
// dropped there is QUEUED (status 'queued' — nothing is sent until the user approves the cost
// estimate on the Capture screen) and moved to capture-inbox/processed/<stamp>-<name>; a file
// that cannot be captured is moved to capture-inbox/failed/<name> with <name>.reason.txt.
// Intake is local only, so the folder works while AI is off. Hidden and partial downloads are
// left alone; a file still being written (changed in the last second) is picked up next scan.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from 'fs'
import { join } from 'path'
import type { DB } from '../../db/connection'
import { runAsAuditUser } from '../../services/audit'
import { log } from '../../log'
import { captureFilesDir, captureInboxDir, cleanName } from './files'
import { addCaptureFile } from './store'

export const CAPTURE_INBOX_USER = 'capture-inbox'

export interface InboxScanOutcome {
  file: string
  ok: boolean
  detail: string
  movedTo: string
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')
const skip = (name: string): boolean => name.startsWith('.') || /\.(crdownload|part|tmp|download)$/i.test(name) || /\.reason\.txt$/i.test(name)

/** Queue every settled file sitting directly in the inbox. `now` for tests. */
export function scanCaptureInbox(db: DB, companyDir: string, opts: { now?: number; minAgeMs?: number } = {}): InboxScanOutcome[] {
  const inbox = captureInboxDir(companyDir)
  if (!existsSync(inbox)) return []
  const now = opts.now ?? Date.now()
  const minAge = opts.minAgeMs ?? 1000
  const out: InboxScanOutcome[] = []
  for (const name of readdirSync(inbox).sort()) {
    if (skip(name)) continue
    const full = join(inbox, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (!st.isFile() || now - st.mtimeMs < minAge) continue
    const processed = join(inbox, 'processed')
    const failed = join(inbox, 'failed')
    mkdirSync(processed, { recursive: true })
    mkdirSync(failed, { recursive: true })
    const fail = (reason: string): void => {
      const dest = join(failed, cleanName(name))
      renameSync(full, dest)
      writeFileSync(`${dest}.reason.txt`, `${reason}\n`)
      out.push({ file: name, ok: false, detail: reason, movedTo: dest })
    }
    try {
      const bytes = readFileSync(full)
      const r = runAsAuditUser(CAPTURE_INBOX_USER, () => addCaptureFile(db, captureFilesDir(companyDir), { name, bytes, origin: 'folder', addedBy: CAPTURE_INBOX_USER }))
      if (r.refusal || !r.item) fail(r.refusal ?? 'not captured')
      else {
        const dest = join(processed, `${stamp()}-${cleanName(name)}`)
        renameSync(full, dest)
        out.push({ file: name, ok: true, detail: `queued as capture item #${r.item.id}`, movedTo: dest })
      }
    } catch (err) {
      try {
        fail((err as Error).message)
      } catch {
        /* moved away meanwhile */
      }
    }
  }
  return out
}

let watcher: FSWatcher | null = null
let watched: string | null = null
let timer: NodeJS.Timeout | null = null

/** Watch the open company's capture inbox (null = stop). One initial scan picks up files dropped
 *  while the app was closed. `onQueued` lets the app refresh / notify. */
export function syncCaptureWatcher(company: { slug: string; db: DB; dir: string } | null, onQueued?: (n: number) => void): void {
  if (watcher && (!company || company.slug !== watched)) {
    watcher.close()
    watcher = null
    watched = null
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
      try {
        const res = scanCaptureInbox(company.db, company.dir)
        if (res.length) {
          log('info', 'capture-inbox-scan', { queued: res.filter((r) => r.ok).length, failed: res.filter((r) => !r.ok).length })
          onQueued?.(res.filter((r) => r.ok).length)
        }
        // A file still being written is retried shortly.
        if (readdirSync(inbox).some((n) => !skip(n) && statSync(join(inbox, n)).isFile())) scan()
      } catch (err) {
        log('warn', 'capture-inbox-scan-failed', { error: err instanceof Error ? err.message : String(err) })
      }
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
