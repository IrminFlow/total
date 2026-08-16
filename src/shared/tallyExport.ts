/**
 * Tally XML export: builders for the ENVELOPE/HEADER/BODY/IMPORTDATA/REQUESTDATA/TALLYMESSAGE
 * structure Tally's "Import Data" XML request expects — the exact shape parseTallyExport
 * (./tally.ts) consumes coming back in. buildTallyMastersXml/buildTallyVouchersXml output
 * round-trips through parseTallyExport unchanged (see tallyExport.test.ts).
 *
 * Sign convention: Tally's AMOUNT/OPENINGBALANCE are negative for debit, positive for credit —
 * the opposite of Total's internal dr-positive convention — so every amount is negated on the
 * way out exactly as tally.ts negates on the way in.
 *
 * Note for accountants: only ledger/group *names* travel in this file, not full group trees.
 * If a custom group's PARENT name doesn't already exist in the target Tally company, Tally will
 * refuse the import for that master — either create the parent group there first, or re-point
 * it under "Primary" (Tally's root group) before importing.
 */
import type { TallyGroup, TallyLedger, TallyUnit, TallyItem, TallyVoucher } from './tally'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** `<TAG>escaped text</TAG>`, or '' for null/undefined/empty — mirrors tally.ts's childText() default of ''. */
function el(tag: string, value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return ''
  return `<${tag}>${esc(value)}</${tag}>`
}

/** ISO "2026-08-15" -> Tally's "20260815". */
function tallyDate(iso: string): string {
  return iso.replace(/-/g, '')
}

/** Signed paise -> plain rupee decimal Tally accepts unformatted, e.g. -118000 -> "-1180.00". */
function tallyAmount(paise: number): string {
  return (paise / 100).toFixed(2)
}

/** Quantity thousandths -> plain decimal, e.g. 2500 -> "2.500". */
function qtyDecimal(qtyMilli: number): string {
  return (qtyMilli / 1000).toFixed(3)
}

function envelope(reportName: string, messages: string[]): string {
  return (
    '<ENVELOPE>' +
    '<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>' +
    '<BODY><IMPORTDATA>' +
    `<REQUESTDESC><REPORTNAME>${esc(reportName)}</REPORTNAME></REQUESTDESC>` +
    `<REQUESTDATA>${messages.join('')}</REQUESTDATA>` +
    '</IMPORTDATA></BODY></ENVELOPE>'
  )
}

const message = (body: string): string => `<TALLYMESSAGE>${body}</TALLYMESSAGE>`

export interface TallyMasters {
  groups: TallyGroup[]
  ledgers: TallyLedger[]
  units: TallyUnit[]
  items: TallyItem[]
}

/** Groups, ledgers, units and stock items as one Tally "All Masters" import envelope. */
export function buildTallyMastersXml(masters: TallyMasters): string {
  const messages: string[] = []

  for (const g of masters.groups) {
    messages.push(message(`<GROUP NAME="${esc(g.name)}">${el('PARENT', g.parent)}</GROUP>`))
  }

  for (const u of masters.units) {
    messages.push(message(`<UNIT NAME="${esc(u.name)}">${el('DECIMALPLACES', String(u.decimals))}</UNIT>`))
  }

  for (const l of masters.ledgers) {
    const body =
      el('PARENT', l.parent) +
      el('OPENINGBALANCE', tallyAmount(-l.opening)) +
      el('PARTYGSTIN', l.gstin) +
      el('LEDSTATENAME', l.stateName)
    messages.push(message(`<LEDGER NAME="${esc(l.name)}">${body}</LEDGER>`))
  }

  for (const it of masters.items) {
    const body =
      el('BASEUNITS', it.unit) +
      el('HSNCODE', it.hsn) +
      (it.gstRate !== null ? el('GSTRATE', String(it.gstRate)) : '') +
      el('OPENINGBALANCE', `${qtyDecimal(it.openingQtyMilli)} ${it.unit}`) +
      el('OPENINGVALUE', tallyAmount(it.openingValue))
    messages.push(message(`<STOCKITEM NAME="${esc(it.name)}">${body}</STOCKITEM>`))
  }

  return envelope('All Masters', messages)
}

/** Vouchers (with inventory lines) as one Tally "Vouchers" import envelope. */
export function buildTallyVouchersXml(vouchers: TallyVoucher[]): string {
  const messages = vouchers.map((v) => {
    const entries = v.lines
      .map((l) => {
        const amount = tallyAmount(l.drCr === 'dr' ? -l.amount : l.amount)
        return (
          '<ALLLEDGERENTRIES.LIST>' +
          el('LEDGERNAME', l.ledger) +
          el('ISDEEMEDPOSITIVE', l.drCr === 'dr' ? 'Yes' : 'No') +
          el('AMOUNT', amount) +
          '</ALLLEDGERENTRIES.LIST>'
        )
      })
      .join('')
    const inventory = v.inventory
      .map(
        (i) =>
          '<ALLINVENTORYENTRIES.LIST>' +
          el('STOCKITEMNAME', i.item) +
          el('ACTUALQTY', qtyDecimal(i.qtyMilli)) +
          el('AMOUNT', tallyAmount(i.amount)) +
          '</ALLINVENTORYENTRIES.LIST>'
      )
      .join('')
    const body =
      el('DATE', tallyDate(v.date)) +
      el('VOUCHERNUMBER', v.number) +
      el('PARTYLEDGERNAME', v.party) +
      el('NARRATION', v.narration) +
      entries +
      inventory
    return message(`<VOUCHER VCHTYPE="${esc(v.vchType)}">${body}</VOUCHER>`)
  })

  return envelope('Vouchers', messages)
}
