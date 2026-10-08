/**
 * Builds a double-entry sales / purchase voucher from an invoice exported line by line (Zoho
 * Books invoices and bills, Busy sales / purchase registers): party, revenue / expense ledger
 * per line, GST split into CGST + SGST (intra-state) or IGST (inter-state), extra charges, and a
 * round-off that absorbs at most ₹1 of difference against the document total. Pure.
 *
 * Ledgers the importer may have to find or create are named by placeholders resolved in the
 * main process (services/dataImport.ts resolveSpecialLedger): the company's existing GST ledger
 * of that tax type and direction (or a new "CGST Output" / "IGST Input" …), its sales /
 * purchase ledger, a round-off ledger.
 */
import type { VoucherKind } from '../domain'
import type { VoucherDraft, VoucherDraftItemLine, VoucherDraftLedgerLine } from './targets'

export const SPECIAL = '@@'
export type SpecialLedger =
  | 'sales' | 'purchase' | 'roundoff' | 'charges-income' | 'charges-expense'
  | 'tax:output:cgst' | 'tax:output:sgst' | 'tax:output:igst' | 'tax:output:cess'
  | 'tax:input:cgst' | 'tax:input:sgst' | 'tax:input:igst' | 'tax:input:cess'
export const special = (s: SpecialLedger): string => `${SPECIAL}${s}`
export const isSpecial = (name: string): boolean => name.startsWith(SPECIAL)

export interface InvoiceLineIn {
  line: number
  /** Revenue / expense ledger for the line (Zoho "Account"); null → the default sales/purchase ledger. */
  account: string | null
  item: string | null
  qtyMilli: number | null
  ratePaise: number | null
  /** Taxable value after discount, paise. */
  taxable: number
  /** Explicit GST amounts when the export carries them (CGST / SGST / IGST columns). */
  cgst: number | null
  sgst: number | null
  igst: number | null
  cess: number | null
  /** Otherwise: total tax of the line and/or its rate; split by place of supply. */
  taxAmount: number | null
  taxRate: number | null
  /** Tax name ("IGST18", "GST18", "L/GST-18%"); "IGST…" / "I/" forces inter-state. */
  taxName: string | null
}

export interface InvoiceIn {
  key: string
  kind: Extract<VoucherKind, 'sales' | 'purchase' | 'credit_note' | 'debit_note'>
  typeName: string
  date: string
  number: string | null
  party: string
  reference: string | null
  narration: string | null
  /** Two-digit place of supply (null = unknown → the tax name / explicit columns decide). */
  placeOfSupply: string | null
  companyState: string
  lines: InvoiceLineIn[]
  /** Extra charges (shipping, packing) and adjustments, signed: + adds to the total. */
  charges: { line: number; label: string; account: string | null; amount: number }[]
  /** The document's own total, when the export has it — checked, with ≤ ₹1 going to round-off. */
  total: number | null
  dueDate: string | null
  billRef: string | null
  godown: string | null
}

/** Round-off tolerance: anything larger is an error (the export and the rebuild disagree). */
export const ROUND_OFF_LIMIT = 100

function interState(inv: InvoiceIn, l: InvoiceLineIn): boolean {
  const n = (l.taxName ?? '').trim().toUpperCase()
  if (n.startsWith('IGST') || n.startsWith('I/')) return true
  if (/^(GST|CGST|SGST|L\/)/.test(n)) return false
  if (inv.placeOfSupply) return inv.placeOfSupply !== inv.companyState
  return false
}

/** Tax of one line, split. Half to CGST, the rest to SGST (odd paise to SGST). */
export function lineTax(inv: InvoiceIn, l: InvoiceLineIn): { cgst: number; sgst: number; igst: number; cess: number } {
  if (l.cgst !== null || l.sgst !== null || l.igst !== null) {
    return { cgst: l.cgst ?? 0, sgst: l.sgst ?? 0, igst: l.igst ?? 0, cess: l.cess ?? 0 }
  }
  const total = l.taxAmount ?? (l.taxRate !== null ? Math.round((l.taxable * l.taxRate) / 100) : 0)
  if (interState(inv, l)) return { cgst: 0, sgst: 0, igst: total, cess: l.cess ?? 0 }
  const cgst = Math.floor(total / 2)
  return { cgst, sgst: total - cgst, igst: 0, cess: l.cess ?? 0 }
}

/** Assemble the voucher; returns errors instead of a draft when it cannot balance. */
export function buildInvoiceVoucher(inv: InvoiceIn): { draft: VoucherDraft | null; error: string | null } {
  const outward = inv.kind === 'sales' || inv.kind === 'debit_note'
  // Sales and debit notes (purchase returns) credit revenue/tax and debit the party; the others mirror it.
  const partySide: 'dr' | 'cr' = inv.kind === 'sales' || inv.kind === 'debit_note' ? 'dr' : 'cr'
  const other: 'dr' | 'cr' = partySide === 'dr' ? 'cr' : 'dr'
  const taxDir = inv.kind === 'sales' || inv.kind === 'credit_note' ? 'output' : 'input'
  const revenueDefault = special(inv.kind === 'sales' || inv.kind === 'credit_note' ? 'sales' : 'purchase')
  const byLedger = new Map<string, number>()
  const add = (ledger: string, amount: number): void => {
    if (amount === 0) return
    byLedger.set(ledger, (byLedger.get(ledger) ?? 0) + amount)
  }
  const items: VoucherDraftItemLine[] = []
  let sum = 0
  for (const l of inv.lines) {
    add(l.account?.trim() || revenueDefault, l.taxable)
    const t = lineTax(inv, l)
    add(special(`tax:${taxDir}:cgst`), t.cgst)
    add(special(`tax:${taxDir}:sgst`), t.sgst)
    add(special(`tax:${taxDir}:igst`), t.igst)
    add(special(`tax:${taxDir}:cess`), t.cess)
    sum += l.taxable + t.cgst + t.sgst + t.igst + t.cess
    if (l.item && l.qtyMilli && l.qtyMilli > 0) {
      items.push({
        line: l.line, item: l.item, godown: inv.godown, batch: null, qtyMilli: l.qtyMilli,
        ratePaise: l.ratePaise ?? Math.round((l.taxable * 1000) / l.qtyMilli), amount: l.taxable,
        direction: inv.kind === 'purchase' || inv.kind === 'credit_note' ? 'in' : 'out'
      })
    }
  }
  for (const c of inv.charges) {
    add(c.account?.trim() || special(outward ? 'charges-income' : 'charges-expense'), c.amount)
    sum += c.amount
  }
  const notes: string[] = []
  let total = sum
  if (inv.total !== null && inv.total !== sum) {
    const diff = inv.total - sum
    if (Math.abs(diff) > ROUND_OFF_LIMIT) {
      return { draft: null, error: `Lines add up to ${(sum / 100).toFixed(2)} but the document total is ${(inv.total / 100).toFixed(2)}` }
    }
    add(special('roundoff'), diff)
    notes.push(`Round-off of ${(diff / 100).toFixed(2)} to match the document total`)
    total = inv.total
  }
  if (total <= 0) return { draft: null, error: 'Document total is zero or negative' }
  const ledgerLines: VoucherDraftLedgerLine[] = [{ line: inv.lines[0]?.line ?? 0, ledger: inv.party, drCr: partySide, amount: total }]
  for (const [ledger, amount] of byLedger) {
    // A negative amount on the "other" side (a discount account, a negative adjustment) flips side.
    if (amount > 0) ledgerLines.push({ line: inv.lines[0]?.line ?? 0, ledger, drCr: other, amount })
    else if (amount < 0) ledgerLines.push({ line: inv.lines[0]?.line ?? 0, ledger, drCr: partySide, amount: -amount })
  }
  return {
    draft: {
      key: inv.key,
      lines: [...new Set([...inv.lines.map((l) => l.line), ...inv.charges.map((c) => c.line)])],
      typeName: inv.typeName,
      kind: inv.kind,
      date: inv.date,
      number: inv.number,
      party: inv.party,
      narration: inv.narration,
      reference: inv.reference,
      ledgerLines,
      items,
      bills: inv.billRef ? [{ line: inv.lines[0]?.line ?? 0, kind: 'new', name: inv.billRef, amount: total, dueDate: inv.dueDate }] : [],
      tds: null,
      tcs: null,
      posOverride: null,
      currencyCode: null,
      exchangeRate: null,
      isOptional: false,
      notes
    },
    error: null
  }
}
