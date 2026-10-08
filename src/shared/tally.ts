import { decimalToScaled } from './dataImport/values'
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

/** Parse an XML document into a tree. Tolerates declarations, comments and Tally's quirks. */
export function parseXml(input: string): XNode {
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
}
export interface TallyUnit { name: string; decimals: number }
export interface TallyItem {
  name: string
  unit: string
  hsn: string | null
  gstRate: number | null
  openingQtyMilli: number
  openingValue: number
}
export interface TallyVoucherLine { ledger: string; drCr: 'dr' | 'cr'; amount: number }
export interface TallyInventoryLine { item: string; qtyMilli: number; amount: number }
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

export function parseTallyExport(xml: string): TallyImport {
  const root = parseXml(xml)
  const warnings: string[] = []
  const result: TallyImport = { groups: [], ledgers: [], units: [], items: [], vouchers: [], orders: [], booksFrom: null, warnings }

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
    result.ledgers.push({
      name,
      parent: childText(l, 'PARENT'),
      // Tally: negative = debit. Ours: positive = debit.
      opening: -openingTally,
      gstin: childText(l, 'PARTYGSTIN') || childText(l, 'GSTREGISTRATIONNUMBER') || null,
      stateName: childText(l, 'LEDSTATENAME') || null
    })
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
      lines.push({ ledger, drCr, amount: Math.abs(amount) })
    }
    const inventory: TallyInventoryLine[] = []
    for (const inv of v.children.filter((c) => c.tag === 'ALLINVENTORYENTRIES.LIST')) {
      const item = childText(inv, 'STOCKITEMNAME')
      if (!item) continue
      inventory.push({
        item,
        qtyMilli: parseTallyQty(childText(inv, 'ACTUALQTY') || childText(inv, 'BILLEDQTY')),
        amount: Math.abs(parseTallyAmount(childText(inv, 'AMOUNT')))
      })
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
    // A delivery / receipt note moves goods only — it legitimately has no ledger entries (WP 2.5).
    if (lines.length === 0 && !(inventory.length > 0 && TALLY_STOCK_NOTE_TYPE.test(vchType))) {
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
