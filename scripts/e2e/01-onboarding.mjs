// Scenario 01 — onboarding: first launch lands on company-select; creating a company through
// the UI opens straight into the Gateway with seeded masters ready.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('01-onboarding', async (h) => {
  await h.waitScreen('company-select')
  await h.shot('01-company-select')

  await h.createCompanyUI('E2E Traders')
  await h.shot('02-gateway')

  // The sidebar (registry-derived nav testids) is up.
  await h.page.waitForSelector('[data-testid="nav-daybook"]', { timeout: 10000 })

  // Seeded masters exist for a brand-new company.
  const groups = await h.invoke('master:groups:list')
  assert(Array.isArray(groups) && groups.some((g) => g.name === 'Sales Accounts'), 'seeded groups include Sales Accounts')
  const ledgers = await h.invoke('master:ledgers:list')
  assert(ledgers.some((l) => l.name === 'Cash'), "seeded ledgers include 'Cash'")
  const types = await h.invoke('master:voucherTypes:list')
  assert(types.some((t) => t.kind === 'sales') && types.some((t) => t.kind === 'receipt'), 'seeded voucher types cover sales + receipt')

  // Round-trip a couple of screens to prove navigation works right after onboarding.
  await h.goto('masters')
  await h.goto('gateway')

  // ---- the getting-started checklist is derived, not ticked ----
  // A checklist someone can tick without doing the thing is a checklist that lies, and the one
  // moment it matters is the moment a new user is deciding whether this will work for them.
  const fresh = await h.invoke('app:checklist')
  assert(fresh.steps.length >= 5, 'the checklist has steps')
  assert(fresh.complete === false, 'a brand-new company has not finished it')
  const voucherStep = fresh.steps.find((s) => s.id === 'voucher')
  assert(voucherStep.done === false, 'and has posted no voucher')

  // The seeded ledgers do not count: a step already ticked on arrival teaches nothing.
  const ledgerStep = fresh.steps.find((s) => s.id === 'ledgers')
  assert(ledgerStep.done === false, 'the seeded chart of accounts is not "ledgers you created"')

  await h.page.waitForSelector('[data-testid="getting-started"]', { timeout: 15000 })
  const panel = await h.page.textContent('[data-testid="getting-started"]')
  assert(/Getting started/.test(panel), 'and it is on the Gateway')

  // Doing the thing closes the step — and undoing it opens the step again, because the list is
  // computed from the books rather than remembered.
  const vTypes = await h.invoke('master:voucherTypes:list')
  const chart = await h.invoke('master:ledgers:list')
  const cash = chart.find((l) => l.name === 'Cash')
  const chartGroups = await h.invoke('master:groups:list')
  const income = await h.invoke('master:ledgers:create', {
    name: 'Checklist Sales', groupId: chartGroups.find((g) => g.name === 'Sales Accounts').id,
    openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
  })
  const saved = await h.invoke('voucher:save', {
    data: {
      voucherTypeId: vTypes.find((t) => t.kind === 'receipt').id,
      date: new Date().toISOString().slice(0, 10),
      partyLedgerId: null, narration: 'Checklist', reference: null,
      instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
      transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: cash.id, drCr: 'dr', amount: 1000 },
        { ledgerId: income.id, drCr: 'cr', amount: 1000 }
      ],
      inventory: []
    }
  })

  const after = await h.invoke('app:checklist')
  assert(after.steps.find((s) => s.id === 'voucher').done === true, 'posting a voucher closes the step')
  assert(after.steps.find((s) => s.id === 'ledgers').done === true, 'and creating a ledger closes that one')

  await h.invoke('voucher:delete', { id: saved.id })
  const undone = await h.invoke('app:checklist')
  assert(
    undone.steps.find((s) => s.id === 'voucher').done === false,
    'deleting it opens the step again — the book really is empty'
  )
  await h.shot('05-checklist')
})
