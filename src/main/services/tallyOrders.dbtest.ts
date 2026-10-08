// WP 6.3 — Tally import: sales / purchase orders land in trade_docs (design §8 Q8), and the
// company's books-from year is set from the file (the Phase 1 gap).
import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import { readCompanyInfo } from '../db/seed'
import { dryRunTallyXml, importTallyXml } from './tallyImport'
import { getTradeDoc } from './tradeDocs'
import { postSimpleVoucher } from '../db/testdb'
import { orderLineMoney, parseTallyLooseDate } from '@shared/tally'

const MASTERS = `
  <TALLYMESSAGE>
    <LEDGER NAME="Acme Retail"><PARENT>Sundry Debtors</PARENT></LEDGER>
    <LEDGER NAME="Steel Supplies"><PARENT>Sundry Creditors</PARENT></LEDGER>
    <UNIT NAME="Nos"><DECIMALPLACES>0</DECIMALPLACES></UNIT>
    <STOCKITEM NAME="Bolt"><BASEUNITS>Nos</BASEUNITS></STOCKITEM>
    <STOCKITEM NAME="Nut"><BASEUNITS>Nos</BASEUNITS></STOCKITEM>
  </TALLYMESSAGE>`

const COMPANY = `<TALLYMESSAGE><COMPANY NAME="Acme"><STARTINGFROM>20240401</STARTINGFROM><BOOKSFROM>20240401</BOOKSFROM></COMPANY></TALLYMESSAGE>`

const order = (type: string, no: string, party: string, due = '15-Jun-2025'): string => `
  <TALLYMESSAGE>
    <VOUCHER VCHTYPE="${type}">
      <DATE>20250510</DATE>
      <VOUCHERNUMBER>${no}</VOUCHERNUMBER>
      <PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>
      <REFERENCE>PO-REF-1</REFERENCE>
      <ALLINVENTORYENTRIES.LIST>
        <STOCKITEMNAME>Bolt</STOCKITEMNAME>
        <RATE>12.50/Nos</RATE>
        <ACTUALQTY>10 Nos</ACTUALQTY>
        <AMOUNT>125.00</AMOUNT>
        <BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><ORDERDUEDATE P="${due}">${due}</ORDERDUEDATE></BATCHALLOCATIONS.LIST>
      </ALLINVENTORYENTRIES.LIST>
      <ALLINVENTORYENTRIES.LIST>
        <STOCKITEMNAME>Nut</STOCKITEMNAME>
        <RATE>3.00/Nos</RATE>
        <ACTUALQTY>7 Nos</ACTUALQTY>
        <AMOUNT>-19.95</AMOUNT>
      </ALLINVENTORYENTRIES.LIST>
    </VOUCHER>
  </TALLYMESSAGE>`

describe('Tally orders → trade_docs', () => {
  it('imports sales and purchase orders with lines, rates, discounts, godown and due date', () => {
    const db = seededDb()
    const summary = importTallyXml(db, `<ENVELOPE>${MASTERS}${order('Sales Order', 'SO/1', 'Acme Retail')}${order('Purchase Order', 'PO/1', 'Steel Supplies')}</ENVELOPE>`)
    expect(summary).toMatchObject({ orders: 2, vouchers: 0, skipped: 0 })
    const docs = db.prepare('SELECT d.id, t.kind, d.number FROM trade_docs d JOIN trade_doc_types t ON t.id = d.doc_type_id ORDER BY d.id').all() as { id: number; kind: string; number: string }[]
    expect(docs.map((d) => [d.kind, d.number])).toEqual([['sales_order', 'SO/1'], ['purchase_order', 'PO/1']])
    const so = getTradeDoc(db, docs[0]!.id, '2025-05-31')!
    expect(so.reference).toBe('PO-REF-1')
    expect(so.dueDate).toBe('2025-06-15')
    expect(so.lines.map((l) => [l.qtyMilli, l.ratePaise, l.discountPaise, l.amount, l.dueDate])).toEqual([
      [10000, 1250, 0, 12500, '2025-06-15'],
      // 7 × 3.00 = 21.00 but the order says 19.95: the 1.05 is the line's discount.
      [7000, 300, 105, 1995, null]
    ])
    expect(so.lines[0]!.godownId).not.toBeNull()
    // Orders post nothing.
    expect(db.prepare('SELECT COUNT(*) AS n FROM vouchers').get()).toEqual({ n: 0 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'trade_doc' AND action = 'create'").get()).toEqual({ n: 2 })
  })

  it('skips an order twice imported, a job-work order and an unknown party — with warnings', () => {
    const db = seededDb()
    importTallyXml(db, `<ENVELOPE>${MASTERS}${order('Sales Order', 'SO/1', 'Acme Retail')}</ENVELOPE>`)
    const again = importTallyXml(db, `<ENVELOPE>${MASTERS}${order('Sales Order', 'SO/1', 'Acme Retail')}${order('Job Work Out Order', 'JW/1', 'Acme Retail')}${order('Sales Order', 'SO/2', 'Nobody')}</ENVELOPE>`)
    expect(again.orders).toBe(0)
    expect(again.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/SO\/1 skipped: already imported/),
      expect.stringMatching(/JW\/1 skipped: job-work orders/),
      expect.stringMatching(/SO\/2 skipped: unknown party "Nobody"/)
    ]))
  })

  it('the same order number in two financial years is two orders (the series restarts each FY)', () => {
    const db = seededDb()
    const s = importTallyXml(db, `<ENVELOPE>${MASTERS}${order('Sales Order', 'SO/1', 'Acme Retail')}${order('Sales Order', 'SO/1', 'Acme Retail').replace('20250510', '20260510').replace('15-Jun-2025', '15-Jun-2026')}</ENVELOPE>`)
    expect(s.orders).toBe(2)
    expect(db.prepare("SELECT date FROM trade_docs WHERE number = 'SO/1' ORDER BY date").all()).toEqual([{ date: '2025-05-10' }, { date: '2026-05-10' }])
  })

  it('the dry run counts orders without writing', () => {
    const db = seededDb()
    expect(dryRunTallyXml(`<ENVELOPE>${MASTERS}${order('Sales Order', 'SO/1', 'Acme Retail')}</ENVELOPE>`).orders).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM trade_docs').get()).toEqual({ n: 0 })
  })

  it('helpers: loose dates and order-line money', () => {
    expect(parseTallyLooseDate('20250415')).toBe('2025-04-15')
    expect(parseTallyLooseDate('1-Apr-25')).toBe('2025-04-01')
    expect(parseTallyLooseDate('15-April-2025')).toBe('2025-04-15')
    expect(orderLineMoney(3000, null, 1000)).toEqual({ ratePaise: 334, discountPaise: 2, amount: 1000 })
    expect(orderLineMoney(2000, 400, 900)).toEqual({ ratePaise: 450, discountPaise: 0, amount: 900 })
  })
})

describe('Tally import sets booksFrom', () => {
  it('from the COMPANY master (BOOKSFROM) on a company without vouchers', () => {
    const db = seededDb()
    expect(readCompanyInfo(db).booksFrom).toBe(2025)
    const s = importTallyXml(db, `<ENVELOPE>${COMPANY}${MASTERS}</ENVELOPE>`)
    expect(s.booksFromSet).toBe(2024)
    expect(readCompanyInfo(db).booksFrom).toBe(2024)
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'company' AND action = 'update'").get()).toEqual({ n: 1 })
  })

  it('from the earliest real voucher when the file has no company master — orders and optional vouchers never count', () => {
    const voucher = (date: string, optional = false): string => `<TALLYMESSAGE><VOUCHER VCHTYPE="Journal"><DATE>${date}</DATE><VOUCHERNUMBER>J${date}</VOUCHERNUMBER>
      ${optional ? '<ISOPTIONAL>Yes</ISOPTIONAL>' : ''}
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Acme Retail</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-10.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Steel Supplies</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>10.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER></TALLYMESSAGE>`
    const db = seededDb()
    // An order in FY 2023-24 and an optional voucher in FY 2022-23 don't move the first year; the
    // real voucher of 1 Mar 2024 (FY 2023-24) does.
    const s = importTallyXml(db, `<ENVELOPE>${MASTERS}${order('Sales Order', 'SO/1', 'Acme Retail').replace('20250510', '20230601')}${voucher('20220601', true)}${voucher('20240301')}</ENVELOPE>`)
    expect(s.booksFromSet).toBe(2023)
    const optional = db.prepare("SELECT is_optional FROM vouchers WHERE number = 'J20220601'").get() as { is_optional: number }
    expect(optional.is_optional).toBe(1)
    const db2 = seededDb()
    expect(importTallyXml(db2, `<ENVELOPE>${MASTERS}${order('Sales Order', 'SO/1', 'Acme Retail').replace('20250510', '20200401')}</ENVELOPE>`).booksFromSet).toBeNull()
  })

  it('only an owner may change it: others import with a warning', () => {
    const db = seededDb()
    const s = importTallyXml(db, `<ENVELOPE>${COMPANY}${MASTERS}</ENVELOPE>`, { canSetBooksFrom: false })
    expect(s.booksFromSet).toBeNull()
    expect(readCompanyInfo(db).booksFrom).toBe(2025)
    expect(s.warnings).toEqual([expect.stringMatching(/only an owner/)])
  })

  it('leaves it (with a warning) once the company has vouchers', () => {
    const db = seededDb()
    postSimpleVoucher(db, { date: '2025-06-01', amount: 100, kind: 'journal' })
    const s = importTallyXml(db, `<ENVELOPE>${COMPANY}${MASTERS}</ENVELOPE>`)
    expect(s.booksFromSet).toBeNull()
    expect(readCompanyInfo(db).booksFrom).toBe(2025)
    expect(s.warnings).toEqual([expect.stringMatching(/FY 2024-25.*left unchanged/)])
  })
})
