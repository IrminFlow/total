// Scenario 26 — the collections desk.
//
// Chasing money is its own job: interest, reminders, credit scores, unallocated advances, the
// payment run and provisioning. Every one of them reads the same FIFO allocation the ageing
// report does, so the property that matters most is that none of them can disagree with it.
//
// The second property is that nothing here posts anything. The provisioning helper produces a
// draft journal; the reminders produce text. Both are asserted, because "the app decided to
// write off a customer" is the failure nobody would forgive.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('26-collections', async (h) => {
  await h.createDemoCompany()

  const info = (await h.invoke('company:current')).info
  const asOn = `${info.booksFrom + 1}-03-31`
  const from = `${info.booksFrom}-04-01`

  // ---- a party with terms, a salesperson and a territory ----
  const ledgers = await h.invoke('master:ledgers:list')
  const debtorGroup = (await h.invoke('master:groups:list')).find((g) => g.name === 'Sundry Debtors')
  const debtors = ledgers.filter((l) => l.groupId === debtorGroup.id)
  assert(debtors.length > 0, 'the demo books have debtors')
  const target = debtors[0]

  await h.invoke('master:ledgers:update', {
    id: target.id,
    data: {
      ...target,
      interestRateBp: 1800,
      interestGraceDays: 0,
      salesperson: 'Ravi',
      territory: 'West',
      creditLimit: 1000
    }
  })
  const reread = (await h.invoke('master:ledgers:list')).find((l) => l.id === target.id)
  assert(reread.interestRateBp === 1800, 'the interest rate round-trips through the master')
  assert(reread.salesperson === 'Ravi', 'the salesperson round-trips')
  assert(reread.territory === 'West', 'the territory round-trips')

  // ---- interest agrees with the ageing report about what is open ----
  const ageing = await h.invoke('analysis:outstandings', { side: 'receivable', asOn, includeBills: true })
  const interest = await h.invoke('recv:interest', { side: 'receivable', asOn })
  const mine = interest.find((r) => r.ledgerId === target.id)
  if (mine) {
    const fromAgeing = ageing.find((p) => p.ledgerId === target.id)
    assert(mine.pending === fromAgeing.pending, 'interest is computed on the same pending total as the ageing report')
    assert(mine.termsLabel === '18% p.a.', `terms read back as typed (${mine.termsLabel})`)
    const sum = mine.interest.lines.reduce((s, l) => s + l.interest, 0)
    assert(sum === mine.interest.total, 'the per-bill interest sums to the total')
    for (const l of mine.interest.lines) {
      assert(Number.isInteger(l.interest), `${l.number}: interest is integer paise`)
      assert(l.chargeableDays <= l.overdueDays, `${l.number}: grace can only reduce the days charged`)
    }
  }

  // Parties without a rate never appear, whatever they owe.
  const rateless = interest.find((r) => r.ledgerId !== target.id && r.terms.rateBp === 0)
  assert(!rateless, 'nobody is charged interest without a rate')

  // ---- ageing by salesperson: the columns and the totals are the same money ----
  const bySalesperson = await h.invoke('recv:ageingBy', { side: 'receivable', asOn, dimension: 'salesperson' })
  const grand = bySalesperson.rows.reduce((s, r) => s + r.pending, 0)
  assert(grand === bySalesperson.total, 'the group totals foot to the report total')
  assert(
    bySalesperson.totals.reduce((s, v) => s + v, 0) === bySalesperson.total,
    'the band columns foot to the same total'
  )
  assert(bySalesperson.rows.some((r) => r.key === 'Ravi'), 'the party lands under its salesperson')
  assert(bySalesperson.rows.some((r) => r.key === 'Unassigned'), 'parties with nobody named are a visible row, not a hidden one')
  assert(bySalesperson.bandLabels.length === bySalesperson.totals.length, 'one label per band')

  // The same money, sliced a different way, still totals the same.
  const byTerritory = await h.invoke('recv:ageingBy', { side: 'receivable', asOn, dimension: 'territory' })
  assert(byTerritory.total === bySalesperson.total, 'slicing by territory does not change how much is owed')

  // ---- credit scores are refused, not invented, without history ----
  const scores = await h.invoke('recv:creditScores', { asOn })
  for (const s of scores) {
    if (s.score === null) continue
    assert(s.score.score >= 0 && s.score.score <= 100, `${s.name}: score is in range`)
    assert(s.score.sample >= 4, `${s.name}: a score needs at least four settled bills`)
  }

  // ---- reminders name real bills, and the app never sends them ----
  const reminders = await h.invoke('recv:reminders', { side: 'receivable', asOn })
  assert(reminders.length > 0, 'the demo books have somebody to chase')
  for (const r of reminders) {
    assert(r.body.includes(r.name), `${r.name}: the letter greets the party`)
    assert(r.body.includes(info.name), `${r.name}: the letter is signed by the company`)
    assert(['gentle', 'firm', 'final'].includes(r.tone), `${r.name}: a known tone`)
    assert(r.mailto.startsWith('mailto:'), `${r.name}: an email draft, not a send`)
    if (r.whatsapp) {
      assert(r.whatsapp.startsWith('https://wa.me/'), `${r.name}: a wa.me link, not an API call`)
      assert(decodeURIComponent(r.whatsapp.split('text=')[1]) === r.body, `${r.name}: both channels carry the same text`)
    }
  }
  // Tone escalates with the oldest overdue bill, which is also the sort order.
  for (let i = 1; i < reminders.length; i++) {
    assert(
      reminders[i - 1].worstOverdueDays >= reminders[i].worstOverdueDays,
      'the list is ordered by who to call first'
    )
  }

  // ---- the payment run counts the money as well as the bills ----
  const schedule = await h.invoke('recv:paymentSchedule', { from: asOn, to: `${info.booksFrom + 1}-12-31` })
  let running = schedule.overdueTotal
  for (const d of schedule.days) {
    running += d.due
    assert(d.cumulative === running, `${d.date}: the cumulative outflow adds up`)
    assert(d.balanceAfter === schedule.funds - d.cumulative, `${d.date}: what is left is funds minus what has gone`)
    assert(d.due === d.bills.reduce((s, b) => s + b.pending, 0), `${d.date}: the day's total is its bills`)
  }
  assert(schedule.total === running, 'the schedule total is everything it listed')

  // ---- provisioning proposes; it never posts ----
  const vouchersBefore = (await h.invoke('voucher:list', { from, to: asOn })).length
  const provision = await h.invoke('recv:provision', { asOn })
  assert(
    provision.result.total === provision.result.parties.reduce((s, p) => s + p.provision, 0),
    'the provision total is the sum of its parties'
  )
  for (const p of provision.result.parties) {
    assert(p.provision <= p.pending, `${p.name}: cannot provide for more than is open`)
    for (const b of p.bills) assert(b.provision > 0, `${p.name}/${b.number}: only doubtful bills are listed`)
  }
  if (provision.draft) {
    const { lines } = provision.draft
    assert(lines.length === 2, 'the draft is one debit and one credit')
    assert(lines[0].drCr === 'dr' && lines[1].drCr === 'cr', 'expense debited, reserve credited')
    assert(lines[0].amount === lines[1].amount, 'the draft balances')
    const names = lines.map((l) => l.ledgerName)
    assert(
      !provision.result.parties.some((p) => names.includes(p.name)),
      'a provision never touches the customer — they still owe the money'
    )
  }
  const vouchersAfter = (await h.invoke('voucher:list', { from, to: asOn })).length
  assert(vouchersAfter === vouchersBefore, 'asking for a provision posted nothing')

  // ---- the statement of account ----
  const statement = await h.invoke('recv:statement', { ledgerId: target.id, from, to: asOn })
  const movement = statement.lines.reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0)
  assert(
    statement.closingBalance === statement.openingBalance + movement,
    'the statement runs the balance forward from its own opening figure'
  )
  if (statement.lines.length > 0) {
    assert(
      statement.lines[statement.lines.length - 1].balance === statement.closingBalance,
      'the last running balance is the closing balance'
    )
  }
  assert(
    statement.buckets.reduce((s, v) => s + v, 0) === statement.openBills.reduce((s, b) => s + b.pending, 0),
    'the ageing on the statement is the bills on the statement'
  )
  const pdf = await h.invoke('recv:statementPdf', { ledgerId: target.id, from, to: asOn, side: 'receivable' })
  assert(pdf.path.endsWith('.pdf'), `the statement prints to a PDF (${pdf.path})`)

  // ---- the policy is validated on the way in, not trusted ----
  let refused = false
  try {
    await h.invoke('recv:setPolicy', {
      interestRateBp: 1200,
      interestGraceDays: 0,
      bandCuts: [90, 30],
      provisionPolicy: [{ afterDays: 180, pct: 25 }],
      reminderMinOverdueDays: 1,
      contact: null
    })
  } catch {
    refused = true
  }
  assert(refused, 'a band set that goes backwards is refused')

  const policy = await h.invoke('recv:setPolicy', {
    interestRateBp: 1200,
    interestGraceDays: 7,
    bandCuts: [45, 90, 180],
    provisionPolicy: [{ afterDays: 180, pct: 25 }, { afterDays: 365, pct: 50 }],
    reminderMinOverdueDays: 1,
    contact: 'Accounts — 98765 43210'
  })
  assert(policy.bandCuts.join(',') === '45,90,180', 'the new bands are saved')
  const rebanded = await h.invoke('recv:ageingBy', { side: 'receivable', asOn, dimension: 'party' })
  assert(rebanded.bandLabels[0] === '0-45 days', 'the ageing report picks the new bands up')
  assert(rebanded.total === bySalesperson.total, 'changing the columns does not change the money')

  // The contact line reaches the letter.
  const afterPolicy = await h.invoke('recv:reminders', { side: 'receivable', asOn })
  assert(afterPolicy[0].body.includes('Accounts — 98765 43210'), 'the contact line is printed under the signature')

  // ---- the credit-limit check reads the same numbers the save path does ----
  const credit = await h.invoke('recv:creditCheck', { ledgerId: target.id, addPaise: 0 })
  assert(credit.creditLimit === 1000, 'the limit round-trips')
  assert(credit.after === credit.outstanding, 'with nothing being entered, after equals outstanding')
  const withVoucher = await h.invoke('recv:creditCheck', { ledgerId: target.id, addPaise: 500_00 })
  assert(withVoucher.after === credit.outstanding + 500_00, 'the voucher on screen is included')
  assert(withVoucher.exceeds === withVoucher.after > 1000, 'the breach flag follows the arithmetic')

  // ---- the screen ----
  await h.page.keyboard.press('Escape')
  await h.goto('collections')
  await h.page.waitForSelector('[data-testid="rows-reminders"] tr', { timeout: 15000 })
  await h.shot('01-reminders')

  await h.click('btn-reminder-preview-' + reminders[0].ledgerId)
  await h.page.waitForSelector('[data-testid="reminder-body"]', { timeout: 10000 })
  const previewed = await h.page.textContent('[data-testid="reminder-body"]')
  assert(previewed.includes(reminders[0].name), 'the preview shows the message that would be sent')
  await h.shot('02-reminder-preview')
  await h.page.keyboard.press('Escape')

  for (const [tab, rows] of [
    ['interest', 'panel-interest'],
    ['scores', 'rows-scores'],
    ['ageing', 'rows-ageing-by'],
    ['advances', 'panel-advances'],
    ['schedule', 'panel-schedule'],
    ['provision', 'panel-provision']
  ]) {
    await h.click(`tab-collections-${tab}`)
    await h.page.waitForSelector(`[data-testid="${rows}"]`, { timeout: 15000 })
    await h.shot(`03-${tab}`)
  }

  // The statement opens from the khata row, where the question is asked.
  await h.goto('khata')
  await h.page.waitForSelector('[data-testid="rows-khata"] tr', { timeout: 15000 })
  await h.click(`btn-khata-statement-${target.id}`)
  await h.page.waitForSelector('[data-testid="statement-body"]', { timeout: 15000 })
  await h.shot('04-statement')
})
