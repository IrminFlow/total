/**
 * TCS on sales (WP 3.3) — the entry-time suggestion. Everything else (sections, rates,
 * certificates, payable ledgers, save-time validation, challans, the ledger summary, returns
 * data) is the kind-aware TDS service in tds.ts / tdsWorkbench.ts with kind 'tcs'; the TCS screen
 * workbench (eligible list, Move to TCS, 27EQ / 27D) is tcsWorkbench.ts.
 */
import type { DB } from '../db/connection'
import { fyOf, todayISO } from '@shared/dates'
import { sectionReferenceOn, thresholdStatus, rateRowOn } from '@shared/withholding'
import { tcsBasePaise } from '@shared/tcs'
import { undeductedCreditsBefore } from '@shared/tdsEligibility'
import { findPayableLedger, listRates, listSections, resolveTds, type TdsSuggestion } from './tds'
import { TCS_STATUTORY_SECTIONS } from '@shared/tcsSources'
import type { TdsSection } from '@shared/domain'
import { writeAudit } from './audit'
import { buildTcsEventGroups, loadTcsVouchers, tcsContext, tcsPartySectionWalk } from './tcsEvents'
import { KIND } from './withholdingKind'

/**
 * The TCS collected on a sale, for documents and GST: the e-invoice / print totals show it as a
 * separate line after GST and keep it OUT of the taxable value and the GST validation — income-tax
 * TCS "would not be includible" in the GST value of supply ("an interim levy not having the
 * character of tax": CBIC Circular 76/50/2018-GST, serial 5 as replaced by the corrigendum of
 * 7-3-2019 — read via a secondary reproduction, UNVERIFIED against the CBIC copy, accessed
 * 2026-10-07). It IS part of the invoice total the buyer owes.
 */
export function tcsOnVoucher(db: DB, voucherId: number): { amountPaise: number; rateBp: number | null; code: string; reference: string } | null {
  const r = db
    .prepare(
      `SELECT te.tds_amount AS amount, te.rate_bp_at AS rateBp, ts.code, ts.legacy_code AS legacyCode, ts.new_reference AS newReference, v.date
       FROM tds_entries te JOIN tds_sections ts ON ts.id = te.section_id JOIN vouchers v ON v.id = te.voucher_id
       WHERE te.voucher_id = ? AND ts.kind = 'tcs' ORDER BY te.id LIMIT 1`
    )
    .get(voucherId) as { amount: number; rateBp: number | null; code: string; legacyCode: string | null; newReference: string | null; date: string } | undefined
  if (!r) return null
  return { amountPaise: r.amount, rateBp: r.rateBp, code: r.code, reference: sectionReferenceOn({ code: r.code, legacyCode: r.legacyCode, newReference: r.newReference }, r.date) }
}

export interface TcsSuggestInput {
  partyLedgerId: number
  date: string
  /** 'sales' (on the invoice) or 'receipt' (first-of-debit-or-receipt: only on sales not
   *  collected on when invoiced, plus any advance). */
  voucherKind: 'sales' | 'receipt'
  /** Sale: invoice taxable value. Receipt: the amount received from the buyer. */
  taxablePaise: number
  /** Sale: GST (+ round-off) on the invoice. */
  gstPaise?: number
  /** Sale: the sales ledger credited (its default section applies when the buyer has none). */
  salesLedgerId?: number | null
  /** Sale: item lines (goods flagged with a TCS section attract it). */
  items?: { stockItemId: number; amount: number }[]
  excludeVoucherId?: number
  /** The banner's section choice. */
  sectionId?: number | null
}

/** The suggestion has the TDS banner's shape (amount in `tdsPaise` = the TCS to collect) plus
 *  the TCS basis: whether GST is in the base, and the goods that set the section. */
export type TcsSuggestion = Omit<TdsSuggestion, 'sectionFrom' | 'candidates'> & {
  kind: 'tcs'
  sectionFrom: 'party' | 'goods' | 'ledger' | 'chosen' | 'credits'
  candidates: { sectionId: number; code: string; from: 'party' | 'goods' | 'ledger' | 'credits' }[]
  gstInBase: boolean
  /** s.206C(1G) tour package (FY 2025-26): how the base splits across the ₹10 lakh slab
   *  (src/shared/tcsSources.ts TCS_SLABS); null for every other section. */
  slab: { limitPaise: number; priorPaise: number; belowPaise: number; abovePaise: number; lowerRateBp: number; upperRateBp: number } | null
}

/**
 * Suggests a TCS collection for a sale to / receipt from `partyLedgerId`, or null when nothing
 * applies. Strictly read-only (a missing TCS payable ledger is created by saveVoucher —
 * tcs.autoPayable). Section precedence mirrors classifyTcsVoucher: chosen → buyer → goods →
 * sales ledger. The base is the flagged part of the invoice (with its GST share when the rate
 * row's base includes GST), or on a receipt the uncollected sales + advance.
 */
export function tcsSuggestion(db: DB, input: TcsSuggestInput): TcsSuggestion | null {
  const party = db.prepare('SELECT id, tcs_section_id AS s FROM ledgers WHERE id = ?').get(input.partyLedgerId) as { id: number; s: number | null } | undefined
  if (!party) return null
  const ctx = tcsContext(db)
  const code = (id: number): string => (db.prepare('SELECT code FROM tds_sections WHERE id = ?').get(id) as { code: string } | undefined)?.code ?? String(id)
  const isTcs = (id: number): boolean => !!db.prepare("SELECT 1 FROM tds_sections WHERE id = ? AND kind = 'tcs'").get(id)
  const items = input.items ?? []
  const totalTaxable = input.taxablePaise
  const candidates: TcsSuggestion['candidates'] = []
  const subjectOf = new Map<number, number>()
  if (party.s != null) {
    candidates.push({ sectionId: party.s, code: code(party.s), from: 'party' })
    subjectOf.set(party.s, totalTaxable)
  }
  if (input.voucherKind === 'sales') {
    for (const i of items) {
      const s = ctx.items.get(i.stockItemId)?.sectionId
      if (s == null) continue
      if (!candidates.some((c) => c.sectionId === s)) candidates.push({ sectionId: s, code: code(s), from: 'goods' })
      if (!(party.s === s)) subjectOf.set(s, (subjectOf.get(s) ?? 0) + i.amount)
    }
    const ls = input.salesLedgerId != null ? ctx.facts.get(input.salesLedgerId)?.defaultSectionId : null
    if (ls != null && !candidates.some((c) => c.sectionId === ls)) {
      candidates.push({ sectionId: ls, code: code(ls), from: 'ledger' })
      subjectOf.set(ls, totalTaxable)
    }
  }
  const fy = fyOf(input.date)
  if (input.voucherKind === 'receipt' && candidates.length === 0) {
    const groups = buildTcsEventGroups(loadTcsVouchers(db, fy.from, input.date, { partyLedgerId: input.partyLedgerId, excludeVoucherId: input.excludeVoucherId }), ctx)
    for (const g of groups.values()) {
      if (g.partyLedgerId === input.partyLedgerId && !candidates.some((c) => c.sectionId === g.sectionId)) {
        candidates.push({ sectionId: g.sectionId, code: code(g.sectionId), from: 'credits' })
      }
    }
  }
  let sectionId: number | null = null
  let sectionFrom: TcsSuggestion['sectionFrom'] = 'party'
  if (input.sectionId != null && isTcs(input.sectionId)) {
    sectionId = input.sectionId
    sectionFrom = 'chosen'
    if (!candidates.some((c) => c.sectionId === sectionId)) candidates.push({ sectionId, code: code(sectionId), from: 'ledger' })
  } else if (candidates[0]) {
    sectionId = candidates[0].sectionId
    sectionFrom = candidates[0].from
  }
  if (sectionId == null) return null
  const section = db.prepare('SELECT code, legacy_code, new_reference FROM tds_sections WHERE id = ?').get(sectionId) as
    { code: string; legacy_code: string | null; new_reference: string | null }
  const type = ctx.facts.get(input.partyLedgerId)?.deducteeType ?? null
  const row = rateRowOn(ctx.rates.get(sectionId) ?? [], input.date, type)
  if (!row) return null

  let base: number
  let payment: TdsSuggestion['payment'] = null
  if (input.voucherKind === 'receipt') {
    const { results, group } = tcsPartySectionWalk(db, input.partyLedgerId, sectionId, fy.from, input.date, input.excludeVoucherId)
    const uncollected = undeductedCreditsBefore(results, input.date, input.excludeVoucherId)
    let debited = 0
    let received = 0
    for (const e of group?.events ?? []) {
      if (e.exempt) continue
      if (e.kind === 'credit') debited += e.grossPaise
      else received += e.grossPaise
    }
    const advance = Math.min(input.taxablePaise, Math.max(0, received + input.taxablePaise - debited))
    base = Math.min(input.taxablePaise, uncollected + advance)
    payment = { undeductedBillsPaise: uncollected, advancePaise: advance, deductedAtCredit: base === 0 }
  } else {
    const subject = Math.min(totalTaxable, subjectOf.get(sectionId) ?? totalTaxable)
    const gst = input.gstPaise ?? 0
    const gstShare = subject === totalTaxable ? gst : totalTaxable > 0 ? Math.round((gst * subject) / totalTaxable) : 0
    base = tcsBasePaise({ taxablePaise: subject, gstPaise: gstShare }, row)
  }

  const resolved = resolveTds(db, sectionId, input.partyLedgerId, Math.max(base, 1), input.date, input.excludeVoucherId)
  if (!resolved.rate || resolved.tdsPaise == null) return null
  const status = thresholdStatus(resolved.rate.row, input.date, base, resolved.priorPaise)
  const payable = findPayableLedger(db, sectionId)
  const effectiveBp = resolved.slab && resolved.slab.abovePaise > 0
    ? resolved.slab.upperRateBp
    : resolved.rate.basis === 'certificate' ? resolved.rate.certificateRateBp! : resolved.rate.rateBp
  const cert = resolved.rate.certificateId != null
    ? (db.prepare('SELECT id, certificate_no, rate_bp, valid_to FROM tds_certificates WHERE id = ?').get(resolved.rate.certificateId) as
      { id: number; certificate_no: string; rate_bp: number; valid_to: string })
    : null
  return {
    kind: 'tcs',
    sectionId,
    code: section.code,
    reference: sectionReferenceOn({ code: section.code, legacyCode: section.legacy_code, newReference: section.new_reference }, input.date),
    rate: effectiveBp / 100,
    rateBp: effectiveBp,
    basis: resolved.rate.basis,
    tdsPaise: base > 0 ? resolved.tdsPaise : 0,
    basePaise: base,
    payableLedgerId: payable?.id ?? null,
    payableLedgerName: payable?.name ?? KIND.tcs.payableName(section.code),
    panAvailable: resolved.panAvailable,
    deducteeType: resolved.deducteeType,
    thresholdCrossed: status.crossed,
    threshold: {
      reason: status.reason, singlePaise: resolved.rate.row.thresholdSinglePaise, aggregateLimitPaise: resolved.rate.row.thresholdAnnualPaise,
      basis: resolved.rate.row.thresholdBasis, priorPaise: resolved.priorPaise
    },
    certificate: cert ? { id: cert.id, certificateNo: cert.certificate_no, rateBp: cert.rate_bp, validTo: cert.valid_to } : null,
    sectionFrom,
    candidates,
    payment,
    gstInBase: !!row.baseIncludesGst && input.voucherKind === 'sales',
    slab: resolved.slab
      ? {
          limitPaise: resolved.slab.limitPaise, priorPaise: resolved.priorPaise, belowPaise: resolved.slab.belowPaise,
          abovePaise: resolved.slab.abovePaise, lowerRateBp: resolved.slab.lowerRateBp, upperRateBp: resolved.slab.upperRateBp
        }
      : null
  }
}

// ---------------------------------------------------------------------------------------------
// Statutory sections a company can add (s.206C(1C) — src/shared/tcsSources.ts)
// ---------------------------------------------------------------------------------------------

export interface TcsStatutoryStatus {
  code: string
  description: string
  legacyCode: string
  newReference: string
  /** The company's section of that code, or null when it has none yet. */
  sectionId: number | null
}

/** Each statutory section of TCS_STATUTORY_SECTIONS and whether the company has it (by code). */
export function statutoryTcsSections(db: DB): TcsStatutoryStatus[] {
  const have = new Map(listSections(db, 'tcs').map((s) => [s.code, s.id]))
  return TCS_STATUTORY_SECTIONS.map((s) => ({
    code: s.code, description: s.description, legacyCode: s.legacyCode, newReference: s.newReference, sectionId: have.get(s.code) ?? null
  }))
}

/**
 * Add the statutory sections the company lacks (all of them, or only `codes`) with their cited,
 * effective-dated rate rows — base incl. GST like every WP 3.3 row (UNVERIFIED for 1C, listed in
 * tcsSources.ts). No migration: an owner action that writes the same rows the Sections editor
 * would, each audited (tdsSection / tdsRate create). Idempotent — a code the company already has
 * (seeded, added before, or made by hand) is left alone. Returns the sections created.
 */
export function addStatutoryTcsSections(db: DB, codes?: readonly string[]): TdsSection[] {
  const wanted = codes ? new Set(codes) : null
  const unknown = codes?.filter((c) => !TCS_STATUTORY_SECTIONS.some((s) => s.code === c)) ?? []
  if (unknown.length > 0) throw new Error(`Not a statutory TCS section Total can add: ${unknown.join(', ')}`)
  return db.transaction(() => {
    const have = new Set((db.prepare('SELECT code FROM tds_sections').all() as { code: string }[]).map((r) => r.code))
    const created: TdsSection[] = []
    const today = todayISO()
    for (const def of TCS_STATUTORY_SECTIONS) {
      if ((wanted && !wanted.has(def.code)) || have.has(def.code)) continue
      // The legacy rate column mirrors the row in force today (else the latest row), as saveRate keeps it.
      const now = def.rates.find((r) => r.effectiveFrom <= today && (r.effectiveTo == null || today <= r.effectiveTo)) ?? def.rates[def.rates.length - 1]!
      const res = db.prepare(
        `INSERT INTO tds_sections (code, description, rate, threshold_single, threshold_annual, nature, act, legacy_code, new_reference, kind)
         VALUES (?, ?, ?, 0, 0, ?, 'it_act_1961', ?, ?, 'tcs')`
      ).run(def.code, def.description, now.rateBp / 100, def.nature, def.legacyCode, def.newReference)
      const sectionId = Number(res.lastInsertRowid)
      const section = listSections(db, 'tcs').find((s) => s.id === sectionId)!
      writeAudit(db, 'tdsSection', sectionId, 'create', null, { ...section, via: 'tcs:statutoryAdd' })
      for (const r of def.rates) {
        const rr = db.prepare(
          `INSERT INTO tds_section_rates (section_id, effective_from, effective_to, deductee_type, rate_bp,
             threshold_single_paise, threshold_annual_paise, threshold_basis, threshold_excess_only, return_code, no_pan_rate_bp,
             base_includes_gst, source)
           VALUES (?, ?, ?, 'any', ?, 0, 0, 'fy', 0, ?, ?, 1, ?)`
        ).run(sectionId, r.effectiveFrom, r.effectiveTo, r.rateBp, r.returnCode, r.noPanRateBp, r.source)
        const rateId = Number(rr.lastInsertRowid)
        writeAudit(db, 'tdsRate', rateId, 'create', null, listRates(db, sectionId).find((x) => x.id === rateId)!)
      }
      created.push(section)
    }
    return created
  })()
}
