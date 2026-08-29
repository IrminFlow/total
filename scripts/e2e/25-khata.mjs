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

  // ---- who to chase today, on the Gateway ----
  // The Gateway used to show the five LARGEST receivables, which is the wrong five: the largest
  // debtor is usually the one who always pays.
  await h.goto('gateway')
  await h.page.waitForSelector('[data-testid="rows-chase-today"]', { timeout: 15000 })
  const chaseText = await h.page.textContent('[data-testid="rows-chase-today"]')
  assert(chaseText.length > 0, 'the chase panel renders')

  const receivable = await h.invoke('analysis:khata', { side: 'receivable', asOn })
  const overdue = receivable.filter((p) => p.worstOverdueDays > 0)
  if (overdue.length > 0) {
    // The most overdue party must be named, whether or not it is the largest.
    const worst = overdue.slice().sort((a, b) => b.worstOverdueDays - a.worstOverdueDays)[0]
    assert(chaseText.includes(worst.name), `the most overdue party is named (${worst.name})`)
    // And a reminder is one tap away for anyone with a number.
    if (worst.phone) {
      const btn = await h.page.$(`[data-testid="btn-chase-remind-${worst.ledgerId}"]`)
      assert(btn, 'a reminder button sits beside them')
    }
  }

  // The panel links to the full khata rather than being the only view of it.
  await h.click('btn-gateway-open-khata')
  await h.waitScreen('khata')
  await h.shot('04-chase-today')

  // ---- the call log, and the promises that come out of it ----
  // Chasing money is a conversation, and a promise nobody wrote down is a promise nobody follows
  // up. "He said he'd pay on the 20th" used to live in someone's head.
  const party = receivable[0]
  assert(party, 'there is a party to note against')

  await h.invoke('party:addNote', {
    ledgerId: party.ledgerId,
    note: 'Spoke to Ramesh — cheque on Friday',
    promisedDate: '2026-06-20',
    promisedAmount: 500000
  })
  const notes = await h.invoke('party:notes', { ledgerId: party.ledgerId })
  assert(notes.length === 1, 'the note is recorded')
  assert(notes[0].promisedDate === '2026-06-20', 'with the date they promised')
  assert(notes[0].promisedAmount === 500000, 'and the amount')

  // A second promise does not replace the first — a promise made and broken is exactly what the
  // next call needs to know.
  await h.invoke('party:addNote', {
    ledgerId: party.ledgerId,
    note: 'Did not pay — now says month end',
    promisedDate: '2026-06-30'
  })
  assert((await h.invoke('party:notes', { ledgerId: party.ledgerId })).length === 2, 'both are kept')

  const promises = await h.invoke('party:promises')
  assert(promises.length >= 2, 'both promises are open')
  // Most overdue first, which is the order the morning's calls go in.
  for (let i = 1; i < promises.length; i++) {
    assert(
      promises[i].overdueDays <= promises[i - 1].overdueDays,
      'the follow-up list is ordered by who to call first'
    )
  }

  // Closing one keeps it in the party's history but takes it off the list.
  await h.invoke('party:closeNote', { id: promises[0].id })
  const afterClose = await h.invoke('party:promises')
  assert(afterClose.length === promises.length - 1, 'a closed promise leaves the list')
  assert(
    (await h.invoke('party:notes', { ledgerId: party.ledgerId })).length === 2,
    'but stays in the history — the call log is the point'
  )

  await h.goto('gateway')
  await h.page.keyboard.press('k')
  await h.waitScreen('khata')
  await h.page.waitForSelector('[data-testid="follow-up-list"]', { timeout: 15000 })
  await h.shot('05-follow-up')
})
