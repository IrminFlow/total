// Builders for small Tally exports in TallyPrime's "All Masters" / Day Book layout (TALLYMESSAGE
// wrappers, Tally's sign convention: a negative AMOUNT / OPENINGBALANCE is a debit), for tests that
// need many variants of one scenario. Amounts in rupees, as Tally writes them.
export const tallyEnvelope = (msgs: string[]): string =>
  `<ENVELOPE>\n <HEADER>\n  <TALLYREQUEST>Import Data</TALLYREQUEST>\n </HEADER>\n <BODY>\n  <IMPORTDATA>\n   <REQUESTDESC>\n    <REPORTNAME>All Masters</REPORTNAME>\n    <STATICVARIABLES><SVCURRENTCOMPANY>Shree Ganesh Traders</SVCURRENTCOMPANY></STATICVARIABLES>\n   </REQUESTDESC>\n   <REQUESTDATA>\n${msgs.map((m) => `    <TALLYMESSAGE xmlns:UDF="TallyUDF">\n${m}\n    </TALLYMESSAGE>`).join('\n')}\n   </REQUESTDATA>\n  </IMPORTDATA>\n </BODY>\n</ENVELOPE>\n`

const rs = (rupees: number): string => rupees.toFixed(2)

export const tallyLedger = (name: string, parent: string, openingRupeesDr = 0, billsXml = ''): string =>
  `     <LEDGER NAME="${name}" RESERVEDNAME="">\n      <PARENT>${parent}</PARENT>\n      <ISBILLWISEON>${/Sundry/.test(parent) ? 'Yes' : 'No'}</ISBILLWISEON>\n      <OPENINGBALANCE>${rs(-openingRupeesDr)}</OPENINGBALANCE>${billsXml}\n     </LEDGER>`

export const tallyUnit = `     <UNIT NAME="Nos" RESERVEDNAME="">\n      <ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>\n      <DECIMALPLACES> 0</DECIMALPLACES>\n     </UNIT>`

export const tallyItem = (name: string, qty = 0, valueRupees = 0): string =>
  `     <STOCKITEM NAME="${name}" RESERVEDNAME="">\n      <PARENT/>\n      <BASEUNITS>Nos</BASEUNITS>\n      <OPENINGBALANCE> ${qty} Nos</OPENINGBALANCE>\n      <OPENINGVALUE>${rs(-valueRupees)}</OPENINGVALUE>\n     </STOCKITEM>`

export interface TallyBatch { godown: string; qty: number; rupees?: number }
const batches = (list: TallyBatch[], sign: 1 | -1): string => list.map((b) =>
  `\n       <BATCHALLOCATIONS.LIST>\n        <GODOWNNAME>${b.godown}</GODOWNNAME>${b.rupees === undefined ? '' : `\n        <AMOUNT>${rs(sign * b.rupees)}</AMOUNT>`}\n        <ACTUALQTY> ${b.qty} Nos</ACTUALQTY>\n        <BILLEDQTY> ${b.qty} Nos</BILLEDQTY>\n       </BATCHALLOCATIONS.LIST>`).join('')

/** A cash purchase (invoice view) of one item, its goods split over `godowns`. */
export function tallyPurchase(no: string, date: string, item: string, qty: number, rupees: number, godowns: TallyBatch[]): string {
  return `     <VOUCHER VCHTYPE="Purchase" ACTION="Create" OBJVIEW="Invoice Voucher View">\n      <DATE>${date}</DATE>\n      <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>\n      <VOUCHERNUMBER>${no}</VOUCHERNUMBER>\n      <PARTYLEDGERNAME>HDFC Bank</PARTYLEDGERNAME>\n      <ISINVOICE>Yes</ISINVOICE>
      <ALLINVENTORYENTRIES.LIST>\n       <STOCKITEMNAME>${item}</STOCKITEMNAME>\n       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n       <AMOUNT>${rs(-rupees)}</AMOUNT>\n       <ACTUALQTY> ${qty} Nos</ACTUALQTY>\n       <BILLEDQTY> ${qty} Nos</BILLEDQTY>${batches(godowns, -1)}\n      </ALLINVENTORYENTRIES.LIST>
      <LEDGERENTRIES.LIST>\n       <LEDGERNAME>Purchase Account</LEDGERNAME>\n       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n       <AMOUNT>${rs(-rupees)}</AMOUNT>\n      </LEDGERENTRIES.LIST>
      <LEDGERENTRIES.LIST>\n       <LEDGERNAME>HDFC Bank</LEDGERNAME>\n       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n       <ISPARTYLEDGER>Yes</ISPARTYLEDGER>\n       <AMOUNT>${rs(rupees)}</AMOUNT>\n      </LEDGERENTRIES.LIST>\n     </VOUCHER>`
}

/** A cash sale (invoice view) of one item from one godown. */
export function tallyCashSale(no: string, date: string, item: string, qty: number, rupees: number, godown: string): string {
  return `     <VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Invoice Voucher View">\n      <DATE>${date}</DATE>\n      <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>\n      <VOUCHERNUMBER>${no}</VOUCHERNUMBER>\n      <PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>\n      <ISINVOICE>Yes</ISINVOICE>
      <ALLINVENTORYENTRIES.LIST>\n       <STOCKITEMNAME>${item}</STOCKITEMNAME>\n       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n       <AMOUNT>${rs(rupees)}</AMOUNT>\n       <ACTUALQTY> ${qty} Nos</ACTUALQTY>\n       <BILLEDQTY> ${qty} Nos</BILLEDQTY>${batches([{ godown, qty, rupees }], 1)}\n      </ALLINVENTORYENTRIES.LIST>
      <LEDGERENTRIES.LIST>\n       <LEDGERNAME>Cash</LEDGERNAME>\n       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n       <ISPARTYLEDGER>Yes</ISPARTYLEDGER>\n       <AMOUNT>${rs(-rupees)}</AMOUNT>\n      </LEDGERENTRIES.LIST>
      <LEDGERENTRIES.LIST>\n       <LEDGERNAME>Sales Account</LEDGERNAME>\n       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n       <AMOUNT>${rs(rupees)}</AMOUNT>\n      </LEDGERENTRIES.LIST>\n     </VOUCHER>`
}

/** A Physical Stock voucher: `entries` are its item entries (INVENTORYENTRIESIN.LIST), each with
 *  its godown-wise counts (one BATCHALLOCATIONS each). */
export function tallyPhysicalStock(no: string, date: string, entries: { item: string; counts: TallyBatch[] }[]): string {
  return `     <VOUCHER VCHTYPE="Physical Stock" ACTION="Create" OBJVIEW="Consumption Voucher View">\n      <DATE>${date}</DATE>\n      <VOUCHERTYPENAME>Physical Stock</VOUCHERTYPENAME>\n      <VOUCHERNUMBER>${no}</VOUCHERNUMBER>\n      <PERSISTEDVIEW>Consumption Voucher View</PERSISTEDVIEW>${entries.map((e) => {
    const qty = e.counts.reduce((s, c) => s + c.qty, 0)
    return `\n      <INVENTORYENTRIESIN.LIST>\n       <STOCKITEMNAME>${e.item}</STOCKITEMNAME>\n       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n       <ACTUALQTY> ${qty} Nos</ACTUALQTY>\n       <BILLEDQTY> ${qty} Nos</BILLEDQTY>${batches(e.counts, -1)}\n      </INVENTORYENTRIESIN.LIST>`
  }).join('')}\n     </VOUCHER>`
}

export interface TallyAlloc { name: string; type: 'New Ref' | 'Agst Ref' | 'Advance' | 'On Account'; rupees: number }
const allocs = (list: TallyAlloc[], sign: 1 | -1): string => list.map((a) =>
  `\n       <BILLALLOCATIONS.LIST>\n        <NAME>${a.name}</NAME>\n        <BILLTYPE>${a.type}</BILLTYPE>\n        <AMOUNT>${rs(sign * a.rupees)}</AMOUNT>\n       </BILLALLOCATIONS.LIST>`).join('')

/** A receipt from a customer into HDFC Bank, with its bill-wise allocations. */
export function tallyReceipt(no: string, date: string, party: string, rupees: number, bills: TallyAlloc[]): string {
  return `     <VOUCHER VCHTYPE="Receipt" ACTION="Create" OBJVIEW="Accounting Voucher View">\n      <DATE>${date}</DATE>\n      <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>\n      <VOUCHERNUMBER>${no}</VOUCHERNUMBER>\n      <PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>
      <ALLLEDGERENTRIES.LIST>\n       <LEDGERNAME>${party}</LEDGERNAME>\n       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n       <ISPARTYLEDGER>Yes</ISPARTYLEDGER>\n       <AMOUNT>${rs(rupees)}</AMOUNT>${allocs(bills, 1)}\n      </ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST>\n       <LEDGERNAME>HDFC Bank</LEDGERNAME>\n       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n       <AMOUNT>${rs(-rupees)}</AMOUNT>\n      </ALLLEDGERENTRIES.LIST>\n     </VOUCHER>`
}

/** A sale to a customer (accounting view), with its bill-wise allocations. */
export function tallyCreditSale(no: string, date: string, party: string, rupees: number, bills: TallyAlloc[]): string {
  return `     <VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Accounting Voucher View">\n      <DATE>${date}</DATE>\n      <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>\n      <VOUCHERNUMBER>${no}</VOUCHERNUMBER>\n      <PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>
      <ALLLEDGERENTRIES.LIST>\n       <LEDGERNAME>${party}</LEDGERNAME>\n       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n       <ISPARTYLEDGER>Yes</ISPARTYLEDGER>\n       <AMOUNT>${rs(-rupees)}</AMOUNT>${allocs(bills, -1)}\n      </ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST>\n       <LEDGERNAME>Sales Account</LEDGERNAME>\n       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n       <AMOUNT>${rs(rupees)}</AMOUNT>\n      </ALLLEDGERENTRIES.LIST>\n     </VOUCHER>`
}

/** Masters every builder above posts to. */
export const tallyBaseMasters = [
  tallyLedger('Sales Account', 'Sales Accounts'),
  tallyLedger('Purchase Account', 'Purchase Accounts'),
  tallyLedger('HDFC Bank', 'Bank Accounts', 100_000),
  tallyLedger('Capital Account', 'Capital Account', -100_000),
  tallyUnit
]
