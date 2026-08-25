import { existsSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import { openCompanyDb } from '../db/connection'
import { seedCompany } from '../db/seed'
import { upsertCompany } from '../registry'
import { companyDbPath, companyDir, ensureCompanyTree, slugify } from '../paths'
import { createLedger, createStockItem } from './masters'
import { saveVoucher } from './vouchers'
import {
  DEMO_COMPANY, DEMO_PARTIES, DEMO_ITEMS, DEMO_EXTRA_LEDGERS, demoVouchers,
  type DemoVoucher
} from '@shared/demo'
import { todayISO } from '@shared/dates'
import type { VoucherKind } from '@shared/domain'
import { applyBusinessTemplate, defaultOnboardingProfile, writeOnboardingProfile, type BusinessType } from './onboarding'

const DEMO_INDUSTRIES: Record<BusinessType, { name: string; needsInventory: boolean; needsPayroll: boolean }> = {
  retailer: { name: DEMO_COMPANY.name, needsInventory: true, needsPayroll: false },
  wholesaler: { name: 'Demo Wholesale House', needsInventory: true, needsPayroll: false },
  service: { name: 'Demo Services Studio', needsInventory: false, needsPayroll: false },
  manufacturer: { name: 'Demo Manufacturing Works', needsInventory: true, needsPayroll: true },
  freelancer: { name: 'Demo Freelancer Books', needsInventory: false, needsPayroll: false },
  professional: { name: 'Demo Professional Practice', needsInventory: false, needsPayroll: true },
}

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
 * Create the "Demo Traders" sample company: seeded masters (parties, items, GST/bank ledgers)
 * plus ~40 balanced sample vouchers, so a first-time user can explore Gateway/GSTR-1/reports
 * without typing anything in. Mirrors company:create (slugify + dedup, ensureCompanyTree,
 * openCompanyDb, seedCompany), then layers demo-specific masters and vouchers on top.
 */
export function createDemoCompany(businessType: BusinessType = 'retailer'): { slug: string } {
  const industry = DEMO_INDUSTRIES[businessType]
  const company = { ...DEMO_COMPANY, name: industry.name }
  let slug = slugify(company.name)
  let n = 2
  while (existsSync(companyDbPath(slug))) slug = `${slugify(company.name)}-${n++}`

  ensureCompanyTree(slug)
  const db = openCompanyDb(slug)
  try {
    seedCompany(db, company)
    applyBusinessTemplate(db, businessType)

    const debtorGroup = groupId(db, 'Sundry Debtors')
    const creditorGroup = groupId(db, 'Sundry Creditors')
    for (const p of DEMO_PARTIES) {
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

    for (const l of DEMO_EXTRA_LEDGERS) {
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

    for (const item of DEMO_ITEMS) {
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

    for (const v of demoVouchers(todayISO())) {
      postDemoVoucher(db, v, ledgerIdByName, itemIdByName)
    }

    const profile = defaultOnboardingProfile({
      businessType,
      priorSoftware: 'first-time',
      needsInventory: industry.needsInventory,
      needsPayroll: industry.needsPayroll,
    })
    profile.setupSteps = { company: true, ledgers: true, opening: true, bank: true, tax: true, backup: false, firstVoucher: true }
    writeOnboardingProfile(join(companyDir(slug), 'setup.json'), profile)
  } finally {
    db.close()
  }

  upsertCompany({ slug, name: company.name, stateCode: company.stateCode, gstin: company.gstin, lastOpenedAt: null })
  return { slug }
}
