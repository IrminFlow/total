/**
 * Agent access layer (lane A): CSV/JSON mirrors of the books under `<company>/agent/`, plus the
 * validated `<company>/inbox/` drop-folder that lets external agents (Claude Code, Codex, ...)
 * post vouchers and masters without touching SQLite directly.
 *
 * Every write goes through the exact same code path as the UI: zod `voucherInputSchema` →
 * `saveVoucher` (which runs `validateVoucher` + the period lock) — the inbox/CLI can never post
 * anything the voucher screen would reject. Reads are recomputed from voucher_lines at export
 * time, never denormalised.
 *
 * Concurrency: the app and the CLI may have the same company.db open at once — WAL journal mode
 * + busy_timeout (set in db/connection.ts) make that safe; nothing here takes exclusive locks.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'fs'
import { basename, extname, join } from 'path'
import { randomUUID } from 'crypto'
import { Notification } from 'electron'
import type { DB } from '../db/connection'
import { companyDir } from '../paths'
import { rowsToCsv } from '@shared/csv'
import { fyOf, todayISO } from '@shared/dates'
import { voucherInputSchema } from '@shared/schemas'
import type { Voucher } from '@shared/domain'
import * as masters from './masters'
import { trialBalance } from './reports'
import { outstandings } from './analysis'
import { getVoucher, saveVoucher, NOT_DELETED } from './vouchers'
import { applyImport, type ImportKind, type ImportResult } from './importers'
import { runAsAuditUser } from './audit'
import { log } from '../log'
import {
  assertVoucherDiscountAuthority,
  postVoucherWithApprovalControl,
  type ControlledVoucherPostResult,
  type VoucherPostingActor
} from './voucherPostingControls'

/** Bumped whenever the mirror file shapes change incompatibly; stamped into meta.json. */
export const MIRROR_SCHEMA_VERSION = 1

export type MirrorWhat = 'masters' | 'vouchers' | 'reports' | 'all'
export type MirrorFormat = 'csv' | 'json' | 'all'

export interface MirrorOptions {
  what?: MirrorWhat
  format?: MirrorFormat
  /** Optional voucher date bounds (inclusive); reports use `to` (default today) as their as-on. */
  from?: string
  to?: string
}

export interface MirrorResult {
  dir: string
  files: string[]
}

export function agentDir(slug: string): string {
  return join(companyDir(slug), 'agent')
}

export function inboxDir(slug: string): string {
  return join(companyDir(slug), 'inbox')
}

export interface AgentProposal {
  version: 1
  id: string
  createdAt: string
  source: 'mcp' | 'ai' | 'external'
  status: 'pending'
  summary: string
  voucher: unknown
}

function proposalsDir(slug: string): string {
  return join(companyDir(slug), 'proposals')
}

export function createProposal(slug: string, source: AgentProposal['source'], summary: string, voucher: unknown): AgentProposal {
  const dir = proposalsDir(slug)
  mkdirSync(dir, { recursive: true })
  const createdAt = new Date().toISOString()
  const id = `${createdAt.replace(/[:.]/g, '-')}-${randomUUID()}.json`
  const proposal: AgentProposal = { version: 1, id, createdAt, source, status: 'pending', summary: summary.slice(0, 240), voucher }
  writeFileSync(join(dir, id), JSON.stringify(proposal, null, 2), { flag: 'wx', mode: 0o600 })
  return proposal
}

function safeProposalName(file: string): string {
  const name = basename(file)
  if (name !== file || !/^[a-zA-Z0-9._-]+\.json$/.test(name)) throw new Error('Invalid proposal name')
  return name
}

/** Read-only listing of reviewable agent drafts. Nothing in proposals/ affects the books. */
export function listProposals(slug: string): AgentProposal[] {
  const dir = proposalsDir(slug)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, 200)
    .flatMap((name) => {
      try {
        if (statSync(join(dir, name)).size > 512 * 1024) return []
        const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as AgentProposal
        if (parsed.version !== 1 || parsed.status !== 'pending' || !parsed.id || !parsed.voucher) return []
        return [{ ...parsed, id: name }]
      } catch {
        return []
      }
    })
}

/**
 * A proposal review is still subject to the company's posting controls. An approval click can
 * therefore be refused by discount authority or routed into maker-checker instead of silently
 * becoming a back door around the ordinary voucher screen.
 */
export function approveProposal(
  db: DB,
  slug: string,
  file: string,
  actor: VoucherPostingActor | null
): ControlledVoucherPostResult {
  const name = safeProposalName(file)
  const dir = proposalsDir(slug)
  const path = join(dir, name)
  if (!existsSync(path)) throw new Error('Proposal no longer exists')
  if (statSync(path).size > 512 * 1024) throw new Error('Proposal is too large')
  const proposal = JSON.parse(readFileSync(path, 'utf8')) as AgentProposal
  if (proposal.version !== 1 || proposal.status !== 'pending') throw new Error('Invalid proposal')
  const input = voucherInputSchema.parse(proposal.voucher)
  assertVoucherDiscountAuthority(db, input, actor)
  const saved = runAsAuditUser(`agent-${proposal.source}`, () =>
    db.transaction(() => postVoucherWithApprovalControl(db, input, actor))()
  )
  const reviewed = join(dir, 'reviewed')
  mkdirSync(reviewed, { recursive: true })
  renameSync(path, join(reviewed, `${stamp()}-${name}`))
  return saved
}

export function discardProposal(slug: string, file: string): void {
  const name = safeProposalName(file)
  const path = join(proposalsDir(slug), name)
  if (!existsSync(path)) throw new Error('Proposal no longer exists')
  rmSync(path)
}

/** FY label for a voucher date, e.g. '2025-26' for anything in FY 2025-04-01..2026-03-31. */
function fyLabel(date: string): string {
  const startYear = Number(fyOf(date).from.slice(0, 4))
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`
}

/**
 * Regenerate the read mirror under `<company>/agent/`:
 *   ledgers.csv, ledgers.json, items.csv, vouchers-<FY>.json, trial-balance.json,
 *   outstandings.json, meta.json (schema version + generated-at + voucher types).
 * Amounts are integer paise, quantities integer milli-units — lossless, same as the DB.
 */
export function exportMirror(db: DB, slug: string, opts: MirrorOptions = {}): MirrorResult {
  const what = opts.what ?? 'all'
  const format = opts.format ?? 'all'
  const dir = agentDir(slug)
  mkdirSync(dir, { recursive: true })
  const files: string[] = []
  const writeOut = (name: string, content: string): void => {
    writeFileSync(join(dir, name), content)
    files.push(name)
  }
  const wantCsv = format !== 'json'
  const wantJson = format !== 'csv'
  const asOn = opts.to ?? todayISO()

  if (what === 'masters' || what === 'all') {
    const groups = new Map(masters.listGroups(db).map((g) => [g.id, g.name]))
    const ledgers = masters.listLedgers(db).map((l) => ({ ...l, groupName: groups.get(l.groupId) ?? '' }))
    if (wantCsv) {
      writeOut(
        'ledgers.csv',
        rowsToCsv(
          ['id', 'name', 'group', 'opening_balance_paise', 'gstin', 'state_code', 'hsn', 'gst_rate', 'credit_days'],
          ledgers.map((l) => [
            String(l.id), l.name, l.groupName, String(l.openingBalance),
            l.gstin ?? '', l.stateCode ?? '', l.hsn ?? '',
            l.gstRate === null ? '' : String(l.gstRate),
            l.creditDays === null ? '' : String(l.creditDays)
          ])
        )
      )
    }
    if (wantJson) writeOut('ledgers.json', JSON.stringify(ledgers, null, 2))
    if (wantCsv) {
      const units = new Map(masters.listUnits(db).map((u) => [u.id, u.symbol]))
      const stockGroups = new Map(masters.listStockGroups(db).map((g) => [g.id, g.name]))
      writeOut(
        'items.csv',
        rowsToCsv(
          ['id', 'name', 'group', 'unit', 'hsn', 'gst_rate', 'opening_qty_milli', 'opening_value_paise'],
          masters.listStockItems(db).map((i) => [
            String(i.id), i.name, i.groupId === null ? '' : (stockGroups.get(i.groupId) ?? ''),
            units.get(i.unitId) ?? '', i.hsn ?? '',
            i.gstRate === null ? '' : String(i.gstRate),
            String(i.openingQtyMilli), String(i.openingValue)
          ])
        )
      )
    }
  }

  if ((what === 'vouchers' || what === 'all') && wantJson) {
    const conds = [NOT_DELETED]
    const params: string[] = []
    if (opts.from) { conds.push('v.date >= ?'); params.push(opts.from) }
    if (opts.to) { conds.push('v.date <= ?'); params.push(opts.to) }
    const rows = db
      .prepare(`SELECT v.id, v.date FROM vouchers v WHERE ${conds.join(' AND ')} ORDER BY v.date, v.id`)
      .all(...params) as { id: number; date: string }[]
    const byFy = new Map<string, Voucher[]>()
    for (const r of rows) {
      const label = fyLabel(r.date)
      const list = byFy.get(label) ?? []
      const v = getVoucher(db, r.id)
      if (v) list.push(v)
      byFy.set(label, list)
    }
    for (const [label, vouchersOfFy] of byFy) {
      writeOut(`vouchers-${label}.json`, JSON.stringify(vouchersOfFy, null, 2))
    }
  }

  if ((what === 'reports' || what === 'all') && wantJson) {
    writeOut('trial-balance.json', JSON.stringify({ asOn, ...trialBalance(db, asOn) }, null, 2))
    writeOut(
      'outstandings.json',
      JSON.stringify(
        { asOn, receivable: outstandings(db, 'receivable', asOn), payable: outstandings(db, 'payable', asOn) },
        null,
        2
      )
    )
  }

  const voucherTypes = masters.listVoucherTypes(db)
  writeOut(
    'meta.json',
    JSON.stringify(
      {
        schemaVersion: MIRROR_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        company: slug,
        amountsUnit: 'paise (integer, 100 paise = 1 rupee)',
        quantitiesUnit: 'milli-units (integer, 1000 = 1 unit)',
        voucherTypes,
        files
      },
      null,
      2
    )
  )
  return { dir, files }
}

// ---------- debounced auto-refresh after saveVoucher (feature-flag gated in ipc.ts) ----------

let refreshTimer: NodeJS.Timeout | null = null

/** Regenerate the mirror 30s after the last voucher save — bursts of entry collapse to one export. */
export function scheduleMirrorRefresh(db: DB, slug: string, delayMs = 30_000): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    try {
      exportMirror(db, slug)
    } catch (err) {
      log('warn', 'agent-mirror-refresh-failed', { slug, error: err instanceof Error ? err.message : String(err) })
    }
  }, delayMs)
  // Never keep the process alive just for a pending mirror refresh.
  refreshTimer.unref?.()
}

export function cancelMirrorRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

// ---------- inbox: validated drop-folder for agent writes ----------

export interface InboxOutcome {
  file: string
  ok: boolean
  /** processed: voucher ids posted / masters created+updated. failed: the error message. */
  detail: string
  movedTo: string
}

function notify(title: string, body: string): void {
  try {
    // Under the CLI / tests `electron` resolves to the binary-path string, so Notification is
    // undefined — guard rather than crash. Notifications are best-effort everywhere.
    if (typeof Notification === 'function' && Notification.isSupported()) {
      new Notification({ title, body }).show()
    }
  } catch {
    /* best-effort */
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** Masters CSV kind sniffing: an items CSV has a Unit column, a ledgers CSV an Opening Balance. */
function sniffCsvKind(headerLine: string): ImportKind | null {
  const cols = headerLine.toLowerCase()
  if (cols.includes('unit')) return 'items'
  if (cols.includes('opening balance') || cols.includes('gstin') || cols.includes('group')) return 'ledgers'
  return null
}

/** Inbox drops larger than this are rejected outright — a runaway agent must not be able to
 *  block/OOM the single-threaded main process with a giant readFileSync + JSON.parse. */
export const MAX_INBOX_FILE_BYTES = 5 * 1024 * 1024
const REREAD_DELAY_MS = 250
const MAX_REREADS = 5

/** Synchronous sleep (Node allows Atomics.wait on the main thread) — used only on the rare
 *  parse-failure path while waiting out a writer that is still streaming the dropped file. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Thrown inside the CSV transaction to roll the whole import back while keeping the row-error
 *  report — the inbox contract is all-or-nothing per file (unlike the UI's preview-then-apply
 *  Data Import screen, which deliberately skips bad rows). */
class CsvRowErrors extends Error {
  constructor(readonly result: ImportResult) {
    super('csv row errors')
  }
}

/**
 * Validate + apply one dropped file, then move it to `inbox/processed/<ts>-<file>` on success or
 * `inbox/failed/<file>` (+ `<file>.error.txt`) on failure. `*.json` = voucher input (single object
 * or array); `*.csv` = masters import (ledgers/items, sniffed from the header). BOTH kinds apply
 * atomically per file — any bad voucher or bad CSV row rolls back the entire drop, so a failure
 * report always truthfully means "nothing was applied". All writes are audited as user
 * 'agent-inbox' and run through the same validation/period-lock path as the UI.
 *
 * Concurrent writers: agents that write the drop in place (no temp-file-then-rename) can be read
 * mid-write. When the content doesn't parse, the file is re-read after a short pause for as long
 * as it keeps changing (bounded) — a static malformed file costs exactly one extra read.
 */
export function processInboxFile(db: DB, slug: string, filePath: string): InboxOutcome {
  const inbox = inboxDir(slug)
  const name = basename(filePath)
  const processedDir = join(inbox, 'processed')
  const failedDir = join(inbox, 'failed')
  mkdirSync(processedDir, { recursive: true })
  mkdirSync(failedDir, { recursive: true })

  const fail = (error: string): InboxOutcome => {
    const dest = join(failedDir, name)
    renameSync(filePath, dest)
    writeFileSync(join(failedDir, `${name}.error.txt`), `${error}\n`)
    notify('Total — inbox file rejected', `${name}: ${error.slice(0, 180)}`)
    return { file: name, ok: false, detail: error, movedTo: dest }
  }
  const succeed = (detail: string): InboxOutcome => {
    const dest = join(processedDir, `${stamp()}-${name}`)
    renameSync(filePath, dest)
    notify('Total — inbox file processed', `${name}: ${detail.slice(0, 180)}`)
    return { file: name, ok: true, detail, movedTo: dest }
  }

  const overCap = (bytes: number): InboxOutcome =>
    fail(
      `File is ${(bytes / (1024 * 1024)).toFixed(1)} MB — the inbox caps drops at 5 MB. ` +
        'Split the file into smaller batches. Nothing was applied.'
    )

  let text: string
  try {
    const bytes = statSync(filePath).size
    if (bytes > MAX_INBOX_FILE_BYTES) return overCap(bytes)
    text = readFileSync(filePath, 'utf8')
  } catch (err) {
    return { file: name, ok: false, detail: err instanceof Error ? err.message : String(err), movedTo: filePath }
  }

  /** Re-read after a pause; null = give up (file unchanged/gone/over cap — caller reports on
   *  the content it already has). Tolerates writers still streaming the drop in place. */
  const reread = (): string | null => {
    sleepMs(REREAD_DELAY_MS)
    try {
      if (statSync(filePath).size > MAX_INBOX_FILE_BYTES) return null
      const next = readFileSync(filePath, 'utf8')
      return next === text ? null : next
    } catch {
      return null
    }
  }

  const ext = extname(name).toLowerCase()
  try {
    if (ext === '.json') {
      let parsed: unknown
      for (let attempt = 0; ; attempt++) {
        try {
          parsed = JSON.parse(text)
          break
        } catch (err) {
          const next = attempt < MAX_REREADS ? reread() : null
          if (next === null) throw err // static (or gone/over-cap) file — genuinely malformed
          text = next
        }
      }
      const items = Array.isArray(parsed) ? parsed : [parsed]
      if (items.length === 0) return fail('Empty voucher array')
      // All-or-nothing per file: saveVoucher's own transaction nests as a savepoint inside this
      // one, so a failure on voucher 3 of 5 rolls back 1-2 as well — no half-applied drops.
      const posted = runAsAuditUser('agent-inbox', () =>
        db.transaction(() =>
          items.map((item) => {
            const input = voucherInputSchema.parse(item)
            return saveVoucher(db, input)
          })
        )()
      )
      return succeed(`posted ${posted.length} voucher(s): ${posted.map((v) => `#${v.number} (id ${v.id})`).join(', ')}`)
    }
    if (ext === '.csv') {
      for (let attempt = 0; ; attempt++) {
        const kind = sniffCsvKind(text.split('\n')[0] ?? '')
        let result: ImportResult | null = null
        if (kind) {
          // All-or-nothing, same contract as the JSON path (v0.3 review F3): applyImport's own
          // transaction nests as a savepoint inside this one, so ANY row error rolls back every
          // row — the failure report below is truthful when it says nothing was applied.
          try {
            result = runAsAuditUser('agent-inbox', () =>
              db.transaction((): ImportResult => {
                const r = applyImport(db, kind, text)
                if (r.errors.length > 0) throw new CsvRowErrors(r)
                return r
              })()
            )
          } catch (err) {
            if (!(err instanceof CsvRowErrors)) throw err
            result = err.result
          }
          if (result.errors.length === 0) {
            return succeed(`${kind}: created ${result.created}, updated ${result.updated}`)
          }
        }
        // Bad header or row errors — the writer may still be streaming the file; retry while
        // the content keeps changing, then report on the final content.
        const next = attempt < MAX_REREADS ? reread() : null
        if (next !== null) {
          text = next
          continue
        }
        if (!kind) return fail('Cannot tell whether this CSV is ledgers or items — use the template headers')
        return fail(
          `${kind} import failed — nothing was applied (${result!.errors.length} row error(s), all rows rolled back):\n` +
            result!.errors.map((e) => `line ${e.line}: ${e.message}`).join('\n')
        )
      }
    }
    return fail(`Unsupported file type '${ext}' — drop .json (vouchers) or .csv (masters)`)
  } catch (err) {
    const message =
      err && typeof err === 'object' && 'issues' in err
        ? // ZodError: flatten issues into readable lines.
          (err as { issues: { path: (string | number)[]; message: string }[] }).issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')
        : err instanceof Error
          ? err.message
          : String(err)
    return fail(message)
  }
}

/** Process every pending `*.json`/`*.csv` sitting directly in the inbox (not subfolders). */
export function scanInbox(db: DB, slug: string): InboxOutcome[] {
  const inbox = inboxDir(slug)
  if (!existsSync(inbox)) return []
  const outcomes: InboxOutcome[] = []
  for (const name of readdirSync(inbox).sort()) {
    const full = join(inbox, name)
    let isFile = false
    try {
      isFile = statSync(full).isFile()
    } catch {
      continue // moved/deleted between readdir and stat
    }
    if (!isFile) continue
    const ext = extname(name).toLowerCase()
    if (ext !== '.json' && ext !== '.csv') continue
    outcomes.push(processInboxFile(db, slug, full))
  }
  return outcomes
}

// ---------- fs.watch wiring (feature flag `agentBridge`, default OFF) ----------

let watcher: FSWatcher | null = null
let watchedSlug: string | null = null
let scanTimer: NodeJS.Timeout | null = null
let scanning = false
let rescanQueued = false

function debouncedScan(db: DB, slug: string): void {
  if (scanTimer) clearTimeout(scanTimer)
  scanTimer = setTimeout(() => {
    scanTimer = null
    if (scanning) {
      rescanQueued = true
      return
    }
    scanning = true
    try {
      const outcomes = scanInbox(db, slug)
      if (outcomes.length > 0) {
        log('info', 'agent-inbox-scan', { slug, processed: outcomes.filter((o) => o.ok).length, failed: outcomes.filter((o) => !o.ok).length })
      }
    } catch (err) {
      log('warn', 'agent-inbox-scan-failed', { slug, error: err instanceof Error ? err.message : String(err) })
    } finally {
      scanning = false
      if (rescanQueued) {
        rescanQueued = false
        debouncedScan(db, slug)
      }
    }
  }, 400)
  scanTimer.unref?.()
}

/**
 * Start/stop the inbox watcher to match the current app state. Pass the open company when the
 * `agentBridge` flag is ON; pass null on company close or when the flag is OFF. Also runs one
 * initial scan on start so files dropped while the app was closed are picked up.
 */
export function syncInboxWatcher(company: { slug: string; db: DB } | null): void {
  if (watcher && (!company || company.slug !== watchedSlug)) {
    watcher.close()
    watcher = null
    watchedSlug = null
  }
  if (scanTimer && !company) {
    clearTimeout(scanTimer)
    scanTimer = null
  }
  if (!company) {
    cancelMirrorRefresh()
    return
  }
  if (watcher) return // already watching this company
  const inbox = inboxDir(company.slug)
  mkdirSync(inbox, { recursive: true })
  try {
    watcher = watch(inbox, () => debouncedScan(company.db, company.slug))
    watchedSlug = company.slug
    log('info', 'agent-inbox-watching', { slug: company.slug })
  } catch (err) {
    log('warn', 'agent-inbox-watch-failed', { slug: company.slug, error: err instanceof Error ? err.message : String(err) })
    return
  }
  debouncedScan(company.db, company.slug)
}
