/**
 * Agent access layer (lane A): CSV/JSON mirrors of the books under `<company>/agent/`, plus the
 * validated `<company>/inbox/` drop-folder that lets external agents (Claude Code, Codex, ...)
 * prepare inert voucher proposals and import explicitly supported master CSVs without touching
 * SQLite directly.
 *
 * Voucher JSON never posts from the drop folder. It is schema-checked and placed in the same
 * human review queue as MCP/AI drafts. Posting happens only after an authenticated approval and
 * the ordinary permission, department, discount and maker-checker gates. Reads are recomputed
 * from voucher_lines at export time, never denormalised.
 *
 * Concurrency: the app and the CLI may have the same company.db open at once — WAL journal mode
 * + busy_timeout (set in db/connection.ts) make that safe; nothing here takes exclusive locks.
 */
import {
  existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, watch, writeFileSync, type Dirent, type FSWatcher
} from 'fs'
import { basename, extname, isAbsolute, join, relative, sep } from 'path'
import { createHash, randomUUID } from 'crypto'
import { Notification } from 'electron'
import type { DB } from '../db/connection'
import { companyDir } from '../paths'
import { rowsToCsv } from '@shared/csv'
import { fyOf, todayISO } from '@shared/dates'
import { voucherInputSchema } from '@shared/schemas'
import type { VoucherInputParsed } from '@shared/schemas'
import type { Voucher, VoucherKind } from '@shared/domain'
import { validateVoucher, type LedgerFacts } from '@shared/posting'
import * as masters from './masters'
import { trialBalance } from './reports'
import { outstandings } from './analysis'
import { getVoucher, NOT_DELETED } from './vouchers'
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

const INBOX_BATCH_ID = /^inbox-[a-f0-9]{64}$/
const INBOX_PROPOSAL_ID = /^(inbox-[a-f0-9]{64})--(\d{4})\.json$/
const MAX_LISTED_PROPOSALS = 200
const MAX_BATCH_DIRECTORIES_SCANNED = 200
const MAX_STAGING_DIRECTORIES_SCANNED = 200
const MAX_LIST_DIRECTORY_ENTRIES_SCANNED = 400
const STALE_STAGING_MS = 24 * 60 * 60 * 1000

function assertPathContained(root: string, target: string): void {
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Proposal path escapes company storage')
  }
}

function secureProposalRoot(slug: string, create = false): { path: string; real: string } {
  const company = companyDir(slug)
  const companyEntry = lstatSync(company)
  if (companyEntry.isSymbolicLink() || !companyEntry.isDirectory()) {
    throw new Error('Company storage is not a regular directory')
  }
  const companyReal = realpathSync(company)
  const root = proposalsDir(slug)
  if (!existsSync(root)) {
    if (!create) throw new Error('Proposal storage does not exist')
    mkdirSync(root, { mode: 0o700 })
  }
  const rootEntry = lstatSync(root)
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error('Proposal storage is not a regular directory')
  }
  const rootReal = realpathSync(root)
  assertPathContained(companyReal, rootReal)
  return { path: root, real: rootReal }
}

function secureProposalDirectory(
  slug: string,
  segments: string[],
  create = false
): { path: string; rootReal: string } {
  const root = secureProposalRoot(slug, create)
  let current = root.path
  for (const segment of segments) {
    if (!/^[a-zA-Z0-9._-]+$/.test(segment)) throw new Error('Invalid proposal directory')
    current = join(current, segment)
    assertPathContained(root.path, current)
    if (!existsSync(current)) {
      if (!create) throw new Error('Proposal directory does not exist')
      mkdirSync(current, { mode: 0o700 })
    }
    const entry = lstatSync(current)
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error('Proposal directory is not a regular directory')
    }
    assertPathContained(root.real, realpathSync(current))
  }
  return { path: current, rootReal: root.real }
}

function assertSecureProposalFile(path: string, rootReal: string): void {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('Proposal is not a regular file')
  assertPathContained(rootReal, realpathSync(path))
}

function proposalLocation(slug: string, file: string): { path: string; rootReal: string } {
  const name = safeProposalName(file)
  const batch = INBOX_PROPOSAL_ID.exec(name)
  if (batch) {
    const parent = secureProposalDirectory(slug, ['queued', batch[1]!])
    return { path: join(parent.path, `${batch[2]}.json`), rootReal: parent.rootReal }
  }
  const root = secureProposalRoot(slug)
  return { path: join(root.path, name), rootReal: root.real }
}

export function createProposal(slug: string, source: AgentProposal['source'], summary: string, voucher: unknown): AgentProposal {
  const dir = secureProposalRoot(slug, true)
  const createdAt = new Date().toISOString()
  const id = `${createdAt.replace(/[:.]/g, '-')}-${randomUUID()}.json`
  const proposal: AgentProposal = { version: 1, id, createdAt, source, status: 'pending', summary: summary.slice(0, 240), voucher }
  writeFileSync(join(dir.path, id), JSON.stringify(proposal, null, 2), { flag: 'wx', mode: 0o600 })
  return proposal
}

function safeProposalName(file: string): string {
  const name = basename(file)
  if (name !== file || !/^[a-zA-Z0-9._-]+\.json$/.test(name)) throw new Error('Invalid proposal name')
  return name
}

function readProposal(slug: string, file: string): { proposal: AgentProposal; sha256: string } {
  const name = safeProposalName(file)
  const location = proposalLocation(slug, name)
  const path = location.path
  if (!existsSync(path)) throw new Error('Proposal no longer exists')
  assertSecureProposalFile(path, location.rootReal)
  if (statSync(path).size > 512 * 1024) throw new Error('Proposal is too large')
  const text = readFileSync(path, 'utf8')
  const parsed = JSON.parse(text) as AgentProposal
  if (parsed.version !== 1 || parsed.status !== 'pending' || !parsed.voucher) throw new Error('Invalid proposal')
  return {
    proposal: { ...parsed, id: name },
    sha256: createHash('sha256').update(text).digest('hex')
  }
}

export function getProposal(slug: string, file: string): AgentProposal {
  return readProposal(slug, file).proposal
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

function boundedDirectoryEntries(path: string, limit: number): Dirent[] {
  const entries: Dirent[] = []
  const directory = opendirSync(path)
  try {
    while (entries.length < limit) {
      const entry = directory.readSync()
      if (!entry) break
      entries.push(entry)
    }
  } finally {
    directory.closeSync()
  }
  return entries
}

function pruneStaleProposalStages(slug: string, now = Date.now()): void {
  const root = secureProposalRoot(slug)
  const stagingPath = join(root.path, '.staging')
  if (!existsSync(stagingPath)) return
  const staging = secureProposalDirectory(slug, ['.staging'])
  for (const entry of boundedDirectoryEntries(staging.path, MAX_STAGING_DIRECTORIES_SCANNED)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const path = join(staging.path, entry.name)
    const first = lstatSync(path)
    if (first.isSymbolicLink() || !first.isDirectory() || now - first.mtimeMs < STALE_STAGING_MS) continue
    const secured = secureProposalDirectory(slug, ['.staging', entry.name])
    const latest = lstatSync(secured.path)
    if (latest.isSymbolicLink() || !latest.isDirectory() || now - latest.mtimeMs < STALE_STAGING_MS) continue
    rmSync(secured.path, { recursive: true })
  }
}

/** Read-only listing of reviewable agent drafts. Nothing in proposals/ affects the books. */
export function listProposals(slug: string): AgentProposal[] {
  const rootPath = proposalsDir(slug)
  if (!existsSync(rootPath)) return []
  const root = secureProposalRoot(slug)
  pruneStaleProposalStages(slug)
  const candidates: { path: string; id: string; rootReal: string }[] = []
  let entryBudget = MAX_LIST_DIRECTORY_ENTRIES_SCANNED
  const rootEntries = boundedDirectoryEntries(root.path, Math.min(entryBudget, MAX_LISTED_PROPOSALS * 2))
  entryBudget -= rootEntries.length
  for (const entry of rootEntries) {
    if (candidates.length >= Math.floor(MAX_LISTED_PROPOSALS / 2)) break
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue
    candidates.push({ path: join(root.path, entry.name), id: entry.name, rootReal: root.real })
  }
  const queuedPath = join(root.path, 'queued')
  if (existsSync(queuedPath) && candidates.length < MAX_LISTED_PROPOSALS && entryBudget > 0) {
    const queued = secureProposalDirectory(slug, ['queued'])
    let batchesScanned = 0
    const batchEntries = boundedDirectoryEntries(
      queued.path,
      Math.min(entryBudget, MAX_BATCH_DIRECTORIES_SCANNED)
    )
    entryBudget -= batchEntries.length
    for (const batchEntry of batchEntries) {
      if (candidates.length >= MAX_LISTED_PROPOSALS) break
      if (!batchEntry.isDirectory() || batchEntry.isSymbolicLink() || !INBOX_BATCH_ID.test(batchEntry.name)) continue
      batchesScanned++
      if (batchesScanned > MAX_BATCH_DIRECTORIES_SCANNED) break
      const batch = secureProposalDirectory(slug, ['queued', batchEntry.name])
      const remaining = MAX_LISTED_PROPOSALS - candidates.length
      if (entryBudget <= 0) break
      const files = boundedDirectoryEntries(
        batch.path,
        Math.min(entryBudget, remaining * 2, MAX_LISTED_PROPOSALS)
      )
      entryBudget -= files.length
      for (const file of files) {
        if (candidates.length >= MAX_LISTED_PROPOSALS) break
        if (!file.isFile() || file.isSymbolicLink() || !/^\d{4}\.json$/.test(file.name)) continue
        candidates.push({
          path: join(batch.path, file.name),
          id: `${batchEntry.name}--${file.name}`,
          rootReal: batch.rootReal
        })
      }
    }
  }
  return candidates
    .flatMap(({ path, id, rootReal }) => {
      try {
        assertSecureProposalFile(path, rootReal)
        if (statSync(path).size > 512 * 1024) return []
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as AgentProposal
        if (
          parsed.version !== 1 || parsed.status !== 'pending' || !parsed.id || !parsed.voucher ||
          !isIsoInstant(parsed.createdAt)
        ) return []
        return [{ ...parsed, id }]
      } catch {
        return []
      }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, 200)
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
  actor: VoucherPostingActor | null,
  authorize?: (input: VoucherInputParsed) => void,
  hooks: { beforeArchiveMove?: () => void } = {}
): ControlledVoucherPostResult {
  const name = safeProposalName(file)
  const location = proposalLocation(slug, name)
  const path = location.path
  // Validate/create the archive destination before any accounting write. A symlink here must
  // never turn a successful review into an external move after the DB transaction commits.
  const reviewed = secureProposalDirectory(slug, ['reviewed'], true)
  const resultRow = db.prepare(
    `SELECT proposal_sha256 AS proposalSha256,proposal_json AS proposalJson,result_kind AS resultKind,
            result_id AS resultId,result_json AS resultJson
     FROM agent_proposal_results WHERE proposal_id=?`
  )
  type ResultRow = {
    proposalSha256: string
    proposalJson: string
    resultKind: 'voucher' | 'approval_request'
    resultId: number
    resultJson: string
  }
  const decodeResult = (row: ResultRow): ControlledVoucherPostResult => {
    const result = JSON.parse(row.resultJson) as ControlledVoucherPostResult
    const identity = result.approvalRequired ? result.request.id : result.id
    const kind = result.approvalRequired ? 'approval_request' : 'voucher'
    if (identity !== row.resultId || kind !== row.resultKind) {
      throw new Error('Stored proposal result is inconsistent')
    }
    return result
  }
  const archive = (): void => {
    if (!existsSync(path)) return
    assertSecureProposalFile(path, location.rootReal)
    const destination = join(reviewed.path, `${stamp()}-${randomUUID()}-${name}`)
    hooks.beforeArchiveMove?.()
    renameSync(path, destination)
    assertSecureProposalFile(destination, reviewed.rootReal)
  }

  const previous = resultRow.get(name) as ResultRow | undefined
  if (previous) {
    authorize?.(voucherInputSchema.parse(JSON.parse(previous.proposalJson)))
    if (existsSync(path)) {
      const pending = readProposal(slug, name)
      if (pending.sha256 !== previous.proposalSha256) {
        throw new Error('Proposal content changed after it was processed')
      }
      // The accounting result is already durable. Archival is housekeeping on a replay and must
      // not turn a successful, idempotent retry into another apparent posting failure.
      try {
        archive()
      } catch (error) {
        log('warn', 'agent-proposal-archive-retry-failed', {
          slug,
          proposalId: name,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return decodeResult(previous)
  }

  const { proposal, sha256 } = readProposal(slug, name)
  const input = voucherInputSchema.parse(proposal.voucher)
  authorize?.(input)
  assertVoucherDiscountAuthority(db, input, actor)
  const saved = runAsAuditUser(`agent-${proposal.source}`, () =>
    db.transaction(() => {
      // Recheck under the write transaction so two near-simultaneous approvals share one result.
      const concurrent = resultRow.get(name) as ResultRow | undefined
      if (concurrent) {
        if (concurrent.proposalSha256 !== sha256) {
          throw new Error('Proposal content changed while it was being processed')
        }
        return decodeResult(concurrent)
      }
      const result = postVoucherWithApprovalControl(db, input, actor)
      const resultKind = result.approvalRequired ? 'approval_request' : 'voucher'
      const resultId = result.approvalRequired ? result.request.id : result.id
      db.prepare(
        `INSERT INTO agent_proposal_results
         (proposal_id,proposal_sha256,proposal_json,result_kind,result_id,result_json)
         VALUES(?,?,?,?,?,?)`
      ).run(name, sha256, JSON.stringify(input), resultKind, resultId, JSON.stringify(result))
      return result
    })()
  )
  // Deliberately after the DB commit. If this fails, the durable result above makes every retry
  // return the same voucher/request rather than posting again.
  archive()
  return saved
}

export function discardProposal(
  slug: string,
  file: string,
  authorize?: (proposal: AgentProposal) => void
): void {
  const proposal = getProposal(slug, file)
  authorize?.(proposal)
  const name = proposal.id
  const location = proposalLocation(slug, name)
  assertSecureProposalFile(location.path, location.rootReal)
  rmSync(location.path)
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

/** Pure posting validation for inert proposals. It catches unbalanced/invalid accounting drafts
 * without allocating a voucher number, touching period state, or calling saveVoucher. */
function validateInertVoucher(db: DB, input: VoucherInputParsed): void {
  const voucherType = db.prepare('SELECT kind FROM voucher_types WHERE id=?').get(input.voucherTypeId) as
    | { kind: VoucherKind }
    | undefined
  if (!voucherType) throw new Error('Voucher type not found')
  const cashBankGroups = masters.cashBankGroupIds(db)
  const ledger = db.prepare('SELECT group_id AS groupId FROM ledgers WHERE id=?')
  const cache = new Map<number, LedgerFacts>()
  const facts = (id: number): LedgerFacts => {
    const known = cache.get(id)
    if (known) return known
    const row = ledger.get(id) as { groupId: number } | undefined
    const resolved = { exists: !!row, isCashOrBank: !!row && cashBankGroups.has(row.groupId) }
    cache.set(id, resolved)
    return resolved
  }
  const errors = validateVoucher(input, voucherType.kind, facts)
  if (errors.length > 0) throw new Error(errors.map((error) => error.message).join('; '))
}

interface InboxProposalBatchHooks {
  /** @internal Deterministic filesystem-failure injection used by DB tests. */
  beforeStageWrite?: (index: number) => void
  /** @internal Simulates a source-file move failure after a batch is durably promoted. */
  beforeSourceMove?: () => void
}

/**
 * Materialise one JSON drop as a content-and-file-identity-addressed proposal batch. Files are
 * invisible under a hidden staging directory until one atomic directory rename exposes the
 * complete batch. The deterministic destination doubles as a durable completion marker: a retry after promotion
 * reuses the batch even if the source drop could not yet be moved to processed/.
 */
function createInboxProposalBatch(
  slug: string,
  sourcePath: string,
  sourceText: string,
  inputs: VoucherInputParsed[],
  hooks: InboxProposalBatchHooks
): number {
  if (inputs.length > 9999) throw new Error('A voucher proposal batch cannot exceed 9,999 entries')
  const sourceSha256 = createHash('sha256').update(sourceText).digest('hex')
  const sourceStat = statSync(sourcePath)
  // Bind idempotency to this physical drop as well as its bytes. Retrying the same file reuses
  // the batch, while a genuinely new file with intentionally identical vouchers remains valid.
  const dropFingerprint = createHash('sha256')
    .update(sourceSha256)
    .update(`:${sourceStat.dev}:${sourceStat.ino}:${sourceStat.birthtimeMs}:${sourceStat.size}`)
    .digest('hex')
  const batchId = `inbox-${dropFingerprint}`
  secureProposalRoot(slug, true)
  const queued = secureProposalDirectory(slug, ['queued'], true)
  const destination = join(queued.path, batchId)
  const manifestName = '.manifest.json'
  const expectedManifest = { version: 1, sourceSha256, count: inputs.length }
  const verifyExisting = (): number => {
    const batch = secureProposalDirectory(slug, ['queued', batchId])
    const manifest = join(batch.path, manifestName)
    assertSecureProposalFile(manifest, batch.rootReal)
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as typeof expectedManifest
    if (parsed.version !== 1 || parsed.sourceSha256 !== sourceSha256 || parsed.count !== inputs.length) {
      throw new Error('Existing inbox proposal batch is inconsistent')
    }
    return parsed.count
  }

  if (existsSync(destination)) return verifyExisting()

  const stagingRoot = secureProposalDirectory(slug, ['.staging'], true)
  const stagingName = `${batchId}-${randomUUID()}`
  const staging = join(stagingRoot.path, stagingName)
  mkdirSync(staging, { mode: 0o700 })
  secureProposalDirectory(slug, ['.staging', stagingName])
  const removeOwnStaging = (): void => {
    if (!existsSync(staging)) return
    const secured = secureProposalDirectory(slug, ['.staging', stagingName])
    rmSync(secured.path, { recursive: true })
  }
  try {
    const createdAt = new Date().toISOString()
    for (let index = 0; index < inputs.length; index++) {
      hooks.beforeStageWrite?.(index)
      const file = `${String(index + 1).padStart(4, '0')}.json`
      const id = `${batchId}--${file}`
      const proposal: AgentProposal = {
        version: 1,
        id,
        createdAt,
        source: 'external',
        status: 'pending',
        summary: `Inbox voucher proposal${inputs.length > 1 ? ` ${index + 1}/${inputs.length}` : ''} · ${inputs[index]!.date}`,
        voucher: inputs[index]
      }
      writeFileSync(join(staging, file), JSON.stringify(proposal, null, 2), { flag: 'wx', mode: 0o600 })
    }
    writeFileSync(join(staging, manifestName), JSON.stringify(expectedManifest), { flag: 'wx', mode: 0o600 })
    try {
      renameSync(staging, destination)
      secureProposalDirectory(slug, ['queued', batchId])
    } catch (error) {
      // Another process may have promoted the same drop batch first. Its manifest
      // is authoritative; otherwise preserve the original promotion failure.
      if (existsSync(destination)) {
        removeOwnStaging()
        return verifyExisting()
      }
      throw error
    }
    return inputs.length
  } catch (error) {
    // Only this invocation's UUID-scoped staging tree is removed. No earlier or unrelated
    // proposal can be touched, and a partially written batch was never visible to reviewers.
    removeOwnStaging()
    throw error
  }
}

/**
 * Validate one dropped file, then move it to `inbox/processed/<ts>-<file>` on success or
 * `inbox/failed/<file>` (+ `<file>.error.txt`) on failure. `*.json` = inert voucher proposal
 * (single object or array); `*.csv` = masters import (ledgers/items, sniffed from the header).
 * JSON never changes the books. CSV applies atomically per file and is audited as agent-inbox.
 *
 * Concurrent writers: agents that write the drop in place (no temp-file-then-rename) can be read
 * mid-write. When the content doesn't parse, the file is re-read after a short pause for as long
 * as it keeps changing (bounded) — a static malformed file costs exactly one extra read.
 */
export function processInboxFile(
  db: DB,
  slug: string,
  filePath: string,
  proposalBatchHooks: InboxProposalBatchHooks = {}
): InboxOutcome {
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
    proposalBatchHooks.beforeSourceMove?.()
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
      // Validate the complete file before creating any proposal, so one malformed member leaves
      // the review queue unchanged. Approval is a separate authenticated action.
      const inputs = items.map((item) => voucherInputSchema.parse(item))
      for (const input of inputs) validateInertVoucher(db, input)
      const proposalCount = createInboxProposalBatch(slug, filePath, text, inputs, proposalBatchHooks)
      return succeed(`queued ${proposalCount} voucher proposal(s) for review`)
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
