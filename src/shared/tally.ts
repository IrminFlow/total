import { decimalToScaled } from './dataImport/values'
import { normaliseNewlines } from './textFiles'
import { addDaysISO } from './dates'
/**
 * Tally XML import: a small tolerant XML parser plus mapping from Tally's
 * TALLYMESSAGE export format (Masters and Daybook/Vouchers) into neutral
 * structures the main process applies to the database.
 */

// ---------- minimal XML parser ----------

export interface XNode {
  tag: string
  attrs: Record<string, string>
  children: XNode[]
  text: string
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(parseInt(body.slice(2), 16))
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10))
    return ENTITIES[body] ?? m
  })
}

/** Parse an XML document into a tree. Tolerates declarations, comments and Tally's quirks.
 *  WP 7.3: a leading byte-order mark is dropped and CRLF / CR become LF first (XML 1.0 §2.11 line-end
 *  handling) — Tally on Windows writes CRLF, so a multi-line address or narration reads the same as
 *  one exported on a Mac. */
export function parseXml(source: string): XNode {
  const input = normaliseNewlines(source.replace(/^\uFEFF/, ''))
  const root: XNode = { tag: '#root', attrs: {}, children: [], text: '' }
  const stack: XNode[] = [root]
  let i = 0
  const len = input.length

  while (i < len) {
    const lt = input.indexOf('<', i)
    if (lt === -1) break
    const textChunk = input.slice(i, lt)
    if (textChunk.trim()) {
      const top = stack[stack.length - 1]!
      top.text += decodeEntities(textChunk.trim())
    }
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt)
      i = end === -1 ? len : end + 3
      continue
    }
    if (input.startsWith('<?', lt) || input.startsWith('<!', lt)) {
      const end = input.indexOf('>', lt)
      i = end === -1 ? len : end + 1
      continue
    }
    const gt = input.indexOf('>', lt)
    if (gt === -1) break
    const raw = input.slice(lt + 1, gt)
    i = gt + 1

    if (raw.startsWith('/')) {
      const tag = raw.slice(1).trim()
      // Pop to the matching open tag; tolerate mismatches.
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d]!.tag === tag) {
          stack.length = d
          break
        }
      }
      continue
    }

    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1) : raw
    const spaceIdx = body.search(/[\s]/)
    const tag = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).trim()
    const attrs: Record<string, string> = {}
    if (spaceIdx !== -1) {
      const attrRe = /([A-Za-z0-9_.:-]+)\s*=\s*"([^"]*)"/g
      let m: RegExpExecArray | null
      while ((m = attrRe.exec(body.slice(spaceIdx)))) attrs[m[1]!.toUpperCase()] = decodeEntities(m[2]!)
    }
    const node: XNode = { tag, attrs, children: [], text: '' }
    stack[stack.length - 1]!.children.push(node)
    if (!selfClosing) stack.push(node)
  }
  return root
}

/** All descendant nodes with the given tag (depth-first). */
export function collect(node: XNode, tag: string): XNode[] {
  const out: XNode[] = []
  const walk = (n: XNode): void => {
    for (const c of n.children) {
      if (c.tag === tag) out.push(c)
      walk(c)
    }
  }
  walk(node)
  return out
}

/** Text of the first direct child with the tag, or ''. */
export function childText(node: XNode, tag: string): string {
  return node.children.find((c) => c.tag === tag)?.text ?? ''
}

// ---------- Tally value parsing ----------

/** Tally amounts: "-1,00,000.00" — negative means DEBIT. Returns signed paise (Tally sign kept). */
export function parseTallyAmount(s: string): number {
  const cleaned = s.replace(/[,\s]/g, '')
  if (cleaned === '') return 0
  const n = Number(cleaned)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100)
}

/** Tally dates: "20260815" -> "2026-08-15". */
export function parseTallyDate(s: string): string | null {
  const m = s.trim().match(/^(\d{4})(\d{2})(\d{2})$/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/** Tally quantities: " 2 Nos" or "2.500 Kg" -> qty in thousandths. */
export function parseTallyQty(s: string): number {
  const m = s.trim().match(/^-?[\d,]*\.?\d+/)
  if (!m) return 0
  return Math.abs(Math.round(Number(m[0].replace(/,/g, '')) * 1000))
}

// ---------- neutral import structures ----------

export interface TallyGroup { name: string; parent: string }
export interface TallyLedger {
  name: string
  parent: string
  /** Signed paise, positive = Dr (already converted from Tally's convention). */
  opening: number
  gstin: string | null
  stateName: string | null
  /** The opening's bill-wise details (BILLALLOCATIONS.LIST on the LEDGER master), when it has any. */
  bills?: TallyOpeningBill[]
}
/** One opening bill of a party master: BILLDATE, NAME, BILLCREDITPERIOD (days from the bill date,
 *  or a date) as the due date, OPENINGBALANCE as signed paise, positive = Dr (an advance in the
 *  opening is on the other side from the party's bills). */
export interface TallyOpeningBill { name: string; date: string | null; dueDate: string | null; amount: number }
export interface TallyUnit { name: string; decimals: number }
export interface TallyItem {
  name: string
  unit: string
  hsn: string | null
  gstRate: number | null
  openingQtyMilli: number
  openingValue: number
}
/** A bill-wise allocation on a ledger entry (BILLALLOCATIONS.LIST): BILLTYPE New Ref / Agst Ref /
 *  Advance / On Account, the bill's NAME, its AMOUNT (paise, unsigned) and BILLCREDITPERIOD as the
 *  due date (ISO) when it can be read. */
export interface TallyBillAllocation { name: string; type: 'new' | 'against' | 'advance' | 'on_account'; amount: number; dueDate: string | null }
export interface TallyVoucherLine { ledger: string; drCr: 'dr' | 'cr'; amount: number; bills?: TallyBillAllocation[] }
export interface TallyInventoryLine {
  item: string
  qtyMilli: number
  amount: number
  /** The entry's own direction: INVENTORYENTRIESIN / OUT (stock / manufacturing journals), else its
   *  ISDEEMEDPOSITIVE (Yes = goods in) or a negative AMOUNT (Tally: debit = goods in). Absent (a
   *  hand-built voucher, the exporter's) = the voucher kind's direction. */
  direction?: 'in' | 'out'
  godown?: string | null
}
/** A VOUCHERTYPE master: its name and PARENT (Tally's predefined type it was made from — a custom
 *  "Sales Return" has PARENT "Credit Note"; a predefined type is its own parent). */
export interface TallyVoucherType { name: string; parent: string }
export interface TallyVoucher {
  vchType: string
  date: string
  number: string
  party: string | null
  narration: string | null
  lines: TallyVoucherLine[]
  inventory: TallyInventoryLine[]
  /** ISOPTIONAL = Yes: a memorandum voucher (never counts in the books). */
  isOptional?: boolean
}

/** A Tally Sales / Purchase Order (WP 6.3 → trade_docs). */
export interface TallyOrderLine {
  item: string
  qtyMilli: number
  /** Paise per unit, as the order states it (RATE "100.00/Nos"); null when absent. */
  ratePaise: number | null
  /** Line value (|AMOUNT|), paise. */
  amount: number
  godown: string | null
  dueDate: string | null
}
export interface TallyOrder {
  kind: 'sales_order' | 'purchase_order'
  vchType: string
  date: string
  number: string
  party: string | null
  narration: string | null
  reference: string | null
  lines: TallyOrderLine[]
}

export interface TallyImport {
  groups: TallyGroup[]
  ledgers: TallyLedger[]
  units: TallyUnit[]
  items: TallyItem[]
  vouchers: TallyVoucher[]
  /** Sales / purchase orders (never vouchers: they post nothing). */
  orders: TallyOrder[]
  /** VOUCHERTYPE masters (name → parent), when the export carries them. */
  voucherTypes: TallyVoucherType[]
  /** COMPANY BOOKSFROM (else STARTINGFROM) as ISO, when the export carries the company master. */
  booksFrom: string | null
  warnings: string[]
}

/** Tally order voucher types (Sales Order, Purchase Order, Job Work In/Out Order). */
export const TALLY_ORDER_TYPE = /\border\b/i

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' }

/** Order due dates: "20250415" or the display form "15-Apr-2025" / "1-Apr-25" (the P attribute). */
export function parseTallyLooseDate(s: string): string | null {
  const strict = parseTallyDate(s)
  if (strict) return strict
  const m = s.trim().match(/^(\d{1,2})-([A-Za-z]{3})[A-Za-z]*-(\d{2}|\d{4})$/)
  if (!m) return null
  const mon = MONTHS[m[2]!.toLowerCase()]
  if (!mon) return null
  const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!
  return `${year}-${mon}-${m[1]!.padStart(2, '0')}`
}

/** RATE "100.00/Nos" → 10000 paise; "" → null. */
export function parseTallyRate(s: string): number | null {
  const m = s.trim().match(/^-?[\d,]*\.?\d+/)
  if (!m) return null
  // Integer maths from the decimal text (floats never touch money).
  const v = decimalToScaled(m[0].replace(/,/g, ''), 2)
  return v === null ? null : Math.abs(v)
}

/** Rate / discount / amount for an order line that satisfies trade_docs' rule
 *  amount = round(qty × rate) − discount, keeping the line's own amount. */
export function orderLineMoney(qtyMilli: number, ratePaise: number | null, amount: number): { ratePaise: number; discountPaise: number; amount: number } {
  let rate = ratePaise ?? Math.ceil((amount * 1000) / qtyMilli)
  let gross = Math.round((qtyMilli * rate) / 1000)
  if (gross < amount) {
    rate = Math.ceil((amount * 1000) / qtyMilli)
    gross = Math.round((qtyMilli * rate) / 1000)
  }
  return { ratePaise: rate, discountPaise: Math.max(0, gross - amount), amount }
}

const nameOf = (n: XNode): string => n.attrs.NAME ?? childText(n, 'NAME')

/** Parse a Tally master/voucher export XML into neutral structures. */
/** Tally voucher types that move goods without posting: Delivery Note / Receipt Note (and the
 *  Rejections In / Out notes). */
export const TALLY_STOCK_NOTE_TYPE = /delivery note|delivery challan|receipt note|goods receipt|rejection/i

/** Tally stock / manufacturing journals (goods in and out, no ledger entries). Physical Stock is
 *  not one (its lines are counts, not movements). */
export const TALLY_STOCK_JOURNAL_TYPE = /stock journal|manufactur/i

/** Tally's Physical Stock voucher: each item line is the counted quantity on that date (no ledger
 *  entries, no amounts) — imported as count lines, never as movements. */
export const TALLY_PHYSICAL_STOCK_TYPE = /physical[^a-z0-9]*stock/i

/** The predefined Tally type a voucher type comes from: its VOUCHERTYPE master's PARENT, followed
 *  up the chain (a custom type may be made from another custom type) until a type that is its own
 *  parent or has no master in the file. The name itself when the file has no master for it. */
export function tallyBaseTypeName(name: string, types: readonly TallyVoucherType[]): string {
  const byName = new Map(types.map((t) => [t.name.toLowerCase(), t.parent]))
  let current = name
  const seen = new Set<string>()
  for (;;) {
    const key = current.toLowerCase()
    const parent = byName.get(key)
    if (!parent || parent.toLowerCase() === key || seen.has(key)) return current
    seen.add(key)
    current = parent
  }
}

/** A voucher carrying stock-journal item lists (INVENTORYENTRIESIN / OUT) — a stock journal under
 *  any custom name. */
const hasJournalLists = (v: XNode): boolean =>
  // Only a list naming an item: TallyPrime / ERP 9 often write BLANK IN / OUT tags beside a sale's
  // real item lines, which must not hide them (or make a voucher a stock journal).
  v.children.some((c) => (c.tag === 'INVENTORYENTRIESIN.LIST' || c.tag === 'INVENTORYENTRIESOUT.LIST') && childText(c, 'STOCKITEMNAME').trim() !== '')

const BILL_TYPES: Record<string, TallyBillAllocation['type']> = { 'new ref': 'new', 'agst ref': 'against', advance: 'advance', 'on account': 'on_account' }

/** BILLALLOCATIONS.LIST of a ledger entry. BILLCREDITPERIOD is "30 Days" (text or its P attribute)
 *  — the due date is the voucher date + those days — or a date. */
function billAllocations(entry: XNode, date: string, label: string, warnings: string[]): TallyBillAllocation[] {
  const out: TallyBillAllocation[] = []
  for (const b of entry.children.filter((c) => c.tag === 'BILLALLOCATIONS.LIST')) {
    const billType = childText(b, 'BILLTYPE').trim()
    const type = BILL_TYPES[billType.toLowerCase()]
    const amount = Math.abs(parseTallyAmount(childText(b, 'AMOUNT')))
    const name = childText(b, 'NAME').trim()
    if (!type && amount !== 0) {
      // Never dropped silently: without it the voucher's refs no longer add up (or are gone).
      warnings.push(`Voucher ${label}: its bill-wise allocation ${name || '(no name)'} has a bill type Total doesn't know ("${billType}") — left out; Outstandings settles that part oldest first`)
      continue
    }
    if (!type || amount === 0 || (!name && type !== 'on_account')) continue
    out.push({ name, type, amount, dueDate: creditPeriodDue(b, date) })
  }
  return out
}

/** BILLCREDITPERIOD of a bill allocation: "30 Days" (text or its P attribute) counts from `from`;
 *  a date is the due date itself. */
function creditPeriodDue(b: XNode, from: string | null): string | null {
  const period = b.children.find((c) => c.tag === 'BILLCREDITPERIOD')
  const text = (period?.text || period?.attrs.P || '').trim()
  if (!text) return null
  const days = text.match(/^(\d+)\s*days?$/i)
  if (days) return from ? addDaysISO(from, Number(days[1])) : null
  return parseTallyLooseDate(text)
}

/** A LEDGER master's opening bill-wise details (BILLALLOCATIONS.LIST directly under LEDGER). */
function openingBills(ledger: XNode): TallyOpeningBill[] {
  const out: TallyOpeningBill[] = []
  for (const b of ledger.children.filter((c) => c.tag === 'BILLALLOCATIONS.LIST')) {
    const name = childText(b, 'NAME').trim()
    // Tally: negative = debit. Ours: positive = debit.
    const amount = -parseTallyAmount(childText(b, 'OPENINGBALANCE'))
    if (!name || amount === 0) continue
    const date = parseTallyDate(childText(b, 'BILLDATE'))
    out.push({ name, date, dueDate: creditPeriodDue(b, date), amount })
  }
  return out
}

/**
 * An item line's godowns: its BATCHALLOCATIONS.LIST, one per godown / batch. One godown → the line
 * in that godown. Several → one line per godown with Tally's own quantities (ACTUALQTY, else
 * BILLEDQTY) and amounts; batches without an AMOUNT share the line's amount by quantity (BigInt,
 * the last one takes the remainder) — the parts always add up to the line to the paisa. A split
 * whose quantities or amounts don't add up to the line keeps ONE line without a godown, and says so.
 */
function godownSplit(inv: XNode, line: TallyInventoryLine, label: string, warnings: string[], isCount: boolean): TallyInventoryLine[] {
  const batches = inv.children.filter((c) => c.tag === 'BATCHALLOCATIONS.LIST')
  const groups = new Map<string, { godown: string; qtyMilli: number; amount: number; amounts: number; batches: number }>()
  for (const b of batches) {
    const godown = childText(b, 'GODOWNNAME').trim()
    const g = groups.get(godown.toLowerCase()) ?? { godown, qtyMilli: 0, amount: 0, amounts: 0, batches: 0 }
    g.batches++
    g.qtyMilli += parseTallyQty(childText(b, 'ACTUALQTY') || childText(b, 'BILLEDQTY'))
    const amount = childText(b, 'AMOUNT').trim()
    if (amount) {
      g.amount += Math.abs(parseTallyAmount(amount))
      g.amounts++
    }
    groups.set(godown.toLowerCase(), g)
  }
  // A part with no quantity and no amount moves nothing — except on a Physical Stock voucher, where
  // a godown counted at 0 says that godown is empty.
  // A batch naming only its godown (no quantity, no amount) still places a line of one godown.
  const all = [...groups.values()]
  const moving = all.filter((p) => p.qtyMilli !== 0 || p.amount !== 0)
  const parts = isCount || moving.length === 0 ? all : moving
  if (parts.length <= 1) {
    const only = parts[0]
    if (!only?.godown) return [line]
    // One godown: its batches must agree with the line where they say a quantity / an amount.
    const qtyGiven = batches.some((b) => (childText(b, 'ACTUALQTY') || childText(b, 'BILLEDQTY')).trim())
    const off = (qtyGiven && only.qtyMilli !== line.qtyMilli) || (only.amounts > 0 && only.amount !== line.amount)
    if (off) {
      warnings.push(`Voucher ${label}: ${line.item}'s godown allocation (${only.godown}) doesn't add up to the line — imported without a godown`)
      return [line]
    }
    return [{ ...line, godown: only.godown }]
  }
  const withAmount = parts.reduce((s, p) => s + p.amounts, 0)
  const qtyAdds = parts.reduce((s, p) => s + p.qtyMilli, 0) === line.qtyMilli
  let amounts: number[] | null = null
  if (withAmount === parts.reduce((s, p) => s + p.batches, 0)) {
    amounts = parts.map((p) => p.amount)
    if (amounts.reduce((s, a) => s + a, 0) !== line.amount) amounts = null
  } else if (withAmount === 0 && line.qtyMilli > 0) {
    let left = BigInt(line.amount)
    amounts = parts.map((p, i) => {
      if (i === parts.length - 1) return Number(left)
      const share = (BigInt(line.amount) * BigInt(p.qtyMilli) * 2n + BigInt(line.qtyMilli)) / (BigInt(line.qtyMilli) * 2n)
      left -= share
      return Number(share)
    })
  }
  if (!qtyAdds || !amounts || amounts.some((a) => a < 0)) {
    warnings.push(`Voucher ${label}: ${line.item} is split over godowns (${parts.map((p) => p.godown || 'no godown').join(', ')}) in parts that don't add up to the line — imported without a godown`)
    return [line]
  }
  return parts.map((p, i) => ({ ...line, qtyMilli: p.qtyMilli, amount: amounts![i]!, ...(p.godown ? { godown: p.godown } : {}) }))
}

export function parseTallyExport(xml: string): TallyImport {
  const root = parseXml(xml)
  const warnings: string[] = []
  const result: TallyImport = { groups: [], ledgers: [], units: [], items: [], vouchers: [], orders: [], voucherTypes: [], booksFrom: null, warnings }

  // The company master, when the export includes it (Masters export / "All Masters"): BOOKSFROM is
  // the first day of the books, STARTINGFROM the FY start (Tally company creation fields).
  for (const c of collect(root, 'COMPANY')) {
    const d = parseTallyDate(childText(c, 'BOOKSFROM')) ?? parseTallyDate(childText(c, 'STARTINGFROM'))
    if (d) {
      result.booksFrom = d
      break
    }
  }

  for (const g of collect(root, 'GROUP')) {
    const name = nameOf(g)
    if (!name) continue
    result.groups.push({ name, parent: childText(g, 'PARENT') })
  }

  for (const l of collect(root, 'LEDGER')) {
    const name = nameOf(l)
    if (!name) continue
    const openingTally = parseTallyAmount(childText(l, 'OPENINGBALANCE'))
    const bills = openingBills(l)
    result.ledgers.push({
      name,
      parent: childText(l, 'PARENT'),
      // Tally: negative = debit. Ours: positive = debit.
      opening: -openingTally,
      gstin: childText(l, 'PARTYGSTIN') || childText(l, 'GSTREGISTRATIONNUMBER') || null,
      stateName: childText(l, 'LEDSTATENAME') || null,
      ...(bills.length ? { bills } : {})
    })
  }

  for (const t of collect(root, 'VOUCHERTYPE')) {
    const name = nameOf(t)
    if (!name) continue
    result.voucherTypes.push({ name, parent: childText(t, 'PARENT') || name })
  }

  for (const u of collect(root, 'UNIT')) {
    const name = nameOf(u)
    if (!name) continue
    result.units.push({ name, decimals: Number(childText(u, 'DECIMALPLACES') || '0') || 0 })
  }

  for (const s of collect(root, 'STOCKITEM')) {
    const name = nameOf(s)
    if (!name) continue
    const rateNodes = collect(s, 'GSTRATE')
    const hsnNodes = collect(s, 'HSNCODE')
    result.items.push({
      name,
      unit: childText(s, 'BASEUNITS'),
      hsn: hsnNodes[0]?.text || null,
      gstRate: rateNodes[0]?.text ? Number(rateNodes[0].text) : null,
      openingQtyMilli: parseTallyQty(childText(s, 'OPENINGBALANCE')),
      openingValue: Math.abs(parseTallyAmount(childText(s, 'OPENINGVALUE')))
    })
  }

  for (const v of collect(root, 'VOUCHER')) {
    const isCount = TALLY_PHYSICAL_STOCK_TYPE.test(tallyBaseTypeName(v.attrs.VCHTYPE ?? childText(v, 'VOUCHERTYPENAME'), result.voucherTypes))
    const date = parseTallyDate(childText(v, 'DATE'))
    if (!date) {
      warnings.push(`Voucher skipped: bad date "${childText(v, 'DATE')}"`)
      continue
    }
    const entryLists = [
      ...v.children.filter((c) => c.tag === 'ALLLEDGERENTRIES.LIST'),
      ...v.children.filter((c) => c.tag === 'LEDGERENTRIES.LIST')
    ]
    const lines: TallyVoucherLine[] = []
    for (const e of entryLists) {
      const ledger = childText(e, 'LEDGERNAME')
      const amount = parseTallyAmount(childText(e, 'AMOUNT'))
      if (!ledger || amount === 0) continue
      const deemedPositive = childText(e, 'ISDEEMEDPOSITIVE').toLowerCase() === 'yes'
      // Tally: ISDEEMEDPOSITIVE=Yes (amount negative) means debit.
      const drCr: 'dr' | 'cr' = deemedPositive || amount < 0 ? 'dr' : 'cr'
      const bills = billAllocations(e, date, childText(v, 'VOUCHERNUMBER') || date, warnings)
      lines.push({ ledger, drCr, amount: Math.abs(amount), ...(bills.length ? { bills } : {}) })
    }
    // Item lines: invoices list them as ALLINVENTORYENTRIES.LIST, vouchers in voucher (non-invoice)
    // mode and older exports as INVENTORYENTRIES.LIST, stock / manufacturing journals as
    // INVENTORYENTRIESIN.LIST (destination, goods in) and INVENTORYENTRIESOUT.LIST (source, out).
    // ALL… wins when a voucher carries both (the same lines twice).
    // A voucher with the IN / OUT lists takes only them: an ALL… / INVENTORYENTRIES copy beside them
    // would move the same goods twice.
    const all = v.children.filter((c) => c.tag === 'ALLINVENTORYENTRIES.LIST')
    const invNodes: { node: XNode; fixed: 'in' | 'out' | null }[] = [
      ...(hasJournalLists(v) ? [] : all.length ? all : v.children.filter((c) => c.tag === 'INVENTORYENTRIES.LIST')).map((node) => ({ node, fixed: null })),
      ...v.children.filter((c) => c.tag === 'INVENTORYENTRIESIN.LIST').map((node) => ({ node, fixed: 'in' as const })),
      ...v.children.filter((c) => c.tag === 'INVENTORYENTRIESOUT.LIST').map((node) => ({ node, fixed: 'out' as const }))
    ]
    const inventory: TallyInventoryLine[] = []
    for (const { node: inv, fixed } of invNodes) {
      const item = childText(inv, 'STOCKITEMNAME')
      if (!item) continue
      const signed = parseTallyAmount(childText(inv, 'AMOUNT'))
      const deemed = childText(inv, 'ISDEEMEDPOSITIVE').toLowerCase()
      const direction = fixed ?? (deemed === 'yes' ? 'in' : deemed === 'no' ? 'out' : signed < 0 ? 'in' : 'out')
      const line: TallyInventoryLine = { item, qtyMilli: parseTallyQty(childText(inv, 'ACTUALQTY') || childText(inv, 'BILLEDQTY')), amount: Math.abs(signed), direction }
      inventory.push(...godownSplit(inv, line, childText(v, 'VOUCHERNUMBER') || date, warnings, isCount))
    }
    const vchType = v.attrs.VCHTYPE ?? childText(v, 'VOUCHERTYPENAME')
    // Orders post nothing: they go to trade_docs (WP 6.3, design §8 Q8). Each inventory entry is
    // a line; its BATCHALLOCATIONS carry the godown and ORDERDUEDATE. Job-work orders have no
    // trade-doc kind and are skipped.
    if (TALLY_ORDER_TYPE.test(vchType)) {
      const number = childText(v, 'VOUCHERNUMBER')
      const kind = /purchase/i.test(vchType) ? 'purchase_order' : /sales/i.test(vchType) ? 'sales_order' : null
      if (!kind) {
        warnings.push(`${vchType} ${number || date} skipped: job-work orders are not imported`)
        continue
      }
      const orderLines: TallyOrderLine[] = []
      for (const inv of v.children.filter((c) => c.tag === 'ALLINVENTORYENTRIES.LIST' || c.tag === 'INVENTORYENTRIES.LIST')) {
        const item = childText(inv, 'STOCKITEMNAME')
        const qtyMilli = parseTallyQty(childText(inv, 'ACTUALQTY') || childText(inv, 'BILLEDQTY'))
        if (!item || qtyMilli <= 0) continue
        const batch = inv.children.find((c) => c.tag === 'BATCHALLOCATIONS.LIST')
        const due = batch?.children.find((c) => c.tag === 'ORDERDUEDATE')
        orderLines.push({
          item,
          qtyMilli,
          ratePaise: parseTallyRate(childText(inv, 'RATE')),
          amount: Math.abs(parseTallyAmount(childText(inv, 'AMOUNT'))),
          godown: (batch && childText(batch, 'GODOWNNAME')) || null,
          dueDate: due ? (parseTallyLooseDate(due.text) ?? parseTallyLooseDate(due.attrs.P ?? '')) : null
        })
      }
      if (orderLines.length === 0) {
        warnings.push(`${vchType} ${number || date} skipped: an order without item lines`)
        continue
      }
      result.orders.push({
        kind, vchType, date, number, party: childText(v, 'PARTYLEDGERNAME') || null, narration: childText(v, 'NARRATION') || null,
        reference: childText(v, 'REFERENCE') || null, lines: orderLines
      })
      continue
    }
    // A delivery / receipt note moves goods only — it legitimately has no ledger entries (WP 2.5);
    // so does a stock / manufacturing journal (goods in and out, no ledger entries).
    const baseType = tallyBaseTypeName(vchType, result.voucherTypes)
    // Separators read as one space ("Stock-Journal"), as kindForName reads them.
    const typeWords = baseType.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    const goodsOnly = TALLY_STOCK_NOTE_TYPE.test(typeWords) || TALLY_STOCK_JOURNAL_TYPE.test(typeWords) || TALLY_PHYSICAL_STOCK_TYPE.test(typeWords) || hasJournalLists(v)
    if (lines.length === 0 && !(inventory.length > 0 && goodsOnly)) {
      warnings.push(`Voucher ${childText(v, 'VOUCHERNUMBER') || date} skipped: no ledger entries`)
      continue
    }
    result.vouchers.push({
      vchType,
      date,
      number: childText(v, 'VOUCHERNUMBER'),
      party: childText(v, 'PARTYLEDGERNAME') || null,
      narration: childText(v, 'NARRATION') || null,
      ...(childText(v, 'ISOPTIONAL').toLowerCase() === 'yes' ? { isOptional: true } : {}),
      lines,
      inventory
    })
  }

  return result
}
