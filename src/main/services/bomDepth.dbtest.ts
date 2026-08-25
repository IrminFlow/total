import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { createStockItem, createUnit } from './masters'
import { getBom, getBomDetail, setBom, explodeBomRequirement, itemsWithBom } from './extras'
import { bomInputSchema } from '@shared/schemas'

function makeItem(db: DB, name: string): number {
  const unit = db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number } | undefined
  const unitId = unit?.id ?? createUnit(db, { name: 'Numbers', symbol: 'nos', decimals: 0, uqc: 'NOS' }).id
  return createStockItem(db, {
    name,
    groupId: null,
    unitId,
    hsn: null,
    gstRate: null,
    cessRate: null,
    openingQtyMilli: 0,
    openingValue: 0,
    barcode: null,
    reorderLevelMilli: null,
    valuationMethod: 'weighted_avg'
  }).id
}

/** Save through the Zod schema, the way IPC does, so defaults are exercised too. */
function save(db: DB, payload: unknown): void {
  setBom(db, bomInputSchema.parse(payload))
}

describe('BOM scrap and yield (#125)', () => {
  it('defaults reproduce yesterday’s numbers exactly for a BOM saved without them', () => {
    const db = seededDb()
    const shirt = makeItem(db, 'Shirt')
    const cloth = makeItem(db, 'Cloth')
    const button = makeItem(db, 'Button')
    // A payload from before scrap and yield existed: no scrapBp, no bomYieldBp.
    save(db, { itemId: shirt, lines: [{ componentId: cloth, qtyMilliPerUnit: 2000 }, { componentId: button, qtyMilliPerUnit: 6000 }] })

    const detail = getBomDetail(db, shirt)
    expect(detail.bomYieldBp).toBe(10000)
    expect(detail.lines.every((l) => l.scrapBp === 0)).toBe(true)

    const req = explodeBomRequirement(db, shirt, 10_000) // 10 shirts
    expect(req.raw.map((r) => [r.componentName, r.qtyMilli]).sort()).toEqual([
      ['Button', 60_000],
      ['Cloth', 20_000]
    ])
  })

  it('persists and returns scrap per line and yield per item', () => {
    const db = seededDb()
    const shirt = makeItem(db, 'Shirt')
    const cloth = makeItem(db, 'Cloth')
    const button = makeItem(db, 'Button')
    save(db, {
      itemId: shirt,
      bomYieldBp: 9700,
      lines: [
        { componentId: cloth, qtyMilliPerUnit: 2000, scrapBp: 250 },
        { componentId: button, qtyMilliPerUnit: 6000, scrapBp: 0 }
      ]
    })
    const lines = getBom(db, shirt)
    expect(lines.find((l) => l.componentName === 'Cloth')!.scrapBp).toBe(250)
    expect(lines.find((l) => l.componentName === 'Button')!.scrapBp).toBe(0)
    expect(getBomDetail(db, shirt).bomYieldBp).toBe(9700)
  })

  it('inflates the scrapped component alone, and every component by the yield', () => {
    const db = seededDb()
    const shirt = makeItem(db, 'Shirt')
    const cloth = makeItem(db, 'Cloth')
    const button = makeItem(db, 'Button')
    save(db, {
      itemId: shirt,
      bomYieldBp: 5000, // half of what is started passes inspection
      lines: [
        { componentId: cloth, qtyMilliPerUnit: 1000, scrapBp: 1000 }, // 10% of the cloth is offcut
        { componentId: button, qtyMilliPerUnit: 1000, scrapBp: 0 }
      ]
    })
    const req = explodeBomRequirement(db, shirt, 10_000) // 10 shirts
    const qty = (name: string): number => req.raw.find((r) => r.componentName === name)!.qtyMilli
    expect(qty('Cloth')).toBe(22_000) // 10 × 1.10 ÷ 0.50
    expect(qty('Button')).toBe(20_000) // 10 ÷ 0.50 — untouched by the other line's scrap
  })
})

describe('nested sub-assembly BOMs (#126)', () => {
  it('explodes three levels and reports the raw materials, not the intermediates', () => {
    const db = seededDb()
    const bike = makeItem(db, 'Bike')
    const wheel = makeItem(db, 'Wheel')
    const rim = makeItem(db, 'Rim')
    const steel = makeItem(db, 'Steel')
    save(db, { itemId: bike, lines: [{ componentId: wheel, qtyMilliPerUnit: 2000 }] })
    save(db, { itemId: wheel, lines: [{ componentId: rim, qtyMilliPerUnit: 1000 }] })
    save(db, { itemId: rim, bomYieldBp: 5000, lines: [{ componentId: steel, qtyMilliPerUnit: 3000, scrapBp: 0 }] })

    const req = explodeBomRequirement(db, bike, 1000) // 1 bike
    expect(req.rows.map((r) => [r.componentName, r.qtyMilli, r.depth, r.isSubAssembly])).toEqual([
      ['Wheel', 2000, 1, true],
      ['Rim', 2000, 2, true],
      ['Steel', 12_000, 3, false] // 2 rims ÷ 0.50 yield × 3
    ])
    expect(req.raw).toHaveLength(1)
    expect(req.raw[0]!.componentName).toBe('Steel')
  })

  it('adds a component used both directly and inside a sub-assembly', () => {
    const db = seededDb()
    const bike = makeItem(db, 'Bike')
    const wheel = makeItem(db, 'Wheel')
    const screw = makeItem(db, 'Screw')
    save(db, {
      itemId: bike,
      lines: [{ componentId: wheel, qtyMilliPerUnit: 2000 }, { componentId: screw, qtyMilliPerUnit: 4000 }]
    })
    save(db, { itemId: wheel, lines: [{ componentId: screw, qtyMilliPerUnit: 3000 }] })
    const req = explodeBomRequirement(db, bike, 1000)
    expect(req.raw).toHaveLength(1)
    expect(req.raw[0]!.qtyMilli).toBe(10_000) // 4 direct + 2 wheels × 3
  })

  it('still refuses to save a cycle, and explodes a pre-existing one into an error', () => {
    const db = seededDb()
    const a = makeItem(db, 'A')
    const b = makeItem(db, 'B')
    save(db, { itemId: a, lines: [{ componentId: b, qtyMilliPerUnit: 1000 }] })
    expect(() => save(db, { itemId: b, lines: [{ componentId: a, qtyMilliPerUnit: 1000 }] })).toThrow(/cycle/)
    // A database written before the save-time guard existed: forced in behind the service.
    db.prepare('INSERT INTO bom_lines (item_id, component_id, qty_milli_per_unit, scrap_bp) VALUES (?, ?, ?, 0)').run(b, a, 1000)
    expect(() => explodeBomRequirement(db, a, 1000)).toThrow(/cycle/)
  })

  it('lists items that have a BOM, sub-assemblies included', () => {
    const db = seededDb()
    const bike = makeItem(db, 'Bike')
    const wheel = makeItem(db, 'Wheel')
    const rim = makeItem(db, 'Rim')
    save(db, { itemId: bike, lines: [{ componentId: wheel, qtyMilliPerUnit: 2000 }] })
    save(db, { itemId: wheel, lines: [{ componentId: rim, qtyMilliPerUnit: 1000 }] })
    expect(itemsWithBom(db).map((i) => i.name)).toEqual(['Bike', 'Wheel'])
    // The picker needs to know a component is itself made, not bought.
    expect(getBom(db, bike)[0]!.hasBom).toBe(true)
    expect(getBom(db, wheel)[0]!.hasBom).toBe(false)
  })
})
