import type { DB } from '../db/connection'
import { orderLineMoney, parseTallyExport, tallyBaseTypeName, TALLY_ORDER_TYPE, type TallyImport, type TallyLedger, type TallyOrder, type TallyVoucher } from '@shared/tally'
import { GST_STATES } from '@shared/gst/states'
import { fyOf } from '@shared/dates'
import { formatPaise } from '@shared/money'
import type { BillAllocator } from '@shared/outstanding'
import { OPENING_BALANCE_NAME } from '@shared/simple/openings'
import { deleteVoucher, IN_BOOKS, MOVES_STOCK, saveVoucher } from './vouchers'
import { uniqueName } from '@shared/simple/intents'
import { createGodown } from './masters'
import { partyBillAllocator } from './analysis'
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

/** A party's bill allocation kept up to date through the import (seeded once from its opening
 *  and the books, then one event per voucher saved), so checking an Agst Ref never re-reads the
 *  party's history. */
interface PartyBills { allocator: BillAllocator; sign: 1 | -1 }

/**
 * An Agst Ref must name a bill the party has open at that point of the import (its opening bills,
 * the books, the vouchers imported before it). One that doesn't — the bill isn't in Total (a master
 * without its bill-wise details, a bill in a file not imported yet) or something before settled it
 * — would sit as unapplied credit with a broken reference. Only that part is rerouted, the way the
 * voucher reads without references; the voucher's other refs (a real Advance included) stay:
 * - money in from a customer / out to a supplier (a settling entry): the part settles the open bills
 *   oldest first, as Agst refs to them. What they can't take rides on the voucher's last Agst ref
 *   (moved last): the engine settles a ref's excess oldest first and holds the rest on account —
 *   exactly the reading without references. It is NEVER a New ref, which GSTR-1 11A would read as
 *   an advance on a receipt. With no Agst ref to carry it, the voucher keeps no refs (as before).
 * - a bill drawing on an advance that isn't there: the part is a bill under the entry's number
 *   (made unique as simple mode does — FY suffix, then a counter); on a receipt / payment (a
 *   refund) the voucher keeps no refs instead.
 * Warnings say what the voucher ends up with, naming the bill "as of this import".
 */
function settleOnOpenBills(party: PartyBills, partyName: string, v: TallyVoucher, kind: VoucherKind, refs: ImportBillRef[], warnings: string[]): ImportBillRef[] {
  if (!refs.some((r) => r.kind === 'against')) return refs
  // tallyBillRefs took refs only when every party line is on one side.
  const partyLine = v.lines.find((l) => l.ledger.toLowerCase() === partyName.toLowerCase())
  const settles = party.sign * (partyLine?.drCr === 'dr' ? 1 : -1) < 0
  const open = party.allocator.open().map((b) => ({ name: b.number, left: b.pending }))
  const credits = party.allocator.openCredits().map((c) => ({ name: c.name, left: c.amount }))
  const out: ImportBillRef[] = []
  const add = (r: ImportBillRef): void => {
    const same = out.find((o) => o.kind === r.kind && o.name === r.name)
    if (same) same.amount += r.amount
    else out.push({ ...r })
  }
  const settleFifo = (amount: number): ImportBillRef[] => {
    let left = amount
    const taken: ImportBillRef[] = []
    for (const b of open) {
      if (left === 0) break
      const take = Math.min(b.left, left)
      if (take === 0) continue
      b.left -= take
      left -= take
      taken.push({ kind: 'against', name: b.name, amount: take, dueDate: null })
    }
    if (left > 0) taken.push({ kind: 'against', name: '', amount: left, dueDate: null })
    return taken
  }
  const label = `Voucher ${v.number || v.date}`
  const notFound = (names: string[], what: string): string =>
    `${label}: its Agst Ref ${names.join(', ')} ${names.length > 1 ? 'name' : 'names'} no open ${what} of ${partyName} as of this import (it may be in a file not imported yet)`
  const keepNone = (names: string[], what: string, why: string): ImportBillRef[] => {
    warnings.push(`${notFound(names, what)}, and ${why} — its bill-wise details were not imported; Outstandings settles it oldest first`)
    return []
  }
  const notes: string[] = []
  const unknown: ImportBillRef[] = []
  for (const r of refs) {
    if (r.kind !== 'against') {
      add(r)
      continue
    }
    if (!settles) {
      const credit = credits.find((c) => c.name === r.name && c.left > 0)
      if (credit) {
        credit.left -= Math.min(credit.left, r.amount)
        add(r)
        continue
      }
      if (kind === 'receipt' || kind === 'payment') return keepNone([r.name], 'advance', 'a refund can\'t open a bill of its own')
      if (!v.number) return keepNone([r.name], 'advance', 'the entry has no number to name a bill by')
      const name = uniqueName(v.number, new Set([...open.map((b) => b.name), ...credits.map((c) => c.name)]), v.date)
      add({ kind: 'new', name, amount: r.amount, dueDate: null })
      notes.push(`${notFound([r.name], 'advance')} — that part is a bill of its own, ${name}`)
      continue
    }
    const named = open.find((b) => b.name === r.name && b.left > 0)
    if (!named) {
      unknown.push(r)
      continue
    }
    const take = Math.min(named.left, r.amount)
    named.left -= take
    // The engine settles an Agst Ref's excess oldest first: so does the tracking here.
    settleFifo(r.amount - take)
    add(r)
  }
  if (unknown.length) {
    const taken = settleFifo(unknown.reduce((s, r) => s + r.amount, 0))
    const onAccount = taken.find((t) => !t.name)?.amount ?? 0
    taken.filter((t) => t.name).forEach(add)
    const names = unknown.map((r) => r.name)
    if (onAccount > 0) {
      // The last Agst ref carries what nothing open can take — moved last, so its excess is held on
      // account only after every other ref of the voucher has been applied.
      const carrier = [...out].reverse().find((o) => o.kind === 'against')
      if (!carrier) return keepNone(names, 'bill', 'nothing open can take it')
      carrier.amount += onAccount
      out.splice(out.indexOf(carrier), 1)
      out.push(carrier)
    }
    const where = taken.filter((t) => t.name).map((t) => t.name)
    notes.push(`${notFound(names, 'bill')} — ${[...(where.length ? [`settled oldest first against ${[...new Set(where)].join(', ')}`] : []), ...(onAccount > 0 ? [`${formatPaise(onAccount, { symbol: true })} on account`] : [])].join(', ')}`)
  }
  warnings.push(...notes)
  return out
}

/** Godown-wise stock of an item as on `date` (before the voucher `beforeId`, when given): opening
 *  stock and lines without a godown are Tally's Main Location (`mainGodown`); a count resets it —
 *  to the godown counts a joined count found (`breakdowns`), else to its own godown. */
function godownHoldings(
  db: DB, itemId: number, date: string, beforeId: number | null, mainGodown: number | null, breakdowns: ReadonlyMap<number, ReadonlyMap<number, ReadonlyMap<number, number>>>
): Map<number, number> {
  const key = (godownId: number | null): number => godownId ?? mainGodown ?? NO_GODOWN
  const opening = (db.prepare('SELECT opening_qty_milli AS q FROM stock_items WHERE id = ?').get(itemId) as { q: number }).q
  let held = new Map<number, number>([[key(null), opening]])
  const rows = db.prepare(
    `SELECT il.voucher_id AS voucherId, il.godown_id AS godownId, il.qty_milli AS qty, il.direction, il.is_absolute AS absolute
     FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id
     WHERE il.stock_item_id = ? AND ${beforeId == null ? 'v.date <= ?' : '(v.date < ? OR (v.date = ? AND v.id < ?))'} AND ${IN_BOOKS} AND ${MOVES_STOCK}
     ORDER BY v.date, v.id, il.line_order, il.id`
  ).all(itemId, ...(beforeId == null ? [date] : [date, date, beforeId])) as { voucherId: number; godownId: number | null; qty: number; direction: 'in' | 'out'; absolute: number }[]
  for (const r of rows) {
    if (r.absolute) {
      const known = breakdowns.get(r.voucherId)?.get(itemId)
      held = known ? new Map(known) : new Map([[key(r.godownId), r.qty]])
    } else {
      held.set(key(r.godownId), (held.get(key(r.godownId)) ?? 0) + (r.direction === 'in' ? r.qty : -r.qty))
    }
  }
  return held
}

const NO_GODOWN = -1
const godownLabel = (db: DB, id: number): string =>
  id === NO_GODOWN ? 'no godown' : ((db.prepare('SELECT name FROM godowns WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? `#${id}`)

/**
 * A Physical Stock voucher's counts as ONE count per item (Total counts the whole item, Tally
 * counts per godown). The godown counts are joined when they cover every godown holding the item
 * as on the voucher's date (opening stock and lines without a godown are Tally's Main Location;
 * after an earlier count, the godowns it found) — then the total is the stock the business holds.
 * A count that leaves out a godown still holding stock (or a godown it can't place) would wipe that
 * stock, so the voucher is skipped instead and it says which. `breakdowns` remembers each joined
 * count's godowns for the counts after it.
 */
function joinGodownCounts(
  db: DB,
  v: TallyVoucher,
  lines: { itemId: number; item: string; godownId: number | null; qtyMilli: number }[],
  mainGodown: number | null,
  breakdowns: Map<number, Map<number, Map<number, number>>>
): { lines: { itemId: number; godownId: number | null; qtyMilli: number }[]; breakdown: Map<number, Map<number, number>> } | { refused: string } {
  const key = (godownId: number | null): number => godownId ?? mainGodown ?? NO_GODOWN
  const byItem = new Map<number, { item: string; counts: Map<number, number> }>()
  for (const l of lines) {
    const entry = byItem.get(l.itemId) ?? { item: l.item, counts: new Map<number, number>() }
    entry.counts.set(key(l.godownId), (entry.counts.get(key(l.godownId)) ?? 0) + l.qtyMilli)
    byItem.set(l.itemId, entry)
  }
  const godownName = (id: number): string => godownLabel(db, id)
  const out: { itemId: number; godownId: number | null; qtyMilli: number }[] = []
  const breakdown = new Map<number, Map<number, number>>()
  for (const [itemId, { item, counts }] of byItem) {
    const held = godownHoldings(db, itemId, v.date, null, mainGodown, breakdowns)
    const left = [...held].filter(([g, q]) => q !== 0 && !counts.has(g))
    if (left.length) {
      return { refused: `Voucher ${v.number || v.date} skipped: the Physical Stock counts ${item} only in ${[...counts.keys()].map(godownName).join(', ')}, but it also holds stock in ${left.map(([g]) => godownName(g)).join(', ')} — Total counts an item as a whole, so this count would lose that stock; count it in the full app` }
    }
    const godowns = [...counts.keys()]
    out.push({ itemId, godownId: godowns.length === 1 && godowns[0] !== NO_GODOWN ? godowns[0]! : null, qtyMilli: [...counts.values()].reduce((s, q) => s + q, 0) })
    breakdown.set(itemId, counts)
  }
  return { lines: out, breakdown }
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

  // Bill tracking per party (seeded at its first Agst Ref, then fed every voucher saved).
  const partyBills = new Map<number, PartyBills>()
  const billsOf = (partyId: number): PartyBills => {
    let p = partyBills.get(partyId)
    if (!p) {
      p = partyBillAllocator(db, partyId, '9999-12-31')!
      partyBills.set(partyId, p)
    }
    return p
  }
  const mainGodown = (db.prepare("SELECT id FROM godowns WHERE name = 'Main Location' COLLATE NOCASE").get() as { id: number } | undefined)?.id ?? null
  const countBreakdowns = new Map<number, Map<number, Map<number, number>>>()

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
    const billRefs = partyRefs.length && billParty ? settleOnOpenBills(billsOf(ledgerId(billParty)!), billParty, v, vt.kind, partyRefs, warnings) : partyRefs
    // A Physical Stock voucher counts: each line is the quantity on hand that day (the Physical
    // Stock editor's count lines — buildPhysicalPayload), never a movement — one per item, its
    // godown counts joined (joinGodownCounts), or the voucher is skipped.
    const count = vt.kind === 'physical_stock'
    const inventoryLines = v.inventory.filter((inv) => itemId(inv.item))
    let joined: ReturnType<typeof joinGodownCounts> | null = null
    if (count) {
      joined = joinGodownCounts(db, v, inventoryLines.map((inv) => ({ itemId: itemId(inv.item)!, item: inv.item, godownId: godownId(inv.godown), qtyMilli: inv.qtyMilli })), mainGodown, countBreakdowns)
      if ('refused' in joined) {
        warnings.push(joined.refused)
        counts.skipped++
        continue
      }
    }
    try {
      const saved = saveVoucher(db, {
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
        inventory: joined && !('refused' in joined)
          ? joined.lines.map((c) => ({ stockItemId: c.itemId, godownId: c.godownId, qtyMilli: c.qtyMilli, ratePaise: 0, amount: 0, direction: 'in' as const, isAbsolute: true }))
          : inventoryLines.map((inv) => ({
                stockItemId: itemId(inv.item)!,
                godownId: godownId(inv.godown),
                qtyMilli: inv.qtyMilli,
                ratePaise: inv.qtyMilli > 0 ? Math.round((inv.amount * 1000) / inv.qtyMilli) : 0,
                amount: inv.amount,
                direction: ownDirection && inv.direction ? inv.direction : goodsIn ? ('in' as const) : ('out' as const)
              })),
        billRefs,
        tds: null
      }, undefined, { historicImport: true })
      counts.vouchers++
      if (joined && !('refused' in joined)) countBreakdowns.set(saved.id, joined.breakdown)
      // Feed the voucher to every party being tracked, as the allocation reads it (in-books only).
      if (!saved.isOptional && !saved.postDated) {
        for (const [partyId, p] of partyBills) {
          const own = saved.lines.filter((l) => l.ledgerId === partyId)
          if (!own.length) continue
          const net = own.reduce((s, l) => s + (l.drCr === 'dr' ? l.amount : -l.amount), 0)
          p.allocator.apply({ voucherId: saved.id, date: saved.date, number: saved.number, amount: p.sign * net, refs: saved.partyLedgerId === partyId ? saved.billRefs.map((r) => ({ kind: r.kind, name: r.name, amount: r.amount, dueDate: r.dueDate })) : [] })
        }
      }
    } catch (err) {
      warnings.push(`Voucher ${v.number || v.date} skipped: ${(err as Error).message}`)
      counts.skipped++
    }
  }

  // A joined count stands only while its godowns still cover the item: a voucher dated on or before
  // it but imported after it (later in the file) may have put stock into a godown it doesn't count.
  // Re-checked in date order (a binned count changes what the counts after it found).
  const countRows = [...countBreakdowns.keys()].map((id) => db.prepare('SELECT id, date, number FROM vouchers WHERE id = ?').get(id) as { id: number; date: string; number: string })
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)
  for (const c of countRows) {
    const breakdown = countBreakdowns.get(c.id)!
    for (const [itemId, godownCounts] of breakdown) {
      const held = godownHoldings(db, itemId, c.date, c.id, mainGodown, countBreakdowns)
      const left = [...held].filter(([g, q]) => q !== 0 && !godownCounts.has(g))
      if (!left.length) continue
      const item = (db.prepare('SELECT name FROM stock_items WHERE id = ?').get(itemId) as { name: string }).name
      const why = `${item} also holds stock in ${left.map(([g]) => godownLabel(db, g)).join(', ')} on its date (a voucher dated on or before it came later in the file), which it doesn't count — counting the item as a whole would lose that stock; count it again in the full app. A later import of earlier-dated vouchers can't be checked against a count like this`
      try {
        deleteVoucher(db, c.id)
        countBreakdowns.delete(c.id)
        counts.vouchers--
        counts.skipped++
        warnings.push(`Voucher ${c.number || c.date} (Physical Stock) moved to the bin: ${why}`)
      } catch (err) {
        warnings.push(`Voucher ${c.number || c.date} (Physical Stock) could not be moved to the bin (${(err as Error).message}) — check it: ${why}`)
      }
      break
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
