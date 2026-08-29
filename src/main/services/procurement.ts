import type { DB } from '../db/connection'
import type { GoodsReceipt, GoodsReceiptInput, InvoiceMatchCandidate, InvoiceMatchInput, InvoiceMatchPreview, ProcurementDebitNoteClaim, PurchaseOrder, PurchaseOrderInput, PurchaseRequisition, ReorderSuggestion, RequisitionInput, RequisitionStatus, SupplierComparisonRow, SupplierConcentrationReport, SupplierPriceHistoryRow } from '@shared/procurement'
import { IN_BOOKS, requireInBooksVoucher, saveVoucher } from './vouchers'
import { writeAudit } from './audit'
import { saveVoucherDraft } from './voucherDrafts'
import type { VoucherWorkDraft } from '@shared/voucherDrafts'
import { todayISO } from '@shared/dates'
import { stockSummary } from './reports'

function nextNumber(db: DB, table: 'purchase_requisitions' | 'purchase_orders' | 'goods_receipts', prefix: string): string {
  const row = db.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM ${table}`).get() as { n: number }
  return `${prefix}-${String(row.n).padStart(5, '0')}`
}
function assertLines(lines: { stockItemId: number; qtyMilli: number }[]): void {
  if (!lines.length) throw new Error('Add at least one item')
  if (new Set(lines.map((line) => line.stockItemId)).size !== lines.length) throw new Error('An item appears more than once')
  if (lines.some((line) => !Number.isInteger(line.qtyMilli) || line.qtyMilli <= 0)) throw new Error('Every quantity must be positive')
}

export function listRequisitions(db: DB): PurchaseRequisition[] {
  const heads = db.prepare('SELECT * FROM purchase_requisitions ORDER BY date DESC, id DESC').all() as any[]
  const lineStmt = db.prepare(`SELECT l.id, l.stock_item_id AS stockItemId, si.name AS itemName, u.symbol AS unitSymbol, l.qty_milli AS qtyMilli, l.note FROM purchase_requisition_lines l JOIN stock_items si ON si.id=l.stock_item_id JOIN units u ON u.id=si.unit_id WHERE l.requisition_id=? ORDER BY l.id`)
  return heads.map((r) => ({ id:r.id, number:r.number, date:r.date, neededBy:r.needed_by, department:r.department, note:r.note, status:r.status, requestedBy:r.requested_by, approvedBy:r.approved_by, approvalNote:r.approval_note, createdAt:r.created_at, updatedAt:r.updated_at, lines:lineStmt.all(r.id) })) as PurchaseRequisition[]
}
export function getRequisition(db: DB, id: number): PurchaseRequisition | null { return listRequisitions(db).find((row) => row.id === id) ?? null }
export function createRequisition(db: DB, input: RequisitionInput, author: string): PurchaseRequisition {
  assertLines(input.lines)
  return db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO purchase_requisitions (number,date,needed_by,department,note,requested_by) VALUES (?,?,?,?,?,?)`).run(nextNumber(db,'purchase_requisitions','PR'),input.date,input.neededBy,input.department?.trim()||null,input.note?.trim()||null,author).lastInsertRowid)
    const insert=db.prepare('INSERT INTO purchase_requisition_lines (requisition_id,stock_item_id,qty_milli,note) VALUES (?,?,?,?)')
    for(const line of input.lines) insert.run(id,line.stockItemId,line.qtyMilli,line.note?.trim()||null)
    writeAudit(db,'purchase_requisition',id,'create',null,{status:'draft'})
    return getRequisition(db,id)!
  })()
}
export function setRequisitionStatus(db: DB, id: number, status: Extract<RequisitionStatus,'submitted'|'approved'|'rejected'|'cancelled'>, author: string, note?: string | null): PurchaseRequisition {
  const row=getRequisition(db,id); if(!row) throw new Error('Purchase requisition was not found')
  const allowed:Record<string,string[]>={draft:['submitted','cancelled'],submitted:['approved','rejected','cancelled']}
  if(!allowed[row.status]?.includes(status)) throw new Error(`${row.number} cannot move from ${row.status} to ${status}`)
  if(status==='rejected' && (note?.trim().length??0)<3) throw new Error('Enter a rejection reason')
  db.prepare(`UPDATE purchase_requisitions SET status=?, approved_by=?, approval_note=?, updated_at=datetime('now') WHERE id=?`).run(status,status==='approved'||status==='rejected'?author:null,note?.trim()||null,id)
  writeAudit(db,'purchase_requisition',id,'update',{status:row.status},{status,by:author,note})
  return getRequisition(db,id)!
}

export function listPurchaseOrders(db: DB): PurchaseOrder[] {
  const heads=db.prepare(`SELECT po.*, l.name AS supplier_name FROM purchase_orders po JOIN ledgers l ON l.id=po.supplier_ledger_id ORDER BY po.date DESC,po.id DESC`).all() as any[]
  const lines=db.prepare(`SELECT pol.id,pol.stock_item_id AS stockItemId,si.name AS itemName,u.symbol AS unitSymbol,pol.qty_ordered_milli AS qtyOrderedMilli,pol.rate_paise AS ratePaise,pol.gst_rate AS gstRate,COALESCE(SUM(CASE WHEN gr.status='posted' THEN grl.qty_received_milli ELSE 0 END),0) AS qtyReceivedMilli,COALESCE(SUM(CASE WHEN gr.status='posted' THEN grl.qty_accepted_milli ELSE 0 END),0) AS qtyAcceptedMilli,COALESCE(SUM(CASE WHEN gr.status='posted' THEN grl.qty_rejected_milli ELSE 0 END),0) AS qtyRejectedMilli,COALESCE((SELECT SUM(piml.invoiced_qty_milli) FROM purchase_invoice_match_lines piml JOIN purchase_invoice_matches pim ON pim.id=piml.match_id WHERE piml.purchase_order_line_id=pol.id),0) AS qtyBilledMilli FROM purchase_order_lines pol JOIN stock_items si ON si.id=pol.stock_item_id JOIN units u ON u.id=si.unit_id LEFT JOIN goods_receipt_lines grl ON grl.purchase_order_line_id=pol.id LEFT JOIN goods_receipts gr ON gr.id=grl.goods_receipt_id WHERE pol.purchase_order_id=? GROUP BY pol.id ORDER BY pol.id`)
  return heads.map((r)=>({id:r.id,number:r.number,date:r.date,expectedDate:r.expected_date,supplierLedgerId:r.supplier_ledger_id,supplierName:r.supplier_name,requisitionId:r.requisition_id,status:r.status,note:r.note,createdBy:r.created_by,createdAt:r.created_at,updatedAt:r.updated_at,lines:(lines.all(r.id) as any[]).map((l)=>({...l,outstandingQtyMilli:Math.max(0,l.qtyOrderedMilli-l.qtyAcceptedMilli),outstandingBillQtyMilli:Math.max(0,l.qtyAcceptedMilli-l.qtyBilledMilli)}))})) as PurchaseOrder[]
}
export function getPurchaseOrder(db: DB,id:number):PurchaseOrder|null{return listPurchaseOrders(db).find((row)=>row.id===id)??null}
export function createPurchaseOrder(db: DB,input:PurchaseOrderInput,author:string):PurchaseOrder{
  assertLines(input.lines); if(input.lines.some((line)=>line.ratePaise<0||line.gstRate<0||line.gstRate>100)) throw new Error('Rates or GST are invalid')
  const supplier=db.prepare('SELECT 1 FROM ledgers WHERE id=?').get(input.supplierLedgerId); if(!supplier) throw new Error('Supplier ledger was not found')
  return db.transaction(()=>{ if(input.requisitionId){const req=getRequisition(db,input.requisitionId);if(!req||req.status!=='approved')throw new Error('Only an approved requisition can be converted')}
    const id=Number(db.prepare(`INSERT INTO purchase_orders(number,date,expected_date,supplier_ledger_id,requisition_id,note,created_by) VALUES(?,?,?,?,?,?,?)`).run(nextNumber(db,'purchase_orders','PO'),input.date,input.expectedDate,input.supplierLedgerId,input.requisitionId,input.note?.trim()||null,author).lastInsertRowid)
    const ins=db.prepare('INSERT INTO purchase_order_lines(purchase_order_id,stock_item_id,qty_ordered_milli,rate_paise,gst_rate) VALUES(?,?,?,?,?)');for(const l of input.lines)ins.run(id,l.stockItemId,l.qtyMilli,l.ratePaise,l.gstRate)
    if(input.requisitionId)db.prepare("UPDATE purchase_requisitions SET status='converted',updated_at=datetime('now') WHERE id=?").run(input.requisitionId)
    writeAudit(db,'purchase_order',id,'create',null,{supplierLedgerId:input.supplierLedgerId,requisitionId:input.requisitionId});return getPurchaseOrder(db,id)!
  })()
}
export function setPurchaseOrderStatus(db:DB,id:number,status:'issued'|'closed'|'cancelled',author:string):PurchaseOrder{const row=getPurchaseOrder(db,id);if(!row)throw new Error('Purchase order was not found');if(status==='issued'&&row.status!=='draft')throw new Error('Only a draft order can be issued');if(status!=='issued'&&!['draft','issued','part_received','received'].includes(row.status))throw new Error(`${row.number} cannot be ${status}`);db.prepare("UPDATE purchase_orders SET status=?,updated_at=datetime('now') WHERE id=?").run(status,id);writeAudit(db,'purchase_order',id,'update',{status:row.status},{status,by:author});return getPurchaseOrder(db,id)!}

export function listGoodsReceipts(db:DB):GoodsReceipt[]{const heads=db.prepare(`SELECT gr.*,po.number AS purchase_order_number FROM goods_receipts gr JOIN purchase_orders po ON po.id=gr.purchase_order_id ORDER BY gr.date DESC,gr.id DESC`).all() as any[];const lines=db.prepare(`SELECT grl.id,grl.purchase_order_line_id AS purchaseOrderLineId,pol.stock_item_id AS stockItemId,si.name AS itemName,u.symbol AS unitSymbol,grl.qty_received_milli AS qtyReceivedMilli,grl.qty_accepted_milli AS qtyAcceptedMilli,grl.qty_rejected_milli AS qtyRejectedMilli FROM goods_receipt_lines grl JOIN purchase_order_lines pol ON pol.id=grl.purchase_order_line_id JOIN stock_items si ON si.id=pol.stock_item_id JOIN units u ON u.id=si.unit_id WHERE grl.goods_receipt_id=? ORDER BY grl.id`);return heads.map((r)=>({id:r.id,number:r.number,purchaseOrderId:r.purchase_order_id,purchaseOrderNumber:r.purchase_order_number,date:r.date,status:r.status,note:r.note,inventoryVoucherId:r.inventory_voucher_id,receivedBy:r.received_by,createdAt:r.created_at,lines:lines.all(r.id)})) as GoodsReceipt[]}
export function createGoodsReceipt(db:DB,input:GoodsReceiptInput,author:string):GoodsReceipt{return db.transaction(()=>{const po=getPurchaseOrder(db,input.purchaseOrderId);if(!po||!['issued','part_received'].includes(po.status))throw new Error('Only an issued order can receive goods');if(!input.lines.length)throw new Error('Receive at least one item');const byId=new Map(po.lines.map((l)=>[l.id,l]));for(const l of input.lines){const order=byId.get(l.purchaseOrderLineId);if(!order)throw new Error('A receipt line does not belong to this order');if(l.qtyReceivedMilli<=0||l.qtyAcceptedMilli<0||l.qtyRejectedMilli<0||l.qtyAcceptedMilli+l.qtyRejectedMilli!==l.qtyReceivedMilli)throw new Error('Received quantity must equal accepted plus rejected');if(l.qtyAcceptedMilli>order.outstandingQtyMilli)throw new Error(`${order.itemName} exceeds the outstanding order quantity`)}if(input.lines.reduce((s,l)=>s+l.qtyAcceptedMilli,0)<=0)throw new Error('At least one accepted quantity is required')
  const stockType=db.prepare("SELECT id FROM voucher_types WHERE kind='stock_journal' ORDER BY is_system DESC,id LIMIT 1").get() as {id:number}|undefined;if(!stockType)throw new Error('Stock Journal voucher type was not found')
  const voucher=saveVoucher(db,{voucherTypeId:stockType.id,date:input.date,partyLedgerId:null,narration:`Goods receipt against ${po.number}`,reference:po.number,instrumentNo:null,instrumentDate:null,transporterId:null,vehicleNo:null,transportDistanceKm:null,posOverride:null,currencyCode:null,exchangeRate:null,lines:[],inventory:input.lines.filter((l)=>l.qtyAcceptedMilli>0).map((l)=>{const order=byId.get(l.purchaseOrderLineId)!;return{stockItemId:order.stockItemId,godownId:null,qtyMilli:l.qtyAcceptedMilli,ratePaise:order.ratePaise,amount:Math.round(l.qtyAcceptedMilli*order.ratePaise/1000),direction:'in' as const}}),billRefs:[],tds:null})
  const id=Number(db.prepare(`INSERT INTO goods_receipts(number,purchase_order_id,date,note,inventory_voucher_id,received_by) VALUES(?,?,?,?,?,?)`).run(nextNumber(db,'goods_receipts','GRN'),po.id,input.date,input.note?.trim()||null,voucher.id,author).lastInsertRowid);const ins=db.prepare(`INSERT INTO goods_receipt_lines(goods_receipt_id,purchase_order_line_id,qty_received_milli,qty_accepted_milli,qty_rejected_milli) VALUES(?,?,?,?,?)`);for(const l of input.lines)ins.run(id,l.purchaseOrderLineId,l.qtyReceivedMilli,l.qtyAcceptedMilli,l.qtyRejectedMilli)
  const refreshed=getPurchaseOrder(db,po.id)!;const next=refreshed.lines.every((l)=>l.outstandingQtyMilli===0)?'received':'part_received';db.prepare("UPDATE purchase_orders SET status=?,updated_at=datetime('now') WHERE id=?").run(next,po.id);writeAudit(db,'goods_receipt',id,'create',null,{purchaseOrderId:po.id,inventoryVoucherId:voucher.id});return listGoodsReceipts(db).find((r)=>r.id===id)!
})()}

export function listInvoiceMatchCandidates(db: DB, supplierLedgerId?: number): InvoiceMatchCandidate[] {
  const params: number[] = []
  const supplierWhere = supplierLedgerId ? 'AND po.supplier_ledger_id = ?' : ''
  if (supplierLedgerId) params.push(supplierLedgerId)
  const heads = db.prepare(`
    SELECT gr.id AS goodsReceiptId, gr.number AS goodsReceiptNumber, gr.date AS goodsReceiptDate,
           po.id AS purchaseOrderId, po.number AS purchaseOrderNumber,
           po.supplier_ledger_id AS supplierLedgerId, supplier.name AS supplierName
    FROM goods_receipts gr
    JOIN purchase_orders po ON po.id = gr.purchase_order_id
    JOIN ledgers supplier ON supplier.id = po.supplier_ledger_id
    LEFT JOIN purchase_invoice_matches pim ON pim.goods_receipt_id = gr.id
    WHERE gr.status = 'posted' AND pim.id IS NULL ${supplierWhere}
    ORDER BY gr.date DESC, gr.id DESC
  `).all(...params) as Omit<InvoiceMatchCandidate, 'lines'>[]
  const lines = db.prepare(`
    SELECT pol.id AS purchaseOrderLineId, pol.stock_item_id AS stockItemId,
           si.name AS itemName, u.symbol AS unitSymbol,
           pol.qty_ordered_milli AS orderedQtyMilli, grl.qty_accepted_milli AS acceptedQtyMilli,
           pol.rate_paise AS poRatePaise, pol.gst_rate AS gstRate
    FROM goods_receipt_lines grl
    JOIN purchase_order_lines pol ON pol.id = grl.purchase_order_line_id
    JOIN stock_items si ON si.id = pol.stock_item_id
    JOIN units u ON u.id = si.unit_id
    WHERE grl.goods_receipt_id = ? AND grl.qty_accepted_milli > 0
    ORDER BY grl.id
  `)
  return heads.map((head) => ({ ...head, lines: lines.all(head.goodsReceiptId) as InvoiceMatchCandidate['lines'] }))
}

export function previewInvoiceMatch(db: DB, input: InvoiceMatchInput): InvoiceMatchPreview {
  const candidate = listInvoiceMatchCandidates(db).find((row) => row.goodsReceiptId === input.goodsReceiptId)
  if (!candidate) throw new Error('This goods receipt is unavailable or already matched')
  if (!input.lines.length) throw new Error('Add invoice item lines before matching')
  if (new Set(input.lines.map((line) => line.stockItemId)).size !== input.lines.length) throw new Error('An invoice item appears more than once')
  const invoiceByItem = new Map(input.lines.map((line) => [line.stockItemId, line]))
  if (candidate.lines.length !== input.lines.length || candidate.lines.some((line) => !invoiceByItem.has(line.stockItemId))) {
    throw new Error('Invoice items must correspond to every accepted item on the goods receipt')
  }
  const lines = candidate.lines.map((received) => {
    const invoice = invoiceByItem.get(received.stockItemId)!
    if (!Number.isInteger(invoice.qtyMilli) || invoice.qtyMilli <= 0 || !Number.isInteger(invoice.ratePaise) || invoice.ratePaise < 0 || !Number.isInteger(invoice.amount) || invoice.amount < 0) throw new Error('Invoice quantities, rates or values are invalid')
    return {
      ...invoice,
      itemName: received.itemName,
      unitSymbol: received.unitSymbol,
      orderedQtyMilli: received.orderedQtyMilli,
      acceptedQtyMilli: received.acceptedQtyMilli,
      poRatePaise: received.poRatePaise,
      quantityVarianceMilli: invoice.qtyMilli - received.acceptedQtyMilli,
      rateVariancePaise: invoice.ratePaise - received.poRatePaise
    }
  })
  const quantityVarianceCount = lines.filter((line) => line.quantityVarianceMilli !== 0).length
  const rateVarianceCount = lines.filter((line) => line.rateVariancePaise !== 0).length
  return {
    goodsReceiptId: candidate.goodsReceiptId,
    goodsReceiptNumber: candidate.goodsReceiptNumber,
    purchaseOrderId: candidate.purchaseOrderId,
    purchaseOrderNumber: candidate.purchaseOrderNumber,
    supplierLedgerId: candidate.supplierLedgerId,
    supplierName: candidate.supplierName,
    status: quantityVarianceCount || rateVarianceCount ? 'variance' : 'exact',
    quantityVarianceCount,
    rateVarianceCount,
    lines
  }
}

export function recordInvoiceMatch(db: DB, voucherId: number, input: InvoiceMatchInput, author: string): InvoiceMatchPreview {
  const preview = previewInvoiceMatch(db, input)
  const activeVoucher = requireInBooksVoucher(db, voucherId, ['purchase'])
  const voucher = db.prepare(`
    SELECT v.party_ledger_id AS partyLedgerId,
           (SELECT COUNT(*) FROM inventory_lines il WHERE il.voucher_id = v.id) AS inventoryLines
    FROM vouchers v WHERE v.id = ?
  `).get(voucherId) as { partyLedgerId: number | null; inventoryLines: number }
  if (activeVoucher.partyLedgerId !== preview.supplierLedgerId || voucher.partyLedgerId !== preview.supplierLedgerId) throw new Error('Invoice supplier does not match the purchase order supplier')
  if (voucher.inventoryLines !== 0) throw new Error('Matched invoice must not post stock already received by the GRN')
  const matchId = Number(db.prepare(`
    INSERT INTO purchase_invoice_matches
      (voucher_id, purchase_order_id, goods_receipt_id, status, quantity_variance_count, rate_variance_count, matched_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(voucherId, preview.purchaseOrderId, preview.goodsReceiptId, preview.status, preview.quantityVarianceCount, preview.rateVarianceCount, author).lastInsertRowid)
  const poLineByItem = new Map(listInvoiceMatchCandidates(db).find((row) => row.goodsReceiptId === preview.goodsReceiptId)?.lines.map((line) => [line.stockItemId, line]) ?? [])
  // The candidate is no longer returned after inserting the header; use the preview plus the PO
  // line lookup directly for the immutable snapshots.
  const poLines = db.prepare('SELECT id, stock_item_id AS stockItemId FROM purchase_order_lines WHERE purchase_order_id = ?').all(preview.purchaseOrderId) as { id: number; stockItemId: number }[]
  const poLineIdByItem = new Map(poLines.map((line) => [line.stockItemId, line.id]))
  const insert = db.prepare(`
    INSERT INTO purchase_invoice_match_lines
      (match_id, purchase_order_line_id, stock_item_id, ordered_qty_milli, accepted_qty_milli,
       invoiced_qty_milli, po_rate_paise, invoice_rate_paise, invoice_amount, gst_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const line of preview.lines) {
    const poLineId = poLineIdByItem.get(line.stockItemId) ?? poLineByItem.get(line.stockItemId)?.purchaseOrderLineId
    if (!poLineId) throw new Error('Purchase order line was not found')
    insert.run(matchId, poLineId, line.stockItemId, line.orderedQtyMilli, line.acceptedQtyMilli, line.qtyMilli, line.poRatePaise, line.ratePaise, line.amount, line.gstRate)
  }
  writeAudit(db, 'purchase_invoice_match', matchId, 'create', null, { voucherId, goodsReceiptId: preview.goodsReceiptId, status: preview.status })
  return preview
}

export function supplierPriceHistory(db: DB, stockItemIds: number[], supplierLedgerId?: number): SupplierPriceHistoryRow[] {
  const ids = [...new Set(stockItemIds)].filter((id) => Number.isInteger(id) && id > 0).slice(0, 100)
  if (!ids.length) return []
  const marks = ids.map(() => '?').join(',')
  const supplierClause = supplierLedgerId ? 'AND supplier_id = ?' : ''
  const params = supplierLedgerId ? [...ids, ...ids, supplierLedgerId] : [...ids, ...ids]
  return db.prepare(`
    SELECT stock_item_id AS stockItemId, item_name AS itemName,
           supplier_id AS supplierLedgerId, supplier_name AS supplierName,
           date, voucher_id AS voucherId, voucher_number AS voucherNumber,
           qty_milli AS qtyMilli, rate_paise AS ratePaise, source
    FROM (
      SELECT il.stock_item_id, si.name AS item_name, v.party_ledger_id AS supplier_id,
             supplier.name AS supplier_name, v.date, v.id AS voucher_id, v.number AS voucher_number,
             il.qty_milli, il.rate_paise, 'purchase_invoice' AS source
      FROM inventory_lines il
      JOIN vouchers v ON v.id = il.voucher_id
      JOIN voucher_types vt ON vt.id = v.voucher_type_id AND vt.kind = 'purchase'
      JOIN stock_items si ON si.id = il.stock_item_id
      JOIN ledgers supplier ON supplier.id = v.party_ledger_id
      WHERE il.stock_item_id IN (${marks}) AND il.direction = 'in' AND ${IN_BOOKS}
      UNION ALL
      SELECT piml.stock_item_id, si.name, v.party_ledger_id, supplier.name, v.date, v.id, v.number,
             piml.invoiced_qty_milli, piml.invoice_rate_paise, 'matched_invoice'
      FROM purchase_invoice_match_lines piml
      JOIN purchase_invoice_matches pim ON pim.id = piml.match_id
      JOIN vouchers v ON v.id = pim.voucher_id
      JOIN stock_items si ON si.id = piml.stock_item_id
      JOIN ledgers supplier ON supplier.id = v.party_ledger_id
      WHERE piml.stock_item_id IN (${marks}) AND ${IN_BOOKS}
    ) history
    WHERE 1=1 ${supplierClause}
    ORDER BY date DESC, voucher_id DESC
    LIMIT 500
  `).all(...params) as SupplierPriceHistoryRow[]
}

export function compareSuppliers(db: DB, stockItemId: number): SupplierComparisonRow[] {
  const rows = db.prepare(`
    SELECT po.supplier_ledger_id AS supplierLedgerId, supplier.name AS supplierName,
           supplier.credit_days AS creditDays,
           pol.rate_paise AS ratePaise, pol.gst_rate AS gstRate,
           po.id AS orderId, po.date AS orderDate, po.expected_date AS expectedDate,
           pol.qty_ordered_milli AS orderedQtyMilli,
           COALESCE(SUM(CASE WHEN gr.status='posted' THEN grl.qty_accepted_milli ELSE 0 END),0) AS acceptedQtyMilli,
           COALESCE(SUM(CASE WHEN gr.status='posted' THEN grl.qty_rejected_milli ELSE 0 END),0) AS rejectedQtyMilli,
           MIN(CASE WHEN gr.status='posted' THEN gr.date END) AS firstReceiptDate
    FROM purchase_order_lines pol
    JOIN purchase_orders po ON po.id=pol.purchase_order_id
    JOIN ledgers supplier ON supplier.id=po.supplier_ledger_id
    LEFT JOIN goods_receipt_lines grl ON grl.purchase_order_line_id=pol.id
    LEFT JOIN goods_receipts gr ON gr.id=grl.goods_receipt_id
    WHERE pol.stock_item_id=? AND po.status <> 'cancelled'
    GROUP BY pol.id
    ORDER BY po.date DESC, po.id DESC
  `).all(stockItemId) as { supplierLedgerId:number; supplierName:string; creditDays:number|null; ratePaise:number; gstRate:number; orderId:number; orderDate:string; expectedDate:string|null; orderedQtyMilli:number; acceptedQtyMilli:number; rejectedQtyMilli:number; firstReceiptDate:string|null }[]
  const groups = new Map<number, typeof rows>()
  for (const row of rows) groups.set(row.supplierLedgerId, [...(groups.get(row.supplierLedgerId) ?? []), row])
  return [...groups.values()].map((orders) => {
    const latest = orders[0]!
    const orderedQtyMilli = orders.reduce((sum, row) => sum + row.orderedQtyMilli, 0)
    const acceptedQtyMilli = orders.reduce((sum, row) => sum + row.acceptedQtyMilli, 0)
    const rejectedQtyMilli = orders.reduce((sum, row) => sum + row.rejectedQtyMilli, 0)
    const delivered = orders.filter((row) => row.firstReceiptDate)
    const onTime = delivered.filter((row) => !row.expectedDate || row.firstReceiptDate! <= row.expectedDate).length
    const leadDays = delivered.map((row) => Math.max(0, Math.round((Date.parse(row.firstReceiptDate!) - Date.parse(row.orderDate)) / 86_400_000)))
    return {
      supplierLedgerId: latest.supplierLedgerId,
      supplierName: latest.supplierName,
      creditDays: latest.creditDays,
      lastRatePaise: latest.ratePaise,
      effectiveRateIncTaxPaise: Math.round(latest.ratePaise * (1 + latest.gstRate / 100)),
      weightedAverageRatePaise: orderedQtyMilli ? Math.round(orders.reduce((sum, row) => sum + row.ratePaise * row.orderedQtyMilli, 0) / orderedQtyMilli) : latest.ratePaise,
      orderCount: orders.length,
      orderedQtyMilli,
      acceptedQtyMilli,
      rejectedQtyMilli,
      rejectionRate: acceptedQtyMilli + rejectedQtyMilli ? rejectedQtyMilli / (acceptedQtyMilli + rejectedQtyMilli) * 100 : 0,
      onTimeDeliveryRate: delivered.length ? onTime / delivered.length * 100 : null,
      averageLeadDays: leadDays.length ? leadDays.reduce((sum, value) => sum + value, 0) / leadDays.length : null
    }
  }).sort((a, b) => a.effectiveRateIncTaxPaise - b.effectiveRateIncTaxPaise || b.onTimeDeliveryRate! - a.onTimeDeliveryRate!)
}

export function listDebitNoteClaims(db: DB): ProcurementDebitNoteClaim[] {
  const claims: ProcurementDebitNoteClaim[] = []
  const linked = new Set((db.prepare('SELECT source_key AS sourceKey FROM procurement_debit_note_links').all() as { sourceKey:string }[]).map((row) => row.sourceKey))
  const rejectionHeads = db.prepare(`SELECT gr.id,gr.number,po.id AS purchaseOrderId,po.number AS purchaseOrderNumber,po.supplier_ledger_id AS supplierLedgerId,s.name AS supplierName FROM goods_receipts gr JOIN purchase_orders po ON po.id=gr.purchase_order_id JOIN ledgers s ON s.id=po.supplier_ledger_id WHERE gr.status='posted' AND EXISTS(SELECT 1 FROM goods_receipt_lines x WHERE x.goods_receipt_id=gr.id AND x.qty_rejected_milli>0) ORDER BY gr.date DESC,gr.id DESC`).all() as {id:number;number:string;purchaseOrderId:number;purchaseOrderNumber:string;supplierLedgerId:number;supplierName:string}[]
  const rejectionLines = db.prepare(`SELECT pol.stock_item_id AS stockItemId,si.name AS itemName,grl.qty_rejected_milli AS qtyMilli,pol.rate_paise AS ratePaise,pol.gst_rate AS gstRate FROM goods_receipt_lines grl JOIN purchase_order_lines pol ON pol.id=grl.purchase_order_line_id JOIN stock_items si ON si.id=pol.stock_item_id WHERE grl.goods_receipt_id=? AND grl.qty_rejected_milli>0`)
  for (const head of rejectionHeads) {
    const sourceKey=`rejection:${head.id}`; if(linked.has(sourceKey)) continue
    const lines=rejectionLines.all(head.id) as ProcurementDebitNoteClaim['lines']; const amount=lines.reduce((sum,line)=>sum+Math.round(line.qtyMilli*line.ratePaise/1000),0); if(amount<=0)continue
    claims.push({sourceKey,reason:'rejection',purchaseOrderId:head.purchaseOrderId,purchaseOrderNumber:head.purchaseOrderNumber,goodsReceiptId:head.id,goodsReceiptNumber:head.number,invoiceMatchId:null,supplierLedgerId:head.supplierLedgerId,supplierName:head.supplierName,amount,detail:`Rejected quantity recorded on ${head.number}`,lines})
  }
  const shortageHeads=db.prepare(`SELECT po.id,po.number,po.supplier_ledger_id AS supplierLedgerId,s.name AS supplierName FROM purchase_orders po JOIN ledgers s ON s.id=po.supplier_ledger_id WHERE po.status='closed' ORDER BY po.date DESC,po.id DESC`).all() as {id:number;number:string;supplierLedgerId:number;supplierName:string}[]
  const shortageLines=db.prepare(`SELECT pol.stock_item_id AS stockItemId,si.name AS itemName,MAX(0,pol.qty_ordered_milli-COALESCE(SUM(CASE WHEN gr.status='posted' THEN grl.qty_accepted_milli ELSE 0 END),0)) AS qtyMilli,pol.rate_paise AS ratePaise,pol.gst_rate AS gstRate FROM purchase_order_lines pol JOIN stock_items si ON si.id=pol.stock_item_id LEFT JOIN goods_receipt_lines grl ON grl.purchase_order_line_id=pol.id LEFT JOIN goods_receipts gr ON gr.id=grl.goods_receipt_id WHERE pol.purchase_order_id=? GROUP BY pol.id HAVING qtyMilli>0`)
  for(const head of shortageHeads){const sourceKey=`shortage:${head.id}`;if(linked.has(sourceKey))continue;const lines=shortageLines.all(head.id) as ProcurementDebitNoteClaim['lines'];const amount=lines.reduce((sum,line)=>sum+Math.round(line.qtyMilli*line.ratePaise/1000),0);if(amount<=0)continue;claims.push({sourceKey,reason:'shortage',purchaseOrderId:head.id,purchaseOrderNumber:head.number,goodsReceiptId:null,goodsReceiptNumber:null,invoiceMatchId:null,supplierLedgerId:head.supplierLedgerId,supplierName:head.supplierName,amount,detail:'Order closed below the ordered quantity',lines})}
  const rateHeads=db.prepare(`SELECT pim.id,pim.purchase_order_id AS purchaseOrderId,po.number AS purchaseOrderNumber,pim.goods_receipt_id AS goodsReceiptId,gr.number AS goodsReceiptNumber,po.supplier_ledger_id AS supplierLedgerId,s.name AS supplierName FROM purchase_invoice_matches pim JOIN vouchers v ON v.id=pim.voucher_id JOIN purchase_orders po ON po.id=pim.purchase_order_id JOIN goods_receipts gr ON gr.id=pim.goods_receipt_id JOIN ledgers s ON s.id=po.supplier_ledger_id WHERE pim.rate_variance_count>0 AND ${IN_BOOKS} ORDER BY pim.matched_at DESC,pim.id DESC`).all() as {id:number;purchaseOrderId:number;purchaseOrderNumber:string;goodsReceiptId:number;goodsReceiptNumber:string;supplierLedgerId:number;supplierName:string}[]
  const rateLines=db.prepare(`SELECT piml.stock_item_id AS stockItemId,si.name AS itemName,piml.invoiced_qty_milli AS qtyMilli,(piml.invoice_rate_paise-piml.po_rate_paise) AS ratePaise,piml.gst_rate AS gstRate FROM purchase_invoice_match_lines piml JOIN stock_items si ON si.id=piml.stock_item_id WHERE piml.match_id=? AND piml.invoice_rate_paise>piml.po_rate_paise`)
  for(const head of rateHeads){const sourceKey=`rate_difference:${head.id}`;if(linked.has(sourceKey))continue;const lines=rateLines.all(head.id) as ProcurementDebitNoteClaim['lines'];const amount=lines.reduce((sum,line)=>sum+Math.round(line.qtyMilli*line.ratePaise/1000),0);if(amount<=0)continue;claims.push({sourceKey,reason:'rate_difference',purchaseOrderId:head.purchaseOrderId,purchaseOrderNumber:head.purchaseOrderNumber,goodsReceiptId:head.goodsReceiptId,goodsReceiptNumber:head.goodsReceiptNumber,invoiceMatchId:head.id,supplierLedgerId:head.supplierLedgerId,supplierName:head.supplierName,amount,detail:`Invoice rate exceeded ${head.purchaseOrderNumber}`,lines})}
  return claims.sort((a,b)=>b.amount-a.amount)
}

export function createDebitNoteDraft(db: DB, sourceKey: string, author: string): VoucherWorkDraft {
  const claim=listDebitNoteClaims(db).find((row)=>row.sourceKey===sourceKey);if(!claim)throw new Error('This procurement claim is unavailable or already linked')
  const type=db.prepare("SELECT id FROM voucher_types WHERE kind='debit_note' ORDER BY is_system DESC,id LIMIT 1").get() as {id:number}|undefined;if(!type)throw new Error('Debit Note voucher type was not found')
  const date=todayISO()
  return saveVoucherDraft(db,{voucherTypeId:type.id,mode:'invoice',title:`Debit note · ${claim.purchaseOrderNumber}`,payloadVersion:1,payload:{date,number:'',partyId:claim.supplierLedgerId,accountId:null,rows:claim.lines.map((line)=>({itemId:line.stockItemId,qtyText:String(line.qtyMilli/1000),rate:line.ratePaise,discount:null})),narration:`${claim.detail} · ${claim.purchaseOrderNumber}${claim.goodsReceiptNumber?` / ${claim.goodsReceiptNumber}`:''}`,vehicleNo:'',transporterId:'',distanceKm:'',currencyCode:'',fxRateText:'',posOverride:null,optionalVoucher:false,billName:'',billDueDate:date,billNameTouched:false,billDueDateTouched:false,manualNewBillMode:false,noteBillRefs:[],procurementClaimKey:sourceKey}},author)
}

export function recordDebitNoteLink(db:DB,voucherId:number,sourceKey:string,author:string):void{
  const claim=listDebitNoteClaims(db).find((row)=>row.sourceKey===sourceKey);if(!claim)throw new Error('This procurement claim is unavailable or already linked')
  requireInBooksVoucher(db,voucherId,['debit_note'])
  const voucher=db.prepare(`SELECT v.party_ledger_id AS partyLedgerId,vt.kind,(SELECT COUNT(*) FROM inventory_lines il WHERE il.voucher_id=v.id) AS inventoryLines FROM vouchers v JOIN voucher_types vt ON vt.id=v.voucher_type_id WHERE v.id=?`).get(voucherId) as {partyLedgerId:number|null;kind:string;inventoryLines:number}|undefined
  if(!voucher||voucher.kind!=='debit_note')throw new Error('Only a posted debit note can settle a procurement claim');if(voucher.partyLedgerId!==claim.supplierLedgerId)throw new Error('Debit note supplier does not match the claim');if(voucher.inventoryLines)throw new Error('Procurement claim debit notes must not move stock')
  const id=Number(db.prepare(`INSERT INTO procurement_debit_note_links(voucher_id,source_key,purchase_order_id,goods_receipt_id,invoice_match_id,reason,claimed_amount,created_by) VALUES(?,?,?,?,?,?,?,?)`).run(voucherId,sourceKey,claim.purchaseOrderId,claim.goodsReceiptId,claim.invoiceMatchId,claim.reason,claim.amount,author).lastInsertRowid);writeAudit(db,'procurement_debit_note',id,'create',null,{voucherId,sourceKey,amount:claim.amount})
}

export function supplierConcentration(db:DB,from:string,to:string):SupplierConcentrationReport{
  const spend=db.prepare(`SELECT v.party_ledger_id AS supplierLedgerId,l.name AS supplierName,SUM(vl.amount) AS purchaseAmount FROM vouchers v JOIN voucher_types vt ON vt.id=v.voucher_type_id AND vt.kind='purchase' JOIN ledgers l ON l.id=v.party_ledger_id JOIN voucher_lines vl ON vl.voucher_id=v.id AND vl.ledger_id=v.party_ledger_id AND vl.dr_cr='cr' WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS} GROUP BY v.party_ledger_id ORDER BY purchaseAmount DESC`).all(from,to) as {supplierLedgerId:number;supplierName:string;purchaseAmount:number}[]
  const totalPurchases=spend.reduce((sum,row)=>sum+row.purchaseAmount,0)
  const sole=db.prepare(`SELECT supplier_ledger_id AS supplierLedgerId,COUNT(*) AS count FROM (SELECT pol.stock_item_id,MIN(po.supplier_ledger_id) AS supplier_ledger_id FROM purchase_order_lines pol JOIN purchase_orders po ON po.id=pol.purchase_order_id WHERE po.status<>'cancelled' GROUP BY pol.stock_item_id HAVING COUNT(DISTINCT po.supplier_ledger_id)=1) GROUP BY supplier_ledger_id`).all() as {supplierLedgerId:number;count:number}[]
  const soleMap=new Map(sole.map((row)=>[row.supplierLedgerId,row.count]));const categoryStmt=db.prepare(`SELECT DISTINCT COALESCE(sg.name,'Uncategorised') AS name FROM purchase_order_lines pol JOIN purchase_orders po ON po.id=pol.purchase_order_id JOIN stock_items si ON si.id=pol.stock_item_id LEFT JOIN stock_groups sg ON sg.id=si.group_id WHERE po.supplier_ledger_id=? AND po.status<>'cancelled' ORDER BY name LIMIT 8`)
  return{totalPurchases,rows:spend.map((row)=>{const sharePercent=totalPurchases?row.purchaseAmount/totalPurchases*100:0;const soleSourcedItemCount=soleMap.get(row.supplierLedgerId)??0;return{...row,sharePercent,soleSourcedItemCount,categories:(categoryStmt.all(row.supplierLedgerId) as {name:string}[]).map((category)=>category.name),risk:sharePercent>=40||soleSourcedItemCount>=5?'high' as const:sharePercent>=20||soleSourcedItemCount>0?'watch' as const:'diversified' as const}})}
}

export function reorderSuggestions(db:DB,asOn:string):ReorderSuggestion[]{
  const balances=new Map(stockSummary(db,asOn).map((row)=>[row.stockItemId,row]));const items=db.prepare(`SELECT si.id,si.name,si.reorder_level_milli AS reorderLevelMilli,COALESCE(si.gst_rate,0) AS gstRate,u.symbol AS unitSymbol FROM stock_items si JOIN units u ON u.id=si.unit_id WHERE si.reorder_level_milli IS NOT NULL AND si.reorder_level_milli>0 ORDER BY si.name`).all() as {id:number;name:string;reorderLevelMilli:number;gstRate:number;unitSymbol:string}[]
  const last=db.prepare(`SELECT po.supplier_ledger_id AS supplierLedgerId,l.name AS supplierName,pol.rate_paise AS ratePaise FROM purchase_order_lines pol JOIN purchase_orders po ON po.id=pol.purchase_order_id JOIN ledgers l ON l.id=po.supplier_ledger_id WHERE pol.stock_item_id=? AND po.status<>'cancelled' ORDER BY po.date DESC,po.id DESC LIMIT 1`)
  return items.flatMap((item)=>{const closingQtyMilli=balances.get(item.id)?.closingQtyMilli??0;if(closingQtyMilli>=item.reorderLevelMilli)return[];const supplier=last.get(item.id) as {supplierLedgerId:number;supplierName:string;ratePaise:number}|undefined;return[{stockItemId:item.id,itemName:item.name,unitSymbol:item.unitSymbol,closingQtyMilli,reorderLevelMilli:item.reorderLevelMilli,suggestedQtyMilli:Math.max(1000,item.reorderLevelMilli-closingQtyMilli),supplierLedgerId:supplier?.supplierLedgerId??null,supplierName:supplier?.supplierName??null,lastRatePaise:supplier?.ratePaise??null,gstRate:item.gstRate}]})
}

export function createReorderPurchaseOrders(db:DB,asOn:string,stockItemIds:number[],author:string):PurchaseOrder[]{
  const selected=new Set(stockItemIds);const suggestions=reorderSuggestions(db,asOn).filter((row)=>selected.has(row.stockItemId));if(!suggestions.length)throw new Error('Choose at least one current reorder suggestion');if(suggestions.some((row)=>!row.supplierLedgerId||row.lastRatePaise==null))throw new Error('Every selected item needs purchase-order history to identify its supplier and rate')
  const groups=new Map<number,typeof suggestions>();for(const row of suggestions){const id=row.supplierLedgerId!;groups.set(id,[...(groups.get(id)??[]),row])}
  return db.transaction(()=>[...groups.entries()].map(([supplierLedgerId,rows])=>createPurchaseOrder(db,{date:asOn,expectedDate:null,supplierLedgerId,requisitionId:null,note:'Owner-approved reorder suggestions',lines:rows.map((row)=>({stockItemId:row.stockItemId,qtyMilli:row.suggestedQtyMilli,ratePaise:row.lastRatePaise!,gstRate:row.gstRate}))},author)))()
}
