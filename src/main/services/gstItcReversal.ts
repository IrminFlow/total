import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { fyOf, gstPeriodOf } from '@shared/dates'
import {
  addHeads, effectiveTurnover, proposalLines, rule37Events, rule42, rule42TrueUp, rule43, summarise, ZERO_HEADS,
  type CapitalGood, type Heads, type Rule37Bill, type Rule42Result
} from '@shared/gst/itcReversal'
import { itcReversalInputsSchema, type ItcReversalInputs } from '@shared/gst/expansionSchemas'
import type { Gstr9ItcDoc } from '@shared/gst/gstr9'
import { RULE37_RULES } from '@shared/gst/sources'
import { gstr3b } from './gst'
import { fyMonths, itcDocsFor, writeReversalSplit } from './gstAnnual'
import { openBills } from './analysis'
import { getGst3bManual, setGst3bManual } from './config'
import { createLedger, descendantIdsByName } from './masters'
import { IN_BOOKS, saveVoucher } from './vouchers'
import { writeAudit } from './audit'
import type { ItcReversalView, ProposalLedger, ProposalView } from '@shared/gst/views'

/**
 * ITC reversal workings (WP 3.4) for one GSTR-3B tax period: rule 42 / 43 apportionment of
 * common credit, rule 37 (bills unpaid 180 days: reversal with interest, re-availment on
 * payment), s.17(5) blocked credit — producing the Table 4(B) figures, an "apply to GSTR-3B"
 * and a journal the user posts with one click (through saveVoucher, so lock date, audit and
 * validation all apply). The maths is pure: shared/gst/itcReversal.ts.
 */

const INPUTS_KEY = (period: string): string => `gst.itcRev.inputs.${period}`
const POSTED_KEY = (period: string): string => `gst.itcRev.posted.${period}`

const readMeta = (db: DB, key: string): unknown => {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.value)
  } catch {
    return null
  }
}
const writeMeta = (db: DB, key: string, value: unknown): void => {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
}

export function getItcReversalInputs(db: DB, period: string): ItcReversalInputs {
  const parsed = itcReversalInputsSchema.safeParse(readMeta(db, INPUTS_KEY(period)) ?? {})
  return parsed.success ? parsed.data : itcReversalInputsSchema.parse({})
}

export function setItcReversalInputs(db: DB, period: string, input: unknown): ItcReversalInputs {
  const before = getItcReversalInputs(db, period)
  const parsed = itcReversalInputsSchema.parse(input)
  writeMeta(db, INPUTS_KEY(period), parsed)
  writeAudit(db, 'company', 0, 'update', { itcReversalInputs: { period, ...before } }, { itcReversalInputs: { period, ...parsed } })
  return parsed
}

const headsOf = (d: { igst: number; cgst: number; sgst: number; cess: number }): Heads => ({ igst: d.igst, cgst: d.cgst, sgst: d.sgst, cess: d.cess })

/** E (exempt + nil-rated outward) and F (total turnover) of a month, from its GSTR-3B. */
function turnoverOf(db: DB, company: CompanyInfo, from: string, to: string): { E: number; F: number } {
  const r = gstr3b(db, company, from, to, gstPeriodOf(from))
  const E = r.nilExempt.taxable
  return { E, F: r.outward.taxable + r.zeroRated.taxable + E }
}

const monthEnd = (key: string): string => {
  const [y, m] = key.split('-').map(Number) as [number, number]
  return `${key}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}
const addMonthsKey = (key: string, n: number): string => {
  const [y, m] = key.split('-').map(Number) as [number, number]
  const idx = y * 12 + (m - 1) + n
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
}

interface Rule42Month {
  rule42: Rule42Result & { T: Heads; T3: Heads }
  E: number
  F: number
  borrowed: boolean
}

function rule42For(db: DB, company: CompanyInfo, docs: Gstr9ItcDoc[], key: string, inputs: ItcReversalInputs): Rule42Month {
  const nonCg = docs.filter((d) => d.bucket !== 'capital_goods')
  const T = addHeads(...nonCg.map(headsOf))
  const T3 = addHeads(...nonCg.filter((d) => d.source === 'blocked').map(headsOf))
  const own = turnoverOf(db, company, `${key}-01`, monthEnd(key))
  // Rule 42 explanation: no turnover this period → E/F of the last period that had some.
  let history: { E: number; F: number }[] = []
  if (own.F === 0) {
    for (let k = 1; k <= 12 && history.every((h) => h.F === 0); k++) {
      const pk = addMonthsKey(key, -k)
      history = [turnoverOf(db, company, `${pk}-01`, monthEnd(pk)), ...history]
    }
  }
  const eff = effectiveTurnover(own, history)
  const r = rule42({ T, T1: inputs.T1, T2: inputs.T2, T3, T4: inputs.T4, E: eff.E, F: eff.F, nonBusiness: inputs.nonBusiness })
  return { rule42: { ...r, T, T3 }, E: eff.E, F: eff.F, borrowed: eff.borrowed }
}

/** Purchase bills whose rule 37 timeline can touch `key`: non-RCM purchases carrying ITC. */
function rule37Bills(db: DB, key: string): Rule37Bill[] {
  const end = monthEnd(key)
  const prevEnd = monthEnd(addMonthsKey(key, -1))
  // Day 180 must fall on or before the end of the previous month for anything to be due now.
  const latest = new Date(`${prevEnd}T00:00:00Z`)
  latest.setUTCDate(latest.getUTCDate() - RULE37_RULES.days)
  const lastInvoice = latest.toISOString().slice(0, 10)
  const earliest = `${Number(key.slice(0, 4)) - 3}${key.slice(4)}-01`
  const rows = db
    .prepare(
      `SELECT v.id, v.number, v.reference, v.date, v.party_ledger_id AS partyLedgerId, p.name AS partyName,
              (SELECT COALESCE(SUM(vl.amount), 0) FROM voucher_lines vl WHERE vl.voucher_id = v.id AND vl.ledger_id = v.party_ledger_id AND vl.dr_cr = 'cr') AS billAmount,
              (SELECT COALESCE(SUM(CASE WHEN l.tax_type = 'igst' THEN vl.amount ELSE 0 END), 0) FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id WHERE vl.voucher_id = v.id AND vl.dr_cr = 'dr') AS igst,
              (SELECT COALESCE(SUM(CASE WHEN l.tax_type = 'cgst' THEN vl.amount ELSE 0 END), 0) FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id WHERE vl.voucher_id = v.id AND vl.dr_cr = 'dr') AS cgst,
              (SELECT COALESCE(SUM(CASE WHEN l.tax_type = 'sgst' THEN vl.amount ELSE 0 END), 0) FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id WHERE vl.voucher_id = v.id AND vl.dr_cr = 'dr') AS sgst,
              (SELECT COALESCE(SUM(CASE WHEN l.tax_type = 'cess' THEN vl.amount ELSE 0 END), 0) FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id WHERE vl.voucher_id = v.id AND vl.dr_cr = 'dr') AS cess
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE vt.kind = 'purchase' AND COALESCE(p.rcm, 0) = 0 AND COALESCE(p.itc_eligibility, 'eligible') <> 'blocked'
         AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(earliest, lastInvoice) as {
      id: number; number: string; reference: string | null; date: string; partyLedgerId: number; partyName: string
      billAmount: number; igst: number; cgst: number; sgst: number; cess: number
    }[]
  const cache = new Map<string, Map<number, number>>()
  const pendingOn = (party: number, voucherId: number, date: string): number => {
    const k = `${party}|${date}`
    let m = cache.get(k)
    if (!m) {
      m = new Map()
      for (const b of openBills(db, party, date)) if (b.voucherId != null) m.set(b.voucherId, (m.get(b.voucherId) ?? 0) + b.pending)
      cache.set(k, m)
    }
    return m.get(voucherId) ?? 0
  }
  const out: Rule37Bill[] = []
  for (const r of rows) {
    const itc = { igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cess }
    if (r.billAmount <= 0 || r.igst + r.cgst + r.sgst + r.cess <= 0) continue
    const d = new Date(`${r.date}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + RULE37_RULES.days)
    const day180 = d.toISOString().slice(0, 10)
    const unpaidAt180 = pendingOn(r.partyLedgerId, r.id, day180)
    if (unpaidAt180 <= 0) continue
    out.push({
      voucherId: r.id, number: r.number, supplierRef: r.reference, date: r.date, partyLedgerId: r.partyLedgerId, partyName: r.partyName,
      billAmount: r.billAmount, itc, unpaidAt180,
      unpaidAtPrevEnd: pendingOn(r.partyLedgerId, r.id, prevEnd), unpaidAtEnd: pendingOn(r.partyLedgerId, r.id, end)
    })
  }
  return out
}

const REVERSAL_LEDGER: ProposalLedger = { ledgerId: null, name: 'ITC Reversal', group: 'Indirect Expenses' }
const INTEREST_LEDGER: ProposalLedger = { ledgerId: null, name: 'Interest on GST', group: 'Indirect Expenses' }
const INTEREST_PAYABLE_LEDGER: ProposalLedger = { ledgerId: null, name: 'GST Interest Payable', group: 'Duties & Taxes' }

/** The input-tax ledger of a head: the tax ledger carrying the most purchase-side debits, else
 *  one whose name says "input", else any ledger of that tax type. */
function inputTaxLedger(db: DB, head: string): ProposalLedger | null {
  const used = db
    .prepare(
      `SELECT l.id, l.name, SUM(vl.amount) AS t FROM voucher_lines vl
       JOIN ledgers l ON l.id = vl.ledger_id JOIN vouchers v ON v.id = vl.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE l.tax_type = ? AND vt.kind = 'purchase' AND vl.dr_cr = 'dr' AND ${IN_BOOKS}
       GROUP BY l.id ORDER BY t DESC LIMIT 1`
    )
    .get(head) as { id: number; name: string } | undefined
  const r = used ??
    (db.prepare("SELECT id, name FROM ledgers WHERE tax_type = ? ORDER BY (name LIKE '%input%') DESC, id LIMIT 1").get(head) as { id: number; name: string } | undefined)
  return r ? { ledgerId: r.id, name: r.name, group: 'Duties & Taxes' } : null
}

function resolve(db: DB, l: ProposalLedger): ProposalLedger {
  const r = db.prepare('SELECT id FROM ledgers WHERE name = ?').get(l.name) as { id: number } | undefined
  return r ? { ...l, ledgerId: r.id } : l
}

export function itcReversal(db: DB, company: CompanyInfo, from: string, to: string, period: string, override?: ItcReversalInputs): ItcReversalView {
  const inputs = override ?? getItcReversalInputs(db, period)
  const key = from.slice(0, 7)
  const docs = itcDocsFor(db, company, from, to)
  const r42 = rule42For(db, company, docs, key, inputs)

  // Rule 43: common capital goods within 60 months, from the books' capital-goods purchases.
  const cgFrom = `${addMonthsKey(key, -59)}-01`
  const exclusive = new Set(inputs.exclusiveCapitalGoods)
  const goods: CapitalGood[] = itcDocsFor(db, company, cgFrom, to)
    .filter((d) => d.bucket === 'capital_goods' && d.source !== 'blocked')
    .map((d) => ({ voucherId: d.voucherId, number: d.number, date: d.date, partyName: d.partyName, itc: headsOf(d), common: !exclusive.has(d.voucherId) }))
  const r43 = rule43(goods, key, r42.E, r42.F)

  const r37 = rule37Events(rule37Bills(db, key), key)
  const blockedDocs = docs.filter((d) => d.source === 'blocked')
  const blocked175 = addHeads(...blockedDocs.map(headsOf))

  // Rule 42(2) annual true-up over the period's financial year.
  const fy = fyOf(from)
  const yearMonths = fyMonths(fy.startYear)
  const monthResults = yearMonths.map((m) => {
    const mDocs = m.key === key ? docs : itcDocsFor(db, company, m.from, m.to)
    const mInputs = m.key === key ? inputs : getItcReversalInputs(db, m.period)
    return m.key === key ? r42 : rule42For(db, company, mDocs, m.key, mInputs)
  })
  const yearE = monthResults.reduce((t, m) => t + m.rule42.E, 0)
  const yearF = monthResults.reduce((t, m) => t + m.rule42.F, 0)
  const trueUp = rule42TrueUp(monthResults.map((m) => ({ C2: m.rule42.C2, reversal: m.rule42.reversal })), yearE, yearF, inputs.nonBusiness)

  const summary = summarise({
    rule42: r42.rule42.reversal,
    rule43: r43.Te,
    blocked175,
    rule37: addHeads(...r37.map((e) => e.reversed)),
    reclaimed: addHeads(...r37.map((e) => e.reclaimed)),
    interest: addHeads(...r37.map((e) => e.interest)),
    trueUp: inputs.includeTrueUp ? trueUp.difference : { ...ZERO_HEADS }
  })

  const missingTaxLedgers: string[] = []
  const proposal: ProposalView[] = proposalLines(summary, inputs.expenseBlocked).map((l) => {
    let ledger: ProposalLedger
    if (l.role === 'input_tax') {
      const found = inputTaxLedger(db, l.head!)
      if (!found) missingTaxLedgers.push(`${l.head!.toUpperCase()} input`)
      ledger = found ?? { ledgerId: null, name: `${l.head!.toUpperCase()} Input`, group: 'Duties & Taxes' }
    } else {
      ledger = resolve(db, l.role === 'reversal_expense' ? REVERSAL_LEDGER : l.role === 'interest_expense' ? INTEREST_LEDGER : INTEREST_PAYABLE_LEDGER)
    }
    return { ...l, ledger }
  })

  const postedMeta = readMeta(db, POSTED_KEY(period)) as { voucherId: number } | null
  const posted = postedMeta
    ? ((db.prepare('SELECT v.id AS voucherId, v.number FROM vouchers v WHERE v.id = ? AND v.deleted_at IS NULL').get(postedMeta.voucherId) as { voucherId: number; number: string } | undefined) ?? null)
    : null

  const manual = getGst3bManual(db, period)
  const same = (a: Heads, b: Heads): boolean => a.igst === b.igst && a.cgst === b.cgst && a.sgst === b.sgst && a.cess === b.cess
  const applied = same(manual.itcRevRul, summary.table4B1) && same(manual.itcRevOth, summary.table4B2) && same(manual.itcReclaimed, summary.reclaimed) && same(manual.interest, summary.interest)

  return {
    period, from, to, inputs, rule42: r42.rule42, turnover: { E: r42.E, F: r42.F, borrowed: r42.borrowed }, rule43: r43, rule37: r37,
    blocked: blockedDocs.map((d) => ({ voucherId: d.voucherId, number: d.number, date: d.date, partyName: d.partyName, partyLedgerId: d.partyLedgerId, tax: headsOf(d) })),
    trueUp, summary, proposal, posted, applied, missingTaxLedgers
  }
}

/** Write the workings into the period's GSTR-3B manual adjustments: 4(B)(1) rules 42/43 (+true-up),
 *  4(B)(2) rule 37, 4(D)(1) reclaimed, 5.1 interest. The late fee is kept. */
export function applyItcReversalTo3b(db: DB, company: CompanyInfo, from: string, to: string, period: string): ItcReversalView {
  const v = itcReversal(db, company, from, to, period)
  const manual = getGst3bManual(db, period)
  setGst3bManual(db, period, {
    ...manual,
    itcRevRul: v.summary.table4B1,
    itcRevOth: v.summary.table4B2,
    itcReclaimed: v.summary.reclaimed,
    interest: v.summary.interest
  })
  writeReversalSplit(db, period, {
    rule37: v.summary.rule37,
    rule37A: { ...ZERO_HEADS },
    rule42: addHeads(v.summary.rule42, v.summary.trueUp),
    rule43: v.summary.rule43
  })
  return itcReversal(db, company, from, to, period)
}

/** Post the proposed journal (Dr ITC reversal / Cr input tax ledgers …) on the period's last day. */
export function postItcReversal(db: DB, company: CompanyInfo, from: string, to: string, period: string): { voucherId: number; number: string } {
  const v = itcReversal(db, company, from, to, period)
  if (v.posted) throw new Error(`Already posted for this period — journal ${v.posted.number}`)
  if (v.proposal.length === 0) throw new Error('Nothing to post — no reversal or re-availment in this period')
  return db.transaction(() => {
    const groupId = (name: string): number => {
      const ids = descendantIdsByName(db, [name])
      const g = db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number } | undefined
      if (!g && ids.size === 0) throw new Error(`Group “${name}” is missing`)
      return g?.id ?? [...ids][0]!
    }
    const ledgerIdOf = (l: ProposalLedger): number =>
      l.ledgerId ?? resolve(db, l).ledgerId ?? createLedger(db, { name: l.name, groupId: groupId(l.group) }).id
    const journalType = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal' ORDER BY is_system DESC, id LIMIT 1").get() as { id: number } | undefined
    if (!journalType) throw new Error('No journal voucher type')
    const saved = saveVoucher(db, {
      voucherTypeId: journalType.id,
      date: to,
      narration: `ITC reversal workings ${period.slice(0, 2)}/${period.slice(2)} — rules 42/43 and s.17(5) (3B 4(B)(1)), rule 37 (4(B)(2)), re-availed (4(D)(1))`,
      lines: v.proposal.map((l) => ({ ledgerId: ledgerIdOf(l.ledger), drCr: l.drCr, amount: l.amount })),
      inventory: []
    } as Parameters<typeof saveVoucher>[1])
    writeMeta(db, POSTED_KEY(period), { voucherId: saved.id })
    const number = (db.prepare('SELECT number FROM vouchers WHERE id = ?').get(saved.id) as { number: string }).number
    return { voucherId: saved.id, number }
  })()
}
