import type { DB } from '../db/connection'
import type { SalesRecurringBatch, SalesRecurringBatchRow, SalesRecurringPreview, SalesRecurringPreviewRow, SalesRecurringSchedule, SalesRecurringScheduleInput } from '@shared/salesBilling'
import { nextSalesBillingDate } from '@shared/salesBilling'
import { salesLineAmounts } from '@shared/salesDocuments'
import { rateFor } from './priceLevels'
import { saveVoucherDraft } from './voucherDrafts'
import { writeAudit } from './audit'

interface ScheduleRow { id:number;name:string;party_ledger_id:number;party_name:string;voucher_type_id:number;voucher_type_name:string;cadence:SalesRecurringSchedule['cadence'];next_due:string;end_date:string|null;due_days:number;lines_json:string;narration:string|null;active:number;last_generated:string|null;created_by:string;created_at:string;updated_at:string }
const SELECT=`SELECT s.*,l.name AS party_name,vt.name AS voucher_type_name FROM sales_recurring_schedules s JOIN ledgers l ON l.id=s.party_ledger_id JOIN voucher_types vt ON vt.id=s.voucher_type_id`

function map(row:ScheduleRow):SalesRecurringSchedule{return{id:row.id,name:row.name,partyLedgerId:row.party_ledger_id,partyName:row.party_name,voucherTypeId:row.voucher_type_id,voucherTypeName:row.voucher_type_name,cadence:row.cadence,nextDue:row.next_due,endDate:row.end_date,dueDays:row.due_days,lines:JSON.parse(row.lines_json) as SalesRecurringSchedule['lines'],narration:row.narration,active:!!row.active,lastGenerated:row.last_generated,createdBy:row.created_by,createdAt:row.created_at,updatedAt:row.updated_at}}
export function listSalesRecurringSchedules(db:DB):SalesRecurringSchedule[]{return(db.prepare(`${SELECT} ORDER BY s.active DESC,s.next_due,s.name`).all() as ScheduleRow[]).map(map)}
function get(db:DB,id:number):SalesRecurringSchedule|null{const row=db.prepare(`${SELECT} WHERE s.id=?`).get(id) as ScheduleRow|undefined;return row?map(row):null}

function validate(db:DB,input:SalesRecurringScheduleInput):void{
  if(!input.name.trim())throw new Error('Schedule name is required')
  if(!/^\d{4}-\d{2}-\d{2}$/.test(input.nextDue))throw new Error('Next due date is invalid')
  if(input.endDate&&input.endDate<input.nextDue)throw new Error('End date cannot be before the first due date')
  if(!input.lines.length)throw new Error('Add at least one recurring invoice line')
  const type=db.prepare('SELECT kind FROM voucher_types WHERE id=?').get(input.voucherTypeId) as {kind:string}|undefined
  if(type?.kind!=='sales')throw new Error('Recurring invoice schedules require a sales voucher type')
  if(!db.prepare('SELECT 1 FROM ledgers WHERE id=?').get(input.partyLedgerId))throw new Error('Customer ledger was not found')
  input.lines.forEach((line,index)=>{if(!db.prepare('SELECT 1 FROM stock_items WHERE id=?').get(line.stockItemId))throw new Error(`Line ${index+1}: item was not found`);if(line.qtyMilli<=0||!Number.isInteger(line.qtyMilli))throw new Error(`Line ${index+1}: quantity must be positive`);if(line.rateMode==='fixed'&&(line.fixedRate==null||line.fixedRate<0||!Number.isInteger(line.fixedRate)))throw new Error(`Line ${index+1}: fixed rate is required`);if(line.discountBps<0||line.discountBps>10000)throw new Error(`Line ${index+1}: discount is invalid`)})
}

export function saveSalesRecurringSchedule(db:DB,input:SalesRecurringScheduleInput,author:string,id?:number):SalesRecurringSchedule{
  validate(db,input);const actor=author.trim()||'Local user',json=JSON.stringify(input.lines),name=input.name.trim();let scheduleId=id
  if(id){const before=get(db,id);if(!before)throw new Error('Recurring invoice schedule was not found');db.prepare(`UPDATE sales_recurring_schedules SET name=?,party_ledger_id=?,voucher_type_id=?,cadence=?,next_due=?,end_date=?,due_days=?,lines_json=?,narration=?,active=?,updated_at=datetime('now') WHERE id=?`).run(name,input.partyLedgerId,input.voucherTypeId,input.cadence,input.nextDue,input.endDate,input.dueDays,json,input.narration?.trim()||null,Number(input.active),id);writeAudit(db,'sales_recurring_schedule',id,'update',before,input)}else{scheduleId=Number(db.prepare(`INSERT INTO sales_recurring_schedules(name,party_ledger_id,voucher_type_id,cadence,next_due,end_date,due_days,lines_json,narration,active,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(name,input.partyLedgerId,input.voucherTypeId,input.cadence,input.nextDue,input.endDate,input.dueDays,json,input.narration?.trim()||null,Number(input.active),actor).lastInsertRowid);writeAudit(db,'sales_recurring_schedule',scheduleId,'create',null,input)}
  return get(db,scheduleId!)!
}

function dueDates(schedule:SalesRecurringSchedule,asOn:string):string[]{const dates:string[]=[];let date=schedule.nextDue;while(date<=asOn&&(!schedule.endDate||date<=schedule.endDate)&&dates.length<60){dates.push(date);date=nextSalesBillingDate(schedule.cadence,date)}return dates}
function addDays(date:string,days:number):string{const value=new Date(`${date}T00:00:00Z`);value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10)}

function previewRow(db:DB,schedule:SalesRecurringSchedule,dueDate:string):SalesRecurringPreviewRow{
  const ledger=db.prepare('SELECT price_level_id AS priceLevelId FROM ledgers WHERE id=?').get(schedule.partyLedgerId) as {priceLevelId:number|null}|undefined
  const resolved:SalesRecurringPreviewRow['resolvedLines']=[];const errors:string[]=[];let amount=0
  schedule.lines.forEach((line,index)=>{let rate=line.fixedRate;if(line.rateMode==='price_list'){rate=ledger?.priceLevelId?rateFor(db,ledger.priceLevelId,line.stockItemId,dueDate):null;if(rate==null)errors.push(`Line ${index+1}: no effective customer price on ${dueDate}`)}if(rate!=null){resolved.push({...line,rate});const item=db.prepare('SELECT gst_rate AS gstRate FROM stock_items WHERE id=?').get(line.stockItemId) as {gstRate:number|null}|undefined;amount+=salesLineAmounts({qtyMilli:line.qtyMilli,rate,discountBps:line.discountBps,gstRate:item?.gstRate??0}).totalAmount}})
  return{scheduleId:schedule.id,scheduleName:schedule.name,partyName:schedule.partyName,dueDate,amount,status:errors.length?'exception':'ready',message:errors.join('; ')||null,resolvedLines:resolved}
}

export function previewSalesRecurringBatch(db:DB,asOn:string):SalesRecurringPreview{
  const rows=listSalesRecurringSchedules(db).filter((schedule)=>schedule.active).flatMap((schedule)=>dueDates(schedule,asOn).map((date)=>previewRow(db,schedule,date)))
  return{asOn,readyCount:rows.filter((row)=>row.status==='ready').length,exceptionCount:rows.filter((row)=>row.status==='exception').length,totalAmount:rows.filter((row)=>row.status==='ready').reduce((sum,row)=>sum+row.amount,0),rows}
}

export function generateSalesRecurringBatch(db:DB,asOn:string,scheduleIds:number[],author:string):SalesRecurringBatch{
  const actor=author.trim()||'Local user',selected=new Set(scheduleIds),preview=previewSalesRecurringBatch(db,asOn)
  const rows=preview.rows.filter((row)=>!selected.size||selected.has(row.scheduleId));if(!rows.length)throw new Error('No due recurring invoices were selected')
  const batchId=db.transaction(()=>{const id=Number(db.prepare('INSERT INTO sales_recurring_batches(as_on,created_by) VALUES(?,?)').run(asOn,actor).lastInsertRowid);for(const row of rows){const schedule=get(db,row.scheduleId)!;if(row.status==='exception'){db.prepare(`INSERT INTO sales_recurring_batch_rows(batch_id,schedule_id,due_date,status,message) VALUES(?,?,?,'exception',?)`).run(id,row.scheduleId,row.dueDate,row.message);continue}const draft=saveVoucherDraft(db,{voucherTypeId:schedule.voucherTypeId,mode:'invoice',title:`${schedule.name} · ${row.dueDate}`,payloadVersion:1,payload:{date:row.dueDate,number:'',partyId:schedule.partyLedgerId,accountId:null,rows:row.resolvedLines.map((line)=>{const base=Math.round(line.qtyMilli*line.rate/1000);return{itemId:line.stockItemId,qtyText:String(line.qtyMilli/1000),rate:line.rate,discount:Math.round(base*line.discountBps/10000)}}),narration:schedule.narration??schedule.name,vehicleNo:'',transporterId:'',distanceKm:'',currencyCode:'',fxRateText:'',posOverride:null,optionalVoucher:false,billName:'',billDueDate:addDays(row.dueDate,schedule.dueDays),billNameTouched:false,billDueDateTouched:schedule.dueDays>0,manualNewBillMode:false,noteBillRefs:[],salesRecurringScheduleId:schedule.id,salesRecurringDueDate:row.dueDate}},actor);db.prepare(`INSERT INTO sales_recurring_batch_rows(batch_id,schedule_id,due_date,status,voucher_draft_id) VALUES(?,?,?,'generated',?)`).run(id,row.scheduleId,row.dueDate,draft.id);db.prepare("UPDATE sales_recurring_schedules SET last_generated=?,next_due=?,updated_at=datetime('now') WHERE id=?").run(row.dueDate,nextSalesBillingDate(schedule.cadence,row.dueDate),schedule.id)}return id})()
  const batch=getSalesRecurringBatch(db,batchId)!;writeAudit(db,'sales_recurring_batch',batchId,'create',null,{asOn,generated:batch.rows.filter((row)=>row.status==='generated').length,exceptions:batch.rows.filter((row)=>row.status==='exception').length});return batch
}

export function getSalesRecurringBatch(db:DB,id:number):SalesRecurringBatch|null{
  const header=db.prepare('SELECT id,as_on AS asOn,created_by AS createdBy,created_at AS createdAt FROM sales_recurring_batches WHERE id=?').get(id) as Omit<SalesRecurringBatch,'rows'>|undefined;if(!header)return null
  const rows=db.prepare(`SELECT r.id,r.schedule_id AS scheduleId,s.name AS scheduleName,l.name AS partyName,r.due_date AS dueDate,0 AS amount,r.status,r.message,r.voucher_draft_id AS voucherDraftId FROM sales_recurring_batch_rows r JOIN sales_recurring_schedules s ON s.id=r.schedule_id JOIN ledgers l ON l.id=s.party_ledger_id WHERE r.batch_id=? ORDER BY r.id`).all(id) as SalesRecurringBatchRow[]
  return{...header,rows}
}
