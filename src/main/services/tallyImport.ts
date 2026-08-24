import type { DB } from '../db/connection'
import { parseTallyExport, type TallyImport, type TallyVoucher } from '@shared/tally'
import { GST_STATES } from '@shared/gst/states'
import { voucherFingerprint } from '@shared/importKey'
import { saveVoucher, NOT_DELETED } from './vouchers'
import { writeAudit } from './audit'
import type { VoucherKind } from '@shared/domain'

export interface ImportSummary {
  groups: number
  ledgers: number
  units: number
  items: number
  vouchers: number
  skipped: number
  /** Vouchers that were already in these books from an earlier import of the same entries
   *  (roadmap O #297). Counted separately from `skipped`: nothing went wrong. */
  duplicates: number
  warnings: string[]
  /** True when the user pressed Cancel and the whole import was rolled back. */
  cancelled?: boolean
}

/** Map a Tally voucher-type name to one of our kinds. */
function kindForName(name: string): VoucherKind {
  const n = name.toLowerCase()
  if (n.includes('contra')) return 'contra'
  if (n.includes('payment')) return 'payment'
  if (n.includes('receipt')) return 'receipt'
  if (n.includes('credit note')) return 'credit_note'
  if (n.includes('debit note')) return 'debit_note'
  if (n.includes('sales')) return 'sales'
  if (n.includes('purchase')) return 'purchase'
  if (n.includes('stock')) return 'stock_journal'
  return 'journal'
}

function stateCodeFromName(stateName: string | null): string | null {
  if (!stateName) return null
  const entry = Object.entries(GST_STATES).find(([, name]) => name.toLowerCase() === stateName.trim().toLowerCase())
  return entry ? entry[0] : null
}

const emptyCounts = (): Omit<ImportSummary, 'warnings'> => ({
  groups: 0, ledgers: 0, units: 0, items: 0, vouchers: 0, skipped: 0, duplicates: 0
})

/** Parse-only sibling of importTallyXml: reads what the file contains without touching the
 *  database at all — no ledger/group lookups (which would run against whatever company happens
 *  to be open), so a dry run always sees the same counts for the same file. Used by the wizard's
 *  Preview step; `skipped` is always 0 here since nothing is attempted against a live company. */
export function dryRunTallyXml(xml: string): ImportSummary {
  const data: TallyImport = parseTallyExport(xml)
  return {
    groups: data.groups.length,
    ledgers: data.ledgers.length,
    units: data.units.length,
    items: data.items.length,
    vouchers: data.vouchers.length,
    skipped: 0,
    duplicates: 0,
    warnings: [...data.warnings]
  }
}

// ---------- the dry-run diff (roadmap O #296) ----------

export interface DiffLine {
  label: string
  create: number
  /** Already present under the same name — the import leaves it alone. */
  exists: number
}

export interface ImportDiff {
  masters: DiffLine[]
  vouchers: {
    create: number
    /** Already in these books from an earlier import of the same entries — will not be repeated. */
    duplicate: number
    /** Cannot be created: a ledger the file never defines. Masters-first fixes most of these. */
    blocked: number
  }
  /** Up to 20 examples of what would be created, so the counts can be checked against a name. */
  samples: { kind: string; label: string }[]
  warnings: string[]
}

const DIFF_SAMPLE_CAP = 20

/**
 * What an import would do to THIS company, without doing it.
 *
 * The counts on the preview screen used to be counts of what was in the file, which answers "did
 * it parse" — a question nobody migrating their books is asking. This answers the one they are:
 * how much of this is new, how much do I already have, and what will not come across.
 *
 * Read-only by construction: every lookup is a SELECT, and the function never opens a
 * transaction. Run it twice and it says the same thing twice.
 */
export function diffTallyXml(db: DB, xml: string): ImportDiff {
  const data = parseTallyExport(xml)
  const samples: { kind: string; label: string }[] = []
  const sample = (kind: string, label: string): void => {
    if (samples.length < DIFF_SAMPLE_CAP) samples.push({ kind, label })
  }

  const exists = (table: string, name: string, extra = ''): boolean =>
    db.prepare(`SELECT 1 FROM ${table} WHERE name = ? COLLATE NOCASE ${extra} LIMIT 1`).get(name) !== undefined

  const count = (
    label: string,
    names: string[],
    present: (name: string) => boolean,
    kind: string
  ): DiffLine => {
    let create = 0
    let already = 0
    // A file that lists the same master twice must not be counted as two creations.
    const seen = new Set<string>()
    for (const name of names) {
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      if (present(name)) already++
      else {
        create++
        sample(kind, name)
      }
    }
    return { label, create, exists: already }
  }

  const masters: DiffLine[] = [
    count('Groups', data.groups.map((g) => g.name), (n) => exists('groups', n), 'Group'),
    count('Ledgers', data.ledgers.map((l) => l.name), (n) => exists('ledgers', n), 'Ledger'),
    count(
      'Units',
      data.units.map((u) => u.name),
      (n) => db.prepare('SELECT 1 FROM units WHERE name = ? COLLATE NOCASE OR symbol = ? COLLATE NOCASE LIMIT 1').get(n, n) !== undefined,
      'Unit'
    ),
    count('Stock items', data.items.map((i) => i.name), (n) => exists('stock_items', n), 'Item')
  ]

  // Ledgers the file itself introduces count as available: masters are applied before vouchers
  // in the same run, so a voucher naming a ledger from this very file is not blocked.
  const availableLedgers = new Set(data.ledgers.map((l) => l.name.toLowerCase()))
  const ledgerPresent = (name: string): boolean =>
    availableLedgers.has(name.toLowerCase()) || exists('ledgers', name)

  let create = 0
  let duplicate = 0
  let blocked = 0
  for (const v of data.vouchers) {
    if (v.lines.some((l) => !ledgerPresent(l.ledger))) {
      blocked++
      continue
    }
    if (alreadyImported(db, v)) {
      duplicate++
      continue
    }
    create++
    sample('Voucher', `${v.vchType || 'Journal'} ${v.number || v.date}`)
  }

  return { masters, vouchers: { create, duplicate, blocked }, samples, warnings: [...data.warnings] }
}

/**
 * Has this exact voucher already been imported into these books?
 *
 * Filtered on `deleted_at IS NULL` on purpose, and this is the whole reason `import_key` is
 * indexed rather than made UNIQUE: a voucher that was imported and then deliberately binned must
 * be importable again. The bin is a decision, and refusing to honour it would leave the user
 * unable to undo an import except by deleting the company.
 */
function alreadyImported(db: DB, v: TallyVoucher): boolean {
  const key = voucherFingerprint(v)
  return (
    db.prepare(`SELECT 1 FROM vouchers v WHERE v.import_key = ? AND ${NOT_DELETED} LIMIT 1`).get(key) !== undefined
  )
}

/** Apply a parsed Tally export to the open company. Idempotent-ish: existing names are reused,
 *  not duplicated, and a voucher already imported from an earlier file is recognised by its
 *  fingerprint and skipped rather than doubled. The whole apply runs in ONE transaction (task Q1
 *  #94) — a hard failure partway through rolls back every master and voucher written so far,
 *  never leaving a half-imported company. Per-voucher validation failures are still soft
 *  (skipped + warned). A single summary audit row records the counts. */
export function importTallyXml(db: DB, xml: string): ImportSummary {
  // Parse outside the transaction — a malformed file fails before any write is attempted.
  const data: TallyImport = parseTallyExport(xml)
  const run = db.transaction((): ImportSummary => {
    const warnings = [...data.warnings]
    const counts = emptyCounts()
    applyMasters(db, data, counts, warnings)
    applyVouchers(db, data.vouchers, counts, warnings)
    const summary = { ...counts, warnings }
    auditImport(db, summary)
    return summary
  })
  return run()
}

export interface ImportProgress {
  /** Vouchers processed so far (created + duplicate + skipped). */
  done: number
  total: number
  phase: 'masters' | 'vouchers'
}

export interface StreamingHooks {
  onProgress?: (progress: ImportProgress) => void
  /** Polled between chunks. Returning true rolls the whole import back. */
  isCancelled?: () => boolean
}

/** Vouchers applied between two yields to the event loop. Small enough that Cancel feels
 *  immediate on a slow machine, large enough that the yielding is not the cost of the import. */
const CHUNK = 25

/**
 * The same import, reported on and interruptible (roadmap O #300).
 *
 * A three-year Day Book export takes a minute, and the app currently does it behind a frozen
 * button. Two things are needed: progress, and a way out — and the way out has to leave the books
 * exactly as they were, not half-imported.
 *
 * That dictates the shape. `db.transaction()` cannot span an `await`, so the transaction is
 * opened by hand and the loop yields to the event loop between chunks; the yield is what lets
 * main service the `tally:cancel` IPC at all (the main process is single-threaded, so a
 * synchronous loop would simply never see the click). Cancel is then one ROLLBACK: everything or
 * nothing, which is the only honest answer to "stop" halfway through a set of books.
 */
export async function importTallyXmlStreaming(db: DB, xml: string, hooks: StreamingHooks = {}): Promise<ImportSummary> {
  const data: TallyImport = parseTallyExport(xml)
  const warnings = [...data.warnings]
  const counts = emptyCounts()
  const total = data.vouchers.length

  db.exec('BEGIN')
  try {
    hooks.onProgress?.({ done: 0, total, phase: 'masters' })
    applyMasters(db, data, counts, warnings)

    for (let i = 0; i < data.vouchers.length; i += CHUNK) {
      applyVouchers(db, data.vouchers.slice(i, i + CHUNK), counts, warnings)
      const done = Math.min(i + CHUNK, total)
      hooks.onProgress?.({ done, total, phase: 'vouchers' })
      // Hand the event loop back so the cancel click can arrive, then ask.
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (hooks.isCancelled?.()) {
        db.exec('ROLLBACK')
        return { ...emptyCounts(), warnings: [], cancelled: true }
      }
    }

    const summary = { ...counts, warnings }
    auditImport(db, summary)
    db.exec('COMMIT')
    hooks.onProgress?.({ done: total, total, phase: 'vouchers' })
    return summary
  } catch (err) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw err
  }
}

function auditImport(db: DB, summary: ImportSummary): void {
  writeAudit(db, 'tally_import', 0, 'import', null, {
    groups: summary.groups,
    ledgers: summary.ledgers,
    units: summary.units,
    items: summary.items,
    vouchers: summary.vouchers,
    skipped: summary.skipped,
    duplicates: summary.duplicates,
    warnings: summary.warnings.length
  })
}

type Counts = Omit<ImportSummary, 'warnings'>

function applyMasters(db: DB, data: TallyImport, counts: Counts, warnings: string[]): void {
  const groupId = (name: string): number | null => {
    const row = db.prepare('SELECT id FROM groups WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined
    return row?.id ?? null
  }

  // Groups first — parents may arrive in any order, so loop until stable.
  let pending = [...data.groups]
  for (let pass = 0; pass < 10 && pending.length; pass++) {
    const next: typeof pending = []
    for (const g of pending) {
      if (groupId(g.name)) continue
      const parentId = g.parent ? groupId(g.parent) : null
      if (g.parent && !parentId) {
        next.push(g)
        continue
      }
      const parent = parentId
        ? (db.prepare('SELECT nature, affects_gross_profit FROM groups WHERE id = ?').get(parentId) as { nature: string; affects_gross_profit: number })
        : { nature: 'asset', affects_gross_profit: 0 }
      db.prepare('INSERT INTO groups (name, parent_id, nature, affects_gross_profit, is_system) VALUES (?, ?, ?, ?, 0)')
        .run(g.name, parentId, parent.nature, parent.affects_gross_profit)
      counts.groups++
    }
    pending = next
  }
  for (const g of pending) warnings.push(`Group "${g.name}" skipped: parent "${g.parent}" not found`)

  // Units
  for (const u of data.units) {
    const exists = db.prepare('SELECT id FROM units WHERE name = ? COLLATE NOCASE OR symbol = ? COLLATE NOCASE').get(u.name, u.name)
    if (exists) continue
    db.prepare('INSERT INTO units (name, symbol, decimals, uqc) VALUES (?, ?, ?, ?)').run(u.name, u.name, u.decimals, 'OTH')
    counts.units++
  }

  // Ledgers
  const suspense = groupId('Suspense A/c')!
  for (const l of data.ledgers) {
    const exists = db.prepare('SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE').get(l.name)
    if (exists) continue
    const gid = groupId(l.parent) ?? suspense
    if (!groupId(l.parent)) warnings.push(`Ledger "${l.name}": group "${l.parent}" not found, placed under Suspense A/c`)
    db.prepare(
      'INSERT INTO ledgers (name, group_id, opening_balance, gstin, state_code, is_system) VALUES (?, ?, ?, ?, ?, 0)'
    ).run(l.name, gid, l.opening, l.gstin, stateCodeFromName(l.stateName))
    counts.ledgers++
  }

  // Stock items
  const defaultUnit = (db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number } | undefined)?.id
  for (const item of data.items) {
    const exists = db.prepare('SELECT id FROM stock_items WHERE name = ? COLLATE NOCASE').get(item.name)
    if (exists) continue
    const unit = db.prepare('SELECT id FROM units WHERE name = ? COLLATE NOCASE OR symbol = ? COLLATE NOCASE').get(item.unit, item.unit) as { id: number } | undefined
    if (!unit && !defaultUnit) {
      warnings.push(`Item "${item.name}" skipped: no unit`)
      continue
    }
    db.prepare(
      'INSERT INTO stock_items (name, unit_id, hsn, gst_rate, opening_qty_milli, opening_value) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(item.name, unit?.id ?? defaultUnit, item.hsn, item.gstRate, item.openingQtyMilli, item.openingValue)
    counts.items++
  }
}

function applyVouchers(db: DB, vouchers: TallyVoucher[], counts: Counts, warnings: string[]): void {
  const ledgerId = (name: string): number | null => {
    const row = db.prepare('SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined
    return row?.id ?? null
  }
  const itemId = (name: string): number | null => {
    const row = db.prepare('SELECT id FROM stock_items WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined
    return row?.id ?? null
  }
  const typeIdFor = (vchType: string): { id: number; kind: VoucherKind } => {
    const existing = db.prepare('SELECT id, kind FROM voucher_types WHERE name = ? COLLATE NOCASE').get(vchType) as
      | { id: number; kind: VoucherKind }
      | undefined
    if (existing) return existing
    const kind = kindForName(vchType)
    const res = db.prepare("INSERT INTO voucher_types (name, kind, numbering, prefix, is_system) VALUES (?, ?, 'manual', '', 0)")
      .run(vchType, kind)
    return { id: Number(res.lastInsertRowid), kind }
  }

  for (const v of vouchers) {
    // Before anything else: have we already got this one? Checked here rather than in the
    // preview alone, because the file the user finally imports is not always the file they
    // previewed, and the second import is exactly when this matters.
    if (alreadyImported(db, v)) {
      counts.duplicates++
      continue
    }
    const missing = v.lines.filter((l) => !ledgerId(l.ledger))
    if (missing.length) {
      warnings.push(`Voucher ${v.number || v.date} skipped: unknown ledger "${missing[0]!.ledger}" (import masters first)`)
      counts.skipped++
      continue
    }
    const vt = typeIdFor(v.vchType || 'Journal')
    const goodsIn = vt.kind === 'purchase' || vt.kind === 'credit_note'
    try {
      const saved = saveVoucher(db, {
        voucherTypeId: vt.id,
        date: v.date,
        number: v.number || undefined,
        partyLedgerId: v.party ? ledgerId(v.party) : null,
        narration: v.narration,
        reference: null,
        instrumentNo: null,
        instrumentDate: null,
        transporterId: null,
        vehicleNo: null,
        transportDistanceKm: null,
        currencyCode: null,
        exchangeRate: null,
        lines: v.lines.map((l) => ({ ledgerId: ledgerId(l.ledger)!, drCr: l.drCr, amount: l.amount, costAllocations: [] })),
        inventory: v.inventory
          .filter((inv) => itemId(inv.item))
          .map((inv) => ({
            stockItemId: itemId(inv.item)!,
            godownId: null,
            qtyMilli: inv.qtyMilli,
            ratePaise: inv.qtyMilli > 0 ? Math.round((inv.amount * 1000) / inv.qtyMilli) : 0,
            amount: inv.amount,
            direction: goodsIn ? ('in' as const) : ('out' as const)
          })),
        billRefs: [],
        tds: null
      })
      // Stamped after the save rather than passed through it: the fingerprint is a fact about
      // where the voucher came from, not part of what a voucher is, and saveVoucher stays the
      // single description of the latter.
      db.prepare('UPDATE vouchers SET import_key = ? WHERE id = ?').run(voucherFingerprint(v), saved.id)
      counts.vouchers++
    } catch (err) {
      warnings.push(`Voucher ${v.number || v.date} skipped: ${(err as Error).message}`)
      counts.skipped++
    }
  }
}
