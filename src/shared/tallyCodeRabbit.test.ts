// PR #191, CodeRabbit review: parser findings (each a regression test).
import { describe, expect, it } from 'vitest'
import { parseTallyExport } from './tally'
import { tallyBaseMasters, tallyEnvelope, tallyItem, tallyPurchase } from './fixtures/tally/tallyXml'

const parse = (msgs: string[]) => parseTallyExport(tallyEnvelope([...tallyBaseMasters, tallyItem('Widget'), ...msgs]))

describe('Tally export: review findings', () => {
  it('an unrecognised BILLTYPE is reported with its voucher and value, never dropped silently', () => {
    const data = parse([`     <VOUCHER VCHTYPE="Receipt" ACTION="Create">
      <DATE>20260405</DATE>
      <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
      <VOUCHERNUMBER>R-7</VOUCHERNUMBER>
      <PARTYLEDGERNAME>Cust</PARTYLEDGERNAME>
      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>Cust</LEDGERNAME>
       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
       <AMOUNT>500.00</AMOUNT>
       <BILLALLOCATIONS.LIST>
        <NAME>S-1</NAME>
        <BILLTYPE>Against Reference</BILLTYPE>
        <AMOUNT>500.00</AMOUNT>
       </BILLALLOCATIONS.LIST>
      </ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>HDFC Bank</LEDGERNAME>
       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
       <AMOUNT>-500.00</AMOUNT>
      </ALLLEDGERENTRIES.LIST>
     </VOUCHER>`])
    expect(data.warnings).toEqual([expect.stringMatching(/R-7.*S-1.*"Against Reference"/)])
  })

  it('one godown batch that disagrees with its line keeps the line without a godown, and says so', () => {
    const data = parse([tallyPurchase('P-1', '20260401', 'Widget', 15, 1500, [{ godown: 'Godown A', qty: 10, rupees: 1000 }])])
    expect(data.vouchers[0]!.inventory).toEqual([{ item: 'Widget', qtyMilli: 15_000, amount: 150_000, direction: 'in' }])
    expect(data.warnings).toEqual([expect.stringMatching(/P-1.*Widget.*Godown A/)])
    // A batch that names only the godown (no quantity, no amount) still places the line.
    const bare = parse([tallyPurchase('P-2', '20260401', 'Widget', 15, 1500, [{ godown: 'Godown A', qty: 15 }]).replace(/<ACTUALQTY> 15 Nos<\/ACTUALQTY>\n        <BILLEDQTY> 15 Nos<\/BILLEDQTY>\n       <\/BATCH/, '</BATCH')])
    expect(bare.vouchers[0]!.inventory.map((l) => l.godown)).toEqual(['Godown A'])
    expect(bare.warnings).toEqual([])
  })

  it('a "Stock-Journal" type (any separators) without masters is a stock journal, not skipped', () => {
    const data = parse([`     <VOUCHER VCHTYPE="Stock-Journal" ACTION="Create">
      <DATE>20260405</DATE>
      <VOUCHERTYPENAME>Stock-Journal</VOUCHERTYPENAME>
      <VOUCHERNUMBER>SJ-9</VOUCHERNUMBER>
      <INVENTORYENTRIES.LIST>
       <STOCKITEMNAME>Widget</STOCKITEMNAME>
       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
       <AMOUNT>100.00</AMOUNT>
       <ACTUALQTY> 1 Nos</ACTUALQTY>
      </INVENTORYENTRIES.LIST>
      <INVENTORYENTRIES.LIST>
       <STOCKITEMNAME>Widget</STOCKITEMNAME>
       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
       <AMOUNT>-100.00</AMOUNT>
       <ACTUALQTY> 1 Nos</ACTUALQTY>
      </INVENTORYENTRIES.LIST>
     </VOUCHER>`])
    expect(data.vouchers.map((v) => v.number)).toEqual(['SJ-9'])
    expect(data.warnings).toEqual([])
  })

  it('a voucher carrying the IN / OUT lists and an ALLINVENTORYENTRIES copy of them moves the goods once', () => {
    const entry = (tag: string, deemed: 'Yes' | 'No', rupees: string) => `      <${tag}>
       <STOCKITEMNAME>Widget</STOCKITEMNAME>
       <ISDEEMEDPOSITIVE>${deemed}</ISDEEMEDPOSITIVE>
       <AMOUNT>${rupees}</AMOUNT>
       <ACTUALQTY> 2 Nos</ACTUALQTY>
      </${tag}>`
    const data = parse([`     <VOUCHER VCHTYPE="Stock Journal" ACTION="Create">
      <DATE>20260405</DATE>
      <VOUCHERTYPENAME>Stock Journal</VOUCHERTYPENAME>
      <VOUCHERNUMBER>SJ-10</VOUCHERNUMBER>
${entry('INVENTORYENTRIESIN.LIST', 'Yes', '-200.00')}
${entry('INVENTORYENTRIESOUT.LIST', 'No', '200.00')}
${entry('ALLINVENTORYENTRIES.LIST', 'Yes', '-200.00')}
${entry('ALLINVENTORYENTRIES.LIST', 'No', '200.00')}
     </VOUCHER>`])
    expect(data.vouchers[0]!.inventory.map((l) => [l.direction, l.qtyMilli])).toEqual([['in', 2_000], ['out', 2_000]])
  })
})
