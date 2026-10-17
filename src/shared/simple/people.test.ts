// WP 9.8 — the pure half of the simple People screens: the reminder message (built from the
// reminder letter's facts, per step and language, short for SMS), the WhatsApp link, a bill's
// timing in words, where someone stands, the filters, the "Bills to pay" order and its this-week /
// this-month totals, and the person view's checks. No banned word in any of it.
import { describe, expect, it } from 'vitest'
import { translator } from '../i18n'
import { bannedWordsIn } from './bannedWords'
import {
  balanceWords, billsToPayTotals, billTiming, matchesFilter, monthEndOf, parseCreditDays, personErrors, reminderMessage, reminderSms, REMINDER_BILL_LINES,
  REMINDER_LOG_CHANNEL, sortBillsToPay, upcomingBills, weekEndOf, whatsappLink, whatsappNumber, type PersonRow
} from './people'

const t = translator('en')
const TODAY = '2026-10-14' // a Wednesday

const row = (over: Partial<PersonRow>): PersonRow => ({
  ledgerId: 1, name: 'Ramesh', side: 'customer', phone: null, whatsapp: null, creditDays: null, onHold: false,
  open: 0, ahead: 0, late: 0, lateBills: 0, maxLateDays: 0, walkIn: false, ...over
})

const FACTS = {
  company: 'Sharma Traders',
  party: 'Ramesh',
  bucket: 'gentle' as const,
  bills: [
    { name: '1', date: '2026-08-20', pending: 120_000, overdueDays: 40 },
    { name: '4', date: '2026-09-10', pending: 30_050, overdueDays: 19 }
  ]
}

describe('reminder message', () => {
  it('says hello, what is late in total, each late bill, thanks and who it is from', () => {
    const text = reminderMessage(FACTS)
    expect(text).toBe(
      [
        'Hello Ramesh,',
        '',
        'This is a friendly reminder from Sharma Traders: ₹1,500.50 is now past its due date.',
        '',
        '• Bill 1 of 20 Aug 2026: ₹1,200.00',
        '• Bill 4 of 10 Sep 2026: ₹300.50',
        '',
        'If you have already paid, thank you — please ignore this message.',
        'Sharma Traders'
      ].join('\n')
    )
    expect(bannedWordsIn(text)).toEqual([])
  })

  it('the firm and final steps name the oldest bill’s days', () => {
    expect(reminderMessage({ ...FACTS, bucket: 'firm' })).toContain('This is Sharma Traders again: ₹1,500.50 is still unpaid, the oldest bill 40 days late.')
    expect(reminderMessage({ ...FACTS, bucket: 'final' })).toContain('A last reminder from Sharma Traders: ₹1,500.50 is 40 days past due. Please pay within 7 days.')
    expect(reminderMessage({ ...FACTS, bucket: 'final', bills: [{ name: '9', date: '2026-10-12', pending: 100, overdueDays: 1 }] })).toContain('is 1 day past due')
  })

  it('lists at most five bills, then how many more', () => {
    const bills = Array.from({ length: 7 }, (_, i) => ({ name: `B${i + 1}`, date: `2026-08-0${i + 1}`, pending: 1000, overdueDays: 50 - i }))
    const lines = reminderMessage({ ...FACTS, bills }).split('\n').filter((l) => l.startsWith('•'))
    expect(lines).toHaveLength(REMINDER_BILL_LINES)
    expect(reminderMessage({ ...FACTS, bills })).toContain('…and 2 more bills')
    expect(reminderMessage({ ...FACTS, bills: bills.slice(0, 6) })).toContain('…and 1 more bill')
  })

  it('Hindi and Hinglish come from their catalogues; amounts as money.ts writes them, dates in the reader’s language (WP 10.4)', () => {
    const hi = reminderMessage(FACTS, 'hi')
    expect(hi.startsWith('नमस्ते Ramesh जी,')).toBe(true)
    expect(hi).toContain('₹1,500.50')
    expect(hi).toContain('• बिल 1, 20 अगस्त 2026: ₹1,200.00')
    const hg = reminderMessage({ ...FACTS, bucket: 'firm' }, 'hinglish')
    expect(hg).toContain('Sharma Traders ki taraf se dobara yaad: ₹1,500.50 abhi bhi baaki hai, sabse purana bill 40 din late hai.')
  })

  it('the SMS text is one paragraph without the bill list', () => {
    const sms = reminderSms(FACTS)
    expect(sms).toBe('Hello Ramesh, This is a friendly reminder from Sharma Traders: ₹1,500.50 is now past its due date. If you have already paid, thank you — please ignore this message. Sharma Traders')
    expect(sms).not.toContain('\n')
  })

  it('the polite pre-due note: what is due and when, thanks, in all three languages and as SMS', () => {
    const f = {
      company: 'Sharma Traders',
      party: 'Ramesh',
      bucket: 'gentle' as const,
      tone: 'before_due' as const,
      bills: [
        { name: '7', date: '2026-10-04', dueDate: '2026-10-17', pending: 120_000, overdueDays: 0 },
        { name: '8', date: '2026-10-09', dueDate: '2026-10-21', pending: 30_050, overdueDays: 0 }
      ]
    }
    expect(reminderMessage(f)).toBe(
      [
        'Hello Ramesh,',
        '',
        'A friendly note from Sharma Traders: ₹1,500.50 falls due on 17 Oct 2026. Thank you!',
        '',
        '• Bill 7, due 17 Oct 2026: ₹1,200.00',
        '• Bill 8, due 21 Oct 2026: ₹300.50',
        '',
        'If you have already paid, thank you — please ignore this message.',
        'Sharma Traders'
      ].join('\n')
    )
    const hi = reminderMessage(f, 'hi')
    expect(hi).toContain('Sharma Traders की ओर से एक विनम्र सूचना: ₹1,500.50 की भुगतान तारीख 17 अक्तूबर 2026 है। धन्यवाद!')
    expect(hi).toContain('• बिल 7, भुगतान की तारीख 17 अक्तूबर 2026: ₹1,200.00')
    const hg = reminderMessage(f, 'hinglish')
    expect(hg).toContain('Sharma Traders ki taraf se ek friendly reminder: ₹1,500.50 ki payment ki date 17 Oct 2026 hai. Dhanyavaad!')
    expect(hg).toContain('• Bill 8, due date 21 Oct 2026: ₹300.50')
    const sms = reminderSms(f)
    expect(sms).toBe('Hello Ramesh, A friendly note from Sharma Traders: ₹1,500.50 falls due on 17 Oct 2026. Thank you! If you have already paid, thank you — please ignore this message. Sharma Traders')
    for (const text of [reminderMessage(f), hi, hg, sms]) expect(bannedWordsIn(text)).toEqual([])
    // The late message is unchanged by the new option.
    expect(reminderMessage({ ...FACTS, tone: 'late' })).toBe(reminderMessage(FACTS))
  })

  it('upcomingBills: due today to 7 days ahead, not late, soonest due first', () => {
    const b = (name: string, dueDate: string | null, overdueDays = 0, pending = 100) => ({ name, dueDate, overdueDays, pending })
    const got = upcomingBills([b('a', '2026-10-21'), b('late', '2026-10-10', 4), b('far', '2026-10-22'), b('today', '2026-10-14'), b('none', null), b('paid', '2026-10-15', 0, 0), b('last', '2026-10-21')], TODAY)
    expect(got.map((x) => x.name)).toEqual(['today', 'a', 'last'])
  })

  it('logs WhatsApp / SMS as phone and a copy as other (reminder_log has no WhatsApp channel)', () => {
    expect(REMINDER_LOG_CHANNEL).toEqual({ whatsapp: 'whatsapp', sms: 'sms', copied: 'other' })
  })
})

describe('WhatsApp link', () => {
  it('a 10-digit Indian mobile gets 91; a leading 0 or +91 is handled; spaces and dashes go', () => {
    expect(whatsappNumber('98765 43210')).toBe('919876543210')
    expect(whatsappNumber('098765-43210')).toBe('919876543210')
    expect(whatsappNumber('+91 98765 43210')).toBe('919876543210')
    expect(whatsappNumber('+44 20 7946 0958')).toBe('442079460958')
    expect(whatsappNumber('0091 98765 43210')).toBe('919876543210')
    expect(whatsappNumber('+91 098765 43210')).toBe('919876543210')
    expect(whatsappNumber('91 98765 43210')).toBe('919876543210')
    // Not a number WhatsApp can open a chat with: no chat, WhatsApp asks whom.
    expect(whatsappNumber('123456')).toBeNull()
    expect(whatsappNumber('98765 4321')).toBeNull()
    expect(whatsappNumber('+0 1234 5678')).toBeNull()
    expect(whatsappNumber('')).toBeNull()
    expect(whatsappNumber('call me')).toBeNull()
  })

  it('carries the text encoded; without a number WhatsApp asks whom to send to', () => {
    expect(whatsappLink('9876543210', 'Hello Ramesh, ₹10 & more')).toBe(`https://wa.me/919876543210?text=${encodeURIComponent('Hello Ramesh, ₹10 & more')}`)
    expect(whatsappLink(null, 'Hi')).toBe('https://wa.me/?text=Hi')
  })
})

describe('words and filters', () => {
  it('a bill’s timing: late, due today, due in N days, nothing once paid', () => {
    expect(billTiming({ pending: 100, dueDate: '2026-10-01', overdueDays: 13 }, TODAY, t)).toBe('13 days overdue')
    expect(billTiming({ pending: 100, dueDate: '2026-10-13', overdueDays: 1 }, TODAY, t)).toBe('1 day overdue')
    expect(billTiming({ pending: 100, dueDate: TODAY, overdueDays: 0 }, TODAY, t)).toBe('due today')
    expect(billTiming({ pending: 100, dueDate: '2026-10-17', overdueDays: 0 }, TODAY, t)).toBe('due in 3 days')
    expect(billTiming({ pending: 100, dueDate: '2026-10-15', overdueDays: 0 }, TODAY, t)).toBe('due in 1 day')
    expect(billTiming({ pending: 100, dueDate: null, overdueDays: 0 }, TODAY, t)).toBe('due today')
    expect(billTiming({ pending: 0, dueDate: null, overdueDays: 9 }, TODAY, t)).toBe('')
  })

  it('where someone stands', () => {
    expect(balanceWords(row({ open: 150_000 }), t)).toBe('Owes you ₹1,500.00')
    expect(balanceWords(row({ side: 'supplier', open: 80_000 }), t)).toBe('You owe ₹800.00')
    expect(balanceWords(row({ ahead: 50_000 }), t)).toBe('Has a credit of ₹500.00 for the next bill')
    expect(balanceWords(row({ side: 'supplier', ahead: 50_000 }), t)).toBe('You have a credit of ₹500.00 for your next bill')
    expect(balanceWords(row({ open: 100, ahead: 200 }), t)).toBe('Owes you ₹1.00 · Has a credit of ₹2.00 for the next bill')
    expect(balanceWords(row({}), t)).toBe('Settled')
  })

  it('filters: customers, suppliers, owe you, you owe, late', () => {
    const people = [row({ ledgerId: 1, open: 100 }), row({ ledgerId: 2, ahead: 5 }), row({ ledgerId: 3, side: 'supplier', open: 7, late: 7 }), row({ ledgerId: 4, side: 'supplier' })]
    const ids = (f: Parameters<typeof matchesFilter>[1]): number[] => people.filter((p) => matchesFilter(p, f)).map((p) => p.ledgerId)
    expect(ids('all')).toEqual([1, 2, 3, 4])
    expect(ids('customers')).toEqual([1, 2])
    expect(ids('suppliers')).toEqual([3, 4])
    expect(ids('owesYou')).toEqual([1])
    expect(ids('youOwe')).toEqual([3])
    expect(ids('late')).toEqual([3])
  })
})

describe('bills to pay', () => {
  it('most late first, then the oldest', () => {
    const bills = [
      { name: 'A', date: '2026-10-01', overdueDays: 0 },
      { name: 'B', date: '2026-08-01', overdueDays: 20 },
      { name: 'C', date: '2026-07-01', overdueDays: 20 },
      { name: 'D', date: '2026-09-01', overdueDays: 0 }
    ]
    expect(sortBillsToPay(bills).map((b) => b.name)).toEqual(['C', 'B', 'D', 'A'])
  })

  it('week = Monday to Sunday, month = to its last day; late bills count in both', () => {
    expect(weekEndOf(TODAY)).toBe('2026-10-18')
    expect(weekEndOf('2026-10-18')).toBe('2026-10-18')
    expect(weekEndOf('2026-10-19')).toBe('2026-10-25')
    expect(monthEndOf(TODAY)).toBe('2026-10-31')
    expect(monthEndOf('2028-02-03')).toBe('2028-02-29')
    const totals = billsToPayTotals(
      [
        { pending: 1_000, dueDate: '2026-10-01', date: '2026-09-01', overdueDays: 13 },
        { pending: 2_000, dueDate: '2026-10-18', date: '2026-10-01', overdueDays: 0 },
        { pending: 4_000, dueDate: '2026-10-25', date: '2026-10-01', overdueDays: 0 },
        { pending: 8_000, dueDate: null, date: '2026-11-02', overdueDays: 0 },
        { pending: 0, dueDate: '2026-10-02', date: '2026-10-01', overdueDays: 12 }
      ],
      TODAY
    )
    expect(totals).toEqual({ weekEnd: '2026-10-18', monthEnd: '2026-10-31', dueThisWeek: 3_000, dueThisMonth: 7_000, late: 1_000 })
  })
})

describe('the person view’s checks', () => {
  it('phone numbers and days to pay', () => {
    expect(personErrors({ phone: '98765 43210', whatsapp: '', creditDays: '15' })).toEqual({})
    expect(personErrors({ phone: 'abc', whatsapp: '12', creditDays: '400' })).toEqual({ phone: 'simple.people.err.phone', whatsapp: 'simple.people.err.phone', creditDays: 'simple.people.err.creditDays' })
    expect(parseCreditDays('')).toBeNull()
    expect(parseCreditDays(' 30 ')).toBe(30)
    expect(parseCreditDays('1.5')).toBeUndefined()
    expect(parseCreditDays('-3')).toBeUndefined()
  })
})
