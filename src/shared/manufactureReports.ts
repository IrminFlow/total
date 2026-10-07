/**
 * Manufacturing reports (WP 2.4) — row shapes and the pure aggregation maths behind the
 * production register, cost sheet, expected-vs-realised margin and material variance screens.
 * The service (src/main/services/manufactureReports.ts) feeds these with engine figures from ONE
 * valuation pass (nothing here re-costs anything). Money in paise, quantities in thousandths.
 */

/** One manufacture as the reports see it (engine figures NOW). */
export interface ManufactureFact {
  voucherId: number
  date: string
  number: string
  finishedItemId: number
  itemName: string
  unitSymbol: string
  decimals: number
  qtyMilli: number
  materialPaise: number
  labourPaise: number
  byProductPaise: number
  /** materials + labour − by-products. */
  productionCost: number
  saleAmount: number
}

const ratio = (num: number, den: number): number | null => (den !== 0 ? Math.round((num * 10000) / den) / 100 : null)
/** Paise per whole unit (0 without a quantity). */
export const perUnit = (paise: number, qtyMilli: number): number => (qtyMilli > 0 ? Math.round((paise * 1000) / qtyMilli) : 0)

// ---------- production register ----------

export interface ProductionRegisterRow {
  finishedItemId: number
  itemName: string
  unitSymbol: string
  decimals: number
  manufactures: number
  qtyMilli: number
  materialPaise: number
  labourPaise: number
  /** materials + labour. */
  grossCost: number
  byProductPaise: number
  /** grossCost − by-products. */
  productionCost: number
  /** production cost per whole unit. */
  unitCostPaise: number
  saleAmount: number
  /** saleAmount − productionCost. */
  marginPaise: number
  /** margin ÷ sale value, percent (2 dp); null without a sale value. */
  marginPct: number | null
}

/** Per finished item over the period (item order: by name). */
export function productionRegister(facts: readonly ManufactureFact[]): ProductionRegisterRow[] {
  const by = new Map<number, ProductionRegisterRow>()
  for (const f of facts) {
    const r =
      by.get(f.finishedItemId) ??
      ({
        finishedItemId: f.finishedItemId, itemName: f.itemName, unitSymbol: f.unitSymbol, decimals: f.decimals, manufactures: 0,
        qtyMilli: 0, materialPaise: 0, labourPaise: 0, grossCost: 0, byProductPaise: 0, productionCost: 0, unitCostPaise: 0,
        saleAmount: 0, marginPaise: 0, marginPct: null
      } satisfies ProductionRegisterRow)
    r.manufactures += 1
    r.qtyMilli += f.qtyMilli
    r.materialPaise += f.materialPaise
    r.labourPaise += f.labourPaise
    r.byProductPaise += f.byProductPaise
    r.productionCost += f.productionCost
    r.saleAmount += f.saleAmount
    by.set(f.finishedItemId, r)
  }
  return [...by.values()]
    .map((r) => {
      const grossCost = r.materialPaise + r.labourPaise
      const marginPaise = r.saleAmount - r.productionCost
      return { ...r, grossCost, unitCostPaise: perUnit(r.productionCost, r.qtyMilli), marginPaise, marginPct: ratio(marginPaise, r.saleAmount) }
    })
    .sort((a, b) => a.itemName.localeCompare(b.itemName))
}

// ---------- cost sheet ----------

export interface CostSheetLine {
  /** 'material' rows carry a component; 'labour' / 'by_product' / 'scrap' are the other lines. */
  kind: 'material' | 'labour' | 'by_product' | 'scrap'
  itemId: number | null
  name: string
  unitSymbol: string
  decimals: number
  qtyMilli: number
  /** Paise per whole unit of the component (amount ÷ qty). */
  ratePaise: number
  /** Paise; by-products / scrap are negative (they reduce the cost). */
  amountPaise: number
  /** Component quantity per ONE unit of the finished item (thousandths). */
  qtyPerUnitMilli: number
  /** Amount per ONE unit of the finished item (paise). */
  amountPerUnitPaise: number
}

export interface CostSheet {
  /** null = the per-item average over the period. */
  voucherId: number | null
  date: string | null
  number: string | null
  qtyMilli: number
  lines: CostSheetLine[]
  /** Σ lines = materials + labour − by-products. */
  productionCost: number
  unitCostPaise: number
  saleAmount: number
}

/** Merge several manufactures' sheets of one item into the period average (Σ amounts and
 *  quantities, then per unit of the Σ finished quantity). Lines keep first-seen order. */
export function averageCostSheet(sheets: readonly CostSheet[]): CostSheet {
  const qtyMilli = sheets.reduce((s, c) => s + c.qtyMilli, 0)
  const merged = new Map<string, CostSheetLine>()
  for (const sheet of sheets) {
    for (const l of sheet.lines) {
      const key = `${l.kind}:${l.itemId ?? ''}`
      const cur = merged.get(key)
      if (cur) {
        cur.qtyMilli += l.qtyMilli
        cur.amountPaise += l.amountPaise
      } else merged.set(key, { ...l })
    }
  }
  const lines = [...merged.values()].map((l) => ({
    ...l,
    ratePaise: perUnit(Math.abs(l.amountPaise), l.qtyMilli),
    qtyPerUnitMilli: qtyMilli > 0 ? Math.round((l.qtyMilli * 1000) / qtyMilli) : 0,
    amountPerUnitPaise: perUnit(l.amountPaise, qtyMilli)
  }))
  const productionCost = lines.reduce((s, l) => s + l.amountPaise, 0)
  return {
    voucherId: null, date: null, number: null, qtyMilli, lines, productionCost, unitCostPaise: perUnit(productionCost, qtyMilli),
    saleAmount: sheets.reduce((s, c) => s + c.saleAmount, 0)
  }
}

// ---------- expected vs realised margin ----------

export interface MarginRow {
  itemId: number
  itemName: string
  unitSymbol: string
  decimals: number
  /** Manufactured in the period. */
  madeQtyMilli: number
  productionCost: number
  /** Production cost per unit (engine, now). */
  unitCostPaise: number
  /** Σ manufacture sale values (qty × the average price typed on the manufacture). */
  expectedSaleAmount: number
  expectedMarginPaise: number
  expectedMarginPct: number | null
  /** Actually sold in the period (sales vouchers), at engine COGS (item profitability). */
  soldQtyMilli: number
  salesValue: number
  cogs: number
  realisedMarginPaise: number
  realisedMarginPct: number | null
  /** realised % − expected % (percentage points); null when either is unknown. */
  marginGapPct: number | null
}

export function marginRows(
  made: readonly ProductionRegisterRow[],
  sold: ReadonlyMap<number, { outQtyMilli: number; salesValue: number; cogs: number }>
): MarginRow[] {
  return made.map((m) => {
    const s = sold.get(m.finishedItemId) ?? { outQtyMilli: 0, salesValue: 0, cogs: 0 }
    const expectedMarginPct = ratio(m.marginPaise, m.saleAmount)
    const realisedMarginPaise = s.salesValue - s.cogs
    const realisedMarginPct = s.outQtyMilli > 0 ? ratio(realisedMarginPaise, s.salesValue) : null
    return {
      itemId: m.finishedItemId, itemName: m.itemName, unitSymbol: m.unitSymbol, decimals: m.decimals, madeQtyMilli: m.qtyMilli,
      productionCost: m.productionCost, unitCostPaise: m.unitCostPaise, expectedSaleAmount: m.saleAmount,
      expectedMarginPaise: m.marginPaise, expectedMarginPct, soldQtyMilli: s.outQtyMilli, salesValue: s.salesValue, cogs: s.cogs,
      realisedMarginPaise, realisedMarginPct,
      marginGapPct:
        expectedMarginPct != null && realisedMarginPct != null ? Math.round((realisedMarginPct - expectedMarginPct) * 100) / 100 : null
    }
  })
}

// ---------- material variance ----------

export interface VarianceReportRow {
  voucherId: number
  date: string
  number: string
  finishedItemId: number
  itemName: string
  producedQtyMilli: number
  bomVersionName: string | null
  componentId: number
  componentName: string
  unitSymbol: string
  decimals: number
  standardQtyMilli: number
  actualQtyMilli: number
  qtyVarianceMilli: number
  standardValuePaise: number
  actualValuePaise: number
  valueVariancePaise: number
}
