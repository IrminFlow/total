// Scenario 20 — the filing register: what a year owes, and what was actually filed.
//
// The app knew every due date and had nowhere to record that a return was filed, so "did we file
// August?" was a question you answered by logging into the portal. This walks the whole loop:
// the register lists every obligation, marking one filed records the ARN, the late fee is
// recomputed from the dates rather than trusted, and clearing it puts the row back.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('20-filings', async (h) => {
  await h.createDemoCompany()

  const info = (await h.invoke('company:current')).info
  const fyStartYear = info.booksFrom

  // ---- the register lists the year, all outstanding ----
  const register = await h.invoke('filings:register', { fyStartYear })
  assert(register.length === 24, `a monthly filer owes 24 returns a year (got ${register.length})`)
  assert(
    register.every((r) => r.record === null),
    'nothing is recorded to begin with'
  )
  assert(
    register.every((r) => ['GSTR-1', 'GSTR-3B'].includes(r.form)),
    'a monthly regular filer owes GSTR-1 and GSTR-3B and nothing else'
  )
  // Every obligation is either upcoming, due or overdue — never filed, and never unclassified.
  for (const r of register) {
    assert(['upcoming', 'due', 'overdue'].includes(r.status), `unexpected status ${r.status}`)
  }

  // A period still running must not read as overdue: that would be a false alarm every month.
  const running = register.filter((r) => r.status === 'upcoming')
  assert(running.length > 0, 'the current and future periods are upcoming, not overdue')

  // ---- record a filing over IPC, and see the register change ----
  const target = register.find((r) => r.form === 'GSTR-3B' && r.status !== 'upcoming')
  assert(target, 'at least one period has closed in the demo books')

  const rec = await h.invoke('filings:record', {
    form: target.form,
    period: target.period,
    dueDate: target.date,
    filedAt: target.date, // filed exactly on time
    arn: 'AA270526000001X',
    taxPaid: 0,
    notes: null
  })
  assert(rec.arn === 'AA270526000001X', 'the ARN round-trips')
  assert(rec.lateFee === 0 && rec.interest === 0, 'filing on the due date costs nothing')

  const after = await h.invoke('filings:register', { fyStartYear })
  const filed = after.find((r) => r.form === target.form && r.period === target.period)
  assert(filed.status === 'filed', 'the row now reads filed')
  assert(filed.projected === false, 'a filed row stops projecting a cost')
  assert(after.filter((r) => r.record !== null).length === 1, 'exactly one row moved')

  // ---- the fee is recomputed from the dates, not taken on trust ----
  const late = await h.invoke('filings:record', {
    form: target.form,
    period: target.period,
    dueDate: '2026-05-20',
    filedAt: '2026-06-19', // 30 days late
    arn: 'AA270526000002X',
    taxPaid: 1000000, // Rs 10,000
    notes: null
  })
  assert(late.lateFee === 30 * 50 * 100, `Rs 50 a day for 30 days (got ${late.lateFee})`)
  assert(late.interest === 14794, `18% a year on Rs 10,000 for 30 days (got ${late.interest})`)

  // ---- clearing puts it back ----
  const cleared = await h.invoke('filings:record', {
    form: target.form,
    period: target.period,
    dueDate: target.date,
    filedAt: null,
    arn: null,
    taxPaid: 0,
    notes: 'filed in error'
  })
  assert(cleared.filedAt === null, 'clearing removes the filing date')
  assert(cleared.lateFee === 0 && cleared.interest === 0, 'and zeroes what it cost')

  // ---- the screen ----
  await h.page.keyboard.press('Escape')
  await h.page.keyboard.press('g')
  await h.waitScreen('gateway')
  await h.page.keyboard.press('q')
  await h.waitScreen('filings')
  await h.page.waitForSelector('[data-testid="rows-filings"] tr', { timeout: 15000 })
  const rowCount = await h.page.$$eval('[data-testid="rows-filings"] tr', (els) => els.length)
  assert(rowCount === 24, `the screen shows every obligation (got ${rowCount})`)
  await h.shot('01-register')

  // Mark one filed through the UI, which is the path a filer actually takes.
  await h.page.click(`[data-testid="btn-filing-edit-${target.form}-${target.period}"]`)
  await h.page.waitForSelector('[data-testid="input-filing-arn"]', { timeout: 10000 })
  await h.page.fill('[data-testid="input-filing-arn"]', 'AA270526000009X')
  await h.shot('02-mark-filed')
  await h.click('btn-filing-save')
  await h.page.waitForSelector('[data-testid="input-filing-arn"]', { state: 'detached', timeout: 10000 })

  // The register refetches after the save, so wait for the ARN rather than racing the query.
  await h.page.waitForFunction(
    () => /AA270526000009X/.test(document.querySelector('[data-testid="rows-filings"]')?.textContent ?? ''),
    null,
    { timeout: 15000 }
  )
  await h.shot('03-filed')

  // ---- the nil shortcut, and what the books say is payable ----
  // A period with nothing in it still owes a return; the register offers it in one action rather
  // than walking a filer through a form whose every field is zero.
  const nilRow = after.find((r) => !r.hasEntries && r.status !== 'upcoming' && !r.record)
  assert(nilRow, 'the demo books have at least one empty closed period')
  const withEntries = after.find((r) => r.hasEntries)
  assert(withEntries, 'and at least one period that is not empty')
  // The shortcut must never be offered on a period that has real entries in it.
  const nilButtons = await h.page.$$eval('[data-testid^="btn-filing-nil-"]', (els) =>
    els.map((el) => el.dataset.testid)
  )
  assert(
    !nilButtons.includes(`btn-filing-nil-${withEntries.form}-${withEntries.period}`),
    'no nil shortcut on a period that has entries'
  )

  await h.page.click(`[data-testid="btn-filing-nil-${nilRow.form}-${nilRow.period}"]`)
  await h.page.waitForSelector('[data-testid="input-nil-arn"]', { timeout: 10000 })
  await h.page.fill('[data-testid="input-nil-arn"]', 'AA270526000011X')
  await h.shot('04-nil')
  await h.click('btn-nil-save')
  await h.page.waitForFunction(
    () => /AA270526000011X/.test(document.querySelector('[data-testid="rows-filings"]')?.textContent ?? ''),
    null,
    { timeout: 15000 }
  )
  const nilRecord = (await h.invoke('filings:register', { fyStartYear })).find(
    (r) => r.form === nilRow.form && r.period === nilRow.period
  )
  assert(nilRecord.record.taxPaid === 0, 'a nil return records no tax')
  assert(nilRecord.charge.interestPaise === 0, 'and can never carry interest')

  // The liability behind a payment form comes from the real return builder.
  const liability = await h.invoke('filings:liability', {
    form: 'GSTR-3B',
    period: withEntries.period
  })
  assert(liability.source === 'GSTR-3B', 'the figure says where it came from')
  assert(typeof liability.taxPayable === 'number', 'and is a number for a payment form')
  // GSTR-1 takes no payment, so it answers null rather than a misleading zero.
  const noPayment = await h.invoke('filings:liability', { form: 'GSTR-1', period: withEntries.period })
  assert(noPayment.taxPayable === null, 'GSTR-1 carries no payment')

  // The ARN is the point of the record — saving without one must be refused.
  const other = after.find((r) => r.period !== target.period && r.status !== 'upcoming' && !r.record)
  await h.page.click(`[data-testid="btn-filing-edit-${other.form}-${other.period}"]`)
  await h.page.waitForSelector('[data-testid="input-filing-arn"]', { timeout: 10000 })
  await h.click('btn-filing-save')
  // Still open: the save was refused rather than silently recording a blank ARN.
  await h.page.waitForSelector('[data-testid="input-filing-arn"]', { timeout: 5000 })
  const stillOpen = await h.page.$('[data-testid="input-filing-arn"]')
  assert(stillOpen, 'saving without an ARN is refused')
})
