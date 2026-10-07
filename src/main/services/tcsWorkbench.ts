/**
 * The TCS screen's server side (WP 3.3) — what differs from the TDS workbench: the Eligible list
 * (sales / receipts that should carry TCS and don't), Move to TCS / remove on a saved sale, and
 * the Form 27EQ (Form 143 from 1 Apr 2026) and Form 27D (Form 133) data. Collected entries,
 * challans + allocation + interest, the ledger summary card and "not applicable" marks are the
 * kind-aware functions of tdsWorkbench.ts / tds.ts called with kind 'tcs'.
 *
 * Every voucher edit goes through saveVoucher (lock date, closing-journal immutability, posting
 * validation, the TCS rate check and the buyer-debit check, the audit row), exactly as for TDS.
 */
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { fyFromStartYear, fyOf } from '@shared/dates'
import { addTcsToLines, candidateTcsSections, isDeclarationReason, removeTcsFromLines, collecteeCodeForReturn } from '@shared/tcs'
import { quarterBounds } from '@shared/withholding'
import { undeductedCreditsBefore } from '@shared/tdsEligibility'
import type { Form16aData, Form26qData, TdsEligibleRow } from '@shared/tdsTypes'
import { voucherToPayload } from '@shared/voucherEdit'
import { rowsToCsv } from '@shared/csv'
import { plainRupees } from '@shared/money'
import { companyExportsDir } from '../paths'
import {
  buildTcsEventGroups, classifyLoaded, eventBase, loadTcsVouchers, tcsContext, tcsPartySectionWalk, walkTcsGroup,
  type LoadedTcsVoucher
} from './tcsEvents'
import { payableTagMap, resolveTds } from './tds'
import { assertEditable, form16aData, form26qData, head } from './tdsWorkbench'
import { getVoucher, saveVoucher } from './vouchers'
import { writeAudit } from './audit'

const sectionCodes = (db: DB): Map<number, string> =>
  new Map((db.prepare("SELECT id, code FROM tds_sections WHERE kind = 'tcs'").all() as { id: number; code: string }[]).map((r) => [r.id, r.code]))

// ---------------------------------------------------------------------------------------------
// Eligible
// ---------------------------------------------------------------------------------------------

/**
 * Every sale (or advance receipt) dated in [from, to] that should carry TCS and does not —
 * buyers flagged for a section, goods flagged with one, sales ledgers with a default — walked
 * from the start of the FY so an aggregate threshold crossed mid-year lists the earlier sales
 * too. Binned, optional, unmatured post-dated vouchers never count. `includeExempt` also lists
 * the "Not applicable" marks (a Form 27C declaration, a buyer outside the definition …).
 */
export function tcsEligible(db: DB, from: string, to: string, opts: { includeExempt?: boolean } = {}): TdsEligibleRow[] {
  const ctx = tcsContext(db)
  const vouchers = loadTcsVouchers(db, fyOf(from).from, to)
  const byId = new Map(vouchers.map((v) => [v.id, v]))
  const groups = buildTcsEventGroups(vouchers, ctx)
  const codes = sectionCodes(db)
  const out: TdsEligibleRow[] = []
  const factOf = (id: number) => ctx.facts.get(id) ?? null
  const itemOf = (id: number): number | null => ctx.items.get(id)?.sectionId ?? null
  for (const g of groups.values()) {
    const party = ctx.facts.get(g.partyLedgerId)
    for (const r of walkTcsGroup(g, ctx)) {
      if (r.date < from || r.date > to) continue
      const v = byId.get(r.voucherId)!
      const exempt = v.exemptReason != null
      if (exempt ? !opts.includeExempt : r.eligibleBasePaise <= 0 || !r.reason) continue
      if (v.entry) continue
      const cls = g.classes.get(r.voucherId)!
      const base = exempt ? (g.events.find((e) => e.voucherId === v.id)?.basePaise ?? cls.taxablePaise) : r.row?.thresholdExcessOnly ? r.eventBasePaise : r.eligibleBasePaise
      const resolved = base > 0 ? resolveTds(db, g.sectionId, g.partyLedgerId, base, v.date, v.id) : null
      const rate = resolved?.rate
      out.push({
        voucherId: v.id, voucherNumber: v.number, date: v.date, kind: v.kind,
        partyLedgerId: g.partyLedgerId, partyName: party?.name ?? '', pan: party?.pan ?? null, deducteeType: party?.deducteeType ?? null,
        expenseLedgerId: cls.salesLedgerId, expenseLedgerName: cls.salesLedgerId != null ? (ctx.facts.get(cls.salesLedgerId)?.name ?? null) : null,
        stockItemId: cls.stockItemId, stockItemName: cls.stockItemId != null ? (ctx.items.get(cls.stockItemId)?.name ?? null) : null,
        sectionId: g.sectionId, sectionCode: codes.get(g.sectionId) ?? '',
        basePaise: base,
        rateBp: rate ? (rate.basis === 'certificate' ? rate.certificateRateBp : rate.rateBp) : null,
        tdsPaise: resolved?.tdsPaise ?? null,
        reason: r.reason ?? 'none',
        exemptReason: v.exemptReason,
        candidates: candidateTcsSections(v, g.partyLedgerId, factOf, itemOf).map((c) => ({ sectionId: c.sectionId, code: codes.get(c.sectionId) ?? '' }))
      })
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.voucherId - b.voucherId)
}

// ---------------------------------------------------------------------------------------------
// Move to TCS / remove
// ---------------------------------------------------------------------------------------------

export interface ApplyTcsInput {
  voucherId: number
  sectionId?: number | null
  /** A typed collection (stored is_manual); default = the rate table's figure. */
  manualPaise?: number | null
}

function loadOne(db: DB, voucherId: number, date: string): LoadedTcsVoucher | null {
  return loadTcsVouchers(db, date, date).find((x) => x.id === voucherId) ?? null
}

/**
 * Move to TCS: add the collection to a saved SALE through saveVoucher — the buyer's debit (and
 * its new bill) grows by the TCS, the section's TCS payable ledger is credited (created at save
 * when missing). A saved receipt is refused (the amount banked is fixed — collect from the
 * receipt's own banner). Base = the walk's eligible base; TCS = the rate table's figure unless
 * `manualPaise` is given.
 */
export function applyTcsToVoucher(db: DB, input: ApplyTcsInput): ReturnType<typeof getVoucher> {
  const v = getVoucher(db, input.voucherId)
  if (!v) throw new Error('Voucher not found')
  const h = head(db, v.id)
  assertEditable(db, v.id, v.date, h, 'tcs')
  if (v.tcs) throw new Error('This voucher already carries a TCS collection — edit it in the voucher editor')
  if (h.kind === 'receipt') throw new Error("A saved receipt's amount banked is fixed — open the receipt and apply TCS from its banner")
  const ctx = tcsContext(db)
  const loaded = loadOne(db, v.id, v.date)
  const cls = loaded ? classifyLoaded(loaded, ctx, input.sectionId ?? null) : null
  if (!cls || cls.sectionId == null) {
    throw new Error('No buyer to collect from — the sale needs a customer debited who is flagged for TCS, or goods / a sales ledger with a TCS section')
  }
  const sectionId = cls.sectionId
  if (!db.prepare("SELECT 1 FROM tds_sections WHERE id = ? AND kind = 'tcs'").get(sectionId)) throw new Error('TCS section not found')
  const fy = fyOf(v.date)
  const { results } = tcsPartySectionWalk(db, cls.partyLedgerId, sectionId, fy.from, fy.to)
  const mine = results.find((r) => r.voucherId === v.id)
  let base = eventBase(cls, sectionId, v.date, ctx)
  if (mine && mine.eligibleBasePaise > 0) base = mine.row?.thresholdExcessOnly ? mine.eventBasePaise : mine.eligibleBasePaise
  const manual = input.manualPaise != null
  let tcsPaise: number
  if (manual) tcsPaise = input.manualPaise!
  else {
    const resolved = resolveTds(db, sectionId, cls.partyLedgerId, base, v.date, v.id)
    if (resolved.tdsPaise == null) throw new Error('No TCS rate is in force for this section on the voucher date — add one under TCS › Sections')
    tcsPaise = resolved.tdsPaise
  }
  if (tcsPaise <= 0) throw new Error('Nothing to collect — the rate table gives ₹0 on this base')
  if (tcsPaise > base) throw new Error('TCS cannot exceed its base amount')
  const payload = voucherToPayload(v)
  const edit = addTcsToLines(h.kind, payload.lines, payload.billRefs, { partyLedgerId: cls.partyLedgerId, tcsPaise })
  if (!edit.ok) throw new Error(edit.error)
  return db.transaction(() => {
    db.prepare("DELETE FROM tds_exemptions WHERE voucher_id = ? AND kind = 'tcs'").run(v.id)
    saveVoucher(
      db,
      {
        ...payload,
        partyLedgerId: payload.partyLedgerId ?? cls.partyLedgerId,
        lines: edit.lines,
        billRefs: edit.billRefs,
        tcs: { sectionId, baseAmount: base, tcsAmount: tcsPaise, isManual: manual, autoPayable: true }
      },
      v.id
    )
    const after = getVoucher(db, v.id)!
    writeAudit(db, 'tcsEntry', after.tcs?.entryId ?? v.id, 'create', null, {
      voucherId: v.id, sectionId, baseAmount: base, tcsAmount: tcsPaise, isManual: manual, via: 'tcs:applyToVoucher', raisedLedgerId: edit.targetLedgerId
    })
    return after
  })()
}

/** Delete a collection: drop the TCS payable credit and take it off the buyer's debit (sale) or
 *  give it back to the buyer's credit (receipt) — through saveVoucher; its challan allocation
 *  goes with the entry. */
export function removeTcsFromVoucher(db: DB, voucherId: number): ReturnType<typeof getVoucher> {
  const v = getVoucher(db, voucherId)
  if (!v) throw new Error('Voucher not found')
  const h = head(db, v.id)
  assertEditable(db, v.id, v.date, h, 'tcs')
  if (!v.tcs) throw new Error('This voucher carries no TCS collection')
  const entry = db.prepare('SELECT party_ledger_id AS p FROM tds_entries WHERE id = ?').get(v.tcs.entryId) as { p: number }
  const tags = payableTagMap(db, 'tcs')
  const sectionId = v.tcs.sectionId
  const payload = voucherToPayload(v)
  const edit = removeTcsFromLines(h.kind, payload.lines, payload.billRefs, {
    partyLedgerId: entry.p,
    isPayableLine: (l) => tags.get(l.ledgerId) === sectionId
  })
  if (!edit.ok) throw new Error(edit.error)
  const before = { ...v.tcs }
  return db.transaction(() => {
    saveVoucher(db, { ...payload, lines: edit.lines, billRefs: edit.billRefs, tcs: null }, v.id)
    writeAudit(db, 'tcsEntry', before.entryId ?? v.id, 'delete', { voucherId: v.id, ...before }, { via: 'tcs:removeFromVoucher', restoredLedgerId: edit.targetLedgerId })
    return getVoucher(db, v.id)
  })()
}

/** Receipts: the uncollected sales + advance a receipt would collect on (for tests / the banner). */
export function tcsUncollectedBefore(db: DB, partyLedgerId: number, sectionId: number, dateISO: string, excludeVoucherId?: number): number {
  const fy = fyOf(dateISO)
  const { results } = tcsPartySectionWalk(db, partyLedgerId, sectionId, fy.from, dateISO, excludeVoucherId)
  return undeductedCreditsBefore(results, dateISO, excludeVoucherId)
}

// ---------------------------------------------------------------------------------------------
// Returns: Form 27EQ / Form 143 data, Form 27D / Form 133 data
// ---------------------------------------------------------------------------------------------

/**
 * Form 27EQ (Form 143 from 1 Apr 2026) collectee + challan data for a quarter: the recorded
 * collections (form26qData with kind 'tcs' — 27EQ section / Form 143 collection code from the
 * rate row in force, collectee code from the PAN's fourth character, remark A certificate /
 * C no PAN), plus the sales on which nothing was collected because the buyer gave a Form 27C
 * (s.206C(1A)) / Form 127 (s.394(2)) declaration — reported with remark B and TCS 0. Layouts per
 * the Protean 27EQ v6.9 / Form 143 v1.1 file formats cited in migration 027.
 */
export function form27eqData(db: DB, fyStartYear: number, quarter: 1 | 2 | 3 | 4): Form26qData {
  const data = form26qData(db, fyStartYear, quarter, 'tcs')
  const { from, to } = quarterBounds(fyStartYear, quarter)
  const ctx = tcsContext(db)
  const codes = sectionCodes(db)
  const declared = loadTcsVouchers(db, from, to).filter((v) => !v.entry && isDeclarationReason(v.exemptReason))
  let serial = data.deductees.length
  for (const v of declared) {
    const cls = classifyLoaded(v, ctx)
    if (!cls || cls.sectionId == null || cls.eventKind !== 'credit') continue
    const party = ctx.facts.get(cls.partyLedgerId)
    const row = (ctx.rates.get(cls.sectionId) ?? []).find((r) => r.effectiveFrom <= v.date && (r.effectiveTo == null || v.date <= r.effectiveTo))
    data.deductees.push({
      serial: ++serial, entryId: -v.id, voucherId: v.id, partyLedgerId: cls.partyLedgerId, partyName: party?.name ?? '', pan: party?.pan ?? null,
      deducteeCode: collecteeCodeForReturn(party?.pan ?? null, party?.deducteeType ?? null, data.layout === 'form143' ? 'form143' : 'form27eq'),
      sectionCode: codes.get(cls.sectionId) ?? '', returnCode: row?.returnCode ?? null, paymentDate: v.date,
      amountPaise: eventBase(cls, cls.sectionId, v.date, ctx), tdsPaise: 0, deductionDate: v.date, rateBp: null, reasonCode: 'B',
      challanSerial: null, bsrCode: null, challanDate: null, challanNo: null
    })
  }
  data.deductees.sort((a, b) => a.paymentDate.localeCompare(b.paymentDate) || a.voucherId - b.voucherId)
  data.deductees.forEach((d, i) => (d.serial = i + 1))
  data.totals.amountPaise = data.deductees.reduce((s, d) => s + d.amountPaise, 0)
  return data
}

/** Data for Form 27D (TCS certificate, rule 37D; Form 133 under the 2026 Rules) per collectee. */
export function form27dData(db: DB, company: CompanyInfo, fyStartYear: number, quarter: 1 | 2 | 3 | 4, partyLedgerId?: number): Form16aData {
  return form16aData(db, company, fyStartYear, quarter, partyLedgerId, 'tcs')
}

/**
 * CSV of collectee-wise TCS for a quarter (27EQ / Form 143 data) — for manual entry into the
 * return preparation utility, NOT a ready-to-file FVU. A "Challans" block follows when the
 * quarter has challans. Written to the company's exports folder.
 */
export function export27eqCsv(db: DB, slug: string, fyStartYear: number, quarter: 1 | 2 | 3 | 4): string {
  const data = form27eqData(db, fyStartYear, quarter)
  const numbers = db.prepare('SELECT number FROM vouchers WHERE id = ?')
  const challanAmount = new Map(data.challans.map((c) => [c.serial, c.amountPaise]))
  let csv = rowsToCsv(
    ['Collectee', 'PAN', 'Collectee Code', 'Section', 'Return Code', 'Date', 'Voucher No', 'Amount (Rs)', 'Rate (%)', 'TCS (Rs)',
      'Remark', 'Challan BSR', 'Challan Date', 'Challan Serial', 'Challan Amount (Rs)'],
    data.deductees.map((r) => [
      r.partyName, r.pan ?? '', r.deducteeCode, r.sectionCode, r.returnCode ?? '', r.paymentDate,
      (numbers.get(r.voucherId) as { number: string } | undefined)?.number ?? '',
      plainRupees(r.amountPaise), r.rateBp != null ? (r.rateBp / 100).toFixed(2) : '', plainRupees(r.tdsPaise), r.reasonCode,
      r.bsrCode ?? '', r.challanDate ?? '', r.challanNo ?? '', r.challanSerial != null ? plainRupees(challanAmount.get(r.challanSerial) ?? 0) : ''
    ])
  )
  if (data.challans.length > 0) {
    const block = rowsToCsv(
      ['Challan #', 'Challan BSR', 'Challan Date', 'Challan Serial', 'Challan Amount (Rs)', 'TCS Allocated (Rs)', 'Entries'],
      data.challans.map((c) => [String(c.serial), c.bsrCode, c.date, c.challanNo, plainRupees(c.amountPaise), plainRupees(c.allocatedPaise), String(c.entries)])
    )
    csv = `${csv.trimEnd()}\r\n\r\n${block.replace('﻿', '')}`
  }
  const fy = fyFromStartYear(fyStartYear)
  const path = join(companyExportsDir(slug), `tcs-${data.layout === 'form143' ? 'form143' : '27eq'}-${fy.label}-Q${quarter}.csv`)
  writeFileSync(path, csv)
  return path
}
