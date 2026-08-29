// Scenario 34 — GSTR-1 amendments (Tables 9A/9C) and the e-way bill distance estimate.
//
// Two properties, both about not lying to the user.
//
// AMENDMENTS: a return that has been filed cannot be re-filed, so a correction to a filed
// invoice is a new row in a LATER period keyed on the ORIGINAL document. That is only possible
// if the app remembers what the return said — so the documents are frozen when the GSTR-1 is
// marked filed, the snapshot survives the ARN being re-entered, and a period that was never
// filed says so instead of showing an empty table that reads "nothing changed".
//
// DISTANCE: the PIN-code estimate is approximate, and the distance on an e-way bill decides how
// long the bill stays valid. So the estimate is offered with its disclaimer and never lands in
// the field on its own, and an unresolvable PIN offers nothing at all rather than a guess.
import { scenario, assert, assertEq } from '../lib/harness.mjs'
import * as fs from 'node:fs'

const monthOf = (d) => ({
  key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
  from: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`,
  to: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    new Date(Date.UTC(d.getFullYear(), d.getMonth() + 1, 0)).getUTCDate()
  ).padStart(2, '0')}`,
  period: `${String(d.getMonth() + 1).padStart(2, '0')}${d.getFullYear()}`
})

await scenario('37-amendments', async (h) => {
  await h.createDemoCompany()
  await h.stubDialogs() // the export reveals the file in Finder

  const now = new Date()
  // The demo books span the trailing months. File LAST month's GSTR-1 and amend in this one —
  // an amendment can only ever be raised in a period later than the one it corrects.
  const filed = monthOf(new Date(now.getFullYear(), now.getMonth() - 1, 1))
  const amending = monthOf(now)

  // ---- nothing filed yet: not "nothing changed", but "nothing to compare against" ----
  const before = await h.invoke('amendments:report', { period: amending.period })
  assert(before.noSnapshots, 'with no filed return there is nothing to amend against')
  assertEq(before.filedPeriods.length, 0, 'no snapshots exist')
  assertEq(before.json, null, 'and no amendment JSON')

  // ---- mark last month's GSTR-1 filed: the moment its documents are frozen ----
  // edoc:list is paginated — { rows, total, nextCursor }. This scenario was written on a branch
  // where it still returned a bare array; the period's whole document set comes back in `rows`
  // when no limit is asked for, so destructuring is the entire change (cf. 06-gst, 18-composition).
  const { rows: docs } = await h.invoke('edoc:list', { from: filed.from, to: filed.to })
  const b2b = docs.filter((d) => d.partyGstin && d.docType === 'INV')
  assert(b2b.length >= 2, `the demo month has B2B invoices to work with (got ${b2b.length})`)

  const record = await h.invoke('filings:record', {
    form: 'GSTR-1',
    period: filed.key,
    dueDate: `${amending.key}-11`,
    filedAt: `${amending.key}-11`,
    arn: 'AA270826000001X',
    taxPaid: 0,
    notes: null
  })
  assert(record.snapshot, 'marking a GSTR-1 filed takes a snapshot of what it contained')
  assert(record.snapshot.docs > 0, 'and the snapshot holds the period documents')
  assertEq(record.snapshot.keptExisting, false, 'this is the first snapshot for the period')
  const filedDocs = record.snapshot.docs

  // ---- nothing has changed yet ----
  const clean = await h.invoke('amendments:report', { period: amending.period })
  assertEq(clean.noSnapshots, false, 'a filed period is now available to amend against')
  assertEq(clean.rows.length, 0, 'but nothing has changed, so there is no amendment row')
  assertEq(clean.json, null, 'and nothing to upload')
  assert(clean.counts.unchanged > 0, 'the documents are counted as unchanged, not as amended')

  // ---- re-entering the ARN must not replace the memory of what was filed ----
  const again = await h.invoke('filings:record', {
    form: 'GSTR-1',
    period: filed.key,
    dueDate: `${amending.key}-11`,
    filedAt: `${amending.key}-12`,
    arn: 'AA270826000002X',
    taxPaid: 0,
    notes: null
  })
  assert(again.snapshot.keptExisting, 'the original snapshot wins over a re-marking')
  assertEq(again.snapshot.written, 0, 'and nothing is written a second time')
  assertEq(again.snapshot.docs, filedDocs, 'the snapshot still holds exactly what was filed')
  assertEq(again.arn, 'AA270826000002X', 'while the ARN itself still updates')

  // ---- correct a filed invoice: its place of supply was wrong ----
  const target = b2b[0]
  const voucher = await h.invoke('voucher:get', { id: target.voucherId })
  // Compare with the EFFECTIVE POS. The worklist row does not expose POS, but this is a B2B
  // document, so without an override it is the state prefix of the party GSTIN. Choosing 29 merely
  // because the nullable override is null is a no-op when that GSTIN already starts with 29; that
  // made the scenario depend on demo-document ordering.
  const currentPos = voucher.posOverride ?? target.partyGstin.slice(0, 2)
  const newPos = currentPos === '29' ? '30' : '29'
  assert(newPos !== currentPos, `the correction changes effective POS ${currentPos} to ${newPos}`)
  await h.invoke('voucher:save', { id: target.voucherId, data: { ...voucher, posOverride: newPos } })

  const report = await h.invoke('amendments:report', { period: amending.period })
  const row = report.rows.find((r) => r.originalNumber === target.number)
  assert(
    row,
    `the corrected invoice ${target.number} raises an amendment row ` +
      `(effective POS ${currentPos} -> ${newPos}; counts ${JSON.stringify(report.counts)}; ` +
      `rejected ${JSON.stringify(report.tables.rejected)})`
  )
  assert(
    row.changes.some((c) => c.field === 'pos'),
    `and the row says what changed (got ${JSON.stringify(row.changes.map((c) => c.field))})`
  )
  assertEq(row.originalPeriod, filed.period, 'keyed to the period the original was filed in')

  // The portal matches on the ORIGINAL document, never on the corrected one — if the key were
  // re-derived from today's books the row would ask the portal to match a document it has never
  // seen, and the correction would silently fail.
  const emitted = [...report.tables.b2ba, ...report.tables.b2cla]
  const inv = emitted.flatMap((g) => g.inv).find((i) => i.oinum === target.number)
  assert(inv, 'the emitted table carries the original document number as its key')
  assert(/^\d{2}-\d{2}-\d{4}$/.test(inv.oidt), `original date is portal DD-MM-YYYY (got ${inv.oidt})`)
  assert(report.json, 'and there is now a JSON payload to upload')
  assertEq(report.json.fp, amending.period, 'filed under the amending period, not the original one')

  // ---- a document deleted after filing is NOT a withdrawal row ----
  await h.invoke('voucher:delete', { id: b2b[1].voucherId })
  const afterDelete = await h.invoke('amendments:report', { period: amending.period })
  assert(
    afterDelete.deleted.some((d) => d.number === b2b[1].number),
    'a filed document that left the books is reported as such'
  )
  assert(
    !afterDelete.rows.some((r) => r.originalNumber === b2b[1].number),
    'and never becomes an amendment row — no GSTR-1 table deletes a filed document'
  )

  // ---- the export writes the amendment-only file ----
  const exported = await h.invoke('amendments:export', { period: amending.period })
  assert(fs.existsSync(exported.path), `amendment JSON written to ${exported.path}`)
  const parsed = JSON.parse(fs.readFileSync(exported.path, 'utf8'))
  assertEq(parsed.fp, amending.period, 'the file is stamped with the amending period')
  assert(
    parsed.b2ba || parsed.b2cla || parsed.cdnra || parsed.cdnura,
    'and carries at least one amendment table'
  )

  // ---- the screen ----
  await h.goto('gstr1')
  await h.click('tab-gstr1-amendments')
  await h.page.waitForSelector('[data-testid="rows-amendments"] tr', { timeout: 15000 })
  const shown = await h.page.$$eval('[data-testid="rows-amendments"] tr', (els) => els.length)
  assertEq(shown, report.rows.length, 'the panel shows every amendment row')
  const changedText = await h.page.textContent('[data-testid="rows-amendments"]')
  assert(/Place of supply/.test(changedText), 'and says what changed on each row, in words')
  // The validated contract and the remaining portal authority are on screen where someone relies
  // on them, not only in source comments.
  const verify = await h.page.textContent('[data-testid="amendments-verify-note"]')
  assert(/GSTR-1 Save API v5\.0/.test(verify), 'the validated GSTN schema version is declared')
  assert(/Recipient GSTIN is explicitly non-amendable/.test(verify), 'the non-amendable correction is declared')
  assert(/37\(3\)/.test(verify), 'as is the rectification window this app does not enforce')
  await h.shot('01-amendments')

  // The exact bytes, before they go anywhere.
  await h.click('btn-json-amendments')
  await h.page.waitForSelector('[data-modal]', { timeout: 10000 })
  const previewed = await h.page.textContent('[data-modal]')
  assert(/"fp": "/.test(previewed), 'the JSON preview shows the payload itself')
  await h.page.keyboard.press('Escape')
  await h.page.waitForSelector('[data-modal]', { state: 'detached', timeout: 10000 })

  // Selecting the FILED month itself: it is not earlier than itself, so there is nothing to
  // amend against — and the panel has to say that rather than show an empty table.
  await h.page.selectOption('[data-testid="input-gstr1-month"]', filed.key)
  await h.page.waitForSelector('[data-testid="panel-amendments-none"]', { timeout: 15000 })
  await h.shot('02-never-filed')

  // ---- the e-way bill distance estimate ----
  await h.goto('edocs')
  await h.page.waitForSelector('[data-testid="rows-edocs"] tr', { timeout: 15000 })
  await h.page.click('[data-testid="rows-edocs"] tr [data-testid="btn-edocs-transport"]')
  await h.page.waitForSelector('[data-testid="input-distance-from-pin"]', { timeout: 10000 })

  const distanceBefore = await h.page.inputValue('[data-testid="input-trans-distance"]')

  await h.fill('input-distance-from-pin', '400001')
  await h.fill('input-distance-to-pin', '560001')
  await h.click('btn-distance-estimate')
  await h.page.waitForSelector('[data-testid="distance-offer"]', { timeout: 10000 })

  const disclaimer = await h.page.textContent('[data-testid="distance-disclaimer"]')
  assert(/estimate, not a measurement/.test(disclaimer), 'the disclaimer is printed beside the figure')
  assert(/expire a consignment/.test(disclaimer), 'including what an understated distance costs')

  // The whole point: offered, not applied.
  const stillUntouched = await h.page.inputValue('[data-testid="input-trans-distance"]')
  assertEq(stillUntouched, distanceBefore, 'the estimate is never written into the field on its own')

  await h.shot('03-distance-offer')
  await h.click('btn-distance-accept')
  const accepted = await h.page.inputValue('[data-testid="input-trans-distance"]')
  assert(Number(accepted) > 0, `accepting puts the figure in the field (got ${JSON.stringify(accepted)})`)
  assert(accepted !== distanceBefore, 'and it actually changed')

  // An unknown PIN offers nothing at all — 9x is the Army Postal Service, whose offices move.
  await h.fill('input-distance-to-pin', '999999')
  await h.click('btn-distance-estimate')
  await h.page.waitForSelector('[data-testid="distance-no-offer"]', { timeout: 10000 })
  const noOffer = await h.page.$('[data-testid="distance-offer"]')
  assert(!noOffer, 'no figure at all for a PIN the app cannot place')
  const afterUnknown = await h.page.inputValue('[data-testid="input-trans-distance"]')
  assertEq(afterUnknown, accepted, 'and the accepted distance is left exactly as it was')
  await h.shot('04-distance-unknown')

  await h.page.keyboard.press('Escape')
})
