import type { DB } from '../db/connection'
import { LABEL_SIZES, labelPreview, labelSize, planLabels, renderLabelsTspl, type LabelSpec } from '@shared/labels'
import { todayISO } from '@shared/dates'
import { rateFor } from './priceLevels'

/**
 * Barcode labels for a thermal printer (roadmap E #111) — the part that needs the books.
 *
 * The command language and the layout are in `@shared/labels`, pure and tested byte for byte. This
 * file turns items into labels: what to print on them, and where the price comes from.
 *
 * The price is the one decision with a wrong answer available. It is taken from the price LEVEL
 * asked for, on the date asked for, and falls back to the item's last purchase rate only when
 * there is no list price at all — never to a weighted-average cost, which is what an item's
 * valuation would give and which is not a selling price by any stretch. A shelf label printed at
 * cost is the most expensive bug in this feature.
 */

export interface LabelRequest {
  stockItemId: number
  copies?: number
  /** Overrides the price list. Used when the operator is labelling a promotion. */
  pricePaise?: number | null
  detail?: string | null
}

export interface LabelJobInput {
  items: LabelRequest[]
  sizeId?: string
  /** Price list to take rates from; null = the item's own last purchase rate. */
  priceLevelId?: number | null
  asOn?: string
  includePrice?: boolean
  humanReadable?: boolean
  speed?: number
  density?: number
}

interface ItemRow {
  id: number
  name: string
  code: string | null
  barcode: string | null
  unitSymbol: string
}

function itemsFor(db: DB, ids: number[]): Map<number, ItemRow> {
  if (ids.length === 0) return new Map()
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT si.id, si.name, si.code, si.barcode, u.symbol AS unitSymbol
         FROM stock_items si JOIN units u ON u.id = si.unit_id
        WHERE si.id IN (${placeholders})`
    )
    .all(...ids) as ItemRow[]
  return new Map(rows.map((r) => [r.id, r]))
}

/**
 * The most recent rate this item was BOUGHT at — the fallback when no price list applies.
 *
 * Deliberately the purchase rate and not the valuation: a weighted average is a cost, and a shelf
 * label showing cost is worse than a shelf label showing no price. The caller can still leave the
 * price off entirely, which is what a label for a stockroom bin wants.
 */
function lastPurchaseRate(db: DB, stockItemId: number, asOn: string): number | null {
  const row = db
    .prepare(
      `SELECT il.rate_paise AS rate
         FROM inventory_lines il
         JOIN vouchers v ON v.id = il.voucher_id
         JOIN voucher_types vt ON vt.id = v.voucher_type_id
        WHERE il.stock_item_id = ? AND il.direction = 'in' AND il.is_absolute = 0
          AND vt.kind = 'purchase' AND v.date <= ? AND v.deleted_at IS NULL
        ORDER BY v.date DESC, il.id DESC LIMIT 1`
    )
    .get(stockItemId, asOn) as { rate: number } | undefined
  return row?.rate ?? null
}

export interface LabelJob {
  specs: LabelSpec[]
  /** Plain-text rendering of each label, so the operator can read the job before sending it. */
  preview: string[][]
  totalLabels: number
  errors: string[]
  sizeId: string
}

/**
 * Build the labels without printing them.
 *
 * Every reason a label cannot be printed comes back at once — an item with no barcode at all is
 * the common one, and a job that stops at the eleventh label leaves the operator with ten labels
 * and no message.
 */
export function planLabelJob(db: DB, input: LabelJobInput): LabelJob {
  const asOn = input.asOn ?? todayISO()
  const size = labelSize(input.sizeId ?? '') ?? LABEL_SIZES[0]!
  const items = itemsFor(db, input.items.map((i) => i.stockItemId))
  const specs: LabelSpec[] = []
  const missing: string[] = []

  for (const req of input.items) {
    const item = items.get(req.stockItemId)
    if (!item) {
      missing.push(`Item ${req.stockItemId} no longer exists`)
      continue
    }
    // The code is a perfectly good thing to encode when there is no barcode — it is what the
    // counter already types — but an item with neither cannot be labelled, and guessing an
    // identifier (the id, the name) prints a barcode that scans to nothing.
    const data = item.barcode ?? item.code
    if (!data) {
      missing.push(`${item.name} has no barcode or item code to print`)
      continue
    }
    let pricePaise: number | undefined
    if (input.includePrice !== false) {
      const listed =
        req.pricePaise ??
        (input.priceLevelId != null ? rateFor(db, input.priceLevelId, req.stockItemId, asOn) : null) ??
        lastPurchaseRate(db, req.stockItemId, asOn)
      if (listed != null) pricePaise = listed
    }
    specs.push({
      barcode: data,
      name: item.name,
      detail: req.detail ?? (item.code && item.barcode ? item.code : null) ?? undefined,
      pricePaise,
      unitSymbol: item.unitSymbol,
      copies: req.copies ?? 1
    })
  }

  const plan = planLabels(specs)
  return {
    specs,
    preview: specs.map((s) => labelPreview(s, size)),
    totalLabels: plan.totalLabels,
    errors: [...missing, ...plan.errors],
    sizeId: size.id
  }
}

/** The bytes that would go to the printer. Throws with every reason when the job is not printable. */
export function renderLabelJob(db: DB, input: LabelJobInput): Uint8Array {
  const job = planLabelJob(db, input)
  if (job.errors.length) throw new Error(job.errors.join('; '))
  return renderLabelsTspl(job.specs, {
    size: labelSize(job.sizeId) ?? LABEL_SIZES[0]!,
    humanReadable: input.humanReadable,
    speed: input.speed,
    density: input.density
  })
}
