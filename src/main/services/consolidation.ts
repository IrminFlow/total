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
import { consolidateStatement, crossesStatements } from '@shared/consolidation/engine'
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
              investment_company_slug AS investmentCompanySlug, investment_ledger_name AS investmentLedgerName,
              investment_cost AS investmentCost, acquisition_equity AS acquisitionEquity
       FROM consolidation_members WHERE group_id = ? ORDER BY CASE role WHEN 'parent' THEN 0 ELSE 1 END, sort_order, id`
    )
    .all(row.id) as ConsolidationMember[]
  const mappings = db
    .prepare(
      `SELECT id, company_slug AS companySlug, ledger_id AS ledgerId, ledger_name AS ledgerName, group_name AS groupName,
              target_name AS targetName, target_nature AS targetNature
       FROM consolidation_mappings WHERE group_id = ? ORDER BY company_slug, id`
    )
    .all(row.id) as ConsolidationMapping[]
  const pairs = db
    .prepare(
      `SELECT id, member_a AS memberA, ledger_a_id AS ledgerAId, ledger_a_name AS ledgerAName, member_b AS memberB,
              ledger_b_id AS ledgerBId, ledger_b_name AS ledgerBName, kind, unrealised_margin_bp AS unrealisedMarginBp
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
  const registry = readRegistry().companies
  const known = new Set(registry.map((c) => c.slug))
  for (const m of input.members) if (!known.has(m.companySlug)) throw new Error(`No company “${m.companySlug}” on this computer`)
  const parentSlug = input.members.find((m) => m.role === 'parent')!.companySlug
  const needsInvestment = input.members.some((m) => m.role !== 'parent' && m.investmentLedgerId != null)
  const parentLedgers = needsInvestment ? memberLedgerIndex(parentSlug, registry.find((c) => c.slug === parentSlug)?.name ?? parentSlug) : null
  const investmentName = (id: number | null): string | null => {
    if (id == null) return null
    const l = parentLedgers?.get(id)
    if (!l) throw new Error(`The investment ledger #${id} is not in the parent's books`)
    if (l.nature !== 'asset') throw new Error(`The investment ledger “${l.name}” must be an asset ledger`)
    return l.name
  }
  const invNames = input.members.map((m) => (m.role === 'parent' ? null : investmentName(m.investmentLedgerId)))
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
         investment_company_slug, investment_ledger_id, investment_ledger_name, investment_cost, acquisition_equity, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    input.members.forEach((m, i) => {
      const inv = m.role === 'parent' ? null : m.investmentLedgerId
      ins.run(groupId, m.companySlug, m.role, m.ownershipBp, m.acquiredOn, m.includeFrom, m.includeTo,
        inv == null ? null : parentSlug, inv, invNames[i], m.role === 'parent' ? null : m.investmentCost, m.role === 'parent' ? null : m.acquisitionEquity, i)
    })
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
    `SELECT id, group_id AS groupId, company_slug AS companySlug, ledger_id AS ledgerId, ledger_name AS ledgerName, group_name AS groupName,
            target_name AS targetName, target_nature AS targetNature FROM consolidation_mappings WHERE id = ?`
  ).get(id) as (ConsolidationMapping & { groupId: number }) | undefined

/** A per-ledger or per-group override (replaces any existing one for the same source). */
export function saveMapping(db: DB, input: ConsolMappingInput): ConsolidationMapping {
  return db.transaction(() => {
    getGroup(db, input.groupId)
    if (!memberSlugs(db, input.groupId).has(input.companySlug)) throw new Error(`${input.companySlug} is not a member of this group`)
    const chart = memberChartOf(input.companySlug)
    let ledgerName: string | null = null
    let sourceNatures: Nature[]
    if (input.ledgerId != null) {
      const l = chart.ledgers.find((x) => x.id === input.ledgerId)
      if (!l) throw new Error(`Ledger #${input.ledgerId} is not in ${chart.name}'s books`)
      ledgerName = l.name
      sourceNatures = [l.nature]
    } else {
      const g = chart.groups.find((x) => x.name.toLowerCase() === input.groupName!.toLowerCase())
      if (!g) throw new Error(`There is no group “${input.groupName}” in ${chart.name}'s books`)
      sourceNatures = [g.nature, ...chart.ledgers.filter((l) => l.groupPath.some((n) => n.toLowerCase() === g.name.toLowerCase())).map((l) => l.nature)]
    }
    if (input.targetNature && sourceNatures.some((n) => crossesStatements(n, input.targetNature!))) {
      throw new Error('A mapping cannot move a ledger between the balance sheet and the P&L')
    }
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
      db.prepare('UPDATE consolidation_mappings SET target_name = ?, target_nature = ?, ledger_name = ? WHERE id = ?').run(input.targetName, input.targetNature, ledgerName, id)
    } else {
      id = Number(
        db.prepare('INSERT INTO consolidation_mappings (group_id, company_slug, ledger_id, ledger_name, group_name, target_name, target_nature) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(input.groupId, input.companySlug, input.ledgerId, ledgerName, input.groupName, input.targetName, input.targetNature).lastInsertRowid
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
    `SELECT id, group_id AS groupId, member_a AS memberA, ledger_a_id AS ledgerAId, ledger_a_name AS ledgerAName, member_b AS memberB,
            ledger_b_id AS ledgerBId, ledger_b_name AS ledgerBName, kind, unrealised_margin_bp AS unrealisedMarginBp FROM intercompany_pairs WHERE id = ?`
  ).get(id) as (IntercompanyPair & { groupId: number }) | undefined

export function savePair(db: DB, input: ConsolPairInput, id?: number): IntercompanyPair {
  return db.transaction(() => {
    getGroup(db, input.groupId)
    const slugs = memberSlugs(db, input.groupId)
    if (!slugs.has(input.memberA) || !slugs.has(input.memberB)) throw new Error('Both sides of a pair must be members of the group')
    const nameIn = (slug: string, id: number): string => {
      const chart = memberChartOf(slug)
      const l = chart.ledgers.find((x) => x.id === id)
      if (!l) throw new Error(`Ledger #${id} is not in ${chart.name}'s books`)
      return l.name
    }
    const aName = nameIn(input.memberA, input.ledgerAId), bName = nameIn(input.memberB, input.ledgerBId)
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
      db.prepare('UPDATE intercompany_pairs SET member_a = ?, ledger_a_id = ?, ledger_a_name = ?, member_b = ?, ledger_b_id = ?, ledger_b_name = ?, kind = ?, unrealised_margin_bp = ? WHERE id = ?')
        .run(input.memberA, input.ledgerAId, aName, input.memberB, input.ledgerBId, bName, input.kind, input.unrealisedMarginBp, pid)
    } else {
      pid = Number(
        db.prepare('INSERT INTO intercompany_pairs (group_id, member_a, ledger_a_id, ledger_a_name, member_b, ledger_b_id, ledger_b_name, kind, unrealised_margin_bp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(input.groupId, input.memberA, input.ledgerAId, aName, input.memberB, input.ledgerBId, bName, input.kind, input.unrealisedMarginBp).lastInsertRowid
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

function memberChartOf(slug: string): { name: string; ledgers: Catalogue['ledgers']; groups: Catalogue['groups'] } {
  const name = readRegistry().companies.find((c) => c.slug === slug)?.name ?? slug
  const read = withMemberDb(slug, name, (mdb) => catalogue(mdb))
  if (!read.ok) throw new Error(read.warning)
  return { name, ...read.value }
}

function memberLedgerIndex(slug: string, name: string): Map<number, Catalogue['ledgers'][number]> {
  const read = withMemberDb(slug, name, (mdb) => catalogue(mdb))
  if (!read.ok) throw new Error(read.warning)
  return new Map(read.value.ledgers.map((l) => [l.id, l]))
}

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
/** A member's first included day: "include from", else the acquisition date. */
const inclusionFrom = (m: Pick<ConsolidationMember, 'includeFrom' | 'acquiredOn'>): string | null => m.includeFrom ?? m.acquiredOn
const minDate = (a: string, b: string | null): string => (b && b < a ? b : a)

/**
 * Inter-company transactions booked through a party ledger: the P&L lines of the window's vouchers
 * that touch `partyLedgerId`, counting only vouchers whose other balance-sheet lines are tax
 * ledgers (an invoice / bill / debit or credit note / interest journal with that party). A voucher
 * that also involves another balance-sheet account — a bank (bank charges on a receipt), another
 * party in a multi-party journal — cannot be attributed safely: its P&L lines are left out and the
 * voucher is listed so the user can check it.
 */
function partyFlows(mdb: DB, partyLedgerId: number, from: string, to: string, taxLedgers: Set<number>): { flows: MemberFlow[]; excluded: string[] } {
  if (from > to) return { flows: [], excluded: [] }
  const lines = mdb
    .prepare(
      `SELECT vl.voucher_id AS vid, v.number AS number, v.date AS date, vl.ledger_id AS ledgerId, g.nature AS nature,
              CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END AS amount
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN ledgers l ON l.id = vl.ledger_id
       JOIN groups g ON g.id = l.group_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS} AND ${NOT_YEAR_END_CLOSE}
         AND vl.voucher_id IN (SELECT voucher_id FROM voucher_lines WHERE ledger_id = ?)
       ORDER BY v.date, vl.voucher_id, vl.id`
    )
    .all(from, to, partyLedgerId) as { vid: number; number: string; date: string; ledgerId: number; nature: Nature; amount: number }[]
  const byVoucher = new Map<number, typeof lines>()
  for (const l of lines) byVoucher.set(l.vid, [...(byVoucher.get(l.vid) ?? []), l])
  const totals = new Map<number, number>()
  const excluded: string[] = []
  for (const vlines of byVoucher.values()) {
    const pl = vlines.filter((l) => l.nature === 'income' || l.nature === 'expense')
    if (!pl.length) continue
    const clean = vlines.every((l) => l.nature === 'income' || l.nature === 'expense' || l.ledgerId === partyLedgerId || taxLedgers.has(l.ledgerId))
    if (!clean) {
      excluded.push(`${vlines[0]!.number} (${vlines[0]!.date})`)
      continue
    }
    for (const l of pl) totals.set(l.ledgerId, (totals.get(l.ledgerId) ?? 0) + l.amount)
  }
  const flows = [...totals].filter(([, a]) => a !== 0).sort((a, b) => a[0] - b[0]).map(([ledgerId, amount]) => ({ ledgerId, amount }))
  return { flows, excluded }
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
  /** Flows per pair side over the overlap of both members' inclusion windows, by statement. */
  flows: Map<string, { pnl: MemberFlow[]; tb: MemberFlow[] }>
  ageing: Map<number, number[]>
  /** Ledger names by id (run-time name checks). */
  names: Map<number, string>
}

function emptyInput(m: ConsolidationMember, name: string): MemberInput {
  return {
    slug: m.companySlug, name, role: m.role, ownershipBp: m.role === 'parent' ? 10000 : m.ownershipBp, included: false, ledgers: [], rows: [],
    periodProfit: 0, equityNow: 0, acquisitionEquity: m.acquisitionEquity, closingStock: 0, purchases: 0, sales: 0, grossProfit: 0,
    investmentLedgerId: m.investmentLedgerId, investmentCost: m.investmentCost
  }
}

function snapshot(m: ConsolidationMember, name: string, group: ConsolidationGroup, from: string, to: string, warnings: string[]): MemberSnapshot {
  const empty = emptyInput(m, name)
  const snap: MemberSnapshot = { name, ok: false, inputs: { tb: empty, pnl: empty, bs: empty }, flows: new Map(), ageing: new Map(), names: new Map() }
  const read = withMemberDb(m.companySlug, name, (mdb) => {
    const booksStart = fyFromStartYear(booksFromYear(mdb)).from
    const cat = catalogue(mdb)
    const catMap = new Map(cat.ledgers.map((l) => [l.id, l]))
    const ledgers: MemberLedger[] = cat.ledgers.map(({ gstin: _g, pan: _p, ...l }) => l)
    snap.names = new Map(cat.ledgers.map((l) => [l.id, l.name]))
    const taxLedgers = new Set(cat.ledgers.filter((l) => l.groupPath.includes('Duties & Taxes')).map((l) => l.id))
    for (const r of mdb.prepare('SELECT id FROM ledgers WHERE tax_type IS NOT NULL').all() as { id: number }[]) taxLedgers.add(r.id)
    const incFrom = inclusionFrom(m)
    const onDate = (!incFrom || incFrom <= to) && (!m.includeTo || m.includeTo >= to)
    const pf = maxDate(from, incFrom), pt = minDate(to, m.includeTo)
    const pnlIn = pf <= pt
    const tbFrom = maxDate(fyOf(to).from, incFrom)

    // P&L for the member's share of the period
    const pnl = pnlIn ? reports.profitAndLoss(mdb, pf, pt) : null
    const rowsPnl = pnl ? pnlRows(pnl, catMap) : []
    // Unrealised-profit inputs: Purchase Accounts only (not direct expenses), trading income, gross profit.
    const purchases = rowsPnl.filter((r) => catMap.get(r.ledgerId)?.groupPath[0] === 'Purchase Accounts').reduce((s, r) => s + r.amount, 0)
    const sales = pnl ? pnl.tradingIncomes.reduce((s, n) => s + n.amount, 0) : 0
    const grossProfit = pnl?.grossProfit ?? 0
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

    const base = { ...empty, ledgers, acquisitionEquity, equityNow, closingStock, purchases, sales, grossProfit }
    snap.inputs = {
      pnl: { ...base, included: pnlIn, rows: rowsPnl, periodProfit: pnl?.netProfit ?? 0 },
      tb: { ...base, included: onDate, rows: tbRows, periodProfit: tbProfit },
      bs: { ...base, included: onDate, rows: bsRows, periodProfit: pnl?.netProfit ?? 0 }
    }

    // Pair sides in this member's books: flows over the overlap of BOTH members' inclusion
    // windows (a sale before the acquisition or after the disposal is not inter-company), ageing.
    for (const p of group.pairs) {
      for (const [side, ledgerId, otherSlug] of [[p.memberA, p.ledgerAId, p.memberB], [p.memberB, p.ledgerBId, p.memberA]] as const) {
        if (side !== m.companySlug) continue
        const l = catMap.get(ledgerId)
        if (!l) continue
        const other = group.members.find((x) => x.companySlug === otherSlug)
        const oFrom = other ? inclusionFrom(other) : null, oTo = other?.includeTo ?? null
        const wf = maxDate(pf, oFrom), wt = minDate(pt, oTo)
        const tf = maxDate(tbFrom, oFrom), tt = minDate(to, oTo)
        const isBs = l.nature === 'asset' || l.nature === 'liability'
        if (isBs && (p.kind === 'sales_purchase' || p.kind === 'loan')) {
          const pnlFlows = pnlIn ? partyFlows(mdb, ledgerId, wf, wt, taxLedgers) : { flows: [], excluded: [] }
          const tbFlows = onDate ? partyFlows(mdb, ledgerId, tf, tt, taxLedgers) : { flows: [], excluded: [] }
          snap.flows.set(`${p.id}:${ledgerId}`, { pnl: pnlFlows.flows, tb: tbFlows.flows })
          if (pnlFlows.excluded.length) {
            warnings.push(`${name}: ${pnlFlows.excluded.length} voucher(s) with ${l.name} also involve other balance-sheet accounts, so their P&L lines were not treated as inter-company — check ${pnlFlows.excluded.slice(0, 5).join(', ')}${pnlFlows.excluded.length > 5 ? ', …' : ''}`)
          }
        } else if (!isBs) {
          const amountIn = (f: string, t: string): MemberFlow[] =>
            f <= t ? [{ ledgerId, amount: reports.pnlLedgerAmounts(mdb, f, t).amounts.get(ledgerId) ?? 0 }] : [{ ledgerId, amount: 0 }]
          snap.flows.set(`${p.id}:${ledgerId}`, { pnl: pnlIn ? amountIn(wf, wt) : [], tb: onDate ? amountIn(tf, tt) : [] })
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
  definitionChecks(group, snaps, warnings)
  const statement = (kind: StatementKind): StatementResult => {
    const pairs: PairInput[] = group.pairs.map((p) => ({
      id: p.id, kind: p.kind, a: { slug: p.memberA, ledgerId: p.ledgerAId }, b: { slug: p.memberB, ledgerId: p.ledgerBId },
      unrealisedMarginBp: p.unrealisedMarginBp,
      flowsA: snaps.get(p.memberA)?.flows.get(`${p.id}:${p.ledgerAId}`)?.[kind === 'tb' ? 'tb' : 'pnl'],
      flowsB: snaps.get(p.memberB)?.flows.get(`${p.id}:${p.ledgerBId}`)?.[kind === 'tb' ? 'tb' : 'pnl']
    }))
    const parentSlug = group.members.find((m) => m.role === 'parent')?.companySlug
    const input: StatementInput = {
      kind,
      members: group.members.map((m) => {
        const inp = snaps.get(m.companySlug)!.inputs[kind]
        return m.investmentCompanySlug && m.investmentCompanySlug !== parentSlug ? { ...inp, investmentLedgerId: null } : inp
      }),
      pairs,
      mappings: group.mappings.map(({ id: _id, ledgerName: _n, ...rest }) => rest), icTolerance: group.icTolerance, unrealisedMarginBp: group.unrealisedMarginBp
    }
    return consolidateStatement(input)
  }
  const tb = statement('tb'), pnl = statement('pnl'), bs = statement('bs')
  for (const w of [...bs.warnings, ...pnl.warnings, ...tb.warnings]) if (!warnings.includes(w)) warnings.push(w)
  return { tb, pnl, bs, snaps, warnings }
}

/** Stored ids point into other files: warn when one now names a different ledger, when the parent
 *  changed since the investment ledger was picked, and when "include from" ≠ the acquisition date. */
function definitionChecks(group: ConsolidationGroup, snaps: Map<string, MemberSnapshot>, warnings: string[]): void {
  const parent = group.members.find((m) => m.role === 'parent')
  const check = (slug: string, id: number, saved: string | null, what: string): void => {
    const snap = snaps.get(slug)
    if (!snap?.ok || saved == null) return
    const now = snap.names.get(id)
    if (now != null && now !== saved) warnings.push(`${snap.name}: ${what} was “${saved}” when saved and ledger #${id} is now “${now}” — check it`)
  }
  for (const m of group.members) {
    const label = snaps.get(m.companySlug)?.name ?? m.companySlug
    if (m.investmentLedgerId != null && parent) {
      if (m.investmentCompanySlug && m.investmentCompanySlug !== parent.companySlug) {
        warnings.push(`${label}: its investment ledger was picked in ${m.investmentCompanySlug}'s books, but the parent is now ${parent.companySlug} — pick it again`)
      } else {
        check(parent.companySlug, m.investmentLedgerId, m.investmentLedgerName, `the investment ledger for ${label}`)
      }
    }
    if (m.includeFrom && m.acquiredOn && m.includeFrom !== m.acquiredOn) {
      warnings.push(`${label}: included from ${m.includeFrom} but acquired on ${m.acquiredOn} — results are consolidated from ${m.includeFrom} (AS 21 para 22 uses the acquisition date)`)
    }
  }
  for (const p of group.pairs) {
    check(p.memberA, p.ledgerAId, p.ledgerAName, 'a pair ledger')
    check(p.memberB, p.ledgerBId, p.ledgerBName, 'a pair ledger')
  }
  for (const mp of group.mappings) if (mp.ledgerId != null) check(mp.companySlug, mp.ledgerId, mp.ledgerName, 'a mapped ledger')
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
