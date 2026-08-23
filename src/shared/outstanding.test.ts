import { describe, it, expect } from 'vitest'
import { allocateBills, buildReminder, type BillEvent, whatsappNumber } from './outstanding'

describe('allocateBills — refless legacy inference (byte-identical to the pre-refactor algorithm)', () => {
  it('one bill, no settlement: stays open in full', () => {
    const events: BillEvent[] = [{ voucherId: 1, date: '2025-05-01', number: 'INV-1', amount: 10000, refs: [] }]
    const { bills, unappliedCredit } = allocateBills(events, '2025-06-01', null)
    expect(bills).toHaveLength(1)
    expect(bills[0]).toMatchObject({ voucherId: 1, number: 'INV-1', amount: 10000, pending: 10000, ageDays: 31 })
    expect(unappliedCredit).toBe(0)
  })

  it('two bills, oldest settled first (FIFO), remainder stays open', () => {
    const events: BillEvent[] = [
      { voucherId: 1, date: '2025-05-01', number: 'INV-1', amount: 10000, refs: [] },
      { voucherId: 2, date: '2025-05-10', number: 'INV-2', amount: 5000, refs: [] },
      { voucherId: 3, date: '2025-05-15', number: 'RCPT-1', amount: -12000, refs: [] }
    ]
    const { bills, unappliedCredit } = allocateBills(events, '2025-06-01', null)
    expect(bills).toHaveLength(1)
    expect(bills[0]).toMatchObject({ number: 'INV-2', amount: 5000, pending: 3000 })
    expect(unappliedCredit).toBe(0)
  })

  it('a settlement larger than every open bill becomes an advance credit', () => {
    const events: BillEvent[] = [
      { voucherId: 1, date: '2025-05-01', number: 'INV-1', amount: 10000, refs: [] },
      { voucherId: 2, date: '2025-05-05', number: 'RCPT-1', amount: -15000, refs: [] }
    ]
    const { bills, unappliedCredit } = allocateBills(events, '2025-06-01', null)
    expect(bills).toHaveLength(0)
    expect(unappliedCredit).toBe(5000)
  })

  it('an advance credit nets off the next bill automatically', () => {
    const events: BillEvent[] = [
      { voucherId: 1, date: '2025-05-01', number: 'ADV', amount: -4000, refs: [] }, // advance receipt, no bill yet
      { voucherId: 2, date: '2025-05-10', number: 'INV-1', amount: 10000, refs: [] }
    ]
    const { bills, unappliedCredit } = allocateBills(events, '2025-06-01', null)
    expect(bills).toHaveLength(1)
    expect(bills[0]).toMatchObject({ number: 'INV-1', amount: 10000, pending: 6000 })
    expect(unappliedCredit).toBe(0)
  })

  it('a zero-amount event is a no-op', () => {
    const events: BillEvent[] = [{ voucherId: 1, date: '2025-05-01', number: 'X', amount: 0, refs: [] }]
    const { bills, unappliedCredit } = allocateBills(events, '2025-06-01', null)
    expect(bills).toHaveLength(0)
    expect(unappliedCredit).toBe(0)
  })

  it('ageDays and overdueDays are equal when there is no due date (matches the old age-from-bill-date bucketing)', () => {
    const events: BillEvent[] = [{ voucherId: 1, date: '2025-05-01', number: 'INV-1', amount: 10000, refs: [] }]
    const { bills } = allocateBills(events, '2025-07-15', null)
    expect(bills[0]!.ageDays).toBe(bills[0]!.overdueDays)
  })
})

describe('allocateBills — named bill refs', () => {
  it("'new' opens a named bill; 'against' settles it exactly by name", () => {
    const events: BillEvent[] = [
      {
        voucherId: 1, date: '2025-05-01', number: 'INV-1', amount: 10000,
        refs: [{ kind: 'new', name: 'INV-1', amount: 10000, dueDate: null }]
      },
      {
        voucherId: 2, date: '2025-05-20', number: 'RCPT-1', amount: -10000,
        refs: [{ kind: 'against', name: 'INV-1', amount: 10000, dueDate: null }]
      }
    ]
    const { bills } = allocateBills(events, '2025-06-01', null)
    expect(bills).toHaveLength(0)
  })

  it("a partial 'against' settlement leaves the named bill open for the remainder", () => {
    const events: BillEvent[] = [
      {
        voucherId: 1, date: '2025-05-01', number: 'INV-1', amount: 10000,
        refs: [{ kind: 'new', name: 'INV-1', amount: 10000, dueDate: null }]
      },
      {
        voucherId: 2, date: '2025-05-20', number: 'RCPT-1', amount: -4000,
        refs: [{ kind: 'against', name: 'INV-1', amount: 4000, dueDate: null }]
      }
    ]
    const { bills } = allocateBills(events, '2025-06-01', null)
    expect(bills).toHaveLength(1)
    expect(bills[0]).toMatchObject({ number: 'INV-1', pending: 6000 })
  })

  it("'against' a bill name that isn't open surfaces a warning instead of silently FIFO-ing (v0.3 #66)", () => {
    const events: BillEvent[] = [
      {
        voucherId: 1, date: '2025-05-01', number: 'INV-1', amount: 10000,
        refs: [{ kind: 'new', name: 'INV-1', amount: 10000, dueDate: null }]
      },
      {
        voucherId: 2, date: '2025-05-20', number: 'RCPT-1', amount: -3000,
        refs: [{ kind: 'against', name: 'UNKNOWN-99', amount: 3000, dueDate: null }]
      }
    ]
    const { bills, unappliedCredit, warnings } = allocateBills(events, '2025-06-01', null)
    // The named settlement no longer silently eats INV-1 — it stays fully open, the amount sits
    // as unapplied credit, and the mismatch is called out.
    expect(bills).toHaveLength(1)
    expect(bills[0]).toMatchObject({ number: 'INV-1', pending: 10000 })
    expect(unappliedCredit).toBe(3000)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('UNKNOWN-99')
  })

  it('refless settlements still FIFO with no warnings', () => {
    const events: BillEvent[] = [
      { voucherId: 1, date: '2025-05-01', number: 'INV-1', amount: 10000, refs: [] },
      { voucherId: 2, date: '2025-05-20', number: 'RCPT-1', amount: -3000, refs: [] }
    ]
    const { bills, warnings } = allocateBills(events, '2025-06-01', null)
    expect(bills[0]).toMatchObject({ number: 'INV-1', pending: 7000 })
    expect(warnings).toEqual([])
  })

  it('two named bills settled independently and out of order', () => {
    const events: BillEvent[] = [
      {
        voucherId: 1, date: '2025-05-01', number: 'INV-1', amount: 10000,
        refs: [{ kind: 'new', name: 'INV-1', amount: 10000, dueDate: null }]
      },
      {
        voucherId: 2, date: '2025-05-05', number: 'INV-2', amount: 6000,
        refs: [{ kind: 'new', name: 'INV-2', amount: 6000, dueDate: null }]
      },
      {
        voucherId: 3, date: '2025-05-20', number: 'RCPT-1', amount: -6000,
        refs: [{ kind: 'against', name: 'INV-2', amount: 6000, dueDate: null }]
      }
    ]
    const { bills } = allocateBills(events, '2025-06-01', null)
    expect(bills).toHaveLength(1)
    expect(bills[0]).toMatchObject({ number: 'INV-1', pending: 10000 })
  })
})

describe('allocateBills — due dates', () => {
  it('explicit ref due date wins over party credit days', () => {
    const events: BillEvent[] = [
      {
        voucherId: 1, date: '2025-05-01', number: 'INV-1', amount: 10000,
        refs: [{ kind: 'new', name: 'INV-1', amount: 10000, dueDate: '2025-05-10' }]
      }
    ]
    const { bills } = allocateBills(events, '2025-06-01', 30)
    expect(bills[0]!.dueDate).toBe('2025-05-10')
    // overdue from 2025-05-10 to 2025-06-01 = 22 days
    expect(bills[0]!.overdueDays).toBe(22)
  })

  it('falls back to date + party credit days when no explicit due date is given', () => {
    const events: BillEvent[] = [
      { voucherId: 1, date: '2025-05-01', number: 'INV-1', amount: 10000, refs: [] }
    ]
    const { bills } = allocateBills(events, '2025-06-15', 15)
    expect(bills[0]!.dueDate).toBe('2025-05-16')
    // overdue from 2025-05-16 to 2025-06-15 = 30 days
    expect(bills[0]!.overdueDays).toBe(30)
  })

  it('has no due date at all when neither a ref date nor credit days is available', () => {
    const events: BillEvent[] = [
      { voucherId: 1, date: '2025-05-01', number: 'INV-1', amount: 10000, refs: [] }
    ]
    const { bills } = allocateBills(events, '2025-06-01', null)
    expect(bills[0]!.dueDate).toBeNull()
  })

  it('is not overdue before the due date', () => {
    const events: BillEvent[] = [
      { voucherId: 1, date: '2025-05-01', number: 'INV-1', amount: 10000, refs: [] }
    ]
    const { bills } = allocateBills(events, '2025-05-05', 30) // due 2025-05-31, well after asOn
    expect(bills[0]!.overdueDays).toBe(0)
  })
})

describe('buildReminder', () => {
  it('builds a subject/body/mailto summarizing the open bills', () => {
    const bills = allocateBills(
      [{ voucherId: 1, date: '2025-05-01', number: 'INV-1', amount: 25000, refs: [] }],
      '2025-06-01',
      null
    ).bills
    const r = buildReminder({ name: 'Demo Traders' }, { name: 'Umbrella Retail', email: 'ap@umbrella.test' }, bills)
    expect(r.subject).toContain('Demo Traders')
    expect(r.body).toContain('INV-1')
    expect(r.body).toContain('250.00')
    expect(r.mailto.startsWith('mailto:ap@umbrella.test?subject=')).toBe(true)
    expect(r.mailto).toContain(encodeURIComponent(r.subject))
  })

  it('leaves the mailto address blank (not "null") when the party has no email', () => {
    const r = buildReminder({ name: 'Demo Traders' }, { name: 'Umbrella Retail', email: null }, [])
    expect(r.mailto.startsWith('mailto:?subject=')).toBe(true)
  })
})

describe('whatsappNumber', () => {
  it('adds the country code to a bare ten-digit mobile', () => {
    expect(whatsappNumber('9876543210')).toBe('919876543210')
  })

  it('strips the punctuation people actually type', () => {
    for (const typed of ['98765 43210', '98765-43210', '(98765) 43210', '+91 98765 43210', '0091-9876543210']) {
      expect(whatsappNumber(typed), typed).toBe('919876543210')
    }
  })

  it('drops a domestic trunk prefix', () => {
    expect(whatsappNumber('09876543210')).toBe('919876543210')
  })

  it('leaves an already-international number alone', () => {
    expect(whatsappNumber('+44 7700 900123')).toBe('447700900123')
  })

  it('refuses anything it cannot read with certainty', () => {
    // Sending a payment reminder to the wrong person is worse than not sending one.
    for (const bad of [null, '', '12345', 'call the office', '1234567890123456789']) {
      expect(whatsappNumber(bad as string | null), String(bad)).toBeNull()
    }
  })
})

describe('buildReminder over WhatsApp', () => {
  const company = { name: 'Demo Traders' }
  const bills = [
    { voucherId: 1, number: 'INV-1', date: '2026-04-01', dueDate: null, amount: 100000, pending: 100000, ageDays: 40, overdueDays: 10 }
  ]

  it('sends the same text through both channels', () => {
    const r = buildReminder(company, { name: 'Sharma Traders', email: 'a@b.com', phone: '9876543210' }, bills)
    expect(r.whatsapp).toContain('wa.me/919876543210')
    expect(decodeURIComponent(r.whatsapp!)).toContain(r.body)
    expect(decodeURIComponent(r.mailto)).toContain(r.body)
  })

  it('offers no WhatsApp link when there is no usable number', () => {
    expect(buildReminder(company, { name: 'X', email: null, phone: null }, bills).whatsapp).toBeNull()
    expect(buildReminder(company, { name: 'X', email: null }, bills).whatsapp).toBeNull()
  })
})
