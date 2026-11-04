import type { DB } from '../db/connection'
import { orderLineMoney, parseTallyExport, tallyBaseTypeName, TALLY_ORDER_TYPE, type TallyImport, type TallyLedger, type TallyOrder, type TallyVoucher } from '@shared/tally'
import { GST_STATES } from '@shared/gst/states'
import { fyOf } from '@shared/dates'
import { OPENING_BALANCE_NAME } from '@shared/simple/openings'
import { saveVoucher } from './vouchers'
import { createGodown } from './masters'
import { partyAllocationWithCredits } from './analysis'
import { partySide, replaceOpeningBills, type OpeningBillRow } from './openingBills'
import { booksBeginDay } from './cashFinanceCommon'
import { saveTradeDoc } from './tradeDocs'
import { listTradeDocTypes } from './tradeDocTypes'
import { writeAudit } from './audit'
import { readCompanyInfo, writeCompanyInfo } from '../db/seed'
import type { TradePurpose, VoucherKind } from '@shared/domain'

export interface ImportSummary {
  groups: number
  ledgers: number
  units: number
  items: number
  vouchers: number
  /** Sales / purchase orders imported into trade_docs (WP 6.3). */
  orders: number
  skipped: number
  /** The books-from FY start year the import set on the company (null = left as it was). */
  booksFromSet: number | null
  warnings: string[]
}

/** Tally order voucher types (Sales Order, Purchase Order, Job Work In/Out Order): not books
 *  documents, so never vouchers. The parser hands sales / purchase orders over as `orders`,
 *  which import into trade_docs (WP 6.3, design §8 Q8); job-work orders are skipped. */
export function isOrderTypeName(name: string): boolean {
  return TALLY_ORDER_TYPE.test(name)
}

/** The FY the books start in: the company master's BOOKSFROM when the file has it, else the FY of
 *  the earliest voucher or order in the file. Null when the file has neither. */
export function tallyBooksFromYear(data: TallyImport): number | null {
  if (data.booksFrom) return fyOf(data.booksFrom).startYear
  // Books start with the first real voucher: optional (memorandum) vouchers and orders post nothing.
  const dates = data.vouchers.filter((v) => !v.isOptional).map((v) => v.date).sort()
  return dates[0] ? fyOf(dates[0]).startYear : null
}

/** Map a Tally voucher-type name to one of our kinds. The stock notes are matched FIRST —
 *  "Receipt Note" used to fall into 'receipt' (a cash/bank voucher) and "Delivery Note" into
 *  'journal'. Tally's "Rejections In" is goods back from a customer (a receipt note), "Rejections
 *  Out" goods back to a supplier (a delivery note). Orders never get here (isOrderTypeName). */
export function kindForName(name: string): VoucherKind {
  // Any run of separators reads as one space: "Sales-Return", "SALES_RETURN", "Sales.Return".
  const n = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (n.includes('delivery note') || n.includes('delivery challan')) return 'delivery_note'
  if (n.includes('receipt note') || n.includes('goods receipt')) return 'receipt_note'
  if (n.includes('rejection')) return /\bout\b/.test(n) ? 'delivery_note' : 'receipt_note'
  // Returns before "sales" / "purchase" (a custom "Sales Return" type is a credit note, "Purchase
  // Return" a debit note — Tally's Return Inward / Outward wording too).
  if (/\bsales? ?returns?\b|\breturns? ?inwards?\b/.test(n)) return 'credit_note'
  if (/\bpurchases? ?returns?\b|\breturns? ?outwards?\b/.test(n)) return 'debit_note'
  // Physical Stock before "stock": its lines are counts, not movements.
  if (/\bphysical ?stock\b/.test(n)) return 'physical_stock'
  if (n.includes('contra')) return 'contra'
  if (n.includes('payment')) return 'payment'
  if (n.includes('receipt')) return 'receipt'
  if (n.includes('credit note')) return 'credit_note'
  if (n.includes('debit note')) return 'debit_note'
  if (n.includes('sales')) return 'sales'
  if (n.includes('purchase')) return 'purchase'
  if (n.includes('stock') || n.includes('manufactur')) return 'stock_journal'
  return 'journal'
}

/** The kind of a Tally voucher type: from the predefined type its VOUCHERTYPE master descends from
 *  (PARENT — a custom "Sales Return" made from "Credit Note" is a credit note), else its own name. */
export function kindForTallyType(name: string, data: Pick<TallyImport, 'voucherTypes'>): VoucherKind {
  const base = tallyBaseTypeName(name, data.voucherTypes ?? [])
  // A custom name says more than a generic parent only when the parent says nothing (Journal).
  const fromBase = kindForName(base)
  return fromBase === 'journal' && base.toLowerCase() !== name.toLowerCase() ? kindForName(name) : fromBase
}

/** Bill references from a voucher's bill-wise allocations (BILLALLOCATIONS.LIST) on the party's
 *  ledger entries: New Ref and Advance open a bill / named credit ('new'), Agst Ref settles one
 *  ('against'). They must add up to what the voucher posts to the party; an On Account part (or
 *  allocations that don't add up) can't be held as references, so none are taken and it says so. */
type ImportBillRef = { kind: 'new' | 'against'; name: string; amount: number; dueDate: string | null }

function tallyBillRefs(v: TallyVoucher, party: string | null, warnings: string[]): ImportBillRef[] {
  if (!party) return []
  const partyLines = v.lines.filter((l) => l.ledger.toLowerCase() === party.toLowerCase())
  const allocs = partyLines.flatMap((l) => l.bills ?? [])
  if (allocs.length === 0) return []
  const posted = partyLines.reduce((s, l) => s + l.amount, 0)
  const refs = allocs.filter((b) => b.type !== 'on_account').map((b) => ({
    kind: b.type === 'against' ? ('against' as const) : ('new' as const), name: b.name, amount: b.amount, dueDate: b.type === 'against' ? null : b.dueDate
  }))
  const sum = refs.reduce((s, r) => s + r.amount, 0)
  if (refs.length === 0 || sum !== posted || new Set(partyLines.map((l) => l.drCr)).size > 1) {
    warnings.push(`Voucher ${v.number || v.date}: its bill-wise details (${allocs.map((b) => `${b.type.replace('_', ' ')} ${b.name}`.trim()).join(', ')}) were not imported — ${allocs.some((b) => b.type === 'on_account') ? 'an On Account part' : 'they don\'t add up to the party\'s amount'}; Outstandings settles it oldest first`)
    return []
  }
  return refs
}

/**
 * An Agst Ref must name a bill the party has open when the voucher is imported (the allocation as
 * on the voucher's date: opening bills, bills of vouchers already imported, named credits for a
 * bill drawing on an advance). One that doesn't — the bill isn't in Total (a master without its
 * bill-wise details, a bill from before the file) or is already settled — would be held as
 * unapplied credit, so it settles the party's open bills oldest first instead, as the voucher
 * would without references (spelt out as Agst refs to those bills, so the voucher's other refs
 * stay). When the open bills can't take it all — or a bill draws on an advance that isn't there —
 * the voucher keeps no references at all (oldest first, as before) and it says so.
 */
function settleOnOpenBills(db: DB, partyId: number, partyName: string, v: TallyVoucher, refs: ImportBillRef[], warnings: string[]): ImportBillRef[] {
  if (!refs.some((r) => r.kind === 'against')) return refs
  const groupId = (db.prepare('SELECT group_id FROM ledgers WHERE id = ?').get(partyId) as { group_id: number }).group_id
  // The allocation's sign: a debtor's debit (a creditor's credit) is a bill, the other side settles.
  const side = partySide(db, groupId) ?? -1
  // tallyBillRefs took refs only when every party line is on one side.
  const partyLine = v.lines.find((l) => l.ledger.toLowerCase() === partyName.toLowerCase())
  const settles = side * (partyLine?.drCr === 'dr' ? 1 : -1) < 0
  const alloc = partyAllocationWithCredits(db, partyId, v.date)
  const open = alloc.bills.map((b) => ({ name: b.number, left: b.pending }))
  const credits = new Set(alloc.credits.filter((c) => c.amount > 0).map((c) => c.name))
  const out: ImportBillRef[] = []
  const add = (r: ImportBillRef): void => {
    const same = out.find((o) => o.kind === r.kind && o.name === r.name)
    if (same) same.amount += r.amount
    else out.push({ ...r })
  }
  const label = `Voucher ${v.number || v.date}`
  for (const r of refs) {
    if (r.kind !== 'against') {
      add(r)
      continue
    }
    if (!settles) {
      if (credits.has(r.name)) {
        add(r)
        continue
      }
      warnings.push(`${label}: its Agst Ref ${r.name} names no open advance of ${partyName} — its bill-wise details were not imported; Outstandings settles it oldest first`)
      return []
    }
    const named = open.find((b) => b.name === r.name && b.left > 0)
    if (named) {
      named.left -= Math.min(named.left, r.amount)
      add(r)
      continue
    }
    let left = r.amount
    const taken: ImportBillRef[] = []
    for (const b of open) {
      if (left === 0) break
      const take = Math.min(b.left, left)
      if (take === 0) continue
      b.left -= take
      left -= take
      taken.push({ kind: 'against', name: b.name, amount: take, dueDate: null })
    }
    if (left > 0) {
      warnings.push(`${label}: its Agst Ref ${r.name} names no open bill of ${partyName}, and its open bills don't cover it — its bill-wise details were not imported; Outstandings settles it oldest first`)
      return []
    }
    taken.forEach(add)
    warnings.push(`${label}: its Agst Ref ${r.name} names no open bill of ${partyName} — settled against ${taken.map((t) => t.name).join(', ')} (oldest first)`)
  }
  return out
}

/** A party master's opening bill-wise details → its opening bills (services/openingBills.ts, the
 *  one writer). They must be on the party's own side (an opening bill can't hold an advance), carry
 *  distinct names and add up to the opening the ledger now has; otherwise the opening stays one
 *  bill (settled oldest first) and it says so. */
function importOpeningBills(db: DB, ledgerId: number, l: TallyLedger, warnings: string[]): void {
  if (!l.bills?.length) return
  const row = db.prepare('SELECT group_id, opening_balance FROM ledgers WHERE id = ?').get(ledgerId) as { group_id: number; opening_balance: number }
  const skip = (why: string): void => {
    warnings.push(`Ledger "${l.name}": its opening bill-wise details (${l.bills!.map((b) => b.name).join(', ')}) were not imported — ${why}; its opening is one bill, settled oldest first`)
  }
  const side = partySide(db, row.group_id)
  if (side == null) return skip('it is not under Sundry Debtors or Sundry Creditors')
  if (row.opening_balance !== l.opening) return skip('it already had a different opening')
  const begin = booksBeginDay(db)
  const bills: OpeningBillRow[] = l.bills.map((b) => ({ name: b.name, date: b.date ?? begin, dueDate: b.dueDate, amount: side * b.amount }))
  const advances = bills.filter((b) => b.amount < 0)
  if (advances.length) return skip(`${advances.map((b) => b.name).join(', ')} ${advances.length > 1 ? 'are advances' : 'is an advance'}, which an opening bill can't hold`)
  const names = bills.map((b) => b.name.toLowerCase())
  if (new Set(names).size !== names.length) return skip('two bills share a name')
  if (names.includes(OPENING_BALANCE_NAME.toLowerCase())) return skip(`"${OPENING_BALANCE_NAME}" is a name Total keeps for itself`)
  if (bills.reduce((s, b) => s + b.amount, 0) !== side * row.opening_balance) return skip("they don't add up to its opening")
  try {
    replaceOpeningBills(db, ledgerId, bills)
  } catch (err) {
    skip((err as Error).message)
  }
}

/** A rejection note returns goods (to the supplier / from the customer); other notes are a
 *  supply out or a purchase in. */
function stockNotePurpose(kind: VoucherKind, typeName: string): TradePurpose {
  const rejection = /rejection/i.test(typeName)
  if (kind === 'delivery_note') return rejection ? 'non_supply' : 'supply'
  return rejection ? 'return' : 'purchase'
}

function stateCodeFromName(stateName: string | null): string | null {
  if (!stateName) return null
  const entry = Object.entries(GST_STATES).find(([, name]) => name.toLowerCase() === stateName.trim().toLowerCase())
  return entry ? entry[0] : null
}

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
    orders: data.orders.length,
    skipped: 0,
    booksFromSet: tallyBooksFromYear(data),
    warnings: [...data.warnings]
  }
}

/** Apply a parsed Tally export to the open company. Idempotent-ish: existing names are reused,
 *  not duplicated. The whole apply runs in ONE transaction (task Q1 #94) — a hard failure
 *  partway through (e.g. a constraint violation) rolls back every master and voucher written so
 *  far, never leaving a half-imported company. Per-voucher validation failures are still soft
 *  (skipped + warned), same as before. A single summary audit row (entity 'tally_import',
 *  action 'import') records the counts. */
export interface TallyImportOptions {
  /** Changing the books-from year is a company-details change: owner only (the IPC layer passes
   *  the session's right; services and tests default to allowed). */
  canSetBooksFrom?: boolean
}

export function importTallyXml(db: DB, xml: string, opts: TallyImportOptions = {}): ImportSummary {
  // Parse outside the transaction — a malformed file fails before any write is attempted.
  const data: TallyImport = parseTallyExport(xml)
  const run = db.transaction((): ImportSummary => {
    const summary = applyParsedTallyImport(db, data, opts.canSetBooksFrom !== false)
    writeAudit(db, 'tally_import', 0, 'import', null, {
      groups: summary.groups,
      ledgers: summary.ledgers,
      units: summary.units,
      items: summary.items,
      vouchers: summary.vouchers,
      orders: summary.orders,
      skipped: summary.skipped,
      booksFromSet: summary.booksFromSet,
      warnings: summary.warnings.length
    })
    return summary
  })
  return run()
}

function applyParsedTallyImport(db: DB, data: TallyImport, canSetBooksFrom: boolean): ImportSummary {
  const warnings = [...data.warnings]
  let counts = { groups: 0, ledgers: 0, units: 0, items: 0, vouchers: 0, orders: 0, skipped: 0 }

  // Books-from (Phase 1 gap): a company being migrated from Tally starts its books where Tally's
  // did — set it while the company has no vouchers yet (stored openings belong to that FY, the
  // WP 1.3 year-opening rule). Afterwards it is the user's call (Company details), so only warn.
  let booksFromSet: number | null = null
  const fileYear = tallyBooksFromYear(data)
  if (fileYear !== null) {
    const info = readCompanyInfo(db)
    if (info.booksFrom !== fileYear) {
      if (!canSetBooksFrom) {
        warnings.push(`The Tally books start in FY ${fileYear}-${String((fileYear + 1) % 100).padStart(2, '0')} — only an owner can change this company's first year (Company details)`)
      } else if (!db.prepare('SELECT 1 FROM vouchers LIMIT 1').get()) {
        writeCompanyInfo(db, { ...info, booksFrom: fileYear })
        writeAudit(db, 'company', 0, 'update', info, { ...info, booksFrom: fileYear })
        booksFromSet = fileYear
      } else {
        warnings.push(`The Tally books start in FY ${fileYear}-${String((fileYear + 1) % 100).padStart(2, '0')}, this company's in ${info.booksFrom}-${String((info.booksFrom + 1) % 100).padStart(2, '0')} — left unchanged because the company already has vouchers`)
      }
    }
  }

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
    const exists = db.prepare('SELECT l.id, l.name, l.opening_balance, g.name AS grp FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.name = ? COLLATE NOCASE').get(l.name) as
      | { id: number; name: string; opening_balance: number; grp: string }
      | undefined
    if (exists) {
      // WP 8.3: a ledger of the same name already exists (a setup preset's "Rent", the seeded
      // Cash). Its Tally opening is never lost: an empty opening takes Tally's (audited), a
      // different one is kept and reported; a different group is reported too.
      if (l.opening !== exists.opening_balance) {
        if (exists.opening_balance === 0) {
          db.prepare('UPDATE ledgers SET opening_balance = ? WHERE id = ?').run(l.opening, exists.id)
          writeAudit(db, 'ledger', exists.id, 'update', { openingBalance: 0 }, { openingBalance: l.opening, source: 'tally_import' })
          warnings.push(`Ledger "${exists.name}" already existed — its opening balance was taken from Tally`)
          if (exists.grp.toLowerCase() === l.parent.toLowerCase()) importOpeningBills(db, exists.id, l, warnings)
        } else {
          warnings.push(`Ledger "${exists.name}" already existed with a different opening balance — kept the existing one; check it against Tally`)
        }
      }
      if (exists.grp.toLowerCase() !== l.parent.toLowerCase()) {
        warnings.push(`Ledger "${exists.name}" already existed under "${exists.grp}" — Tally has it under "${l.parent}"; left under "${exists.grp}"`)
      }
      continue
    }
    const gid = groupId(l.parent) ?? suspense
    if (!groupId(l.parent)) warnings.push(`Ledger "${l.name}": group "${l.parent}" not found, placed under Suspense A/c`)
    const created = db.prepare(
      'INSERT INTO ledgers (name, group_id, opening_balance, gstin, state_code, is_system) VALUES (?, ?, ?, ?, ?, 0)'
    ).run(l.name, gid, l.opening, l.gstin, stateCodeFromName(l.stateName))
    counts.ledgers++
    importOpeningBills(db, Number(created.lastInsertRowid), l, warnings)
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

  // Vouchers
  const ledgerId = (name: string): number | null => {
    const row = db.prepare('SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined
    return row?.id ?? null
  }
  const itemId = (name: string): number | null => {
    const row = db.prepare('SELECT id FROM stock_items WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined
    return row?.id ?? null
  }
  // Godowns named on item lines (BATCHALLOCATIONS GODOWNNAME): the one of that name, else created.
  const godownIds = new Map<string, number>()
  const godownId = (name: string | null | undefined): number | null => {
    const key = name?.trim().toLowerCase()
    if (!key) return null
    const known = godownIds.get(key)
    if (known) return known
    const row = db.prepare('SELECT id FROM godowns WHERE name = ? COLLATE NOCASE').get(name!.trim()) as { id: number } | undefined
    const id = row?.id ?? createGodown(db, { name: name!.trim() }).id
    godownIds.set(key, id)
    return id
  }
  const typeIdFor = (vchType: string): { id: number; kind: VoucherKind } => {
    const existing = db.prepare('SELECT id, kind FROM voucher_types WHERE name = ? COLLATE NOCASE').get(vchType) as
      | { id: number; kind: VoucherKind }
      | undefined
    if (existing) return existing
    const kind = kindForTallyType(vchType, data)
    const res = db.prepare("INSERT INTO voucher_types (name, kind, numbering, prefix, is_system) VALUES (?, ?, 'manual', '', 0)")
      .run(vchType, kind)
    return { id: Number(res.lastInsertRowid), kind }
  }

  for (const v of data.vouchers) {
    const missing = v.lines.filter((l) => !ledgerId(l.ledger))
    if (missing.length) {
      warnings.push(`Voucher ${v.number || v.date} skipped: unknown ledger "${missing[0]!.ledger}" (import masters first)`)
      counts.skipped++
      continue
    }
    if (isOrderTypeName(v.vchType || '')) {
      warnings.push(`Voucher ${v.number || v.date} skipped: ${v.vchType} is an order — orders are not imported yet`)
      counts.skipped++
      continue
    }
    const vt = typeIdFor(v.vchType || 'Journal')
    const goodsIn = vt.kind === 'purchase' || vt.kind === 'credit_note' || vt.kind === 'receipt_note'
    // A stock / manufacturing journal (or any voucher whose goods go both ways) keeps each line's
    // own direction from the file; trading vouchers move goods the way their kind does.
    const ownDirection = vt.kind === 'stock_journal' || vt.kind === 'journal'
    // A delivery / receipt note moves goods only: Tally may still list the party's ledger entry
    // on it, but it posts nothing — keep the goods and the party, drop the ledger lines.
    const stockNote = vt.kind === 'delivery_note' || vt.kind === 'receipt_note'
    if (stockNote && v.lines.length > 0) {
      warnings.push(`Voucher ${v.number || v.date} (${v.vchType}): ledger entries on a ${vt.kind === 'delivery_note' ? 'delivery' : 'receipt'} note were not imported — it moves stock only`)
    }
    // Bill-wise details ride on the party's entry: the voucher's party, else the one ledger whose
    // entries carry them.
    const billParty = v.party ?? (() => {
      const withBills = [...new Set(v.lines.filter((l) => l.bills?.length).map((l) => l.ledger.toLowerCase()))]
      return withBills.length === 1 ? v.lines.find((l) => l.ledger.toLowerCase() === withBills[0])!.ledger : null
    })()
    const partyRefs = stockNote ? [] : tallyBillRefs(v, billParty, warnings)
    const billRefs = partyRefs.length && billParty ? settleOnOpenBills(db, ledgerId(billParty)!, billParty, v, partyRefs, warnings) : partyRefs
    // A Physical Stock voucher counts: each line is the quantity on hand that day (the Physical
    // Stock editor's count lines — buildPhysicalPayload), never a movement.
    const count = vt.kind === 'physical_stock'
    try {
      saveVoucher(db, {
        voucherTypeId: vt.id,
        date: v.date,
        number: v.number || undefined,
        partyLedgerId: v.party ? ledgerId(v.party) : billRefs.length && billParty ? ledgerId(billParty) : null,
        ...(stockNote ? { trade: { purpose: stockNotePurpose(vt.kind, v.vchType || '') } } : {}),
        narration: v.narration,
        isOptional: v.isOptional || undefined,
        reference: null,
        instrumentNo: null,
        instrumentDate: null,
        transporterId: null,
        vehicleNo: null,
        transportDistanceKm: null,
        currencyCode: null,
        exchangeRate: null,
        lines: stockNote ? [] : v.lines.map((l) => ({ ledgerId: ledgerId(l.ledger)!, drCr: l.drCr, amount: l.amount, costAllocations: [] })),
        inventory: v.inventory
          .filter((inv) => itemId(inv.item))
          .map((inv) => count
            ? { stockItemId: itemId(inv.item)!, godownId: godownId(inv.godown), qtyMilli: inv.qtyMilli, ratePaise: 0, amount: 0, direction: 'in' as const, isAbsolute: true }
            : {
                stockItemId: itemId(inv.item)!,
                godownId: godownId(inv.godown),
                qtyMilli: inv.qtyMilli,
                ratePaise: inv.qtyMilli > 0 ? Math.round((inv.amount * 1000) / inv.qtyMilli) : 0,
                amount: inv.amount,
                direction: ownDirection && inv.direction ? inv.direction : goodsIn ? ('in' as const) : ('out' as const)
              }),
        billRefs,
        tds: null
      }, undefined, { historicImport: true })
      counts.vouchers++
    } catch (err) {
      warnings.push(`Voucher ${v.number || v.date} skipped: ${(err as Error).message}`)
      counts.skipped++
    }
  }

  // Orders → trade_docs (WP 6.3). Each in its own savepoint: a bad order is skipped and warned.
  const docTypes = listTradeDocTypes(db)
  for (const o of data.orders) {
    try {
      db.transaction(() => importTallyOrder(db, o, docTypes, ledgerId, itemId))()
      counts.orders++
    } catch (err) {
      warnings.push(`${o.vchType} ${o.number || o.date} skipped: ${(err as Error).message}`)
      counts.skipped++
    }
  }

  return { ...counts, booksFromSet, warnings }
}

function importTallyOrder(
  db: DB,
  o: TallyOrder,
  docTypes: ReturnType<typeof listTradeDocTypes>,
  ledgerId: (name: string) => number | null,
  itemId: (name: string) => number | null
): void {
  if (!o.party) throw new Error('no party ledger')
  const partyId = ledgerId(o.party)
  if (!partyId) throw new Error(`unknown party "${o.party}" (import masters first)`)
  // The series with the same name as the Tally type ("Sales Order"), else the kind's first.
  const type = docTypes.find((t) => t.kind === o.kind && t.name.toLowerCase() === o.vchType.toLowerCase()) ?? docTypes.find((t) => t.kind === o.kind)
  if (!type) throw new Error(`no ${o.kind.replace('_', ' ')} series`)
  // A number repeats every FY in a series that restarts numbering: duplicates are per FY then.
  const fy = fyOf(o.date)
  if (o.number && db.prepare(`SELECT 1 FROM trade_docs WHERE doc_type_id = ? AND number = ? AND deleted_at IS NULL${type.restartFy ? ' AND date BETWEEN ? AND ?' : ''}`).get(type.id, o.number, ...(type.restartFy ? [fy.from, fy.to] : []))) {
    throw new Error('already imported')
  }
  const godownId = (name: string | null): number | null =>
    name ? ((db.prepare('SELECT id FROM godowns WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined)?.id ?? null) : null
  const dues = o.lines.map((l) => l.dueDate).filter((d): d is string => !!d && d >= o.date).sort()
  saveTradeDoc(db, {
    docTypeId: type.id,
    date: o.date,
    number: o.number || undefined,
    partyLedgerId: partyId,
    dueDate: dues[dues.length - 1] ?? null,
    reference: o.reference ? o.reference.slice(0, 120) : null,
    narration: o.narration ? o.narration.slice(0, 1000) : null,
    lines: o.lines.map((l) => {
      const id = itemId(l.item)
      if (!id) throw new Error(`unknown stock item "${l.item}" (import masters first)`)
      const money = orderLineMoney(l.qtyMilli, l.ratePaise, l.amount)
      return {
        stockItemId: id, godownId: godownId(l.godown), qtyMilli: l.qtyMilli, ...money,
        dueDate: l.dueDate && l.dueDate >= o.date ? l.dueDate : null
      }
    })
  })
}
