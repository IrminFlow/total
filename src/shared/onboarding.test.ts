import { describe, expect, it } from 'vitest'
import { buildChecklist, SEEDED_LEDGER_COUNT, type ChecklistFacts } from './onboarding'

const empty: ChecklistFacts = {
  hasCompanyAddress: false,
  hasGstin: false,
  gstAnswered: false,
  ledgerCount: SEEDED_LEDGER_COUNT,
  voucherCount: 0,
  hasVerifiedBackup: false,
  hasSeenShortcuts: false
}

const stepFor = (facts: ChecklistFacts, id: string) =>
  buildChecklist(facts).steps.find((s) => s.id === id)!

describe('buildChecklist', () => {
  it('opens every step on a brand-new company', () => {
    const c = buildChecklist(empty)
    expect(c.doneCount).toBe(0)
    expect(c.complete).toBe(false)
    expect(c.steps.every((s) => !s.done)).toBe(true)
  })

  it('does not count the seeded ledgers as ledgers the user created', () => {
    // A step already ticked on arrival teaches nothing.
    expect(stepFor({ ...empty, ledgerCount: SEEDED_LEDGER_COUNT }, 'ledgers').done).toBe(false)
    expect(stepFor({ ...empty, ledgerCount: SEEDED_LEDGER_COUNT + 1 }, 'ledgers').done).toBe(true)
  })

  it('closes the voucher step on the first voucher, and reopens it if that voucher goes', () => {
    // Derived, not ticked: the list is self-healing, which is correct — the book really is empty.
    expect(stepFor({ ...empty, voucherCount: 1 }, 'voucher').done).toBe(true)
    expect(stepFor({ ...empty, voucherCount: 0 }, 'voucher').done).toBe(false)
  })

  it('needs both an address and a GST answer for company details', () => {
    expect(stepFor({ ...empty, hasCompanyAddress: true }, 'company').done).toBe(false)
    expect(stepFor({ ...empty, gstAnswered: true }, 'company').done).toBe(false)
    expect(stepFor({ ...empty, hasCompanyAddress: true, gstAnswered: true }, 'company').done).toBe(true)
  })

  it('treats "not registered" as a complete answer to the GSTIN step', () => {
    // Not every business has a GSTIN, and a checklist that can never be finished by an
    // unregistered business is a checklist that tells them they are doing it wrong.
    expect(stepFor({ ...empty, gstAnswered: true, hasGstin: false }, 'gstin').done).toBe(true)
    expect(stepFor({ ...empty, gstAnswered: true, hasGstin: true }, 'gstin').done).toBe(true)
    // Before the question has been answered at all, it is still open.
    expect(stepFor({ ...empty, gstAnswered: false, hasGstin: false }, 'gstin').done).toBe(false)
  })

  it('is complete only when every step is', () => {
    const all: ChecklistFacts = {
      hasCompanyAddress: true,
      hasGstin: true,
      gstAnswered: true,
      ledgerCount: SEEDED_LEDGER_COUNT + 3,
      voucherCount: 5,
      hasVerifiedBackup: true,
      hasSeenShortcuts: true
    }
    const c = buildChecklist(all)
    expect(c.complete).toBe(true)
    expect(c.doneCount).toBe(c.steps.length)
  })

  it('gives every step a reason and a place to go, except the one with nowhere to go', () => {
    for (const step of buildChecklist(empty).steps) {
      expect(step.why.length).toBeGreaterThan(20)
      if (step.id === 'shortcuts') expect(step.screen).toBeNull()
      else expect(step.screen).toBeTruthy()
    }
  })
})
