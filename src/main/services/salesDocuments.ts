import type { DB } from '../db/connection'
import type {
  SalesDocument, SalesDocumentConversionInput, SalesDocumentConversionResult,
  SalesDocumentInput, SalesDocumentKind, SalesDocumentLine, SalesDocumentLineInput,
  SalesDocumentNumberPreview, SalesDocumentSeries, SalesDocumentSeriesInput,
  SalesDocumentStatus
} from '@shared/salesDocuments'
import { SALES_STATUS_TRANSITIONS, salesDocumentTotals, salesLineAmounts } from '@shared/salesDocuments'
import { saveVoucherDraft } from './voucherDrafts'
import { writeAudit } from './audit'
import { assertDiscountAuthority } from './discountAuthority'
import type { DiscountActorRole } from '@shared/salesBilling'
import { validateCustomFields } from './customerOperations'

interface SeriesRow { id:number; kind:SalesDocumentKind; name:string; prefix:string; suffix:string; pad_width:number; restart_fy:number; active:number }
interface DocumentRow {
  id:number; kind:SalesDocumentKind; series_id:number; series_name:string; number:string; revision_no:number
  party_ledger_id:number; party_name:string; date:string; valid_until:string|null; status:SalesDocumentStatus
  parent_document_id:number|null; purpose:string|null; gst_registration_id:number|null; terms_json:string
  custom_fields_json:string; invoice_draft_id:number|null; created_by:string; created_at:string; updated_at:string
}
interface LineRow {
  id:number; document_id:number; line_order:number; stock_item_id:number|null; description:string; qty_milli:number
  rate:number; discount_bps:number; gst_rate:number; optional:number; cancelled_qty_milli:number; metadata_json:string
  allocated_qty_milli:number; delivered_qty_milli:number; invoiced_qty_milli:number; returned_qty_milli:number
}

const DOCUMENT_SELECT = `SELECT d.*,s.name AS series_name,l.name AS party_name
  FROM sales_documents d JOIN sales_document_series s ON s.id=d.series_id JOIN ledgers l ON l.id=d.party_ledger_id`

function parseJson<T>(json: string, fallback: T): T {
  try { return JSON.parse(json) as T } catch { return fallback }
}

function mapSeries(row: SeriesRow): SalesDocumentSeries {
  return { id:row.id,kind:row.kind,name:row.name,prefix:row.prefix,suffix:row.suffix,padWidth:row.pad_width,restartFy:!!row.restart_fy,active:!!row.active }
}

function mapLine(row: LineRow, kind: SalesDocumentKind): SalesDocumentLine {
  const amounts = salesLineAmounts({ qtyMilli:row.qty_milli,rate:row.rate,discountBps:row.discount_bps,gstRate:row.gst_rate })
  const used = kind === 'quotation' ? row.allocated_qty_milli
    : kind === 'order' ? row.delivered_qty_milli + row.invoiced_qty_milli
    : row.invoiced_qty_milli
  return {
    id:row.id,lineOrder:row.line_order,stockItemId:row.stock_item_id,description:row.description,
    qtyMilli:row.qty_milli,rate:row.rate,discountBps:row.discount_bps,gstRate:row.gst_rate,
    optional:!!row.optional,metadata:parseJson(row.metadata_json,{}),cancelledQtyMilli:row.cancelled_qty_milli,
    allocatedQtyMilli:row.allocated_qty_milli,deliveredQtyMilli:row.delivered_qty_milli,
    invoicedQtyMilli:row.invoiced_qty_milli,returnedQtyMilli:row.returned_qty_milli,
    openQtyMilli:Math.max(0,row.qty_milli-row.cancelled_qty_milli-used+row.returned_qty_milli),...amounts
  }
}

function linesFor(db: DB, documentId: number, kind: SalesDocumentKind): SalesDocumentLine[] {
  const rows = db.prepare(`SELECT l.*,
    COALESCE(SUM(CASE WHEN x.kind='allocation' THEN x.qty_milli ELSE 0 END),0) AS allocated_qty_milli,
    COALESCE(SUM(CASE WHEN x.kind='delivery' THEN x.qty_milli ELSE 0 END),0) AS delivered_qty_milli,
    COALESCE(SUM(CASE WHEN x.kind='invoice' THEN x.qty_milli ELSE 0 END),0) AS invoiced_qty_milli,
    COALESCE(SUM(CASE WHEN x.kind='return' THEN x.qty_milli ELSE 0 END),0) AS returned_qty_milli
    FROM sales_document_lines l LEFT JOIN sales_document_line_links x ON x.from_line_id=l.id
    WHERE l.document_id=? GROUP BY l.id ORDER BY l.line_order`).all(documentId) as LineRow[]
  return rows.map((row)=>mapLine(row,kind))
}

function mapDocument(db: DB, row: DocumentRow): SalesDocument {
  const lines=linesFor(db,row.id,row.kind)
  return {
    id:row.id,kind:row.kind,seriesId:row.series_id,seriesName:row.series_name,number:row.number,
    revisionNo:row.revision_no,partyLedgerId:row.party_ledger_id,partyName:row.party_name,date:row.date,
    validUntil:row.valid_until,status:row.status,parentDocumentId:row.parent_document_id,purpose:row.purpose,
    gstRegistrationId:row.gst_registration_id,terms:parseJson(row.terms_json,[]),customFields:parseJson(row.custom_fields_json,{}),
    invoiceDraftId:row.invoice_draft_id,createdBy:row.created_by,createdAt:row.created_at,updatedAt:row.updated_at,
    lines,totals:salesDocumentTotals(lines)
  }
}

export function listSalesDocumentSeries(db: DB, kind?: SalesDocumentKind): SalesDocumentSeries[] {
  const rows=(kind
    ? db.prepare('SELECT * FROM sales_document_series WHERE kind=? ORDER BY active DESC,name').all(kind)
    : db.prepare('SELECT * FROM sales_document_series ORDER BY kind,active DESC,name').all()) as SeriesRow[]
  return rows.map(mapSeries)
}

export function saveSalesDocumentSeries(db: DB, input: SalesDocumentSeriesInput, id?: number): SalesDocumentSeries {
  const name=input.name.trim(),prefix=input.prefix.trim(),suffix=input.suffix.trim()
  if(!name) throw new Error('Series name is required')
  if(prefix.length>24||suffix.length>24) throw new Error('Series prefix and suffix must be 24 characters or fewer')
  let seriesId=id
  if(id){
    const before=listSalesDocumentSeries(db).find((row)=>row.id===id);if(!before)throw new Error('Sales document series was not found')
    db.prepare(`UPDATE sales_document_series SET kind=?,name=?,prefix=?,suffix=?,pad_width=?,restart_fy=?,active=? WHERE id=?`)
      .run(input.kind,name,prefix,suffix,input.padWidth,Number(input.restartFy),Number(input.active),id)
    writeAudit(db,'sales_document_series',id,'update',before,input)
  }else{
    seriesId=Number(db.prepare(`INSERT INTO sales_document_series(kind,name,prefix,suffix,pad_width,restart_fy,active) VALUES(?,?,?,?,?,?,?)`)
      .run(input.kind,name,prefix,suffix,input.padWidth,Number(input.restartFy),Number(input.active)).lastInsertRowid)
    writeAudit(db,'sales_document_series',seriesId,'create',null,input)
  }
  return listSalesDocumentSeries(db).find((row)=>row.id===seriesId)!
}

function fyStartYear(date: string): number {
  const year=Number(date.slice(0,4)),month=Number(date.slice(5,7))
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isInteger(year)||month<1||month>12)throw new Error('Document date must be YYYY-MM-DD')
  return month>=4?year:year-1
}

function formatNumber(series: SalesDocumentSeries, sequence: number): string {
  return `${series.prefix}${String(sequence).padStart(series.padWidth,'0')}${series.suffix}`
}

export function previewSalesDocumentNumber(db: DB, seriesId: number, date: string): SalesDocumentNumberPreview {
  const series=listSalesDocumentSeries(db).find((row)=>row.id===seriesId)
  if(!series)throw new Error('Sales document series was not found')
  const fy=series.restartFy?fyStartYear(date):0
  const row=db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM sales_document_number_allocations WHERE series_id=? AND fy_start_year=?').get(seriesId,fy) as {sequence:number}
  return {seriesId,fyStartYear:fy,sequence:row.sequence,number:formatNumber(series,row.sequence)}
}

function validateInput(db: DB, input: SalesDocumentInput): void {
  const series=listSalesDocumentSeries(db).find((row)=>row.id===input.seriesId)
  if(!series||series.kind!==input.kind)throw new Error('Select a matching document series')
  if(!series.active)throw new Error('The selected document series is inactive')
  if(!db.prepare('SELECT 1 FROM ledgers WHERE id=?').get(input.partyLedgerId))throw new Error('Customer ledger was not found')
  fyStartYear(input.date)
  if(!input.lines.length)throw new Error('Add at least one document line')
  validateCustomFields(db,input.kind,input.customFields)
  for(const [index,line] of input.lines.entries()){
    if(!line.description.trim())throw new Error(`Line ${index+1}: description is required`)
    if(!Number.isInteger(line.qtyMilli)||line.qtyMilli<=0)throw new Error(`Line ${index+1}: quantity must be positive`)
    if(!Number.isSafeInteger(line.rate)||line.rate<0)throw new Error(`Line ${index+1}: rate must be non-negative paise`)
    if(!Number.isInteger(line.discountBps)||line.discountBps<0||line.discountBps>10_000)throw new Error(`Line ${index+1}: discount is invalid`)
    if(!Number.isFinite(line.gstRate)||line.gstRate<0||line.gstRate>100)throw new Error(`Line ${index+1}: GST rate is invalid`)
    if(line.stockItemId&&!db.prepare('SELECT 1 FROM stock_items WHERE id=?').get(line.stockItemId))throw new Error(`Line ${index+1}: stock item was not found`)
  }
}

function insertLines(db: DB, documentId: number, lines: SalesDocumentLineInput[]): void {
  const insert=db.prepare(`INSERT INTO sales_document_lines(document_id,line_order,stock_item_id,description,qty_milli,rate,discount_bps,gst_rate,optional,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?)`)
  lines.forEach((line,index)=>insert.run(documentId,index+1,line.stockItemId,line.description.trim(),line.qtyMilli,line.rate,line.discountBps,line.gstRate,Number(!!line.optional),JSON.stringify(line.metadata??{})))
}

export function createSalesDocument(db: DB, input: SalesDocumentInput, author: string, parentDocumentId: number|null=null, actorRole:DiscountActorRole='owner'): SalesDocument {
  validateInput(db,input)
  const actor=author.trim()||'Local user'
  assertDiscountAuthority(db,{role:actorRole,actorName:actor,customerLedgerId:input.partyLedgerId,contextKind:'sales_document',lines:input.lines.map((line)=>({stockItemId:line.stockItemId,requestedDiscountBps:line.discountBps}))})
  const id=db.transaction(()=>{
    const preview=previewSalesDocumentNumber(db,input.seriesId,input.date)
    const allocation=db.prepare(`INSERT INTO sales_document_number_allocations(series_id,fy_start_year,sequence,number) VALUES(?,?,?,?)`)
      .run(input.seriesId,preview.fyStartYear,preview.sequence,preview.number)
    const result=db.prepare(`INSERT INTO sales_documents(kind,series_id,number,party_ledger_id,date,valid_until,parent_document_id,purpose,gst_registration_id,terms_json,custom_fields_json,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(input.kind,input.seriesId,preview.number,input.partyLedgerId,input.date,input.validUntil,parentDocumentId,input.purpose?.trim()||null,input.gstRegistrationId,JSON.stringify(input.terms),JSON.stringify(input.customFields),actor)
    const documentId=Number(result.lastInsertRowid)
    db.prepare('UPDATE sales_document_number_allocations SET document_id=? WHERE id=?').run(documentId,allocation.lastInsertRowid)
    insertLines(db,documentId,input.lines)
    return documentId
  })()
  const document=getSalesDocument(db,id)!
  writeAudit(db,'sales_document',id,'create',null,{number:document.number,kind:document.kind,total:document.totals.totalAmount})
  return document
}

export function getSalesDocument(db: DB, id: number): SalesDocument|null {
  const row=db.prepare(`${DOCUMENT_SELECT} WHERE d.id=?`).get(id) as DocumentRow|undefined
  return row?mapDocument(db,row):null
}

export function listSalesDocuments(db: DB, kind?: SalesDocumentKind, status?: SalesDocumentStatus): SalesDocument[] {
  const clauses:string[]=[],args:unknown[]=[]
  if(kind){clauses.push('d.kind=?');args.push(kind)}
  if(status){clauses.push('d.status=?');args.push(status)}
  const where=clauses.length?` WHERE ${clauses.join(' AND ')}`:''
  return (db.prepare(`${DOCUMENT_SELECT}${where} ORDER BY d.date DESC,d.id DESC`).all(...args) as DocumentRow[]).map((row)=>mapDocument(db,row))
}

export function setSalesDocumentStatus(db: DB, id: number, status: SalesDocumentStatus, author: string): SalesDocument {
  const before=getSalesDocument(db,id);if(!before)throw new Error('Sales document was not found')
  if(!(SALES_STATUS_TRANSITIONS[before.kind][before.status]??[]).includes(status))throw new Error(`${before.kind} cannot move from ${before.status} to ${status}`)
  db.prepare("UPDATE sales_documents SET status=?,updated_at=datetime('now') WHERE id=?").run(status,id)
  const after=getSalesDocument(db,id)!
  writeAudit(db,'sales_document',id,'update',{status:before.status},{status:after.status,author})
  return after
}

export function reviseSalesDocument(db: DB, id: number, input: SalesDocumentInput, reason: string, author: string, actorRole:DiscountActorRole='owner'): SalesDocument {
  const before=getSalesDocument(db,id);if(!before)throw new Error('Sales document was not found')
  if(before.kind!==input.kind||before.seriesId!==input.seriesId)throw new Error('A revision cannot change document kind or numbering series')
  if(!['draft','sent'].includes(before.status))throw new Error('Only draft or sent documents can be revised')
  if(!reason.trim())throw new Error('Revision reason is required')
  if(db.prepare(`SELECT 1 FROM sales_document_line_links x JOIN sales_document_lines l ON l.id=x.from_line_id WHERE l.document_id=? LIMIT 1`).get(id))throw new Error('A converted document cannot be revised')
  validateInput(db,input)
  assertDiscountAuthority(db,{role:actorRole,actorName:author.trim()||'Local user',customerLedgerId:input.partyLedgerId,contextKind:'sales_document',lines:input.lines.map((line)=>({stockItemId:line.stockItemId,requestedDiscountBps:line.discountBps}))})
  db.transaction(()=>{
    db.prepare(`INSERT INTO sales_document_revisions(document_id,revision_no,snapshot_json,reason,created_by) VALUES(?,?,?,?,?)`)
      .run(id,before.revisionNo,JSON.stringify(before),reason.trim(),author.trim()||'Local user')
    db.prepare(`UPDATE sales_documents SET revision_no=revision_no+1,party_ledger_id=?,date=?,valid_until=?,status='draft',purpose=?,gst_registration_id=?,terms_json=?,custom_fields_json=?,updated_at=datetime('now') WHERE id=?`)
      .run(input.partyLedgerId,input.date,input.validUntil,input.purpose?.trim()||null,input.gstRegistrationId,JSON.stringify(input.terms),JSON.stringify(input.customFields),id)
    db.prepare('DELETE FROM sales_document_lines WHERE document_id=?').run(id)
    insertLines(db,id,input.lines)
  })()
  const after=getSalesDocument(db,id)!
  writeAudit(db,'sales_document',id,'update',{revisionNo:before.revisionNo},{revisionNo:after.revisionNo,reason:reason.trim()})
  return after
}

function allowedTarget(source: SalesDocumentKind, target: SalesDocumentKind|'invoice'): boolean {
  return target==='invoice'||(source==='quotation'&&target==='order')||(source==='order'&&target==='challan')
}

function readyForConversion(source: SalesDocument): boolean {
  return source.kind==='quotation'||source.kind==='proforma' ? ['accepted','part_fulfilled'].includes(source.status)
    : source.kind==='order' ? ['confirmed','part_fulfilled'].includes(source.status)
    : ['approved','part_fulfilled'].includes(source.status)
}

function refreshFulfilmentStatus(db: DB, id: number): void {
  const doc=getSalesDocument(db,id)!
  const open=doc.lines.reduce((sum,line)=>sum+line.openQtyMilli,0)
  const total=doc.lines.reduce((sum,line)=>sum+line.qtyMilli-line.cancelledQtyMilli,0)
  const next:SalesDocumentStatus=open===0?(doc.kind==='quotation'||doc.kind==='proforma'?'converted':'fulfilled'):open<total?'part_fulfilled':doc.status
  if(next!==doc.status)db.prepare("UPDATE sales_documents SET status=?,updated_at=datetime('now') WHERE id=?").run(next,id)
}

export function convertSalesDocument(db: DB, input: SalesDocumentConversionInput, author: string): SalesDocumentConversionResult {
  const source=getSalesDocument(db,input.sourceDocumentId);if(!source)throw new Error('Source sales document was not found')
  if(!allowedTarget(source.kind,input.targetKind))throw new Error(`A ${source.kind} cannot convert to ${input.targetKind}`)
  if(!readyForConversion(source))throw new Error(`${source.number} must be approved or accepted before conversion`)
  if(!input.lines.length)throw new Error('Select at least one quantity to convert')
  const requested=new Map<number,number>()
  for(const line of input.lines){
    if(requested.has(line.sourceLineId))throw new Error('A source line can only appear once')
    if(!Number.isInteger(line.qtyMilli)||line.qtyMilli<=0)throw new Error('Conversion quantity must be positive')
    const sourceLine=source.lines.find((row)=>row.id===line.sourceLineId)
    if(!sourceLine)throw new Error('Conversion line does not belong to the source document')
    if(line.qtyMilli>sourceLine.openQtyMilli)throw new Error(`Conversion quantity for ${sourceLine.description} exceeds the open quantity`)
    requested.set(line.sourceLineId,line.qtyMilli)
  }
  const selected=source.lines.filter((line)=>requested.has(line.id)).map((line)=>({line,qtyMilli:requested.get(line.id)!}))
  const actor=author.trim()||'Local user'
  let targetDocument:SalesDocument|null=null,invoiceDraftId:number|null=null
  db.transaction(()=>{
    if(input.targetKind==='invoice'){
      const type=db.prepare("SELECT id FROM voucher_types WHERE kind='sales' ORDER BY is_system DESC,id LIMIT 1").get() as {id:number}|undefined
      if(!type)throw new Error('Create a sales voucher type before converting to invoice')
      const draft=saveVoucherDraft(db,{voucherTypeId:type.id,mode:'invoice',title:`Invoice from ${source.number}`,payloadVersion:1,payload:{
        date:input.date,number:'',partyId:source.partyLedgerId,accountId:null,
        rows:selected.map(({line,qtyMilli})=>{const amount=salesLineAmounts({...line,qtyMilli});return{itemId:line.stockItemId,qtyText:String(qtyMilli/1000),rate:line.rate,discount:amount.discountAmount}}),
        narration:`Converted from ${source.number}`,vehicleNo:'',transporterId:'',distanceKm:'',currencyCode:'',fxRateText:'',posOverride:null,optionalVoucher:false,
        billName:'',billDueDate:input.date,billNameTouched:false,billDueDateTouched:false,manualNewBillMode:false,noteBillRefs:[],salesDocumentId:source.id
      }},actor)
      invoiceDraftId=draft.id
      const link=db.prepare(`INSERT INTO sales_document_line_links(from_line_id,invoice_draft_id,kind,qty_milli) VALUES(?,?,'invoice',?)`)
      selected.forEach(({line,qtyMilli})=>link.run(line.id,draft.id,qtyMilli))
      db.prepare(`INSERT INTO sales_document_conversions(from_document_id,invoice_draft_id,created_by) VALUES(?,?,?)`).run(source.id,draft.id,actor)
      db.prepare('UPDATE sales_documents SET invoice_draft_id=?,updated_at=datetime(\'now\') WHERE id=?').run(draft.id,source.id)
    }else{
      if(!input.targetSeriesId)throw new Error('Select a target numbering series')
      targetDocument=createSalesDocument(db,{
        kind:input.targetKind,seriesId:input.targetSeriesId,partyLedgerId:source.partyLedgerId,date:input.date,
        validUntil:null,purpose:source.purpose,gstRegistrationId:source.gstRegistrationId,terms:source.terms,
        customFields:{...source.customFields,sourceDocument:source.number},
        lines:selected.map(({line,qtyMilli})=>({stockItemId:line.stockItemId,description:line.description,qtyMilli,rate:line.rate,discountBps:line.discountBps,gstRate:line.gstRate,optional:line.optional,metadata:line.metadata}))
      },actor,source.id)
      const targetLines=targetDocument.lines
      const kind=source.kind==='quotation'?'allocation':'delivery'
      const link=db.prepare(`INSERT INTO sales_document_line_links(from_line_id,to_line_id,kind,qty_milli) VALUES(?,?,?,?)`)
      selected.forEach(({line,qtyMilli},index)=>link.run(line.id,targetLines[index]!.id,kind,qtyMilli))
      db.prepare(`INSERT INTO sales_document_conversions(from_document_id,to_document_id,created_by) VALUES(?,?,?)`).run(source.id,targetDocument!.id,actor)
    }
    refreshFulfilmentStatus(db,source.id)
  })()
  const refreshed=getSalesDocument(db,source.id)!
  const createdTargetId=(targetDocument as SalesDocument|null)?.id
  if(createdTargetId)targetDocument=getSalesDocument(db,createdTargetId)!
  writeAudit(db,'sales_document',source.id,'update',{status:source.status},{status:refreshed.status,convertedTo:targetDocument?.number??`draft:${invoiceDraftId}`})
  return {source:refreshed,targetDocument,invoiceDraftId}
}
