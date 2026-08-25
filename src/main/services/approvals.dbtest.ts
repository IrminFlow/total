import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import { voucherInputSchema } from '@shared/schemas'
import { saveUser } from './users'
import {
  approveRequest,
  createApprovalRequest,
  getApprovalPolicy,
  listApprovalRequests,
  rejectRequest,
  requiresApproval,
  setApprovalPolicy
} from './approvals'

function fixture() {
  const db = seededDb()
  const owner = saveUser(db, { name: 'Owner', role: 'owner', pin: '1234' })
  const maker = saveUser(db, { name: 'Maker', role: 'accountant', pin: '2345' })
  const type = db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt'").get() as { id: number }
  const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Sales Accounts'").get() as { id: number }
  const salesId = Number(db.prepare("INSERT INTO ledgers (name, group_id) VALUES ('Approval Sales', ?)").run(group.id).lastInsertRowid)
  const input = voucherInputSchema.parse({
    voucherTypeId: type.id,
    date: '2026-08-24',
    partyLedgerId: null,
    narration: 'Controlled receipt',
    reference: null,
    instrumentNo: null,
    instrumentDate: null,
    transporterId: null,
    vehicleNo: null,
    transportDistanceKm: null,
    currencyCode: null,
    exchangeRate: null,
    lines: [
      { ledgerId: cash.id, drCr: 'dr', amount: 250_000, costAllocations: [] },
      { ledgerId: salesId, drCr: 'cr', amount: 250_000, costAllocations: [] }
    ],
    inventory: [],
    billRefs: [],
    tds: null
  })
  return { db, owner, maker, type, input }
}

describe('maker-checker approval requests', () => {
  it('keeps a validated pending request completely outside the books until a different user approves', () => {
    const { db, owner, maker, input } = fixture()
    setApprovalPolicy(db, { enabled: true, thresholdPaise: 200_000, voucherTypeIds: [], expenseEnabled: false, expenseThresholdPaise: null })
    expect(requiresApproval(db, input)).toBe(true)

    const request = createApprovalRequest(db, input, maker)
    expect(request.amount).toBe(250_000)
    expect((db.prepare('SELECT COUNT(*) AS count FROM vouchers').get() as { count: number }).count).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS count FROM voucher_lines').get() as { count: number }).count).toBe(0)
    expect(listApprovalRequests(db)).toHaveLength(1)

    expect(() => approveRequest(db, request.id, maker, null)).toThrow(/different users/)
    expect((db.prepare('SELECT COUNT(*) AS count FROM vouchers').get() as { count: number }).count).toBe(0)

    const voucher = approveRequest(db, request.id, owner, 'Checked source receipt')
    expect(voucher.lines).toHaveLength(2)
    expect(listApprovalRequests(db)).toHaveLength(0)
    const approved = listApprovalRequests(db, 'approved')[0]!
    expect(approved).toMatchObject({ checkerName: 'Owner', postedVoucherId: voucher.id, decisionNote: 'Checked source receipt' })
  })

  it('retains rejected requests and never posts them', () => {
    const { db, owner, maker, input } = fixture()
    const request = createApprovalRequest(db, input, maker)
    rejectRequest(db, request.id, owner, 'Reference document is missing')
    expect(listApprovalRequests(db)).toHaveLength(0)
    expect(listApprovalRequests(db, 'rejected')[0]).toMatchObject({ checkerName: 'Owner', decisionNote: 'Reference document is missing' })
    expect((db.prepare('SELECT COUNT(*) AS count FROM vouchers').get() as { count: number }).count).toBe(0)
  })

  it('refuses to enable an unusable one-person policy', () => {
    const db = seededDb()
    saveUser(db, { name: 'Only owner', role: 'owner', pin: '1234' })
    expect(() => setApprovalPolicy(db, { enabled: true, thresholdPaise: 1, voucherTypeIds: [], expenseEnabled: false, expenseThresholdPaise: null })).toThrow(/at least two/)
    expect(getApprovalPolicy(db).enabled).toBe(false)
  })

  it('routes detected department expenses independently of the general voucher policy', () => {
    const {db,maker}=fixture();const payment=db.prepare("SELECT id FROM voucher_types WHERE kind='payment'").get() as {id:number};const cash=db.prepare("SELECT id FROM ledgers WHERE name='Cash'").get() as {id:number};const group=db.prepare("SELECT id FROM groups WHERE name='Indirect Expenses'").get() as {id:number};const expenseId=Number(db.prepare("INSERT INTO ledgers(name,group_id) VALUES('Employee Travel',?)").run(group.id).lastInsertRowid);const departmentId=Number(db.prepare("INSERT INTO cost_centres(name) VALUES('Field Sales')").run().lastInsertRowid)
    const expense=voucherInputSchema.parse({voucherTypeId:payment.id,date:'2026-08-24',partyLedgerId:null,narration:'Travel reimbursement',reference:null,instrumentNo:null,instrumentDate:null,transporterId:null,vehicleNo:null,transportDistanceKm:null,currencyCode:null,exchangeRate:null,lines:[{ledgerId:expenseId,drCr:'dr',amount:50_000,costAllocations:[{costCentreId:departmentId,amount:50_000}]},{ledgerId:cash.id,drCr:'cr',amount:50_000,costAllocations:[]}],inventory:[],billRefs:[],tds:null})
    setApprovalPolicy(db,{enabled:false,thresholdPaise:null,voucherTypeIds:[],expenseEnabled:true,expenseThresholdPaise:25_000});expect(requiresApproval(db,expense)).toBe(true);const request=createApprovalRequest(db,expense,maker);expect(request).toMatchObject({requestKind:'expense',expenseLedgers:['Employee Travel'],departments:['Field Sales'],summary:'Expense · Employee Travel · 2026-08-24'})
  })
})
