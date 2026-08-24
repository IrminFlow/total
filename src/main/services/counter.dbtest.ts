import { describe, it, expect } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger, createStockItem, createUnit } from './masters'
import { saveVoucher, getVoucher } from './vouchers'
import {
  closeDrawer,
  findSaleForReturn,
  itemDetail,
  listCounterSales,
  lookup,
  openDrawer,
  openSession,
  priceCounterCart,
  recordMovement,
  saveCounterSale,
  saveScheme,
  sessionSummary
} from './counter'

type Db = ReturnType<typeof seededDb>

/**
 * The till.
 *
 * What matters: a walk-in leaves no ledger behind, the tender has to cover the bill, change only
 * comes out of cash, a scheme's free goods still leave stock, and a counted drawer that is short
 * says so rather than quietly balancing.
 */
const LEDGER_DEFAULTS = {
  openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null,
  hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
}

function books(): {
  db: Db
  widget: number
  sugar: number
  buyer: number
  groupId: (n: string) => number
} {
  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const existingUnit = db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number } | undefined
  const unit = existingUnit ?? createUnit(db, { name: 'Pieces', symbol: 'pcs', decimals: 3, uqc: 'PCS' })

  const item = (name: string, code: string, gstRate: number): number =>
    createStockItem(db, {
      name, groupId: null, unitId: unit.id, hsn: '1905', gstRate, cessRate: null,
      openingQtyMilli: 0, openingValue: 0, code, barcode: null, reorderLevelMilli: null
    } as never).id

  const widget = item('Widget', 'W1', 18)
  const sugar = item('Sugar', 'S1', 5)
  const buyer = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Kumar Stores', groupId: groupId('Sundry Debtors'), stateCode: '27' }).id

  // Buy some stock in, so there is a cost and something to sell.
  const purchaseType = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'purchase'").get() as { id: number }).id
  const supplier = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Supplier', groupId: groupId('Sundry Creditors') }).id
  const purchases = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Purchase Account', groupId: groupId('Purchase Accounts') }).id
  saveVoucher(db, {
    voucherTypeId: purchaseType, date: '2025-04-01', partyLedgerId: supplier,
    narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
    vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: [
      { ledgerId: purchases, drCr: 'dr', amount: 1_60_000, costAllocations: [] },
      { ledgerId: supplier, drCr: 'cr', amount: 1_60_000, costAllocations: [] }
    ],
    inventory: [
      { stockItemId: widget, godownId: null, qtyMilli: 100_000, ratePaise: 1000, amount: 1_00_000, direction: 'in' },
      { stockItemId: sugar, godownId: null, qtyMilli: 100_000, ratePaise: 600, amount: 60_000, direction: 'in' }
    ],
    billRefs: [], tds: null
  })
  return { db, widget, sugar, buyer, groupId }
}

describe('finding an item at the counter', () => {
  it('finds it by the code on the shelf label', () => {
    const { db, widget } = books()
    expect(lookup(db, 'W1')!.stockItemId).toBe(widget)
  })

  it('knows what it cost, so a below-cost sale can be flagged', () => {
    const { db, widget } = books()
    const d = itemDetail(db, widget, '2025-04-02')
    expect(d.costPaise).toBe(1000)
    expect(d.onHandMilli).toBe(100_000)
    expect(d.gstRate).toBe(18)
  })

  it('says nothing at all about an item nobody has heard of', () => {
    const { db } = books()
    expect(lookup(db, 'NOSUCH')).toBeNull()
  })
})

describe('pricing a cart', () => {
  it('prices a shelf price inclusive of tax by default', () => {
    const { db, widget } = books()
    const cart = priceCounterCart(db, TEST_INFO, { lines: [{ stockItemId: widget, qtyMilli: 1000, ratePaise: 11800 }], date: '2025-04-02' })
    expect(cart.gst.taxable).toBe(10000)
    expect(cart.payablePaise).toBe(11800)
  })

  it('flags a line sold under cost while it is being typed', () => {
    const { db, widget } = books()
    const cart = priceCounterCart(db, TEST_INFO, {
      lines: [{ stockItemId: widget, qtyMilli: 1000, ratePaise: 900 }],
      date: '2025-04-02',
      pricingMode: 'exclusive'
    })
    expect(cart.belowCostLines).toBe(1)
    expect(cart.lines[0]!.belowCostBy).toBe(100)
  })

  it('warns about selling more than is on hand without refusing to sell it', () => {
    const { db, widget } = books()
    const cart = priceCounterCart(db, TEST_INFO, {
      lines: [{ stockItemId: widget, qtyMilli: 200_000, ratePaise: 1000 }],
      date: '2025-04-02'
    })
    expect(cart.shortLines).toHaveLength(1)
    expect(cart.payablePaise).toBeGreaterThan(0)
  })

  it('applies a running scheme, and the free unit still leaves stock', () => {
    const { db, widget } = books()
    saveScheme(db, {
      name: 'Ten and one', stockItemId: widget, kind: 'free', minQtyMilli: 10_000,
      freeQtyMilli: 1_000, fromDate: '2025-04-01'
    })
    const cart = priceCounterCart(db, TEST_INFO, {
      lines: [{ stockItemId: widget, qtyMilli: 10_000, ratePaise: 1000 }],
      date: '2025-04-02',
      pricingMode: 'exclusive'
    })
    // Eleven move, ten are charged for.
    expect(cart.lines[0]!.qtyMilli).toBe(11_000)
    expect(cart.lines[0]!.taxablePaise).toBe(10_000)
    expect(cart.lines[0]!.scheme!.freeQtyMilli).toBe(1_000)
  })

  it('lets the operator override the scheme', () => {
    const { db, widget } = books()
    saveScheme(db, {
      name: 'Ten and one', stockItemId: widget, kind: 'free', minQtyMilli: 10_000,
      freeQtyMilli: 1_000, fromDate: '2025-04-01'
    })
    const cart = priceCounterCart(db, TEST_INFO, {
      lines: [{ stockItemId: widget, qtyMilli: 10_000, ratePaise: 1000, noScheme: true }],
      date: '2025-04-02',
      pricingMode: 'exclusive'
    })
    expect(cart.lines[0]!.qtyMilli).toBe(10_000)
    expect(cart.lines[0]!.scheme).toBeNull()
  })

  it('refuses a scheme written for neither an item nor a group', () => {
    const { db } = books()
    expect(() => saveScheme(db, { name: 'Nowhere', kind: 'percent', minQtyMilli: 1000, percentBp: 500, fromDate: '2025-04-01' }))
      .toThrow('item or a group')
  })
})

describe('ringing up a sale', () => {
  it('posts a balanced sales voucher with no party ledger for a walk-in', () => {
    const { db, widget } = books()
    const before = (db.prepare('SELECT COUNT(*) AS n FROM ledgers').get() as { n: number }).n
    const sale = saveCounterSale(db, TEST_INFO, {
      lines: [{ stockItemId: widget, qtyMilli: 1000, ratePaise: 11800 }],
      tenders: [{ mode: 'cash', amountPaise: 20000 }],
      date: '2025-04-02',
      customerName: 'Walk-in'
    })
    expect(sale.tender.changePaise).toBe(8200)

    const voucher = getVoucher(db, sale.voucherId)!
    expect(voucher.partyLedgerId).toBeNull()
    const dr = voucher.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    const cr = voucher.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
    expect(dr).toBe(cr)
    // The cash line is what stayed in the drawer, not what was handed over.
    expect(dr).toBe(11800)

    const after = (db.prepare('SELECT COUNT(*) AS n FROM ledgers').get() as { n: number }).n
    // Cash, Sales Account, CGST and SGST — but no "Walk-in" master.
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledgers WHERE name = 'Walk-in'").get()).toEqual({ n: 0 })
    expect(after).toBeGreaterThan(before)
  })

  it('moves the stock out', () => {
    const { db, widget } = books()
    saveCounterSale(db, TEST_INFO, {
      lines: [{ stockItemId: widget, qtyMilli: 2000, ratePaise: 11800 }],
      tenders: [{ mode: 'cash', amountPaise: 23600 }],
      date: '2025-04-02'
    })
    expect(itemDetail(db, widget, '2025-04-02').onHandMilli).toBe(98_000)
  })

  it('refuses a tender that does not cover the bill', () => {
    const { db, widget } = books()
    expect(() =>
      saveCounterSale(db, TEST_INFO, {
        lines: [{ stockItemId: widget, qtyMilli: 1000, ratePaise: 11800 }],
        tenders: [{ mode: 'cash', amountPaise: 10000 }],
        date: '2025-04-02'
      })
    ).toThrow('short by')
  })

  it('refuses credit with nobody to owe it', () => {
    const { db, widget } = books()
    expect(() =>
      saveCounterSale(db, TEST_INFO, {
        lines: [{ stockItemId: widget, qtyMilli: 1000, ratePaise: 11800 }],
        tenders: [{ mode: 'credit', amountPaise: 11800 }],
        date: '2025-04-02'
      })
    ).toThrow('Somebody has to owe')
  })

  it('puts a credit tender on the party, and the cash part on cash', () => {
    const { db, widget, buyer } = books()
    const sale = saveCounterSale(db, TEST_INFO, {
      lines: [{ stockItemId: widget, qtyMilli: 1000, ratePaise: 11800 }],
      tenders: [{ mode: 'cash', amountPaise: 5000 }, { mode: 'credit', amountPaise: 6800 }],
      date: '2025-04-02',
      partyLedgerId: buyer
    })
    const voucher = getVoucher(db, sale.voucherId)!
    const partyLine = voucher.lines.find((l) => l.ledgerId === buyer)!
    expect(partyLine.amount).toBe(6800)
    expect(partyLine.drCr).toBe('dr')
  })

  it('refuses an empty cart', () => {
    const { db } = books()
    expect(() => saveCounterSale(db, TEST_INFO, { lines: [], tenders: [{ mode: 'cash', amountPaise: 0 }] })).toThrow('nothing in the cart')
  })
})

describe('returns at the counter', () => {
  it('finds the sale behind a receipt and reverses it', () => {
    const { db, widget } = books()
    const sale = saveCounterSale(db, TEST_INFO, {
      lines: [{ stockItemId: widget, qtyMilli: 2000, ratePaise: 11800 }],
      tenders: [{ mode: 'cash', amountPaise: 23600 }],
      date: '2025-04-02',
      customerPhone: '9876543210'
    })
    const found = findSaleForReturn(db, sale.number)!
    expect(found.voucherId).toBe(sale.voucherId)
    expect(found.lines[0]!.qtyMilli).toBe(2000)

    const ret = saveCounterSale(db, TEST_INFO, {
      lines: [{ stockItemId: widget, qtyMilli: 1000, ratePaise: 11800 }],
      tenders: [{ mode: 'cash', amountPaise: 11800 }],
      date: '2025-04-03',
      kind: 'return',
      returnsVoucherId: sale.voucherId
    })
    const voucher = getVoucher(db, ret.voucherId)!
    // A return runs every line the other way: cash out, sales reversed, stock back in.
    const cashLine = voucher.lines.find((l) => l.drCr === 'cr')!
    expect(cashLine.amount).toBe(11800)
    expect(itemDetail(db, widget, '2025-04-03').onHandMilli).toBe(99_000)
  })

  it('finds the sale by the customer’s phone number when the receipt is lost', () => {
    const { db, widget } = books()
    saveCounterSale(db, TEST_INFO, {
      lines: [{ stockItemId: widget, qtyMilli: 1000, ratePaise: 11800 }],
      tenders: [{ mode: 'cash', amountPaise: 11800 }],
      date: '2025-04-02',
      customerPhone: '9876543210'
    })
    expect(findSaleForReturn(db, '9876543210')).not.toBeNull()
    expect(findSaleForReturn(db, '0000000000')).toBeNull()
  })
})

describe('the drawer', () => {
  it('opens once, and refuses a second open till', () => {
    const { db } = books()
    openDrawer(db, { openedOn: '2025-04-02', openingFloatPaise: 2_00_000 })
    expect(() => openDrawer(db, { openedOn: '2025-04-02', openingFloatPaise: 1000 })).toThrow('already open')
  })

  it('expects the float plus the cash that stayed in it', () => {
    const { db, widget } = books()
    const session = openDrawer(db, { openedOn: '2025-04-02', openingFloatPaise: 2_00_000, operator: 'Ravi' })
    saveCounterSale(db, TEST_INFO, {
      lines: [{ stockItemId: widget, qtyMilli: 1000, ratePaise: 11800 }],
      tenders: [{ mode: 'cash', amountPaise: 20000 }],
      date: '2025-04-02'
    })
    const summary = sessionSummary(db, session.id)
    // The change handed back never entered the takings.
    expect(summary.drawer.cashSalesPaise).toBe(11800)
    expect(summary.drawer.expectedPaise).toBe(2_11_800)
    expect(summary.sales).toBe(1)
  })

  it('keeps card takings out of the till', () => {
    const { db, widget } = books()
    const session = openDrawer(db, { openedOn: '2025-04-02', openingFloatPaise: 0 })
    saveCounterSale(db, TEST_INFO, {
      lines: [{ stockItemId: widget, qtyMilli: 1000, ratePaise: 11800 }],
      tenders: [{ mode: 'card', amountPaise: 11800 }],
      date: '2025-04-02'
    })
    const summary = sessionSummary(db, session.id)
    expect(summary.drawer.expectedPaise).toBe(0)
    expect(summary.byMode.find((m) => m.mode === 'card')!.amountPaise).toBe(11800)
  })

  it('counts a payout out of the expected balance', () => {
    const { db } = books()
    const session = openDrawer(db, { openedOn: '2025-04-02', openingFloatPaise: 2_00_000 })
    recordMovement(db, session.id, 'payout', 50_000, 'Bank drop')
    expect(sessionSummary(db, session.id).drawer.expectedPaise).toBe(1_50_000)
  })

  it('calls a drawer counted short short, and stores the variance it was closed on', () => {
    const { db } = books()
    const session = openDrawer(db, { openedOn: '2025-04-02', openingFloatPaise: 2_00_000 })
    const closed = closeDrawer(db, session.id, 1_95_000, 'Fifty short')
    expect(closed.drawer.status).toBe('short')
    expect(closed.drawer.variancePaise).toBe(-5_000)
    expect(closed.session.countedPaise).toBe(1_95_000)
    expect(openSession(db)).toBeNull()
  })

  it('refuses to close twice, or to take a movement after closing', () => {
    const { db } = books()
    const session = openDrawer(db, { openedOn: '2025-04-02', openingFloatPaise: 0 })
    closeDrawer(db, session.id, 0, null)
    expect(() => closeDrawer(db, session.id, 0, null)).toThrow('already been closed')
    expect(() => recordMovement(db, session.id, 'payin', 100, null)).toThrow('closed')
  })

  it('lists the day’s sales against the session that rang them up', () => {
    const { db, widget } = books()
    const session = openDrawer(db, { openedOn: '2025-04-02', openingFloatPaise: 0 })
    saveCounterSale(db, TEST_INFO, {
      lines: [{ stockItemId: widget, qtyMilli: 1000, ratePaise: 11800 }],
      tenders: [{ mode: 'cash', amountPaise: 11800 }],
      date: '2025-04-02'
    })
    const rows = listCounterSales(db, session.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.totalPaise).toBe(11800)
    expect(rows[0]!.modes).toBe('cash')
  })
})
