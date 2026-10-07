import { describe, expect, it } from 'vitest'
import { deriveOnboarding, isInvoiceConfigCustomised, isPrintSetupCustomised, onboardingFromDashSetup, type OnboardingFacts } from './onboarding'
import { DEFAULT_INVOICE_CONFIG } from './invoiceConfig'

const groups = [
  { id: 1, name: 'Current Assets', parentId: null },
  { id: 2, name: 'Bank Accounts', parentId: 1 },
  { id: 3, name: 'Savings', parentId: 2 },
  { id: 4, name: 'Sundry Debtors', parentId: 1 }
]

const blank: OnboardingFacts = {
  company: { name: 'Acme', address: '', stateCode: '27', gstin: null, gstRegistrationType: 'regular', email: null, phone: null },
  ledgers: [{ isSystem: true, groupId: 4 }],
  groups,
  voucherCount: 0,
  backupCount: 0,
  invoiceConfigured: false
}

const byId = (facts: OnboardingFacts): Record<string, boolean> =>
  Object.fromEntries(deriveOnboarding(facts).steps.map((s) => [s.id, s.done]))

describe('deriveOnboarding', () => {
  it('a fresh company has nothing done', () => {
    const r = deriveOnboarding(blank)
    expect(r.doneCount).toBe(0)
    expect(r.total).toBe(7)
    expect(r.complete).toBe(false)
  })

  it('company details need address, state and a phone or email', () => {
    expect(byId({ ...blank, company: { ...blank.company!, address: 'MG Road' } }).company).toBe(false)
    expect(byId({ ...blank, company: { ...blank.company!, address: 'MG Road', phone: '98200' } }).company).toBe(true)
  })

  it('GSTIN: set, or skipped for an unregistered company', () => {
    expect(byId({ ...blank, company: { ...blank.company!, gstin: '27AAAAA0000A1Z5' } }).gstin).toBe(true)
    const r = deriveOnboarding({ ...blank, company: { ...blank.company!, gstRegistrationType: 'unregistered' } })
    const step = r.steps.find((s) => s.id === 'gstin')!
    expect(step.done).toBe(true)
    expect(step.skipped).toBe(true)
  })

  it('a ledger beyond the seeded system ledgers counts; a bank ledger at any depth under Bank Accounts', () => {
    expect(byId({ ...blank, ledgers: [{ isSystem: false, groupId: 4 }] }).ledger).toBe(true)
    expect(byId({ ...blank, ledgers: [{ isSystem: false, groupId: 4 }] }).bank).toBe(false)
    expect(byId({ ...blank, ledgers: [{ isSystem: false, groupId: 3 }] }).bank).toBe(true)
  })

  it('voucher, backup and invoice steps follow their facts; all done = complete', () => {
    const r = deriveOnboarding({
      company: { name: 'Acme', address: 'MG Road', stateCode: '27', gstin: '27AAAAA0000A1Z5', gstRegistrationType: 'regular', email: 'a@b.c', phone: null },
      ledgers: [{ isSystem: false, groupId: 2 }],
      groups,
      voucherCount: 3,
      backupCount: 1,
      invoiceConfigured: true
    })
    expect(r.complete).toBe(true)
    expect(r.doneCount).toBe(7)
  })

  it('no company info yet → company and gstin pending', () => {
    const r = byId({ ...blank, company: null })
    expect(r.company).toBe(false)
    expect(r.gstin).toBe(false)
  })
})

describe('isInvoiceConfigCustomised', () => {
  it('defaults are not customised; any changed field is', () => {
    expect(isInvoiceConfigCustomised(null)).toBe(false)
    expect(isInvoiceConfigCustomised(DEFAULT_INVOICE_CONFIG)).toBe(false)
    expect(isInvoiceConfigCustomised({ ...DEFAULT_INVOICE_CONFIG, terms: 'Net 30' })).toBe(true)
    expect(isInvoiceConfigCustomised({ ...DEFAULT_INVOICE_CONFIG, copyLabels: ['Original', 'Duplicate'] })).toBe(true)
  })
})

describe('onboardingFromDashSetup', () => {
  const setup = { companyInfoComplete: true, gstRegistered: true, gstinSet: false, userLedgers: 2, bankLedgers: 0, voucherCount: 5, userBackups: 0 }
  it('maps the dashboard setup section onto the same steps', () => {
    const r = onboardingFromDashSetup(setup, true)
    expect(Object.fromEntries(r.steps.map((s) => [s.id, s.done]))).toEqual({
      company: true, gstin: false, ledger: true, bank: false, voucher: true, invoice: true, backup: false
    })
    expect(r.doneCount).toBe(4)
  })
  it('without the invoice fact the invoice step is left out; unregistered skips the GSTIN', () => {
    const r = onboardingFromDashSetup({ ...setup, gstRegistered: false })
    expect(r.steps.map((s) => s.id)).not.toContain('invoice')
    expect(r.total).toBe(6)
    expect(r.steps.find((s) => s.id === 'gstin')).toMatchObject({ done: true, skipped: true })
  })
})

describe('isPrintSetupCustomised', () => {
  it('a customised built-in or any user template counts', () => {
    expect(isPrintSetupCustomised(null)).toBe(false)
    expect(isPrintSetupCustomised({ templates: [{ builtIn: true, customised: false }] })).toBe(false)
    expect(isPrintSetupCustomised({ templates: [{ builtIn: true, customised: true }] })).toBe(true)
    expect(isPrintSetupCustomised({ templates: [{ builtIn: false, customised: false }] })).toBe(true)
  })
})
