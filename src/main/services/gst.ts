import { writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import { applyCapitalGoodsExtraTax } from './fixedAssets'
import type { CompanyInfo, TradePurpose } from '@shared/domain'
import type { Gstr3bView } from '@shared/gst/views'
import { POSTED_TAX_ROUNDING_PAISE, ratedLinesUnexplained, resolvePostedRates, type PostedRateLine, type PostedRates } from '@shared/gst/postedRate'
export type { Gstr3bView }
import {
  buildGstr1, buildGstr3b, circular170Inputs, classifyDoc, isZeroRatedTyp,
  type GstAdvanceAgg, type GstDoc, type GstDocRateItem, type GstDocSeries, type GstHsnLine,
  type GstNilLine, type Gstr1Extras, type Gstr1Result, type Gstr3bResult, type InwardSummary,
  type ItcBreakdown, type TaxTotals
} from '@shared/gst/returns'
import { backOutAdvance, computeGst, supplyTypeFor } from '@shared/gst/calc'
import { spreadPosted } from '@shared/gst/postedSpread'
import { toUqc } from '@shared/gst/uqc'
import { validateGstr1, type GstIssue } from '@shared/gst/validate'
import { fyFromStartYear, fyOf } from '@shared/dates'
import { plainRupees } from '@shared/money'
import { parseGstr2b, reconcile2b, type PurchaseDoc, type Recon2bOptions, type Recon2bResult } from '@shared/gst/recon2b'
import { cashBankGroupIds, descendantIdsByName } from './masters'
import { getGst3bManual, getGstProfile } from './config'
import { einvoiceApplicability, type EinvoiceApplicability } from '@shared/gst/einvoiceApplicability'
import { einvoiceTurnOnNotice, type EinvoiceStatus } from '@shared/compliance'
import { companyExportsDir } from '../paths'
import { IN_BOOKS } from './vouchers'
import { chargesGstOn } from '@shared/gst/registration'
import { hasTradeSchema } from './tradeLinks'
import { writeAudit } from './audit'
import { lineSnapSql, partySnapSql, partySnapshots, withPartySnap } from './taxFacts'
import { openingBillsByParty, openingEvents } from './openingBills'

interface DocVoucherRow {
  id: number; date: string; number: string; kind: 'sales' | 'credit_note' | 'debit_note'
  posOverride: string | null
  partyName: string | null; partyGstin: string | null; partyState: string | null
  partyExportType: 'sez_wp' | 'sez_wop' | 'exp_wp' | 'exp_wop' | null
  partyRcm: number
  transDocNo: string | null; transDocDate: string | null
}

const INCOME_GROUPS = ['Sales Accounts', 'Direct Incomes', 'Indirect Incomes']

/**
 * Debit notes are dual-use in the books (sales price revision vs purchase return). A debit
 * note counts as an OUTWARD document — reachable by GSTR-1 — when it credits an income-group
 * ledger, or failing that when its party sits under Sundry Debtors (a customer). Everything
 * else stays purchase-side (GSTR-3B ITC / 2B reconciliation).
 */
export function outwardDebitNoteIds(db: DB, from: string, to: string): Set<number> {
  const rows = db
    .prepare(
      `SELECT v.id, v.party_ledger_id AS partyLedgerId
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vt.kind = 'debit_note' AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}`
    )
    .all(from, to) as { id: number; partyLedgerId: number | null }[]
  if (!rows.length) return new Set()
  const incomeIds = descendantIdsByName(db, INCOME_GROUPS)
  // Owner decision (4 Nov, PR #188): GST returns stay exactly as on main — the outward / inward
  // split keeps the SEEDED Sundry Debtors tree, so no filed month moves for a party under an
  // imported group name (revisit in Phase 2 behind the upgrade-diff report; to-do §4 GST).
  const debtorIds = descendantIdsByName(db, ['Sundry Debtors'])
  const lineStmt = db.prepare(
    `SELECT l.group_id AS groupId FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
     WHERE vl.voucher_id = ? AND vl.dr_cr = 'cr'`
  )
  const partyStmt = db.prepare('SELECT group_id AS groupId FROM ledgers WHERE id = ?')
  const out = new Set<number>()
  for (const r of rows) {
    const crGroups = (lineStmt.all(r.id) as { groupId: number }[]).map((x) => x.groupId)
    if (crGroups.some((g) => incomeIds.has(g))) {
      out.add(r.id)
      continue
    }
    if (r.partyLedgerId != null) {
      const p = partyStmt.get(r.partyLedgerId) as { groupId: number } | undefined
      if (p && debtorIds.has(p.groupId)) out.add(r.id)
    }
  }
  return out
}

/**
 * The GST class of an outward document — the one definition extractOutwardDocs uses, shared with
 * the interest-on-overdue debit notes (WP 4.2), which follow the original invoice's class.
 */
export function outwardSupplyClass(
  company: CompanyInfo,
  v: { partyExportType: 'sez_wp' | 'sez_wop' | 'exp_wp' | 'exp_wop' | null; partyState: string | null; posOverride: string | null }
): { invTyp: ReturnType<typeof classifyDoc>; isExport: boolean; pos: string; supply: 'intra' | 'inter'; zeroTax: boolean } {
  const invTyp = classifyDoc(v.partyExportType, v.partyState)
  const isExport = invTyp === 'EXPWP' || invTyp === 'EXPWOP'
  // POS precedence: per-voucher override, then party state, then company state
  // (exports default to 96 "Other Country" when the party has no state code).
  const pos = v.posOverride ?? v.partyState ?? (isExport ? '96' : company.stateCode)
  // SEZ/export supplies are ALWAYS inter-state (sec 7(5)(b) IGST Act) — an SEZ unit in
  // the company's own state still gets IGST, never CGST/SGST. POS stays the real state.
  const supply = isZeroRatedTyp(invTyp) ? 'inter' : supplyTypeFor(company.stateCode, pos)
  // Without-payment zero-rated supplies charge no tax at all.
  const zeroTax = invTyp === 'SEWOP' || invTyp === 'EXPWOP'
  return { invTyp, isExport, pos, supply, zeroTax }
}

// One prepared statement per connection (postedLineRates runs once per ledger-line document).
const postedTaxStmts = new WeakMap<DB, { get(salesSide: string, voucherId: number): unknown }>()

/**
 * Rates of a ledger-line document's sales-side lines. The ledger's rate is the fallback; when the
 * voucher POSTS CGST / SGST / IGST the rate-less lines take the rate the posted tax implies
 * (shared/gst/postedRate.ts) — an amount-only sale on a rate-less Sales ledger is not nil-rated.
 * Shared by extractOutwardDocs and the e-document extractor.
 */
export function postedLineRates(
  db: DB, voucherId: number, salesSide: 'cr' | 'dr', lines: PostedRateLine[], supply: 'intra' | 'inter', date: string
): PostedRates {
  let stmt = postedTaxStmts.get(db)
  if (!stmt) {
    stmt = db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = ? THEN vl.amount ELSE -vl.amount END), 0) AS t
       FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
       WHERE vl.voucher_id = ? AND l.tax_type IN ('cgst', 'sgst', 'igst')`
    )
    postedTaxStmts.set(db, stmt)
  }
  const posted = (stmt.get(salesSide, voucherId) as { t: number }).t
  // Review of #187: a rated line is re-rated only when the document's value ties — the party is
  // charged the sales lines + the posted tax + cess (+ TCS), within the rounding. Read only when a
  // rated line's master rate leaves the posted tax unexplained (otherwise it can't matter).
  if (!ratedLinesUnexplained(lines, posted, supply)) return resolvePostedRates(lines, posted, supply, date)
  // Prepared per call (rare: only an unexplained rated line gets here) — it names the cash / bank
  // groups as they are now.
  const facts = db.prepare(
      `SELECT
         (SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = ? THEN vl.amount ELSE -vl.amount END), 0) FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
          WHERE vl.voucher_id = ? AND vl.ledger_id = v.party_ledger_id) AS party,
         (SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = ? THEN vl.amount ELSE -vl.amount END), 0) FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
          WHERE vl.voucher_id = ? AND l.tax_type = 'cess') AS cess,
         (SELECT COALESCE(SUM(te.tds_amount), 0) FROM tds_entries te JOIN tds_sections ts ON ts.id = te.section_id
          WHERE te.voucher_id = ? AND ts.kind = 'tcs') AS tcs,
         (SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = ? THEN vl.amount ELSE -vl.amount END), 0) FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
          WHERE vl.voucher_id = ? AND l.group_id IN (${[...cashBankGroupIds(db)].join(',') || 'NULL'})) AS cash,
         (SELECT party_ledger_id IS NOT NULL FROM vouchers WHERE id = ?) AS hasParty`
  )
  const partySide = salesSide === 'cr' ? 'dr' : 'cr'
  const f = facts.get(partySide, voucherId, salesSide, voucherId, voucherId, partySide, voucherId, voucherId) as { party: number; cash: number; hasParty: number; cess: number; tcs: number }
  const taxable = lines.reduce((s, l) => s + l.taxable, 0)
  // CodeRabbit on #187: a sale with no party ledger (a cash bill) is charged on its cash / bank lines.
  const charged = f.hasParty ? f.party : f.cash
  const valueTies = charged > 0 && Math.abs(charged - f.tcs - (taxable + posted + f.cess)) <= lines.length + POSTED_TAX_ROUNDING_PAISE
  return resolvePostedRates(lines, posted, supply, date, { valueTies })
}

/** Bill names asked per statement (5 variables each — well under SQLite's 32,766, review of #187). */
const ORIGINAL_NAMES_PER_QUERY = 400

/**
 * The ORIGINAL invoice of each credit / outward debit note (GSTR-1 9B CDNUR vs B2CS is decided by
 * it — returns.ts buildGstr1), never guessed: its `return` line links when they all point at ONE
 * invoice; else (review of #187) the name(s) it is set `against`, or failing bill refs its
 * reference — accepted only when that name can mean exactly ONE bill of the party dated on /
 * before the note and that bill is a sales invoice in the books. A name's candidates are every
 * unbinned voucher of the party opening a bill of that name (a `new` ref, or a sales invoice of
 * that number without refs — and, for a reference, any sales invoice of that number dated in the
 * note's FY or the one before) and the party's opening bills of that name (an unnamed opening is
 * the bill "Opening") — the books settle a name against the OLDEST open one and numbers restart
 * every year, so two candidates are never told apart here. Several names against must all mean the
 * same invoice. Not found = the note is judged by its own value, as before. The original carries
 * its debit side (as `invoiceValue`), its date (the B2CL limit in force then) and, from
 * outwardSupplyClass on its own row (its override, else its party snapshot), its place of supply,
 * whether its buyer was registered and its export type. In chunks of 500 notes.
 */
function originalInvoices(db: DB, company: CompanyInfo, notes: { id: number; date: string }[]): Map<number, NonNullable<GstDoc['original']>> {
  const out = new Map<number, NonNullable<GstDoc['original']>>()
  const o = IN_BOOKS.replace(/\bv\./g, 'o.')
  for (let i = 0; i < notes.length; i += 500) {
    const chunk = notes.slice(i, i + 500)
    const marks = chunk.map(() => '?').join(',')
    const found = new Map<number, number>()
    // Return links: accepted only when the note links to exactly one invoice, in the books.
    const linkedNotes = new Set<number>()
    for (const r of db
      .prepare(
        `SELECT ll.to_voucher_id AS noteId, COUNT(DISTINCT ll.from_voucher_id) AS n, MIN(ll.from_voucher_id) AS origId,
                MIN(CASE WHEN ot.kind = 'sales' AND ${o} THEN 1 ELSE 0 END) AS ok
         FROM line_links ll JOIN vouchers o ON o.id = ll.from_voucher_id JOIN voucher_types ot ON ot.id = o.voucher_type_id
         WHERE ll.to_voucher_id IN (${marks}) AND ll.link_type = 'return'
         GROUP BY ll.to_voucher_id`
      )
      .all(...chunk.map((n) => n.id)) as { noteId: number; n: number; origId: number; ok: number }[]) {
      linkedNotes.add(r.noteId)
      if (r.n === 1 && r.ok) found.set(r.noteId, r.origId)
    }

    // The names each remaining note could mean: the bills it is set against, else its reference.
    const rest = chunk.filter((n) => !found.has(n.id))
    if (rest.length) {
      const restMarks = rest.map(() => '?').join(',')
      const head = new Map((db.prepare(`SELECT id, party_ledger_id AS partyId, reference FROM vouchers WHERE id IN (${restMarks})`)
        .all(...rest.map((n) => n.id)) as { id: number; partyId: number | null; reference: string | null }[]).map((r) => [r.id, r]))
      const against = new Map<number, Set<string>>()
      for (const r of db.prepare(`SELECT voucher_id AS id, name FROM bill_refs WHERE voucher_id IN (${restMarks}) AND kind = 'against'`)
        .all(...rest.map((n) => n.id)) as { id: number; name: string }[]) against.set(r.id, (against.get(r.id) ?? new Set()).add(r.name))
      // A reference names an invoice of the note's FY or the one before (numbers restart each FY).
      const asks: { noteId: number; party: number; date: string; from: string; name: string; path: 'bill' | 'ref' }[] = []
      for (const n of rest) {
        const h = head.get(n.id)
        if (!h || h.partyId == null) continue
        const names = against.get(n.id)
        if (names?.size) for (const name of names) asks.push({ noteId: n.id, party: h.partyId, date: n.date, from: '0000-00-00', name, path: 'bill' })
        else if (h.reference?.trim()) {
          const from = fyFromStartYear(fyOf(n.date).startYear - 1).from
          asks.push({ noteId: n.id, party: h.partyId, date: n.date, from, name: h.reference.trim(), path: 'ref' })
        }
      }
      // Every voucher each name could mean (bounded number of names per statement).
      const cands = new Map<string, { id: number; invoice: boolean }[]>()
      const key = (a: { noteId: number; name: string }): string => `${a.noteId}\u0000${a.name}`
      for (let k = 0; k < asks.length; k += ORIGINAL_NAMES_PER_QUERY) {
        const part = asks.slice(k, k + ORIGINAL_NAMES_PER_QUERY)
        const rows = db
          .prepare(
            `WITH q(noteId, party, d, f, name, path) AS (VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')})
             SELECT q.noteId, q.name, v.id, (vt.kind = 'sales' AND ${IN_BOOKS}) AS invoice
             FROM q JOIN vouchers v ON v.party_ledger_id = q.party AND v.deleted_at IS NULL AND v.date <= q.d AND v.date >= q.f AND v.id <> q.noteId
             JOIN voucher_types vt ON vt.id = v.voucher_type_id
             WHERE EXISTS (SELECT 1 FROM bill_refs b WHERE b.voucher_id = v.id AND b.kind = 'new' AND b.name = q.name)
                OR (vt.kind = 'sales' AND v.number = q.name
                    AND (q.path = 'ref' OR NOT EXISTS (SELECT 1 FROM bill_refs b WHERE b.voucher_id = v.id AND b.kind = 'new')))`
          )
          .all(...part.flatMap((a) => [a.noteId, a.party, a.date, a.from, a.name, a.path])) as { noteId: number; name: string; id: number; invoice: number }[]
        for (const r of rows) {
          const list = cands.get(key(r)) ?? []
          if (!list.some((c) => c.id === r.id)) list.push({ id: r.id, invoice: !!r.invoice })
          cands.set(key(r), list)
        }
      }
      // The parties' opening bills carry names too.
      const parties = [...new Set(asks.map((a) => a.party))]
      const openingBills = openingBillsByParty(db, parties)
      const openingOf = new Map<number, number>()
      for (let k = 0; k < parties.length; k += 500) {
        const part = parties.slice(k, k + 500)
        for (const r of db.prepare(`SELECT id, opening_balance AS opening FROM ledgers WHERE id IN (${part.map(() => '?').join(',')})`).all(...part) as { id: number; opening: number }[]) {
          openingOf.set(r.id, r.opening)
        }
      }
      const openingNames = (party: number, date: string): Set<string> =>
        new Set(openingEvents(date, openingOf.get(party) ?? 0, 1, openingBills.get(party)).map((e) => e.number))
      const byNote = new Map<number, typeof asks>()
      for (const a of asks) byNote.set(a.noteId, [...(byNote.get(a.noteId) ?? []), a])
      for (const [noteId, list] of byNote) {
        let only: number | null = null
        const ok = list.every((a) => {
          const c = cands.get(key(a)) ?? []
          if (openingNames(a.party, a.date).has(a.name) || c.length !== 1 || !c[0]!.invoice) return false
          if (only != null && only !== c[0]!.id) return false
          only = c[0]!.id
          return true
        })
        if (ok && only != null) found.set(noteId, only)
      }
    }
    if (found.size === 0) continue
    const ids = [...new Set(found.values())]
    const snaps = partySnapshots(db, ids)
    const facts = new Map(
      (db
        .prepare(
          `SELECT o.id, o.date, o.pos_override AS posOverride, p.state_code AS partyState, p.export_type AS partyExportType, p.gstin AS partyGstin,
                  (SELECT COALESCE(SUM(amount), 0) FROM voucher_lines WHERE voucher_id = o.id AND dr_cr = 'dr') AS total
           FROM vouchers o LEFT JOIN ledgers p ON p.id = o.party_ledger_id WHERE o.id IN (${ids.map(() => '?').join(',')})`
        )
        .all(...ids) as { id: number; date: string; posOverride: string | null; partyState: string | null; partyExportType: DocVoucherRow['partyExportType']; partyGstin: string | null; total: number }[])
        .map((r) => [r.id, withPartySnap(r, snaps.get(r.id))])
    )
    for (const [noteId, origId] of found) {
      const f = facts.get(origId)
      if (!f) continue
      const c = outwardSupplyClass(company, f)
      out.set(noteId, {
        invoiceValue: f.total, pos: c.pos, date: f.date,
        ...(f.partyGstin?.trim() ? { registered: true } : {}),
        ...(c.invTyp === 'EXPWP' || c.invTyp === 'EXPWOP' ? { exportTyp: c.invTyp } : {})
      })
    }
  }
  return out
}

/**
 * Extract outward GST documents (sales + credit notes + outward debit notes) for a period.
 *
 * Tax is computed ONCE per line (computeGst on the line's taxable at its master rate) and
 * both the per-rate items and the HSN lines are sums of those line-level paise — the shared
 * bucketing path that makes Tables 4-7 tie to Table 12 exactly (audit D2). Rate-0 lines go
 * to nilLines (Table 8), never into the rated buckets. SEWOP/EXPWOP (without-payment)
 * documents are zero-rated with no tax charged.
 */
export function extractOutwardDocs(db: DB, company: CompanyInfo, from: string, to: string): GstDoc[] {
  // CGST Act s.18(6) / rule 44(6) proviso: a capital good sold below its credit pays the excess as
  // output tax (services/fixedAssets.ts) — added to its tax invoice's document so GSTR-1, 3B, 9 and
  // the HSN summary agree with the books. A company without such sales gets the docs unchanged.
  return applyCapitalGoodsExtraTax(db, extractOutwardDocsRaw(db, company, from, to), from, to)
}

function extractOutwardDocsRaw(db: DB, company: CompanyInfo, from: string, to: string): GstDoc[] {
  // To-do §4: a voucher's own tax-fact snapshot (services/taxFacts.ts) wins over today's masters.
  const itemFacts = lineSnapSql(db, 'v', 'il', 'si')
  const ledgerFacts = lineSnapSql(db, 'v', 'vl', 'l')
  const scanned = db
    .prepare(
      `SELECT v.id, v.date, v.number, vt.kind, v.pos_override AS posOverride,
              p.name AS partyName, p.gstin AS partyGstin, p.state_code AS partyState,
              p.export_type AS partyExportType, COALESCE(p.rcm, 0) AS partyRcm,
              t.trans_doc_no AS transDocNo, t.trans_doc_date AS transDocDate
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       LEFT JOIN voucher_transport t ON t.voucher_id = v.id
       WHERE vt.kind IN ('sales', 'credit_note', 'debit_note') AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(from, to) as DocVoucherRow[]
  const partySnaps = partySnapshots(db, scanned.map((v) => v.id))
  const vouchers = scanned.map((v) => withPartySnap(v, partySnaps.get(v.id)))

  const outwardDbn = outwardDebitNoteIds(db, from, to)
  const salesGroupIds = descendantIdsByName(db, INCOME_GROUPS)

  // WP 7.1: each document's item lines, total and TCS are read for the whole period in chunks of
  // 500 vouchers (one query per chunk, not three per voucher); per voucher, lines keep their order.
  type InvRow = { qtyMilli: number; amount: number; itemName: string; hsn: string | null; gstRate: number | null; cessRate: number | null; uqc: string }
  const invBy = new Map<number, InvRow[]>()
  const totalBy = new Map<number, number>()
  const tcsBy = new Map<number, number>()
  // PR #190 review: per note, its POSTED GST heads (net on the tax side) and how many of its item
  // lines are `return` links — a return note reports the tax it posted (see below).
  const noteIds = new Set(vouchers.filter((v) => v.kind === 'credit_note' || v.kind === 'debit_note').map((v) => v.id))
  const postedBy = new Map<number, { cgst: number; sgst: number; igst: number; cess: number }>()
  const returnLinksBy = new Map<number, number>()
  // Only notes simple Returns made (simple_posts, a return_sale / return_purchase intent — the
  // only writer of a running-total tax). Every other note, an accountant's or a seeded one whose
  // heads split the tax another way, is reported line by line exactly as before.
  const simpleReturnNotes = new Set<number>()
  if (noteIds.size && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'simple_posts'").get()) {
    for (const r of db.prepare("SELECT voucher_ids_json AS ids FROM simple_posts WHERE kind IN ('return_sale', 'return_purchase')").all() as { ids: string }[]) {
      for (const e of JSON.parse(r.ids) as { role?: string; voucherId: number }[]) if (e.role === 'note' && noteIds.has(e.voucherId)) simpleReturnNotes.add(e.voucherId)
    }
  }
  const docIds = vouchers.map((v) => v.id)
  for (let i = 0; i < docIds.length; i += 500) {
    const chunk = docIds.slice(i, i + 500)
    const marks = chunk.map(() => '?').join(',')
    const invRows = db
      .prepare(
        `SELECT il.voucher_id AS voucherId, il.qty_milli AS qtyMilli, il.amount,
                si.name AS itemName, ${itemFacts.hsn} AS hsn, ${itemFacts.gstRate} AS gstRate, ${itemFacts.cessRate} AS cessRate,
                u.uqc
         FROM inventory_lines il
         JOIN vouchers v ON v.id = il.voucher_id
         JOIN stock_items si ON si.id = il.stock_item_id
         JOIN units u ON u.id = si.unit_id
         WHERE il.voucher_id IN (${marks}) ORDER BY il.voucher_id, il.line_order, il.id`
      )
      .all(...chunk) as (InvRow & { voucherId: number })[]
    for (const { voucherId, ...r } of invRows) {
      const list = invBy.get(voucherId)
      if (list) list.push(r)
      else invBy.set(voucherId, [r])
    }
    for (const r of db.prepare(`SELECT voucher_id AS id, SUM(amount) AS t FROM voucher_lines WHERE voucher_id IN (${marks}) AND dr_cr = 'dr' GROUP BY voucher_id`).all(...chunk) as { id: number; t: number }[]) totalBy.set(r.id, r.t)
    for (const r of db
      .prepare(
        `SELECT te.voucher_id AS id, SUM(te.tds_amount) AS t FROM tds_entries te JOIN tds_sections ts ON ts.id = te.section_id
         WHERE te.voucher_id IN (${marks}) AND ts.kind = 'tcs' GROUP BY te.voucher_id`
      )
      .all(...chunk) as { id: number; t: number }[]) tcsBy.set(r.id, r.t)
    const notes = chunk.filter((id) => noteIds.has(id))
    if (notes.length) {
      const nm = notes.map(() => '?').join(',')
      for (const r of db
        .prepare(
          `SELECT vl.voucher_id AS id, l.tax_type AS head, vl.dr_cr AS drCr, SUM(vl.amount) AS t FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
           WHERE vl.voucher_id IN (${nm}) AND l.tax_type IN ('cgst', 'sgst', 'igst', 'cess') GROUP BY vl.voucher_id, l.tax_type, vl.dr_cr`
        )
        .all(...notes) as { id: number; head: 'cgst' | 'sgst' | 'igst' | 'cess'; drCr: 'dr' | 'cr'; t: number }[]) {
        const kind = vouchers.find((x) => x.id === r.id)!.kind
        // A credit note reverses output tax on the debit side; an outward debit note adds it on the credit side.
        const sign = (kind === 'credit_note') === (r.drCr === 'dr') ? 1 : -1
        const p = postedBy.get(r.id) ?? { cgst: 0, sgst: 0, igst: 0, cess: 0 }
        p[r.head] += sign * r.t
        postedBy.set(r.id, p)
      }
      for (const r of db
        .prepare(`SELECT ll.to_voucher_id AS id, COUNT(*) AS n FROM line_links ll WHERE ll.to_voucher_id IN (${nm}) AND ll.link_type = 'return' GROUP BY ll.to_voucher_id`)
        .all(...notes) as { id: number; n: number }[]) returnLinksBy.set(r.id, r.n)
    }
  }
  const lineStmt = db.prepare(
    `SELECT vl.amount, vl.dr_cr AS drCr, l.group_id AS groupId, ${ledgerFacts.gstRate} AS gstRate, ${ledgerFacts.cessRate} AS cessRate, ${ledgerFacts.hsn} AS hsn, l.name
     FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id JOIN ledgers l ON l.id = vl.ledger_id
     WHERE vl.voucher_id = ? ORDER BY vl.line_order, vl.id`
  )
  // WP 3.3: income-tax TCS on the invoice is part of the invoice value (the buyer's total, as the
  // e-invoice reports it in OthChrg / TotInvVal) but not of the GST value of supply (CBIC
  // Circular 76/50/2018-GST corrigendum 7-3-2019 — see services/tcs.ts tcsOnVoucher), so the
  // value-mismatch check leaves it out (tcsBy, read above).
  // WP 8.0: a bill dated while the company is composition / unregistered charges no GST, so its
  // lines are reported at 0% (the item / ledger master's rate never applies) — except a voucher
  // that actually posts tax (saved before the rule, or a note against a regular-period bill).
  // Decided per voucher by ITS date, so a later change of registration never rewrites past returns.
  const taxLineStmt = db.prepare(
    `SELECT 1 FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
     WHERE vl.voucher_id = ? AND l.tax_type IN ('cgst', 'sgst', 'igst', 'cess') LIMIT 1`
  )

  // Notes to an unregistered, non-export buyer carry their original invoice (CDNUR vs B2CS).
  const outward = vouchers.filter((v) => v.kind !== 'debit_note' || outwardDbn.has(v.id))
  const originals = originalInvoices(
    db,
    company,
    outward.flatMap((v) => (v.kind === 'sales' || v.partyGstin || outwardSupplyClass(company, v).isExport ? [] : [{ id: v.id, date: v.date }]))
  )

  return outward
    .map((v) => {
      const { invTyp, isExport, pos, supply, zeroTax } = outwardSupplyClass(company, v)
      const rated = chargesGstOn(company, v.date) || !!taxLineStmt.get(v.id)

      const inv = invBy.get(v.id) ?? []

      interface Bucket { rate: number; taxable: number; cgst: number; sgst: number; igst: number; cess: number }
      const buckets = new Map<number, Bucket>()
      const hsnLines: GstHsnLine[] = []
      const nilLines: GstNilLine[] = []
      let missingHsnCount = 0
      let computedTotal = 0
      let offSlabRate = false

      // The one shared bucketing path: compute per LINE, then only ever sum. Lines are collected
      // first so a return note can report its posted heads (spreadPosted) before they are summed.
      interface DocLine { taxable: number; rate: number; cessRate: number; hsn: string | null; description: string; uqc: string; qtyMilli: number }
      const docLines: DocLine[] = []
      const collect = (taxable: number, rate: number, cessRate: number, hsn: string | null, description: string, uqc: string, qtyMilli: number): void => {
        docLines.push({ taxable, rate, cessRate, hsn, description, uqc, qtyMilli })
      }
      const addLine = (
        { taxable, rate, hsn, description, uqc, qtyMilli }: DocLine,
        g: { cgst: number; sgst: number; igst: number; cess: number }
      ): void => {
        computedTotal += taxable + g.cgst + g.sgst + g.igst + g.cess
        if (rate === 0) {
          nilLines.push({ taxable })
        } else {
          // D1 fix: bucket key is the RATE alone; cess sums within the rate bucket.
          const b = buckets.get(rate) ?? { rate, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 }
          b.taxable += taxable
          b.cgst += g.cgst
          b.sgst += g.sgst
          b.igst += g.igst
          b.cess += g.cess
          buckets.set(rate, b)
        }
        if (hsn) {
          hsnLines.push({
            hsn, description, uqc, qtyMilli, rate,
            taxable, cgst: g.cgst, sgst: g.sgst, igst: g.igst, cess: g.cess
          })
        } else {
          missingHsnCount++
        }
      }

      if (inv.length > 0) {
        for (const line of inv) {
          // Normalise the unit's UQC through the alias mapper; genuinely unknown codes are
          // kept as-is so the validation panel can flag them (never silently 'OTH').
          const mapped = toUqc(line.uqc)
          const uqc = mapped.fallback ? line.uqc : mapped.uqc
          collect(line.amount, rated ? (line.gstRate ?? 0) : 0, rated ? (line.cessRate ?? 0) : 0, line.hsn, line.itemName, uqc, line.qtyMilli)
        }
      } else {
        const lines = lineStmt.all(v.id) as {
          amount: number; drCr: 'dr' | 'cr'; groupId: number; gstRate: number | null; cessRate: number | null; hsn: string | null; name: string
        }[]
        // Sales side: credit lines on sales/debit notes, debit lines on credit notes.
        const salesSide = v.kind === 'credit_note' ? 'dr' : 'cr'
        const salesLines = lines.filter((l) => l.drCr === salesSide && salesGroupIds.has(l.groupId))
        // A voucher that posts tax is reported at the rate the posted tax implies on rate-less lines.
        const resolved =
          rated && !zeroTax
            ? postedLineRates(db, v.id, salesSide, salesLines.map((l) => ({ taxable: l.amount, rate: l.gstRate })), supply, v.date)
            : null
        if (resolved?.offSlab) offSlabRate = true
        salesLines.forEach((line, i) => {
          // WP 4.2: a ledger can carry a cess rate (migration 032) — absent = no cess, as before.
          collect(
            line.amount, rated ? (resolved ? resolved.rates[i]! : (line.gstRate ?? 0)) : 0, rated ? (line.cessRate ?? 0) : 0,
            line.hsn, line.name, 'OTH', 0
          )
        })
      }
      const taxes = docLines.map((l) => (zeroTax ? { cgst: 0, sgst: 0, igst: 0, cess: 0 } : computeGst(l.taxable, l.rate, supply, l.cessRate)))
      // PR #190 review: a RETURN note reports the GST it posted, not its lines recomputed one by
      // one — a return made from the running total (simple Returns) posts each head a paisa or so
      // away from that, and the bill + its returns must net to what the books hold. A return note
      // = one simple Returns made (simpleReturnNotes) with every item line a `return` link, or (no
      // item lines) whose posted heads are within a paisa per line of the computation. Each head is
      // spread over the lines (spreadPosted: by their computed tax, never below zero); any other
      // document is computed exactly as before.
      const posted = postedBy.get(v.id)
      const returnNote =
        rated && !zeroTax && posted != null && docLines.length > 0 && simpleReturnNotes.has(v.id) &&
        (inv.length > 0
          ? returnLinksBy.get(v.id) === inv.length
          : (['cgst', 'sgst', 'igst', 'cess'] as const).every((k) => Math.abs(posted[k] - taxes.reduce((x, t) => x + t[k], 0)) <= docLines.length))
      // Equal to the lines' own tax (the editor rounds per line, #187): spreadPosted changes nothing.
      if (returnNote && (['cgst', 'sgst', 'igst', 'cess'] as const).every((k) => posted[k] >= 0)) {
        const weights = docLines.map((l) => (l.rate > 0 ? l.taxable : 0))
        for (const k of ['cgst', 'sgst', 'igst', 'cess'] as const) {
          const spread = spreadPosted(taxes.map((t) => t[k]), posted[k], k === 'cess' ? docLines.map((l) => (l.cessRate > 0 ? l.taxable : 0)) : weights)
          spread.forEach((x, i) => (taxes[i]![k] = x))
        }
      }
      docLines.forEach((l, i) => addLine(l, taxes[i]!))

      const items: GstDocRateItem[] = [...buckets.values()].map((b) => ({
        rate: b.rate, taxable: b.taxable, cgst: b.cgst, sgst: b.sgst, igst: b.igst, cess: b.cess
      }))

      const invoiceValue = totalBy.get(v.id) ?? 0

      return {
        voucherId: v.id,
        kind: v.kind,
        date: v.date,
        number: v.number,
        partyName: v.partyName,
        partyGstin: v.partyGstin,
        pos,
        invoiceValue,
        items,
        nilLines,
        hsnLines,
        invTyp,
        rchrg: !!v.partyRcm,
        shippingBill: isExport ? { num: v.transDocNo, date: v.transDocDate } : null,
        ...(originals.has(v.id) ? { original: originals.get(v.id)! } : {}),
        validation: {
          valDiff: invoiceValue - (tcsBy.get(v.id) ?? 0) - computedTotal,
          missingHsnCount,
          ...(offSlabRate ? { offSlabRate: true } : {}),
          // SEZ/deemed-export registrations always have a GSTIN — flag its absence.
          missingGstin: (invTyp === 'SEWP' || invTyp === 'SEWOP' || invTyp === 'DE') && !v.partyGstin
        }
      }
    })
}

// ---------- inward (purchase) side ----------

const ZERO: InwardSummary = { igst: 0, cgst: 0, sgst: 0, cess: 0 }

/**
 * 3.1(d) — inward supplies liable to reverse charge: purchases from parties flagged rcm=1,
 * NET of purchase-return debit notes to those parties (goods returned reduce the RCM
 * liability and the matching ISRC credit for the period). Tax is computed at master rates
 * (item rate, else purchase-ledger rate) since RCM purchases book no input-tax lines of
 * their own. Outward (sales-side) debit notes are excluded via outwardDebitNoteIds.
 */
export function rcmInwardSummary(db: DB, company: CompanyInfo, from: string, to: string): TaxTotals {
  const total: TaxTotals = { taxable: 0, ...ZERO }
  for (const v of rcmInwardByVoucher(db, company, from, to)) {
    total.taxable += v.taxable
    total.igst += v.igst
    total.cgst += v.cgst
    total.sgst += v.sgst
    total.cess += v.cess
  }
  return total
}

/** The same 3.1(d) figures per voucher (signed: purchase returns negative) — rcmInwardSummary is
 *  their sum, so GSTR-9 Table 4G / 6C / 6D (WP 3.4) tie to the monthly 3B by construction. */
export function rcmInwardByVoucher(
  db: DB, company: CompanyInfo, from: string, to: string
): (TaxTotals & { voucherId: number; kind: 'purchase' | 'debit_note'; partyGstin: string | null })[] {
  const outwardDbn = outwardDebitNoteIds(db, from, to)
  const party = partySnapSql(db)
  const itemFacts = lineSnapSql(db, 'v', 'il', 'si')
  const ledgerFacts = lineSnapSql(db, 'v', 'vl', 'l')
  const vouchers = (db
    .prepare(
      `SELECT v.id, vt.kind, ${party.state} AS partyState, ${party.gstin} AS partyGstin
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE vt.kind IN ('purchase', 'debit_note') AND ${party.rcm} = 1 AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(from, to) as { id: number; kind: 'purchase' | 'debit_note'; partyState: string | null; partyGstin: string | null }[])
    .filter((v) => v.kind !== 'debit_note' || !outwardDbn.has(v.id))

  const purchaseGroupIds = descendantIdsByName(db, ['Purchase Accounts', 'Direct Expenses', 'Indirect Expenses'])
  const invStmt = db.prepare(
    `SELECT il.amount, ${itemFacts.gstRate} AS gstRate, ${itemFacts.cessRate} AS cessRate
     FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id JOIN stock_items si ON si.id = il.stock_item_id
     WHERE il.voucher_id = ?`
  )
  const lineStmt = db.prepare(
    `SELECT vl.amount, vl.dr_cr AS drCr, l.group_id AS groupId, ${ledgerFacts.gstRate} AS gstRate
     FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id JOIN ledgers l ON l.id = vl.ledger_id WHERE vl.voucher_id = ?`
  )

  return vouchers.map((v) => {
    const total: TaxTotals = { taxable: 0, ...ZERO }
    const supply = supplyTypeFor(company.stateCode, v.partyState ?? company.stateCode)
    // A purchase-return debit note reverses the purchase: negative sign, purchase-side
    // value sits on the CREDIT lines (mirror of extractPurchaseDocs).
    const sign = v.kind === 'debit_note' ? -1 : 1
    const purchaseSide = v.kind === 'debit_note' ? 'cr' : 'dr'
    const inv = invStmt.all(v.id) as { amount: number; gstRate: number | null; cessRate: number | null }[]
    const lines =
      inv.length > 0
        ? inv.map((l) => ({ amount: l.amount, rate: l.gstRate ?? 0, cessRate: l.cessRate ?? 0 }))
        : (lineStmt.all(v.id) as { amount: number; drCr: 'dr' | 'cr'; groupId: number; gstRate: number | null }[])
            .filter((l) => l.drCr === purchaseSide && purchaseGroupIds.has(l.groupId))
            .map((l) => ({ amount: l.amount, rate: l.gstRate ?? 0, cessRate: 0 }))
    for (const l of lines) {
      const g = computeGst(l.amount, l.rate, supply, l.cessRate)
      total.taxable += sign * l.amount
      total.igst += sign * g.igst
      total.cgst += sign * g.cgst
      total.sgst += sign * g.sgst
      total.cess += sign * g.cess
    }
    return { ...total, voucherId: v.id, kind: v.kind, partyGstin: v.partyGstin }
  })
}

/**
 * ITC itemised for GSTR-3B Table 4: booked input-tax lines on purchases/purchase-side debit
 * notes are assigned per voucher to IMPG (import — party state 96/97), blocked (4D — party
 * itc_eligibility='blocked') or OTH; RCM parties' vouchers are skipped here (their credit is
 * ISRC, computed from master rates in rcmInwardSummary). Outward debit notes are excluded —
 * their tax lines are OUTPUT tax, not ITC (they used to be silently subtracted).
 */
export function itcBreakdown(db: DB, company: CompanyInfo, from: string, to: string): ItcBreakdown {
  const result: ItcBreakdown = {
    impg: { ...ZERO }, isrc: { ...ZERO }, oth: { ...ZERO }, blocked: { ...ZERO }
  }
  for (const r of bookedItcByVoucher(db, from, to)) {
    const bucket = r.bucket === 'blocked' ? result.blocked : r.bucket === 'impg' ? result.impg : result.oth
    bucket.igst += r.igst
    bucket.cgst += r.cgst
    bucket.sgst += r.sgst
    bucket.cess += r.cess
  }
  const rcm = rcmInwardSummary(db, company, from, to)
  result.isrc = { igst: rcm.igst, cgst: rcm.cgst, sgst: rcm.sgst, cess: rcm.cess }
  return result
}

/**
 * The booked (non-RCM) input-tax lines per purchase-side voucher, bucketed as itcBreakdown
 * buckets them — itcBreakdown is their sum (WP 3.4: GSTR-9 Table 6 and the ITC-reversal
 * workings read the same rows, so they tie to the monthly 3B by construction).
 */
export function bookedItcByVoucher(
  db: DB, from: string, to: string
): (InwardSummary & { voucherId: number; kind: 'purchase' | 'debit_note'; bucket: 'impg' | 'oth' | 'blocked'; itcEligibility: string })[] {
  const outwardDbn = outwardDebitNoteIds(db, from, to)
  const scanned = db
    .prepare(
      `SELECT v.id AS voucherId, vt.kind, l.tax_type AS taxType,
              SUM(CASE
                    WHEN vt.kind = 'purchase' AND vl.dr_cr = 'dr' THEN vl.amount
                    WHEN vt.kind = 'debit_note' AND vl.dr_cr = 'cr' THEN -vl.amount
                    ELSE 0
                  END) AS amount,
              p.state_code AS partyState, COALESCE(p.rcm, 0) AS partyRcm,
              COALESCE(p.itc_eligibility, 'eligible') AS itcEligibility
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN ledgers l ON l.id = vl.ledger_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE l.tax_type IS NOT NULL AND vt.kind IN ('purchase', 'debit_note')
         AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       GROUP BY v.id, l.tax_type
       ORDER BY v.date, v.id`
    )
    .all(from, to) as {
      voucherId: number; kind: 'purchase' | 'debit_note'; taxType: 'cgst' | 'sgst' | 'igst' | 'cess'; amount: number
      partyState: string | null; partyRcm: number; itcEligibility: string
    }[]
  // To-do §4: a voucher's own snapshot of the party's class wins (services/taxFacts.ts).
  const partySnaps = partySnapshots(db, scanned.map((r) => r.voucherId))
  const rows = scanned.map((r) => withPartySnap(r, partySnaps.get(r.voucherId)))
  const byVoucher = new Map<number, InwardSummary & { voucherId: number; kind: 'purchase' | 'debit_note'; bucket: 'impg' | 'oth' | 'blocked'; itcEligibility: string }>()
  for (const r of rows) {
    if (r.kind === 'debit_note' && outwardDbn.has(r.voucherId)) continue
    if (r.partyRcm) continue // ISRC — computed from master rates, not booked lines
    const bucket = r.itcEligibility === 'blocked' ? 'blocked' : r.partyState === '96' || r.partyState === '97' ? 'impg' : 'oth'
    const v = byVoucher.get(r.voucherId) ?? { voucherId: r.voucherId, kind: r.kind, bucket, itcEligibility: r.itcEligibility, ...ZERO }
    v[r.taxType] += r.amount
    byVoucher.set(r.voucherId, v)
  }
  return [...byVoucher.values()]
}

/** Net booked ITC for the period (legacy shape — the on-screen "Eligible ITC" row). */
export function inwardSummary(db: DB, from: string, to: string): InwardSummary {
  // Kept for the 2B reconciliation summary; excludes outward debit notes like itcBreakdown.
  const outwardDbn = outwardDebitNoteIds(db, from, to)
  const rows = db
    .prepare(
      `SELECT v.id AS voucherId, vt.kind, l.tax_type AS taxType,
              SUM(CASE
                    WHEN vt.kind = 'purchase' AND vl.dr_cr = 'dr' THEN vl.amount
                    WHEN vt.kind = 'debit_note' AND vl.dr_cr = 'cr' THEN -vl.amount
                    ELSE 0
                  END) AS amount
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN ledgers l ON l.id = vl.ledger_id
       WHERE l.tax_type IS NOT NULL AND vt.kind IN ('purchase', 'debit_note') AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       GROUP BY v.id, l.tax_type`
    )
    .all(from, to) as { voucherId: number; kind: string; taxType: 'cgst' | 'sgst' | 'igst' | 'cess'; amount: number }[]
  const s: InwardSummary = { ...ZERO }
  for (const r of rows) {
    if (r.kind === 'debit_note' && outwardDbn.has(r.voucherId)) continue
    s[r.taxType] += r.amount
  }
  return s
}

// ---------- extras: advances, document series, turnover ----------

/**
 * 11A — advances received: receipt vouchers carrying a 'new' bill reference (money received
 * against no invoice yet) from parties whose ledger carries a GST rate. The money received
 * is tax-INCLUSIVE, so the reported ad_amt is the Rule-35 backed-out taxable value and the
 * tax is the residue (see backOutAdvance). Receipts against parties without a gst_rate
 * can't be rate-classified and are skipped — the dedicated "advance" flag on receipt entry
 * is renderer work (S4).
 */
export function extractAdvances(db: DB, company: CompanyInfo, from: string, to: string): GstAdvanceAgg[] {
  const rows = db
    .prepare(
      `SELECT br.amount, p.state_code AS partyState, p.gst_rate AS gstRate
       FROM bill_refs br
       JOIN vouchers v ON v.id = br.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN ledgers p ON p.id = br.party_ledger_id
       WHERE vt.kind = 'receipt' AND br.kind = 'new' AND p.gst_rate IS NOT NULL
         AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}`
    )
    .all(from, to) as { amount: number; partyState: string | null; gstRate: number }[]
  return aggregateAdvances(rows, company)
}

/**
 * 11B — advances adjusted: sales vouchers in the period settling ('against') a bill that a
 * receipt voucher created ('new') — i.e. an invoice issued against an earlier advance.
 */
export function extractAdvanceAdjustments(db: DB, company: CompanyInfo, from: string, to: string): GstAdvanceAgg[] {
  const rows = db
    .prepare(
      `SELECT br.amount, p.state_code AS partyState, p.gst_rate AS gstRate
       FROM bill_refs br
       JOIN vouchers v ON v.id = br.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN ledgers p ON p.id = br.party_ledger_id
       WHERE vt.kind = 'sales' AND br.kind = 'against' AND p.gst_rate IS NOT NULL
         AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
         AND EXISTS (
           SELECT 1 FROM bill_refs br2
           JOIN vouchers v2 ON v2.id = br2.voucher_id
           JOIN voucher_types vt2 ON vt2.id = v2.voucher_type_id
           WHERE br2.kind = 'new' AND br2.name = br.name AND br2.party_ledger_id = br.party_ledger_id
             AND vt2.kind = 'receipt' AND v2.deleted_at IS NULL
         )`
    )
    .all(from, to) as { amount: number; partyState: string | null; gstRate: number }[]
  return aggregateAdvances(rows, company)
}

function aggregateAdvances(
  rows: { amount: number; partyState: string | null; gstRate: number }[],
  company: CompanyInfo
): GstAdvanceAgg[] {
  const agg = new Map<string, GstAdvanceAgg>()
  for (const r of rows) {
    const pos = r.partyState ?? company.stateCode
    const supply = supplyTypeFor(company.stateCode, pos)
    const key = `${pos}|${supply}|${r.gstRate}`
    const a = agg.get(key) ?? { pos, supply, rate: r.gstRate, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 }
    // The receipt amount is money actually received — TAX-INCLUSIVE (Rule 35 CGST Rules).
    // Back the tax out of the gross; never compute it on top (that over-reported both the
    // taxable value and the tax on every advance).
    const g = backOutAdvance(r.amount, r.gstRate, supply)
    a.taxable += g.taxable
    a.cgst += g.cgst
    a.sgst += g.sgst
    a.igst += g.igst
    agg.set(key, a)
  }
  return [...agg.values()]
}

/**
 * Table 13 — documents issued, one series per sales/credit-note/debit-note voucher type.
 *
 * DELIBERATE EXCEPTION to the NOT_DELETED rule: this query reads soft-deleted (binned)
 * vouchers too — a deleted voucher consumed a number in the series, and Table 13 reports it
 * as a CANCELLED document (`cancel`), not a gap. Do not add the filter here.
 */
export function extractDocSeries(db: DB, from: string, to: string): GstDocSeries[] {
  const types = db
    .prepare(
      `SELECT DISTINCT v.voucher_type_id AS typeId, vt.kind
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vt.kind IN ('sales', 'credit_note', 'debit_note') AND v.date BETWEEN ? AND ?`
    )
    .all(from, to) as { typeId: number; kind: 'sales' | 'credit_note' | 'debit_note' }[]
  const seriesStmt = db.prepare(
    `SELECT v.number, v.deleted_at AS deletedAt
     FROM vouchers v WHERE v.voucher_type_id = ? AND v.date BETWEEN ? AND ?
     ORDER BY v.date, v.id`
  )
  const CATEGORY: Record<string, 1 | 4 | 5> = { sales: 1, debit_note: 4, credit_note: 5 }
  const result: GstDocSeries[] = []
  for (const t of types) {
    const rows = seriesStmt.all(t.typeId, from, to) as { number: string; deletedAt: string | null }[]
    if (!rows.length) continue
    result.push({
      category: CATEGORY[t.kind]!,
      from: rows[0]!.number,
      to: rows[rows.length - 1]!.number,
      totnum: rows.length,
      cancel: rows.filter((r) => r.deletedAt).length
    })
  }
  result.push(...challanDocSeries(db, from, to))
  return result.sort((a, b) => a.category - b.category)
}

/**
 * Table 13 nature of document for a delivery challan, by purpose (WP 2.5b, design §4.2 / §9 Q6).
 * The GSTR-1 form lists 9 "Delivery Challan for job work", 10 "… for supply on approval",
 * 11 "… in case of liquid gas", 12 "… in cases other than by way of supply (excluding at S no.
 * 9 to 11)". The JSON doc_num codes are taken to equal those serial numbers — UNVERIFIED against
 * the portal's offline tool. A challan for a plain supply (rule 55(4): the invoice follows
 * delivery) has no row of its own; it is reported under 12 — CONFIRM WITH YOUR CA.
 */
export const CHALLAN_DOC_CATEGORY: Record<TradePurpose, 9 | 10 | 11 | 12> = {
  job_work: 9, approval: 10, liquid_gas: 11, non_supply: 12, supply: 12,
  // GRN purposes never reach here (GRNs are not outward documents); listed for exhaustiveness.
  purchase: 12, return: 12
}

/** Delivery-challan series for Table 13: one entry per (challan voucher type, category). Binned
 *  challans count as cancelled, like every other series here (same deliberate NOT_DELETED
 *  exception). GRNs are inward documents and are not reported. */
function challanDocSeries(db: DB, from: string, to: string): GstDocSeries[] {
  if (!hasTradeSchema(db)) return []
  const rows = db
    .prepare(
      `SELECT v.voucher_type_id AS typeId, v.number, v.deleted_at AS deletedAt, COALESCE(tvd.purpose, 'supply') AS purpose
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN trade_voucher_details tvd ON tvd.voucher_id = v.id
       WHERE vt.kind = 'delivery_note' AND v.is_optional = 0 AND v.date BETWEEN ? AND ?
       ORDER BY v.voucher_type_id, v.date, v.id`
    )
    .all(from, to) as { typeId: number; number: string; deletedAt: string | null; purpose: TradePurpose }[]
  const groups = new Map<string, { category: GstDocSeries['category']; rows: typeof rows }>()
  for (const r of rows) {
    const category = CHALLAN_DOC_CATEGORY[r.purpose]
    const key = `${r.typeId}|${category}`
    const g = groups.get(key) ?? { category, rows: [] }
    g.rows.push(r)
    groups.set(key, g)
  }
  return [...groups.values()].map((g) => ({
    category: g.category,
    from: g.rows[0]!.number,
    to: g.rows[g.rows.length - 1]!.number,
    totnum: g.rows.length,
    cancel: g.rows.filter((r) => r.deletedAt).length
  }))
}

/**
 * Turnover for the GSTR-1 header: income-group movement (sales credits − credit-note debits
 * + outward debit-note credits) over a date range. Computed from the books every time —
 * never hardcoded.
 */
export function turnover(db: DB, from: string, to: string): number {
  const incomeIds = [...descendantIdsByName(db, INCOME_GROUPS)]
  if (!incomeIds.length) return 0
  const placeholders = incomeIds.map(() => '?').join(',')
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE
                WHEN vl.dr_cr = 'cr' THEN vl.amount
                ELSE -vl.amount
              END), 0) AS t
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN ledgers l ON l.id = vl.ledger_id
       WHERE l.group_id IN (${placeholders})
         AND vt.kind IN ('sales', 'credit_note', 'debit_note')
         AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}`
    )
    .get(...incomeIds, from, to) as { t: number }
  return Math.max(0, row.t)
}

function gstr1Extras(db: DB, company: CompanyInfo, from: string, to: string): Gstr1Extras {
  const fy = fyOf(from)
  const prevFy = fyOf(`${fy.startYear - 1}-06-01`)
  return {
    advances: extractAdvances(db, company, from, to),
    advanceAdjustments: extractAdvanceAdjustments(db, company, from, to),
    docSeries: extractDocSeries(db, from, to),
    gt: turnover(db, prevFy.from, prevFy.to),
    curGt: turnover(db, fy.from, to)
  }
}

// ---------- purchase docs for 2B reconciliation (unchanged behavior + outward-DBN fix) ----------

interface PurchaseVoucherRow {
  id: number; date: string; number: string; reference: string | null; kind: 'purchase' | 'debit_note'
  partyLedgerId: number | null; partyName: string | null; partyGstin: string | null
}

/**
 * Extract purchase-side documents (purchase invoices + purchase-return debit notes) for a
 * period, for GSTR-2B reconciliation. Mirrors extractOutwardDocs: taxable value from
 * inventory lines when present, otherwise from purchase-side ledger lines. Tax components
 * are the actual booked tax lines — not a recomputation — so entry errors surface in the
 * reconciliation. Outward (sales-side) debit notes are excluded.
 */
export function extractPurchaseDocs(db: DB, from: string, to: string): PurchaseDoc[] {
  const outwardDbn = outwardDebitNoteIds(db, from, to)
  // To-do §4 (review of #172): these rows feed GSTR-2B MATCHING only (recon2b, the 2B mismatch
  // assistant, simple Home's "booked, not yet confirmed"), and matching is against the portal's
  // truth — so the supplier's GSTIN is read LIVE from the ledger, never from the voucher's tax-fact
  // snapshot: a GSTIN typo fixed on the ledger heals every earlier bill's match at once (the
  // `gstin_differs` row says "fix the supplier ledger"). Returns, prints and e-documents keep the
  // snapshot (extractOutwardDocs / extractEdocInvoices / rcmInwardByVoucher / bookedItcByVoucher).
  const vouchers = (db
    .prepare(
      `SELECT v.id, v.date, v.number, v.reference, v.party_ledger_id AS partyLedgerId, vt.kind,
              p.name AS partyName, p.gstin AS partyGstin
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE vt.kind IN ('purchase', 'debit_note') AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(from, to) as PurchaseVoucherRow[])
    .filter((v) => v.kind !== 'debit_note' || !outwardDbn.has(v.id))

  const purchaseGroupIds = descendantIdsByName(db, ['Purchase Accounts', 'Direct Expenses', 'Indirect Expenses'])

  const invStmt = db.prepare(`SELECT il.amount FROM inventory_lines il WHERE il.voucher_id = ?`)
  const lineStmt = db.prepare(
    `SELECT vl.amount, vl.dr_cr AS drCr, l.group_id AS groupId, l.tax_type AS taxType
     FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
     WHERE vl.voucher_id = ? ORDER BY vl.line_order, vl.id`
  )
  const partyLineStmt = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM voucher_lines WHERE voucher_id = ? AND ledger_id = ? AND dr_cr = ?`
  )
  const totalDrStmt = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM voucher_lines WHERE voucher_id = ? AND dr_cr = 'dr'`
  )

  return vouchers.map((v) => {
    const inv = invStmt.all(v.id) as { amount: number }[]
    const lines = lineStmt.all(v.id) as { amount: number; drCr: 'dr' | 'cr'; groupId: number; taxType: string | null }[]

    let taxable = 0
    if (inv.length > 0) {
      taxable = inv.reduce((s, l) => s + l.amount, 0)
    } else {
      const purchaseSide = v.kind === 'purchase' ? 'dr' : 'cr'
      for (const line of lines) {
        if (line.drCr === purchaseSide && purchaseGroupIds.has(line.groupId)) taxable += line.amount
      }
    }

    let igst = 0, cgst = 0, sgst = 0, cess = 0
    for (const line of lines) {
      if (line.taxType === 'igst') igst += line.amount
      else if (line.taxType === 'cgst') cgst += line.amount
      else if (line.taxType === 'sgst') sgst += line.amount
      else if (line.taxType === 'cess') cess += line.amount
    }

    const partySide = v.kind === 'purchase' ? 'cr' : 'dr'
    let invoiceValue = v.partyLedgerId != null ? (partyLineStmt.get(v.id, v.partyLedgerId, partySide) as { t: number }).t : 0
    if (!invoiceValue) invoiceValue = (totalDrStmt.get(v.id) as { t: number }).t

    return {
      voucherId: v.id,
      kind: v.kind,
      date: v.date,
      number: v.number,
      supplierRef: v.reference,
      partyLedgerId: v.partyLedgerId,
      partyName: v.partyName,
      partyGstin: v.partyGstin,
      invoiceValue,
      taxable,
      igst,
      cgst,
      sgst,
      cess
    }
  })
}

/** Parse a downloaded GSTR-2B JSON and reconcile it against the books for the same period. */
export function recon2b(
  db: DB,
  jsonText: string,
  from: string,
  to: string,
  opts: Recon2bOptions = { amountTolerancePaise: 100, dateWindowDays: 7 }
): { result: Recon2bResult; errors: string[]; period: string | null } {
  const parsed = parseGstr2b(jsonText)
  const books = extractPurchaseDocs(db, from, to)
  const result = reconcile2b(parsed.invoices, books, opts)
  return { result, errors: parsed.errors, period: parsed.period }
}

// ---------- entry points ----------

export function gstr1(db: DB, company: CompanyInfo, from: string, to: string, period: string): Gstr1Result {
  const docs = extractOutwardDocs(db, company, from, to)
  return buildGstr1(docs, company.gstin ?? '', company.stateCode, period, gstr1Extras(db, company, from, to))
}

export function gstr3b(db: DB, company: CompanyInfo, from: string, to: string, period: string): Gstr3bView {
  const docs = extractOutwardDocs(db, company, from, to)
  const books = itcBreakdown(db, company, from, to)
  const entered = getGst3bManual(db, period)
  const shaped = circular170Inputs(books, entered, entered.itcReclaimed)
  const result = buildGstr3b(
    { docs, itc: shaped.itc, rcmInward: rcmInwardSummary(db, company, from, to), manual: shaped.manual },
    company.gstin ?? '',
    period
  )
  return { ...result, circular170: { blocked: books.blocked, reclaimed: entered.itcReclaimed, entered } }
}

/** What the books' history says about e-invoicing (PR #140's heuristic): a REGULAR registration
 *  and any sign of use — NIC live filing set up for e-invoices (the non-secret meta 'nic' row:
 *  mode 'einvoice' or an e-invoice base URL), an IRN on a voucher in the books, or an e-invoice
 *  JSON exported (its audit 'export' row). The setting's answer until the owner chooses. Read-only. */
export function einvoicingFromHistory(db: DB, company: Pick<CompanyInfo, 'gstRegistrationType'>): boolean {
  if (company.gstRegistrationType !== 'regular') return false
  const nic = db.prepare("SELECT value FROM meta WHERE key = 'nic'").get() as { value: string } | undefined
  if (nic) {
    try {
      const v = JSON.parse(nic.value) as { mode?: string; baseUrlEinvoice?: string }
      if (v.mode === 'einvoice' || (typeof v.baseUrlEinvoice === 'string' && v.baseUrlEinvoice.trim() !== '')) return true
    } catch {
      // an unreadable row says nothing either way
    }
  }
  if (db.prepare(`SELECT 1 FROM vouchers v WHERE v.irn IS NOT NULL AND v.irn <> '' AND ${IN_BOOKS} LIMIT 1`).get()) return true
  return !!db
    .prepare("SELECT 1 FROM audit_log WHERE entity = 'export' AND json_extract(after_json, '$.kind') = 'einvoice' LIMIT 1")
    .get()
}

export const EINVOICING_META_KEY = 'einvoicing'
export interface EinvoicingSetting { enabled: boolean }

function storedEinvoicing(db: DB): EinvoicingSetting | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(EINVOICING_META_KEY) as { value: string } | undefined
  if (!row) return null
  try {
    const v = JSON.parse(row.value) as { enabled?: unknown }
    return typeof v?.enabled === 'boolean' ? { enabled: v.enabled } : null
  } catch {
    return null
  }
}

/**
 * The company's e-invoicing switch (meta `einvoicing: { enabled }`, Settings → Company details).
 * No row yet = the history heuristic's answer (PR #140), read live — never stored on a read: a
 * viewer's read writes nothing, and a company that starts e-invoicing (NIC set up, an IRN, an
 * e-invoice exported) before anyone chose still gets the checks. Only the owner's choice
 * (`setEinvoicing`, audited) is stored, and from then on it alone decides.
 */
export function getEinvoicing(db: DB, company: Pick<CompanyInfo, 'gstRegistrationType'>): EinvoicingSetting {
  return storedEinvoicing(db) ?? { enabled: einvoicingFromHistory(db, company) }
}

/** Owner-only at the IPC layer; audited as a company update with the whole before / after (before
 *  `{ einvoicing: null }` while it still followed the history, like gstProfile). An unchanged
 *  stored value writes nothing; the first explicit choice is stored even when it equals the
 *  history's answer (it stops following the history). */
export function setEinvoicing(db: DB, company: Pick<CompanyInfo, 'gstRegistrationType'>, input: EinvoicingSetting): EinvoicingSetting {
  const stored = storedEinvoicing(db)
  if (stored && stored.enabled === input.enabled) return stored
  const after = { enabled: input.enabled }
  db.transaction(() => {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(EINVOICING_META_KEY, JSON.stringify(after))
    writeAudit(db, 'company', 0, 'update', { einvoicing: stored }, { einvoicing: after })
  })()
  return after
}

/** Does this company e-invoice? Its switch, for a REGULAR registration only (the IRP issues IRNs
 *  to registered persons; a composition / unregistered business never e-invoices). */
export function einvoicingOn(db: DB, company: Pick<CompanyInfo, 'gstRegistrationType'>): boolean {
  return company.gstRegistrationType === 'regular' && getEinvoicing(db, company).enabled
}

/** To-do §4: what the business profile (meta gstProfile turnover / exemption) says about
 *  e-invoicing on `today` (shared/gst/einvoiceApplicability.ts). Read-only; never touches the
 *  switch — `einvoicingOn` is unchanged and stays the owner's choice. */
export function einvoiceProfileApplicability(db: DB, company: Pick<CompanyInfo, 'gstRegistrationType'>, today: string): EinvoiceApplicability {
  const p = getGstProfile(db)
  return einvoiceApplicability({ gstRegistrationType: company.gstRegistrationType, turnover: p.turnover, einvoiceExemption: p.einvoiceExemption }, today)
}

/** One read for Company details, the Gateway / simple Taxes chip and the e-Invoice list. */
export function einvoiceStatus(db: DB, company: Pick<CompanyInfo, 'gstRegistrationType'>, today: string): EinvoiceStatus {
  const enabled = einvoicingOn(db, company)
  const applicability = einvoiceProfileApplicability(db, company, today)
  return {
    enabled,
    applicability,
    turnOn: einvoiceTurnOnNotice(applicability, enabled),
    reportingWindowDays: enabled && applicability.reportingWindowDays ? applicability.reportingWindowDays : null
  }
}

/** Pre-export validation over the period's extracted documents (G7 panel + export gate). The
 *  e-invoice doc-no warning (#140) runs while the switch is on OR the profile says e-invoicing
 *  is required on the period's last day (to-do §4). */
export function gstValidate(db: DB, company: CompanyInfo, from: string, to: string): GstIssue[] {
  const docs = extractOutwardDocs(db, company, from, to)
  return validateGstr1(docs, {
    stateCode: company.stateCode,
    gstin: company.gstin,
    gstRegistrationType: company.gstRegistrationType,
    einvoicing: einvoicingOn(db, company) || einvoiceProfileApplicability(db, company, to).required
  })
}

/** Throw (with the issue list) when blocking issues exist — the server-side export gate.
 *  Guards BOTH return exports: GSTR-1 and GSTR-3B are computed from the same extracted
 *  documents, so a period the app knows is unsound must not export either JSON. */
export function assertExportable(db: DB, company: CompanyInfo, from: string, to: string): void {
  const blocking = gstValidate(db, company, from, to).filter((i) => i.severity === 'blocking')
  if (blocking.length) {
    throw new Error(`GST export blocked: ${blocking.map((i) => i.message).join(' | ')}`)
  }
}

export function exportReturnJson(
  slug: string,
  name: 'gstr1' | 'gstr3b',
  period: string,
  json: Record<string, unknown>
): string {
  const path = join(companyExportsDir(slug), `${name}-${period}.json`)
  writeFileSync(path, JSON.stringify(json, null, 2))
  return path
}

/** CSV of the GSTR-1 section summary for spreadsheet review. */
export function exportGstr1Csv(slug: string, result: Gstr1Result): string {
  const header = 'Section,Documents,Taxable Value,IGST,CGST,SGST,Cess'
  const lines = result.summary.map((s) =>
    [s.label, s.docs, plainRupees(s.taxable), plainRupees(s.igst), plainRupees(s.cgst), plainRupees(s.sgst), plainRupees(s.cess)]
      .map((v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v))
      .join(',')
  )
  const path = join(companyExportsDir(slug), `gstr1-${result.period}-summary.csv`)
  writeFileSync(path, [header, ...lines].join('\n'))
  return path
}
