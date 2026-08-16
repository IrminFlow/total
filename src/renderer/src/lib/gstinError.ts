import { GST_STATES } from '@shared/gst/states'
import { validateGstin } from '@shared/gst/validate'

/** Human message for each machine-readable validateGstin failure. */
const GSTIN_ERROR_MESSAGES: Record<string, string> = {
  length: 'A GSTIN has 15 characters',
  format: 'That doesn’t look like a GSTIN',
  state_code: 'Unknown state code',
  checksum: 'Check digit doesn’t match — one character is off'
}

/**
 * Specific, per-failure GSTIN error message (shared by CompanySelect's create form and
 * CompanyInfo). Also flags a valid GSTIN whose embedded state code disagrees with the
 * selected state. Returns null when the GSTIN is empty or fine.
 */
export function gstinErrorMessage(gstin: string, stateCode: string): string | null {
  if (!gstin.trim()) return null
  const check = validateGstin(gstin)
  if (!check.valid) return GSTIN_ERROR_MESSAGES[check.error!] ?? 'Invalid GSTIN'
  if (check.stateCode !== stateCode)
    return `GSTIN says ${GST_STATES[check.stateCode!] ?? check.stateCode} but the state above differs`
  return null
}
