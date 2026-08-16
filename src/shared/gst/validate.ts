import { GST_STATES } from './states'
import { B2CL_THRESHOLD_PAISE, type GstDoc } from './returns'
import { isUqc } from './uqc'

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Compute the 15th (check) character for the first 14 characters of a GSTIN. */
export function gstinCheckChar(first14: string): string {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]!)
    const factor = i % 2 === 0 ? 1 : 2
    const prod = v * factor
    sum += Math.floor(prod / 36) + (prod % 36)
  }
  return CHARS[(36 - (sum % 36)) % 36]!
}

export interface GstinValidation {
  valid: boolean
  /** Machine-readable problem, null when valid. */
  error:
    | null
    | 'length'
    | 'format'
    | 'state_code'
    | 'checksum'
  /** State code extracted from the GSTIN (chars 1-2), when format allows. */
  stateCode: string | null
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/

export function validateGstin(raw: string): GstinValidation {
  const gstin = raw.trim().toUpperCase()
  if (gstin.length !== 15) return { valid: false, error: 'length', stateCode: null }
  if (!GSTIN_RE.test(gstin)) {
    const sc = /^\d{2}/.test(gstin) ? gstin.slice(0, 2) : null
    return { valid: false, error: 'format', stateCode: sc }
  }
  const stateCode = gstin.slice(0, 2)
  if (!(stateCode in GST_STATES)) return { valid: false, error: 'state_code', stateCode }
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin[14]) {
    return { valid: false, error: 'checksum', stateCode }
  }
  return { valid: true, error: null, stateCode }
}

/**
 * HSN/SAC codes are 4, 6, or 8 digits (2-digit chapters exist but returns require ≥4).
 * Businesses over ₹5 crore turnover must use 6+ digits; we surface that as advice, not an error.
 */
export function validateHsn(raw: string): { valid: boolean; error: string | null } {
  const hsn = raw.trim()
  if (!/^\d+$/.test(hsn)) return { valid: false, error: 'HSN must be digits only' }
  if (![4, 6, 8].includes(hsn.length)) {
    return { valid: false, error: 'HSN must be 4, 6 or 8 digits' }
  }
  return { valid: true, error: null }
}

// ---------- pre-export GSTR-1 validation (the export gate) ----------

export interface GstIssue {
  code:
    | 'missing_hsn'
    | 'missing_gstin'
    | 'invalid_gstin'
    | 'invalid_uqc'
    | 'val_mismatch'
    | 'duplicate_number'
    | 'composition'
    | 'rate_zero_untyped'
    | 'b2cl_edge'
  severity: 'blocking' | 'warning'
  message: string
  /** Vouchers to drill into from the issues panel (empty for company-level issues). */
  voucherIds: number[]
}

export interface Gstr1ValidationCompany {
  stateCode: string
  gstin: string | null
  gstRegistrationType: 'regular' | 'composition' | 'unregistered'
}

/** Booked-vs-computed invoice value differences within ±₹1 are treated as legitimate round-off. */
export const VAL_MISMATCH_TOLERANCE_PAISE = 100

/**
 * Validate the extracted document set before any GSTR-1/EWB export. Blocking issues must be
 * cleared before the export buttons enable (the IPC layer refuses too); warnings only inform.
 */
export function validateGstr1(docs: GstDoc[], company: Gstr1ValidationCompany): GstIssue[] {
  const issues: GstIssue[] = []

  // Composition dealers file CMP-08/GSTR-4, never GSTR-1 — exporting one would just be
  // rejected by the portal, so this blocks with an explanation instead of failing there.
  if (company.gstRegistrationType === 'composition') {
    issues.push({
      code: 'composition',
      severity: 'blocking',
      message:
        'This company is registered under the composition scheme — composition dealers file CMP-08/GSTR-4, not GSTR-1.',
      voucherIds: []
    })
  }

  const missingHsn = docs.filter((d) => (d.validation?.missingHsnCount ?? 0) > 0)
  if (missingHsn.length) {
    const lines = missingHsn.reduce((s, d) => s + (d.validation?.missingHsnCount ?? 0), 0)
    issues.push({
      code: 'missing_hsn',
      severity: 'blocking',
      message: `${lines} line${lines === 1 ? '' : 's'} across ${missingHsn.length} voucher${missingHsn.length === 1 ? '' : 's'} missing an HSN/SAC — Table 12 will not tie to the invoice tables.`,
      voucherIds: missingHsn.map((d) => d.voucherId)
    })
  }

  const missingGstin = docs.filter((d) => d.validation?.missingGstin)
  if (missingGstin.length) {
    issues.push({
      code: 'missing_gstin',
      severity: 'blocking',
      message: `${missingGstin.length} SEZ/deemed-export document${missingGstin.length === 1 ? '' : 's'} missing the buyer GSTIN.`,
      voucherIds: missingGstin.map((d) => d.voucherId)
    })
  }

  const badGstin = docs.filter((d) => d.partyGstin && !validateGstin(d.partyGstin).valid)
  if (badGstin.length) {
    issues.push({
      code: 'invalid_gstin',
      severity: 'blocking',
      message: `${badGstin.length} document${badGstin.length === 1 ? '' : 's'} carry an invalid buyer GSTIN (checksum/format).`,
      voucherIds: badGstin.map((d) => d.voucherId)
    })
  }

  const badUqc = docs.filter((d) => d.hsnLines.some((h) => !isUqc(h.uqc)))
  if (badUqc.length) {
    issues.push({
      code: 'invalid_uqc',
      severity: 'blocking',
      message: `${badUqc.length} document${badUqc.length === 1 ? '' : 's'} use a unit whose UQC is not a valid portal code — fix the unit master (Masters → Units).`,
      voucherIds: badUqc.map((d) => d.voucherId)
    })
  }

  const valMismatch = docs.filter((d) => Math.abs(d.validation?.valDiff ?? 0) > VAL_MISMATCH_TOLERANCE_PAISE)
  if (valMismatch.length) {
    issues.push({
      code: 'val_mismatch',
      severity: 'blocking',
      message: `${valMismatch.length} document${valMismatch.length === 1 ? '' : 's'} where the booked total differs from taxable + computed tax by more than ₹1 — tax lines were likely hand-edited.`,
      voucherIds: valMismatch.map((d) => d.voucherId)
    })
  }

  const byNumber = new Map<string, GstDoc[]>()
  for (const d of docs) {
    if (d.kind !== 'sales') continue
    const list = byNumber.get(d.number) ?? []
    list.push(d)
    byNumber.set(d.number, list)
  }
  const dupes = [...byNumber.values()].filter((list) => list.length > 1)
  if (dupes.length) {
    issues.push({
      code: 'duplicate_number',
      severity: 'blocking',
      message: `Duplicate invoice numbers in the period: ${dupes.map((l) => l[0]!.number).join(', ')} — the portal rejects repeated document numbers.`,
      voucherIds: dupes.flat().map((d) => d.voucherId)
    })
  }

  // Warnings.
  const rate0 = docs.filter((d) => (d.nilLines?.length ?? 0) > 0 || d.items.some((i) => i.rate === 0))
  if (rate0.length) {
    issues.push({
      code: 'rate_zero_untyped',
      severity: 'warning',
      message: `${rate0.length} document${rate0.length === 1 ? '' : 's'} carry rate-0 lines — reported as nil-rated in Table 8. If these are exempt or non-GST supplies the classification cannot be represented yet.`,
      voucherIds: rate0.map((d) => d.voucherId)
    })
  }

  const edge = docs.filter(
    (d) =>
      d.kind === 'sales' &&
      !d.partyGstin &&
      d.pos !== company.stateCode &&
      d.invoiceValue > B2CL_THRESHOLD_PAISE - 100_000 &&
      d.invoiceValue <= B2CL_THRESHOLD_PAISE
  )
  if (edge.length) {
    issues.push({
      code: 'b2cl_edge',
      severity: 'warning',
      message: `${edge.length} inter-state unregistered invoice${edge.length === 1 ? '' : 's'} within ₹1,000 of the ₹1,00,000 B2CL threshold — reported in B2CS; double-check the value.`,
      voucherIds: edge.map((d) => d.voucherId)
    })
  }

  return issues
}
