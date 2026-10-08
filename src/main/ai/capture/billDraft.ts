// WP 5.4 — a captured bill → a PURCHASE DRAFT, deterministically (no model call here: the
// extraction is done; this step only resolves and builds, so a review answer re-runs it free).
//
//   supplier  GSTIN first (an identifier is exact), else the name through @shared/aiResolve —
//             several close names become a question; none becomes a question with a suggested
//             "create party" action (prefilled, never done automatically);
//   lines     each printed line → a stock item by name (aliases, barcode) and HSN — a name match
//             whose HSN disagrees is not taken, an HSN shared by several items is a question;
//             a service line can be booked to a ledger instead ("ledger line");
//   GST       the invoice editor's own calculation (computeInvoice through the WP 5.3
//             draft_invoice builder; computeGst per rate for ledger lines) — never the printed
//             tax; a printed tax or total that differs becomes an assumption on the banner;
//   duplicate same supplier + invoice number in the FY → REFUSED with a link to the voucher;
//             same supplier + amount within ±7 days → drafted and flagged with a link.
// The draft is stored like every WP 5.3 draft (rehearsed save, sources, assumptions, fields) with
// source 'capture'; nothing reaches the books until the user saves it in the editor.
import type { DB } from '../../db/connection'
import type { CompanyInfo, Ledger, StockItem } from '@shared/domain'
import type { AiDraftDto, AiDraftSourceRef } from '@shared/ai'
import type { ParsedBill, ParsedBillLine } from '@shared/capture/parse'
import { recomputeBill } from '@shared/capture/totals'
import { findDuplicates, type DuplicateCandidate, type DuplicateHit } from '@shared/capture/duplicates'
import type { CaptureMapping, CaptureQuestion, CaptureReview } from '@shared/capture/types'
import { formatPaise, roundToRupee } from '@shared/money'
import { resolveName } from '@shared/aiResolve'
import { computeGst, addBreakups, supplyTypeFor } from '@shared/gst/calc'
import { stateName } from '@shared/gst/states'
import { computeInvoice, taxLedgerIdsFrom, type AccountingFormState, type AccountingRowState, type InvoiceFormState } from '@shared/voucherEdit'
import { saveVoucher, NOT_DELETED } from '../../services/vouchers'
import { writeAudit } from '../../services/audit'
import { insertDraft } from '../store'
import { DraftWork, NeedsClarification, isCreditor, isParty, loadMasters, underGroup, type DraftMasters } from '../drafting/work'
import { buildInvoiceDraft, finish, invoiceCtx, precheck, rehearsalNumber, saveWarnings, voucherTypeFor, type BuiltDraft } from '../drafting/builders'
import { rehearse } from '../drafting/rehearse'

const rs = (p: number): string => formatPaise(p, { symbol: true })
/** Paise → the rupee text the draft builders read with parseAmountText (integer maths). */
const paiseToRupeeText = (p: number): string => `${Math.floor(p / 100)}.${String(p % 100).padStart(2, '0')}`

export type BillDraftOutcome =
  | { status: 'drafted'; review: CaptureReview; supplierLedgerId: number; draft: AiDraftDto; duplicate: DuplicateHit | null }
  | { status: 'needs_review'; review: CaptureReview; supplierLedgerId: number | null }
  | { status: 'duplicate'; review: CaptureReview; supplierLedgerId: number; duplicate: DuplicateHit }
  | { status: 'failed'; review: CaptureReview | null; supplierLedgerId: number | null; error: string }

export interface BillDraftInput {
  db: DB
  company: CompanyInfo
  item: { id: number; fileName: string }
  parsed: ParsedBill
  mode: CaptureReview['mode']
  mapping: CaptureMapping
  today: string
}

/** Lines that carry something to book (blank description rows and pure sub-total rows dropped). */
export function bookableLines(parsed: ParsedBill): ParsedBillLine[] {
  return parsed.lines.filter((l) => l.description && (l.qtyMilli != null || l.ratePaise != null || l.taxablePaise != null || l.amountPaise != null))
}

const hsn4 = (s: string | null | undefined): string => (s ?? '').replace(/\D/g, '').slice(0, 4)

function resolveSupplier(m: DraftMasters, parsed: ParsedBill, mapping: CaptureMapping, q: CaptureQuestion[], sources: AiDraftSourceRef[], assume: (t: string) => void): Ledger | null {
  if (mapping.supplierLedgerId) {
    const l = m.ledgers.find((x) => x.id === mapping.supplierLedgerId)
    if (!l || !isParty(m, l)) throw new Error('The supplier picked is not a party ledger (Sundry Creditors / Debtors)')
    sources.push({ field: 'party', kind: 'ledger', label: l.name, id: l.id, said: parsed.supplierName ?? undefined, why: 'picked in the capture review' })
    return l
  }
  const parties = m.ledgers.filter((l) => isParty(m, l))
  const creditors = parties.filter((l) => isCreditor(m, l))
  if (parsed.supplierGstin) {
    const byGstin = parties.filter((l) => (l.gstin ?? '').toUpperCase() === parsed.supplierGstin)
    if (byGstin.length === 1) {
      sources.push({ field: 'party', kind: 'ledger', label: byGstin[0]!.name, id: byGstin[0]!.id, said: parsed.supplierGstin, why: `its GSTIN is ${parsed.supplierGstin}` })
      if (!isCreditor(m, byGstin[0]!)) assume(`${byGstin[0]!.name} is a debtor, not a creditor — check the supplier`)
      return byGstin[0]!
    }
    if (byGstin.length > 1) {
      q.push({ field: 'supplier', said: parsed.supplierGstin, question: `Several parties have GSTIN ${parsed.supplierGstin} — which is the supplier?`, candidates: byGstin.map((l) => ({ id: l.id, name: l.name })) })
      return null
    }
  }
  const said = parsed.supplierName ?? ''
  const cand = (l: Ledger): { id: number; name: string; keys: (string | null)[]; detail: string } => ({
    id: l.id, name: l.name, keys: [l.gstin, l.pan], detail: [l.gstin ? `GSTIN ${l.gstin}` : null, l.stateCode ? stateName(l.stateCode) : null].filter(Boolean).join(' · ')
  })
  if (said) {
    for (const pool of [creditors, parties]) {
      const r = resolveName(said, pool.map(cand))
      if (r.status === 'match') {
        const l = m.ledgers.find((x) => x.id === r.id)!
        // A GSTIN on the bill that differs from the ledger's is not the same supplier.
        if (parsed.supplierGstin && l.gstin && l.gstin.toUpperCase() !== parsed.supplierGstin) {
          q.push({ field: 'supplier', said, question: `${l.name} has GSTIN ${l.gstin}, but the bill prints ${parsed.supplierGstin}. Which supplier is it?`, candidates: [{ id: l.id, name: l.name, detail: `GSTIN ${l.gstin}` }] })
          return null
        }
        sources.push({ field: 'party', kind: 'ledger', label: l.name, id: l.id, said, why: r.why })
        if (!parsed.supplierGstin) assume(`Supplier matched by name (${r.why}) — the bill shows no GSTIN`)
        if (!isCreditor(m, l)) assume(`${l.name} is a debtor, not a creditor — check the supplier`)
        return l
      }
      if (r.status === 'ambiguous') {
        q.push({ field: 'supplier', said, question: `Which supplier is “${said}”?`, candidates: r.candidates.map((c) => ({ id: c.id, name: c.name, ...(c.detail ? { detail: c.detail } : {}) })) })
        return null
      }
    }
    const closest = resolveName(said, creditors.map(cand))
    q.push({
      field: 'supplier',
      said,
      question: `There is no supplier “${said}”${parsed.supplierGstin ? ` (GSTIN ${parsed.supplierGstin})` : ''}. Pick one, or create the party first.`,
      candidates: closest.status === 'none' ? closest.closest.map((c) => ({ id: c.id, name: c.name })) : []
    })
    return null
  }
  q.push({ field: 'supplier', said: '', question: 'The bill does not show a legible supplier — which supplier is it?', candidates: creditors.slice(0, 8).map((l) => ({ id: l.id, name: l.name })) })
  return null
}

type LineMap = { line: ParsedBillLine; item: StockItem | null; ledger: Ledger | null }

function resolveLines(m: DraftMasters, lines: ParsedBillLine[], mapping: CaptureMapping, q: CaptureQuestion[], sources: AiDraftSourceRef[], assume: (t: string) => void): LineMap[] {
  const expenseLike = (l: Ledger): boolean => underGroup(m, l, ['Purchase Accounts', 'Direct Expenses', 'Indirect Expenses', 'Fixed Assets'])
  return lines.map((line) => {
    const field = `line:${line.index}`
    const answer = mapping.lines?.[String(line.index)]
    if (answer?.itemId) {
      const it = m.items.find((x) => x.id === answer.itemId)
      if (!it) throw new Error(`Line ${line.index + 1}: there is no stock item with id ${answer.itemId}`)
      sources.push({ field, kind: 'item', label: it.name, id: it.id, said: line.description, why: 'picked in the capture review' })
      return { line, item: it, ledger: null }
    }
    if (answer?.ledgerId) {
      const l = m.ledgers.find((x) => x.id === answer.ledgerId)
      if (!l || !expenseLike(l)) throw new Error(`Line ${line.index + 1}: pick a purchase, expense or fixed-asset ledger for a ledger line`)
      sources.push({ field, kind: 'ledger', label: l.name, id: l.id, said: line.description, why: 'booked to a ledger in the capture review' })
      return { line, item: null, ledger: l }
    }
    const h = hsn4(line.hsn)
    const r = resolveName(
      line.description,
      m.items.map((i) => ({ id: i.id, name: i.name, keys: [i.barcode], secondary: [i.hsn], detail: [i.hsn ? `HSN ${i.hsn}` : null, i.gstRate != null ? `${i.gstRate}% GST` : null].filter(Boolean).join(' · ') }))
    )
    if (r.status === 'match') {
      const it = m.items.find((x) => x.id === r.id)!
      if (!h || !hsn4(it.hsn) || hsn4(it.hsn) === h) {
        sources.push({ field, kind: 'item', label: it.name, id: it.id, said: line.description, why: `${r.why}${h && hsn4(it.hsn) === h ? `, HSN ${line.hsn} agrees` : ''}` })
        return { line, item: it, ledger: null }
      }
      q.push({ field, said: line.description, question: `Line ${line.index + 1} “${line.description}” looks like ${it.name}, but the bill's HSN ${line.hsn} is not its HSN ${it.hsn}. Which item is it?`, candidates: [{ id: it.id, name: it.name, detail: `HSN ${it.hsn}` }], ledgerOption: true })
      return { line, item: null, ledger: null }
    }
    if (h) {
      const sameHsn = m.items.filter((i) => hsn4(i.hsn) === h)
      const named = r.status === 'ambiguous' ? sameHsn.filter((i) => r.candidates.some((c) => c.id === i.id)) : []
      const pick = named.length === 1 ? named[0] : sameHsn.length === 1 ? sameHsn[0] : undefined
      if (pick) {
        sources.push({ field, kind: 'item', label: pick.name, id: pick.id, said: `${line.description} (HSN ${line.hsn})`, why: named.length === 1 ? 'the only close name with that HSN' : `the only item with HSN ${line.hsn}` })
        if (named.length !== 1) assume(`Line ${line.index + 1} “${line.description}” taken as ${pick.name} — the only item with HSN ${line.hsn}`)
        return { line, item: pick, ledger: null }
      }
      if (sameHsn.length > 1) {
        q.push({ field, said: line.description, question: `Line ${line.index + 1} “${line.description}” (HSN ${line.hsn}) — which item?`, candidates: sameHsn.map((i) => ({ id: i.id, name: i.name, detail: `HSN ${i.hsn}` })), ledgerOption: true })
        return { line, item: null, ledger: null }
      }
    }
    const cands = r.status === 'ambiguous' ? r.candidates : r.closest
    q.push({
      field,
      said: line.description,
      question: `Line ${line.index + 1} “${line.description}”${line.hsn ? ` (HSN/SAC ${line.hsn})` : ''} — which stock item, or book it to a ledger (a service)?`,
      candidates: cands.map((c) => ({ id: c.id, name: c.name, ...(c.detail ? { detail: c.detail } : {}) })),
      ledgerOption: true
    })
    return { line, item: null, ledger: null }
  })
}

/** The supplier's purchase vouchers in the books (and open capture drafts) for the duplicate rules. */
export function duplicateCandidates(db: DB, supplierId: number, exceptItemId: number): DuplicateCandidate[] {
  const vouchers = db
    .prepare(
      `SELECT v.id, v.number, v.date, v.reference,
              (SELECT GROUP_CONCAT(br.name, char(31)) FROM bill_refs br WHERE br.voucher_id = v.id) AS bills,
              (SELECT COALESCE(SUM(vl.amount), 0) FROM voucher_lines vl WHERE vl.voucher_id = v.id AND vl.ledger_id = ? AND vl.dr_cr = 'cr') AS total
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE ${NOT_DELETED} AND vt.kind = 'purchase' AND (v.party_ledger_id = ? OR EXISTS (SELECT 1 FROM voucher_lines x WHERE x.voucher_id = v.id AND x.ledger_id = ?))`
    )
    .all(supplierId, supplierId, supplierId) as { id: number; number: string; date: string; reference: string | null; bills: string | null; total: number }[]
  const open = db
    .prepare(
      `SELECT c.id, c.invoice_no, c.invoice_date, c.total FROM capture_items c JOIN ai_drafts d ON d.id = c.draft_id
       WHERE c.supplier_ledger_id = ? AND c.id <> ? AND c.status = 'drafted' AND d.status = 'open'`
    )
    .all(supplierId, exceptItemId) as { id: number; invoice_no: string | null; invoice_date: string | null; total: number | null }[]
  return [
    ...vouchers.map((v) => ({
      voucherId: v.id, number: v.number, date: v.date, partyLedgerId: supplierId, total: v.total,
      invoiceNos: [...(v.bills ? v.bills.split('\u001f') : []), ...(v.reference ? [v.reference] : [])]
    })),
    ...open
      .filter((c) => c.invoice_date)
      .map((c) => ({ voucherId: null, captureItemId: c.id, number: `capture #${c.id}`, date: c.invoice_date!, partyLedgerId: supplierId, total: c.total ?? -1, invoiceNos: c.invoice_no ? [c.invoice_no] : [] }))
  ]
}

const noteFor = (fileName: string): string => `Captured from ${fileName}`.slice(0, 500)

/** Accounting-mode purchase for service / expense lines: Dr ledgers (taxable), Dr input GST
 *  (computeGst per rate — the editor's calculation), round off, Cr supplier (one new bill). */
function buildLedgerPurchase(w: DraftWork, party: Ledger, maps: LineMap[], parsed: ParsedBill, fileName: string): BuiltDraft {
  const m = w.m
  const type = voucherTypeFor(m, 'purchase')
  const date = w.date('date', parsed.date ?? undefined)
  const pos = parsed.placeOfSupply
  const partyState = party.stateCode ?? m.company.stateCode
  if (pos && pos !== partyState) w.assume(`The bill's place of supply is ${pos} ${stateName(pos) ?? ''}; a ledger-line purchase uses the supplier's state ${partyState} — check the tax`)
  const supply = supplyTypeFor(m.company.stateCode, partyState)
  const byLedger = new Map<number, number>()
  const buckets = new Map<number, number>()
  for (const { line, ledger } of maps) {
    const taxable = line.qtyMilli != null && line.ratePaise != null ? Math.round((line.qtyMilli * line.ratePaise) / 1000) - (line.discountPaise ?? 0) : (line.taxablePaise ?? line.amountPaise)
    if (taxable == null || taxable <= 0) throw new Error(`Line ${line.index + 1} has no legible amount to book`)
    let rate = ledger!.gstRate
    if (rate == null) {
      // The line's printed rate, else the bill's only tax-summary rate, else 0%.
      const summaryRates = [...new Set(parsed.taxSummary.map((t) => t.rateBp).filter((r): r is number => r != null))]
      const bp = line.gstRateBp ?? (summaryRates.length === 1 ? summaryRates[0]! : null)
      rate = bp != null ? bp / 100 : 0
      w.assume(`${ledger!.name} has no GST rate in its master — ${rate}% taken from the bill for line ${line.index + 1}`)
    } else w.assume(`${rate}% GST on line ${line.index + 1} from the ${ledger!.name} ledger master`)
    byLedger.set(ledger!.id, (byLedger.get(ledger!.id) ?? 0) + taxable)
    buckets.set(rate, (buckets.get(rate) ?? 0) + taxable)
    w.fields.add(`line:${line.index}`)
  }
  const gst = addBreakups([...buckets].map(([rate, taxable]) => computeGst(taxable, rate, supply)))
  const total = roundToRupee(gst.total)
  const roundDiff = total - gst.total
  const tax = taxLedgerIdsFrom(m.ledgers, 'input')
  const need: [keyof typeof tax, number][] = [['cgst', gst.cgst], ['sgst', gst.sgst], ['igst', gst.igst]]
  const rows: AccountingRowState[] = [...byLedger].map(([ledgerId, amount]) => ({ drCr: 'dr', ledgerId, amount, costAllocations: [] }))
  for (const [k, amt] of need) {
    if (amt <= 0) continue
    if (tax[k] == null) throw new Error(`There is no ${k.toUpperCase()} input ledger yet — create it (Duties & Taxes, tax type ${k.toUpperCase()}) or map the lines to stock items`)
    rows.push({ drCr: 'dr', ledgerId: tax[k], amount: amt, costAllocations: [] })
  }
  if (roundDiff !== 0) {
    const ro = m.ledgers.find((l) => /^round ?off$/i.test(l.name))
    if (!ro) throw new Error('There is no Round Off ledger yet — create one under Indirect Expenses')
    rows.push({ drCr: roundDiff > 0 ? 'dr' : 'cr', ledgerId: ro.id, amount: Math.abs(roundDiff), costAllocations: [] })
  }
  rows.push({ drCr: 'cr', ledgerId: party.id, amount: total, costAllocations: [] })
  const billName = parsed.invoiceNo?.trim().slice(0, 80) || ''
  if (!billName) w.assume('No invoice number on the bill — the bill-wise reference is the voucher number')
  w.fields.add('party').add('narration').add('bills')
  const due = parsed.dueDate ?? null
  const state: AccountingFormState = {
    date, number: '', rows, narration: noteFor(fileName), instrumentNo: '',
    billRefs: [{ kind: 'new', name: billName || 'AI-DRAFT', amount: total, dueDate: due }],
    advanceReceipt: false, optional: false, tds: null, tcs: null, reference: billName || null, original: null
  }
  const payload = {
    voucherTypeId: type.id, date, partyLedgerId: party.id, narration: state.narration, reference: state.reference ?? null, instrumentNo: null, instrumentDate: null,
    transporterId: null, vehicleNo: null, transportDistanceKm: null, posOverride: null, currencyCode: null, exchangeRate: null, isOptional: false,
    lines: rows.map((r) => ({ ledgerId: r.ledgerId!, drCr: r.drCr, amount: r.amount!, costAllocations: [] })),
    inventory: [], billRefs: state.billRefs, tds: null, tcs: null
  }
  const parsedPayload = precheck(m.db, payload as never, 'purchase')
  saveWarnings(w, rehearse(m.db, () => {
    const number = rehearsalNumber(w, type, date)
    return saveVoucher(m.db, { ...parsedPayload, number, billRefs: parsedPayload.billRefs.map((b) => ({ ...b, name: billName || number })) })
  }).warnings)
  if (!billName) state.billRefs = [{ kind: 'new', name: '', amount: total, dueDate: due }]
  const taxText = [gst.cgst ? `CGST ${rs(gst.cgst)}` : null, gst.sgst ? `SGST ${rs(gst.sgst)}` : null, gst.igst ? `IGST ${rs(gst.igst)}` : null].filter(Boolean).join(', ')
  const summary = `Purchase (ledger lines) from ${party.name} on ${date}${billName ? `, bill ${billName}` : ''}: taxable ${rs(gst.taxable)}${taxText ? `, ${taxText}` : ''}${roundDiff ? `, round off ${rs(roundDiff)}` : ''}, total ${rs(total)}`
  return finish(
    w,
    { voucherTypeId: type.id, voucherKind: 'purchase', date, partyLedgerId: party.id, narration: state.narration, reference: state.reference ?? null, lines: payload.lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount })), form: 'accounting', state, total },
    summary
  )
}

export function draftFromBill(input: BillDraftInput): BillDraftOutcome {
  const { db, parsed, mapping } = input
  const totals = recomputeBill(parsed)
  const review: CaptureReview = { mode: input.mode, parsed, totals, questions: [], suggestedParty: null, duplicates: [], assumptions: [], taxCheck: null }
  if (parsed.documentType === 'not_a_bill') return { status: 'failed', review, supplierLedgerId: null, error: 'This does not look like a bill' }
  if (parsed.documentType === 'credit_note' || parsed.documentType === 'debit_note') {
    return { status: 'failed', review, supplierLedgerId: null, error: 'Credit and debit notes are not captured yet — enter it in the voucher editor' }
  }
  if (parsed.currency && !/^(inr|₹|rs\.?|rupees?)$/i.test(parsed.currency.trim())) {
    return { status: 'failed', review, supplierLedgerId: null, error: `The bill is in ${parsed.currency} — capture books rupee bills only; enter it in the voucher editor` }
  }
  const m = loadMasters(db, input.company, input.today)
  const sources: AiDraftSourceRef[] = []
  const assumptions: string[] = []
  const assume = (t: string): void => {
    if (!assumptions.includes(t)) assumptions.push(t)
  }
  let supplier: Ledger | null
  try {
    supplier = resolveSupplier(m, parsed, mapping, review.questions, sources, assume)
  } catch (err) {
    return { status: 'failed', review, supplierLedgerId: null, error: (err as Error).message }
  }
  if (!supplier && parsed.supplierName) {
    review.suggestedParty = { name: parsed.supplierName, gstin: parsed.supplierGstin, stateCode: parsed.supplierStateCode, address: null }
  }
  const lines = bookableLines(parsed)
  if (lines.length === 0) return { status: 'failed', review, supplierLedgerId: supplier?.id ?? null, error: 'No legible item lines on the bill' }
  let maps: LineMap[]
  try {
    maps = resolveLines(m, lines, mapping, review.questions, sources, assume)
  } catch (err) {
    return { status: 'failed', review, supplierLedgerId: supplier?.id ?? null, error: (err as Error).message }
  }
  const resolved = maps.filter((x) => x.item || x.ledger)
  if (resolved.length === maps.length && resolved.some((x) => x.item) && resolved.some((x) => x.ledger)) {
    review.questions.push({
      field: 'mix',
      said: '',
      question: 'This bill mixes stock items and ledger lines — a purchase draft is either an item invoice or ledger lines. Map every line to an item, or every line to a ledger.',
      candidates: []
    })
  }
  if (!supplier || review.questions.length) return { status: 'needs_review', review, supplierLedgerId: supplier?.id ?? null }

  // Duplicates: refused before anything is built.
  review.duplicates = findDuplicates({ partyLedgerId: supplier.id, invoiceNo: parsed.invoiceNo, date: parsed.date, total: parsed.total ?? totals.computedTotal }, duplicateCandidates(db, supplier.id, input.item.id))
  const refused = review.duplicates.find((d) => d.kind === 'same_invoice')
  if (refused) return { status: 'duplicate', review, supplierLedgerId: supplier.id, duplicate: refused }
  const flagged = review.duplicates.find((d) => d.kind === 'same_amount') ?? null

  const w = new DraftWork(m)
  for (const s of sources) w.source(s)
  for (const a of assumptions) w.assume(a)
  let built: BuiltDraft
  try {
    if (maps.every((x) => x.item)) {
      const items = maps.map(({ line, item }) => {
        let qtyMilli = line.qtyMilli
        let rate = line.ratePaise
        const taxable = line.taxablePaise ?? line.amountPaise
        if (qtyMilli == null && rate == null && taxable != null) {
          qtyMilli = 1000
          rate = taxable
          w.assume(`Line ${line.index + 1}: no quantity or rate legible — 1 × ${rs(taxable)} (the printed taxable value)`)
        } else if (qtyMilli != null && rate == null && taxable != null) {
          if ((taxable * 1000) % qtyMilli !== 0) throw new Error(`Line ${line.index + 1}: no legible rate (the taxable value does not divide by the quantity) — correct the line in the editor`)
          rate = (taxable * 1000) / qtyMilli
          w.assume(`Line ${line.index + 1}: rate ${rs(rate)} worked out from the printed taxable value ÷ quantity`)
        } else if (qtyMilli == null && rate != null) {
          qtyMilli = 1000
          w.assume(`Line ${line.index + 1}: no quantity legible — taken as 1`)
        }
        if (qtyMilli == null || rate == null) throw new Error(`Line ${line.index + 1} has no legible quantity and rate`)
        const unit = m.units.get(item!.unitId)
        if (line.unit && unit && ![unit.symbol, unit.name].some((u) => u && u.toLowerCase().replace(/\.$/, '') === line.unit!.toLowerCase().replace(/\.$/, ''))) {
          w.assume(`Line ${line.index + 1}: the bill's unit “${line.unit}” is not ${item!.name}'s unit (${unit.symbol}) — the quantity is taken as ${unit.symbol}; check it`)
        }
        if (line.gstRateBp != null && item!.gstRate != null && line.gstRateBp !== Math.round(item!.gstRate * 100)) {
          w.assume(`Line ${line.index + 1}: the bill charges ${line.gstRateBp / 100}% but ${item!.name} is ${item!.gstRate}% in the item master — the master's rate is used`)
        }
        return {
          itemId: item!.id,
          qty: String(qtyMilli / 1000),
          rate: paiseToRupeeText(rate),
          ...(line.discountPaise && line.discountPaise > 0 ? { discount: paiseToRupeeText(line.discountPaise) } : {})
        }
      })
      const pos = parsed.placeOfSupply && parsed.placeOfSupply !== (supplier.stateCode ?? m.company.stateCode) ? parsed.placeOfSupply : undefined
      built = buildInvoiceDraft(w, {
        kind: 'purchase',
        partyLedgerId: supplier.id,
        ...(parsed.date ? { date: parsed.date } : {}),
        ...(mapping.accountLedgerId ? { accountLedgerId: mapping.accountLedgerId } : {}),
        items,
        ...(pos ? { placeOfSupply: pos } : {}),
        narration: noteFor(input.item.fileName),
        ...(parsed.invoiceNo ? { billNo: parsed.invoiceNo.trim().slice(0, 80) } : {}),
        ...(parsed.dueDate ? { dueDate: parsed.dueDate } : {})
      })
    } else {
      built = buildLedgerPurchase(w, supplier, maps, parsed, input.item.fileName)
    }
  } catch (err) {
    if (err instanceof NeedsClarification) {
      for (const c of w.clarifications) review.questions.push({ field: c.field, said: c.said, question: c.question, candidates: c.candidates })
      return { status: 'needs_review', review, supplierLedgerId: supplier.id }
    }
    return { status: 'failed', review, supplierLedgerId: supplier.id, error: (err as Error).message }
  }

  // The editor's GST vs the printed GST, and the totals.
  let computedTax: number
  if (built.payload.form === 'invoice') {
    const c = computeInvoice(built.payload.state as InvoiceFormState, invoiceCtx(m, 'purchase'))
    computedTax = c.gst.cgst + c.gst.sgst + c.gst.igst + c.gst.cess
  } else {
    computedTax = (built.payload.total ?? 0) - built.payload.lines.filter((l) => l.drCr === 'dr' && !m.ledgers.find((x) => x.id === l.ledgerId)?.taxType).reduce((s, l) => s + l.amount, 0)
  }
  const draftTotal = built.payload.total ?? 0
  review.taxCheck = { computed: computedTax, printed: totals.tax, computedTotal: draftTotal, printedTotal: totals.printedTotal }
  const extra: string[] = []
  if (computedTax !== totals.tax) extra.push(`The bill prints GST of ${rs(totals.tax)}; the editor's calculation from the masters gives ${rs(computedTax)} (difference ${rs(totals.tax - computedTax)}) — check the GST rates before saving`)
  if (totals.printedTotal != null && totals.printedTotal !== draftTotal) extra.push(`The bill's total is ${rs(totals.printedTotal)}; this draft totals ${rs(draftTotal)} (difference ${rs(totals.printedTotal - draftTotal)})`)
  for (const d of totals.discrepancies) extra.push(`On the bill: ${d}`)
  for (const wmsg of parsed.warnings) extra.push(`Not read: ${wmsg}`)
  if (parsed.confidence === 'low') extra.push('The reading of this bill is marked low-confidence — compare every line with the file')
  if (flagged) extra.push(`Possible duplicate: ${flagged.why}`)
  const dupSource: AiDraftSourceRef[] = flagged?.voucherId ? [{ field: 'reference', kind: 'voucher', label: `Possible duplicate ${flagged.number} (${flagged.date})`, id: flagged.voucherId, why: flagged.why }] : []
  const payload = {
    ...built.payload,
    assumptions: [...(built.payload.assumptions ?? []), ...extra],
    sources: [...(built.payload.sources ?? []), ...dupSource],
    captureItemId: input.item.id
  }
  review.assumptions = payload.assumptions
  const draft = db.transaction(() => {
    const d = insertDraft(db, { threadId: null, messageId: null, summary: built.summary, payload, unrequested: false, source: 'capture', origin: input.item.fileName.slice(0, 120) })
    writeAudit(db, 'ai_draft', d.id, 'create', null, { tool: 'capture', captureItemId: input.item.id, summary: built.summary, payload, source: 'capture', origin: d.origin })
    return d
  })()
  return { status: 'drafted', review, supplierLedgerId: supplier.id, draft, duplicate: flagged }
}
