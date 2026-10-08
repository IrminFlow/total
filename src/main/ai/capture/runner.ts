// WP 5.4 — processing the capture queue: ONE item at a time, per company, cancellable.
//
//   queued     → the user saw the cost estimate and pressed Process → pending
//   pending    → processing (extract: one provider call) → drafted | needs_review | duplicate | failed
//   needs_review → the user answers the questions → drafted (no further provider call)
//   drafted    → the draft is saved in the editor → saved (the file becomes the voucher attachment)
//
// The queue lives in capture_items, so it survives a restart (recoverQueue puts an interrupted
// 'processing' item back to 'pending'). Stop aborts the call in flight and returns every approved
// item to 'queued' (approve again to resume). Nothing is sent while AI is off or the notice is not
// accepted — items simply wait.
import type { DB } from '../../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { AiSettings } from '@shared/ai'
import type { BillExtraction } from '@shared/capture/schema'
import { parseExtraction } from '@shared/capture/parse'
import { runAsAuditUser } from '../../services/audit'
import { AiAbortError, type AiProvider } from '../types'
import { redactSecrets } from '../provider'
import { readCaptureFile } from './files'
import { prepareDocument, type ImageConverter } from './prepare'
import { extractBill } from './extract'
import { draftFromBill, type BillDraftOutcome } from './billDraft'
import { getItem, nextPending, patchItem, type CaptureItemRow } from './store'

export interface CaptureEnv {
  db: DB
  company: CompanyInfo
  slug: string
  filesDir: string
  provider: () => AiProvider
  settings: () => AiSettings
  /** Why nothing may be sent right now (AI off, notice, no key), or null. */
  blocker: () => string | null
  images: ImageConverter
  today: () => string
  /** Called after each item changes (the renderer polls; tests count). */
  onChange?: (item: CaptureItemRow) => void
}

/** Apply a bill → draft outcome to the item (audited). */
export function applyOutcome(db: DB, id: number, o: BillDraftOutcome, extra: { costMicroUsd?: number | null; extractionJson?: string } = {}): CaptureItemRow {
  const p = o.review?.parsed
  const base = {
    ...(extra.extractionJson !== undefined ? { extractionJson: extra.extractionJson } : {}),
    ...(extra.costMicroUsd !== undefined ? { costMicroUsd: extra.costMicroUsd } : {}),
    review: o.review,
    supplierName: p?.supplierName ?? null,
    supplierLedgerId: o.supplierLedgerId,
    invoiceNo: p?.invoiceNo ?? null,
    invoiceDate: p?.date ?? null,
    total: p?.total ?? o.review?.totals.computedTotal ?? null
  }
  switch (o.status) {
    case 'drafted':
      return patchItem(db, id, { ...base, status: 'drafted', error: null, draftId: o.draft.id, duplicateKind: o.duplicate ? 'same_amount' : null, duplicateVoucherId: o.duplicate?.voucherId ?? null }, true)
    case 'duplicate':
      return patchItem(db, id, { ...base, status: 'duplicate', error: o.duplicate.why, duplicateKind: 'same_invoice', duplicateVoucherId: o.duplicate.voucherId ?? null, draftId: null }, true)
    case 'needs_review':
      return patchItem(db, id, { ...base, status: 'needs_review', error: null }, true)
    default:
      return patchItem(db, id, { ...base, status: 'failed', error: o.error }, true)
  }
}

/** Re-run bill → draft on the stored extraction (after the user answered the questions). */
export function redraft(env: Pick<CaptureEnv, 'db' | 'company' | 'today'>, id: number, user: string | null): CaptureItemRow {
  const it = getItem(env.db, id)
  if (!it) throw new Error('Capture item not found')
  if (!it.extractionJson) throw new Error('This file has not been read yet')
  if (it.status === 'drafted' || it.status === 'saved') throw new Error(`This file is already ${it.status}`)
  const extraction = JSON.parse(it.extractionJson) as BillExtraction
  const run = (): CaptureItemRow => {
    const outcome = draftFromBill({
      db: env.db, company: env.company, item: { id, fileName: it.fileName }, parsed: parseExtraction(extraction, env.today()), mode: it.review?.mode ?? 'text',
      mapping: it.mapping ?? {}, today: env.today()
    })
    return applyOutcome(env.db, id, outcome)
  }
  return user ? runAsAuditUser(user, run) : run()
}

type Run = { controller: AbortController; item: { id: number; controller: AbortController } | null; done: Promise<void> }

export class CaptureRunner {
  private readonly runs = new Map<string, Run>()

  isRunning(slug: string): boolean {
    return this.runs.has(slug)
  }

  /** Start working the approved items, unless already running or blocked. */
  kick(env: CaptureEnv): boolean {
    if (this.runs.has(env.slug) || env.blocker() !== null || !nextPending(env.db)) return false
    const run: Run = { controller: new AbortController(), item: null, done: Promise.resolve() }
    this.runs.set(env.slug, run)
    run.done = this.loop(env, run).finally(() => {
      if (this.runs.get(env.slug) === run) this.runs.delete(env.slug)
    })
    return true
  }

  /** Resolves when the current run (if any) has finished. */
  async idle(slug: string): Promise<void> {
    await this.runs.get(slug)?.done
  }

  /** Stop: abort the call in flight; the in-flight and approved items go back to 'queued'. */
  stop(slug: string, db: DB | null): void {
    this.runs.get(slug)?.controller.abort()
    if (db) {
      try {
        db.prepare("UPDATE capture_items SET status = 'queued', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status IN ('pending', 'processing')").run()
      } catch {
        /* the handle is closing */
      }
    }
  }

  /** Per-item cancel: abort the call only when `id` is the item in flight (the caller marks it
   *  cancelled); the run goes on with the next approved item. */
  cancelCurrent(slug: string, id: number): boolean {
    const r = this.runs.get(slug)
    if (!r?.item || r.item.id !== id) return false
    r.item.controller.abort()
    return true
  }

  stopAll(): void {
    for (const r of this.runs.values()) r.controller.abort()
    this.runs.clear()
  }

  private async loop(env: CaptureEnv, run: Run): Promise<void> {
    for (;;) {
      if (run.controller.signal.aborted || env.blocker() !== null) return
      let next: CaptureItemRow | null
      try {
        next = nextPending(env.db)
      } catch {
        return // company closed
      }
      if (!next) return
      const item = { id: next.id, controller: new AbortController() }
      const onStop = (): void => item.controller.abort()
      run.controller.signal.addEventListener('abort', onStop, { once: true })
      run.item = item
      const user = next.approvedBy ?? 'capture'
      try {
        await this.processOne(env, next, item.controller.signal, user)
      } catch (err) {
        if (run.controller.signal.aborted) return // stop() already put the items back to 'queued'
        if (item.controller.signal.aborted || err instanceof AiAbortError) continue // cancelled: marked by the caller
        try {
          const msg = redactSecrets(err instanceof Error ? err.message : String(err))
          const failed = runAsAuditUser(user, () => patchItem(env.db, item.id, { status: 'failed', error: msg }, true))
          env.onChange?.(failed)
        } catch {
          return
        }
      } finally {
        run.controller.signal.removeEventListener('abort', onStop)
        run.item = null
      }
    }
  }

  private async processOne(env: CaptureEnv, item: CaptureItemRow, signal: AbortSignal, user: string): Promise<void> {
    const db = env.db
    runAsAuditUser(user, () => patchItem(db, item.id, { status: 'processing', attempts: item.attempts + 1, error: null }, false))
    const bytes = readCaptureFile(env.filesDir, item.storedPath, item.sha256)
    const doc = prepareDocument(bytes, item.mime, item.fileName, env.images)
    const res = await extractBill(
      { db, provider: env.provider(), settings: env.settings(), today: env.today(), companyGstin: env.company.gstin ?? null, signal },
      doc,
      item.fileName
    )
    if (signal.aborted) throw new AiAbortError()
    const current = getItem(db, item.id)
    if (!current || current.status !== 'processing') return // cancelled or removed meanwhile
    const cost = res.costMicroUsd == null ? item.costMicroUsd : (item.costMicroUsd ?? 0) + res.costMicroUsd
    const outcome = runAsAuditUser(user, () =>
      draftFromBill({ db, company: env.company, item: { id: item.id, fileName: item.fileName }, parsed: res.parsed, mode: doc.mode, mapping: current.mapping ?? {}, today: env.today() })
    )
    // (Evaluated first: an optional call `f?.(x)` skips evaluating x when f is absent.)
    const done = runAsAuditUser(user, () => applyOutcome(db, item.id, outcome, { costMicroUsd: cost, extractionJson: JSON.stringify(res.extraction) }))
    env.onChange?.(done)
  }
}

export const captureRunner = new CaptureRunner()
