import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger, findOrCreateLedger } from './masters'
import { deleteVoucher, saveVoucher } from './vouchers'
import { tdsSuggestion } from './tds'
import {
  certificateFor,
  deleteCertificate,
  listCertificates,
  listCertificatesWithUsage,
  paidUnderCertificate,
  resolveDeduction,
  saveCertificate
} from './tdsCertificates'
import { computeTds } from '@shared/tds'
import type { VoucherInputParsed } from '@shared/schemas'

type Db = ReturnType<typeof seededDb>

const PAN = 'ABCDE1234F'

function sectionId(db: Db, code: string): number {
  return (db.prepare('SELECT id FROM tds_sections WHERE code = ?').get(code) as { id: number }).id
}

function creditor(db: Db, name: string, opts: { sectionCode: string | null; pan: string | null }): number {
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Sundry Creditors'").get() as { id: number }
  return createLedger(db, {
    name,
    groupId: group.id,
    openingBalance: 0,
    gstin: null,
    stateCode: null,
    address: null,
    taxType: null,
    gstRate: null,
    hsn: null,
    tdsSectionId: opts.sectionCode === null ? null : sectionId(db, opts.sectionCode),
    pan: opts.pan,
    creditDays: null,
    exportType: null
  }).id
}

/** A journal that pays `base` to the party and withholds `tds` — 'journal' so the receipt/payment
 *  cash-side rule doesn't stand in the way of crediting TDS Payable as well. */
function payment(
  db: Db,
  opts: { date: string; partyLedgerId: number; base: number; tds: number; sectionCode: string; deleted?: boolean }
): number {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
  const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
  const payable = findOrCreateLedger(db, `TDS Payable ${opts.sectionCode}`, 'Duties & Taxes')
  const lines: VoucherInputParsed['lines'] = [
    { ledgerId: opts.partyLedgerId, drCr: 'dr', amount: opts.base, costAllocations: [] },
    { ledgerId: cash.id, drCr: 'cr', amount: opts.base - opts.tds, costAllocations: [] }
  ]
  if (opts.tds > 0) lines.push({ ledgerId: payable, drCr: 'cr', amount: opts.tds, costAllocations: [] })
  else lines[1] = { ledgerId: cash.id, drCr: 'cr', amount: opts.base, costAllocations: [] }

  const input: VoucherInputParsed = {
    voucherTypeId: vt.id,
    date: opts.date,
    number: undefined,
    partyLedgerId: opts.partyLedgerId,
    narration: null,
    reference: null,
    instrumentNo: null,
    instrumentDate: null,
    transporterId: null,
    vehicleNo: null,
    transportDistanceKm: null,
    posOverride: null,
    currencyCode: null,
    exchangeRate: null,
    lines,
    inventory: [],
    billRefs: [],
    tds: null
  }
  const v = saveVoucher(db, input)
  if (opts.deleted) deleteVoucher(db, v.id)
  return v.id
}

const certInput = (over: Partial<Parameters<typeof saveCertificate>[1]> = {}): Parameters<typeof saveCertificate>[1] => ({
  certificateNumber: 'AO197/2025/0001',
  pan: PAN,
  sectionCode: '194C',
  ratePercent: 0.5,
  validFrom: '2025-04-01',
  validTo: '2026-03-31',
  ceilingPaise: null,
  notes: null,
  ...over
})

describe('tds lower-deduction certificates (s.197 / Rule 28AA)', () => {
  it('with NO certificate the deduction is unchanged — computeTds at the section rate', () => {
    const db = seededDb()
    const party = creditor(db, 'Contractor A', { sectionCode: '194C', pan: PAN })

    const s = tdsSuggestion(db, party, 5000000, '2025-05-01')! // ₹50,000 at 194C's 2%
    expect(s.tdsPaise).toBe(computeTds(2, 5000000, true))
    expect(s.tdsPaise).toBe(100000)
    expect(s.certificate).toBeNull()
    expect(s.certificateExhausted).toBe(false)
    expect(s.ratesApplied).toEqual([
      { ratePercent: 2, basePaise: 5000000, tdsPaise: 100000, underCertificate: false }
    ])
  })

  it('a certificate in force reduces the deduction to the AO rate', () => {
    const db = seededDb()
    const party = creditor(db, 'Contractor A', { sectionCode: '194C', pan: PAN })
    saveCertificate(db, certInput())

    const s = tdsSuggestion(db, party, 5000000, '2025-05-01')!
    expect(s.tdsPaise).toBe(25000) // 0.5% of ₹50,000 = ₹250
    expect(s.certificate).not.toBeNull()
    expect(s.certificate!.certificateNumber).toBe('AO197/2025/0001')
    expect(s.certificate!.headroomPaise).toBeNull() // uncapped
    expect(s.certificateExhausted).toBe(false)
    expect(s.ratesApplied.map((r) => r.underCertificate)).toEqual([true])
  })

  it('a payment straddling the Rule 28AA ceiling is deducted at BOTH rates, and they re-add', () => {
    const db = seededDb()
    const party = creditor(db, 'Contractor A', { sectionCode: '194C', pan: PAN })
    saveCertificate(db, certInput({ ceilingPaise: 10000000 })) // ceiling ₹1,00,000

    const s = tdsSuggestion(db, party, 15000000, '2025-05-01')! // pay ₹1,50,000 in one go
    expect(s.ratesApplied).toHaveLength(2)

    const [under, over] = s.ratesApplied
    expect(under).toEqual({ ratePercent: 0.5, basePaise: 10000000, tdsPaise: 50000, underCertificate: true })
    expect(over).toEqual({ ratePercent: 2, basePaise: 5000000, tdsPaise: 100000, underCertificate: false })

    // The two halves are the whole payment, and the two taxes are the whole deduction.
    expect(under!.basePaise + over!.basePaise).toBe(15000000)
    expect(under!.tdsPaise + over!.tdsPaise).toBe(s.tdsPaise)
    expect(s.tdsPaise).toBe(150000) // ₹250 + ₹1,000
    expect(s.certificateExhausted).toBe(true)
  })

  it('an earlier payment eats the ceiling, so the next one is wholly at the ordinary rate', () => {
    const db = seededDb()
    const party = creditor(db, 'Contractor A', { sectionCode: '194C', pan: PAN })
    saveCertificate(db, certInput({ ceilingPaise: 10000000 }))

    payment(db, { date: '2025-04-10', partyLedgerId: party, base: 10000000, tds: 50000, sectionCode: '194C' })

    const s = tdsSuggestion(db, party, 5000000, '2025-05-01')!
    expect(s.certificate!.alreadyPaidPaise).toBe(10000000)
    expect(s.certificate!.headroomPaise).toBe(0)
    expect(s.tdsPaise).toBe(computeTds(2, 5000000, true)) // back to the ordinary rate
    expect(s.ratesApplied.every((r) => !r.underCertificate)).toBe(true)
  })

  it('a certificate that expires mid-year stops applying the day after it lapses', () => {
    const db = seededDb()
    const party = creditor(db, 'Contractor A', { sectionCode: '194C', pan: PAN })
    saveCertificate(db, certInput({ validFrom: '2025-04-01', validTo: '2025-09-30' }))

    const inside = tdsSuggestion(db, party, 5000000, '2025-09-30')!
    expect(inside.certificate).not.toBeNull()
    expect(inside.tdsPaise).toBe(25000)

    const outside = tdsSuggestion(db, party, 5000000, '2025-10-01')!
    expect(outside.certificate).toBeNull()
    expect(outside.tdsPaise).toBe(computeTds(2, 5000000, true))

    // Same FY, same payee — the lapse is a date fact, not a party fact.
    expect(certificateFor(db, { pan: PAN, sectionCode: '194C', date: '2026-01-01' })).toBeNull()
  })

  it('a soft-deleted voucher does not consume anybody’s ceiling', () => {
    const db = seededDb()
    const party = creditor(db, 'Contractor A', { sectionCode: '194C', pan: PAN })
    const cert = saveCertificate(db, certInput({ ceilingPaise: 10000000 }))

    const vid = payment(db, { date: '2025-04-10', partyLedgerId: party, base: 10000000, tds: 50000, sectionCode: '194C' })
    expect(paidUnderCertificate(db, cert)).toBe(10000000)

    deleteVoucher(db, vid)
    expect(paidUnderCertificate(db, cert)).toBe(0)

    // And the ceiling is whole again for the next payment.
    const s = tdsSuggestion(db, party, 5000000, '2025-05-01')!
    expect(s.certificate!.headroomPaise).toBe(10000000)
    expect(s.tdsPaise).toBe(25000)
  })

  it('excludeVoucherId keeps a voucher being edited from eating its own headroom', () => {
    const db = seededDb()
    const party = creditor(db, 'Contractor A', { sectionCode: '194C', pan: PAN })
    saveCertificate(db, certInput({ ceilingPaise: 10000000 }))
    const vid = payment(db, { date: '2025-04-10', partyLedgerId: party, base: 10000000, tds: 50000, sectionCode: '194C' })

    // Re-suggesting on the SAME voucher must see the ceiling as it was before that voucher.
    const editing = tdsSuggestion(db, party, 10000000, '2025-04-10', vid)!
    expect(editing.certificate!.alreadyPaidPaise).toBe(0)
    expect(editing.tdsPaise).toBe(50000)

    // Without the exclusion the voucher counts against itself and the rate reverts.
    const naive = tdsSuggestion(db, party, 10000000, '2025-04-10')!
    expect(naive.tdsPaise).toBe(computeTds(2, 10000000, true))
  })

  it('a party with no PAN gets no certificate and the section 206AA 20% floor', () => {
    const db = seededDb()
    const party = creditor(db, 'Contractor No PAN', { sectionCode: '194C', pan: null })
    // A certificate exists for that PAN, but this ledger cannot be the person holding it.
    saveCertificate(db, certInput())

    const s = tdsSuggestion(db, party, 5000000, '2025-05-01')!
    expect(s.panAvailable).toBe(false)
    expect(s.certificate).toBeNull()
    expect(s.tdsPaise).toBe(1000000) // 20% of ₹50,000, not 2% and not 0.5%

    expect(certificateFor(db, { pan: null, sectionCode: '194C', date: '2025-05-01' })).toBeNull()
  })

  it('a certificate for another section does nothing for this one', () => {
    const db = seededDb()
    const party = creditor(db, 'Consultant', { sectionCode: '194J', pan: PAN })
    saveCertificate(db, certInput({ sectionCode: '194C' }))

    const s = tdsSuggestion(db, party, 5000000, '2025-05-01')!
    expect(s.certificate).toBeNull()
    expect(s.code).toBe('194J')
  })

  it('a NIL certificate (s.197A / Form 15G) deducts nothing, and its ceiling still binds', () => {
    const db = seededDb()
    const party = creditor(db, 'Depositor', { sectionCode: '194A', pan: PAN })
    saveCertificate(db, certInput({ sectionCode: '194A', ratePercent: 0, ceilingPaise: 10000000 }))

    const nil = tdsSuggestion(db, party, 5000000, '2025-05-01')!
    expect(nil.tdsPaise).toBe(0)

    // The nil deduction posts no TDS line at all, so the ceiling has to be measured from the
    // payment itself — which is exactly why paidUnderCertificate reads voucher_lines.
    payment(db, { date: '2025-05-01', partyLedgerId: party, base: 10000000, tds: 0, sectionCode: '194A' })
    const after = tdsSuggestion(db, party, 5000000, '2025-06-01')!
    expect(after.certificate!.headroomPaise).toBe(0)
    expect(after.tdsPaise).toBeGreaterThan(0)
  })

  it('listCertificatesWithUsage reports consumption and flags an exhausted ceiling', () => {
    const db = seededDb()
    const party = creditor(db, 'Contractor A', { sectionCode: '194C', pan: PAN })
    saveCertificate(db, certInput({ ceilingPaise: 10000000 }))
    saveCertificate(db, certInput({ certificateNumber: 'AO197/2025/0002', sectionCode: '194J', ceilingPaise: null }))

    let usage = listCertificatesWithUsage(db)
    expect(usage).toHaveLength(2)
    const capped = usage.find((c) => c.sectionCode === '194C')!
    const uncapped = usage.find((c) => c.sectionCode === '194J')!
    expect(capped.exhausted).toBe(false)
    expect(uncapped.headroomPaise).toBeNull()
    expect(uncapped.exhausted).toBe(false) // nothing to exhaust

    payment(db, { date: '2025-04-10', partyLedgerId: party, base: 10000000, tds: 50000, sectionCode: '194C' })
    usage = listCertificatesWithUsage(db)
    const spent = usage.find((c) => c.sectionCode === '194C')!
    expect(spent.usedPaise).toBe(10000000)
    expect(spent.headroomPaise).toBe(0)
    expect(spent.exhausted).toBe(true)
  })

  it('save/edit/delete round-trips, and deleting one restores the ordinary rate', () => {
    const db = seededDb()
    const party = creditor(db, 'Contractor A', { sectionCode: '194C', pan: PAN })
    const created = saveCertificate(db, certInput())
    expect(listCertificates(db)).toHaveLength(1)

    const edited = saveCertificate(db, certInput({ ratePercent: 1 }), created.id)
    expect(edited.ratePercent).toBe(1)
    expect(tdsSuggestion(db, party, 5000000, '2025-05-01')!.tdsPaise).toBe(50000) // 1% of ₹50,000

    deleteCertificate(db, created.id)
    expect(listCertificates(db)).toHaveLength(0)
    expect(tdsSuggestion(db, party, 5000000, '2025-05-01')!.tdsPaise).toBe(computeTds(2, 5000000, true))
    expect(() => deleteCertificate(db, created.id)).toThrow(/not found/)
  })

  it('resolveDeduction is the whole rule in one call, and is total for an unflagged payee', () => {
    const db = seededDb()
    const out = resolveDeduction(db, {
      pan: null,
      sectionCode: '194C',
      normalRatePercent: 2,
      basePaise: 5000000,
      date: '2025-05-01'
    })
    expect(out.certificate).toBeNull()
    expect(out.tdsPaise).toBe(computeTds(2, 5000000, false))
    expect(out.atCertificateRatePaise).toBe(0)
    expect(out.atNormalRatePaise).toBe(out.tdsPaise)
  })
})
