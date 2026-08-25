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
const MAX_XML_DEPTH = 256
const MAX_XML_NODES = 500_000

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, body: string) => {
    const numeric = body.startsWith('#x') || body.startsWith('#X')
      ? parseInt(body.slice(2), 16)
      : body.startsWith('#')
        ? parseInt(body.slice(1), 10)
        : null
    if (numeric !== null)
      return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
        ? String.fromCodePoint(numeric)
        : '\ufffd'
    return ENTITIES[body] ?? m
  })
}

/** Parse an XML document into a tree. Tolerates declarations, comments and Tally's quirks. */
export function parseXml(input: string): XNode {
  const root: XNode = { tag: '#root', attrs: {}, children: [], text: '' }
  const stack: XNode[] = [root]
  let i = 0
  let nodeCount = 0
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
    nodeCount++
    if (nodeCount > MAX_XML_NODES)
      throw new Error(`Tally XML exceeds the ${MAX_XML_NODES.toLocaleString('en-IN')} node safety limit`)
    stack[stack.length - 1]!.children.push(node)
    if (!selfClosing) {
      if (stack.length >= MAX_XML_DEPTH)
        throw new Error(`Tally XML nesting exceeds the ${MAX_XML_DEPTH}-level safety limit`)
      stack.push(node)
    }
  }
  return root
}

/** All descendant nodes with the given tag (depth-first). */
export function collect(node: XNode, tag: string): XNode[] {
  const out: XNode[] = []
  const pending: XNode[] = [...node.children].reverse()
  while (pending.length) {
    const current = pending.pop()!
    if (current.tag === tag) out.push(current)
    for (let index = current.children.length - 1; index >= 0; index--)
      pending.push(current.children[index]!)
  }
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
}

export interface TallyImport {
  groups: TallyGroup[]
  ledgers: TallyLedger[]
  units: TallyUnit[]
  items: TallyItem[]
  vouchers: TallyVoucher[]
  warnings: string[]
}

const nameOf = (n: XNode): string => n.attrs.NAME ?? childText(n, 'NAME')

/** Parse a Tally master/voucher export XML into neutral structures. */
export function parseTallyExport(xml: string): TallyImport {
  const root = parseXml(xml)
  const warnings: string[] = []
  const result: TallyImport = { groups: [], ledgers: [], units: [], items: [], vouchers: [], warnings }

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
    if (lines.length === 0) {
      warnings.push(`Voucher ${childText(v, 'VOUCHERNUMBER') || date} skipped: no ledger entries`)
      continue
    }
    result.vouchers.push({
      vchType: v.attrs.VCHTYPE ?? childText(v, 'VOUCHERTYPENAME'),
      date,
      number: childText(v, 'VOUCHERNUMBER'),
      party: childText(v, 'PARTYLEDGERNAME') || null,
      narration: childText(v, 'NARRATION') || null,
      lines,
      inventory
    })
  }

  return result
}
