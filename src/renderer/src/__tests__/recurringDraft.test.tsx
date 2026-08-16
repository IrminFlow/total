// Recurring template → voucher-entry draft helpers (screens/Recurring.tsx): line mapping,
// corrupt-JSON fallback, and the invoice-mode "lines get dropped" warning flag.
import { describe, expect, it } from 'vitest'
import type { RecurringTemplate } from '@shared/domain'
import { todayISO } from '@shared/dates'
import { draftFromTemplate, templateOpenTarget } from '../screens/Recurring'

function template(overrides: Partial<RecurringTemplate>): RecurringTemplate {
  return {
    id: 1,
    name: 'Office rent',
    voucherTypeId: 3,
    voucherKind: 'payment',
    cadence: 'monthly',
    dayOfMonth: 1,
    weekday: null,
    nextDue: '2026-09-01',
    lastPosted: null,
    active: true,
    voucherJson: JSON.stringify({
      partyLedgerId: 12,
      narration: 'Rent for the month',
      lines: [
        { ledgerId: 5, drCr: 'dr', amount: 2500000 },
        { ledgerId: 2, drCr: 'cr', amount: 2500000 }
      ]
    }),
    ...overrides
  } as RecurringTemplate
}

describe('draftFromTemplate', () => {
  it('maps party, narration and lines; the date is today, never the stored one', () => {
    const d = draftFromTemplate(template({}))
    expect(d.date).toBe(todayISO())
    expect(d.partyLedgerId).toBe(12)
    expect(d.narration).toBe('Rent for the month')
    expect(d.lines).toEqual([
      { ledgerId: 5, drCr: 'dr', amount: 2500000 },
      { ledgerId: 2, drCr: 'cr', amount: 2500000 }
    ])
  })

  it('integer paise pass through untouched', () => {
    const d = draftFromTemplate(template({}))
    for (const line of d.lines ?? []) expect(Number.isInteger(line.amount)).toBe(true)
  })

  it('falls back to a bare dated draft on corrupt JSON', () => {
    const d = draftFromTemplate(template({ voucherJson: '{not json' }))
    expect(d).toEqual({ date: todayISO() })
  })

  it('tolerates missing fields in the stored voucher', () => {
    const d = draftFromTemplate(template({ voucherJson: '{}' }))
    expect(d.partyLedgerId).toBeUndefined()
    expect(d.narration).toBeUndefined()
    expect(d.lines).toEqual([])
  })
})

describe('templateOpenTarget', () => {
  it('targets voucher-entry with the template kind and draft', () => {
    const { screen, warnInvoice } = templateOpenTarget(template({}))
    expect(screen.name).toBe('voucher-entry')
    if (screen.name === 'voucher-entry') {
      expect(screen.kindHint).toBe('payment')
      expect(screen.draft?.partyLedgerId).toBe(12)
    }
    expect(warnInvoice).toBe(false) // accounting kinds keep their lines
  })

  it('warns for trading kinds — InvoiceEntry drops stored lines', () => {
    expect(templateOpenTarget(template({ voucherKind: 'sales' })).warnInvoice).toBe(true)
    expect(templateOpenTarget(template({ voucherKind: 'purchase' })).warnInvoice).toBe(true)
    expect(templateOpenTarget(template({ voucherKind: 'journal' })).warnInvoice).toBe(false)
  })

  it('a deleted voucher type (null kind) falls through without a kind hint or warning', () => {
    const { screen, warnInvoice } = templateOpenTarget(template({ voucherKind: null }))
    if (screen.name === 'voucher-entry') expect(screen.kindHint).toBeUndefined()
    expect(warnInvoice).toBe(false)
  })
})
