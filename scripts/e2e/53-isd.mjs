// Scenario 53 — Input Service Distributor (roadmap #355).
//
// A business with registrations in several states pays some bills once, centrally. The invoice
// names one GSTIN; the credit belongs to all of them. Since 1 April 2025 an ISD registration is
// how it has to move — not optional, as it used to be.
//
// The properties this asserts:
//
//   1. A registration can be marked as the ISD, and there is only ever one.
//   2. The ratio is each recipient's OWN turnover in the relevant period, not the company's.
//   3. Distribution splits the credit on that ratio, exactly — nothing is lost or gained.
//   4. CGST+SGST leaves as IGST for a recipient outside the distributor's state. This is the part
//      of ISD that is invisible until a return is filed.
//   5. The recipient's GSTR-3B carries it in 4(A)(4), the ISD row that was always zero.
//   6. Nothing posts: the trial balance and the P&L are unchanged.
//   7. GSTR-6 is data with a due date of the 13th, in the table numbering of FORM GSTR-6 itself.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

const MH = '27AAAPA1234A1ZT'
const GJ = '24AAAPA1234A1ZZ'
const DL = '07AAAPA1234A1ZV'

await scenario('53-isd', async (h) => {
  await h.createCompanyUI('Common Bill Traders')
  await h.stubDialogs()

  const info = await h.invoke('company:current')
  await h.invoke('company:updateInfo', {
    ...info.info, gstin: MH, stateCode: '27', gstRegistrationType: 'regular'
  })
  const gjReg = await h.invoke('gstReg:save', {
    gstin: GJ, stateCode: '24', tradeName: 'Surat branch', address: 'Surat',
    registeredOn: null, surrenderedOn: null
  })
  const dlReg = await h.invoke('gstReg:save', {
    gstin: DL, stateCode: '07', tradeName: 'Head office', address: 'Delhi',
    registeredOn: null, surrenderedOn: null
  })
  const mhReg = (await h.invoke('gstReg:list')).find((r) => r.gstin === MH)


  // These books start this financial year, so the preceding year holds nothing — which is exactly
  // the case rule 39's Explanation falls back to the last quarter for. The sales below sit in that
  // quarter, and the distribution month is chosen to be after it.
  const fyStart = (() => {
    const d = new Date()
    return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  })()
  const MONTH = `${fyStart}-08`
  const asOn = `${fyStart + 1}-03-31`

  // ---- 1. one ISD ----
  const marked = await h.invoke('isd:setRegistration', { id: dlReg.id })
  assertEq(marked.gstin, DL, 'the Delhi registration is the ISD')
  await h.invoke('isd:setRegistration', { id: mhReg.id })
  await h.invoke('isd:setRegistration', { id: dlReg.id })
  const deskEmpty = await h.invoke('isd:desk', { month: MONTH })
  assertEq(deskEmpty.isd.gstin, DL, 'and moving it leaves exactly one, not two')
  assertEq(deskEmpty.recipients.length, 2, 'the ISD is never a recipient of its own distribution')

  // ---- turnover in the relevant period: the preceding financial year ----
  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  const mk = (input) => h.invoke('master:ledgers:create', {
    openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null,
    gstRate: null, hsn: null, tdsSectionId: null, pan: null, ...input
  })
  await mk({ name: 'Sales 18', groupId: gid('Sales Accounts'), gstRate: 18, hsn: '9983' })
  await mk({ name: 'Buyer', groupId: gid('Sundry Debtors'), gstin: '27AAPFU0939F1ZV', stateCode: '27' })
  const ledgers = await h.invoke('master:ledgers:list')
  const L = (name) => ledgers.find((l) => l.name === name).id
  const types = await h.invoke('master:voucherTypes:list')
  const salesType = types.find((t) => t.kind === 'sales').id

  const sell = (registrationId, amount, date) =>
    h.invoke('voucher:save', {
      data: {
        voucherTypeId: salesType,
        date,
        partyLedgerId: L('Buyer'),
        gstRegistrationId: registrationId,
        lines: [
          { ledgerId: L('Buyer'), drCr: 'dr', amount, costAllocations: [] },
          { ledgerId: L('Sales 18'), drCr: 'cr', amount, costAllocations: [] }
        ],
        inventory: [],
        billRefs: [],
        tds: null
      }
    })

  // ₹6,00,000 in Maharashtra and ₹4,00,000 in Gujarat, in the quarter the ratio is read from.
  await sell(mhReg.id, 60000000, `${fyStart}-05-10`)
  await sell(gjReg.id, 40000000, `${fyStart}-05-11`)

  // ---- 2. the ratio ----
  const desk = await h.invoke('isd:desk', { month: MONTH })
  assertEq(
    desk.period.kind,
    'last-quarter',
    'no recipient traded in the preceding financial year, so rule 39 falls back to the last quarter'
  )
  const mhRec = desk.recipients.find((r) => r.registrationId === mhReg.id)
  const gjRec = desk.recipients.find((r) => r.registrationId === gjReg.id)
  assertEq(desk.recipients.length, 2, 'the ISD itself is not one of its own recipients')
  assertEq(mhRec.turnoverPaise, 60000000, "Maharashtra's own turnover, not the company's")
  assertEq(gjRec.turnoverPaise, 40000000, "and Gujarat's own")

  // ---- the common bill: ₹1,00,000 audit fee, CGST ₹9,000 + SGST ₹9,000 ----
  // Enter it through the UI so invoice value, POS and the rate-wise Table 3 row are exercised.
  await h.goto('disclosure')
  await h.click('tab-disclosure-isd')
  await h.fill('input-isd-month', MONTH)
  await h.waitIdle()
  await h.click('btn-isd-add-credit')
  await h.fill('input-isd-date', `12-08-${fyStart}`)
  await h.page.getByTestId('input-isd-date').press('Enter')
  await h.page.waitForTimeout(50)
  await h.fill('input-isd-invoice-number', 'A/26/9')
  await h.fill('input-isd-supplier', 'Audit LLP')
  await h.fill('input-isd-supplier-gstin', '07AAPFU0939F1ZX')
  await h.fill('input-isd-description', 'Statutory audit fee')
  await h.fill('input-isd-invoice-value', '118000')
  await h.fill('input-isd-pos', '07')
  await h.fill('input-isd-rate-0', '18')
  await h.fill('input-isd-item-taxable-0', '100000')
  await h.fill('input-isd-item-cgst-0', '9000')
  await h.fill('input-isd-item-sgst-0', '9000')
  await h.shot('53-isd-credit-modal')
  await h.click('btn-isd-save-credit')
  await h.page.waitForSelector('[data-testid="rows-isd-credits"] tr', { timeout: 10000 })
  assert((await h.page.getByTestId('rows-isd-credits').textContent())?.includes('12-Aug-26'), 'the visible invoice date survives DateInput commit')

  // ---- the books, before ----
  const tbBefore = await h.invoke('report:trialBalance', { asOn })
  const plBefore = await h.invoke('report:profitLoss', { from: `${fyStart}-04-01`, to: asOn })
  const vouchersBefore = (await h.invoke('voucher:list', { from: `${fyStart}-04-01`, to: asOn })).length

  // ---- 3 & 4. distribute ----
  const run = (await h.invoke('isd:desk', { month: MONTH })).preview
  assertEq(run.invoices.length, 2, 'one ISD invoice per recipient')
  const mhInv = run.invoices.find((i) => i.recipient.registrationId === mhReg.id)
  const gjInv = run.invoices.find((i) => i.recipient.registrationId === gjReg.id)
  assertEq(mhInv.eligible.igst, 1080000, '60% of ₹18,000 to Maharashtra')
  assertEq(gjInv.eligible.igst, 720000, 'and 40% to Gujarat')
  assertEq(mhInv.eligible.igst + gjInv.eligible.igst, 1800000, 'the whole credit, to the paise')
  assertEq(mhInv.eligible.cgst, 0, 'CGST+SGST left the Delhi ISD as IGST — both recipients are outside Delhi')
  assertEq(gjInv.eligible.sgst, 0, 'on both documents')
  assert(/^ISD\/\d{4}-\d{2}\/\d{4}$/.test(mhInv.number), 'numbered in the ISD series under rule 54(1)')
  // Commit through the visible control as well as checking the pure preview above. This also
  // proves the mutation refreshes the table the operator is looking at.
  await h.click('btn-isd-distribute')
  await h.page.waitForSelector('[data-testid="rows-isd-issued"] tr', { timeout: 10000 })

  // ---- 5. the recipient's return ----
  const mh3b = await h.invoke('gst:gstr3b', {
    from: `${MONTH}-01`, to: `${MONTH}-31`, period: `08${fyStart}`, registrationId: mhReg.id
  })
  assertEq(mh3b.itcParts.isd.igst, 1080000, "the recipient's 4(A)(4) carries the distributed credit")
  const isdRow = mh3b.json.itc_elg.itc_avl.find((r) => r.ty === 'ISD')
  assertEq(isdRow.iamt, 10800, 'and the ISD row in the portal JSON is no longer hard zero')

  // ---- 6. nothing posted ----
  const tbAfter = await h.invoke('report:trialBalance', { asOn })
  assertEq(tbAfter.totalDebit, tbBefore.totalDebit, 'the trial balance is unchanged')
  assertEq(tbAfter.totalCredit, tbBefore.totalCredit, 'on both sides')
  const plAfter = await h.invoke('report:profitLoss', { from: `${fyStart}-04-01`, to: asOn })
  assertEq(plAfter.netProfit, plBefore.netProfit, 'the P&L is unchanged — credit moved, nothing was earned')
  assertEq(
    (await h.invoke('voucher:list', { from: `${fyStart}-04-01`, to: asOn })).length,
    vouchersBefore,
    'and no voucher was posted'
  )

  // ---- 7. GSTR-6 ----
  const g6 = await h.invoke('isd:gstr6', { month: MONTH })
  assertEq(g6.dueDate, `${fyStart}-09-13`, 'GSTR-6 is due thirteen days after the month — section 39(4)')
  assertEq(g6.undistributedPaise, 0, 'everything received was distributed')
  // The table numbering was checked against FORM GSTR-6 [See rule 65] — Table 3 inward, Table 4
  // available, Table 5 distribution with 5A eligible and 5B ineligible — so it no longer calls
  // itself a guess. Portal-file readiness is a separate, dated and machine-readable audit.
  assertEq(g6.layoutUnverified, false, 'the table numbering is read in FORM GSTR-6, not guessed')
  assert(g6.formCitation.includes('rule 65'), 'and the working names the form it follows')
  assertEq(g6.portalFile.ready, false, 'portal JSON stays disabled')
  assertEq(g6.portalFile.auditedOn, '2026-08-28', 'the official-source audit is dated')
  assertEq(g6.portalFile.schemaStatus, 'Draft', 'GSTN exposes only a Draft save schema')
  assertEq(g6.portalFile.validation.valid, true, 'the Draft-v1.0-shaped preview validates structurally and ties')
  assertEq(g6.portalFile.preview.b2b[0].inv[0].pos, '07', 'Table 3 preview carries place of supply')
  assertEq(g6.portalFile.preview.b2b[0].inv[0].itms[0].itm_det.rt, 18, 'and the rate-wise item')
  assertEq(
    g6.portalFile.preview.isd.elglst.reduce((sum, group) => sum + group.doclst[0].camti + group.doclst[0].samti, 0),
    18000,
    'source CGST/SGST to destination IGST lineage is preserved in portal field names'
  )
  assert(g6.portalFile.blockers.some((b) => b.includes('signed-in GST portal')), 'signed-in business validation remains explicit')
  assert(
    !g6.warnings.some((w) => w.includes('not been checked against the notification')),
    'the rules applied are no longer flagged as unchecked'
  )
  assert(
    !g6.warnings.some((w) => w.includes('compensation cess')),
    'and cess-to-cess is no longer flagged either — FORM GSTR-6 has a CESS column in Table 5'
  )

  // ---- the screen ----
  await h.goto('disclosure')
  await h.click('tab-disclosure-isd')
  await h.waitIdle()
  // The tab defaults to the session period's month; point it back at the distributed month.
  await h.fill('input-isd-month', MONTH)
  await h.waitIdle()
  assert(
    (await h.page.getByTestId('text-isd-portal-status').textContent())?.includes('Disabled after an official-source check'),
    'the screen shows the dated portal-file audit'
  )
  assert((await h.page.getByTestId('list-isd-portal-blockers').textContent())?.includes('signed-in GST portal'), 'the screen shows the remaining portal-authority blocker')
  const rows = await h.page.locator('[data-testid="rows-isd-issued"] tr').count()
  assertEq(rows, 2, 'the ISD tab lists both invoices it issued')
  await h.shot('53-isd')

  // Distribution is once per month.
  let threw = false
  try {
    await h.invoke('isd:distribute', { month: MONTH })
  } catch {
    threw = true
  }
  assert(threw, 'a month that has been distributed cannot be distributed again')
})
