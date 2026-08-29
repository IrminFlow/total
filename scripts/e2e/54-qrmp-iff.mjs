// Scenario 54 — QRMP/IFF filing memory.
//
// IFF is not a preview of the quarter: filing it puts registered-recipient records on the
// portal. This real-Electron scenario proves M1/M2 are frozen separately, the quarter does not
// freeze those vouchers a second time, and a later correction still points to the IFF month in
// which the portal first saw the invoice.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

const iso = (d) => d.toISOString().slice(0, 10)
const monthKey = (d) => iso(d).slice(0, 7)
const portalPeriod = (d) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}${d.getUTCFullYear()}`

await scenario('54-qrmp-iff', async (h) => {
  await h.createDemoCompany()

  const now = new Date()
  const currentQuarterStart = new Date(Date.UTC(
    now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1
  ))
  const { rows: allRows } = await h.invoke('edoc:list', {
    from: `${now.getUTCFullYear() - 5}-01-01`, to: `${now.getUTCFullYear() + 1}-12-31`
  })
  const target = [...allRows].reverse().find((d) => {
    const date = new Date(`${d.date}T00:00:00Z`)
    return d.partyGstin && ['INV', 'CRN', 'DBN'].includes(d.docType) &&
      date < currentQuarterStart && date.getUTCMonth() % 3 < 2
  })
  assert(target, 'demo has an IFF-eligible document in a completed quarter')
  const targetDate = new Date(`${target.date}T00:00:00Z`)
  const qStart = new Date(Date.UTC(
    targetDate.getUTCFullYear(), Math.floor(targetDate.getUTCMonth() / 3) * 3, 1
  ))
  const m1 = new Date(qStart)
  const m2 = new Date(Date.UTC(qStart.getUTCFullYear(), qStart.getUTCMonth() + 1, 1))
  const m3 = new Date(Date.UTC(qStart.getUTCFullYear(), qStart.getUTCMonth() + 2, 1))
  const qEnd = new Date(Date.UTC(qStart.getUTCFullYear(), qStart.getUTCMonth() + 3, 0))
  const nextMonth = new Date(Date.UTC(qStart.getUTCFullYear(), qStart.getUTCMonth() + 3, 1))
  const quarterNumber = Math.floor(((qStart.getUTCMonth() + 9) % 12) / 3) + 1
  const filingYear = qStart.getUTCMonth() < 3 ? qStart.getUTCFullYear() - 1 : qStart.getUTCFullYear()
  const quarterKey = `${filingYear}-Q${quarterNumber}`

  const { rows } = await h.invoke('edoc:list', { from: iso(qStart), to: iso(qEnd) })
  const outward = rows.filter((d) => ['INV', 'CRN', 'DBN'].includes(d.docType))
  const eligibleM1 = outward.filter((d) => d.date.startsWith(monthKey(m1)) && d.partyGstin)
  const eligibleM2 = outward.filter((d) => d.date.startsWith(monthKey(m2)) && d.partyGstin)
  assert(
    eligibleM1.length + eligibleM2.length > 0,
    `selected quarter has an IFF-eligible M1/M2 document (${eligibleM1.length}/${eligibleM2.length})`
  )

  const apr = await h.invoke('filings:record', {
    form: 'IFF', period: monthKey(m1), dueDate: iso(new Date(Date.UTC(m2.getUTCFullYear(), m2.getUTCMonth(), 13))),
    filedAt: iso(new Date(Date.UTC(m2.getUTCFullYear(), m2.getUTCMonth(), 10))),
    arn: `IFF-${monthKey(m1)}`, taxPaid: 0, notes: null
  })
  assertEq(apr.snapshot.docs, eligibleM1.length, 'M1 freezes only its registered-recipient records')

  const may = await h.invoke('filings:record', {
    form: 'IFF', period: monthKey(m2), dueDate: iso(new Date(Date.UTC(m3.getUTCFullYear(), m3.getUTCMonth(), 13))),
    filedAt: iso(new Date(Date.UTC(m3.getUTCFullYear(), m3.getUTCMonth(), 10))),
    arn: `IFF-${monthKey(m2)}`, taxPaid: 0, notes: null
  })
  assertEq(may.snapshot.docs, eligibleM2.length, 'M2 does not freeze M1 records a second time')

  const quarter = await h.invoke('filings:record', {
    form: 'GSTR-1', period: quarterKey,
    dueDate: iso(new Date(Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth(), 13))),
    filedAt: iso(new Date(Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth(), 10))),
    arn: `GSTR1-${quarterKey}`, taxPaid: 0, notes: null
  })
  assertEq(
    apr.snapshot.docs + may.snapshot.docs + quarter.snapshot.docs,
    outward.length,
    'IFF and quarter snapshots partition the outward documents without omissions or duplicates'
  )

  const voucher = await h.invoke('voucher:get', { id: target.voucherId })
  const effectivePos = voucher.posOverride ?? target.partyGstin.slice(0, 2)
  const changedPos = effectivePos === '29' ? '30' : '29'
  await h.invoke('voucher:save', {
    id: target.voucherId,
    data: { ...voucher, posOverride: changedPos }
  })

  const report = await h.invoke('amendments:report', { period: portalPeriod(nextMonth) })
  const corrected = report.rows.filter((r) => r.voucherId === target.voucherId)
  assertEq(corrected.length, 1, 'an IFF invoice correction appears exactly once after quarter filing')
  assertEq(
    corrected[0].originalPeriod,
    portalPeriod(targetDate),
    'the original period remains the M1/M2 IFF in which the portal first saw it'
  )
  assert(
    corrected[0].changes.some((c) => c.field === 'pos'),
    `the correction retains its substantive POS diff (${JSON.stringify(corrected[0].changes)})`
  )
  assertEq(report.addedAfterFiling.length, 0, 'the completed quarter has no false missed-invoice warnings')

  // Re-entering a nil IFF later must preserve zero documents; this is the case a document-only
  // snapshot table could not distinguish from "never filed".
  const oldMonth = new Date(Date.UTC(qStart.getUTCFullYear() - 5, 0, 1))
  const oldDue = new Date(Date.UTC(qStart.getUTCFullYear() - 5, 1, 13))
  const nil = await h.invoke('filings:record', {
    form: 'IFF', period: monthKey(oldMonth), dueDate: iso(oldDue), filedAt: iso(oldDue),
    arn: 'IFF-NIL-1', taxPaid: 0, notes: null
  })
  assertEq(nil.snapshot.docs, 0, 'nil IFF records a real zero-document snapshot')
  const nilAgain = await h.invoke('filings:record', {
    form: 'IFF', period: monthKey(oldMonth), dueDate: iso(oldDue), filedAt: iso(oldDue),
    arn: 'IFF-NIL-2', taxPaid: 0, notes: null
  })
  assert(nilAgain.snapshot.keptExisting, 're-entering the nil IFF keeps its original snapshot header')
  assertEq(nilAgain.snapshot.docs, 0, 'and it remains nil')
})
