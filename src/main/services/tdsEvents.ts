/**
 * Loads vouchers + ledger facts for the TDS event walk (src/shared/tdsEligibility.ts) — the one
 * place SQL meets the engine's classification. Used by the threshold base (tds.resolveTds), the
 * Eligible tab, the payment-time suggestion and tds:applyToVoucher.
 */
import type { DB } from '../db/connection'
import type { VoucherKind } from '@shared/domain'
import {
  classifyTdsVoucher, TDS_KINDS, walkTdsEvents,
  type TdsLedgerFacts, type TdsVoucherClass, type WalkEvent, type WalkResult
} from '@shared/tdsEligibility'
import { rateRowOn, resolveDeducteeType, type DeducteeType, type TdsRateRow } from '@shared/tds'
import { cashBankGroupIds, descendantIdsByName } from './masters'
import { IN_BOOKS, NOT_YEAR_END_CLOSE } from './vouchers'

export interface LedgerTdsFacts extends TdsLedgerFacts {
  id: number
  name: string
  pan: string | null
  deducteeType: DeducteeType | null
}

/** Every ledger's TDS-relevant facts, by id. */
export function ledgerTdsFacts(db: DB): Map<number, LedgerTdsFacts> {
  const creditors = descendantIdsByName(db, ['Sundry Creditors'])
  const cashBank = cashBankGroupIds(db)
  const rows = db
    .prepare(
      `SELECT id, name, group_id, pan, deductee_type, tds_section_id, tds_default_section_id, tds_payable_section_id, tax_type
       FROM ledgers`
    )
    .all() as {
      id: number; name: string; group_id: number; pan: string | null; deductee_type: DeducteeType | null
      tds_section_id: number | null; tds_default_section_id: number | null; tds_payable_section_id: number | null; tax_type: string | null
    }[]
  const out = new Map<number, LedgerTdsFacts>()
  for (const r of rows) {
    const deducteeType = resolveDeducteeType(r.deductee_type, r.pan)
    out.set(r.id, {
      id: r.id, name: r.name, pan: r.pan, deducteeType,
      isDeducteeCandidate: creditors.has(r.group_id) || r.tds_section_id != null,
      tdsSectionId: r.tds_section_id,
      deducteeKnown: deducteeType != null,
      defaultSectionId: r.tds_default_section_id,
      isTax: r.tax_type != null,
      isTdsPayable: r.tds_payable_section_id != null,
      isCashBank: cashBank.has(r.group_id)
    })
  }
  return out
}

export interface LoadedVoucher {
  id: number
  date: string
  number: string
  kind: VoucherKind
  partyLedgerId: number | null
  lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[]
  entry: { id: number; sectionId: number; partyLedgerId: number; baseAmount: number; tdsAmount: number } | null
  exemptReason: string | null
}

/**
 * TDS-kind vouchers in the books (not binned, optional or unmatured post-dated; never a year-end
 * closing journal) dated in [from, to] — optionally only those touching `partyLedgerId`.
 */
export function loadTdsVouchers(db: DB, from: string, to: string, opts: { partyLedgerId?: number; excludeVoucherId?: number } = {}): LoadedVoucher[] {
  const kinds = TDS_KINDS.map(() => '?').join(',')
  const partyClause = opts.partyLedgerId != null ? 'AND v.id IN (SELECT voucher_id FROM voucher_lines WHERE ledger_id = ?)' : ''
  const params: unknown[] = [from, to, ...TDS_KINDS, opts.excludeVoucherId ?? -1]
  if (opts.partyLedgerId != null) params.push(opts.partyLedgerId)
  const heads = db
    .prepare(
      `SELECT v.id, v.date, v.number, vt.kind, v.party_ledger_id AS partyLedgerId, x.reason AS exemptReason
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN tds_exemptions x ON x.voucher_id = v.id
       WHERE v.date BETWEEN ? AND ? AND vt.kind IN (${kinds}) AND v.id <> ? AND ${IN_BOOKS} AND ${NOT_YEAR_END_CLOSE}
       ${partyClause}
       ORDER BY v.date, v.id`
    )
    .all(...params) as { id: number; date: string; number: string; kind: VoucherKind; partyLedgerId: number | null; exemptReason: string | null }[]
  if (heads.length === 0) return []
  const byId = new Map<number, LoadedVoucher>(heads.map((h) => [h.id, { ...h, lines: [], entry: null }]))
  // Chunked IN lists keep the statement under SQLite's variable limit.
  const ids = [...byId.keys()]
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const ph = chunk.map(() => '?').join(',')
    const lines = db
      .prepare(`SELECT voucher_id AS vid, ledger_id AS ledgerId, dr_cr AS drCr, amount FROM voucher_lines WHERE voucher_id IN (${ph}) ORDER BY line_order, id`)
      .all(...chunk) as { vid: number; ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[]
    for (const l of lines) byId.get(l.vid)!.lines.push({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount })
    const entries = db
      .prepare(
        `SELECT id, voucher_id AS vid, section_id AS sectionId, party_ledger_id AS partyLedgerId, base_amount AS baseAmount, tds_amount AS tdsAmount
         FROM tds_entries WHERE voucher_id IN (${ph}) ORDER BY id`
      )
      .all(...chunk) as { id: number; vid: number; sectionId: number; partyLedgerId: number; baseAmount: number; tdsAmount: number }[]
    for (const e of entries) {
      const v = byId.get(e.vid)!
      if (!v.entry) v.entry = { id: e.id, sectionId: e.sectionId, partyLedgerId: e.partyLedgerId, baseAmount: e.baseAmount, tdsAmount: e.tdsAmount }
    }
  }
  return [...byId.values()]
}

export interface EventGroup {
  partyLedgerId: number
  sectionId: number
  events: WalkEvent[]
  /** Classification of each voucher in the group. */
  classes: Map<number, TdsVoucherClass>
}

const groupKey = (party: number, section: number): string => `${party}|${section}`

/**
 * Classify every voucher and group the events per party × section. A voucher with a recorded
 * entry joins the entry's group (whatever the classification says); a payment to a party with
 * no section of its own joins the section that party's credits use.
 */
export function buildEventGroups(vouchers: readonly LoadedVoucher[], facts: ReadonlyMap<number, LedgerTdsFacts>): Map<string, EventGroup> {
  const groups = new Map<string, EventGroup>()
  const factOf = (id: number): TdsLedgerFacts | null => facts.get(id) ?? null
  const add = (party: number, section: number, v: LoadedVoucher, cls: TdsVoucherClass): void => {
    const key = groupKey(party, section)
    let g = groups.get(key)
    if (!g) {
      g = { partyLedgerId: party, sectionId: section, events: [], classes: new Map() }
      groups.set(key, g)
    }
    g.classes.set(v.id, cls)
    g.events.push({
      voucherId: v.id, date: v.date, kind: cls.eventKind, basePaise: cls.basePaise, grossPaise: cls.grossPaise,
      entryBasePaise: v.entry && v.entry.sectionId === section && v.entry.partyLedgerId === party ? v.entry.baseAmount : null,
      exempt: v.exemptReason != null
    })
  }
  const unsectioned: { v: LoadedVoucher; cls: TdsVoucherClass }[] = []
  for (const v of vouchers) {
    let cls = classifyTdsVoucher(v, factOf, v.entry?.sectionId ?? null)
    if (v.entry) {
      if (!cls || cls.partyLedgerId !== v.entry.partyLedgerId) {
        const isPayment = v.kind === 'payment'
        cls = {
          eventKind: isPayment ? 'payment' : 'credit', partyLedgerId: v.entry.partyLedgerId, sectionId: v.entry.sectionId,
          sectionFrom: 'party', basePaise: v.entry.baseAmount, grossPaise: v.entry.baseAmount, expenseLedgerId: null
        }
      }
      add(v.entry.partyLedgerId, v.entry.sectionId, v, cls)
      continue
    }
    if (!cls) continue
    if (cls.sectionId == null) unsectioned.push({ v, cls })
    else add(cls.partyLedgerId, cls.sectionId, v, cls)
  }
  for (const { v, cls } of unsectioned) {
    const target = [...groups.values()].filter((g) => g.partyLedgerId === cls.partyLedgerId).sort((a, b) => b.events.length - a.events.length)[0]
    if (target) add(cls.partyLedgerId, target.sectionId, v, { ...cls, sectionId: target.sectionId, sectionFrom: 'credits' })
  }
  return groups
}

/** Rate rows by section (one query). */
export function ratesBySection(db: DB): Map<number, TdsRateRow[]> {
  const rows = db.prepare('SELECT * FROM tds_section_rates ORDER BY section_id, effective_from').all() as {
    id: number; section_id: number; effective_from: string; effective_to: string | null; deductee_type: TdsRateRow['deducteeType']
    rate_bp: number; threshold_single_paise: number; threshold_annual_paise: number; threshold_basis: 'fy' | 'month'
    threshold_excess_only: number; return_code: string | null; no_pan_rate_bp: number; source: string | null
  }[]
  const out = new Map<number, TdsRateRow[]>()
  for (const r of rows) {
    const list = out.get(r.section_id) ?? []
    list.push({
      id: r.id, sectionId: r.section_id, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, deducteeType: r.deductee_type,
      rateBp: r.rate_bp, thresholdSinglePaise: r.threshold_single_paise, thresholdAnnualPaise: r.threshold_annual_paise,
      thresholdBasis: r.threshold_basis, thresholdExcessOnly: !!r.threshold_excess_only, returnCode: r.return_code,
      noPanRateBp: r.no_pan_rate_bp, source: r.source
    })
    out.set(r.section_id, list)
  }
  return out
}

/** Walk one group with the deductee's rate rows. */
export function walkGroup(group: EventGroup, rates: ReadonlyMap<number, TdsRateRow[]>, deducteeType: DeducteeType | null): WalkResult[] {
  const rows = rates.get(group.sectionId) ?? []
  return walkTdsEvents(group.events, (d) => rateRowOn(rows, d, deducteeType))
}

/** The walk for one party × section over [from, to] (vouchers touching the party only). */
export function partySectionWalk(
  db: DB, partyLedgerId: number, sectionId: number, from: string, to: string, excludeVoucherId?: number
): { results: WalkResult[]; group: EventGroup | null; facts: Map<number, LedgerTdsFacts> } {
  const facts = ledgerTdsFacts(db)
  const vouchers = loadTdsVouchers(db, from, to, { partyLedgerId, excludeVoucherId })
  const group = buildEventGroups(vouchers, facts).get(groupKey(partyLedgerId, sectionId)) ?? null
  if (!group) return { results: [], group: null, facts }
  return { results: walkGroup(group, ratesBySection(db), facts.get(partyLedgerId)?.deducteeType ?? null), group, facts }
}
