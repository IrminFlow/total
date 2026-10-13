// WP 8.0 item defaults, shared by the quick "New stock item" modal and the Masters item form.
import { chargesGst, type GstRegistrationType } from '@shared/gst/registration'

/** The unit a new item starts with: Pcs, else Nos, else the first unit listed. */
export function defaultUnitId(units: readonly { id: number; symbol: string }[] | undefined): number | null {
  if (!units?.length) return null
  const by = (sym: string): number | undefined => units.find((u) => u.symbol.toLowerCase() === sym)?.id
  return by('pcs') ?? by('nos') ?? units[0]!.id
}

/** Does the item dialog show (and save) GST / cess rates? Only in a regular registration. */
export const itemShowsGst = (type: GstRegistrationType | null | undefined): boolean => chargesGst(type)

/** HSN on items / ledgers: a registered company needs it (a composition bill of supply too —
 *  rule 49(e)); an unregistered business doesn't. */
export const itemShowsHsn = (type: GstRegistrationType | null | undefined): boolean => type !== 'unregistered'

/** A NEW item in a regular company needs a GST rate (blank by default — the user picks it; 0
 *  for nil-rated / exempt goods). Null = fine. */
export function newItemGstRateError(type: GstRegistrationType | null | undefined, rateText: string): string | null {
  if (!itemShowsGst(type)) return null
  const t = rateText.trim()
  if (!t) return 'Pick the GST rate for this item (0 if it is nil-rated or exempt)'
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0 || n > 100) return 'The GST rate must be a percentage between 0 and 100'
  return null
}
