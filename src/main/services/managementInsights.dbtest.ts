import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import {
  listManagementScenarios, listReportAnnotations, saveManagementScenario, saveReportAnnotation,
  saveScheduleIiiMapping, scenarioProjection, scheduleIiiStatement, varianceExplanation
} from './managementInsights'

function setupSale(amount:number,date:string,partyName:string){const db=seededDb();const group=(name:string)=>(db.prepare('SELECT id FROM groups WHERE name=?').get(name) as {id:number}).id;const party=createLedger(db,{name:partyName,groupId:group('Sundry Debtors')});const sales=createLedger(db,{name:'Consulting sales',groupId:group('Sales Accounts')});const type=(db.prepare("SELECT id FROM voucher_types WHERE kind='sales'").get() as {id:number}).id;const voucher=saveVoucher(db,{voucherTypeId:type,date,partyLedgerId:party.id,narration:null,reference:null,instrumentNo:null,instrumentDate:null,transporterId:null,vehicleNo:null,transportDistanceKm:null,posOverride:null,currencyCode:null,exchangeRate:null,lines:[{ledgerId:party.id,drCr:'dr',amount},{ledgerId:sales.id,drCr:'cr',amount}],inventory:[],billRefs:[],tds:null});return{db,voucher,group,sales}}

describe('management insights',()=>{
  it('explains period change with exact party voucher evidence',()=>{const {db,voucher}=setupSale(100_000,'2026-08-10','Acme');const result=varianceExplanation(db,'2026-08-01','2026-08-31','2026-07-01','2026-07-31');expect(result.salesChange).toBe(100_000);expect(result.drivers.find((row)=>row.dimension==='customer')).toMatchObject({name:'Acme',change:100_000,voucherIds:[voucher.id]})})
  it('saves non-posting scenarios and projects the reviewed assumptions',()=>{const {db}=setupSale(100_000,'2026-08-10','Acme');const scenario=saveManagementScenario(db,{name:'Growth',salesGrowthPct:10,grossMarginPct:60,expenseChangePct:5,collectionDaysChange:7,paymentDaysChange:0,note:null},'Owner');expect(listManagementScenarios(db)).toHaveLength(1);expect(scenarioProjection(db,'2026-08-01','2026-08-31',scenario).projected.sales).toBe(110_000)})
  it('retains export-selectable row annotations',()=>{const {db}=setupSale(100_000,'2026-08-10','Acme');saveReportAnnotation(db,{reportKey:'profit-loss',rowKey:'net-profit',from:'2026-08-01',to:'2026-08-31',note:'Launch costs normalized',includeInExport:true},'Asha');expect(listReportAnnotations(db,'profit-loss','2026-08-01','2026-08-31')[0]).toMatchObject({note:'Launch costs normalized',author:'Asha',includeInExport:true})})
  it('builds Schedule III rows only from explicitly mapped groups and exposes unmapped balances',()=>{const {db,group}=setupSale(100_000,'2026-08-10','Acme');const salesGroup=group('Sales Accounts');saveScheduleIiiMapping(db,{groupId:salesGroup,side:'income',section:'Revenue from operations',noteCode:'20',sortOrder:20},'Owner');const statement=scheduleIiiStatement(db,'2026-08-31','2025-08-31');expect(statement.rows.find((row)=>row.section==='Revenue from operations')?.current).toBe(100_000);expect(statement.unmapped.length).toBeGreaterThan(0)})
})
