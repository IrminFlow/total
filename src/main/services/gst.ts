import { writeFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import {
  buildGstr1, buildGstr3b, classifyDoc, isZeroRatedTyp,
  type GstAdvanceAgg, type GstDoc, type GstDocRateItem, type GstDocSeries, type GstHsnLine,
  type GstNilLine, type Gstr1Extras, type Gstr1Result, type Gstr3bResult, type InwardSummary,
  type ItcBreakdown, type TaxTotals
} from '@shared/gst/returns'
import { backOutAdvance, computeGst, supplyTypeFor } from '@shared/gst/calc'
import { toUqc } from '@shared/gst/uqc'
import { validateGstr1, type GstIssue } from '@shared/gst/validate'
import { fyOf } from '@shared/dates'
import { plainRupees } from '@shared/money'
import { parseGstr2b, reconcile2b, type PurchaseDoc, type Recon2bResult } from '@shared/gst/recon2b'
import { descendantIdsByName } from './masters'
import { getGst3bManual } from './config'
import { companyExportsDir } from '../paths'
import { IN_BOOKS } from './vouchers'
import { writeAudit } from './audit'

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
export function outwardDebitNoteIds(db: DB, from: string, to: string, registrationId?: number | null): Set<number> {
  const rows = db
    .prepare(
      `SELECT v.id, v.party_ledger_id AS partyLedgerId
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vt.kind = 'debit_note' AND v.date BETWEEN ? AND ?
         AND (? IS NULL OR v.gst_registration_id = ?) AND ${IN_BOOKS}`
    )
    .all(from, to, registrationId ?? null, registrationId ?? null) as { id: number; partyLedgerId: number | null }[]
  if (!rows.length) return new Set()
  const incomeIds = descendantIdsByName(db, INCOME_GROUPS)
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
 * Extract outward GST documents (sales + credit notes + outward debit notes) for a period.
 *
 * Tax is computed ONCE per line (computeGst on the line's taxable at its master rate) and
 * both the per-rate items and the HSN lines are sums of those line-level paise — the shared
 * bucketing path that makes Tables 4-7 tie to Table 12 exactly (audit D2). Rate-0 lines go
 * to nilLines (Table 8), never into the rated buckets. SEWOP/EXPWOP (without-payment)
 * documents are zero-rated with no tax charged.
 */
export function extractOutwardDocs(db: DB, company: CompanyInfo, from: string, to: string, registrationId?: number | null): GstDoc[] {
  const vouchers = db
    .prepare(
      `SELECT v.id, v.date, v.number, vt.kind, v.pos_override AS posOverride,
              p.name AS partyName, p.gstin AS partyGstin, p.state_code AS partyState,
              p.export_type AS partyExportType, COALESCE(p.rcm, 0) AS partyRcm,
              t.trans_doc_no AS transDocNo, t.trans_doc_date AS transDocDate
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       LEFT JOIN voucher_transport t ON t.voucher_id = v.id
       WHERE vt.kind IN ('sales', 'credit_note', 'debit_note') AND v.date BETWEEN ? AND ?
         AND (? IS NULL OR v.gst_registration_id = ?) AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(from, to, registrationId ?? null, registrationId ?? null) as DocVoucherRow[]

  const outwardDbn = outwardDebitNoteIds(db, from, to, registrationId)
  const salesGroupIds = descendantIdsByName(db, INCOME_GROUPS)

  const invStmt = db.prepare(
    `SELECT il.qty_milli AS qtyMilli, il.amount,
            si.name AS itemName, si.hsn, si.gst_rate AS gstRate, si.cess_rate AS cessRate,
            u.uqc
     FROM inventory_lines il
     JOIN stock_items si ON si.id = il.stock_item_id
     JOIN units u ON u.id = si.unit_id
     WHERE il.voucher_id = ? ORDER BY il.line_order, il.id`
  )
  const lineStmt = db.prepare(
    `SELECT vl.amount, vl.dr_cr AS drCr, l.group_id AS groupId, l.gst_rate AS gstRate, l.hsn, l.name
     FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
     WHERE vl.voucher_id = ? ORDER BY vl.line_order, vl.id`
  )
  const totalStmt = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS t FROM voucher_lines WHERE voucher_id = ? AND dr_cr = 'dr'"
  )

  return vouchers
    .filter((v) => v.kind !== 'debit_note' || outwardDbn.has(v.id))
    .map((v) => {
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

      const inv = invStmt.all(v.id) as {
        qtyMilli: number; amount: number; itemName: string
        hsn: string | null; gstRate: number | null; cessRate: number | null; uqc: string
      }[]

      interface Bucket { rate: number; taxable: number; cgst: number; sgst: number; igst: number; cess: number }
      const buckets = new Map<number, Bucket>()
      const hsnLines: GstHsnLine[] = []
      const nilLines: GstNilLine[] = []
      let missingHsnCount = 0
      let computedTotal = 0

      // The one shared bucketing path: compute per LINE, then only ever sum.
      const addLine = (
        taxable: number, rate: number, cessRate: number,
        hsn: string | null, description: string, uqc: string, qtyMilli: number
      ): void => {
        const g = zeroTax
          ? { cgst: 0, sgst: 0, igst: 0, cess: 0 }
          : computeGst(taxable, rate, supply, cessRate)
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
          addLine(line.amount, line.gstRate ?? 0, line.cessRate ?? 0, line.hsn, line.itemName, uqc, line.qtyMilli)
        }
      } else {
        const lines = lineStmt.all(v.id) as {
          amount: number; drCr: 'dr' | 'cr'; groupId: number; gstRate: number | null; hsn: string | null; name: string
        }[]
        // Sales side: credit lines on sales/debit notes, debit lines on credit notes.
        const salesSide = v.kind === 'credit_note' ? 'dr' : 'cr'
        for (const line of lines) {
          if (line.drCr !== salesSide || !salesGroupIds.has(line.groupId)) continue
          addLine(line.amount, line.gstRate ?? 0, 0, line.hsn, line.name, 'OTH', 0)
        }
      }

      const items: GstDocRateItem[] = [...buckets.values()].map((b) => ({
        rate: b.rate, taxable: b.taxable, cgst: b.cgst, sgst: b.sgst, igst: b.igst, cess: b.cess
      }))

      const invoiceValue = (totalStmt.get(v.id) as { t: number }).t

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
        validation: {
          valDiff: invoiceValue - computedTotal,
          missingHsnCount,
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
export function rcmInwardSummary(db: DB, company: CompanyInfo, from: string, to: string, registrationId?: number | null): TaxTotals {
  const outwardDbn = outwardDebitNoteIds(db, from, to, registrationId)
  const vouchers = (db
    .prepare(
      `SELECT v.id, vt.kind, p.state_code AS partyState
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE vt.kind IN ('purchase', 'debit_note') AND p.rcm = 1 AND v.date BETWEEN ? AND ?
         AND (? IS NULL OR v.gst_registration_id = ?) AND ${IN_BOOKS}`
    )
    .all(from, to, registrationId ?? null, registrationId ?? null) as { id: number; kind: 'purchase' | 'debit_note'; partyState: string | null }[])
    .filter((v) => v.kind !== 'debit_note' || !outwardDbn.has(v.id))

  const purchaseGroupIds = descendantIdsByName(db, ['Purchase Accounts', 'Direct Expenses', 'Indirect Expenses'])
  const invStmt = db.prepare(
    `SELECT il.amount, si.gst_rate AS gstRate, si.cess_rate AS cessRate
     FROM inventory_lines il JOIN stock_items si ON si.id = il.stock_item_id
     WHERE il.voucher_id = ?`
  )
  const lineStmt = db.prepare(
    `SELECT vl.amount, vl.dr_cr AS drCr, l.group_id AS groupId, l.gst_rate AS gstRate
     FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id WHERE vl.voucher_id = ?`
  )

  const total: TaxTotals = { taxable: 0, ...ZERO }
  for (const v of vouchers) {
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
  }
  return total
}

/**
 * ITC itemised for GSTR-3B Table 4: booked input-tax lines on purchases/purchase-side debit
 * notes are assigned per voucher to IMPG (import — party state 96/97), blocked (4D — party
 * itc_eligibility='blocked') or OTH; RCM parties' vouchers are skipped here (their credit is
 * ISRC, computed from master rates in rcmInwardSummary). Outward debit notes are excluded —
 * their tax lines are OUTPUT tax, not ITC (they used to be silently subtracted).
 */
export function itcBreakdown(db: DB, company: CompanyInfo, from: string, to: string, registrationId?: number | null): ItcBreakdown {
  const outwardDbn = outwardDebitNoteIds(db, from, to, registrationId)
  const rows = db
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
         AND v.date BETWEEN ? AND ? AND (? IS NULL OR v.gst_registration_id = ?) AND ${IN_BOOKS}
       GROUP BY v.id, l.tax_type`
    )
    .all(from, to, registrationId ?? null, registrationId ?? null) as {
      voucherId: number; kind: string; taxType: 'cgst' | 'sgst' | 'igst' | 'cess'; amount: number
      partyState: string | null; partyRcm: number; itcEligibility: string
    }[]

  const result: ItcBreakdown = {
    impg: { ...ZERO }, isrc: { ...ZERO }, oth: { ...ZERO }, blocked: { ...ZERO }
  }
  for (const r of rows) {
    if (r.kind === 'debit_note' && outwardDbn.has(r.voucherId)) continue
    if (r.partyRcm) continue // ISRC — computed from master rates, not booked lines
    const bucket =
      r.itcEligibility === 'blocked'
        ? result.blocked
        : r.partyState === '96' || r.partyState === '97'
          ? result.impg
          : result.oth
    bucket[r.taxType] += r.amount
  }
  const rcm = rcmInwardSummary(db, company, from, to, registrationId)
  result.isrc = { igst: rcm.igst, cgst: rcm.cgst, sgst: rcm.sgst, cess: rcm.cess }
  return result
}

/** Net booked ITC for the period (legacy shape — the on-screen "Eligible ITC" row). */
export function inwardSummary(db: DB, from: string, to: string, registrationId?: number | null): InwardSummary {
  // Kept for the 2B reconciliation summary; excludes outward debit notes like itcBreakdown.
  const outwardDbn = outwardDebitNoteIds(db, from, to, registrationId)
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
       WHERE l.tax_type IS NOT NULL AND vt.kind IN ('purchase', 'debit_note') AND v.date BETWEEN ? AND ?
         AND (? IS NULL OR v.gst_registration_id = ?) AND ${IN_BOOKS}
       GROUP BY v.id, l.tax_type`
    )
    .all(from, to, registrationId ?? null, registrationId ?? null) as { voucherId: number; kind: string; taxType: 'cgst' | 'sgst' | 'igst' | 'cess'; amount: number }[]
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
export function extractAdvances(db: DB, company: CompanyInfo, from: string, to: string, registrationId?: number | null): GstAdvanceAgg[] {
  const rows = db
    .prepare(
      `SELECT br.amount, p.state_code AS partyState, p.gst_rate AS gstRate
       FROM bill_refs br
       JOIN vouchers v ON v.id = br.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN ledgers p ON p.id = br.party_ledger_id
       WHERE vt.kind = 'receipt' AND br.kind = 'new' AND p.gst_rate IS NOT NULL
         AND v.date BETWEEN ? AND ? AND (? IS NULL OR v.gst_registration_id = ?) AND ${IN_BOOKS}`
    )
    .all(from, to, registrationId ?? null, registrationId ?? null) as { amount: number; partyState: string | null; gstRate: number }[]
  return aggregateAdvances(rows, company)
}

/**
 * 11B — advances adjusted: sales vouchers in the period settling ('against') a bill that a
 * receipt voucher created ('new') — i.e. an invoice issued against an earlier advance.
 */
export function extractAdvanceAdjustments(db: DB, company: CompanyInfo, from: string, to: string, registrationId?: number | null): GstAdvanceAgg[] {
  const rows = db
    .prepare(
      `SELECT br.amount, p.state_code AS partyState, p.gst_rate AS gstRate
       FROM bill_refs br
       JOIN vouchers v ON v.id = br.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN ledgers p ON p.id = br.party_ledger_id
       WHERE vt.kind = 'sales' AND br.kind = 'against' AND p.gst_rate IS NOT NULL
         AND v.date BETWEEN ? AND ? AND (? IS NULL OR v.gst_registration_id = ?) AND ${IN_BOOKS}
         AND EXISTS (
           SELECT 1 FROM bill_refs br2
           JOIN vouchers v2 ON v2.id = br2.voucher_id
           JOIN voucher_types vt2 ON vt2.id = v2.voucher_type_id
           WHERE br2.kind = 'new' AND br2.name = br.name AND br2.party_ledger_id = br.party_ledger_id
             AND vt2.kind = 'receipt' AND v2.deleted_at IS NULL
         )`
    )
    .all(from, to, registrationId ?? null, registrationId ?? null) as { amount: number; partyState: string | null; gstRate: number }[]
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
export function extractDocSeries(db: DB, from: string, to: string, registrationId?: number | null): GstDocSeries[] {
  const types = db
    .prepare(
      `SELECT DISTINCT v.voucher_type_id AS typeId, vt.kind
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vt.kind IN ('sales', 'credit_note', 'debit_note') AND v.date BETWEEN ? AND ?
         AND (? IS NULL OR v.gst_registration_id = ?)`
    )
    .all(from, to, registrationId ?? null, registrationId ?? null) as { typeId: number; kind: 'sales' | 'credit_note' | 'debit_note' }[]
  const seriesStmt = db.prepare(
    `SELECT v.number, v.deleted_at AS deletedAt
     FROM vouchers v WHERE v.voucher_type_id = ? AND v.date BETWEEN ? AND ?
       AND (? IS NULL OR v.gst_registration_id = ?)
     ORDER BY v.date, v.id`
  )
  const CATEGORY: Record<string, 1 | 4 | 5> = { sales: 1, debit_note: 4, credit_note: 5 }
  const result: GstDocSeries[] = []
  for (const t of types) {
    const rows = seriesStmt.all(t.typeId, from, to, registrationId ?? null, registrationId ?? null) as { number: string; deletedAt: string | null }[]
    if (!rows.length) continue
    result.push({
      category: CATEGORY[t.kind]!,
      from: rows[0]!.number,
      to: rows[rows.length - 1]!.number,
      totnum: rows.length,
      cancel: rows.filter((r) => r.deletedAt).length
    })
  }
  return result.sort((a, b) => a.category - b.category)
}

/**
 * Turnover for the GSTR-1 header: income-group movement (sales credits − credit-note debits
 * + outward debit-note credits) over a date range. Computed from the books every time —
 * never hardcoded.
 */
export function turnover(db: DB, from: string, to: string, registrationId?: number | null): number {
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
         AND v.date BETWEEN ? AND ? AND (? IS NULL OR v.gst_registration_id = ?) AND ${IN_BOOKS}`
    )
    .get(...incomeIds, from, to, registrationId ?? null, registrationId ?? null) as { t: number }
  return Math.max(0, row.t)
}

function gstr1Extras(db: DB, company: CompanyInfo, from: string, to: string, registrationId?: number | null): Gstr1Extras {
  const fy = fyOf(from)
  const prevFy = fyOf(`${fy.startYear - 1}-06-01`)
  return {
    advances: extractAdvances(db, company, from, to, registrationId),
    advanceAdjustments: extractAdvanceAdjustments(db, company, from, to, registrationId),
    docSeries: extractDocSeries(db, from, to, registrationId),
    gt: turnover(db, prevFy.from, prevFy.to, registrationId),
    curGt: turnover(db, fy.from, to, registrationId)
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
export function extractPurchaseDocs(db: DB, from: string, to: string, registrationId?: number | null): PurchaseDoc[] {
  const outwardDbn = outwardDebitNoteIds(db, from, to, registrationId)
  const vouchers = (db
    .prepare(
      `SELECT v.id, v.date, v.number, v.reference, v.party_ledger_id AS partyLedgerId, vt.kind,
              p.name AS partyName, p.gstin AS partyGstin
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE vt.kind IN ('purchase', 'debit_note') AND v.date BETWEEN ? AND ?
         AND (? IS NULL OR v.gst_registration_id = ?) AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(from, to, registrationId ?? null, registrationId ?? null) as PurchaseVoucherRow[])
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
  to: string
): { result: Recon2bResult; errors: string[]; period: string | null } {
  const parsed = parseGstr2b(jsonText)
  const books = extractPurchaseDocs(db, from, to)
  const result = reconcile2b(parsed.invoices, books, { amountTolerancePaise: 100, dateWindowDays: 7 })
  return { result, errors: parsed.errors, period: parsed.period }
}

// ---------- entry points ----------

export function gstr1(db: DB, company: CompanyInfo, from: string, to: string, period: string, registrationId?: number | null): Gstr1Result {
  const docs = extractOutwardDocs(db, company, from, to, registrationId)
  return buildGstr1(docs, company.gstin ?? '', company.stateCode, period, gstr1Extras(db, company, from, to, registrationId))
}

export function gstr3b(db: DB, company: CompanyInfo, from: string, to: string, period: string, registrationId?: number | null): Gstr3bResult {
  const docs = extractOutwardDocs(db, company, from, to, registrationId)
  const outwardDbn = outwardDebitNoteIds(db, from, to, registrationId)
  const purchaseSources = (db.prepare(
    `SELECT DISTINCT v.id AS voucherId, vt.kind, p.state_code AS partyState,
            COALESCE(p.rcm, 0) AS partyRcm, COALESCE(p.itc_eligibility, 'eligible') AS itcEligibility
     FROM vouchers v
     JOIN voucher_types vt ON vt.id = v.voucher_type_id
     JOIN voucher_lines vl ON vl.voucher_id = v.id
     JOIN ledgers tax ON tax.id = vl.ledger_id AND tax.tax_type IS NOT NULL
     LEFT JOIN ledgers p ON p.id = v.party_ledger_id
     WHERE vt.kind IN ('purchase', 'debit_note') AND v.date BETWEEN ? AND ?
       AND (? IS NULL OR v.gst_registration_id = ?) AND ${IN_BOOKS}`
  ).all(from, to, registrationId ?? null, registrationId ?? null) as { voucherId: number; kind: string; partyState: string | null; partyRcm: number; itcEligibility: string }[])
    .filter((row) => row.kind !== 'debit_note' || !outwardDbn.has(row.voucherId))
  const rcmIds = (db.prepare(
    `SELECT v.id AS voucherId, vt.kind
     FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
     JOIN ledgers p ON p.id = v.party_ledger_id
     WHERE vt.kind IN ('purchase', 'debit_note') AND p.rcm = 1
       AND v.date BETWEEN ? AND ? AND (? IS NULL OR v.gst_registration_id = ?) AND ${IN_BOOKS}`
  ).all(from, to, registrationId ?? null, registrationId ?? null) as { voucherId: number; kind: string }[])
    .filter((row) => row.kind !== 'debit_note' || !outwardDbn.has(row.voucherId))
    .map((row) => row.voucherId)
  const impgIds = [...new Set(purchaseSources.filter((row) => !row.partyRcm && (row.partyState === '96' || row.partyState === '97') && row.itcEligibility !== 'blocked').map((row) => row.voucherId))]
  const blockedIds = [...new Set(purchaseSources.filter((row) => !row.partyRcm && row.itcEligibility === 'blocked').map((row) => row.voucherId))]
  const othIds = [...new Set(purchaseSources.filter((row) => !row.partyRcm && row.partyState !== '96' && row.partyState !== '97' && row.itcEligibility !== 'blocked').map((row) => row.voucherId))]
  const unique = (ids: number[]): number[] => [...new Set(ids)]
  return buildGstr3b(
    {
      docs,
      itc: itcBreakdown(db, company, from, to, registrationId),
      rcmInward: rcmInwardSummary(db, company, from, to, registrationId),
      manual: getGst3bManual(db, period, registrationId),
      sourceVoucherIds: {
        outward: docs.filter((doc) => !isZeroRatedTyp(doc.invTyp ?? 'R') && doc.items.some((item) => item.rate > 0)).map((doc) => doc.voucherId),
        zeroRated: docs.filter((doc) => isZeroRatedTyp(doc.invTyp ?? 'R')).map((doc) => doc.voucherId),
        nilExempt: docs.filter((doc) => (doc.nilLines?.length ?? 0) > 0 || doc.items.some((item) => item.rate === 0)).map((doc) => doc.voucherId),
        rcm: rcmIds,
        impg: impgIds,
        isrc: rcmIds,
        oth: othIds,
        blocked: blockedIds,
        netItc: unique([...impgIds, ...rcmIds, ...othIds])
      }
    },
    company.gstin ?? '',
    period
  )
}

export type GstReturnType = 'gstr1' | 'gstr3b'

export interface GstReturnStatus {
  registrationId: number | null
  returnType: GstReturnType
  period: string
  from: string
  to: string
  status: 'not_prepared' | 'prepared' | 'filed'
  frozenAt: string | null
  changedSinceFreeze: boolean
  filedAt: string | null
  arn: string | null
  hasSubmittedJson: boolean
}

interface GstReturnPeriodRow {
  id: number
  registration_id: number | null
  return_type: GstReturnType
  period: string
  from_date: string
  to_date: string
  frozen_at: string
  snapshot_hash: string
  status: 'prepared' | 'filed'
  filed_at: string | null
  arn: string | null
  submitted_json: string | null
}

function returnPayload(db: DB, company: CompanyInfo, type: GstReturnType, from: string, to: string, period: string, registrationId?: number | null): Record<string, unknown> {
  return type === 'gstr1'
    ? gstr1(db, company, from, to, period, registrationId).json
    : gstr3b(db, company, from, to, period, registrationId).json
}

function payloadHash(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export function gstReturnStatus(db: DB, company: CompanyInfo, type: GstReturnType, from: string, to: string, period: string, registrationId?: number | null): GstReturnStatus {
  const scope = registrationId ?? null
  const row = db.prepare('SELECT * FROM gst_return_periods WHERE COALESCE(registration_id, 0) = COALESCE(?, 0) AND return_type = ? AND period = ?').get(scope, type, period) as GstReturnPeriodRow | undefined
  if (!row) {
    return { registrationId: scope, returnType: type, period, from, to, status: 'not_prepared', frozenAt: null, changedSinceFreeze: false, filedAt: null, arn: null, hasSubmittedJson: false }
  }
  const currentHash = payloadHash(returnPayload(db, company, type, from, to, period, scope))
  return {
    registrationId: row.registration_id,
    returnType: type,
    period,
    from: row.from_date,
    to: row.to_date,
    status: row.status,
    frozenAt: row.frozen_at,
    changedSinceFreeze: currentHash !== row.snapshot_hash,
    filedAt: row.filed_at,
    arn: row.arn,
    hasSubmittedJson: row.submitted_json !== null
  }
}

/** Freeze the exact reviewed/exported JSON. Subsequent book edits are compared to its hash. */
export function freezeGstReturn(db: DB, company: CompanyInfo, type: GstReturnType, from: string, to: string, period: string, registrationId?: number | null): GstReturnStatus {
  const scope = registrationId ?? null
  assertExportable(db, company, from, to, scope)
  const existing = db.prepare('SELECT id, status FROM gst_return_periods WHERE COALESCE(registration_id, 0) = COALESCE(?, 0) AND return_type = ? AND period = ?').get(scope, type, period) as { id: number; status: string } | undefined
  if (existing?.status === 'filed') throw new Error('This return is already marked filed. Keep its acknowledgement and prepare an amendment separately.')
  const payload = returnPayload(db, company, type, from, to, period, scope)
  const snapshot = JSON.stringify(payload)
  const hash = payloadHash(payload)
  let id: number
  if (existing) {
    db.prepare(
      `UPDATE gst_return_periods SET from_date=?, to_date=?, frozen_at=datetime('now'), snapshot_hash=?,
       snapshot_json=?, status='prepared', filed_at=NULL, arn=NULL, submitted_json=NULL WHERE id=?`
    ).run(from, to, hash, snapshot, existing.id)
    id = existing.id
  } else {
    id = Number(db.prepare(
      `INSERT INTO gst_return_periods
       (registration_id, return_type, period, from_date, to_date, frozen_at, snapshot_hash, snapshot_json, status)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, 'prepared')`
    ).run(scope, type, period, from, to, hash, snapshot).lastInsertRowid)
  }
  writeAudit(db, 'gst_return', id, existing ? 'update' : 'create', existing ?? null, { registrationId: scope, type, period, hash, status: 'prepared' })
  return gstReturnStatus(db, company, type, from, to, period, scope)
}

/** Retain portal acknowledgement and the optional exact submitted JSON beside the frozen copy. */
export function acknowledgeGstReturn(
  db: DB,
  company: CompanyInfo,
  type: GstReturnType,
  from: string,
  to: string,
  period: string,
  input: { arn: string; filedAt: string; submittedJson: string | null },
  registrationId?: number | null
): GstReturnStatus {
  const scope = registrationId ?? null
  const row = db.prepare('SELECT id, status, arn, filed_at FROM gst_return_periods WHERE COALESCE(registration_id, 0) = COALESCE(?, 0) AND return_type = ? AND period = ?').get(scope, type, period) as { id: number; status: string; arn: string | null; filed_at: string | null } | undefined
  if (!row) throw new Error('Prepare or export this return before marking it filed')
  if (input.submittedJson) {
    try { JSON.parse(input.submittedJson) } catch { throw new Error('Submitted return JSON is not valid JSON') }
  }
  db.prepare(
    `UPDATE gst_return_periods SET status = 'filed', arn = ?, filed_at = ?, submitted_json = ?
     WHERE id = ?`
  ).run(input.arn.trim().toUpperCase(), input.filedAt, input.submittedJson, row.id)
  writeAudit(db, 'gst_return', row.id, 'update', row, { status: 'filed', arn: input.arn.trim().toUpperCase(), filedAt: input.filedAt })
  return gstReturnStatus(db, company, type, from, to, period, scope)
}

/** Pre-export validation over the period's extracted documents (G7 panel + export gate). */
export function gstValidate(db: DB, company: CompanyInfo, from: string, to: string, registrationId?: number | null): GstIssue[] {
  const docs = extractOutwardDocs(db, company, from, to, registrationId)
  return validateGstr1(docs, {
    stateCode: company.stateCode,
    gstin: company.gstin,
    gstRegistrationType: company.gstRegistrationType
  })
}

/** Throw (with the issue list) when blocking issues exist — the server-side export gate.
 *  Guards BOTH return exports: GSTR-1 and GSTR-3B are computed from the same extracted
 *  documents, so a period the app knows is unsound must not export either JSON. */
export function assertExportable(db: DB, company: CompanyInfo, from: string, to: string, registrationId?: number | null): void {
  const blocking = gstValidate(db, company, from, to, registrationId).filter((i) => i.severity === 'blocking')
  if (blocking.length) {
    throw new Error(`GST export blocked: ${blocking.map((i) => i.message).join(' | ')}`)
  }
}

export function exportReturnJson(
  slug: string,
  name: 'gstr1' | 'gstr3b',
  period: string,
  json: Record<string, unknown>,
  gstin?: string | null
): string {
  const path = join(companyExportsDir(slug), `${name}-${period}${gstin ? `-${gstin}` : ''}.json`)
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
