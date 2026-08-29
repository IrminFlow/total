// Scenario 52 — the branch-transfer invoice (roadmap #108).
//
// Stock moved between two registrations of one PAN is a taxable supply under Schedule I para 2,
// even though nothing is sold and no money moves. Scenario 42 pinned the fact that the app FINDS
// the movement. This one pins that it raises the invoice, and — the part that makes it hard — that
// raising it changes nothing in the books.
//
// The properties this asserts:
//
//   1. The movement appears on the branch-transfer register awaiting an invoice.
//   2. Raising it leaves the TRIAL BALANCE, the P&L and the CLOSING STOCK VALUE exactly as they
//      were. One business, one set of books: a transfer between its own branches creates a tax
//      liability and a matching credit, but no revenue, no expense and no change in stock value.
//   3. The sender's GSTR-1 carries the outward supply, against the receiving GSTIN, as IGST.
//   4. The receiver's GSTR-3B carries the matching input credit, to the paise.
//   5. The GST validation warning retires — it reports what has no invoice, not what happened.
//   6. The Disclosure screen's Branch transfers tab shows it, and it never posts a voucher.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

const MH = '27AAAPA1234A1ZT'
const GJ = '24AAAPA1234A1ZZ'

await scenario('52-branch-transfer', async (h) => {
  await h.createCompanyUI('Branch Transfer Traders')
  await h.stubDialogs()

  const info = await h.invoke('company:current')
  await h.invoke('company:updateInfo', {
    ...info.info, gstin: MH, stateCode: '27', gstRegistrationType: 'regular'
  })
  const gjReg = await h.invoke('gstReg:save', {
    gstin: GJ, stateCode: '24', tradeName: 'Surat depot', address: 'Surat',
    registeredOn: null, surrenderedOn: null
  })
  const regs = await h.invoke('gstReg:list')
  const mhReg = regs.find((r) => r.gstin === MH)

  // ---- masters: a godown per registration, and something to move ----
  const godowns = await h.invoke('master:godowns:list')
  const mumbai = godowns[0]
  await h.invoke('master:godowns:update', {
    id: mumbai.id, data: { name: mumbai.name, gstRegistrationId: mhReg.id }
  })
  const surat = await h.invoke('master:godowns:create', {
    name: 'Surat warehouse', gstRegistrationId: gjReg.id
  })

  const units = await h.invoke('master:units:list')
  await h.invoke('master:stockItems:create', {
    name: 'Widget', unitId: units[0].id, gstRate: 18, hsn: '8481', openingQtyMilli: 0, openingValue: 0
  })
  const widget = (await h.invoke('master:stockItems:list')).find((i) => i.name === 'Widget')

  const groups = await h.invoke('master:groups:list')
  const gid = (name) => groups.find((g) => g.name === name).id
  await h.invoke('master:ledgers:create', {
    name: 'Purchases 18', groupId: gid('Purchase Accounts'), openingBalance: 0, gstin: null,
    stateCode: null, address: null, taxType: null, gstRate: 18, hsn: null, tdsSectionId: null, pan: null
  })
  const ledgers = await h.invoke('master:ledgers:list')
  const purchases = ledgers.find((l) => l.name === 'Purchases 18').id
  const cash = ledgers.find((l) => l.name === 'Cash').id
  const types = await h.invoke('master:voucherTypes:list')
  const purchaseType = types.find((t) => t.kind === 'purchase').id

  const fyStart = (() => {
    const d = new Date()
    return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  })()
  const from = `${fyStart}-07-01`
  const to = `${fyStart}-07-31`
  const period = `07${fyStart}`
  const asOn = `${fyStart + 1}-03-31`

  await h.invoke('voucher:save', {
    data: {
      voucherTypeId: purchaseType,
      date: `${fyStart}-07-02`,
      partyLedgerId: null,
      lines: [
        { ledgerId: purchases, drCr: 'dr', amount: 100000, costAllocations: [] },
        { ledgerId: cash, drCr: 'cr', amount: 100000, costAllocations: [] }
      ],
      inventory: [
        { stockItemId: widget.id, godownId: mumbai.id, qtyMilli: 10000, ratePaise: 10000, amount: 100000, direction: 'in' }
      ],
      billRefs: [],
      tds: null
    }
  })

  await h.invoke('stock:saveTransfer', {
    date: `${fyStart}-07-12`,
    fromGodownId: mumbai.id,
    toGodownId: surat.id,
    items: [{ stockItemId: widget.id, qtyMilli: 4000 }]
  })

  // ---- 1. it is awaiting an invoice ----
  let register = await h.invoke('branchTransfer:register', { from, to })
  assert(register.multiRegistration, 'the register knows this book has more than one registration')
  assertEq(register.pending.length, 1, 'the movement is awaiting an invoice')
  assertEq(register.pending[0].fromGstin, MH, 'it left the Maharashtra registration')
  assertEq(register.pending[0].toGstin, GJ, 'and arrived at the Gujarat one')
  assertEq(register.pending[0].supplyType, 'inter', 'two states means IGST')

  // ---- the books, before ----
  const tbBefore = await h.invoke('report:trialBalance', { asOn })
  const plBefore = await h.invoke('report:profitLoss', { from: `${fyStart}-04-01`, to: asOn })
  const stockBefore = await h.invoke('report:stockSummary', { asOn })
  const vouchersBefore = (await h.invoke('voucher:list', { from: `${fyStart}-04-01`, to: asOn })).length

  // ---- raise it ----
  const issued = await h.invoke('branchTransfer:issue', {
    from, to, basis: 'declared-full-itc', recipientFullItc: true
  })
  assertEq(issued.issued.length, 1, 'one invoice was raised')
  assertEq(issued.issued[0].igst, 7200, '18% IGST on the ₹1,000 of stock moved')
  assert(/^BT\/27\//.test(issued.issued[0].number), "numbered in the SENDING registration's own series")

  // ---- 2. the books did not move. This is the constraint that makes the item hard. ----
  const tbAfter = await h.invoke('report:trialBalance', { asOn })
  assertEq(tbAfter.totalDebit, tbBefore.totalDebit, 'the trial balance is unchanged')
  assertEq(tbAfter.totalCredit, tbBefore.totalCredit, 'on both sides')
  assertEq(tbAfter.rows.length, tbBefore.rows.length, 'and no ledger appeared or vanished')

  const plAfter = await h.invoke('report:profitLoss', { from: `${fyStart}-04-01`, to: asOn })
  assertEq(plAfter.netProfit, plBefore.netProfit, 'the P&L is unchanged — nothing was sold')

  const stockAfter = await h.invoke('report:stockSummary', { asOn })
  assertEq(
    stockAfter.reduce((t, r) => t + r.closingValue, 0),
    stockBefore.reduce((t, r) => t + r.closingValue, 0),
    'and the closing stock value is unchanged — the goods are still the same goods'
  )
  assertEq(
    (await h.invoke('voucher:list', { from: `${fyStart}-04-01`, to: asOn })).length,
    vouchersBefore,
    'no voucher was posted at all'
  )

  // ---- 3. the sender's return carries the outward supply ----
  const senderGstr1 = await h.invoke('gst:gstr1', { from, to, period, registrationId: mhReg.id })
  const b2b = senderGstr1.summary.find((s) => s.section === 'b2b')
  assertEq(b2b.docs, 1, "the branch transfer is a B2B document in the sender's GSTR-1")
  assertEq(b2b.taxable, 40000, 'at the value rule 28 fixed')
  assertEq(b2b.igst, 7200, 'carrying IGST, because the movement terminated in another state')
  const table13 = senderGstr1.json.doc_issue.doc_det.find((d) => d.doc_num === 1)
  assert(
    table13.docs.some((d) => d.from === issued.issued[0].number && d.to === issued.issued[0].number),
    "the sender's separately numbered branch-transfer series is in Table 13"
  )

  const senderGstr3b = await h.invoke('gst:gstr3b', { from, to, period, registrationId: mhReg.id })
  assertEq(senderGstr3b.outward.igst, 7200, "and it is 3.1(a) output tax in the sender's 3B")

  // ---- 4. the receiver's return carries the credit ----
  const receiverGstr3b = await h.invoke('gst:gstr3b', { from, to, period, registrationId: gjReg.id })
  assertEq(receiverGstr3b.itcParts.oth.igst, 7200, "the receiver's 4(A)(5) carries the matching credit")
  assertEq(
    receiverGstr3b.itcParts.oth.igst,
    senderGstr3b.outward.igst,
    'output tax in one registration equals input credit in the other — one PAN, nothing gained'
  )
  assertEq(receiverGstr3b.outward.taxable, 0, "and the supply is not in the RECEIVER's outward return")

  // ---- 5. the warning retires ----
  const validation = await h.invoke('gst:validate', { from, to, registrationId: mhReg.id })
  assertEq(
    validation.crossRegistration.length,
    0,
    'the return-preparation warning reports what has no invoice, and this one now has one'
  )

  // ---- 6. and it is on the screen ----
  await h.goto('disclosure')
  await h.click('tab-disclosure-branch')
  // The branch tab owns its own React Query. The parent screen's data-loading flag is already
  // false before this lazy tab mounts, so waitIdle() can return while the register is still in its
  // loading/empty render. Wait for the durable business result instead of racing the query.
  await h.page.waitForSelector('[data-testid="rows-bt-issued"] tr', { timeout: 15000 })
  const issuedRows = await h.page.locator('[data-testid="rows-bt-issued"] tr').count()
  assertEq(issuedRows, 1, 'the Branch transfers tab lists the invoice it raised')
  await h.shot('52-branch-transfers')

  // Idempotent: asking again documents nothing twice.
  const again = await h.invoke('branchTransfer:issue', {
    from, to, basis: 'declared-full-itc', recipientFullItc: true
  })
  assertEq(again.issued.length, 0, 'a movement that already has an invoice is never invoiced twice')

  register = await h.invoke('branchTransfer:register', { from, to })
  assertEq(register.issued.length, 1, 'and there is still exactly one document')
})
