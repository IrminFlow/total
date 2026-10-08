/**
 * Agent access layer (lane A): CSV/JSON mirrors of the books under `<company>/agent/`, plus the
 * validated `<company>/inbox/` drop-folder for external agents (Claude Code, Codex, ...).
 *
 * WP 5.7: the MCP server (`total-cli mcp`, src/main/mcp/) is now the way agents read the books
 * and propose entries, and the inbox follows the same read/draft rule — a voucher drop becomes a
 * flagged DRAFT for the user to review (ai/inboxDrafts.ts); it is no longer posted. The old
 * posting path survives only behind `total-cli inbox --legacy-inbox-post` (deprecated), where it
 * still goes through the UI's code path: zod `voucherInputSchema` → `saveVoucher` (validateVoucher
 * + the period lock). The mirrors are unchanged; buildMirrorFiles also feeds the MCP resources.
 * Reads are recomputed from voucher_lines at export time, never denormalised.
 *
 * Concurrency: the app and the CLI may have the same company.db open at once — WAL journal mode
 * + busy_timeout (set in db/connection.ts) make that safe; nothing here takes exclusive locks.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from 'fs'
import { basename, extname, join } from 'path'
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
import { inboxDraftProposal, insertInboxDrafts } from '../ai/inboxDrafts'
import { log } from '../log'

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

/** FY label for a voucher date, e.g. '2025-26' for anything in FY 2025-04-01..2026-03-31. */
function fyLabel(date: string): string {
  const startYear = Number(fyOf(date).from.slice(0, 4))
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`
}

export interface MirrorFile {
  name: string
  mimeType: 'text/csv' | 'application/json'
  content: string
}

/** Applied to every TEXT value of a mirror, with the field it sits in (names, GSTINs, narrations —
 *  never amounts, which stay integers): identity for the on-disk mirror; field-aware masking /
 *  pseudonymisation (mcp/mask.ts) when the MCP server serves the same files. */
export type MirrorTextTransform = (s: string, key: string | null) => string

const identity: MirrorTextTransform = (s) => s

function mapJsonStrings(value: unknown, fn: MirrorTextTransform, key: string | null = null): unknown {
  if (typeof value === 'string') return fn(value, key)
  if (Array.isArray(value)) return value.map((v) => mapJsonStrings(v, fn, key))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = mapJsonStrings(v, fn, k)
    return out
  }
  return value
}

/**
 * Build the read mirror in memory:
 *   ledgers.csv, ledgers.json, items.csv, vouchers-<FY>.json, trial-balance.json,
 *   outstandings.json, meta.json (schema version + generated-at + voucher types).
 * Amounts are integer paise, quantities integer milli-units — lossless, same as the DB.
 * `exportMirror` writes these under `<company>/agent/`; the MCP server serves them as resources
 * straight from here (computed at request time, never read back from the files).
 */
export function buildMirrorFiles(db: DB, slug: string, opts: MirrorOptions = {}, text: MirrorTextTransform = identity): MirrorFile[] {
  const what = opts.what ?? 'all'
  const format = opts.format ?? 'all'
  const files: MirrorFile[] = []
  const csv = (name: string, content: string): void => {
    files.push({ name, mimeType: 'text/csv', content })
  }
  const json = (name: string, value: unknown): void => {
    files.push({ name, mimeType: 'application/json', content: JSON.stringify(text === identity ? value : mapJsonStrings(value, text), null, 2) })
  }
  const t = (s: string, key: string): string => (s ? text(s, key) : s)
  const wantCsv = format !== 'json'
  const wantJson = format !== 'csv'
  const asOn = opts.to ?? todayISO()

  if (what === 'masters' || what === 'all') {
    const groups = new Map(masters.listGroups(db).map((g) => [g.id, g.name]))
    const ledgers = masters.listLedgers(db).map((l) => ({ ...l, groupName: groups.get(l.groupId) ?? '' }))
    if (wantCsv) {
      csv(
        'ledgers.csv',
        rowsToCsv(
          ['id', 'name', 'group', 'opening_balance_paise', 'gstin', 'state_code', 'hsn', 'gst_rate', 'credit_days'],
          ledgers.map((l) => [
            String(l.id), t(l.name, 'name'), t(l.groupName, 'group'), String(l.openingBalance),
            t(l.gstin ?? '', 'gstin'), l.stateCode ?? '', l.hsn ?? '',
            l.gstRate === null ? '' : String(l.gstRate),
            l.creditDays === null ? '' : String(l.creditDays)
          ])
        )
      )
    }
    if (wantJson) json('ledgers.json', ledgers)
    if (wantCsv) {
      const units = new Map(masters.listUnits(db).map((u) => [u.id, u.symbol]))
      const stockGroups = new Map(masters.listStockGroups(db).map((g) => [g.id, g.name]))
      csv(
        'items.csv',
        rowsToCsv(
          ['id', 'name', 'group', 'unit', 'hsn', 'gst_rate', 'opening_qty_milli', 'opening_value_paise'],
          masters.listStockItems(db).map((i) => [
            String(i.id), t(i.name, 'name'), i.groupId === null ? '' : t(stockGroups.get(i.groupId) ?? '', 'group'),
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
    for (const [label, vouchersOfFy] of byFy) json(`vouchers-${label}.json`, vouchersOfFy)
  }

  if ((what === 'reports' || what === 'all') && wantJson) {
    json('trial-balance.json', { asOn, ...trialBalance(db, asOn) })
    json('outstandings.json', { asOn, receivable: outstandings(db, 'receivable', asOn), payable: outstandings(db, 'payable', asOn) })
  }

  const voucherTypes = masters.listVoucherTypes(db)
  json('meta.json', {
    schemaVersion: MIRROR_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    company: slug,
    amountsUnit: 'paise (integer, 100 paise = 1 rupee)',
    quantitiesUnit: 'milli-units (integer, 1000 = 1 unit)',
    voucherTypes,
    files: files.map((f) => f.name)
  })
  return files
}

/** FY labels ('2025-26') that have vouchers in the books — one vouchers-<FY>.json each. */
export function mirrorVoucherYears(db: DB): string[] {
  const rows = db.prepare(`SELECT DISTINCT v.date FROM vouchers v WHERE ${NOT_DELETED} ORDER BY v.date`).all() as { date: string }[]
  return [...new Set(rows.map((r) => fyLabel(r.date)))]
}

/** Regenerate the read mirror under `<company>/agent/` (see buildMirrorFiles). */
export function exportMirror(db: DB, slug: string, opts: MirrorOptions = {}): MirrorResult {
  const dir = agentDir(slug)
  mkdirSync(dir, { recursive: true })
  const files = buildMirrorFiles(db, slug, opts)
  for (const f of files) writeFileSync(join(dir, f.name), f.content)
  return { dir, files: files.map((f) => f.name) }
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
  /** processed: the drafts created (or, legacy, voucher ids posted / masters created+updated).
   *  failed: the error message. */
  detail: string
  movedTo: string
}

export interface InboxOptions {
  /** Deprecated pre-0.9 behaviour: POST voucher drops and import masters CSVs instead of making
   *  drafts. Only `total-cli inbox --legacy-inbox-post` sets it; the app's watcher never does. */
  legacyPost?: boolean
}

export const LEGACY_INBOX_WARNING =
  'DEPRECATED: --legacy-inbox-post posts inbox drops straight into the books. The inbox now turns drops into drafts for review ' +
  '(and agents should use `total-cli mcp`); this flag will be removed in a later release.'

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
 * Validate one dropped file, then move it to `inbox/processed/<ts>-<file>` on success or
 * `inbox/failed/<file>` (+ `<file>.error.txt`) on failure.
 *
 * Default (WP 5.7 — the inbox supersedes nothing into the books any more): a `*.json` voucher drop
 * (single object or array) becomes DRAFTS — one ai_drafts row per voucher, source 'inbox',
 * flagged `unrequested`, checked exactly like the assistant's draft_voucher — that the user
 * reviews and saves in the voucher editor (Settings → Agent access lists them). Nothing is
 * posted. A `*.csv` masters drop is refused (use Settings → Data import).
 *
 * `legacyPost` (only `total-cli inbox --legacy-inbox-post`, deprecated): the pre-0.9 behaviour —
 * `*.json` vouchers are POSTED via saveVoucher and `*.csv` masters (ledgers/items, sniffed from
 * the header) are imported.
 *
 * Every mode is atomic per file — any bad voucher or bad CSV row rolls back the entire drop, so
 * a failure report always truthfully means "nothing was applied". All writes are audited as user
 * 'agent-inbox'.
 *
 * Concurrent writers: agents that write the drop in place (no temp-file-then-rename) can be read
 * mid-write. When the content doesn't parse, the file is re-read after a short pause for as long
 * as it keeps changing (bounded) — a static malformed file costs exactly one extra read.
 */
export function processInboxFile(db: DB, slug: string, filePath: string, opts: InboxOptions = {}): InboxOutcome {
  const legacyPost = opts.legacyPost === true
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
  const succeed = (detail: string, title = 'Total — inbox file processed'): InboxOutcome => {
    const dest = join(processedDir, `${stamp()}-${name}`)
    renameSync(filePath, dest)
    notify(title, `${name}: ${detail.slice(0, 180)}`)
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
      if (!legacyPost) {
        // Drafts, never postings: every voucher is validated as a draft proposal first, then all
        // drafts are written in one transaction — one bad voucher refuses the whole file.
        const today = todayISO()
        const proposals = items.map((item, i) => {
          try {
            return inboxDraftProposal(db, voucherInputSchema.parse(item), today)
          } catch (err) {
            throw new Error(`voucher ${i + 1}: ${zodOrErrorMessage(err)}`)
          }
        })
        const drafts = runAsAuditUser('agent-inbox', () => db.transaction(() => insertInboxDrafts(db, name, proposals))())
        return succeed(
          `drafted ${drafts.length} voucher(s) for review — nothing posted: ${drafts.map((d) => `draft #${d.id}`).join(', ')}`,
          'Total — inbox file turned into drafts'
        )
      }
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
      if (!legacyPost) {
        return fail(
          'Masters CSV drops are no longer imported from the inbox — nothing was applied. Import masters in Settings → Data import ' +
            '(preview + undo), or run `total-cli inbox --legacy-inbox-post` (deprecated) to import them the old way.'
        )
      }
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
    return fail(zodOrErrorMessage(err))
  }
}

/** A ZodError flattened into readable "path: message" lines; any other error's message. */
function zodOrErrorMessage(err: unknown): string {
  return err && typeof err === 'object' && 'issues' in err
    ? (err as { issues: { path: (string | number)[]; message: string }[] }).issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    : err instanceof Error
      ? err.message
      : String(err)
}

/** Process every pending `*.json`/`*.csv` sitting directly in the inbox (not subfolders). */
export function scanInbox(db: DB, slug: string, opts: InboxOptions = {}): InboxOutcome[] {
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
    outcomes.push(processInboxFile(db, slug, full, opts))
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
