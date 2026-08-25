import { describe, it, expect } from 'vitest'
import type { CompanyInfo, DrCr } from '@shared/domain'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger, createStockItem, effectiveItemTax } from './masters'
import { saveVoucher } from './vouchers'
import { extractOutwardDocs, gstr1 } from './gst'
import { convert, getDocument, saveDocument } from './salesDocs'
import {
  deleteItemRate,
  itemRateChangedWithin,
  itemRateHistory,
  itemRatePeriods,
  listItemRates,
  makeRateResolver,
  rateForItemOn,
  saveItemRate
} from './itemRates'

/**
 * GST rate history per item (roadmap D-92).
 *
 * The feature exists for one reason: a rate change must never reprice a document that was already
 * raised, or a return that was already filed. Everything below is a restatement of that in a
 * different place — the item editor, an invoice, a quotation, GSTR-1.
 *
 * The 2025-09-22 dates are not arbitrary: that is the 56th Council rationalisation (12% and 28%
 * withdrawn, 5%/18%/40% in), which is the change most books in service today actually straddle.
 */

const INFO: CompanyInfo = { ...TEST_INFO, gstin: '27AAPFU0939F1ZV' }

type Db = ReturnType<typeof seededDb>

function books(): {
  db: Db
  buyer: number
  itemId: number
  post: (
    date: string,
    lines: { ledgerId: number; drCr: DrCr; amount: number }[],
    inventory: { stockItemId: number; qtyMilli: number; ratePaise: number; amount: number }[]
  ) => { id: number }
  sales: number
  cgstL: number
  sgstL: number
} {
  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number =>
    (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id

  const buyer = createLedger(db, {
    name: 'Kumar Stores', groupId: groupId('Sundry Debtors'), gstin: '27AAPFU0939F1ZV', stateCode: '27'
  } as never).id
  const sales = createLedger(db, { name: 'Sales', groupId: groupId('Sales Accounts') } as never).id
  const cgstL = createLedger(db, { name: 'CGST', groupId: groupId('Duties & Taxes'), taxType: 'cgst' } as never).id
  const sgstL = createLedger(db, { name: 'SGST', groupId: groupId('Duties & Taxes'), taxType: 'sgst' } as never).id

  const unitId = (db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number }).id
  const itemId = createStockItem(db, {
    name: 'Hair Oil', groupId: null, unitId, hsn: '3305', gstRate: 12, cessRate: null,
    openingQtyMilli: 0, openingValue: 0, code: null, barcode: null, reorderLevelMilli: null
  } as never).id

  const post = (
    date: string,
    lines: { ledgerId: number; drCr: DrCr; amount: number }[],
    inventory: { stockItemId: number; qtyMilli: number; ratePaise: number; amount: number }[]
  ): { id: number } =>
    saveVoucher(db, {
      voucherTypeId: vtId('sales'), date, partyLedgerId: buyer,
      lines: lines.map((l) => ({ ...l, costAllocations: [] })),
      inventory: inventory.map((l) => ({ ...l, godownId: null, direction: 'out' as const })),
      billRefs: [], tds: null
    })

  return { db, buyer, itemId, post, sales, cgstL, sgstL }
}

/** A one-line sale of ₹1,000 worth of the item, with tax lines that do not matter to extraction. */
function sell(b: ReturnType<typeof books>, date: string): { id: number } {
  return b.post(
    date,
    [
      { ledgerId: b.buyer, drCr: 'dr', amount: 112000 },
      { ledgerId: b.sales, drCr: 'cr', amount: 100000 },
      { ledgerId: b.cgstL, drCr: 'cr', amount: 6000 },
      { ledgerId: b.sgstL, drCr: 'cr', amount: 6000 }
    ],
    [{ stockItemId: b.itemId, qtyMilli: 1000, ratePaise: 100000, amount: 100000 }]
  )
}

const rateOfDoc = (db: Db, from: string, to: string): number[] =>
  extractOutwardDocs(db, INFO, from, to).flatMap((d) => d.items.map((i) => i.rate))

// ---------------------------------------------------------------------------

describe('an item with no rate history at all', () => {
  /**
   * The compatibility guarantee. Most books never change a rate, and they must not pay a paisa —
   * of behaviour or of speed — for a feature they never use.
   */
  it('answers from its own column, on every date, exactly as before the table existed', () => {
    const b = books()
    expect(listItemRates(b.db, b.itemId)).toEqual([])
    expect(rateForItemOn(b.db, b.itemId, '2017-07-01')).toBeNull()
    expect(rateForItemOn(b.db, b.itemId, '2099-12-31')).toBeNull()

    for (const date of ['2017-07-01', '2025-09-21', '2025-09-22', '2099-12-31']) {
      const tax = effectiveItemTax(b.db, b.itemId, date)
      expect(tax.gstRate).toBe(12)
      expect(tax.cessRate).toBeNull()
    }

    sell(b, '2025-09-21')
    sell(b, '2025-09-23')
    expect(rateOfDoc(b.db, '2025-09-01', '2025-09-30')).toEqual([12, 12])
  })

  it('costs one COUNT and then nothing — the resolver refuses to exist when no book uses it', () => {
    const b = books()
    expect(makeRateResolver(b.db)).toBeNull()
    saveItemRate(b.db, {
      stockItemId: b.itemId, effectiveFrom: '2025-09-22', ratePercent: 18, cessPercent: 0, note: null
    })
    expect(makeRateResolver(b.db)).not.toBeNull()
  })

  it('the editor view reports the fallback rather than pretending there is a history', () => {
    const b = books()
    const view = itemRateHistory(b.db, b.itemId, '2026-04-01')
    expect(view.rows).toEqual([])
    expect(view.inForce).toBeNull()
    expect(view.latestSentence).toBeNull()
    expect(view.itemRate).toEqual({ gstRate: 12, cessRate: null })
    // An empty history is the documented fallback, not a problem to nag about.
    expect(view.warnings).toEqual([])
  })
})

describe('a rate change mid-year', () => {
  function changed(): ReturnType<typeof books> {
    const b = books()
    saveItemRate(b.db, {
      stockItemId: b.itemId, effectiveFrom: '2017-07-01', ratePercent: 12, cessPercent: 0, note: '1/2017-CTR'
    })
    saveItemRate(b.db, {
      stockItemId: b.itemId, effectiveFrom: '2025-09-22', ratePercent: 18, cessPercent: 0, note: '9/2025-CTR'
    })
    return b
  }

  it('taxes the day before at the old rate, the day of at the new one, and the day after at the new one', () => {
    const b = changed()
    // The boundary is inclusive: "with effect from 22-09-2025" applies ON the 22nd, not the 23rd.
    expect(effectiveItemTax(b.db, b.itemId, '2025-09-21').gstRate).toBe(12)
    expect(effectiveItemTax(b.db, b.itemId, '2025-09-22').gstRate).toBe(18)
    expect(effectiveItemTax(b.db, b.itemId, '2025-09-23').gstRate).toBe(18)

    sell(b, '2025-09-21')
    sell(b, '2025-09-22')
    sell(b, '2025-09-23')
    expect(rateOfDoc(b.db, '2025-09-01', '2025-09-30')).toEqual([12, 18, 18])
  })

  it('reports the period as containing a change, and names the two stretches', () => {
    const b = changed()
    expect(itemRateChangedWithin(b.db, b.itemId, '2025-09-01', '2025-09-30')).toBe(true)
    // August is wholly before it; October wholly after. Neither straddles anything.
    expect(itemRateChangedWithin(b.db, b.itemId, '2025-08-01', '2025-08-31')).toBe(false)
    expect(itemRateChangedWithin(b.db, b.itemId, '2025-10-01', '2025-10-31')).toBe(false)

    const periods = itemRatePeriods(b.db, b.itemId, '2025-09-01', '2025-09-30')
    expect(periods).toHaveLength(2)
    expect(periods[0]).toMatchObject({ from: '2025-09-01', to: '2025-09-21' })
    expect(periods[0]!.rate!.ratePercent).toBe(12)
    expect(periods[1]).toMatchObject({ from: '2025-09-22', to: '2025-09-30' })
    expect(periods[1]!.rate!.ratePercent).toBe(18)
  })
})

describe('THE regression the feature exists to prevent', () => {
  /**
   * A return that was filed must keep answering what it answered when it was filed.
   *
   * Before this table, the rate lived in one column on the item. Recording October's rate change
   * meant editing that column, and July's GSTR-1 — already filed, already paid — silently
   * recomputed at the new rate the next time anybody opened it. The figures moved under a return
   * whose acknowledgement number is already with the department.
   *
   * This test computes July, then records a change effective in September, then computes July
   * again and demands the two are byte-for-byte identical.
   */
  it('a rate change recorded LATER does not move an EARLIER period’s GSTR-1 by one paisa', () => {
    const b = books()
    saveItemRate(b.db, {
      stockItemId: b.itemId, effectiveFrom: '2017-07-01', ratePercent: 12, cessPercent: 0, note: '1/2017-CTR'
    })
    sell(b, '2025-07-05')
    sell(b, '2025-07-19')

    const JULY = ['2025-07-01', '2025-07-31'] as const
    const before = gstr1(b.db, INFO, JULY[0], JULY[1], '072025')
    // Sanity: July really was taxed, at the old rate, or the comparison below proves nothing.
    expect(before.summary.some((s) => s.taxable > 0)).toBe(true)
    expect(rateOfDoc(b.db, JULY[0], JULY[1])).toEqual([12, 12])

    // Now the Council raises it, and the user records the change — months after filing July.
    saveItemRate(b.db, {
      stockItemId: b.itemId, effectiveFrom: '2025-09-22', ratePercent: 18, cessPercent: 0, note: '9/2025-CTR'
    })

    const after = gstr1(b.db, INFO, JULY[0], JULY[1], '072025')
    expect(after).toEqual(before)
    expect(after.summary).toEqual(before.summary)
    expect(JSON.stringify(after.json)).toBe(JSON.stringify(before.json))
    // And July's documents still say 12%, not 18%.
    expect(rateOfDoc(b.db, JULY[0], JULY[1])).toEqual([12, 12])

    // While September, which is on the other side of the change, does move — otherwise the
    // assertion above would pass just as well for a feature that does nothing at all.
    sell(b, '2025-09-25')
    expect(rateOfDoc(b.db, '2025-09-01', '2025-09-30')).toEqual([18])
  })

  it('and the same holds for an item whose history starts AFTER the invoice was raised', () => {
    const b = books()
    sell(b, '2025-07-05')
    const before = rateOfDoc(b.db, '2025-07-01', '2025-07-31')
    expect(before).toEqual([12]) // from the item's own column — no history exists yet

    // A history that begins in September says nothing about July, so July keeps its answer.
    saveItemRate(b.db, {
      stockItemId: b.itemId, effectiveFrom: '2025-09-22', ratePercent: 18, cessPercent: 0, note: '9/2025-CTR'
    })
    expect(rateOfDoc(b.db, '2025-07-01', '2025-07-31')).toEqual(before)
  })
})

describe('editing the history', () => {
  it('deleting the last row falls back to the item’s own rate — a mistyped date can be undone', () => {
    const b = books()
    const saved = saveItemRate(b.db, {
      stockItemId: b.itemId, effectiveFrom: '2025-09-22', ratePercent: 18, cessPercent: 0, note: '9/2025-CTR'
    })
    expect(effectiveItemTax(b.db, b.itemId, '2026-04-01').gstRate).toBe(18)

    deleteItemRate(b.db, saved.row.id)
    expect(listItemRates(b.db, b.itemId)).toEqual([])
    // Back to exactly what the item said before anybody recorded a history.
    expect(effectiveItemTax(b.db, b.itemId, '2026-04-01').gstRate).toBe(12)
    expect(rateForItemOn(b.db, b.itemId, '2026-04-01')).toBeNull()
    expect(itemRateHistory(b.db, b.itemId, '2026-04-01').itemRate).toEqual({ gstRate: 12, cessRate: null })
  })

  it('refuses two changes dated the same day — only the last one could ever apply', () => {
    const b = books()
    saveItemRate(b.db, {
      stockItemId: b.itemId, effectiveFrom: '2025-09-22', ratePercent: 18, cessPercent: 0, note: '9/2025-CTR'
    })
    expect(() =>
      saveItemRate(b.db, {
        stockItemId: b.itemId, effectiveFrom: '2025-09-22', ratePercent: 5, cessPercent: 0, note: 'typo'
      })
    ).toThrow(/Two rate changes are dated 22-Sep-25/)
    expect(listItemRates(b.db, b.itemId)).toHaveLength(1)

    // Correcting the existing row to that same date is fine — it is the row itself.
    const [row] = listItemRates(b.db, b.itemId)
    const fixed = saveItemRate(
      b.db,
      { stockItemId: b.itemId, effectiveFrom: '2025-09-22', ratePercent: 5, cessPercent: 0, note: 'corrected' },
      row!.id
    )
    expect(fixed.row.ratePercent).toBe(5)
    expect(listItemRates(b.db, b.itemId)).toHaveLength(1)
  })

  it('records a cess-only change — the GST rate stands still and the cess moves', () => {
    const b = books()
    saveItemRate(b.db, {
      stockItemId: b.itemId, effectiveFrom: '2020-04-01', ratePercent: 28, cessPercent: 12, note: '1/2017-Cess'
    })
    saveItemRate(b.db, {
      stockItemId: b.itemId, effectiveFrom: '2023-04-01', ratePercent: 28, cessPercent: 22, note: '3/2023-Cess'
    })

    const before = effectiveItemTax(b.db, b.itemId, '2023-03-31')
    expect([before.gstRate, before.cessRate]).toEqual([28, 12])
    const after = effectiveItemTax(b.db, b.itemId, '2023-04-01')
    expect([after.gstRate, after.cessRate]).toEqual([28, 22])

    const view = itemRateHistory(b.db, b.itemId, '2023-04-01')
    expect(view.inForce).toMatchObject({ ratePercent: 28, cessPercent: 22 })
    // The sentence must say what actually moved, not claim the rate changed.
    expect(view.latestSentence).toContain('cess 12% → 22%')
    expect(view.latestSentence).not.toMatch(/raised from|reduced from/)
  })
})

describe('a quotation raised before a change', () => {
  /**
   * A quotation is a promise about a price. Converting it months later must honour the rate it was
   * raised under — otherwise the customer is billed a number nobody quoted them.
   */
  it('converts at the rate it was raised under, not today’s', () => {
    const b = books()
    saveItemRate(b.db, {
      stockItemId: b.itemId, effectiveFrom: '2017-07-01', ratePercent: 12, cessPercent: 0, note: '1/2017-CTR'
    })
    saveItemRate(b.db, {
      stockItemId: b.itemId, effectiveFrom: '2025-09-22', ratePercent: 18, cessPercent: 0, note: '9/2025-CTR'
    })

    const quote = saveDocument(b.db, INFO, {
      stage: 'quotation',
      date: '2025-09-01',
      partyLedgerId: b.buyer,
      validUntil: '2025-12-31',
      lines: [{ stockItemId: b.itemId, description: 'Hair Oil', qtyMilli: 10_000, ratePaise: 10000 }]
    })
    expect(quote.lines[0]!.gstRate).toBe(12)

    // Converted after the change — the carried line keeps the quoted rate.
    const order = convert(b.db, quote.id, INFO, { date: '2025-10-05' })
    expect(order.lines[0]!.gstRate).toBe(12)
    expect(getDocument(b.db, order.id, INFO)!.lines[0]!.gstRate).toBe(12)

    // A NEW quotation raised after the change quotes the new rate — the lookup is by date, not
    // a frozen constant.
    const fresh = saveDocument(b.db, INFO, {
      stage: 'quotation',
      date: '2025-10-05',
      partyLedgerId: b.buyer,
      validUntil: '2025-12-31',
      lines: [{ stockItemId: b.itemId, description: 'Hair Oil', qtyMilli: 10_000, ratePaise: 10000 }]
    })
    expect(fresh.lines[0]!.gstRate).toBe(18)
  })
})
