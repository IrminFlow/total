// Scenario 21 — what the invoice entry screen tells you while you are typing.
//
// The entry form had no E2E coverage at all, and three things it now says are only reachable
// there: the party's current balance, the warning that a date falls outside the working period,
// and the reverse-charge / B2C-large notices. All are decisions the user can only take before
// saving, so the screen is the only place they can be tested.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('21-entry-guidance', async (h) => {
  await h.createDemoCompany()
  await h.stubDialogs() // the entry screen asks to confirm several things

  // Open a sales invoice.
  await h.page.keyboard.press('v')
  await h.waitScreen('voucher-entry')
  await h.page.click('[data-testid="tab-voucher-entry-sales"]')
  await h.page.waitForSelector('[data-testid="picker-party"]', { timeout: 15000 })
  await h.shot('01-blank')

  // ---- the party's balance appears once a party is chosen ----
  // "Does he already owe me?" is the question being asked at exactly this moment.
  // Pick a party that genuinely has a balance, so the assertion below is a real one rather than
  // one that passes because the element is legitimately absent.
  const today = new Date().toISOString().slice(0, 10)
  const balances = await h.invoke('master:ledgerBalances', { asOn: today })
  const ledgers = await h.invoke('master:ledgers:list')
  const withBalance = ledgers.find(
    (l) => l.gstin && (balances.find((b) => b.ledgerId === l.id)?.balance ?? 0) !== 0
  )
  assert(withBalance, 'the demo books have a party with a GSTIN and a non-zero balance')

  await h.page.fill('[data-testid="picker-party"]', withBalance.name.slice(0, 8))
  await h.page.keyboard.press('Enter')
  await h.page.waitForSelector('[data-testid="party-facts"]', { timeout: 15000 })
  const facts = await h.page.textContent('[data-testid="party-facts"]')
  assert(/GSTIN|Unregistered/.test(facts), 'the party line names the registration')
  assert(
    /Intra-state|Inter-state/.test(facts),
    'and which way the tax splits, which decides the whole invoice'
  )

  const balanceText = await h.page.textContent('[data-testid="party-balance"]')
  assert(/Balance/.test(balanceText), 'the balance is labelled')
  assert(/Dr|Cr/.test(balanceText), 'and says which side it is on, which is the whole point')
  await h.shot('02-party-chosen')

  // ---- the narration writes itself from what the voucher already says ----
  // Narration is the field most often left blank and most often wanted a year later. The
  // suggestion is a placeholder until the field is reached, and never overwrites typed text.
  const placeholder = await h.page.getAttribute('[data-testid="input-narration"]', 'placeholder')
  assert(
    new RegExp(withBalance.name.slice(0, 8), 'i').test(placeholder ?? ''),
    `the placeholder names the party (got ${JSON.stringify(placeholder)})`
  )
  assert(/^Sold /.test(placeholder ?? ''), 'and reads as a sentence about a sale')

  await h.page.focus('[data-testid="input-narration"]')
  const filled = await h.page.inputValue('[data-testid="input-narration"]')
  assert(filled === placeholder, 'focusing an empty narration accepts the suggestion')

  // Typing over it, then leaving and returning, must not restore the suggestion.
  await h.page.fill('[data-testid="input-narration"]', 'My own words')
  await h.page.focus('[data-testid="picker-party"]')
  await h.page.focus('[data-testid="input-narration"]')
  assert(
    (await h.page.inputValue('[data-testid="input-narration"]')) === 'My own words',
    'a narration already written is never overwritten'
  )

  // Leave the form clean before the scenario ends: an unsaved voucher arms the beforeunload
  // guard, and the native dialog that fires on teardown races the harness's own shutdown.
  // Escape in a field means "leave the field", so the first press blurs and the second leaves
  // the screen. Only then does the unsaved-changes guard get a chance to ask.
  await h.page.keyboard.press('Escape')
  await h.page.keyboard.press('Escape')
  const discard = await h.page.$('[data-testid="confirm-ok"]')
  if (discard) await discard.click()
  await h.waitScreen('gateway', 20000)
})
