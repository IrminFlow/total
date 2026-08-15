import { GST_STATES } from './states'

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
