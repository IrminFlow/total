// Scenario 25 — the khata.
//
// "Who owes me, how much, how long, and can they take more" is the question a small business asks
// every day, and answering it used to mean three screens. Two properties matter here: the khata
// and the ageing report must never disagree about what is open (they share one allocation), and
// the list must be ordered by who is worth calling rather than by who is worth the most.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('25-khata', async (h) => {
  await h.createDemoCompany()

  const info = (await h.invoke('company:current')).info
  const asOn = `${info.booksFrom + 1}-03-31`

  const khata = await h.invoke('analysis:khata', { side: 'receivable', asOn })
  const ageing = await h.invoke('analysis:outstandings', { side: 'receivable', asOn, includeBills: true })
  assert(khata.length > 0, 'the demo books have debtors')

  // One allocation behind both screens: the khata cannot say a party owes something the ageing
  // report does not.
  const byId = new Map(ageing.map((p) => [p.ledgerId, p]))
  for (const p of khata) {
    const other = byId.get(p.ledgerId)
    assert(other, `${p.name} appears in both`)
    assert(p.pending === other.pending, `${p.name}: pending agrees (${p.pending} vs ${other.pending})`)
    assert(p.billCount === other.billCount, `${p.name}: bill count agrees`)
    assert(
      JSON.stringify(p.buckets) === JSON.stringify(other.buckets),
      `${p.name}: ageing buckets agree`
    )
  }

  // Balance and pending are genuinely different numbers, and both are reported.
  for (const p of khata) {
    assert(typeof p.balance === 'number', `${p.name} carries a balance`)
    assert(p.oldestBillDays >= p.worstOverdueDays, `${p.name}: a bill cannot be overdue longer than it is old`)
  }

  // ---- the screen ----
  await h.page.keyboard.press('Escape')
  await h.page.keyboard.press('g')
  await h.waitScreen('gateway')
  await h.page.keyboard.press('k')
  await h.waitScreen('khata')
  await h.page.waitForSelector('[data-testid="rows-khata"] tr', { timeout: 15000 })

  const overdueCells = await h.page.$$eval('[data-testid="rows-khata"] tr', (els) =>
    els.slice(0, -1).map((tr) => tr.querySelectorAll('td')[4]?.textContent.trim() ?? '')
  )
  const asDays = overdueCells.map((t) => (t === '–' ? 0 : Number(t.replace('d', ''))))
  for (let i = 1; i < asDays.length; i++) {
    assert(
      asDays[i] <= asDays[i - 1],
      `most overdue first (${asDays[i - 1]}d then ${asDays[i]}d) — the one worth calling, not the largest`
    )
  }
  await h.shot('01-receivable')

  // Overdue-only hides everything still within terms.
  await h.click('btn-khata-overdue-only')
  await h.page.waitForFunction(
    () => {
      const rows = document.querySelectorAll('[data-testid="rows-khata"] tr')
      return rows.length === 0 || document.querySelector('[data-testid="rows-khata"]') !== null
    },
    null,
    { timeout: 15000 }
  )
  const filtered = await h.page.$$eval('[data-testid="rows-khata"] tr', (els) =>
    els.slice(0, -1).map((tr) => tr.querySelectorAll('td')[4]?.textContent.trim() ?? '')
  )
  assert(
    filtered.every((t) => t !== '–'),
    `overdue-only shows nothing that is still within terms (got ${JSON.stringify(filtered)})`
  )
  await h.shot('02-overdue-only')

  // The payable side asks the same question the other way round.
  await h.click('btn-khata-overdue-only')
  await h.page.click('[data-testid="tab-khata-payable"]')
  await h.page.waitForFunction(
    () => /who I owe/.test(document.body.textContent ?? ''),
    null,
    { timeout: 15000 }
  )
  const payable = await h.invoke('analysis:khata', { side: 'payable', asOn })
  // Both sides read as "what is owed" — a payable party's dr-negative balance is flipped, so a
  // caller never has to remember which way round it is.
  assert(
    payable.every((p) => p.side === 'payable'),
    'the payable side is labelled as such'
  )
  await h.shot('03-payable')
})
