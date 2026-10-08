/**
 * WP 6.5 — group consolidation. The group definition (members, mappings, inter-company pairs)
 * lives in the group (parent) company's own DB (migration "WP 6.5"); every member's books —
 * including the open company's — are read READ-ONLY at query time through `withMemberDb`
 * (consolidated.ts: a file whose schema differs from this build is skipped with a warning, never
 * migrated). Each member's statements come from its own report functions (trial balance, P&L
 * through pnlLedgerAmounts, balance sheet), so its own year-opening rule and stock valuation
 * apply. The pure engine (@shared/consolidation/engine) does the combining and eliminations.
 * Nothing consolidated is stored.
 */
import type { DB } from '../db/connection'
import type { Nature } from '@shared/domain'
import type { ProfitAndLoss, StatementNode } from '@shared/reports'
import { fyFromStartYear, fyOf } from '@shared/dates'
import { consolidateStatement } from '@shared/consolidation/engine'
import { ageBalance } from '@shared/consolidation/ageing'
import { suggestPairs, type PairSuggestion, type SuggestMember } from '@shared/consolidation/suggest'
import type {
  ConsolidationGroup, ConsolidationMapping, ConsolidationMember, GroupRunResult, IcReconRow, IntercompanyPair,
  MemberChart, MemberFlow, MemberInput, MemberLedger, MemberRow, PairInput, StatementInput, StatementKind, StatementResult
} from '@shared/consolidation/types'
import type { ConsolGroupInput, ConsolMappingInput, ConsolPairInput } from '@shared/consolidation/schemas'
import { readRegistry } from '../registry'
import { withMemberDb } from './consolidated'
import * as reports from './reports'
import { booksFromYear } from './booksStart'
import { IN_BOOKS, NOT_YEAR_END_CLOSE } from './vouchers'
import { writeAudit } from './audit'

// ---------------------------------------------------------------- definition (this company's DB)

interface GroupRow { id: number; name: string; presentationCurrency: string; icTolerance: number; unrealisedMarginBp: number | null }

function readGroup(db: DB, row: GroupRow): ConsolidationGroup {
  const members = db
    .prepare(
      `SELECT id, company_slug AS companySlug, role, ownership_bp AS ownershipBp, acquired_on AS acquiredOn,
              include_from AS includeFrom, include_to AS includeTo, investment_ledger_id AS investmentLedgerId,
              acquisition_equity AS acquisitionEquity
       FROM consolidation_members WHERE group_id = ? ORDER BY CASE role WHEN 'parent' THEN 0 ELSE 1 END, sort_order, id`
    )
    .all(row.id) as ConsolidationMember[]
  const mappings = db
    .prepare(
      `SELECT id, company_slug AS companySlug, ledger_id AS ledgerId, group_name AS groupName, target_name AS targetName,
              target_nature AS targetNature
       FROM consolidation_mappings WHERE group_id = ? ORDER BY company_slug, id`
    )
    .all(row.id) as ConsolidationMapping[]
  const pairs = db
    .prepare(
      `SELECT id, member_a AS memberA, ledger_a_id AS ledgerAId, member_b AS memberB, ledger_b_id AS ledgerBId, kind,
              unrealised_margin_bp AS unrealisedMarginBp
       FROM intercompany_pairs WHERE group_id = ? ORDER BY id`
    )
    .all(row.id) as IntercompanyPair[]
  return { ...row, members, mappings, pairs }
}

const GROUP_COLS = `id, name, presentation_currency AS presentationCurrency, ic_tolerance AS icTolerance, unrealised_margin_bp AS unrealisedMarginBp`

export function listGroups(db: DB): ConsolidationGroup[] {
  return (db.prepare(`SELECT ${GROUP_COLS} FROM consolidation_groups ORDER BY name`).all() as GroupRow[]).map((r) => readGroup(db, r))
}

export function getGroup(db: DB, id: number): ConsolidationGroup {
  const row = db.prepare(`SELECT ${GROUP_COLS} FROM consolidation_groups WHERE id = ?`).get(id) as GroupRow | undefined
  if (!row) throw new Error('Consolidation group not found')
  return readGroup(db, row)
}

/** Create or update a group with its member list. Mappings and pairs of members that are no
 *  longer in the group are removed with them. */
export function saveGroup(db: DB, input: ConsolGroupInput, id?: number): ConsolidationGroup {
  const known = new Set(readRegistry().companies.map((c) => c.slug))
  for (const m of input.members) if (!known.has(m.companySlug)) throw new Error(`No company “${m.companySlug}” on this computer`)
  return db.transaction(() => {
    const before = id ? getGroup(db, id) : null
    const clash = db.prepare('SELECT id FROM consolidation_groups WHERE name = ? COLLATE NOCASE AND id IS NOT ?').get(input.name, id ?? null)
    if (clash) throw new Error(`A group called “${input.name}” already exists`)
    let groupId = id
    if (groupId) {
      db.prepare(
        `UPDATE consolidation_groups SET name = ?, presentation_currency = ?, ic_tolerance = ?, unrealised_margin_bp = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(input.name, input.presentationCurrency, input.icTolerance, input.unrealisedMarginBp, groupId)
    } else {
      groupId = Number(
        db.prepare('INSERT INTO consolidation_groups (name, presentation_currency, ic_tolerance, unrealised_margin_bp) VALUES (?, ?, ?, ?)')
          .run(input.name, input.presentationCurrency, input.icTolerance, input.unrealisedMarginBp).lastInsertRowid
      )
    }
    db.prepare('DELETE FROM consolidation_members WHERE group_id = ?').run(groupId)
    const ins = db.prepare(
      `INSERT INTO consolidation_members (group_id, company_slug, role, ownership_bp, acquired_on, include_from, include_to,
         investment_ledger_id, acquisition_equity, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    input.members.forEach((m, i) =>
      ins.run(groupId, m.companySlug, m.role, m.ownershipBp, m.acquiredOn, m.includeFrom, m.includeTo, m.investmentLedgerId, m.acquisitionEquity, i)
    )
    const slugs = input.members.map((m) => m.companySlug)
    const marks = slugs.map(() => '?').join(', ')
    db.prepare(`DELETE FROM consolidation_mappings WHERE group_id = ? AND company_slug NOT IN (${marks})`).run(groupId, ...slugs)
    db.prepare(`DELETE FROM intercompany_pairs WHERE group_id = ? AND (member_a NOT IN (${marks}) OR member_b NOT IN (${marks}))`).run(groupId, ...slugs, ...slugs)
    const after = getGroup(db, groupId)
    writeAudit(db, 'consolidation_group', groupId, before ? 'update' : 'create', before, after)
    return after
  })()
}

export function deleteGroup(db: DB, id: number): void {
  db.transaction(() => {
    const before = getGroup(db, id)
    db.prepare('DELETE FROM consolidation_groups WHERE id = ?').run(id)
    writeAudit(db, 'consolidation_group', id, 'delete', before, null)
  })()
}

const memberSlugs = (db: DB, groupId: number): Set<string> =>
  new Set((db.prepare('SELECT company_slug AS s FROM consolidation_members WHERE group_id = ?').all(groupId) as { s: string }[]).map((r) => r.s))

const mappingById = (db: DB, id: number): (ConsolidationMapping & { groupId: number }) | undefined =>
  db.prepare(
    `SELECT id, group_id AS groupId, company_slug AS companySlug, ledger_id AS ledgerId, group_name AS groupName, target_name AS targetName,
            target_nature AS targetNature FROM consolidation_mappings WHERE id = ?`
  ).get(id) as (ConsolidationMapping & { groupId: number }) | undefined

/** A per-ledger or per-group override (replaces any existing one for the same source). */
export function saveMapping(db: DB, input: ConsolMappingInput): ConsolidationMapping {
  return db.transaction(() => {
    getGroup(db, input.groupId)
    if (!memberSlugs(db, input.groupId).has(input.companySlug)) throw new Error(`${input.companySlug} is not a member of this group`)
    const existing = db
      .prepare(
        input.ledgerId != null
          ? 'SELECT id FROM consolidation_mappings WHERE group_id = ? AND company_slug = ? AND ledger_id = ?'
          : 'SELECT id FROM consolidation_mappings WHERE group_id = ? AND company_slug = ? AND group_name = ? COLLATE NOCASE'
      )
      .get(input.groupId, input.companySlug, input.ledgerId ?? input.groupName) as { id: number } | undefined
    const before = existing ? mappingById(db, existing.id) ?? null : null
    let id = existing?.id
    if (id) {
      db.prepare('UPDATE consolidation_mappings SET target_name = ?, target_nature = ? WHERE id = ?').run(input.targetName, input.targetNature, id)
    } else {
      id = Number(
        db.prepare('INSERT INTO consolidation_mappings (group_id, company_slug, ledger_id, group_name, target_name, target_nature) VALUES (?, ?, ?, ?, ?, ?)')
          .run(input.groupId, input.companySlug, input.ledgerId, input.groupName, input.targetName, input.targetNature).lastInsertRowid
      )
    }
    const after = mappingById(db, id)!
    writeAudit(db, 'consolidation_mapping', id, before ? 'update' : 'create', before, after)
    return after
  })()
}

export function deleteMapping(db: DB, id: number): void {
  db.transaction(() => {
    const before = mappingById(db, id)
    if (!before) throw new Error('Mapping not found')
    db.prepare('DELETE FROM consolidation_mappings WHERE id = ?').run(id)
    writeAudit(db, 'consolidation_mapping', id, 'delete', before, null)
  })()
}

const pairById = (db: DB, id: number): (IntercompanyPair & { groupId: number }) | undefined =>
  db.prepare(
    `SELECT id, group_id AS groupId, member_a AS memberA, ledger_a_id AS ledgerAId, member_b AS memberB, ledger_b_id AS ledgerBId, kind,
            unrealised_margin_bp AS unrealisedMarginBp FROM intercompany_pairs WHERE id = ?`
  ).get(id) as (IntercompanyPair & { groupId: number }) | undefined

export function savePair(db: DB, input: ConsolPairInput, id?: number): IntercompanyPair {
  return db.transaction(() => {
    getGroup(db, input.groupId)
    const slugs = memberSlugs(db, input.groupId)
    if (!slugs.has(input.memberA) || !slugs.has(input.memberB)) throw new Error('Both sides of a pair must be members of the group')
    const before = id ? pairById(db, id) ?? null : null
    if (id && !before) throw new Error('Pair not found')
    const dup = db
      .prepare(
        `SELECT id FROM intercompany_pairs WHERE group_id = ? AND kind = ? AND id IS NOT ? AND
           ((member_a = ? AND ledger_a_id = ? AND member_b = ? AND ledger_b_id = ?) OR (member_a = ? AND ledger_a_id = ? AND member_b = ? AND ledger_b_id = ?))`
      )
      .get(input.groupId, input.kind, id ?? null, input.memberA, input.ledgerAId, input.memberB, input.ledgerBId, input.memberB, input.ledgerBId, input.memberA, input.ledgerAId)
    if (dup) throw new Error('That pair already exists')
    let pid = id
    if (pid) {
      db.prepare('UPDATE intercompany_pairs SET member_a = ?, ledger_a_id = ?, member_b = ?, ledger_b_id = ?, kind = ?, unrealised_margin_bp = ? WHERE id = ?')
        .run(input.memberA, input.ledgerAId, input.memberB, input.ledgerBId, input.kind, input.unrealisedMarginBp, pid)
    } else {
      pid = Number(
        db.prepare('INSERT INTO intercompany_pairs (group_id, member_a, ledger_a_id, member_b, ledger_b_id, kind, unrealised_margin_bp) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(input.groupId, input.memberA, input.ledgerAId, input.memberB, input.ledgerBId, input.kind, input.unrealisedMarginBp).lastInsertRowid
      )
    }
    const after = pairById(db, pid)!
    writeAudit(db, 'intercompany_pair', pid, before ? 'update' : 'create', before, after)
    return after
  })()
}

export function deletePair(db: DB, id: number): void {
  db.transaction(() => {
    const before = pairById(db, id)
    if (!before) throw new Error('Pair not found')
    db.prepare('DELETE FROM intercompany_pairs WHERE id = ?').run(id)
    writeAudit(db, 'intercompany_pair', id, 'delete', before, null)
  })()
}

// ---------------------------------------------------------------- reading a member's books

interface CompanyMeta { gstin: string | null; pan: string | null }

function companyMeta(mdb: DB): CompanyMeta {
  const row = mdb.prepare("SELECT value FROM meta WHERE key = 'company'").get() as { value: string } | undefined
  try {
    const v = row ? (JSON.parse(row.value) as { gstin?: string | null; pan?: string | null }) : {}
    return { gstin: v.gstin ?? null, pan: v.pan ?? null }
  } catch {
    return { gstin: null, pan: null }
  }
}

interface Catalogue { ledgers: (MemberLedger & { gstin: string | null; pan: string | null })[]; groups: { name: string; nature: Nature }[] }

function catalogue(mdb: DB): Catalogue {
  const groups = mdb.prepare('SELECT id, name, parent_id AS parentId, nature, affects_gross_profit AS gp FROM groups').all() as
    { id: number; name: string; parentId: number | null; nature: Nature; gp: number }[]
  const byId = new Map(groups.map((g) => [g.id, g]))
  const pathOf = (id: number): string[] => {
    const out: string[] = []
    for (let g = byId.get(id), guard = 0; g && guard < 50; g = g.parentId != null ? byId.get(g.parentId) : undefined, guard++) out.unshift(g.name)
    return out
  }
  const ledgers = (mdb.prepare('SELECT id, name, group_id AS groupId, gstin, pan FROM ledgers ORDER BY name').all() as
    { id: number; name: string; groupId: number; gstin: string | null; pan: string | null }[]).map((l) => {
    const g = byId.get(l.groupId)!
    const groupPath = pathOf(l.groupId)
    return {
      id: l.id, name: l.name, groupName: g.name, groupPath, nature: g.nature, gp: !!g.gp,
      equity: groupPath[0] === 'Capital Account', gstin: l.gstin, pan: l.pan
    }
  })
  return { ledgers, groups: groups.map((g) => ({ name: g.name, nature: g.nature })).sort((a, b) => a.name.localeCompare(b.name)) }
}

function flattenTree(nodes: StatementNode[], sign: 1 | -1, cat: Map<number, MemberLedger>, out: MemberRow[], fallbackGroup: string): void {
  for (const n of nodes) {
    if (n.kind === 'group') {
      flattenTree(n.children, sign, cat, out, n.name)
    } else if (n.kind === 'ledger') {
      const l = cat.get(n.id)
      out.push({
        ledgerId: n.id, name: n.name, groupName: l?.groupName ?? fallbackGroup, nature: l?.nature ?? 'asset', gp: l?.gp ?? false,
        amount: sign * n.amount, equity: l?.equity ?? false
      })
    } else if (n.id === -2) {
      out.push({ ledgerId: -2, name: 'Closing Stock', groupName: 'Stock-in-Hand', nature: 'asset', gp: false, amount: sign * n.amount, equity: false, computed: 'closing_stock' })
    } else if (n.id === -3) {
      out.push({ ledgerId: -3, name: n.name, groupName: 'Profit & Loss A/c', nature: 'liability', gp: false, amount: sign * n.amount, equity: true, computed: 'pnl_current' })
    } else if (n.id === -4) {
      out.push({ ledgerId: -4, name: n.name, groupName: 'Difference in Opening Balances', nature: 'liability', gp: false, amount: sign * n.amount, equity: false, computed: 'opening_diff' })
    }
  }
}

function pnlRows(pnl: ProfitAndLoss, cat: Map<number, MemberLedger>): MemberRow[] {
  const out: MemberRow[] = []
  flattenTree(pnl.tradingExpenses, 1, cat, out, 'Trading expenses')
  flattenTree(pnl.indirectExpenses, 1, cat, out, 'Indirect expenses')
  flattenTree(pnl.tradingIncomes, -1, cat, out, 'Trading incomes')
  flattenTree(pnl.indirectIncomes, -1, cat, out, 'Indirect incomes')
  if (pnl.openingStock) out.push({ ledgerId: -6, name: 'Opening Stock', groupName: 'Stock-in-Hand', nature: 'expense', gp: true, amount: pnl.openingStock, equity: false, computed: 'opening_stock' })
  if (pnl.closingStock) out.push({ ledgerId: -2, name: 'Closing Stock', groupName: 'Stock-in-Hand', nature: 'income', gp: true, amount: -pnl.closingStock, equity: false, computed: 'closing_stock' })
  return out
}

const dayBefore = (date: string): string => {
  const dt = new Date(`${date}T00:00:00Z`)
  dt.setUTCDate(dt.getUTCDate() - 1)
  return dt.toISOString().slice(0, 10)
}
const maxDate = (a: string, b: string | null): string => (b && b > a ? b : a)
const minDate = (a: string, b: string | null): string => (b && b < a ? b : a)

/** P&L lines of the window in vouchers that touch `partyLedgerId` (inter-company transactions
 *  booked through a party ledger). */
function partyFlows(mdb: DB, partyLedgerId: number, from: string, to: string): MemberFlow[] {
  if (from > to) return []
  return (mdb
    .prepare(
      `SELECT vl.ledger_id AS ledgerId, SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS amount
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN ledgers l ON l.id = vl.ledger_id
       JOIN groups g ON g.id = l.group_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS} AND ${NOT_YEAR_END_CLOSE}
         AND g.nature IN ('income', 'expense')
         AND vl.voucher_id IN (SELECT voucher_id FROM voucher_lines WHERE ledger_id = ?)
       GROUP BY vl.ledger_id
       HAVING amount <> 0
       ORDER BY vl.ledger_id`
    )
    .all(from, to, partyLedgerId) as MemberFlow[])
}

function ledgerMovements(mdb: DB, ledgerId: number, asOn: string, booksStart: string): { date: string; amount: number }[] {
  const opening = (mdb.prepare('SELECT opening_balance AS ob FROM ledgers WHERE id = ?').get(ledgerId) as { ob: number } | undefined)?.ob ?? 0
  const lines = mdb
    .prepare(
      `SELECT v.date AS date, SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS amount
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = ? AND v.date <= ? AND ${IN_BOOKS}
       GROUP BY v.id`
    )
    .all(ledgerId, asOn) as { date: string; amount: number }[]
  return opening ? [{ date: booksStart, amount: opening }, ...lines] : lines
}

interface MemberSnapshot {
  name: string
  ok: boolean
  inputs: Record<StatementKind, MemberInput>
  /** Flows per pair side, by statement window. */
  flows: Map<string, { pnl: MemberFlow[]; tb: MemberFlow[] }>
  ageing: Map<number, number[]>
}

function emptyInput(m: ConsolidationMember, name: string): MemberInput {
  return {
    slug: m.companySlug, name, role: m.role, ownershipBp: m.role === 'parent' ? 10000 : m.ownershipBp, included: false, ledgers: [], rows: [],
    periodProfit: 0, equityNow: 0, acquisitionEquity: m.acquisitionEquity, closingStock: 0, purchases: 0, investmentLedgerId: m.investmentLedgerId
  }
}

function snapshot(m: ConsolidationMember, name: string, group: ConsolidationGroup, from: string, to: string, warnings: string[]): MemberSnapshot {
  const empty = emptyInput(m, name)
  const snap: MemberSnapshot = { name, ok: false, inputs: { tb: empty, pnl: empty, bs: empty }, flows: new Map(), ageing: new Map() }
  const read = withMemberDb(m.companySlug, name, (mdb) => {
    const booksStart = fyFromStartYear(booksFromYear(mdb)).from
    const cat = catalogue(mdb)
    const catMap = new Map(cat.ledgers.map((l) => [l.id, l]))
    const ledgers: MemberLedger[] = cat.ledgers.map(({ gstin: _g, pan: _p, ...l }) => l)
    const incFrom = m.includeFrom ?? m.acquiredOn
    const onDate = (!incFrom || incFrom <= to) && (!m.includeTo || m.includeTo >= to)
    const pf = maxDate(from, incFrom), pt = minDate(to, m.includeTo)
    const pnlIn = pf <= pt
    const tbFrom = maxDate(fyOf(to).from, incFrom)

    // P&L for the member's share of the period
    const pnl = pnlIn ? reports.profitAndLoss(mdb, pf, pt) : null
    const rowsPnl = pnl ? pnlRows(pnl, catMap) : []
    const purchases = pnl ? pnl.tradingExpenses.reduce((s, n) => s + n.amount, 0) : 0
    const tbProfit = onDate && tbFrom <= to ? reports.profitAndLoss(mdb, tbFrom, to).netProfit : 0

    // Trial balance and balance sheet on the reporting date
    const tbRows: MemberRow[] = onDate
      ? reports.trialBalance(mdb, to).rows.map((r): MemberRow => {
          const l = catMap.get(r.ledgerId)
          const amount = r.debit - r.credit
          if (r.ledgerId === -1) return { ledgerId: -1, name: r.ledgerName, groupName: r.groupName, nature: 'asset', gp: false, amount, equity: false, computed: 'tb_stock_opening' }
          if (r.ledgerId === -5) return { ledgerId: -5, name: r.ledgerName, groupName: r.groupName, nature: 'liability', gp: false, amount, equity: true, computed: 'pnl_opening' }
          return { ledgerId: r.ledgerId, name: r.ledgerName, groupName: r.groupName, nature: l?.nature ?? 'asset', gp: l?.gp ?? false, amount, equity: l?.equity ?? false }
        })
      : []
    const bsRows: MemberRow[] = []
    let closingStock = 0
    if (onDate) {
      const bs = reports.balanceSheet(mdb, booksStart, to)
      flattenTree(bs.assets, 1, catMap, bsRows, 'Assets')
      flattenTree(bs.liabilities, -1, catMap, bsRows, 'Liabilities')
      closingStock = reports.stockValue(mdb, to)
    }
    const equityNow = -bsRows.filter((r) => r.equity).reduce((s, r) => s + r.amount, 0)

    // Equity at acquisition (override, else from the member's own books — sources.ts 'equity-at-acquisition')
    let acquisitionEquity = m.acquisitionEquity
    if (acquisitionEquity == null && m.acquiredOn && m.role !== 'parent') {
      const d = dayBefore(m.acquiredOn)
      if (d >= booksStart) {
        const rows: MemberRow[] = []
        const bsAcq = reports.balanceSheet(mdb, booksStart, d)
        flattenTree(bsAcq.liabilities, -1, catMap, rows, 'Liabilities')
        acquisitionEquity = -rows.filter((r) => r.equity).reduce((s, r) => s + r.amount, 0)
      } else {
        const ids = cat.ledgers.filter((l) => l.equity).map((l) => l.id)
        acquisitionEquity = ids.length
          ? -(mdb.prepare(`SELECT COALESCE(SUM(opening_balance), 0) AS s FROM ledgers WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids) as { s: number }).s
          : 0
      }
    }

    const base = { ...empty, ledgers, acquisitionEquity, equityNow, closingStock, purchases }
    snap.inputs = {
      pnl: { ...base, included: pnlIn, rows: rowsPnl, periodProfit: pnl?.netProfit ?? 0 },
      tb: { ...base, included: onDate, rows: tbRows, periodProfit: tbProfit },
      bs: { ...base, included: onDate, rows: bsRows, periodProfit: pnl?.netProfit ?? 0 }
    }

    // Pair sides in this member's books: party flows and ageing
    for (const p of group.pairs) {
      for (const [side, ledgerId] of [[p.memberA, p.ledgerAId], [p.memberB, p.ledgerBId]] as const) {
        if (side !== m.companySlug) continue
        const l = catMap.get(ledgerId)
        if (!l) continue
        const isBs = l.nature === 'asset' || l.nature === 'liability'
        if (isBs && (p.kind === 'sales_purchase' || p.kind === 'loan')) {
          snap.flows.set(`${p.id}:${ledgerId}`, { pnl: pnlIn ? partyFlows(mdb, ledgerId, pf, pt) : [], tb: onDate ? partyFlows(mdb, ledgerId, tbFrom, to) : [] })
        }
        if (isBs && p.kind !== 'sales_purchase' && !snap.ageing.has(ledgerId)) snap.ageing.set(ledgerId, ageBalance(ledgerMovements(mdb, ledgerId, to, booksStart), to))
      }
    }
    return true
  })
  if (!read.ok) warnings.push(read.warning)
  snap.ok = read.ok
  return snap
}

// ---------------------------------------------------------------- the run

function runStatements(group: ConsolidationGroup, from: string, to: string, names: Map<string, string>): {
  tb: StatementResult; pnl: StatementResult; bs: StatementResult; snaps: Map<string, MemberSnapshot>; warnings: string[]
} {
  const warnings: string[] = []
  if (group.presentationCurrency !== 'INR') warnings.push(`Presentation currency ${group.presentationCurrency}: members' books are in INR and no translation is applied`)
  const snaps = new Map<string, MemberSnapshot>()
  for (const m of group.members) snaps.set(m.companySlug, snapshot(m, names.get(m.companySlug) ?? m.companySlug, group, from, to, warnings))
  const statement = (kind: StatementKind): StatementResult => {
    const pairs: PairInput[] = group.pairs.map((p) => ({
      id: p.id, kind: p.kind, a: { slug: p.memberA, ledgerId: p.ledgerAId }, b: { slug: p.memberB, ledgerId: p.ledgerBId },
      unrealisedMarginBp: p.unrealisedMarginBp,
      flowsA: snaps.get(p.memberA)?.flows.get(`${p.id}:${p.ledgerAId}`)?.[kind === 'tb' ? 'tb' : 'pnl'],
      flowsB: snaps.get(p.memberB)?.flows.get(`${p.id}:${p.ledgerBId}`)?.[kind === 'tb' ? 'tb' : 'pnl']
    }))
    const input: StatementInput = {
      kind, members: group.members.map((m) => snaps.get(m.companySlug)!.inputs[kind]), pairs,
      mappings: group.mappings.map(({ id: _id, ...rest }) => rest), icTolerance: group.icTolerance, unrealisedMarginBp: group.unrealisedMarginBp
    }
    return consolidateStatement(input)
  }
  const tb = statement('tb'), pnl = statement('pnl'), bs = statement('bs')
  for (const w of [...bs.warnings, ...pnl.warnings, ...tb.warnings]) if (!warnings.includes(w)) warnings.push(w)
  return { tb, pnl, bs, snaps, warnings }
}

const yearBefore = (date: string): string => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const maxDay = new Date(Date.UTC(y - 1, m, 0)).getUTCDate()
  return `${y - 1}-${String(m).padStart(2, '0')}-${String(Math.min(d, maxDay)).padStart(2, '0')}`
}

const byKey = (s: StatementResult): Record<string, number> => Object.fromEntries(s.lines.map((l) => [l.key, l.consolidated]))

export function runGroup(db: DB, groupId: number, from: string, to: string, opts: { comparePrior?: boolean; openSlug?: string | null } = {}): GroupRunResult {
  const group = getGroup(db, groupId)
  const names = new Map(readRegistry().companies.map((c) => [c.slug, c.name]))
  const { tb, pnl, bs, snaps, warnings } = runStatements(group, from, to, names)

  const nameOf = (slug: string): string => snaps.get(slug)?.name ?? names.get(slug) ?? slug
  const recon: IcReconRow[] = group.pairs.map((p) => {
    const bal = bs.pairs.find((r) => r.pairId === p.id && r.basis === 'balance')
    const balSkip = bs.pairs.find((r) => r.pairId === p.id && r.status === 'skipped')
    const flow = pnl.pairs.find((r) => r.pairId === p.id && r.basis === 'flow')
    const flowSkip = pnl.pairs.find((r) => r.pairId === p.id && r.status === 'skipped')
    const ledgerName = (slug: string, id: number): string =>
      snaps.get(slug)?.inputs.bs.ledgers.find((l) => l.id === id)?.name ?? `ledger #${id} (not found)`
    return {
      pairId: p.id, kind: p.kind,
      memberA: p.memberA, memberAName: nameOf(p.memberA), ledgerAId: p.ledgerAId, ledgerAName: ledgerName(p.memberA, p.ledgerAId),
      memberB: p.memberB, memberBName: nameOf(p.memberB), ledgerBId: p.ledgerBId, ledgerBName: ledgerName(p.memberB, p.ledgerBId),
      balanceA: bal ? bal.a.amount : null, balanceB: bal ? bal.b.amount : null, difference: bal ? bal.difference : null,
      status: bal ? bal.status : balSkip ? 'skipped' : 'n/a',
      flowA: flow ? flow.a.amount : null, flowB: flow ? flow.b.amount : null, flowDifference: flow ? flow.difference : null,
      flowStatus: flow ? flow.status : flowSkip ? 'skipped' : 'n/a',
      ageingA: snaps.get(p.memberA)?.ageing.get(p.ledgerAId) ?? [],
      ageingB: snaps.get(p.memberB)?.ageing.get(p.ledgerBId) ?? [],
      note: balSkip?.note ?? flowSkip?.note ?? null
    }
  })

  const result: GroupRunResult = {
    group: { id: group.id, name: group.name, presentationCurrency: group.presentationCurrency, icTolerance: group.icTolerance, unrealisedMarginBp: group.unrealisedMarginBp },
    period: { from, to },
    openSlug: opts.openSlug ?? null,
    tb, pnl, bs, recon, warnings
  }
  if (opts.comparePrior) {
    const pf = yearBefore(from), pt = yearBefore(to)
    const prior = runStatements(group, pf, pt, names)
    result.prior = {
      period: { from: pf, to: pt }, tb: byKey(prior.tb), pnl: byKey(prior.pnl), bs: byKey(prior.bs),
      netProfit: prior.pnl.profit!.netProfit, ownersProfit: prior.pnl.profit!.ownersProfit
    }
  }
  return result
}

// ---------------------------------------------------------------- pickers + suggestions

export function memberCharts(db: DB, groupId: number): MemberChart[] {
  const group = getGroup(db, groupId)
  const names = new Map(readRegistry().companies.map((c) => [c.slug, c.name]))
  return group.members.map((m) => {
    const name = names.get(m.companySlug) ?? m.companySlug
    const read = withMemberDb(m.companySlug, name, (mdb) => ({ cat: catalogue(mdb), meta: companyMeta(mdb) }))
    if (!read.ok) return { slug: m.companySlug, name, available: false, warning: read.warning, gstin: null, pan: null, ledgers: [], groups: [] }
    return {
      slug: m.companySlug, name, available: true, warning: null, ...read.value.meta,
      ledgers: read.value.cat.ledgers.map((l) => ({ id: l.id, name: l.name, groupName: l.groupName, nature: l.nature, gstin: l.gstin, pan: l.pan })),
      groups: read.value.cat.groups
    }
  })
}

export function suggestGroupPairs(db: DB, groupId: number): PairSuggestion[] {
  const group = getGroup(db, groupId)
  const members: SuggestMember[] = memberCharts(db, groupId)
    .filter((c) => c.available && group.members.find((m) => m.companySlug === c.slug)?.role !== 'associate')
    .map((c) => ({ slug: c.slug, name: c.name, gstin: c.gstin, pan: c.pan, ledgers: c.ledgers }))
  return suggestPairs(members, group.pairs)
}
