export interface SalesReturnCandidateLine { inventoryLineId:number;stockItemId:number;itemName:string;qtySoldMilli:number;qtyReturnedMilli:number;openQtyMilli:number;ratePaise:number;value:number }
export interface SalesReturnCandidate { voucherId:number;number:string;date:string;partyLedgerId:number;partyName:string;lines:SalesReturnCandidateLine[] }
export interface SalesReturnDraftInput { invoiceVoucherId:number;date:string;reason:string;lines:{invoiceInventoryLineId:number;qtyMilli:number}[] }
export interface WarrantyClaim { id:number;serialId:number;serialNo:string;itemName:string;invoiceVoucherId:number;invoiceNumber:string;invoiceDate:string;warrantyUntil:string|null;openedDate:string;issue:string;status:'open'|'in_service'|'resolved'|'rejected';outcome:string|null;serviceCost:number;resolvedDate:string|null }
export type SalesCustomFieldType='text'|'number'|'date'|'choice'
export interface SalesCustomFieldDefinition {id:number;fieldKey:string;label:string;documentKind:'quotation'|'order'|'challan'|'proforma'|null;dataType:SalesCustomFieldType;required:boolean;options:string[];active:boolean}
export interface SalesCustomFieldInput extends Omit<SalesCustomFieldDefinition,'id'>{}
export interface SalesTerritory {id:number;name:string;parentId:number|null;active:boolean}
export interface SalesCustomerAssignment {id:number;customerLedgerId:number;customerName:string;territoryId:number;territoryName:string;salesperson:string;effectiveFrom:string;effectiveTo:string|null}
export interface TerritorySalesRow {territoryId:number|null;territoryName:string;salesperson:string;invoiceCount:number;salesAmount:number;returnAmount:number;netSales:number;collections:number}
export interface SubscriptionContract {id:number;recurringScheduleId:number;scheduleName:string;customerName:string;planName:string;startDate:string;endDate:string|null;escalationBps:number;nextEscalationDate:string|null;status:'draft'|'active'|'paused'|'renewal_due'|'ended'|'cancelled';renewedFromId:number|null;note:string|null}
export interface SubscriptionContractInput {recurringScheduleId:number;planName:string;startDate:string;endDate:string|null;escalationBps:number;nextEscalationDate:string|null;note:string|null}
export interface CustomerPortalBundle {path:string;token:string;manifestHash:string;invoiceCount:number;receiptCount:number}
