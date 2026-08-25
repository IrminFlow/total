import { GST_STATES } from './states'
import { validateGstin } from './validate'

/**
 * GST registrations of one business (roadmap #108).
 *
 * A business with one PAN and premises in several states holds a separate registration per
 * state. It is ONE set of books — one P&L, one balance sheet, one chart of accounts — but
 * returns are filed per GSTIN, and the place-of-supply rule that decides CGST+SGST against
 * IGST is computed from the state of the registration that MADE the supply, not from a
 * single company-level state.
 *
 * Everything in this file is pure: the database side lives in
 * `src/main/services/registrations.ts`.
 */

export interface GstRegistration {
  id: number
  /** NULL is legitimate: an unregistered company still has one row here, its state. */
  gstin: string | null
  /** Two-digit GST state code. The registration's state, which is what decides intra/inter. */
  stateCode: string
  /** Trade name at this registration — often not the legal name (rule 46(b) "trade name"). */
  tradeName: string
  address: string | null
  /** ISO date the registration was granted, or null if never recorded. */
  registeredOn: string | null
  /** ISO date it was surrendered/cancelled. Non-null means it files no more returns. */
  surrenderedOn: string | null
  isPrimary: boolean
}

/** What a caller supplies to create or edit one. */
export interface GstRegistrationInput {
  id?: number | null
  gstin: string | null
  stateCode: string
  tradeName: string
  address: string | null
  registeredOn: string | null
  surrenderedOn: string | null
  isPrimary?: boolean
}

/**
 * Rules a registration must satisfy before it can be saved.
 *
 * The load-bearing one is the first two digits: a GSTIN encodes its own state code, and a row
 * whose `stateCode` disagreed with its GSTIN would tax every supply from it against the wrong
 * state — silently, and only in one direction (CGST/SGST where IGST was due, or the reverse),
 * which is exactly the error the department picks up and the books never do.
 */
export function validateRegistration(input: GstRegistrationInput): string[] {
  const errors: string[] = []
  if (!input.tradeName.trim()) errors.push('Trade name is required')
  if (!(input.stateCode in GST_STATES)) {
    errors.push(`Unknown GST state code "${input.stateCode}"`)
  }
  if (input.gstin) {
    const v = validateGstin(input.gstin)
    if (!v.valid) errors.push(`GSTIN is not valid (${v.error})`)
    else if (v.stateCode !== input.stateCode) {
      errors.push(`GSTIN starts ${v.stateCode} but the state code says ${input.stateCode}`)
    }
  }
  if (input.registeredOn && input.surrenderedOn && input.surrenderedOn < input.registeredOn) {
    errors.push('Surrendered date is before the registered date')
  }
  return errors
}

/** Was this registration live on `date`? A surrendered registration files nothing after. */
export function isActiveOn(reg: GstRegistration, date: string): boolean {
  if (reg.registeredOn && date < reg.registeredOn) return false
  if (reg.surrenderedOn && date > reg.surrenderedOn) return false
  return true
}

export function primaryOf(regs: GstRegistration[]): GstRegistration | null {
  return regs.find((r) => r.isPrimary) ?? regs[0] ?? null
}

export function findById(regs: GstRegistration[], id: number | null | undefined): GstRegistration | null {
  if (id == null) return null
  return regs.find((r) => r.id === id) ?? null
}

/**
 * Which registration a voucher belongs to, given whatever the voucher recorded.
 *
 * A voucher with no registration is every voucher that existed before this feature. It resolves
 * to the primary, and it must KEEP resolving to the primary — which is why the migration stamps
 * the primary onto every such row rather than leaving the answer to be re-derived later. This
 * function is the safety net for anything the stamp missed, not the mechanism.
 */
export function resolveRegistration(
  regs: GstRegistration[],
  voucherRegistrationId: number | null | undefined
): GstRegistration | null {
  return findById(regs, voucherRegistrationId) ?? primaryOf(regs)
}

/**
 * The registration a new supply should default to.
 *
 * Preference order: the registration the godown/branch belongs to (goods leaving a Gujarat
 * warehouse are supplied by the Gujarat registration), then the primary. A surrendered
 * registration is never defaulted to, but IS honoured when explicitly named — back-dated entry
 * into a period when it was live is ordinary work.
 */
export function defaultRegistrationFor(
  regs: GstRegistration[],
  opts: { godownRegistrationId?: number | null; date?: string | null } = {}
): GstRegistration | null {
  const byGodown = findById(regs, opts.godownRegistrationId)
  if (byGodown && (!opts.date || isActiveOn(byGodown, opts.date))) return byGodown
  return primaryOf(regs)
}

/** Label for a picker: "27 · Maharashtra — 27AAAAA0000A1Z5". */
export function registrationLabel(reg: GstRegistration): string {
  const state = GST_STATES[reg.stateCode] ?? reg.stateCode
  return `${reg.stateCode} · ${state}${reg.gstin ? ` — ${reg.gstin}` : ' — unregistered'}`
}

/**
 * A stock movement that crossed from one registration to another.
 *
 * Under Schedule I para 2 of the CGST Act a supply between two registrations of the same
 * person is a supply even though it is made without consideration, and it is taxable: the
 * sending registration raises a tax invoice (rule 55 does NOT cover it — a delivery challan is
 * only for the movements listed there), values it under rule 28, and reports it in its GSTR-1;
 * the receiving registration takes the credit.
 *
 * `crossRegistrationTransfers` on the main side finds them and this shapes the finding. The
 * invoice itself is now raised — see `src/shared/gst/branchTransfer.ts` and
 * `src/main/services/branchTransfer.ts` — and what is still REPORTED here is what has no document
 * yet, so the warning shrinks as the work is done. See `docs/roadmap.md` #108.
 */
export interface CrossRegistrationTransfer {
  voucherId: number
  date: string
  number: string
  fromRegistrationId: number
  fromGstin: string | null
  fromStateCode: string
  toRegistrationId: number
  toGstin: string | null
  toStateCode: string
  /** Book value of the goods moved, in paise. NOT the taxable value: rule 28 governs that. */
  valuePaise: number
}
