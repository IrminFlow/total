// Scenario 38 — section 197 lower-deduction certificates, and the Form 26AS credit check.
//
// The two properties this asserts, neither of which is about pixels:
//
//   1. A certificate really reduces the deduction, and a payment that crosses the Rule 28AA(4)
//      ceiling is deducted at TWO rates whose halves re-add to the whole. Getting this wrong is
//      not cosmetic: under-deducting is the deductor's own liability under s.201(1) with interest
//      under s.201(1A), and the two legs are filed as two deductee rows that have to foot.
//   2. The 26AS reconciliation reports both directions — credit the books claim that the
//      department's record does not support (s.199 / Rule 37BA), and tax the department can see
//      against income the books never recorded.
//
// It also pins the thing most likely to rot: with no certificate on file the deduction must be
// byte-identical to the plain section rate.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

const PAN = 'ABCDE1234F'

await scenario('38-tds-certificates', async (h) => {
  await h.createCompanyUI('Certificate Books')
  await h.stubDialogs()

  const groups = await h.invoke('master:groups:list')
  const creditors = groups.find((g) => g.name === 'Sundry Creditors')
  const debtors = groups.find((g) => g.name === 'Sundry Debtors')
  const duties = groups.find((g) => g.name === 'Duties & Taxes')
  const sections = await h.invoke('tds:sections')
  const s194c = sections.find((s) => s.code === '194C')
  assert(s194c, 'the seeded 194C section exists')
  assertEq(s194c.rate, 2, '194C is seeded at 2%')

  await h.invoke('master:ledgers:create', {
    name: 'Wireframe Constructions', groupId: creditors.id, openingBalance: 0,
    gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: s194c.id, pan: PAN
  })
  const ledgers = await h.invoke('master:ledgers:list')
  const payee = ledgers.find((l) => l.name === 'Wireframe Constructions')
  const cash = ledgers.find((l) => l.name === 'Cash')
  const types = await h.invoke('master:voucherTypes:list')
  const journal = types.find((t) => t.kind === 'journal')

  const fyStart = (() => {
    const d = new Date()
    return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  })()
  const dateIn = `${fyStart}-05-10`
  const from = `${fyStart}-04-01`
  const to = `${fyStart + 1}-03-31`

  // ---- 1. no certificate: the ordinary section rate, and nothing else ----
  const plain = await h.invoke('tds:suggest', { partyLedgerId: payee.id, base: 15000000, date: dateIn })
  assertEq(plain.tdsPaise, 300000, '2% of ₹1,50,000 is ₹3,000 with no certificate')
  assertEq(plain.certificate, null, 'no certificate is in force')
  assertEq(plain.ratesApplied.length, 1, 'one rate applies with no certificate')
  assertEq(plain.certificateExhausted, false, 'nothing to exhaust')

  // ---- 2. the owner enters the certificate the AO issued, through the UI ----
  await h.goto('tds')
  await h.click('tab-tds-certificates')
  await h.page.waitForSelector('[data-testid="input-tds-cert-number"]', { timeout: 10000 })
  await h.fill('input-tds-cert-number', 'AO197/2026/0001')
  await h.fill('input-tds-cert-pan', PAN)
  await h.fill('input-tds-cert-section', '194C')
  await h.fill('input-tds-cert-rate', '0.5')
  await h.fill('input-tds-cert-ceiling', '100000')
  await h.click('btn-tds-cert-save')
  await h.page.waitForSelector('[data-testid="rows-tds-certificates"] tr', { timeout: 10000 })
  await h.shot('01-certificate-added')

  const listed = await h.invoke('tds:certificates')
  assertEq(listed.length, 1, 'the certificate was stored')
  assertEq(listed[0].ceilingPaise, 10000000, 'the ₹1,00,000 ceiling round-trips as paise')
  assertEq(listed[0].exhausted, false, 'a fresh ceiling is not spent')

  // ---- 3. a payment straddling the ceiling is deducted at BOTH rates ----
  const split = await h.invoke('tds:suggest', { partyLedgerId: payee.id, base: 15000000, date: dateIn })
  assertEq(split.ratesApplied.length, 2, 'a straddling payment applies two rates')
  const under = split.ratesApplied.find((r) => r.underCertificate)
  const over = split.ratesApplied.find((r) => !r.underCertificate)
  assert(under && over, 'one leg under the certificate, one at the ordinary rate')
  assertEq(under.basePaise, 10000000, 'the certificate covers exactly its ceiling')
  assertEq(over.basePaise, 5000000, 'the excess reverts to the ordinary rate')
  assertEq(under.basePaise + over.basePaise, 15000000, 'the two legs are the whole payment')
  assertEq(under.tdsPaise + over.tdsPaise, split.tdsPaise, 'the two taxes are the whole deduction')
  assertEq(split.tdsPaise, 150000, '0.5% of ₹1,00,000 plus 2% of ₹50,000 is ₹1,500')
  assert(split.tdsPaise < plain.tdsPaise, 'the certificate reduced the deduction')
  assertEq(split.certificateExhausted, true, 'this payment spends the ceiling')

  // ---- 4. once spent, the register says so and the ordinary rate resumes ----
  await h.invoke('voucher:save', {
    data: {
      voucherTypeId: journal.id, date: dateIn, partyLedgerId: payee.id,
      narration: 'Contract payment', reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: payee.id, drCr: 'dr', amount: 10000000 },
        { ledgerId: cash.id, drCr: 'cr', amount: 10000000 }
      ],
      inventory: []
    }
  })
  const after = await h.invoke('tds:suggest', { partyLedgerId: payee.id, base: 5000000, date: dateIn })
  assertEq(after.certificate.headroomPaise, 0, 'the ceiling is spent')
  assertEq(after.tdsPaise, 100000, 'the ordinary 2% resumes past the ceiling')
  assert(after.ratesApplied.every((r) => !r.underCertificate), 'nothing rides the certificate any more')

  // The register has to make that visible — a spent certificate that still looks live is how
  // someone keeps deducting at 0.5% into a s.201(1) liability.
  await h.goto('daybook')
  await h.goto('tds')
  await h.click('tab-tds-certificates')
  await h.page.waitForSelector('[data-testid="rows-tds-certificates"] tr[data-exhausted="true"]', { timeout: 10000 })
  await h.page.waitForSelector('[data-testid="note-tds-cert-exhausted"]', { timeout: 10000 })
  await h.shot('02-ceiling-spent')

  // ---- 5. the 26AS credit check, both directions ----
  await h.invoke('master:ledgers:create', {
    name: 'Bright Media Pvt Ltd', groupId: debtors.id, openingBalance: 0,
    gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
  })
  await h.invoke('master:ledgers:create', {
    name: 'TDS Receivable 194J', groupId: duties.id, openingBalance: 0,
    gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null
  })
  const l2 = await h.invoke('master:ledgers:list')
  const customer = l2.find((l) => l.name === 'Bright Media Pvt Ltd')
  const receivable = l2.find((l) => l.name === 'TDS Receivable 194J')

  // A customer settles ₹1,00,000 net of ₹10,000 they withheld.
  await h.invoke('voucher:save', {
    data: {
      voucherTypeId: journal.id, date: dateIn, partyLedgerId: customer.id,
      narration: 'Receipt net of TDS', reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: cash.id, drCr: 'dr', amount: 9000000 },
        { ledgerId: receivable.id, drCr: 'dr', amount: 1000000 },
        { ledgerId: customer.id, drCr: 'cr', amount: 10000000 }
      ],
      inventory: []
    }
  })

  const header =
    'Name of Deductor,TAN of Deductor,Section,Transaction Date,Amount Paid / Credited,Tax Deducted,TDS Deposited'
  const day = dateIn.slice(8, 10)
  const monthName = 'May'
  const year = dateIn.slice(0, 4)

  // (a) the department's record agrees — nothing at risk.
  const agreeing = [
    'Form 26AS',
    'PAN of Assessee: AAACT1234A',
    '',
    header,
    `Bright Media Pvt Ltd,MUMB12345A,194J,${day}-${monthName}-${year},100000.00,10000.00,10000.00`
  ].join('\n')
  const ok = await h.invoke('tds:recon26as', { text: agreeing, from, to })
  assertEq(ok.problems.length, 0, 'a well-formed 26AS parses without complaint')
  assertEq(ok.result.buckets.matched.count, 1, 'the deduction matches the books')
  assertEq(ok.result.creditAtRiskPaise, 0, 'no credit at risk when the record agrees')

  // (b) the deductor deducted but never deposited — the credit is unavailable under s.199, and a
  // second deductor reported tax against income the books never recorded.
  const trouble = [
    header,
    `Bright Media Pvt Ltd,MUMB12345A,194J,${day}-${monthName}-${year},100000.00,10000.00,0.00`,
    `Quiet Systems LLP,DELQ98765B,194C,${day}-${monthName}-${year},50000.00,1000.00,1000.00`
  ].join('\n')
  const bad = await h.invoke('tds:recon26as', { text: trouble, from, to })
  assertEq(bad.result.creditAtRiskPaise, 1000000, 'tax deducted and not deposited is credit at risk')
  assertEq(bad.result.unrecordedCreditPaise, 100000, 'a 26AS row with no book entry is unrecorded income')

  // (c) an empty statement is a nil reconciliation, not a crash — and it is the WORST case, not
  // the best one: nobody has reported the credit the books are claiming.
  const empty = await h.invoke('tds:recon26as', { text: header, from, to })
  assertEq(empty.result.buckets.missingInStatement.count, 1, 'the book entry stands alone')
  assertEq(empty.result.creditAtRiskPaise, 1000000, 'the whole claimed credit is at risk')

  // ---- 6. the 26AS tab renders what the handler answered ----
  await h.click('tab-tds-26as')
  await h.click('btn-26as-paste')
  await h.page.waitForSelector('[data-testid="input-26as-paste"]', { timeout: 10000 })
  await h.page.fill('[data-testid="input-26as-paste"]', trouble)
  await h.click('btn-26as-paste-apply')
  await h.page.waitForSelector('[data-testid="figure-26as-at-risk"]', { timeout: 15000 })
  await h.page.waitForSelector('[data-testid="btn-26as-bucket-missingInBooks"]', { timeout: 10000 })
  await h.click('btn-26as-bucket-missingInBooks')
  await h.page.waitForSelector('[data-testid="rows-26as-pairs"] tr', { timeout: 10000 })
  const unrecorded = await h.page.$$eval('[data-testid="rows-26as-pairs"] tr', (els) => els.length)
  assertEq(unrecorded, 1, 'the unrecorded-income row is on screen, not just in the payload')
  await h.shot('03-26as-buckets')

  // ---- 7. deleting the certificate puts the ordinary rate back ----
  await h.click('tab-tds-certificates')
  await h.page.waitForSelector('[data-testid="rows-tds-certificates"] tr', { timeout: 10000 })
  await h.click(`btn-tds-cert-delete-${listed[0].id}`)
  await h.page.waitForFunction(
    () => !document.querySelector('[data-testid="rows-tds-certificates"]'),
    null,
    { timeout: 10000 }
  )
  const restored = await h.invoke('tds:suggest', { partyLedgerId: payee.id, base: 15000000, date: dateIn })
  assertEq(restored.certificate, null, 'the certificate is gone')
  assertEq(restored.tdsPaise, 300000, 'the deduction is back to the plain section rate')
})
