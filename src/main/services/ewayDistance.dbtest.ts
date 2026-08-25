import { describe, it, expect } from 'vitest'
import type { DrCr } from '@shared/domain'
import { PIN_DISTANCE_DISCLAIMER } from '@shared/gst/pinDistance'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import { estimateTransportDistance, getTransport, setTransport } from './edocs'

/**
 * The e-way bill distance estimate (roadmap D-96), where it meets the database.
 *
 * The arithmetic is pure and tested in src/shared/gst/pinDistance.test.ts. The property that can
 * only be tested here is the one that matters most: asking for an estimate NEVER writes it into
 * the field that goes on the bill. The declared distance sets how long the bill stays valid, so
 * an understated figure expires a consignment while it is still on the road — and a figure this
 * app admits is approximate must not arrive there without somebody choosing it.
 */

const EMPTY_TRANSPORT = {
  transMode: null,
  transDistanceKm: null,
  transporterId: null,
  transporterName: null,
  transDocNo: null,
  transDocDate: null,
  vehicleNo: null,
  vehicleType: null,
  shipToName: null,
  shipToGstin: null,
  shipToAddr1: null,
  shipToAddr2: null,
  shipToPlace: null,
  shipToPincode: null,
  shipToState: null
} as const

function setup() {
  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number =>
    (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id

  const buyer = createLedger(db, {
    name: 'Buyer 27',
    groupId: groupId('Sundry Debtors'),
    gstin: '27AAPFU0939F1ZV',
    stateCode: '27'
  }).id
  const sales = createLedger(db, { name: 'Sales 18', groupId: groupId('Sales Accounts'), gstRate: 18 }).id

  const lines: { ledgerId: number; drCr: DrCr; amount: number }[] = [
    { ledgerId: buyer, drCr: 'dr', amount: 100000 },
    { ledgerId: sales, drCr: 'cr', amount: 100000 }
  ]
  const voucherId = saveVoucher(db, {
    voucherTypeId: vtId('sales'),
    date: '2026-07-05',
    partyLedgerId: buyer,
    posOverride: null,
    lines: lines.map((l) => ({ ...l, costAllocations: [] })),
    inventory: [],
    billRefs: [],
    tds: null
  }).id

  const storedKm = (): number | null => getTransport(db, voucherId)?.transDistanceKm ?? null

  return { db, voucherId, storedKm }
}

describe('e-way bill distance — an offer, never a write', () => {
  it('offers a figure for two resolvable PINs and leaves the stored distance untouched', () => {
    const s = setup()
    // Mumbai 400001 → Bengaluru 560001: both are three-digit sorting districts the table knows.
    const offer = estimateTransportDistance(s.db, s.voucherId, { fromPin: '400001', toPin: '560001' })
    expect(offer.estimate).not.toBeNull()
    expect(offer.estimate!.approximate).toBe(true)
    expect(offer.estimate!.km).toBeGreaterThan(700)
    expect(offer.estimate!.km).toBeLessThan(1200)
    expect(offer.toPinSource).toBe('typed')
    // Verbatim, because the UI prints exactly what comes back.
    expect(offer.disclaimer).toBe(PIN_DISTANCE_DISCLAIMER)
    // The point of the whole test file.
    expect(offer.storedKm).toBeNull()
    expect(s.storedKm()).toBeNull()
  })

  it('takes the delivery PIN from the ship-to address when there is one', () => {
    const s = setup()
    setTransport(s.db, s.voucherId, { ...EMPTY_TRANSPORT, shipToPincode: '110001' })
    const offer = estimateTransportDistance(s.db, s.voucherId, { fromPin: '400001' })
    expect(offer.toPin).toBe('110001')
    expect(offer.toPinSource).toBe('ship_to')
    expect(offer.estimate).not.toBeNull()
    expect(s.storedKm()).toBeNull()
  })

  it('offers nothing at all for a PIN it cannot place', () => {
    // 999999 is the Army Postal Service range, whose field post offices move; 000000 was never
    // allotted. Neither gets a fallback figure — a confident wrong distance is the failure this
    // path exists to avoid.
    const s = setup()
    for (const bad of ['999999', '000000', '12345', 'not-a-pin']) {
      const offer = estimateTransportDistance(s.db, s.voucherId, { fromPin: '400001', toPin: bad })
      expect(offer.estimate).toBeNull()
      expect(offer.reason).toMatch(/No estimate|delivery PIN/)
      expect(s.storedKm()).toBeNull()
    }
  })

  it('asks for the despatch PIN rather than inventing one, because none is stored', () => {
    // The company address is a single free-text field with no PIN column, and the party ledger
    // carries a state code but no PIN. Parsing six digits out of an address line and calling it
    // the despatch point would be a guess presented as a fact.
    const s = setup()
    const offer = estimateTransportDistance(s.db, s.voucherId, { toPin: '560001' })
    expect(offer.estimate).toBeNull()
    expect(offer.fromPin).toBeNull()
    expect(offer.reason).toMatch(/despatch PIN/)
    expect(offer.reason).toMatch(/no PIN/)
  })

  it('says both PINs are missing when neither is typed nor stored', () => {
    const s = setup()
    const offer = estimateTransportDistance(s.db, s.voucherId, {})
    expect(offer.estimate).toBeNull()
    expect(offer.toPinSource).toBeNull()
    expect(offer.reason).toMatch(/Neither is stored/)
  })

  it('stores the figure only through an explicit save, and then reports it back', () => {
    const s = setup()
    const offer = estimateTransportDistance(s.db, s.voucherId, { fromPin: '400001', toPin: '560001' })
    expect(s.storedKm()).toBeNull()

    // What accepting the offer does in the UI: the user saves the transport details.
    setTransport(s.db, s.voucherId, { ...EMPTY_TRANSPORT, transDistanceKm: offer.estimate!.km })
    expect(s.storedKm()).toBe(offer.estimate!.km)

    // And a later estimate reports what is stored without touching it.
    const again = estimateTransportDistance(s.db, s.voucherId, { fromPin: '400001', toPin: '560001' })
    expect(again.storedKm).toBe(offer.estimate!.km)
    expect(s.storedKm()).toBe(offer.estimate!.km)
  })

  it('is symmetric, and never offers zero', () => {
    const s = setup()
    const there = estimateTransportDistance(s.db, s.voucherId, { fromPin: '400001', toPin: '560001' })
    const back = estimateTransportDistance(s.db, s.voucherId, { fromPin: '560001', toPin: '400001' })
    expect(back.estimate!.km).toBe(there.estimate!.km)
    // The portal rejects 0 km, and two addresses in one sorting district resolve to one point.
    const local = estimateTransportDistance(s.db, s.voucherId, { fromPin: '400001', toPin: '400051' })
    expect(local.estimate!.km).toBeGreaterThanOrEqual(1)
  })
})
