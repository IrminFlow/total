import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import { compareSuppliers, createDebitNoteDraft, createGoodsReceipt, createPurchaseOrder, createReorderPurchaseOrders, createRequisition, getPurchaseOrder, getRequisition, listDebitNoteClaims, listGoodsReceipts, listInvoiceMatchCandidates, previewInvoiceMatch, recordDebitNoteLink, recordInvoiceMatch, reorderSuggestions, setPurchaseOrderStatus, setRequisitionStatus, supplierConcentration, supplierPriceHistory } from './procurement'
import { stockSummary } from './reports'
import { deleteVoucher, saveVoucher } from './vouchers'

function fixtures() {
  const db = seededDb()
  const unit = db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number }
  const itemId = Number(db.prepare("INSERT INTO stock_items(name,unit_id,gst_rate) VALUES('Copper Cable',?,18)").run(unit.id).lastInsertRowid)
  const creditors = db.prepare("SELECT id FROM groups WHERE name='Sundry Creditors'").get() as { id: number }
  const supplierId = Number(db.prepare("INSERT INTO ledgers(name,group_id,gstin,state_code) VALUES('Reliable Cables',?,'27ABCDE1234F1Z5','27')").run(creditors.id).lastInsertRowid)
  return { db, itemId, supplierId }
}

describe('procurement document chain', () => {
  it('moves approved demand through PO and partial/final receipts while posting only accepted stock', () => {
    const { db, itemId, supplierId } = fixtures()
    const req = createRequisition(db, { date:'2026-08-01',neededBy:'2026-08-10',department:'Projects',note:'Site requirement',lines:[{stockItemId:itemId,qtyMilli:10_000,note:null}] }, 'Kavya')
    expect((db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as {n:number}).n).toBe(0)
    setRequisitionStatus(db,req.id,'submitted','Kavya')
    setRequisitionStatus(db,req.id,'approved','Owner','Approved within budget')
    const po=createPurchaseOrder(db,{date:'2026-08-02',expectedDate:'2026-08-08',supplierLedgerId:supplierId,requisitionId:req.id,note:null,lines:[{stockItemId:itemId,qtyMilli:10_000,ratePaise:12_500,gstRate:18}]},'Kavya')
    expect(getRequisition(db,req.id)?.status).toBe('converted')
    setPurchaseOrderStatus(db,po.id,'issued','Kavya')
    const line=po.lines[0]!
    const first=createGoodsReceipt(db,{purchaseOrderId:po.id,date:'2026-08-08',note:'One unit rejected',lines:[{purchaseOrderLineId:line.id,qtyReceivedMilli:7_000,qtyAcceptedMilli:6_000,qtyRejectedMilli:1_000}]},'Stores')
    expect(first.inventoryVoucherId).toBeGreaterThan(0)
    expect(getPurchaseOrder(db,po.id)).toMatchObject({status:'part_received',lines:[{qtyAcceptedMilli:6_000,qtyRejectedMilli:1_000,outstandingQtyMilli:4_000}]})
    expect(stockSummary(db,'2026-08-08')[0]?.closingQtyMilli).toBe(6_000)
    createGoodsReceipt(db,{purchaseOrderId:po.id,date:'2026-08-09',note:'Replacement received',lines:[{purchaseOrderLineId:line.id,qtyReceivedMilli:4_000,qtyAcceptedMilli:4_000,qtyRejectedMilli:0}]},'Stores')
    expect(getPurchaseOrder(db,po.id)?.status).toBe('received')
    expect(stockSummary(db,'2026-08-09')[0]?.closingQtyMilli).toBe(10_000)
    expect(listGoodsReceipts(db)).toHaveLength(2)
    db.prepare('UPDATE stock_items SET reorder_level_milli=12000 WHERE id=?').run(itemId)
    expect(reorderSuggestions(db,'2026-08-09')).toMatchObject([{stockItemId:itemId,closingQtyMilli:10_000,suggestedQtyMilli:2_000,supplierLedgerId:supplierId,lastRatePaise:12_500}])
    const [reorder]=createReorderPurchaseOrders(db,'2026-08-09',[itemId],'Owner');expect(reorder).toMatchObject({status:'draft',supplierLedgerId:supplierId,lines:[{qtyOrderedMilli:2_000,ratePaise:12_500}]})
  })

  it('blocks invalid transitions and over-receipt', () => {
    const { db, itemId, supplierId } = fixtures()
    const req=createRequisition(db,{date:'2026-08-01',neededBy:null,department:null,note:null,lines:[{stockItemId:itemId,qtyMilli:1_000,note:null}]},'Kavya')
    expect(()=>setRequisitionStatus(db,req.id,'approved','Owner')).toThrow('cannot move')
    const po=createPurchaseOrder(db,{date:'2026-08-01',expectedDate:null,supplierLedgerId:supplierId,requisitionId:null,note:null,lines:[{stockItemId:itemId,qtyMilli:1_000,ratePaise:100,gstRate:18}]},'Kavya')
    expect(()=>createGoodsReceipt(db,{purchaseOrderId:po.id,date:'2026-08-02',note:null,lines:[{purchaseOrderLineId:po.lines[0]!.id,qtyReceivedMilli:1_000,qtyAcceptedMilli:1_000,qtyRejectedMilli:0}]},'Stores')).toThrow('issued')
    setPurchaseOrderStatus(db,po.id,'issued','Kavya')
    expect(()=>createGoodsReceipt(db,{purchaseOrderId:po.id,date:'2026-08-02',note:null,lines:[{purchaseOrderLineId:po.lines[0]!.id,qtyReceivedMilli:2_000,qtyAcceptedMilli:2_000,qtyRejectedMilli:0}]},'Stores')).toThrow('exceeds')
  })

  it('three-way matches a financial-only purchase invoice without receiving stock twice', () => {
    const { db, itemId, supplierId } = fixtures()
    const po = createPurchaseOrder(db, { date:'2026-08-01',expectedDate:null,supplierLedgerId:supplierId,requisitionId:null,note:null,lines:[{stockItemId:itemId,qtyMilli:10_000,ratePaise:12_500,gstRate:18}] }, 'Kavya')
    setPurchaseOrderStatus(db, po.id, 'issued', 'Kavya')
    const receipt = createGoodsReceipt(db, { purchaseOrderId:po.id,date:'2026-08-02',note:null,lines:[{purchaseOrderLineId:po.lines[0]!.id,qtyReceivedMilli:10_000,qtyAcceptedMilli:10_000,qtyRejectedMilli:0}] }, 'Stores')
    expect(listInvoiceMatchCandidates(db, supplierId)).toHaveLength(1)
    const matchInput = { goodsReceiptId:receipt.id, lines:[{stockItemId:itemId,qtyMilli:10_000,ratePaise:12_500,amount:125_000,gstRate:18}] }
    expect(previewInvoiceMatch(db, matchInput)).toMatchObject({ status:'exact', quantityVarianceCount:0, rateVarianceCount:0 })
    const purchaseType = db.prepare("SELECT id FROM voucher_types WHERE kind='purchase' LIMIT 1").get() as { id:number }
    const purchaseGroup = db.prepare("SELECT id FROM groups WHERE name='Purchase Accounts'").get() as { id:number }
    const purchaseLedgerId = Number(db.prepare("INSERT INTO ledgers(name,group_id) VALUES('Materials Purchased',?)").run(purchaseGroup.id).lastInsertRowid)
    const voucher = saveVoucher(db, { voucherTypeId:purchaseType.id,date:'2026-08-03',partyLedgerId:supplierId,narration:null,reference:'INV-88',instrumentNo:null,instrumentDate:null,transporterId:null,vehicleNo:null,transportDistanceKm:null,posOverride:null,currencyCode:null,exchangeRate:null,lines:[{ledgerId:purchaseLedgerId,drCr:'dr',amount:125_000},{ledgerId:supplierId,drCr:'cr',amount:125_000}],inventory:[],billRefs:[],tds:null })
    recordInvoiceMatch(db, voucher.id, matchInput, 'Owner')
    expect(listInvoiceMatchCandidates(db, supplierId)).toHaveLength(0)
    expect(stockSummary(db, '2026-08-03')[0]?.closingQtyMilli).toBe(10_000)
    expect((db.prepare('SELECT status FROM purchase_invoice_matches WHERE voucher_id=?').get(voucher.id) as {status:string}).status).toBe('exact')
    expect(getPurchaseOrder(db, po.id)?.lines[0]).toMatchObject({ qtyBilledMilli:10_000, outstandingBillQtyMilli:0 })
    expect(supplierPriceHistory(db, [itemId], supplierId)).toMatchObject([{ source:'matched_invoice', ratePaise:12_500, qtyMilli:10_000 }])
    expect(compareSuppliers(db, itemId)).toMatchObject([{ supplierLedgerId:supplierId, lastRatePaise:12_500, orderCount:1, acceptedQtyMilli:10_000, rejectionRate:0, onTimeDeliveryRate:100 }])
    expect(supplierConcentration(db,'2026-08-01','2026-08-31')).toMatchObject({totalPurchases:125_000,rows:[{supplierLedgerId:supplierId,purchaseAmount:125_000,sharePercent:100,soleSourcedItemCount:1,risk:'high'}]})
    expect(() => recordInvoiceMatch(db, voucher.id, matchInput, 'Owner')).toThrow('unavailable')
  })

  it('surfaces quantity and rate variances before posting', () => {
    const { db, itemId, supplierId } = fixtures()
    const po=createPurchaseOrder(db,{date:'2026-08-01',expectedDate:null,supplierLedgerId:supplierId,requisitionId:null,note:null,lines:[{stockItemId:itemId,qtyMilli:5_000,ratePaise:1_000,gstRate:18}]},'Kavya')
    setPurchaseOrderStatus(db,po.id,'issued','Kavya')
    const receipt=createGoodsReceipt(db,{purchaseOrderId:po.id,date:'2026-08-02',note:null,lines:[{purchaseOrderLineId:po.lines[0]!.id,qtyReceivedMilli:5_000,qtyAcceptedMilli:5_000,qtyRejectedMilli:0}]},'Stores')
    expect(previewInvoiceMatch(db,{goodsReceiptId:receipt.id,lines:[{stockItemId:itemId,qtyMilli:4_000,ratePaise:1_100,amount:4_400,gstRate:18}]})).toMatchObject({status:'variance',quantityVarianceCount:1,rateVarianceCount:1,lines:[{quantityVarianceMilli:-1_000,rateVariancePaise:100}]})
  })

  it('refuses to match a purchase invoice after it is moved to the bin', () => {
    const { db, itemId, supplierId } = fixtures()
    const po=createPurchaseOrder(db,{date:'2026-08-01',expectedDate:null,supplierLedgerId:supplierId,requisitionId:null,note:null,lines:[{stockItemId:itemId,qtyMilli:1_000,ratePaise:1_000,gstRate:18}]},'Kavya')
    setPurchaseOrderStatus(db,po.id,'issued','Kavya')
    const receipt=createGoodsReceipt(db,{purchaseOrderId:po.id,date:'2026-08-02',note:null,lines:[{purchaseOrderLineId:po.lines[0]!.id,qtyReceivedMilli:1_000,qtyAcceptedMilli:1_000,qtyRejectedMilli:0}]},'Stores')
    const matchInput={goodsReceiptId:receipt.id,lines:[{stockItemId:itemId,qtyMilli:1_000,ratePaise:1_000,amount:1_000,gstRate:18}]}
    const purchaseType=db.prepare("SELECT id FROM voucher_types WHERE kind='purchase' LIMIT 1").get() as {id:number}
    const purchaseGroup=db.prepare("SELECT id FROM groups WHERE name='Purchase Accounts'").get() as {id:number}
    const purchaseLedgerId=Number(db.prepare("INSERT INTO ledgers(name,group_id) VALUES('Binned Purchase',?)").run(purchaseGroup.id).lastInsertRowid)
    const voucher=saveVoucher(db,{voucherTypeId:purchaseType.id,date:'2026-08-03',partyLedgerId:supplierId,narration:null,reference:null,instrumentNo:null,instrumentDate:null,transporterId:null,vehicleNo:null,transportDistanceKm:null,posOverride:null,currencyCode:null,exchangeRate:null,lines:[{ledgerId:purchaseLedgerId,drCr:'dr',amount:1_000},{ledgerId:supplierId,drCr:'cr',amount:1_000}],inventory:[],billRefs:[],tds:null})
    deleteVoucher(db,voucher.id)
    expect(() => recordInvoiceMatch(db,voucher.id,matchInput,'Owner')).toThrow('Voucher is not active in the books')
    expect(listInvoiceMatchCandidates(db,supplierId)).toHaveLength(1)
  })

  it('turns rejected delivery evidence into one financial-only linked debit note', () => {
    const {db,itemId,supplierId}=fixtures();const po=createPurchaseOrder(db,{date:'2026-08-01',expectedDate:null,supplierLedgerId:supplierId,requisitionId:null,note:null,lines:[{stockItemId:itemId,qtyMilli:2_000,ratePaise:1_000,gstRate:18}]},'Kavya');setPurchaseOrderStatus(db,po.id,'issued','Kavya')
    createGoodsReceipt(db,{purchaseOrderId:po.id,date:'2026-08-02',note:'Quality failure',lines:[{purchaseOrderLineId:po.lines[0]!.id,qtyReceivedMilli:2_000,qtyAcceptedMilli:1_000,qtyRejectedMilli:1_000}]},'Stores')
    const [claim]=listDebitNoteClaims(db);expect(claim).toMatchObject({reason:'rejection',amount:1_000,supplierLedgerId:supplierId,lines:[{qtyMilli:1_000,ratePaise:1_000}]})
    const draft=createDebitNoteDraft(db,claim!.sourceKey,'Owner');expect(draft).toMatchObject({kind:'debit_note',mode:'invoice',payload:{partyId:supplierId,procurementClaimKey:claim!.sourceKey}})
    const debitType=db.prepare("SELECT id FROM voucher_types WHERE kind='debit_note' LIMIT 1").get() as {id:number};const purchaseGroup=db.prepare("SELECT id FROM groups WHERE name='Purchase Accounts'").get() as {id:number};const accountId=Number(db.prepare("INSERT INTO ledgers(name,group_id) VALUES('Purchase Returns',?)").run(purchaseGroup.id).lastInsertRowid)
    const voucher=saveVoucher(db,{voucherTypeId:debitType.id,date:'2026-08-03',partyLedgerId:supplierId,narration:null,reference:null,instrumentNo:null,instrumentDate:null,transporterId:null,vehicleNo:null,transportDistanceKm:null,posOverride:null,currencyCode:null,exchangeRate:null,lines:[{ledgerId:supplierId,drCr:'dr',amount:1_000},{ledgerId:accountId,drCr:'cr',amount:1_000}],inventory:[],billRefs:[],tds:null})
    recordDebitNoteLink(db,voucher.id,claim!.sourceKey,'Owner');expect(listDebitNoteClaims(db)).toHaveLength(0);expect(()=>recordDebitNoteLink(db,voucher.id,claim!.sourceKey,'Owner')).toThrow('unavailable');expect(stockSummary(db,'2026-08-03')[0]?.closingQtyMilli).toBe(1_000)
  })

  it('refuses to link a procurement claim to a binned debit note', () => {
    const {db,itemId,supplierId}=fixtures();const po=createPurchaseOrder(db,{date:'2026-08-01',expectedDate:null,supplierLedgerId:supplierId,requisitionId:null,note:null,lines:[{stockItemId:itemId,qtyMilli:2_000,ratePaise:1_000,gstRate:18}]},'Kavya');setPurchaseOrderStatus(db,po.id,'issued','Kavya')
    createGoodsReceipt(db,{purchaseOrderId:po.id,date:'2026-08-02',note:null,lines:[{purchaseOrderLineId:po.lines[0]!.id,qtyReceivedMilli:2_000,qtyAcceptedMilli:1_000,qtyRejectedMilli:1_000}]},'Stores')
    const claim=listDebitNoteClaims(db)[0]!
    const debitType=db.prepare("SELECT id FROM voucher_types WHERE kind='debit_note' LIMIT 1").get() as {id:number};const purchaseGroup=db.prepare("SELECT id FROM groups WHERE name='Purchase Accounts'").get() as {id:number};const accountId=Number(db.prepare("INSERT INTO ledgers(name,group_id) VALUES('Binned Returns',?)").run(purchaseGroup.id).lastInsertRowid)
    const voucher=saveVoucher(db,{voucherTypeId:debitType.id,date:'2026-08-03',partyLedgerId:supplierId,narration:null,reference:null,instrumentNo:null,instrumentDate:null,transporterId:null,vehicleNo:null,transportDistanceKm:null,posOverride:null,currencyCode:null,exchangeRate:null,lines:[{ledgerId:supplierId,drCr:'dr',amount:1_000},{ledgerId:accountId,drCr:'cr',amount:1_000}],inventory:[],billRefs:[],tds:null})
    deleteVoucher(db,voucher.id)
    expect(() => recordDebitNoteLink(db,voucher.id,claim.sourceKey,'Owner')).toThrow('Voucher is not active in the books')
    expect(listDebitNoteClaims(db)).toHaveLength(1)
  })
})
