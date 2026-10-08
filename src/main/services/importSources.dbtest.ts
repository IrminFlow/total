// WP 6.3 — Zoho Books and Busy importers against fixtures built from the documented layouts
// (header strings and sources in src/shared/dataImport/zoho.ts and busy.ts). Each file is
// auto-detected, imported, and checked against the books it should produce.
import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { openingTotals, runImport, type ImportOptions } from './dataImport'
import { autoPlan, parseImportFile, planSteps } from './importFiles'
import { getLedger } from './masters'
import { getVoucher } from './vouchers'
import { trialBalance } from './reports'
import { readCompanyInfo } from '../db/seed'

const enc = new TextEncoder()

// Source files carry openings without their contra (Zoho opening stock, Busy masters): leave the
// difference — the books-level tests check it explicitly.
function load(db: DB, name: string, csv: string, expectProfile: string, opts: Partial<ImportOptions> = { openingDifference: 'leave' }) {
  const f = parseImportFile(name, enc.encode(csv))
  const { steps, profile } = autoPlan(db, f, readCompanyInfo(db).stateCode)
  expect(profile.id).toBe(expectProfile)
  return runImport(db, steps, opts, { source: profile.source, profileId: profile.id, fileName: name }, false)
}
const lid = (db: DB, name: string): number => (db.prepare('SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE').get(name) as { id: number }).id
const vid = (db: DB, number: string): number => (db.prepare('SELECT id FROM vouchers WHERE number = ?').get(number) as { id: number }).id
const lines = (db: DB, number: string): string[] =>
  getVoucher(db, vid(db, number))!.lines.map((l) => `${(db.prepare('SELECT name FROM ledgers WHERE id = ?').get(l.ledgerId) as { name: string }).name} ${l.drCr} ${l.amount}`)
const noErrors = (r: ReturnType<typeof load>): void => expect(r.steps.flatMap((s) => s.errors)).toEqual([])

// ---------- Zoho Books (company in Maharashtra, 27) ----------

const ZOHO_COA = [
  'Account ID,Account Name,Account Code,Description,Account Type,Account Status,Parent Account',
  '1,Sales,4000,,Income,Active,',
  '2,HDFC Current,1010,,Bank,Active,',
  '3,Office Rent,6100,,Expense,Active,',
  '4,Accounts Receivable,1200,,Accounts Receivable,Active,',
  '5,Output CGST,2201,,Output Tax,Active,',
  '6,Cost of Goods Sold,5000,,Cost Of Goods Sold,Active,'
].join('\n')

const ZOHO_CONTACTS = [
  'Contact ID,Display Name,Company Name,Contact Type,GST Treatment,GST Identification Number (GSTIN),Place Of Supply,Payment Terms,Payment Terms Label,Opening Balance,Credit Limit,Billing Address,Billing City,Billing Code,Accounts Receivable,Customer Sub Type',
  '11,Umbrella Retail,Umbrella Retail LLP,customer,business_registered_regular,27AABCD1234E1Z8,MH,30,Net 30,1500,50000,Shop 4 FC Road,Pune,411004,Accounts Receivable,business',
  '12,Krishna Enterprises,,customer,business_registered_regular,29AABCF9012G1ZQ,KA,15,Net 15,,,Indiranagar,Bengaluru,,Accounts Receivable,business'
].join('\n')

const ZOHO_ITEMS = [
  'Item ID,Item Name,SKU,HSN/SAC,Usage unit,Rate,Purchase Rate,Tax Percentage,Intra State Tax Name,Inter State Tax Name,Opening Stock,Opening Stock Value,Reorder Point,Product Type',
  '21,Steel Bracket,SB-01,7326,pcs,250,180,18,GST18,IGST18,100,18000,10,goods',
  '22,Hinge,HG-02,8302,pcs,40,25,,GST12,IGST12,,,,goods'
].join('\n')

// One row per line item; header fields repeated (Invoice.csv layout).
const ZOHO_INVOICES = [
  'Invoice Date,Invoice ID,Invoice Number,Invoice Status,Customer Name,GST Treatment,GST Identification Number (GSTIN),Place of Supply,Due Date,Is Inclusive Tax,Item Name,Account,Quantity,Item Price,Item Total,Item Tax,Item Tax %,Item Tax Amount,HSN/SAC,Shipping Charge,Adjustment,SubTotal,Total,Balance',
  // Intra-state, two lines, shipping: 2×250 + 4×40 = 660 taxable; tax 90 + 19.20; shipping 50 → 819.20
  '2025-06-02,9001,INV-0001,Sent,Umbrella Retail,business_registered_regular,27AABCD1234E1Z8,MH,2025-07-02,false,Steel Bracket,Sales,2,250,500,GST18,18,90,7326,50,,660,819.2,819.2',
  '2025-06-02,9001,INV-0001,Sent,Umbrella Retail,business_registered_regular,27AABCD1234E1Z8,MH,2025-07-02,false,Hinge,Sales,4,40,160,GST12,12,19.2,8302,50,,660,819.2,819.2',
  // Inter-state, IGST; total off by 0.40 (rounding in Zoho) → round-off.
  '2025-06-05,9002,INV-0002,Paid,Krishna Enterprises,business_registered_regular,29AABCF9012G1ZQ,KA,2025-06-20,false,Steel Bracket,Sales,3,250,750,IGST18,18,135,7326,,,750,885.4,0',
  // Draft: never posted.
  '2025-06-06,9003,INV-0003,Draft,Krishna Enterprises,,,KA,,,Hinge,Sales,1,40,40,IGST12,12,4.8,8302,,,40,44.8,44.8'
].join('\n')

const ZOHO_PAYMENTS = [
  'Payment Number,CustomerPayment ID,Mode,Date,Customer Name,Amount,Deposit To,Reference Number,Invoice Number,Amount Applied to Invoice,Invoice Payment Applied Date',
  '1,7001,Bank Transfer,2025-06-10,Krishna Enterprises,885.4,HDFC Current,UTR123,INV-0002,885.4,2025-06-10',
  '2,7002,Cash,2025-06-12,Umbrella Retail,1000,HDFC Current,,INV-0001,819.2,2025-06-12',
  '2,7002,Cash,2025-06-12,Umbrella Retail,1000,HDFC Current,,,,'
].join('\n')

const ZOHO_JOURNALS = [
  'Journal Date,Journal Number,Journal Number Prefix,Journal Type,Reference Number,Notes,Account,Debit,Credit,Contact Name,Status,Journal Created By',
  '2025-06-30,JV-1,JV-,both,,June rent,Office Rent,12000,,,Published,admin',
  '2025-06-30,JV-1,JV-,both,,June rent,HDFC Current,,12000,,Published,admin',
  '2025-06-30,JV-2,JV-,both,,Write-off,Accounts Receivable,,180.8,Umbrella Retail,Published,admin',
  '2025-06-30,JV-2,JV-,both,,Write-off,Office Rent,180.8,,,Published,admin'
].join('\n')

describe('Zoho Books', () => {
  it('imports CoA, contacts, items, invoices, payments and journals into balanced books', () => {
    const db = seededDb()
    noErrors(load(db, 'Chart_of_Accounts.csv', ZOHO_COA, 'zoho:accounts'))
    expect(db.prepare("SELECT g.name FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.name = 'HDFC Current'").get()).toEqual({ name: 'Bank Accounts' })
    expect(getLedger(db, lid(db, 'Output CGST'))!.taxType).toBe('cgst')
    expect(db.prepare("SELECT 1 FROM ledgers WHERE name = 'Accounts Receivable'").get()).toBeUndefined() // control account skipped

    noErrors(load(db, 'Contacts.csv', ZOHO_CONTACTS, 'zoho:contacts'))
    expect(getLedger(db, lid(db, 'Umbrella Retail'))).toMatchObject({ openingBalance: 150000, creditDays: 30, creditLimit: 5000000, stateCode: '27', pan: 'AABCD1234E', gstin: '27AABCD1234E1Z8' })
    expect(getLedger(db, lid(db, 'Krishna Enterprises'))!.stateCode).toBe('29')

    noErrors(load(db, 'Item.csv', ZOHO_ITEMS, 'zoho:items'))
    expect(db.prepare("SELECT hsn, gst_rate, opening_qty_milli, opening_value, barcode FROM stock_items WHERE name = 'Steel Bracket'").get())
      .toEqual({ hsn: '7326', gst_rate: 18, opening_qty_milli: 100000, opening_value: 1800000, barcode: 'SB-01' })
    expect(db.prepare("SELECT gst_rate FROM stock_items WHERE name = 'Hinge'").get()).toEqual({ gst_rate: 12 })

    const inv = load(db, 'Invoice.csv', ZOHO_INVOICES, 'zoho:invoices')
    expect(inv.steps[0]).toMatchObject({ created: 2 })
    expect(inv.steps[0]!.errors).toEqual([expect.objectContaining({ message: expect.stringMatching(/INV-0003 skipped: draft/) })])
    expect(lines(db, 'INV-0001')).toEqual([
      'Umbrella Retail dr 81920', 'Sales cr 66000', 'CGST Output cr 5460', 'SGST Output cr 5460', 'Freight & Packing Recovered cr 5000'
    ].map((s) => (s.startsWith('CGST Output') ? 'Output CGST cr 5460' : s)))
    expect(lines(db, 'INV-0002')).toEqual(['Krishna Enterprises dr 88540', 'Sales cr 75000', 'IGST Output cr 13500', 'Round Off cr 40'])
    const inv1 = getVoucher(db, vid(db, 'INV-0001'))!
    expect(inv1.inventory.map((i) => [i.qtyMilli, i.ratePaise, i.amount, i.direction])).toEqual([[2000, 25000, 50000, 'out'], [4000, 4000, 16000, 'out']])
    expect(inv1.billRefs).toEqual([expect.objectContaining({ kind: 'new', name: 'INV-0001', amount: 81920, dueDate: '2025-07-02' })])
    expect(getVoucher(db, vid(db, 'INV-0002'))!.posOverride).toBe('29')

    noErrors(load(db, 'Customer_Payment.csv', ZOHO_PAYMENTS, 'zoho:customerPayments'))
    const p2 = getVoucher(db, (db.prepare("SELECT v.id FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id WHERE t.kind = 'receipt' AND v.number = '2'").get() as { id: number }).id)!
    expect(p2.lines.map((l) => [l.drCr, l.amount])).toEqual([['dr', 100000], ['cr', 100000]])
    // 180.80 paid beyond the invoice stays on account as an advance reference.
    expect(p2.billRefs).toEqual([expect.objectContaining({ kind: 'against', name: 'INV-0001', amount: 81920 }), expect.objectContaining({ kind: 'new', name: 'Advance 2', amount: 18080 })])

    noErrors(load(db, 'Journal.csv', ZOHO_JOURNALS, 'zoho:journals'))
    // The receivable line names the contact: it posts to the customer's ledger.
    expect(lines(db, 'JV-2')).toEqual(['Umbrella Retail cr 18080', 'Office Rent dr 18080'])

    const tb = trialBalance(db, '2026-03-31')
    // Every voucher balances; the only gap is the openings (stock + party openings with no
    // contra in the source file), exactly what the opening check reports.
    expect(tb.totalDebit - tb.totalCredit).toBe(openingTotals(db).difference)
  })
})

// ---------- Busy (Excel templates + XML) ----------

const BUSY_ACCOUNTS = [
  'Busy Account Master List', // title row above the table, as Busy prints it
  '',
  'Acc_name,Alias,Account Group,Op. Bal.,Dr/Cr,GSTNo,ITPAN,StateName,Address1,Address2,CreditDaysForSale',
  'Sharma Traders,ST,Sundry Debtors,"12,500.00",Dr,27AAPFU0939F1ZV,,Maharashtra,Plot 7,MIDC,30',
  'Gupta Supply Co,GS,Sundry Creditors,"12,500.00",Cr,,ABCDE1234F,Gujarat,,,',
  'Godown Rent,,Expenses (Indirect/Admn.),,,,,,,,',
  'Counter Sales,,Sale,,,,,,,,',
  'Freight Charges,,Expenses (Direct/Mfg.),,,,,,,,',
  'Old Suspense,,Suspense Account,,,,,,,,'
].join('\n')

const BUSY_ITEMS = [
  'Item Name,Alias,Item Group,Unit,HSN Code,Tax Category,Item Opening Quantity,Item Opening Amount,Sale Price,MRP',
  'Copper Wire,CW,Electricals,Mtr,8544,GST 18%,500,"25,000.00",80,95',
  'Switch,SW,Electricals,Pcs,8536,GST 12%,40,"2,000.00",70,'
].join('\n')

const BUSY_SALES = [
  'Vch Series,Voucher/Bill Date,Voucher/Bill Number,Sale Type,Party Name,Material Centre,Item Name,Quantity,Unit Name,Price,Amount,Narration',
  'Main,15-05-2025,B-101,L/GST-18%,Sharma Traders,Main Location,Copper Wire,100,Mtr,80,8000,First bill',
  ',,,,,,Switch,10,Pcs,70,700,',
  'Main,16-05-2025,B-102,I/GST-18%,Gupta Supply Co,Main Location,Switch,5,Pcs,70,350,'
].join('\n')

const BUSY_ACC = [
  'Vch Type,Date,Vch No,Account,Debit,Credit,Short Narration,Ref. No,Method',
  'Receipt,20-05-2025,R/1,Cash,"5,000.00",,part payment,,',
  ',,,Sharma Traders,,"5,000.00",,B-101,Agst Ref',
  'Payment,21-05-2025,P/1,Godown Rent,"1,000.00",,May rent,,',
  ',,,Cash,,"1,000.00",,,'
].join('\n')

const BUSY_XML = `<?xml version="1.0" encoding="iso8859-1"?>
<BusyData FinYear="01-04-2025">
  <AccountGroups><AccountGroup><Name>Retail Debtors</Name><ParentGroup>Sundry Debtors</ParentGroup></AccountGroup>
    <AccountGroup><Name>Sundry Debtors</Name><ParentGroup>Current Assets</ParentGroup></AccountGroup></AccountGroups>
  <Accounts>
    <Account><Name>Mehta Stores</Name><ParentGroup>Retail Debtors</ParentGroup><OPBal>-2000.00</OPBal>
      <Address><Address1>Main Road</Address1><StateName>Maharashtra</StateName><GSTNo>27AABCE5678F1ZH</GSTNo></Address></Account>
    <Account><Name>Proprietor Capital</Name><ParentGroup>Capital Account</ParentGroup><OPBal>2000.00</OPBal></Account>
    <Account><Name>Sale A/c</Name><ParentGroup>Sale</ParentGroup></Account>
  </Accounts>
  <Units><Unit><Name>Box</Name></Unit></Units>
  <Items><Item><Name>Carton</Name><ParentGroup>Packing</ParentGroup><MainUnit>Box</MainUnit><OPStockInMainUnit>20</OPStockInMainUnit><OPAmount>-400.00</OPAmount></Item></Items>
  <Sales>
    <Sale><VchSeriesName>Main</VchSeriesName><Date>08-04-2025</Date><VchNo>X-1</VchNo><MasterName1>Mehta Stores</MasterName1>
      <ItemEntries><ItemDetail><ItemName>Carton</ItemName><Qty>2</Qty><Price>50</Price><Amt>100</Amt></ItemDetail></ItemEntries>
      <AccEntries>
        <AccDetail><AccountName>Mehta Stores</AccountName><AmountType>1</AmountType><AmtMainCur>100</AmtMainCur></AccDetail>
        <AccDetail><AccountName>Sale A/c</AccountName><AmountType>2</AmountType><AmtMainCur>100</AmtMainCur></AccDetail>
      </AccEntries>
      <VchOtherInfoDetails><Narration1>XML sale</Narration1></VchOtherInfoDetails>
    </Sale>
  </Sales>
</BusyData>`

describe('Busy', () => {
  it('account masters: title rows skipped, Busy groups mapped to the chart, Dr/Cr column honoured', () => {
    const db = seededDb()
    noErrors(load(db, 'accounts.csv', BUSY_ACCOUNTS, 'busy:accounts'))
    const grp = (n: string): string => (db.prepare('SELECT g.name FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.name = ?').get(n) as { name: string }).name
    expect(grp('Godown Rent')).toBe('Indirect Expenses')
    expect(grp('Counter Sales')).toBe('Sales Accounts')
    expect(grp('Freight Charges')).toBe('Direct Expenses')
    expect(grp('Old Suspense')).toBe('Suspense A/c')
    expect(getLedger(db, lid(db, 'Sharma Traders'))).toMatchObject({ openingBalance: 1250000, creditDays: 30, stateCode: '27', address: 'Plot 7, MIDC' })
    expect(getLedger(db, lid(db, 'Gupta Supply Co'))).toMatchObject({ openingBalance: -1250000, pan: 'ABCDE1234F', stateCode: '24' })
  })

  it('items, item-line sales (L/ and I/ sale types) and accounting vouchers with bill references', () => {
    const db = seededDb()
    load(db, 'accounts.csv', BUSY_ACCOUNTS, 'busy:accounts')
    noErrors(load(db, 'items.csv', BUSY_ITEMS, 'busy:items'))
    expect(db.prepare("SELECT hsn, gst_rate, opening_qty_milli, opening_value, mrp_paise FROM stock_items WHERE name = 'Copper Wire'").get())
      .toEqual({ hsn: '8544', gst_rate: 18, opening_qty_milli: 500000, opening_value: 2500000, mrp_paise: 9500 })
    const s = load(db, 'sales.csv', BUSY_SALES, 'busy:sales')
    noErrors(s)
    expect(s.steps[0]!.created).toBe(2)
    // Local 18%: CGST 9% + SGST 9% on 8,700; inter-state: IGST. The company's only sales ledger takes the revenue.
    expect(lines(db, 'B-101')).toEqual(['Sharma Traders dr 1026600', 'Counter Sales cr 870000', 'CGST Output cr 78300', 'SGST Output cr 78300'])
    expect(lines(db, 'B-102')).toEqual(['Gupta Supply Co dr 41300', 'Counter Sales cr 35000', 'IGST Output cr 6300'])
    expect(getVoucher(db, vid(db, 'B-101'))!.inventory.map((i) => [i.qtyMilli, i.godownId !== null])).toEqual([[100000, true], [10000, true]])
    const a = load(db, 'acc.csv', BUSY_ACC, 'busy:accVouchers')
    noErrors(a)
    expect(getVoucher(db, vid(db, 'R/1'))!.billRefs).toEqual([expect.objectContaining({ kind: 'against', name: 'B-101', amount: 500000 })])
    const tb = trialBalance(db, '2026-03-31')
    // Every voucher balances; the only gap is the openings (stock + party openings with no
    // contra in the source file), exactly what the opening check reports.
    expect(tb.totalDebit - tb.totalCredit).toBe(openingTotals(db).difference)
  })

  it('Busy XML: groups, accounts (Busy sign: negative = Dr), units, items and vouchers in one plan', () => {
    const db = seededDb()
    const f = parseImportFile('MSAll.xml', enc.encode(BUSY_XML))
    expect(f.kind).toBe('busyXml')
    expect(f.busy!.groups.map((g) => g.name)).toEqual(['Retail Debtors']) // default groups are not re-created
    const r = runImport(db, planSteps(f), { openingDifference: 'leave' }, { source: 'busy-xml', profileId: null, fileName: 'MSAll.xml' }, false)
    expect(r.steps.flatMap((s) => s.errors)).toEqual([])
    expect(getLedger(db, lid(db, 'Mehta Stores'))).toMatchObject({ openingBalance: 200000, gstin: '27AABCE5678F1ZH' })
    expect(getLedger(db, lid(db, 'Proprietor Capital'))!.openingBalance).toBe(-200000)
    expect(db.prepare("SELECT opening_qty_milli, opening_value FROM stock_items WHERE name = 'Carton'").get()).toEqual({ opening_qty_milli: 20000, opening_value: 40000 })
    expect(lines(db, 'X-1')).toEqual(['Mehta Stores dr 10000', 'Sale A/c cr 10000'])
    expect(getVoucher(db, vid(db, 'X-1'))!.narration).toBe('XML sale')
  })
})
