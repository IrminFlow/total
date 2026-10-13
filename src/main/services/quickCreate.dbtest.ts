// WP 8.4: quick-create lands where the plain dialogs say. A ledger made from a plain answer goes
// into the answer's group with its category and phone, and the WP 5.6 classifier agrees with the
// kind; a quick-created product's selling price sits on the default price level (created when
// there is none) and the pricing resolver finds it there — resolvePrice's order untouched.
import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger, getLedger, updateLedger } from './masters'
import { ledgerClassifier } from '../ai/ledgerClass'
import { classForKind, groupForKind, INCOME_KINDS, type KindAnswer } from '@shared/simple/accountKinds'
import { NEW_CATEGORY_KINDS } from '@shared/simple/categories'
import { quickCreateItem, DEFAULT_SELLING_LEVEL } from './quickCreate'
import { listPriceLevels, savePriceLevel, listRates } from './priceLevels'
import { resolveLines } from './pricing'
import { verifyAudit } from './audit'
import type { DB } from '../db/connection'

const groupId = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const pcs = (db: DB): number => (db.prepare("SELECT id FROM units WHERE symbol = 'Pcs'").get() as { id: number }).id
const item = (db: DB, name: string, gstRate: number | null = null) => ({
  name, groupId: null, unitId: pcs(db), hsn: null, gstRate, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null
})

describe('quick-created ledgers', () => {
  it('a customer lands in Sundry Debtors with its phone / WhatsApp; an expense category keeps its key', () => {
    const db = seededDb()
    const c = createLedger(db, { name: 'Anita Stores', groupId: groupId(db, groupForKind({ kind: 'customer' })), phone: '98765 43210', whatsapp: '+91 98765 43210' })
    expect(c).toMatchObject({ groupId: groupId(db, 'Sundry Debtors'), phone: '98765 43210', whatsapp: '+91 98765 43210' })
    const audit = db.prepare("SELECT after_json FROM audit_log WHERE entity = 'ledger' AND entity_id = ? AND action = 'create'").get(c.id) as { after_json: string }
    expect(JSON.parse(audit.after_json)).toMatchObject({ phone: '98765 43210' })

    const travel = createLedger(db, { name: 'Travel', groupId: groupId(db, 'Indirect Expenses'), simpleCategory: 'travel' })
    expect(travel.simpleCategory).toBe('travel')
    expect(ledgerClassifier(db).cls(travel.id)).toBe('expense')
    expect(verifyAudit(db).ok).toBe(true)
  })

  it('phone: absent keeps it, null clears it, a non-number is refused; a ledger without one reads as before', () => {
    const db = seededDb()
    const c = createLedger(db, { name: 'Ravi', groupId: groupId(db, 'Sundry Creditors'), phone: '022 2345 6789' })
    expect(updateLedger(db, c.id, { name: 'Ravi Kumar', groupId: c.groupId }).phone).toBe('022 2345 6789')
    expect(updateLedger(db, c.id, { name: 'Ravi Kumar', groupId: c.groupId, phone: '' }).phone).toBeUndefined()
    expect(() => createLedger(db, { name: 'Bad', groupId: c.groupId, phone: 'call me' })).toThrow(/phone/i)
    const plain = createLedger(db, { name: 'Plain', groupId: c.groupId })
    expect('phone' in getLedger(db, plain.id)!).toBe(false)
    expect('whatsapp' in getLedger(db, plain.id)!).toBe(false)
  })

  it('every plain answer’s group gets the class the kind promises (ai/ledgerClass.ts)', () => {
    const db = seededDb()
    const answers: KindAnswer[] = [
      { kind: 'customer' }, { kind: 'supplier' }, { kind: 'bank' }, { kind: 'cash' }, { kind: 'loan' },
      ...INCOME_KINDS.map((incomeKind) => ({ kind: 'income' as const, incomeKind })),
      ...NEW_CATEGORY_KINDS.map((expenseKind) => ({ kind: 'expense' as const, expenseKind }))
    ]
    let n = 0
    for (const a of answers) {
      const l = createLedger(db, { name: `Plain ${n++}`, groupId: groupId(db, groupForKind(a)) })
      expect(ledgerClassifier(db).cls(l.id), JSON.stringify(a)).toBe(classForKind(a))
    }
  })
})

describe('product quick-create', () => {
  it('puts the selling price on a new default level, the purchase price as standard cost; the resolver finds it', () => {
    const db = seededDb()
    expect(listPriceLevels(db)).toEqual([])
    const res = quickCreateItem(db, { item: item(db, 'Notebook', 18), sellingPricePaise: 4500, purchasePricePaise: 3000 })
    const levels = listPriceLevels(db)
    expect(levels).toHaveLength(1)
    expect(levels[0]).toMatchObject({ id: res.priceLevelId, name: DEFAULT_SELLING_LEVEL, isDefault: true, inclusiveOfTax: false })
    expect(listRates(db, res.priceLevelId!)).toEqual([expect.objectContaining({ stockItemId: res.item.id, rate: 4500, effectiveFrom: '2025-04-01', minQtyMilli: 0 })])
    expect(res.item).toMatchObject({ gstRate: 18, standardCostPaise: 3000 })
    const r = resolveLines(db, { date: '2025-10-07', partyLedgerId: null, currency: '', supply: 'intra', lines: [{ key: 1, itemId: res.item.id, qtyMilli: 1000 }] })[0]!.result
    expect(r).toMatchObject({ ratePaise: 4500, source: 'default_level' })
    expect(verifyAudit(db).ok).toBe(true)
    const entities = (db.prepare('SELECT entity FROM audit_log ORDER BY id DESC LIMIT 3').all() as { entity: string }[]).map((e) => e.entity).sort()
    expect(entities).toEqual(['priceLevel', 'priceRate', 'stockItem'])
  })

  it('uses the existing default level; no price = no rate row; one transaction (a failure leaves nothing)', () => {
    const db = seededDb()
    const level = savePriceLevel(db, { name: 'Retail', isDefault: true })
    const a = quickCreateItem(db, { item: item(db, 'Pen'), sellingPricePaise: 1000 })
    expect(a.priceLevelId).toBe(level.id)
    const b = quickCreateItem(db, { item: item(db, 'Pencil') })
    expect(b.priceLevelId).toBeNull()
    expect(listRates(db, level.id).map((r) => r.stockItemId)).toEqual([a.item.id])
    const before = (db.prepare('SELECT COUNT(*) AS n FROM stock_items').get() as { n: number }).n
    expect(() => quickCreateItem(db, { item: item(db, 'Pen'), sellingPricePaise: 500 })).toThrow()
    expect((db.prepare('SELECT COUNT(*) AS n FROM stock_items').get() as { n: number }).n).toBe(before)
  })
})
