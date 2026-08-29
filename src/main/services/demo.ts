import { existsSync } from 'fs'
import type { DB } from '../db/connection'
import { openCompanyDb } from '../db/connection'
import { seedCompany } from '../db/seed'
import { upsertCompany } from '../registry'
import { companyDbPath, ensureCompanyTree, slugify } from '../paths'
import { createLedger, createStockItem } from './masters'
import { saveVoucher } from './vouchers'
import { setBom } from './extras'
import { getFeatures, setFeatures } from './config'
import { demoProfile, type DemoTrade, type DemoVoucher } from '@shared/demo'
import { todayISO } from '@shared/dates'
import type { VoucherKind } from '@shared/domain'

function groupId(db: DB, name: string): number {
  const row = db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number } | undefined
  if (!row) throw new Error(`Seed group "${name}" not found — did seedCompany() run?`)
  return row.id
}

function unitId(db: DB, name: string): number {
  const row = db.prepare('SELECT id FROM units WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined
  if (!row) throw new Error(`Seed unit "${name}" not found — did seedCompany() run?`)
  return row.id
}

function voucherTypeIdForKind(db: DB, kind: VoucherKind): number {
  const row = db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number } | undefined
  if (!row) throw new Error(`No seeded voucher type for kind "${kind}"`)
  return row.id
}

/** Post one neutral, name-keyed demo voucher via the same saveVoucher() every screen uses,
 *  resolving ledger/item names to ids via the lookups built by createDemoCompany(). */
function postDemoVoucher(
  db: DB,
  v: DemoVoucher,
  ledgerIdByName: Map<string, number>,
  itemIdByName: Map<string, number>
): void {
  const ledgerId = (name: string): number => {
    const id = ledgerIdByName.get(name)
    if (id === undefined) throw new Error(`Demo voucher references unknown ledger "${name}"`)
    return id
  }
  const itemId = (name: string): number => {
    const id = itemIdByName.get(name)
    if (id === undefined) throw new Error(`Demo voucher references unknown item "${name}"`)
    return id
  }
  saveVoucher(db, {
    voucherTypeId: voucherTypeIdForKind(db, v.kind),
    date: v.date,
    number: undefined,
    partyLedgerId: v.partyName ? ledgerId(v.partyName) : null,
    narration: v.narration,
    reference: null,
    instrumentNo: null,
    instrumentDate: null,
    transporterId: null,
    vehicleNo: null,
    transportDistanceKm: null,
    currencyCode: null,
    exchangeRate: null,
    lines: v.lines.map((l) => ({ ledgerId: ledgerId(l.ledgerName), drCr: l.drCr, amount: l.amount, costAllocations: [] })),
    inventory: (v.inventory ?? []).map((inv) => ({
      stockItemId: itemId(inv.itemName),
      godownId: null,
      qtyMilli: inv.qtyMilli,
      ratePaise: inv.ratePaise,
      amount: inv.amount,
      direction: inv.direction
    })),
    billRefs: [],
    tds: null
  })
}

/**
 * Create a sample company for one of the trades in `DEMO_TRADE_PROFILES` — the shop, the
 * workshop or the practice (roadmap #293): seeded masters (parties, items, GST/bank ledgers)
 * plus a few dozen balanced sample vouchers, so a first-time user can explore Gateway/GSTR-1/
 * reports without typing anything in, in books that look like their own.
 *
 * Defaults to 'trading', which is the original "Demo Traders" book, so every existing caller
 * keeps the company it expects. Mirrors company:create (slugify + dedup, ensureCompanyTree,
 * openCompanyDb, seedCompany), then layers the profile's masters, bill of materials, feature
 * toggles and vouchers on top.
 */
export function createDemoCompany(trade: DemoTrade = 'trading'): { slug: string } {
  const profile = demoProfile(trade)
  const company = profile.company

  let slug = slugify(company.name)
  let n = 2
  while (existsSync(companyDbPath(slug))) slug = `${slugify(company.name)}-${n++}`

  ensureCompanyTree(slug)
  const db = openCompanyDb(slug)
  try {
    seedCompany(db, company)

    const debtorGroup = groupId(db, 'Sundry Debtors')
    const creditorGroup = groupId(db, 'Sundry Creditors')
    for (const p of profile.parties) {
      createLedger(db, {
        name: p.name,
        groupId: p.kind === 'debtor' ? debtorGroup : creditorGroup,
        openingBalance: 0,
        gstin: p.gstin,
        stateCode: p.stateCode,
        address: p.address,
        taxType: null,
        gstRate: null,
        hsn: null,
        tdsSectionId: null,
        pan: null,
        creditDays: 30,
        exportType: null
      })
    }

    for (const l of profile.extraLedgers) {
      createLedger(db, {
        name: l.name,
        groupId: groupId(db, l.groupName),
        openingBalance: 0,
        gstin: null,
        stateCode: null,
        address: null,
        taxType: l.taxType ?? null,
        gstRate: null,
        hsn: null,
        tdsSectionId: null,
        pan: null,
        creditDays: null,
        exportType: null
      })
    }

    for (const item of profile.items) {
      createStockItem(db, {
        name: item.name,
        groupId: null,
        unitId: unitId(db, item.unitName),
        hsn: item.hsn,
        gstRate: item.gstRate,
        cessRate: null,
        openingQtyMilli: 0,
        openingValue: 0,
        barcode: null,
        reorderLevelMilli: null
      })
    }

    const ledgerIdByName = new Map(
      (db.prepare('SELECT id, name FROM ledgers').all() as { id: number; name: string }[]).map((r) => [r.name, r.id])
    )
    const itemIdByName = new Map(
      (db.prepare('SELECT id, name FROM stock_items').all() as { id: number; name: string }[]).map((r) => [r.name, r.id])
    )

    const itemId = (name: string): number => {
      const id = itemIdByName.get(name)
      if (id === undefined) throw new Error(`Demo BOM references unknown item "${name}"`)
      return id
    }

    // The bill of materials is the app's own bom_lines (services/extras.ts#setBom), not a
    // demo-only shadow of one: the sample is worth having only if Masters → Stock items and the
    // Manufacture voucher find exactly what a user would have typed in themselves.
    for (const b of profile.bom) {
      setBom(db, {
        itemId: itemId(b.itemName),
        lines: b.components.map((c) => ({ componentId: itemId(c.itemName), qtyMilliPerUnit: c.qtyMilliPerUnit }))
      })
    }

    // A services firm with inventory switched on is shown several screens about stock it will
    // never have. Settings turns it back on the moment anyone wants it.
    if (Object.keys(profile.featureOverrides).length > 0) {
      setFeatures(db, { ...getFeatures(db), ...profile.featureOverrides })
    }

    for (const v of profile.vouchers(todayISO())) {
      postDemoVoucher(db, v, ledgerIdByName, itemIdByName)
    }
  } finally {
    db.close()
  }

  upsertCompany({ slug, name: company.name, stateCode: company.stateCode, gstin: company.gstin, lastOpenedAt: null })
  return { slug }
}
