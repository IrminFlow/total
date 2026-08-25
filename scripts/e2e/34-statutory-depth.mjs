// Scenario 34 — statutory depth: the documents and returns a CA asks for in the first meeting.
//
// Section S of the roadmap is mostly about producing paper the books could always have produced
// and never did. This walks the five that a user can now do end to end: the reverse-charge
// self-invoice, the Schedule III face, the Form 3CD pack, the TDS challan/return/Form 16A chain,
// and GSTR-1A.
//
// The assertions are about PROPERTIES rather than pixels: that the self-invoices cover exactly
// the supplies GSTR-3B taxes, that the Schedule III face ties to the balance sheet it is a view
// over, that a return will not export while it is unfileable, and that a period with no snapshot
// says so instead of reporting itself clean.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('34-statutory-depth', async (h) => {
  await h.createDemoCompany()

  const { info } = await h.invoke('company:current')
  const fyStartYear = info.booksFrom
  const from = `${fyStartYear}-04-01`
  const to = `${fyStartYear + 1}-03-31`

  const groups = await h.invoke('master:groups:list')
  const groupId = (name) => groups.find((g) => g.name === name).id
  const vts = await h.invoke('master:voucherTypes:list')
  const vtId = (kind) => vts.find((v) => v.kind === kind).id

  const ledger = (data) => h.invoke('master:ledgers:create', data)
  const post = (kind, date, partyLedgerId, lines) =>
    h.invoke('voucher:save', {
      data: {
        voucherTypeId: vtId(kind),
        date,
        partyLedgerId,
        lines: lines.map((l) => ({ ...l, costAllocations: [] })),
        inventory: [],
        billRefs: [],
        tds: null
      }
    })

  // ---- #356 the reverse-charge self-invoice ----

  // An unregistered goods-transport vendor, flagged for reverse charge: the section 9(4) case.
  const transporter = await ledger({
    name: 'Ram Transport (RCM)',
    groupId: groupId('Sundry Creditors'),
    stateCode: '27',
    rcm: true,
    address: 'Pune'
  })
  const freight = await ledger({
    name: 'Freight Inward (RCM)',
    groupId: groupId('Direct Expenses'),
    gstRate: 5,
    hsn: '996511'
  })
  const rcmDate = `${fyStartYear}-06-10`
  await post('purchase', rcmDate, transporter.id, [
    { ledgerId: freight.id, drCr: 'dr', amount: 10_000_00 },
    { ledgerId: transporter.id, drCr: 'cr', amount: 10_000_00 }
  ])

  let register = await h.invoke('rcm:register', { from, to })
  assert(register.pending.length === 1, `the reverse-charge purchase needs a document (got ${register.pending.length})`)
  assert(register.pending[0].basis === 'unregistered', 'an unregistered supplier is a section 9(4) supply')
  assert(register.issued.length === 0, 'nothing has been issued yet')

  const issued = await h.invoke('rcm:issue', { from, to, consolidate: false })
  assert(issued.issued.length === 1, 'one supply, one self-invoice')
  const doc = issued.issued[0]
  assert(/^RCM\/\d{4}-\d{2}\/0001$/.test(doc.number), `serial comes from its own dated series (got ${doc.number})`)
  assert(doc.taxable === 10_000_00, 'the taxable value is the purchase value')
  assert(doc.cgst + doc.sgst === 500_00, 'tax computed at the master rate — 5% on a local supply')

  // The set of documents must be the set GSTR-3B taxes. If these ever diverge the paper stops
  // adding up to the return and reconciling them becomes the user's problem forever.
  const gstr3b = await h.invoke('gst:gstr3b', {
    from: `${fyStartYear}-06-01`,
    to: `${fyStartYear}-06-30`,
    period: `06${fyStartYear}`
  })
  const rcmPayable = gstr3b.rcmPayable
  assert(
    rcmPayable.cgst + rcmPayable.sgst + rcmPayable.igst === doc.cgst + doc.sgst + doc.igst,
    'the self-invoice tax equals the 3B reverse-charge liability for the month'
  )

  // Idempotent: a purchase that already has a document is skipped, not documented twice.
  const again = await h.invoke('rcm:issue', { from, to, consolidate: false })
  assert(again.issued.length === 0 && again.skipped.length === 1, 'a documented purchase is never documented twice')

  register = await h.invoke('rcm:register', { from, to })
  assert(register.pending.length === 0 && register.issued.length === 1, 'the register moves it from pending to issued')

  // ---- #363 Schedule III ----

  const bs = await h.invoke('report:balanceSheet', { asOn: to })
  const s3 = await h.invoke('report:scheduleIII', { from, to })
  assert(
    s3.balanceSheet.totalAssets === s3.balanceSheet.totalEquityAndLiabilities,
    'the Schedule III face ties — a face that does not tie is the one failure this must never have'
  )
  assert(
    s3.balanceSheet.totalAssets === bs.totalAssets,
    `the face is a view over the same balance sheet (${s3.balanceSheet.totalAssets} vs ${bs.totalAssets})`
  )
  assert(
    s3.profitAndLoss.profitBeforeTax === s3.profitAndLoss.totalIncome - s3.profitAndLoss.totalExpenses,
    'income less expenses is the profit before tax'
  )
  assert(
    s3.balanceSheet.equityAndLiabilities.some((l) => l.key === 'tradePayables'),
    'trade payables is on the face'
  )

  // ---- #362 the Form 3CD pack ----

  const pack = await h.invoke('report:form3cd', { fyStartYear })
  assert(pack.extracts.length + pack.empty.length >= 11, 'every catalogued clause is either extracted or explained')
  assert(
    pack.empty.every((e) => e.reason.length > 0),
    'a clause with nothing in it says why — a blank page is not an answer'
  )

  // ---- #360 / #361 the TDS chain: challan, return, certificate ----

  // A statement is filed against a TAN by a named person. The demo company has neither, and the
  // return says so — recording them is the first step of the chain.
  await h.invoke('company:updateInfo', { ...info, tan: 'PNET12345B' })
  await h.invoke('tds:filingConfigSave', {
    responsiblePerson: 'A. Kumar',
    responsibleDesignation: 'Partner',
    deductorType: 'S'
  })

  const sections = await h.invoke('tds:sections')
  const s194c = sections.find((s) => s.code === '194C')
  const contractor = await ledger({
    name: 'Shyam Contractors',
    groupId: groupId('Sundry Creditors'),
    tdsSectionId: s194c.id,
    pan: 'AAAPA0000A'
  })
  const worksExpense = await ledger({ name: 'Contract Works', groupId: groupId('Direct Expenses') })
  const cashLedger = (await h.invoke('master:ledgers:list')).find((l) => l.name === 'Cash')
  const payable = await ledger({ name: 'TDS Payable 194C (e2e)', groupId: groupId('Duties & Taxes') })

  const tdsDate = `${fyStartYear}-06-15`
  await h.invoke('voucher:save', {
    data: {
      voucherTypeId: vtId('journal'),
      date: tdsDate,
      partyLedgerId: contractor.id,
      lines: [
        { ledgerId: worksExpense.id, drCr: 'dr', amount: 5_00_000_00, costAllocations: [] },
        { ledgerId: cashLedger.id, drCr: 'cr', amount: 4_95_000_00, costAllocations: [] },
        { ledgerId: payable.id, drCr: 'cr', amount: 5_000_00, costAllocations: [] }
      ],
      inventory: [],
      billRefs: [],
      tds: { sectionId: s194c.id, baseAmount: 5_00_000_00, tdsAmount: 5_000_00 }
    }
  })

  let working = await h.invoke('tds:return', { form: '26Q', fyStartYear, quarter: 1 })
  assert(working.deductions.length === 1, 'the deduction is in the quarter')
  assert(working.unlinkedTds === 5_000_00, 'and is not yet under a challan')
  assert(
    working.issues.some((i) => i.severity === 'blocking' && i.message.includes('challan')),
    'an unlinked deduction blocks the return'
  )

  // The e-TDS file must refuse while the return is unfileable — a file built from a return that
  // cannot be filed is not a draft, it is a wasted afternoon at a facilitation centre.
  let refused = false
  try {
    await h.invoke('tds:returnFile', { form: '26Q', fyStartYear, quarter: 1, acknowledgedUnverifiedFormat: true })
  } catch {
    refused = true
  }
  assert(refused, 'the e-TDS export refuses a return with a blocking issue')

  const challanId = await h.invoke('tds:challanSave', {
    form: '26Q',
    bsrCode: '0004329',
    paidOn: `${fyStartYear}-07-07`,
    serial: '00021',
    tax: 5_000_00,
    bookEntry: false
  })
  const challans = await h.invoke('tds:challans', { fyStartYear })
  assert(challans.length === 1 && challans[0].linked === 0, 'the challan is recorded with nothing against it yet')

  const entryIds = (await h.invoke('tds:return', { form: '26Q', fyStartYear, quarter: 1 })).deductions.map(
    (d) => d.entryId
  )
  await h.invoke('tds:link', { entryIds, challanId })

  working = await h.invoke('tds:return', { form: '26Q', fyStartYear, quarter: 1 })
  assert(working.unlinkedTds === 0, 'the deduction now sits under the challan')
  assert(
    working.issues.every((i) => i.severity !== 'blocking'),
    `nothing blocking remains (${working.issues.map((i) => i.message).join(' | ')})`
  )

  const file = await h.invoke('tds:returnFile', {
    form: '26Q',
    fyStartYear,
    quarter: 1,
    acknowledgedUnverifiedFormat: true
  })
  assert(file.lineCount === 4, `header, batch, challan and deductee (got ${file.lineCount})`)
  assert(file.unverifiedFormat === true, 'the export never stops saying the layout is unverified')

  // Form 16A — a working copy, and it says so first.
  const deductees = await h.invoke('tds:form16aDeductees', { fyStartYear, quarter: 1 })
  assert(deductees.length === 1 && deductees[0].name === 'Shyam Contractors', 'the vendor has something to certify')
  const cert = await h.invoke('tds:form16a', { ledgerId: contractor.id, fyStartYear, quarter: 1 })
  assert(cert.totalTds === 5_000_00, 'the certificate carries what was deducted')
  assert(cert.deductions[0].challan.bsrCode === '0004329', 'and how it was paid')
  assert(cert.warnings[0].includes('TRACES'), 'the first thing it says is that this is not the certificate')

  // ---- #353 GSTR-1A ----

  const period = `${fyStartYear}-06`
  let amend = await h.invoke('gst:gstr1a', { period })
  assert(amend.result === null, 'nothing is comparable before the return is recorded as filed')
  assert(amend.window.open === false, 'and the amendment window is shut')

  await h.invoke('filings:record', {
    form: 'GSTR-1',
    period,
    dueDate: `${fyStartYear}-07-11`,
    filedAt: `${fyStartYear}-07-10`,
    arn: 'AA270000000001Z',
    taxPaid: 0,
    notes: null
  })

  amend = await h.invoke('gst:gstr1a', { period })
  assert(amend.window.open === true, 'filed GSTR-1 and unfiled GSTR-3B opens the window')
  assert(
    amend.result === null && amend.message.includes('No snapshot'),
    'without a snapshot it says so rather than reporting itself clean'
  )

  const snap = await h.invoke('gst:gstr1Snapshot', { period })
  assert(snap.docs >= 0, 'the filed return is frozen')
  amend = await h.invoke('gst:gstr1a', { period })
  assert(amend.result.clean === true, 'immediately after the snapshot the books still match')

  // Add an invoice after "filing" — that is exactly what GSTR-1A exists for.
  const customer = await ledger({
    name: 'Late Invoice Customer',
    groupId: groupId('Sundry Debtors'),
    stateCode: '27'
  })
  const salesLedger = (await h.invoke('master:ledgers:list')).find((l) => l.name.startsWith('Sales'))
  await post('sales', `${fyStartYear}-06-28`, customer.id, [
    { ledgerId: customer.id, drCr: 'dr', amount: 50_000_00 },
    { ledgerId: salesLedger.id, drCr: 'cr', amount: 50_000_00 }
  ])

  amend = await h.invoke('gst:gstr1a', { period })
  assert(amend.result.clean === false, 'an invoice added after filing shows up')
  assert(
    amend.result.rows.some((r) => r.change === 'added'),
    'and is reported as an addition rather than an amendment'
  )

  // ---- #358 rate history ----

  const advisory = await h.invoke('gst:rateAdvisory', { from: '2025-09-01', to: '2025-09-30' })
  assert(
    advisory.structureChange && advisory.structureChange.effectiveFrom === '2025-09-22',
    'September 2025 is flagged as straddling the rate rationalisation'
  )
  assert(
    advisory.structureChange.unverified === true,
    'and the entry never claims to have been verified against the notification'
  )

  // ---- the screens render ----

  await h.goto('disclosure')
  await h.click('tab-disclosure-rcm')
  await h.waitIdle()
  await h.click('tab-disclosure-3cd')
  await h.waitIdle()
  await h.click('tab-disclosure-rates')
  await h.waitIdle()

  await h.goto('balance-sheet')
  await h.click('btn-bs-schedule3')
  await h.waitIdle()

  await h.goto('tds')
  await h.click('tab-tds-challans')
  await h.waitIdle()
  await h.click('tab-tds-return')
  await h.waitIdle()
  await h.click('tab-tds-certificates')
  await h.waitIdle()

  h.assertNoConsoleErrors()
})
