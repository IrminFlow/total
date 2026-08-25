import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger, updateLedger, getLedger } from './masters'
import { saveVoucher, setLockDate, getVoucher } from './vouchers'
import { fcAccounts, fcAccount, previewRevaluation, postRevaluation, listRevaluations, removeRevaluation } from './fx'
import { trialBalance } from './reports'
import type { DrCr } from '@shared/domain'

/**
 * Foreign-currency accounts and revaluation (roadmap F #140), against a real database.
 *
 * The arithmetic is exhaustively tested in `@shared/fx`. What is asserted here is the part that
 * only a database can be wrong about: that the foreign amount is persisted per line, that the rate
 * used is recorded on the voucher rather than looked up again, and that an unrealised difference
 * is a real posting the trial balance sees.
 */
function books() {
  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number =>
    (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id

  db.prepare("INSERT INTO currencies (code, symbol, name, decimals) VALUES ('USD', '$', 'US Dollar', 2)").run()
  db.prepare("INSERT INTO currencies (code, symbol, name, decimals) VALUES ('JPY', '¥', 'Japanese Yen', 0)").run()

  const usdBank = createLedger(db, {
    name: 'HSBC USD Current', groupId: groupId('Bank Accounts'), currencyCode: 'USD'
  }).id
  const capital = createLedger(db, { name: 'Capital', groupId: groupId('Capital Account') }).id
  const usdSupplier = createLedger(db, {
    name: 'Shenzhen Traders', groupId: groupId('Sundry Creditors'), currencyCode: 'USD'
  }).id
  const purchases = createLedger(db, { name: 'Purchases', groupId: groupId('Purchase Accounts') }).id

  /** A receipt into the dollar account: `fcMinor` cents at `rateMicro`, worth `paise`. */
  const receive = (paise: number, fcMinor: number, rateMicro: number, date = '2026-04-01'): number => {
    const lines = [
      { ledgerId: usdBank, drCr: 'dr' as DrCr, amount: paise, costAllocations: [], fcAmount: fcMinor, fcRateMicro: rateMicro },
      { ledgerId: capital, drCr: 'cr' as DrCr, amount: paise, costAllocations: [] }
    ]
    return saveVoucher(db, {
      voucherTypeId: vtId('receipt'), date, partyLedgerId: null, posOverride: null,
      lines, inventory: [], billRefs: [], tds: null
    }).id
  }

  return { db, usdBank, capital, usdSupplier, purchases, receive, vtId, groupId }
}

describe('foreign-currency accounts', () => {
  it('keeps the foreign amount the invoice was agreed in, per line', () => {
    const b = books()
    // USD 10,000 at ₹82.00 = ₹8,20,000.
    const id = b.receive(82_000_000, 1_000_000, 82_000_000)
    const voucher = getVoucher(b.db, id)!
    const line = voucher.lines.find((l) => l.ledgerId === b.usdBank)!
    expect(line.fcAmount).toBe(1_000_000)
    expect(line.fcRateMicro).toBe(82_000_000)
    // And the other side carries neither, because it is a rupee account.
    expect(voucher.lines.find((l) => l.ledgerId === b.capital)!.fcAmount).toBeNull()
  })

  it('refuses half of the pair: an amount with no rate is a line nobody can read back', () => {
    const b = books()
    const id = saveVoucher(b.db, {
      voucherTypeId: b.vtId('receipt'), date: '2026-04-01', partyLedgerId: null, posOverride: null,
      lines: [
        { ledgerId: b.usdBank, drCr: 'dr', amount: 100, costAllocations: [], fcAmount: 1_000 },
        { ledgerId: b.capital, drCr: 'cr', amount: 100, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    }).id
    const line = getVoucher(b.db, id)!.lines.find((l) => l.ledgerId === b.usdBank)!
    expect(line.fcAmount).toBeNull()
    expect(line.fcRateMicro).toBeNull()
  })

  it('reports both balances, and only for the ledgers that keep a currency', () => {
    const b = books()
    b.receive(82_000_000, 1_000_000, 82_000_000)
    const accounts = fcAccounts(b.db, '2026-06-01')
    expect(accounts.map((a) => a.ledgerName).sort()).toEqual(['HSBC USD Current', 'Shenzhen Traders'])
    const bank = accounts.find((a) => a.ledgerId === b.usdBank)!
    expect(bank.fcMinor).toBe(1_000_000)
    expect(bank.bookPaise).toBe(82_000_000)
    expect(bank.decimals).toBe(2)
    expect(bank.unmatchedPaise).toBe(0)
  })

  it('reports rupee-only movements separately rather than folding them into the foreign balance', () => {
    // A rupee bank charge on a dollar account is real, and pretending it moved dollars would put
    // the foreign balance permanently out.
    const b = books()
    b.receive(82_000_000, 1_000_000, 82_000_000)
    const charges = createLedger(b.db, { name: 'Bank Charges', groupId: b.groupId('Indirect Expenses') }).id
    saveVoucher(b.db, {
      voucherTypeId: b.vtId('payment'), date: '2026-04-15', partyLedgerId: null, posOverride: null,
      lines: [
        { ledgerId: charges, drCr: 'dr', amount: 50_000, costAllocations: [] },
        { ledgerId: b.usdBank, drCr: 'cr', amount: 50_000, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    })
    const bank = fcAccount(b.db, b.usdBank, '2026-06-01')!
    expect(bank.fcMinor).toBe(1_000_000)
    expect(bank.bookPaise).toBe(81_950_000)
    expect(bank.unmatchedPaise).toBe(-50_000)
  })

  it('answers as on a date, not as of now', () => {
    const b = books()
    b.receive(82_000_000, 1_000_000, 82_000_000, '2026-04-01')
    b.receive(41_000_000, 500_000, 82_000_000, '2026-07-01')
    expect(fcAccount(b.db, b.usdBank, '2026-06-30')!.fcMinor).toBe(1_000_000)
    expect(fcAccount(b.db, b.usdBank, '2026-07-31')!.fcMinor).toBe(1_500_000)
  })
})

describe('revaluation', () => {
  it('posts an unrealised gain as a real journal that the trial balance sees', () => {
    const b = books()
    b.receive(82_000_000, 1_000_000, 82_000_000, '2026-04-01')

    const preview = previewRevaluation(b.db, {
      ledgerId: b.usdBank, asOn: '2026-06-30', closingRateMicro: 83_500_000
    })
    expect(preview.errors).toEqual([])
    expect(preview.restatedPaise).toBe(83_500_000)
    expect(preview.differencePaise).toBe(1_500_000)
    expect(preview.effect).toBe('gain')
    expect(preview.ledgerSide).toBe('dr')

    const record = postRevaluation(b.db, {
      ledgerId: b.usdBank, asOn: '2026-06-30', closingRateMicro: 83_500_000
    })
    expect(record.differencePaise).toBe(1_500_000)
    expect(record.voucherId).not.toBeNull()

    // In the books, on both sides.
    const tb = trialBalance(b.db, '2026-06-30')
    const bank = tb.rows.find((r) => r.ledgerName === 'HSBC USD Current')!
    expect(bank.debit - bank.credit).toBe(83_500_000)
    expect(tb.rows.some((r) => r.ledgerName === 'Exchange Gain / Loss (Unrealised)')).toBe(true)
    expect(tb.totalDebit).toBe(tb.totalCredit)
  })

  it('records the rate ON the voucher, so June cannot redescribe March', () => {
    const b = books()
    b.receive(82_000_000, 1_000_000, 82_000_000, '2026-03-01')
    const record = postRevaluation(b.db, {
      ledgerId: b.usdBank, asOn: '2026-03-31', closingRateMicro: 83_500_000
    })
    const voucher = getVoucher(b.db, record.voucherId!)!
    const line = voucher.lines.find((l) => l.ledgerId === b.usdBank)!
    expect(line.fcRateMicro).toBe(83_500_000)
    // Zero foreign movement: the balance did not change in dollars, only in rupees.
    expect(line.fcAmount).toBe(0)
    expect(voucher.narration).toContain('83.5000')
  })

  it('restates a liability the other way — no special case for nature', () => {
    const b = books()
    // Owe USD 5,000 at ₹82 = ₹4,10,000 credit.
    saveVoucher(b.db, {
      voucherTypeId: b.vtId('purchase'), date: '2026-04-01', partyLedgerId: b.usdSupplier, posOverride: null,
      lines: [
        { ledgerId: b.purchases, drCr: 'dr', amount: 41_000_000, costAllocations: [] },
        {
          ledgerId: b.usdSupplier, drCr: 'cr', amount: 41_000_000, costAllocations: [],
          fcAmount: 500_000, fcRateMicro: 82_000_000
        }
      ],
      inventory: [], billRefs: [], tds: null
    })
    const preview = previewRevaluation(b.db, {
      ledgerId: b.usdSupplier, asOn: '2026-06-30', closingRateMicro: 83_500_000
    })
    // The rupee weakened, so the debt costs more: the supplier is credited and the loss debited.
    expect(preview.differencePaise).toBe(-750_000)
    expect(preview.ledgerSide).toBe('cr')
    expect(preview.effect).toBe('loss')
    postRevaluation(b.db, { ledgerId: b.usdSupplier, asOn: '2026-06-30', closingRateMicro: 83_500_000 })
    const tb = trialBalance(b.db, '2026-06-30')
    expect(tb.totalDebit).toBe(tb.totalCredit)
  })

  it('is not reversed next period: revaluing again at the same rate posts nothing', () => {
    const b = books()
    b.receive(82_000_000, 1_000_000, 82_000_000, '2026-04-01')
    postRevaluation(b.db, { ledgerId: b.usdBank, asOn: '2026-06-30', closingRateMicro: 83_500_000 })
    const next = previewRevaluation(b.db, {
      ledgerId: b.usdBank, asOn: '2026-09-30', closingRateMicro: 83_500_000
    })
    expect(next.isNil).toBe(true)
    expect(next.errors[0]).toContain('not moved')
  })

  it('refuses to revalue the same period end twice', () => {
    const b = books()
    b.receive(82_000_000, 1_000_000, 82_000_000, '2026-04-01')
    postRevaluation(b.db, { ledgerId: b.usdBank, asOn: '2026-06-30', closingRateMicro: 83_500_000 })
    expect(() =>
      postRevaluation(b.db, { ledgerId: b.usdBank, asOn: '2026-06-30', closingRateMicro: 84_000_000 })
    ).toThrow(/already been revalued/)
  })

  it('refuses a locked period, in both directions', () => {
    const b = books()
    b.receive(82_000_000, 1_000_000, 82_000_000, '2026-04-01')
    const record = postRevaluation(b.db, { ledgerId: b.usdBank, asOn: '2026-06-30', closingRateMicro: 83_500_000 })
    setLockDate(b.db, '2026-09-30')
    expect(() =>
      postRevaluation(b.db, { ledgerId: b.usdBank, asOn: '2026-09-30', closingRateMicro: 84_000_000 })
    ).toThrow(/locked/)
    expect(() => removeRevaluation(b.db, record.id)).toThrow(/locked/)
  })

  it('removing a revaluation bins its journal and frees the period end again', () => {
    const b = books()
    b.receive(82_000_000, 1_000_000, 82_000_000, '2026-04-01')
    const record = postRevaluation(b.db, { ledgerId: b.usdBank, asOn: '2026-06-30', closingRateMicro: 83_500_000 })
    removeRevaluation(b.db, record.id)

    // The journal is in the bin, not gone: it was a posted entry.
    const binned = b.db.prepare('SELECT deleted_at AS d FROM vouchers WHERE id = ?').get(record.voucherId) as { d: string | null }
    expect(binned.d).not.toBeNull()
    expect(listRevaluations(b.db, b.usdBank)).toEqual([])
    // And the corrected posting is now possible.
    expect(() =>
      postRevaluation(b.db, { ledgerId: b.usdBank, asOn: '2026-06-30', closingRateMicro: 84_000_000 })
    ).not.toThrow()
  })

  it('refuses a ledger that keeps no currency at all', () => {
    const b = books()
    expect(() =>
      previewRevaluation(b.db, { ledgerId: b.capital, asOn: '2026-06-30', closingRateMicro: 83_500_000 })
    ).toThrow(/foreign currency/)
  })

  it('un-designating a currency is possible, and takes the account off the list', () => {
    const b = books()
    const before = getLedger(b.db, b.usdBank)!
    updateLedger(b.db, b.usdBank, { name: before.name, groupId: before.groupId, currencyCode: null })
    expect(fcAccounts(b.db, '2026-06-30').map((a) => a.ledgerId)).not.toContain(b.usdBank)
  })

  it('an update that never mentions the currency leaves it alone', () => {
    // The same rule the bank details follow: a form that did not carry the field must not clear it.
    const b = books()
    const before = getLedger(b.db, b.usdBank)!
    updateLedger(b.db, b.usdBank, { name: 'HSBC USD Current (renamed)', groupId: before.groupId })
    expect(getLedger(b.db, b.usdBank)!.currencyCode).toBe('USD')
  })

  it('handles a currency with no minor unit', () => {
    const b = books()
    const jpy = createLedger(b.db, { name: 'MUFG JPY', groupId: b.groupId('Bank Accounts'), currencyCode: 'JPY' }).id
    saveVoucher(b.db, {
      voucherTypeId: b.vtId('receipt'), date: '2026-04-01', partyLedgerId: null, posOverride: null,
      lines: [
        { ledgerId: jpy, drCr: 'dr', amount: 56_120, costAllocations: [], fcAmount: 1000, fcRateMicro: 561_200 },
        { ledgerId: b.capital, drCr: 'cr', amount: 56_120, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    })
    const account = fcAccount(b.db, jpy, '2026-06-30')!
    expect(account.decimals).toBe(0)
    expect(account.fcMinor).toBe(1000)
    const preview = previewRevaluation(b.db, { ledgerId: jpy, asOn: '2026-06-30', closingRateMicro: 600_000 })
    // 1,000 yen at ₹0.60 = ₹600.
    expect(preview.restatedPaise).toBe(60_000)
  })
})
