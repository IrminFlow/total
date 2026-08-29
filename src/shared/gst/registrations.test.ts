import { describe, expect, it } from 'vitest'
import {
  defaultRegistrationFor,
  isActiveOn,
  primaryOf,
  registrationLabel,
  resolveRegistration,
  validateRegistration,
  type GstRegistration
} from './registrations'
import { supplyTypeFor } from './calc'

const reg = (over: Partial<GstRegistration> = {}): GstRegistration => ({
  id: 1,
  gstin: '27AAAPA1234A1ZT',
  stateCode: '27',
  tradeName: 'Head office',
  address: null,
  registeredOn: null,
  surrenderedOn: null,
  isPrimary: true,
  ...over
})

// A pair of checksum-valid GSTINs, one Maharashtra and one Gujarat, on the same PAN.
const MH = '27AAAPA1234A1ZT'
const GJ = '24AAAPA1234A1ZZ'

describe('validateRegistration', () => {
  it('accepts a GSTIN whose first two digits are its state code', () => {
    expect(validateRegistration({ gstin: MH, stateCode: '27', tradeName: 'HO', address: null, registeredOn: null, surrenderedOn: null }))
      .toEqual([])
  })

  it('refuses a GSTIN whose state prefix disagrees with the state code', () => {
    // The whole feature turns on this: a row saying "Gujarat" while holding a Maharashtra GSTIN
    // would tax every supply from it against the wrong state, in silence and in one direction.
    const errors = validateRegistration({
      gstin: MH, stateCode: '24', tradeName: 'Branch', address: null, registeredOn: null, surrenderedOn: null
    })
    expect(errors.join(' ')).toContain('starts 27')
  })

  it('allows a registration with no GSTIN at all', () => {
    // An unregistered company still holds one row here — its state — so that every GST
    // computation has something to read.
    expect(validateRegistration({ gstin: null, stateCode: '27', tradeName: 'HO', address: null, registeredOn: null, surrenderedOn: null }))
      .toEqual([])
  })

  it('refuses an unknown state code, a blank trade name, and a backwards surrender date', () => {
    expect(validateRegistration({ gstin: null, stateCode: '99', tradeName: 'X', address: null, registeredOn: null, surrenderedOn: null }).length).toBe(1)
    expect(validateRegistration({ gstin: null, stateCode: '27', tradeName: '  ', address: null, registeredOn: null, surrenderedOn: null }).length).toBe(1)
    expect(
      validateRegistration({
        gstin: null, stateCode: '27', tradeName: 'X', address: null,
        registeredOn: '2026-04-01', surrenderedOn: '2026-03-31'
      }).length
    ).toBe(1)
  })
})

describe('isActiveOn', () => {
  const r = reg({ registeredOn: '2025-07-01', surrenderedOn: '2026-03-31' })
  it('is inactive before it was granted and after it was surrendered', () => {
    expect(isActiveOn(r, '2025-06-30')).toBe(false)
    expect(isActiveOn(r, '2025-07-01')).toBe(true)
    expect(isActiveOn(r, '2026-03-31')).toBe(true)
    expect(isActiveOn(r, '2026-04-01')).toBe(false)
  })
  it('with no dates recorded is active always — an absent date is not an expiry', () => {
    expect(isActiveOn(reg(), '1999-01-01')).toBe(true)
  })
})

describe('resolveRegistration', () => {
  const regs = [reg({ id: 1 }), reg({ id: 2, gstin: GJ, stateCode: '24', tradeName: 'Gujarat', isPrimary: false })]

  it('a voucher with no registration resolves to the primary', () => {
    expect(resolveRegistration(regs, null)?.id).toBe(1)
    expect(resolveRegistration(regs, undefined)?.id).toBe(1)
  })

  it('and keeps resolving to the primary when a second registration exists', () => {
    // The whole point: adding Gujarat must not move a single one of last year's Maharashtra
    // invoices. The stamp in the migration is what guarantees it; this is the fallback agreeing.
    expect(resolveRegistration(regs, null)?.stateCode).toBe('27')
  })

  it('honours the registration a voucher names', () => {
    expect(resolveRegistration(regs, 2)?.stateCode).toBe('24')
  })

  it('falls back to the primary for an id that no longer exists', () => {
    expect(resolveRegistration(regs, 99)?.id).toBe(1)
  })

  it('answers null for a book with no registrations at all', () => {
    expect(resolveRegistration([], 1)).toBeNull()
    expect(primaryOf([])).toBeNull()
  })
})

describe('defaultRegistrationFor', () => {
  const mh = reg({ id: 1 })
  const gj = reg({ id: 2, gstin: GJ, stateCode: '24', tradeName: 'Gujarat', isPrimary: false })

  it('follows the godown the goods moved through', () => {
    expect(defaultRegistrationFor([mh, gj], { godownRegistrationId: 2 })?.id).toBe(2)
  })

  it('falls back to the primary when the godown has no registration', () => {
    expect(defaultRegistrationFor([mh, gj], { godownRegistrationId: null })?.id).toBe(1)
  })

  it('does not default to a registration that was surrendered before the date', () => {
    const closed = { ...gj, surrenderedOn: '2025-12-31' }
    expect(defaultRegistrationFor([mh, closed], { godownRegistrationId: 2, date: '2026-05-01' })?.id).toBe(1)
    // Still honoured for a date when it WAS live — back-dated entry is ordinary work.
    expect(defaultRegistrationFor([mh, closed], { godownRegistrationId: 2, date: '2025-06-01' })?.id).toBe(2)
  })
})

describe('place of supply is decided by the supplying registration', () => {
  // This is the correctness core of roadmap #108, stated as arithmetic rather than as prose.
  const mh = reg({ id: 1 })
  const gj = reg({ id: 2, gstin: GJ, stateCode: '24', isPrimary: false })

  it('a Gujarat registration billing a Gujarat customer charges CGST+SGST', () => {
    expect(supplyTypeFor(gj.stateCode, '24')).toBe('intra')
  })

  it('the same invoice, computed against the company head-office state, would charge IGST', () => {
    // The bug this feature exists to prevent, kept as a test so nobody re-introduces the shortcut.
    expect(supplyTypeFor(mh.stateCode, '24')).toBe('inter')
  })

  it('a Gujarat registration billing a Maharashtra customer charges IGST', () => {
    expect(supplyTypeFor(gj.stateCode, '27')).toBe('inter')
  })
})

describe('registrationLabel', () => {
  it('names the state and the GSTIN', () => {
    expect(registrationLabel(reg())).toBe('27 · Maharashtra — 27AAAPA1234A1ZT')
  })
  it('says so when there is no GSTIN, rather than showing an empty dash', () => {
    expect(registrationLabel(reg({ gstin: null }))).toBe('27 · Maharashtra — unregistered')
  })
})
