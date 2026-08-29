import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import { supplierDueQueue } from './payables'
import { supplierAdvances } from './analysis'

const defaults = { gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: 0, exportType: null }

function purchase(db: ReturnType<typeof seededDb>, name: string, amount: number, date: string): number {
  const group = (value: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(value) as { id: number }).id
  const supplier = createLedger(db, { ...defaults, name, groupId: group('Sundry Creditors'), openingBalance: 0 }).id
  const expense = createLedger(db, { ...defaults, name: `${name} Purchases`, groupId: group('Purchase Accounts'), openingBalance: 0 }).id
  const type = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'purchase'").get() as { id: number }).id
  saveVoucher(db, { voucherTypeId: type, date, partyLedgerId: supplier, narration: 'Supplier bill', reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null, lines: [{ ledgerId: expense, drCr: 'dr', amount, costAllocations: [] }, { ledgerId: supplier, drCr: 'cr', amount, costAllocations: [] }], inventory: [], billRefs: [{ kind: 'new', name: `BILL-${supplier}`, amount, dueDate: date }], tds: null })
  return supplier
}

describe('supplierDueQueue', () => {
  it('ranks overdue suppliers and explains whether available cash covers them', () => {
    const db = seededDb()
    db.prepare("UPDATE ledgers SET opening_balance = 150000 WHERE name = 'Cash'").run()
    const urgent = purchase(db, 'Urgent Supplier', 100_000, '2026-06-01')
    purchase(db, 'Large Supplier', 200_000, '2026-08-20')
    const queue = supplierDueQueue(db, '2026-08-24')
    expect(queue.availableCash).toBe(150_000)
    expect(queue.rows[0]).toMatchObject({ ledgerId: urgent, priority: 'critical', coveredByCash: true })
    expect(queue.rows[1]?.coveredByCash).toBe(false)
    expect(queue.totalPending).toBe(300_000)
  })

  it('tracks unapplied supplier payments as ageing advances and consumes them against later bills', () => {
    const db=seededDb();const group=(name:string):number=>(db.prepare('SELECT id FROM groups WHERE name=?').get(name) as {id:number}).id;const supplier=createLedger(db,{...defaults,name:'Advance Supplier',groupId:group('Sundry Creditors'),openingBalance:0}).id;const cash=(db.prepare("SELECT id FROM ledgers WHERE name='Cash'").get() as {id:number}).id;const payment=(db.prepare("SELECT id FROM voucher_types WHERE kind='payment'").get() as {id:number}).id
    saveVoucher(db,{voucherTypeId:payment,date:'2026-06-01',partyLedgerId:supplier,narration:'Supplier advance',reference:null,instrumentNo:null,instrumentDate:null,transporterId:null,vehicleNo:null,transportDistanceKm:null,currencyCode:null,exchangeRate:null,lines:[{ledgerId:supplier,drCr:'dr',amount:50_000,costAllocations:[]},{ledgerId:cash,drCr:'cr',amount:50_000,costAllocations:[]}],inventory:[],billRefs:[],tds:null})
    expect(supplierAdvances(db,'2026-08-24')).toMatchObject([{ledgerId:supplier,pendingAdjustment:50_000,oldestDate:'2026-06-01',ageDays:84,paymentVoucherIds:[expect.any(Number)]}])
    const expense=createLedger(db,{...defaults,name:'Advance Purchases',groupId:group('Purchase Accounts'),openingBalance:0}).id;const purchaseType=(db.prepare("SELECT id FROM voucher_types WHERE kind='purchase'").get() as {id:number}).id
    saveVoucher(db,{voucherTypeId:purchaseType,date:'2026-08-20',partyLedgerId:supplier,narration:'Adjusted bill',reference:null,instrumentNo:null,instrumentDate:null,transporterId:null,vehicleNo:null,transportDistanceKm:null,currencyCode:null,exchangeRate:null,lines:[{ledgerId:expense,drCr:'dr',amount:30_000,costAllocations:[]},{ledgerId:supplier,drCr:'cr',amount:30_000,costAllocations:[]}],inventory:[],billRefs:[{kind:'new',name:'B-ADV',amount:30_000,dueDate:'2026-08-20'}],tds:null})
    expect(supplierAdvances(db,'2026-08-24')[0]?.pendingAdjustment).toBe(20_000)
  })
})
