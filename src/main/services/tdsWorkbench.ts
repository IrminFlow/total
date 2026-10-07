/**
 * The TDS screen's server side (WP 3.2): the Eligible list, Move to TDS / remove / Not
 * applicable on a saved voucher, the Deducted list, the TDS ledger summary card, challans from
 * payment vouchers with auto-allocation and indicative interest, Form 26Q / Form 16A data.
 *
 * Every voucher edit goes through saveVoucher — lock date, closing-journal immutability,
 * manufacture ownership, posting validation, the TDS rate check and the voucher audit row all
 * apply exactly as for a typed edit. The per-kind line rules are in src/shared/tdsEligibility.ts
 * (tdsTargetIndex): purchase / journal → the party's credit gives up the TDS; payment → the
 * bank/cash credit does. The payable credit is appended last by saveVoucher (tds.autoPayable).
 */
import type { DB } from '../db/connection'
import type { CompanyInfo, VoucherKind } from '@shared/domain'
import { fyOf, fyFromStartYear } from '@shared/dates'
import {
  addTdsToLines, candidateSections, classifyTdsVoucher, removeTdsFromLines, TDS_KINDS, undeductedCreditsBefore, type TdsLedgerFacts
} from '@shared/tdsEligibility'
import { lateDepositInterest, LATE_DEPOSIT_RATE_BP } from '@shared/tdsInterest'
import { collecteeCodeForReturn, tcsDepositDueDate, TCS_KINDS, TCS_LATE_PAYMENT_RATE_BP } from '@shared/tcs'
import { KIND, type WithholdingKind } from './withholdingKind'
import { rateRowOn, tdsQuarterBounds, tdsQuarterOf, IT_ACT_2025_FROM, type DeducteeType } from '@shared/tds'
import { tdsStateFromSaved, voucherToPayload } from '@shared/voucherEdit'
import type {
  ChallanStatus, Form16aData, Form26qData, TdsChallanEntryInterest, TdsChallanRow, TdsDeductedRow, TdsEligibleRow,
  TdsLedgerSummaryRow, TdsPaymentCandidate
} from '@shared/tdsTypes'
import { buildEventGroups, ledgerTdsFacts, loadTdsVouchers, partySectionWalk, ratesBySection, walkGroup } from './tdsEvents'
import { allocateEntries, challanKind, listChallans, payableTagMap, resolveTds, saveChallan } from './tds'
import { getLockDate, getVoucher, IN_BOOKS, NOT_DELETED, saveVoucher, YEAR_END_CLOSE_IMMUTABLE } from './vouchers'
import { writeAudit } from './audit'

const sectionCodes = (db: DB): Map<number, string> =>
  new Map((db.prepare('SELECT id, code FROM tds_sections').all() as { id: number; code: string }[]).map((r) => [r.id, r.code]))

// ---------------------------------------------------------------------------------------------
// Eligible
// ---------------------------------------------------------------------------------------------

/**
 * Every voucher dated in [from, to] that should carry TDS and does not. Thresholds are walked
 * from the start of `from`'s financial year over EVERY qualifying credit/advance to the party
 * (src/shared/tdsEligibility.ts), so an aggregate crossed mid-year makes the earlier bills
 * eligible too. Binned, optional, unmatured post-dated and year-end closing vouchers are never
 * listed nor counted. `includeExempt` also lists the "Not applicable" marks.
 */
export function tdsEligible(db: DB, from: string, to: string, opts: { includeExempt?: boolean } = {}): TdsEligibleRow[] {
  const facts = ledgerTdsFacts(db)
  const vouchers = loadTdsVouchers(db, fyOf(from).from, to)
  const byId = new Map(vouchers.map((v) => [v.id, v]))
  const groups = buildEventGroups(vouchers, facts)
  const rates = ratesBySection(db)
  const codes = sectionCodes(db)
  const out: TdsEligibleRow[] = []
  const factOf = (id: number): TdsLedgerFacts | null => facts.get(id) ?? null
  for (const g of groups.values()) {
    const party = facts.get(g.partyLedgerId)
    const results = walkGroup(g, rates, party?.deducteeType ?? null)
    for (const r of results) {
      if (r.date < from || r.date > to) continue
      const v = byId.get(r.voucherId)!
      const exempt = v.exemptReason != null
      if (exempt ? !opts.includeExempt : r.eligibleBasePaise <= 0 || !r.reason) continue
      if (v.entry) continue
      const cls = g.classes.get(r.voucherId)!
      // Excess-only rows (194Q) record the whole event base; the rate table takes the excess.
      const base = exempt ? cls.basePaise : r.row?.thresholdExcessOnly ? r.eventBasePaise : r.eligibleBasePaise
      const resolved = base > 0 ? resolveTds(db, g.sectionId, g.partyLedgerId, base, v.date, v.id) : null
      const rate = resolved?.rate
      out.push({
        voucherId: v.id, voucherNumber: v.number, date: v.date, kind: v.kind,
        partyLedgerId: g.partyLedgerId, partyName: party?.name ?? '', pan: party?.pan ?? null, deducteeType: party?.deducteeType ?? null,
        expenseLedgerId: cls.expenseLedgerId, expenseLedgerName: cls.expenseLedgerId != null ? (facts.get(cls.expenseLedgerId)?.name ?? null) : null,
        sectionId: g.sectionId, sectionCode: codes.get(g.sectionId) ?? '',
        basePaise: base,
        rateBp: rate ? (rate.basis === 'certificate' ? rate.certificateRateBp : rate.rateBp) : null,
        tdsPaise: resolved?.tdsPaise ?? null,
        reason: r.reason ?? 'none',
        exemptReason: v.exemptReason,
        candidates: candidateSections(v, g.partyLedgerId, factOf).map((c) => ({ sectionId: c.sectionId, code: codes.get(c.sectionId) ?? '' }))
      })
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.voucherId - b.voucherId)
}

// ---------------------------------------------------------------------------------------------
// Move to TDS / remove / Not applicable
// ---------------------------------------------------------------------------------------------

interface VoucherHead {
  kind: VoucherKind
  isYearEndClose: number
  deletedAt: string | null
  isOptional: number
  currencyCode: string | null
}

export function head(db: DB, voucherId: number): VoucherHead {
  const h = db
    .prepare(
      `SELECT vt.kind, v.is_year_end_close AS isYearEndClose, v.deleted_at AS deletedAt, v.is_optional AS isOptional,
              v.currency_code AS currencyCode
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = ?`
    )
    .get(voucherId) as VoucherHead | undefined
  if (!h) throw new Error('Voucher not found')
  return h
}

/** The refusals that apply to every server-side TDS (or, with kind 'tcs', TCS) edit, with the
 *  reason in words. */
export function assertEditable(db: DB, voucherId: number, date: string, h: VoucherHead, kind: WithholdingKind = 'tds'): void {
  const name = KIND[kind].name
  const noun = kind === 'tcs' ? 'collection' : 'deduction'
  if (h.deletedAt) throw new Error('The voucher is in the bin — restore it first')
  if (h.isYearEndClose) throw new Error(YEAR_END_CLOSE_IMMUTABLE)
  if (h.isOptional) throw new Error(`An optional (memorandum) voucher isn't in the books — ${name} can't be moved onto it`)
  if (h.currencyCode) throw new Error(`Foreign-currency voucher — add the ${noun} in the voucher editor, where the rate is visible`)
  if (!(kind === 'tcs' ? TCS_KINDS : TDS_KINDS).includes(h.kind)) throw new Error(`A ${h.kind.replace('_', ' ')} can't carry a ${name} ${noun}`)
  const lock = getLockDate(db)
  if (lock && date <= lock) throw new Error(`Books are locked up to ${lock} — this voucher can't be changed`)
  const fy = fyOf(date)
  const closed = db
    .prepare(`SELECT 1 FROM vouchers v WHERE ${NOT_DELETED} AND v.is_year_end_close = 1 AND v.date BETWEEN ? AND ? LIMIT 1`)
    .get(fy.from, fy.to)
  if (closed) {
    throw new Error(`FY ${fy.label} is closed — move its closing journal to the bin to reopen the year, then move ${name} onto this voucher`)
  }
}

export interface ApplyTdsInput {
  voucherId: number
  /** Section to deduct under; default = the voucher's classification (party flag / ledger default). */
  sectionId?: number | null
  /** A typed deduction (is_manual); default = the rate table's figure. */
  manualPaise?: number | null
}

/**
 * Move to TDS: add the deduction to a saved voucher through saveVoucher. Base = the walk's
 * eligible base for the voucher (the excess-only rows record the whole event base), or for a
 * payment the undeducted bills plus any advance; the TDS is the rate table's figure unless
 * `manualPaise` is given. Refused with a reason when it can't be done safely.
 */
export function applyTdsToVoucher(db: DB, input: ApplyTdsInput): ReturnType<typeof getVoucher> {
  const v = getVoucher(db, input.voucherId)
  if (!v) throw new Error('Voucher not found')
  const h = head(db, v.id)
  assertEditable(db, v.id, v.date, h)
  if (v.tds) throw new Error('This voucher already carries a TDS deduction — edit it in the voucher editor')
  const facts = ledgerTdsFacts(db)
  const factOf = (id: number): TdsLedgerFacts | null => facts.get(id) ?? null
  let cls = classifyTdsVoucher({ kind: h.kind, partyLedgerId: v.partyLedgerId, lines: v.lines }, factOf, input.sectionId ?? null)
  if (!cls) throw new Error('No deductee on this voucher — it needs a supplier credited (bill) or paid (payment) who is flagged for TDS or has a PAN')
  let sectionId = cls.sectionId
  if (sectionId == null) {
    const fy = fyOf(v.date)
    const groups = buildEventGroups(loadTdsVouchers(db, fy.from, fy.to, { partyLedgerId: cls.partyLedgerId }), facts)
    sectionId = [...groups.values()].find((g) => g.partyLedgerId === cls!.partyLedgerId)?.sectionId ?? null
    if (sectionId == null) throw new Error('Choose a TDS section — the party has none and no bill sets one')
    cls = { ...cls, sectionId }
  }
  if (!db.prepare("SELECT 1 FROM tds_sections WHERE id = ? AND kind = 'tds'").get(sectionId)) throw new Error('TDS section not found')

  // Base from the walk (this voucher included).
  const fy = fyOf(v.date)
  const { results } = partySectionWalk(db, cls.partyLedgerId, sectionId, fy.from, fy.to)
  const mine = results.find((r) => r.voucherId === v.id)
  let base = cls.basePaise
  if (mine && mine.eligibleBasePaise > 0) base = mine.row?.thresholdExcessOnly ? mine.eventBasePaise : mine.eligibleBasePaise
  else if (cls.eventKind === 'payment') {
    const undeducted = undeductedCreditsBefore(results, v.date, v.id)
    base = Math.min(cls.grossPaise, undeducted + (mine?.eventBasePaise ?? 0)) || cls.grossPaise
  }
  const manual = input.manualPaise != null
  let tdsPaise: number
  if (manual) {
    tdsPaise = input.manualPaise!
  } else {
    const resolved = resolveTds(db, sectionId, cls.partyLedgerId, base, v.date, v.id)
    if (resolved.tdsPaise == null) throw new Error('No TDS rate is in force for this section on the voucher date — add one under TDS › Sections')
    tdsPaise = resolved.tdsPaise
  }
  if (tdsPaise <= 0) throw new Error('Nothing to deduct — the rate table gives ₹0 on this base')
  if (tdsPaise > base) throw new Error('TDS cannot exceed its base amount')

  const payload = voucherToPayload(v)
  const cashBank = (id: number): boolean => !!facts.get(id)?.isCashBank
  const edit = addTdsToLines(h.kind, payload.lines, payload.billRefs, { partyLedgerId: cls.partyLedgerId, tdsPaise, isCashBank: cashBank })
  if (!edit.ok) throw new Error(edit.error)
  const sid = sectionId
  return db.transaction(() => {
    db.prepare("DELETE FROM tds_exemptions WHERE voucher_id = ? AND kind = 'tds'").run(v.id)
    saveVoucher(
      db,
      {
        ...payload,
        partyLedgerId: payload.partyLedgerId ?? cls!.partyLedgerId,
        lines: edit.lines,
        billRefs: edit.billRefs,
        tds: { sectionId: sid, baseAmount: base, tdsAmount: tdsPaise, isManual: manual, autoPayable: true }
      },
      v.id
    )
    const after = getVoucher(db, v.id)!
    writeAudit(db, 'tdsEntry', after.tds?.entryId ?? v.id, 'create', null, {
      voucherId: v.id, sectionId: sid, baseAmount: base, tdsAmount: tdsPaise, isManual: manual, via: 'tds:applyToVoucher',
      reducedLedgerId: edit.targetLedgerId
    })
    return after
  })()
}

/**
 * Delete a deduction: drop the payable credit and give it back to the line it came out of (the
 * supplier's credit on a bill, the bank/cash credit on a payment), clearing the entry — through
 * saveVoucher, so the voucher still has to balance. Its challan allocation goes with the entry.
 */
export function removeTdsFromVoucher(db: DB, voucherId: number): ReturnType<typeof getVoucher> {
  const v = getVoucher(db, voucherId)
  if (!v) throw new Error('Voucher not found')
  const h = head(db, v.id)
  assertEditable(db, v.id, v.date, h)
  if (!v.tds) throw new Error('This voucher carries no TDS deduction')
  const entry = db.prepare('SELECT party_ledger_id AS p FROM tds_entries WHERE id = ?').get(v.tds.entryId) as { p: number }
  const tags = payableTagMap(db)
  const facts = ledgerTdsFacts(db)
  const saved = tdsStateFromSaved(v.tds, v.lines, entry.p, (id) => tags.get(id) ?? null)
  const sectionId = v.tds.sectionId
  const payload = voucherToPayload(v)
  const edit = removeTdsFromLines(h.kind, payload.lines, payload.billRefs, {
    partyLedgerId: entry.p,
    isPayableLine: (l) => (tags.has(l.ledgerId) ? tags.get(l.ledgerId) === sectionId : l.ledgerId === saved.payableLedgerId),
    isCashBank: (id) => !!facts.get(id)?.isCashBank
  })
  if (!edit.ok) throw new Error(edit.error)
  const before = { ...v.tds }
  return db.transaction(() => {
    saveVoucher(db, { ...payload, lines: edit.lines, billRefs: edit.billRefs, tds: null }, v.id)
    writeAudit(db, 'tdsEntry', before.entryId ?? v.id, 'delete', { voucherId: v.id, ...before }, { via: 'tds:removeFromVoucher', restoredLedgerId: edit.targetLedgerId })
    return getVoucher(db, v.id)
  })()
}

/** "Not applicable": the voucher carries no TDS (or TCS) by the user's decision (reason kept). */
export function exemptVoucher(db: DB, voucherId: number, reason: string, kind: WithholdingKind = 'tds'): void {
  const v = getVoucher(db, voucherId)
  if (!v) throw new Error('Voucher not found')
  if (v.deletedAt) throw new Error('The voucher is in the bin')
  if (kind === 'tds' && v.tds) throw new Error('This voucher carries a TDS deduction — remove it first')
  if (kind === 'tcs' && v.tcs) throw new Error('This voucher carries a TCS collection — remove it first')
  const before = db.prepare('SELECT reason FROM tds_exemptions WHERE voucher_id = ? AND kind = ?').get(voucherId, kind) as { reason: string } | undefined
  db.prepare(
    `INSERT INTO tds_exemptions (voucher_id, kind, reason) VALUES (?, ?, ?)
     ON CONFLICT(voucher_id, kind) DO UPDATE SET reason = excluded.reason`
  ).run(voucherId, kind, reason)
  writeAudit(db, kind === 'tcs' ? 'tcsExemption' : 'tdsExemption', voucherId, before ? 'update' : 'create', before ?? null, { voucherId, reason })
}

export function unexemptVoucher(db: DB, voucherId: number, kind: WithholdingKind = 'tds'): void {
  const before = db.prepare('SELECT reason FROM tds_exemptions WHERE voucher_id = ? AND kind = ?').get(voucherId, kind) as { reason: string } | undefined
  if (!before) return
  db.prepare('DELETE FROM tds_exemptions WHERE voucher_id = ? AND kind = ?').run(voucherId, kind)
  writeAudit(db, kind === 'tcs' ? 'tcsExemption' : 'tdsExemption', voucherId, 'delete', { voucherId, reason: before.reason }, null)
}

export function exemptionOf(db: DB, voucherId: number, kind: WithholdingKind = 'tds'): string | null {
  return (db.prepare('SELECT reason FROM tds_exemptions WHERE voucher_id = ? AND kind = ?').get(voucherId, kind) as { reason: string } | undefined)?.reason ?? null
}

// ---------------------------------------------------------------------------------------------
// Deducted
// ---------------------------------------------------------------------------------------------

/** Every recorded entry of `kind` in [from, to] (TCS: every collection). */
export function tdsDeducted(db: DB, from: string, to: string, kind: WithholdingKind = 'tds'): TdsDeductedRow[] {
  const rows = db
    .prepare(
      `SELECT te.id AS entryId, v.id AS voucherId, v.number AS voucherNumber, v.date, vt.kind,
              te.party_ledger_id AS partyLedgerId, l.name AS partyName, te.pan,
              te.section_id AS sectionId, ts.code AS sectionCode, te.base_amount AS basePaise, te.rate_bp_at AS rateBp,
              te.tds_amount AS tdsPaise, te.deductee_type_at AS deducteeType, te.is_manual AS isManual,
              cert.certificate_no AS certificateNo, c.id AS challanId, c.challan_no AS challanNo, c.payment_voucher_id AS paidBy
       FROM tds_entries te
       JOIN vouchers v ON v.id = te.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN tds_sections ts ON ts.id = te.section_id
       JOIN ledgers l ON l.id = te.party_ledger_id
       LEFT JOIN tds_certificates cert ON cert.id = te.certificate_id
       LEFT JOIN tds_entry_challans tec ON tec.entry_id = te.id
       LEFT JOIN tds_challans c ON c.id = tec.challan_id
       WHERE v.date BETWEEN ? AND ? AND ts.kind = ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(from, to, kind) as (Omit<TdsDeductedRow, 'isManual' | 'challanStatus'> & { isManual: number; paidBy: number | null })[]
  return rows.map(({ paidBy, ...r }) => {
    const challanStatus: ChallanStatus = r.challanId == null ? 'unallocated' : paidBy != null ? 'paid' : 'allocated'
    return { ...r, deducteeType: r.deducteeType as DeducteeType | null, isManual: !!r.isManual, challanStatus }
  })
}

// ---------------------------------------------------------------------------------------------
// TDS ledger summary (the card): tagged payable ledgers, from voucher lines at query time
// ---------------------------------------------------------------------------------------------

/** Quarter 0 = the whole financial year. */
export function tdsLedgerSummary(db: DB, fyStartYear: number, quarter: 0 | 1 | 2 | 3 | 4, kind: WithholdingKind = 'tds'): TdsLedgerSummaryRow[] {
  const { from, to } = quarter === 0 ? fyFromStartYear(fyStartYear) : tdsQuarterBounds(fyStartYear, quarter)
  const col = KIND[kind].payableCol
  const ledgers = db
    .prepare(
      `SELECT l.id, l.name, l.opening_balance AS opening, l.${col} AS sectionId, ts.code
       FROM ledgers l JOIN tds_sections ts ON ts.id = l.${col} ORDER BY ts.code, l.id`
    )
    .all() as { id: number; name: string; opening: number; sectionId: number; code: string }[]
  const move = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = 'cr' AND v.date < :from THEN vl.amount ELSE 0 END), 0) AS crBefore,
            COALESCE(SUM(CASE WHEN vl.dr_cr = 'dr' AND v.date < :from THEN vl.amount ELSE 0 END), 0) AS drBefore,
            COALESCE(SUM(CASE WHEN vl.dr_cr = 'cr' AND v.date >= :from THEN vl.amount ELSE 0 END), 0) AS crIn,
            COALESCE(SUM(CASE WHEN vl.dr_cr = 'dr' AND v.date >= :from THEN vl.amount ELSE 0 END), 0) AS drIn
     FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
     WHERE vl.ledger_id = :ledgerId AND v.date <= :to AND ${IN_BOOKS}`
  )
  const entries = db
    .prepare(
      `SELECT te.section_id AS sectionId, COALESCE(SUM(te.tds_amount), 0) AS tds, COUNT(DISTINCT te.party_ledger_id) AS deductees
       FROM tds_entries te JOIN vouchers v ON v.id = te.voucher_id JOIN tds_sections ts ON ts.id = te.section_id
       WHERE v.date BETWEEN ? AND ? AND ts.kind = ? AND ${IN_BOOKS} GROUP BY te.section_id`
    )
    .all(from, to, kind) as { sectionId: number; tds: number; deductees: number }[]
  const bySection = new Map<number, TdsLedgerSummaryRow>()
  for (const l of ledgers) {
    const m = move.get({ from, to, ledgerId: l.id }) as { crBefore: number; drBefore: number; crIn: number; drIn: number }
    const opening = -l.opening + m.crBefore - m.drBefore
    const row = bySection.get(l.sectionId) ?? {
      sectionId: l.sectionId, sectionCode: l.code, ledgerId: l.id, ledgerName: l.name, openingPaise: 0, deductedPaise: 0,
      depositedPaise: 0, outstandingPaise: 0, entriesTdsPaise: 0, deductees: 0
    }
    row.openingPaise += opening
    row.deductedPaise += m.crIn
    row.depositedPaise += m.drIn
    row.outstandingPaise += opening + m.crIn - m.drIn
    bySection.set(l.sectionId, row)
  }
  const codes = sectionCodes(db)
  for (const e of entries) {
    const row = bySection.get(e.sectionId) ?? {
      sectionId: e.sectionId, sectionCode: codes.get(e.sectionId) ?? '', ledgerId: null, ledgerName: '—', openingPaise: 0,
      deductedPaise: 0, depositedPaise: 0, outstandingPaise: 0, entriesTdsPaise: 0, deductees: 0
    }
    row.entriesTdsPaise = e.tds
    row.deductees = e.deductees
    bySection.set(e.sectionId, row)
  }
  return [...bySection.values()]
    .filter((r) => r.openingPaise !== 0 || r.deductedPaise !== 0 || r.depositedPaise !== 0 || r.entriesTdsPaise !== 0)
    .sort((a, b) => a.sectionCode.localeCompare(b.sectionCode))
}

// ---------------------------------------------------------------------------------------------
// Challans: from payment vouchers, auto-allocation, interest
// ---------------------------------------------------------------------------------------------

/** Payment vouchers that debit a tagged TDS payable ledger, from the FY start to 30 April after it
 *  (March deductions are deposited by 30 April — rule 30(2), see tdsInterest.ts). */
export function tdsPaymentCandidates(db: DB, fyStartYear: number, kind: WithholdingKind = 'tds'): TdsPaymentCandidate[] {
  const fy = fyFromStartYear(fyStartYear)
  const col = KIND[kind].payableCol
  const rows = db
    .prepare(
      `SELECT v.id AS voucherId, v.number AS voucherNumber, v.date, SUM(vl.amount) AS amountPaise,
              GROUP_CONCAT(DISTINCT l.${col}) AS sections,
              (SELECT MIN(c.id) FROM tds_challans c WHERE c.payment_voucher_id = v.id AND c.kind = '${kind}') AS challanId
       FROM vouchers v
       JOIN voucher_lines vl ON vl.voucher_id = v.id AND vl.dr_cr = 'dr'
       JOIN ledgers l ON l.id = vl.ledger_id AND l.${col} IS NOT NULL
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       GROUP BY v.id ORDER BY v.date, v.id`
    )
    .all(fy.from, `${fyStartYear + 1}-04-30`) as { voucherId: number; voucherNumber: string; date: string; amountPaise: number; sections: string; challanId: number | null }[]
  const codes = sectionCodes(db)
  return rows.map((r) => {
    const sectionIds = r.sections.split(',').map(Number)
    return { ...r, sectionIds, sectionCodes: sectionIds.map((s) => codes.get(s) ?? '').join(', ') }
  })
}

const challanSections = (db: DB, challanId: number): number[] | null => {
  const r = db.prepare('SELECT payment_voucher_id AS p, kind FROM tds_challans WHERE id = ?').get(challanId) as { p: number | null; kind: WithholdingKind } | undefined
  if (!r?.p) return null
  const col = KIND[r.kind].payableCol
  return (db
    .prepare(
      `SELECT DISTINCT l.${col} AS s FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
       WHERE vl.voucher_id = ? AND vl.dr_cr = 'dr' AND l.${col} IS NOT NULL`
    )
    .all(r.p) as { s: number }[]).map((x) => x.s)
}

/**
 * Auto-allocate: the challan's quarter's unallocated entries — of the sections its payment
 * voucher debited (all sections when it has none) — oldest first, each one that still fits
 * under the challan amount. Returns the entry ids allocated.
 */
export function autoAllocate(db: DB, challanId: number): number[] {
  const c = db.prepare('SELECT * FROM tds_challans WHERE id = ?').get(challanId) as
    | { id: number; amount_paise: number; quarter: 1 | 2 | 3 | 4; fy_start_year: number; kind: WithholdingKind }
    | undefined
  if (!c) throw new Error('Challan not found')
  const allocated = (db
    .prepare('SELECT COALESCE(SUM(te.tds_amount), 0) AS a FROM tds_entry_challans tec JOIN tds_entries te ON te.id = tec.entry_id WHERE tec.challan_id = ?')
    .get(challanId) as { a: number }).a
  let room = c.amount_paise - allocated
  const sections = challanSections(db, challanId)
  const { from, to } = tdsQuarterBounds(c.fy_start_year, c.quarter)
  const candidates = db
    .prepare(
      `SELECT te.id, te.tds_amount AS tds, te.section_id AS sectionId FROM tds_entries te
       JOIN vouchers v ON v.id = te.voucher_id JOIN tds_sections ts ON ts.id = te.section_id
       LEFT JOIN tds_entry_challans tec ON tec.entry_id = te.id
       WHERE tec.entry_id IS NULL AND v.date BETWEEN ? AND ? AND ts.kind = ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id, te.id`
    )
    .all(from, to, c.kind) as { id: number; tds: number; sectionId: number }[]
  const pick: number[] = []
  for (const e of candidates) {
    if (sections && !sections.includes(e.sectionId)) continue
    if (e.tds <= room) {
      pick.push(e.id)
      room -= e.tds
    }
  }
  if (pick.length > 0) allocateEntries(db, challanId, pick)
  return pick
}

export interface ChallanFromPaymentInput {
  paymentVoucherId: number
  bsrCode: string
  challanNo: string
  /** Default: the payment voucher's date. */
  date?: string | null
  quarter?: 1 | 2 | 3 | 4 | null
  fyStartYear?: number | null
  autoAllocate?: boolean
}

/**
 * A challan from the payment voucher that deposited the TDS: amount = what it debits to tagged
 * payable ledgers. Quarter default: the quarter of the oldest unallocated entry of those
 * sections dated on or before the payment, else the quarter of the payment.
 */
export function challanFromPayment(db: DB, input: ChallanFromPaymentInput, kind: WithholdingKind = 'tds'): TdsChallanRow {
  const col = KIND[kind].payableCol
  const v = db
    .prepare(`SELECT v.id, v.date FROM vouchers v WHERE v.id = ? AND ${NOT_DELETED}`)
    .get(input.paymentVoucherId) as { id: number; date: string } | undefined
  if (!v) throw new Error('Payment voucher not found')
  const debits = db
    .prepare(
      `SELECT l.${col} AS s, vl.amount FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
       WHERE vl.voucher_id = ? AND vl.dr_cr = 'dr' AND l.${col} IS NOT NULL`
    )
    .all(v.id) as { s: number; amount: number }[]
  const amount = debits.reduce((s, d) => s + d.amount, 0)
  if (amount <= 0) throw new Error(`That voucher doesn't debit a ${KIND[kind].name} payable ledger — it isn't a ${KIND[kind].name} deposit`)
  let quarter = input.quarter ?? null
  let fyStartYear = input.fyStartYear ?? null
  if (quarter == null || fyStartYear == null) {
    const sections = [...new Set(debits.map((d) => d.s))]
    const oldest = db
      .prepare(
        `SELECT MIN(v.date) AS d FROM tds_entries te JOIN vouchers v ON v.id = te.voucher_id
         LEFT JOIN tds_entry_challans tec ON tec.entry_id = te.id
         WHERE tec.entry_id IS NULL AND v.date <= ? AND te.section_id IN (${sections.map(() => '?').join(',')}) AND ${IN_BOOKS}`
      )
      .get(v.date, ...sections) as { d: string | null }
    const q = tdsQuarterOf(oldest.d ?? v.date)
    quarter = quarter ?? q.q
    fyStartYear = fyStartYear ?? q.fyStartYear
  }
  return db.transaction(() => {
    const c = saveChallan(db, {
      date: input.date ?? v.date, bsrCode: input.bsrCode, challanNo: input.challanNo, amountPaise: amount,
      paymentVoucherId: v.id, quarter, fyStartYear
    }, kind)
    if (input.autoAllocate) autoAllocate(db, c.id)
    return challanRows(db, fyStartYear!, undefined, undefined, kind).find((r) => r.id === c.id)!
  })()
}

/** Indicative interest on late deposit for each entry allocated to the challan (s.201(1A)(ii) /
 *  2025 s.398(3)(a)); `rateBp` is the user-editable rate (default 1.5% a month). */
export function challanInterest(db: DB, challanId: number, rateBp?: number): TdsChallanEntryInterest[] {
  // TCS: s.206C(7) / 2025 s.398(3)(a) second tier, measured against rule 37CA / rule 218(2).
  const kind = challanKind(db, challanId) ?? 'tds'
  const bp = rateBp ?? (kind === 'tcs' ? TCS_LATE_PAYMENT_RATE_BP : LATE_DEPOSIT_RATE_BP)
  const dueOf = kind === 'tcs' ? tcsDepositDueDate : undefined
  const c = db.prepare('SELECT date FROM tds_challans WHERE id = ?').get(challanId) as { date: string } | undefined
  if (!c) throw new Error('Challan not found')
  const rows = db
    .prepare(
      `SELECT te.id AS entryId, v.id AS voucherId, v.number AS voucherNumber, v.date, l.name AS partyName, ts.code AS sectionCode,
              te.tds_amount AS tdsPaise
       FROM tds_entry_challans tec JOIN tds_entries te ON te.id = tec.entry_id
       JOIN vouchers v ON v.id = te.voucher_id JOIN ledgers l ON l.id = te.party_ledger_id JOIN tds_sections ts ON ts.id = te.section_id
       WHERE tec.challan_id = ? AND ${NOT_DELETED} ORDER BY v.date, v.id`
    )
    .all(challanId) as Omit<TdsChallanEntryInterest, 'dueDate' | 'months' | 'interestPaise'>[]
  return rows.map((r) => {
    const i = lateDepositInterest(r.tdsPaise, r.date, c.date, bp, dueOf)
    return { ...r, dueDate: i.dueDate!, months: i.months, interestPaise: i.interestPaise }
  })
}

export function challanRows(db: DB, fyStartYear: number, quarter?: number, rateBp?: number, kind: WithholdingKind = 'tds'): TdsChallanRow[] {
  const numberOf = db.prepare('SELECT number FROM vouchers WHERE id = ?')
  return listChallans(db, fyStartYear, quarter, kind).map((c) => ({
    ...c,
    paymentVoucherNumber: c.paymentVoucherId != null ? ((numberOf.get(c.paymentVoucherId) as { number: string } | undefined)?.number ?? null) : null,
    interestPaise: challanInterest(db, c.id, rateBp).reduce((s, e) => s + e.interestPaise, 0)
  }))
}

// ---------------------------------------------------------------------------------------------
// Returns: Form 26Q / Form 140 data, Form 16A data
// ---------------------------------------------------------------------------------------------

/** 26Q deductee code (Protean file format, cited in migration 020): '01' company, '02' other. */
export function deducteeCode26q(type: string | null): string {
  if (type === 'company') return '01'
  if (type === 'individual_huf' || type === 'firm' || type === 'other') return '02'
  return ''
}

/**
 * Form 26Q deductee-annexure + challan data for a quarter. Layout per the Protean 26Q file
 * format v7.8 (old-Act section codes) and Form No. 140 v1.1 (payment codes under the 2025 Act)
 * — [F26Q]/[F140] in migration 020. Reason codes from the 26Q annexure: "A" lower/no deduction
 * on a certificate u/s 197, "C" higher rate for want of PAN (Form 26Q annexure notes, Income-tax
 * Rules 1962 Form 26Q; https://tinpan.proteantech.in/downloads/e-tds/download/26Q_04012018.pdf,
 * accessed 2026-10-07 via search summary — UNVERIFIED against the current utility).
 */
export function form26qData(db: DB, fyStartYear: number, quarter: 1 | 2 | 3 | 4, kind: WithholdingKind = 'tds'): Form26qData {
  const { from, to } = tdsQuarterBounds(fyStartYear, quarter)
  const newAct = from >= IT_ACT_2025_FROM
  // TDS: 26Q / Form 140 (migration 020); TCS: 27EQ / Form 143 (Income-tax Rules 2026 rule 219, migration 027).
  const layout: Form26qData['layout'] = kind === 'tcs' ? (newAct ? 'form143' : 'form27eq') : newAct ? 'form140' : 'form26q'
  const rates = ratesBySection(db)
  const entries = db
    .prepare(
      `SELECT te.id AS entryId, v.id AS voucherId, v.date, te.party_ledger_id AS partyLedgerId, l.name AS partyName, te.pan,
              te.section_id AS sectionId, ts.code AS sectionCode, te.base_amount AS amountPaise, te.tds_amount AS tdsPaise,
              te.rate_bp_at AS rateBp, te.deductee_type_at AS deducteeType, te.certificate_id AS certificateId,
              tec.challan_id AS challanId
       FROM tds_entries te JOIN vouchers v ON v.id = te.voucher_id JOIN ledgers l ON l.id = te.party_ledger_id
       JOIN tds_sections ts ON ts.id = te.section_id LEFT JOIN tds_entry_challans tec ON tec.entry_id = te.id
       WHERE v.date BETWEEN ? AND ? AND ts.kind = ? AND ${IN_BOOKS} ORDER BY v.date, v.id`
    )
    .all(from, to, kind) as {
      entryId: number; voucherId: number; date: string; partyLedgerId: number; partyName: string; pan: string | null; sectionId: number
      sectionCode: string; amountPaise: number; tdsPaise: number; rateBp: number | null; deducteeType: DeducteeType | null
      certificateId: number | null; challanId: number | null
    }[]
  const challans = listChallans(db, fyStartYear, quarter, kind)
  // Challans of other quarters an entry of this quarter was allocated to (late deposits) list too.
  const extraIds = [...new Set(entries.map((e) => e.challanId).filter((id): id is number => id != null && !challans.some((c) => c.id === id)))]
  for (const id of extraIds) {
    const c = db.prepare('SELECT fy_start_year AS fy, quarter AS q FROM tds_challans WHERE id = ?').get(id) as { fy: number; q: number }
    const hit = listChallans(db, c.fy, c.q, kind).find((x) => x.id === id)
    if (hit) challans.push(hit)
  }
  const serialOf = new Map(challans.map((c, i) => [c.id, i + 1]))
  const deductees = entries.map((e, i) => {
    const row = rateRowOn(rates.get(e.sectionId) ?? [], e.date, e.deducteeType)
    const c = e.challanId != null ? challans.find((x) => x.id === e.challanId) : undefined
    return {
      serial: i + 1, entryId: e.entryId, voucherId: e.voucherId, partyLedgerId: e.partyLedgerId, partyName: e.partyName, pan: e.pan,
      deducteeCode: kind === 'tcs' ? collecteeCodeForReturn(e.pan, e.deducteeType, layout === 'form143' ? 'form143' : 'form27eq') : deducteeCode26q(e.deducteeType),
      sectionCode: e.sectionCode, returnCode: row?.returnCode ?? null,
      paymentDate: e.date, amountPaise: e.amountPaise, tdsPaise: e.tdsPaise, deductionDate: e.date, rateBp: e.rateBp,
      reasonCode: e.certificateId != null ? 'A' : !e.pan ? 'C' : '',
      challanSerial: e.challanId != null ? (serialOf.get(e.challanId) ?? null) : null,
      bsrCode: c?.bsrCode ?? null, challanDate: c?.date ?? null, challanNo: c?.challanNo ?? null
    }
  })
  const challanRowsOut = challans.map((c, i) => ({
    serial: i + 1, challanId: c.id, bsrCode: c.bsrCode, date: c.date, challanNo: c.challanNo, amountPaise: c.amountPaise,
    allocatedPaise: c.allocatedPaise, entries: c.entryCount
  }))
  return {
    fyStartYear, quarter,
    layout,
    deductees,
    challans: challanRowsOut,
    totals: {
      amountPaise: deductees.reduce((s, d) => s + d.amountPaise, 0),
      tdsPaise: deductees.reduce((s, d) => s + d.tdsPaise, 0),
      depositedPaise: challanRowsOut.reduce((s, c) => s + c.amountPaise, 0)
    }
  }
}

/**
 * Data for Form 16A (TDS certificate for other than salary), per deductee for the quarter:
 * the fields Form No. 16A carries under rule 31(1)(b) of the Income-tax Rules 1962 — deductor
 * name/address/PAN/TAN, deductee name/address/PAN, assessment year, period, a summary of
 * amounts paid/credited by section with dates, tax deducted, and the challans it was deposited
 * through (BSR code, date, serial). The actual certificate is issued by TRACES; this is "data
 * for Form 16A" (form layout UNVERIFIED against the current CBDT notification / its 2025-Act
 * equivalent).
 */
export function form16aData(
  db: DB, company: CompanyInfo, fyStartYear: number, quarter: 1 | 2 | 3 | 4, partyLedgerId?: number, kind: WithholdingKind = 'tds'
): Form16aData {
  const data = form26qData(db, fyStartYear, quarter, kind)
  const nature = new Map((db.prepare('SELECT id, code, COALESCE(nature, description) AS n FROM tds_sections').all() as { id: number; code: string; n: string }[]).map((s) => [s.code, s.n]))
  const numbers = db.prepare('SELECT number FROM vouchers WHERE id = ?')
  const address = db.prepare('SELECT address FROM ledgers WHERE id = ?')
  const parties = new Map<number, Form16aData['parties'][number]>()
  for (const d of data.deductees) {
    if (partyLedgerId != null && d.partyLedgerId !== partyLedgerId) continue
    const p = parties.get(d.partyLedgerId) ?? {
      partyLedgerId: d.partyLedgerId, partyName: d.partyName, pan: d.pan,
      address: (address.get(d.partyLedgerId) as { address: string | null } | undefined)?.address ?? null,
      payments: [], challans: [], totals: { amountPaise: 0, tdsPaise: 0, depositedPaise: 0 }
    }
    p.payments.push({
      date: d.paymentDate, sectionCode: d.sectionCode, nature: nature.get(d.sectionCode) ?? '', amountPaise: d.amountPaise, tdsPaise: d.tdsPaise,
      voucherNumber: (numbers.get(d.voucherId) as { number: string } | undefined)?.number ?? ''
    })
    p.totals.amountPaise += d.amountPaise
    p.totals.tdsPaise += d.tdsPaise
    if (d.bsrCode && d.challanDate && d.challanNo) {
      const existing = p.challans.find((c) => c.challanNo === d.challanNo && c.bsrCode === d.bsrCode && c.date === d.challanDate)
      if (existing) existing.tdsPaise += d.tdsPaise
      else p.challans.push({ bsrCode: d.bsrCode, date: d.challanDate, challanNo: d.challanNo, tdsPaise: d.tdsPaise })
      p.totals.depositedPaise += d.tdsPaise
    }
    parties.set(d.partyLedgerId, p)
  }
  return {
    deductor: { name: company.name, address: company.address, pan: company.pan, tan: company.tan },
    fyStartYear, quarter, period: tdsQuarterBounds(fyStartYear, quarter),
    assessmentYear: `${fyStartYear + 1}-${String((fyStartYear + 2) % 100).padStart(2, '0')}`,
    parties: [...parties.values()].sort((a, b) => a.partyName.localeCompare(b.partyName))
  }
}
