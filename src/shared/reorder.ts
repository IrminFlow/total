/**
 * Telling somebody what to reorder (roadmap #121).
 *
 * The purchase suggestions report already knows what has fallen below its reorder level and who
 * it was last bought from. What it never did was reach the supplier: the person still had to
 * copy the list into a message. This turns the report into one draft per supplier, opened through
 * wa.me or a mailto — the app never sends anything, it fills the message in and a person presses
 * send.
 *
 * The channel choice and the number handling are deliberately the same as the payment reminder in
 * outstanding.ts, down to reusing `whatsappNumber`: two different opinions about what counts as a
 * valid Indian mobile is one of them being wrong.
 *
 * Pure: no Electron, no DB.
 */
import { formatPaise } from './money'
import { whatsappNumber } from './outstanding'
import type { PurchaseSuggestionRow } from './reports'

export interface ReorderCompany {
  name: string
}

/** Contact details for the supplier of an item's last purchase. */
export interface ReorderSupplier {
  ledgerId: number
  name: string
  email: string | null
  phone: string | null
}

export interface ReorderMessage {
  supplierLedgerId: number
  supplierName: string
  subject: string
  body: string
  mailto: string
  /** A wa.me link, when the supplier has a number WhatsApp can use. Null when it cannot be built. */
  whatsapp: string | null
  items: PurchaseSuggestionRow[]
  /** Sum of the item estimates, in paise. Zero when nothing has a known last price. */
  estimatedTotal: number
}

export interface ReorderAlerts {
  asOn: string
  messages: ReorderMessage[]
  /**
   * Items below their reorder level that no supplier can be named for — never purchased, or
   * purchased on a voucher with no party. Listed separately instead of being dropped: "nothing
   * to order" and "we do not know who to ask" are different answers.
   */
  unsourced: PurchaseSuggestionRow[]
}

const fmtQty = (r: PurchaseSuggestionRow): string =>
  `${(r.shortfallQtyMilli / 1000).toFixed(r.decimals)} ${r.unitSymbol}`

/**
 * The body of one supplier's enquiry.
 *
 * The last price we paid is stated as exactly that — a price we paid once, not a price we expect.
 * Sending a supplier a number and calling it the order value invites an argument on delivery;
 * asking them to confirm it invites a quote.
 */
function bodyFor(company: ReorderCompany, supplier: ReorderSupplier, items: PurchaseSuggestionRow[]): string {
  const priced = items.filter((r) => r.estimatedCost != null)
  const total = priced.reduce((s, r) => s + (r.estimatedCost ?? 0), 0)
  return [
    `Dear ${supplier.name},`,
    '',
    'We are running low on the following and would like to place an order:',
    '',
    ...items.map((r) => {
      const rate = r.lastRatePaise == null ? '' : `  (last paid ${formatPaise(r.lastRatePaise, { symbol: true })} per ${r.unitSymbol})`
      return `  ${r.name}  —  ${fmtQty(r)}${rate}`
    }),
    ...(total > 0
      ? ['', `Approximately ${formatPaise(total, { symbol: true })} at the prices we last paid — please confirm your current rates and availability.`]
      : ['', 'Please confirm your current rates and availability.']),
    '',
    'Regards,',
    company.name
  ].join('\n')
}

/**
 * Group the reorder list into one draft per supplier, biggest order first.
 *
 * Grouping is by supplier rather than by item because the message is what gets sent: five items
 * from one supplier is one message, not five. Order is by estimated value so the enquiry worth
 * making first is the one at the top.
 */
export function buildReorderMessages(
  company: ReorderCompany,
  rows: PurchaseSuggestionRow[],
  suppliers: Map<number, ReorderSupplier>,
  asOn: string
): ReorderAlerts {
  const bySupplier = new Map<number, PurchaseSuggestionRow[]>()
  const unsourced: PurchaseSuggestionRow[] = []

  for (const row of rows) {
    const id = row.lastSupplierLedgerId
    // A supplier the ledger no longer has is as unreachable as one that was never recorded.
    if (id == null || !suppliers.has(id)) {
      unsourced.push(row)
      continue
    }
    const list = bySupplier.get(id) ?? []
    list.push(row)
    bySupplier.set(id, list)
  }

  const messages: ReorderMessage[] = []
  for (const [ledgerId, items] of bySupplier) {
    const supplier = suppliers.get(ledgerId)!
    const subject = `Reorder enquiry from ${company.name}`
    const body = bodyFor(company, supplier, items)
    const number = whatsappNumber(supplier.phone)
    messages.push({
      supplierLedgerId: ledgerId,
      supplierName: supplier.name,
      subject,
      body,
      mailto: `mailto:${supplier.email ?? ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
      // Same text down both channels, so what the user previews is what the supplier receives.
      whatsapp: number ? `https://wa.me/${number}?text=${encodeURIComponent(body)}` : null,
      items,
      estimatedTotal: items.reduce((s, r) => s + (r.estimatedCost ?? 0), 0)
    })
  }

  messages.sort((a, b) => b.estimatedTotal - a.estimatedTotal || a.supplierName.localeCompare(b.supplierName))
  return { asOn, messages, unsourced }
}
