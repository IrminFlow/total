// WP 2.6 — IPC payload schemas for pricing (party-wise rates, discount schemes, price-list tools,
// the resolver) and counter billing. Kept apart from schemas.ts so the pricing surface reads in
// one place; every IPC handler still Zod-parses through these.
import { z } from 'zod'
import { isoDate } from './schemas'

const id = z.number().int().positive()
const paise = z.number().int().safe()
const bp = z.number().int().min(0).max(10000)
const milli = z.number().int().min(0)

// ---------------------------------------------------------------- party-wise rates

export const partyRateInputSchema = z
  .object({
    ledgerId: id,
    stockItemId: id,
    ratePaise: paise.min(0),
    discountBp: bp.default(0),
    effectiveFrom: isoDate.nullable().default(null),
    effectiveTo: isoDate.nullable().default(null)
  })
  .refine((r) => r.effectiveTo == null || r.effectiveFrom == null || r.effectiveTo >= r.effectiveFrom, 'The end date is before the start date')
export type PartyRateInput = z.input<typeof partyRateInputSchema>

// ---------------------------------------------------------------- discount schemes

export const SCHEME_KINDS = ['qty_slab', 'value_slab', 'buy_x_get_y', 'flat'] as const
export const SCHEME_KIND_LABELS: Record<(typeof SCHEME_KINDS)[number], string> = {
  qty_slab: 'Quantity slabs',
  value_slab: 'Value slabs',
  buy_x_get_y: 'Buy X get Y free',
  flat: 'Flat discount'
}

export const schemeSlabSchema = z.object({
  minQtyMilli: milli.nullable().default(null),
  minValuePaise: paise.min(0).nullable().default(null),
  discountBp: bp.nullable().default(null),
  freeQtyMilli: z.number().int().positive().nullable().default(null)
})

export const discountSchemeInputSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    kind: z.enum(SCHEME_KINDS),
    appliesTo: z.enum(['item', 'group', 'all']),
    targetId: id.nullable().default(null),
    fromDate: isoDate.nullable().default(null),
    toDate: isoDate.nullable().default(null),
    priority: z.number().int().min(-100).max(100).default(0),
    active: z.boolean().default(true),
    slabs: z.array(schemeSlabSchema).min(1, 'Add at least one slab').max(20)
  })
  .superRefine((s, ctx) => {
    if ((s.appliesTo === 'all') !== (s.targetId == null)) {
      ctx.addIssue({ code: 'custom', message: s.appliesTo === 'all' ? 'A scheme for everything has no target' : `Pick the ${s.appliesTo === 'item' ? 'item' : 'stock group'}` })
    }
    if (s.toDate && s.fromDate && s.toDate < s.fromDate) ctx.addIssue({ code: 'custom', message: 'The end date is before the start date' })
    s.slabs.forEach((sl, i) => {
      const at = `Slab ${i + 1}: `
      if (s.kind === 'buy_x_get_y') {
        if (!sl.minQtyMilli || !sl.freeQtyMilli) ctx.addIssue({ code: 'custom', message: `${at}enter the quantity to buy and the quantity free` })
        if (sl.discountBp != null || sl.minValuePaise != null) ctx.addIssue({ code: 'custom', message: `${at}buy-x-get-y slabs carry quantities only` })
      } else {
        if (sl.discountBp == null) ctx.addIssue({ code: 'custom', message: `${at}enter the discount %` })
        if (sl.freeQtyMilli != null) ctx.addIssue({ code: 'custom', message: `${at}free quantity is for buy-x-get-y schemes` })
        if (s.kind === 'value_slab' && (sl.minValuePaise == null || sl.minQtyMilli != null)) ctx.addIssue({ code: 'custom', message: `${at}enter the minimum line value` })
        if (s.kind !== 'value_slab' && (sl.minValuePaise != null || (s.kind === 'qty_slab' && sl.minQtyMilli == null))) {
          ctx.addIssue({ code: 'custom', message: `${at}enter the minimum quantity` })
        }
      }
    })
  })
export type DiscountSchemeInput = z.input<typeof discountSchemeInputSchema>

// ---------------------------------------------------------------- price-list tools

export const bulkRateUpdateSchema = z.object({
  priceLevelId: id,
  /** Signed basis points: 500 = +5%, -250 = −2.5%. */
  changeBp: z.number().int().min(-9900).max(100000),
  /** Round the new rate to a multiple of this many paise (1 = paisa, 100 = rupee). */
  roundToPaise: z.number().int().min(1).max(100000).default(1),
  /** Restrict to these items (default: every row of the level). */
  stockItemIds: z.array(id).max(5000).optional(),
  /** The rows in force on this date are re-priced: from this date as a new row (the old row
   *  closes the day before), or in place when it starts that day. Absent = in place. */
  effectiveFrom: isoDate.optional()
})
export type BulkRateUpdate = z.infer<typeof bulkRateUpdateSchema>

export const copyLevelSchema = z.object({
  fromLevelId: id,
  /** Name of the new level (created). */
  name: z.string().trim().min(1).max(60),
  /** Signed basis points applied while copying (0 = same rates). */
  changeBp: z.number().int().min(-9900).max(100000).default(0),
  inclusiveOfTax: z.boolean().optional()
})

export const ratesCsvImportSchema = z.object({ csvText: z.string().max(5_000_000), dryRun: z.boolean().default(false) })

// ---------------------------------------------------------------- config

export const pricingConfigSchema = z.object({
  /** Invoice entry fills and re-prices auto lines through the resolver. */
  autoApply: z.boolean().default(true),
  /** Saving a sales invoice remembers each line's rate as the party + item's last price. */
  rememberLastPrice: z.boolean().default(false)
})
export type PricingConfig = z.output<typeof pricingConfigSchema>

// ---------------------------------------------------------------- resolver

export const priceResolveSchema = z.object({
  date: isoDate,
  partyLedgerId: id.nullable().default(null),
  currency: z.string().trim().max(3).default(''),
  supply: z.enum(['intra', 'inter']).default('intra'),
  lines: z.array(z.object({ key: z.number().int(), itemId: id, qtyMilli: milli })).min(1).max(500)
})

// ---------------------------------------------------------------- counter billing

export const PAYMENT_MODES = ['cash', 'upi', 'card'] as const
export type PaymentMode = (typeof PAYMENT_MODES)[number]
export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = { cash: 'Cash', upi: 'UPI', card: 'Card' }

export const counterConfigSchema = z.object({
  /** The walk-in party (default: a "Cash sale" ledger under Sundry Debtors, created on first use). */
  walkInLedgerId: id.nullable().default(null),
  salesLedgerId: id.nullable().default(null),
  voucherTypeId: id.nullable().default(null),
  receiptTypeId: id.nullable().default(null),
  cashLedgerId: id.nullable().default(null),
  upiLedgerId: id.nullable().default(null),
  cardLedgerId: id.nullable().default(null),
  godownId: id.nullable().default(null),
  /** Print template for the bill: the thermal 'receipt-80mm' built-in or any other. */
  templateId: z.string().min(1).max(60).default('receipt-80mm'),
  /** Print the bill straight after checkout. */
  autoPrint: z.boolean().default(true)
})
export type CounterConfig = z.output<typeof counterConfigSchema>

export const counterLineSchema = z.object({
  itemId: id,
  qtyMilli: z.number().int().positive(),
  ratePaise: paise.min(0),
  discountPaise: paise.min(0).default(0)
})

export const counterCheckoutSchema = z.object({
  date: isoDate,
  /** null = the walk-in party. */
  partyLedgerId: id.nullable().default(null),
  lines: z.array(counterLineSchema).min(1, 'Add an item').max(500),
  payments: z.array(z.object({ mode: z.enum(PAYMENT_MODES), amountPaise: paise.min(0) })).max(3).default([]),
  /** Cash handed over (≥ the cash payment); the difference is the change. */
  tenderedPaise: paise.min(0).default(0),
  narration: z.string().trim().max(500).nullable().default(null)
})
export type CounterCheckoutInput = z.input<typeof counterCheckoutSchema>

export const heldBillSchema = z.object({
  label: z.string().trim().max(60).default(''),
  partyLedgerId: id.nullable().default(null),
  lines: z.array(counterLineSchema.extend({ rateSource: z.enum(['auto', 'manual']).default('auto') })).min(1).max(500)
})
export type HeldBillInput = z.input<typeof heldBillSchema>
