import { describe, it, expect } from 'vitest'
import {
  bankChangeNeedsSecondPerson, bankDetailsChanged, canConfirmBankChange, looksLikeIfsc, maskAccount,
  normaliseAccount, sharedBankAccounts
} from './bankDetails'

describe('normaliseAccount', () => {
  it('ignores how the number was written', () => {
    expect(normaliseAccount('0012 3456 7890')).toBe('001234567890')
    expect(normaliseAccount('0012-3456-7890')).toBe('001234567890')
  })

  it('keeps leading zeros — two accounts differing by one are two accounts', () => {
    expect(normaliseAccount('0123456')).not.toBe(normaliseAccount('123456'))
  })

  it('is null for nothing at all', () => {
    expect(normaliseAccount('')).toBeNull()
    expect(normaliseAccount('   ')).toBeNull()
    expect(normaliseAccount(null)).toBeNull()
  })
})

describe('looksLikeIfsc', () => {
  it('accepts a well-formed code and rejects a typo', () => {
    expect(looksLikeIfsc('HDFC0001234')).toBe(true)
    expect(looksLikeIfsc('hdfc0001234')).toBe(true)
    expect(looksLikeIfsc('HDFC1001234')).toBe(false)
    expect(looksLikeIfsc('HDFC000123')).toBe(false)
  })
})

describe('bankDetailsChanged', () => {
  it('is blind to formatting', () => {
    expect(
      bankDetailsChanged(
        { account: '0012 3456', ifsc: 'hdfc0001234', holder: 'Kumar Traders' },
        { account: '00123456', ifsc: 'HDFC0001234', holder: 'Kumar Traders' }
      )
    ).toBe(false)
  })

  it('sees a changed digit, a changed branch and a changed holder', () => {
    const before = { account: '00123456', ifsc: 'HDFC0001234', holder: 'Kumar Traders' }
    expect(bankDetailsChanged(before, { ...before, account: '00123457' })).toBe(true)
    expect(bankDetailsChanged(before, { ...before, ifsc: 'HDFC0009999' })).toBe(true)
    expect(bankDetailsChanged(before, { ...before, holder: 'Kumar Trading Co' })).toBe(true)
  })
})

describe('bankChangeNeedsSecondPerson', () => {
  it('does not park a change in a one-person business', () => {
    // A rule nobody can satisfy is a master that never gets corrected.
    expect(bankChangeNeedsSecondPerson({ activeUsers: 1, actorRole: 'owner' })).toBe(false)
    expect(bankChangeNeedsSecondPerson({ activeUsers: 0, actorRole: null })).toBe(false)
  })

  it("parks even the owner's own change once a second person exists", () => {
    // Unlike the voucher threshold: the risk here is a convincing letter, not a careless entry.
    expect(bankChangeNeedsSecondPerson({ activeUsers: 2, actorRole: 'owner' })).toBe(true)
    expect(bankChangeNeedsSecondPerson({ activeUsers: 3, actorRole: 'accountant' })).toBe(true)
  })
})

describe('canConfirmBankChange', () => {
  it('refuses the person who asked for it', () => {
    const r = canConfirmBankChange({ approverRole: 'owner', approverName: 'Priya', requestedBy: 'Priya' })
    expect(r.ok).toBe(false)
  })

  it('accepts a different owner or accountant', () => {
    expect(canConfirmBankChange({ approverRole: 'owner', approverName: 'Priya', requestedBy: 'Arun' }).ok).toBe(true)
    expect(canConfirmBankChange({ approverRole: 'accountant', approverName: 'Arun', requestedBy: 'Priya' }).ok).toBe(true)
  })

  it('refuses a viewer and refuses nobody at all', () => {
    expect(canConfirmBankChange({ approverRole: 'viewer', approverName: 'V', requestedBy: 'Arun' }).ok).toBe(false)
    expect(canConfirmBankChange({ approverRole: 'owner', approverName: null, requestedBy: 'Arun' }).ok).toBe(false)
  })
})

describe('sharedBankAccounts', () => {
  const row = (ledgerId: number, name: string, account: string | null, sharedOk = false) => ({
    ledgerId, name, account, ifsc: 'HDFC0001234', sharedOk
  })

  it('finds two parties on one account however it was typed', () => {
    const groups = sharedBankAccounts([row(1, 'Kumar Traders', '0012 3456'), row(2, 'Kumar Enterprises', '00123456')])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.parties.map((p) => p.name)).toEqual(['Kumar Enterprises', 'Kumar Traders'])
  })

  it('says nothing about a party with no bank details', () => {
    expect(sharedBankAccounts([row(1, 'A', null), row(2, 'B', null), row(3, 'C', '')])).toEqual([])
  })

  it('stays silent when every party on the account is knowingly sharing', () => {
    // A proprietor and their firm banking into one account is real and common.
    const groups = sharedBankAccounts([row(1, 'S Kumar', '00123456', true), row(2, 'Kumar Traders', '00123456', true)])
    expect(groups).toEqual([])
  })

  it('speaks up again when a third party appears on that same account', () => {
    const groups = sharedBankAccounts([
      row(1, 'S Kumar', '00123456', true),
      row(2, 'Kumar Traders', '00123456', true),
      row(3, 'Unknown Payee', '00123456', false)
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.parties).toHaveLength(3)
  })
})

describe('maskAccount', () => {
  it('shows only the tail', () => {
    expect(maskAccount('001234567890')).toBe('••••••••7890')
    expect(maskAccount('1234')).toBe('1234')
    expect(maskAccount(null)).toBe('—')
  })
})
