import { describe, expect, it } from 'vitest'
import { SCRATCHPAD_GROUP_NAME, SCRATCHPAD_LEDGER_NAME, checkReclassify, reclassifyNote } from './scratchpad'
import { DEFAULT_GROUPS } from './seed'

const base = {
  lockDate: null as string | null,
  voucherDate: '2026-06-01',
  isDeleted: false,
  targetLedgerId: 5,
  scratchpadLedgerId: 9
}

describe('the scratchpad ledger', () => {
  it('lives under a group the seeded chart actually has', () => {
    // A ledger created under a group that does not exist fails inside a foreign key, months later,
    // on somebody else's machine.
    expect(DEFAULT_GROUPS.map((g) => g.name)).toContain(SCRATCHPAD_GROUP_NAME)
  })

  it('is named once, so two call sites cannot create two of it', () => {
    expect(SCRATCHPAD_LEDGER_NAME).toBe('Scratchpad (unclassified)')
  })
})

describe('checkReclassify', () => {
  it('allows the ordinary case', () => {
    expect(checkReclassify(base)).toBeNull()
  })

  it('refuses a voucher in the bin', () => {
    expect(checkReclassify({ ...base, isDeleted: true })).toContain('bin')
  })

  it('refuses moving a line to the scratchpad it is already on', () => {
    expect(checkReclassify({ ...base, targetLedgerId: 9 })).toContain('OFF the scratchpad')
  })

  it('refuses a line somebody else already classified', () => {
    expect(checkReclassify({ ...base, notOnScratchpad: true })).toContain('not on the scratchpad')
  })

  it('refuses to rewrite a voucher inside the locked period, and says what to do instead', () => {
    // A suspense balance reported at 31 March has to stay reported.
    const msg = checkReclassify({ ...base, lockDate: '2026-03-31', voucherDate: '2026-03-15' })
    expect(msg).toContain('locked up to 2026-03-31')
    expect(msg).toContain('journal')
  })

  it('allows one dated after the lock', () => {
    expect(checkReclassify({ ...base, lockDate: '2026-03-31', voucherDate: '2026-04-01' })).toBeNull()
  })

  it('treats the lock date itself as locked', () => {
    expect(checkReclassify({ ...base, lockDate: '2026-03-31', voucherDate: '2026-03-31' })).not.toBeNull()
  })
})

describe('reclassifyNote', () => {
  it('says where the amount came from and where it went', () => {
    expect(reclassifyNote('Scratchpad (unclassified)', 'Printing & Stationery')).toBe(
      'Classified from Scratchpad (unclassified) to Printing & Stationery'
    )
  })
})
