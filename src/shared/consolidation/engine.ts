/**
 * WP 6.5 — the consolidation engine (pure). One call per statement (trial balance, P&L, balance
 * sheet): member rows are mapped to group chart lines and added line by line (AS 21 para 13),
 * then the eliminations are posted as explicit entries — every entry lists its postings
 * (line, member, member ledger, amount), so each consolidated line drills down to the member rows
 * and eliminations that make it, and the reconciliation statement is just the entry list.
 *
 * Rules and their sources: ./sources.ts. Balance-sheet and trial-balance entries always net to
 * zero (a warning is raised if one ever does not); P&L entries net to their profit effect.
 */
import type { Nature } from '../domain'
import { normKey, shareOf, mulDiv, allocate } from './math'
import type {
  ComputedCode, ConsolLine, Elimination, EliminationPosting, LineSection, MemberInput, MemberLedger, MemberRow,
  PairInput, PairResult, StatementInput, StatementKind, StatementResult
} from './types'
import type { ConsolidationSourceId } from './sources'

const isBsNature = (n: Nature): boolean => n === 'asset' || n === 'liability'

// ---------------------------------------------------------------- group chart lines

interface Draft { def: LineDef; slug: string | null; ledgerId: number | null; ledgerName: string | null; amount: number }

interface LineDef { key: string; name: string; nature: Nature; gp: boolean; special: boolean; auto?: 'bs' | 'pnl' }

const COMPUTED_NAMES: Record<ComputedCode, string> = {
  opening_stock: 'Opening stock',
  closing_stock: 'Closing stock',
  tb_stock_opening: 'Stock-in-Hand (opening)',
  pnl_opening: 'Profit & Loss A/c (opening)',
  pnl_current: 'Profit & Loss A/c',
  opening_diff: 'Difference in opening balances'
}

export const SPECIAL_LINES = {
  unreconciledBal: { key: 'elim:unreconciled_bal', name: 'Unreconciled inter-company balances', nature: 'asset', gp: false, special: true, auto: 'bs' },
  roundingBal: { key: 'elim:rounding_bal', name: 'Inter-company balance differences (within tolerance)', nature: 'asset', gp: false, special: true, auto: 'bs' },
  unreconciledFlow: { key: 'elim:unreconciled_flow', name: 'Unreconciled inter-company transactions', nature: 'expense', gp: false, special: true, auto: 'pnl' },
  roundingFlow: { key: 'elim:rounding_flow', name: 'Inter-company transaction differences (within tolerance)', nature: 'expense', gp: false, special: true, auto: 'pnl' },
  goodwill: { key: 'elim:goodwill', name: 'Goodwill on consolidation', nature: 'asset', gp: false, special: true },
  capitalReserve: { key: 'elim:capital_reserve', name: 'Capital reserve on consolidation', nature: 'liability', gp: false, special: true },
  minorityInterest: { key: 'elim:minority_interest', name: 'Minority interest', nature: 'liability', gp: false, special: true },
  postAcq: { key: 'elim:post_acq', name: 'Group share of post-acquisition reserves', nature: 'liability', gp: false, special: true },
  minorityProfit: { key: 'elim:minority_profit', name: 'Minority interest in profit', nature: 'expense', gp: false, special: true },
  upsStock: { key: 'elim:ups_stock', name: 'Unrealised profit in stock (provision)', nature: 'asset', gp: false, special: true },
  upsExpense: { key: 'elim:ups_expense', name: 'Unrealised profit on inter-company stock', nature: 'expense', gp: true, special: true },
  associatesProfit: { key: 'elim:associates_profit', name: 'Share of profit of associates', nature: 'income', gp: false, special: true }
} as const satisfies Record<string, LineDef>

/** Line for a computed member row (stock, P&L A/c …) — never remapped. */
function computedLine(code: ComputedCode, nature: Nature, gp: boolean): LineDef {
  return { key: `computed:${code}`, name: COMPUTED_NAMES[code], nature, gp, special: false }
}

/**
 * The group chart line a member ledger maps to: a per-ledger override, else a group override on
 * the ledger's group or its nearest mapped ancestor, else (default) the ledger's own group by
 * name and nature — so like groups across members ("Sundry Debtors", "Sales Accounts") add up.
 */
export function lineForLedger(
  slug: string,
  ledger: Pick<MemberLedger, 'id' | 'groupName' | 'groupPath' | 'nature' | 'gp'>,
  mappings: StatementInput['mappings']
): LineDef {
  const own = mappings.filter((m) => m.companySlug === slug)
  const byLedger = own.find((m) => m.ledgerId === ledger.id)
  const path = ledger.groupPath.length ? ledger.groupPath : [ledger.groupName]
  let target = byLedger
  if (!target) {
    for (let i = path.length - 1; i >= 0 && !target; i--) {
      const g = normKey(path[i]!)
      target = own.find((m) => m.groupName != null && normKey(m.groupName) === g)
    }
  }
  if (target) {
    const nature = target.targetNature ?? ledger.nature
    return { key: `${nature}:${normKey(target.targetName)}`, name: target.targetName.trim(), nature, gp: nature === ledger.nature ? ledger.gp : false, special: false }
  }
  return { key: `${ledger.nature}:${normKey(ledger.groupName)}`, name: ledger.groupName, nature: ledger.nature, gp: ledger.gp, special: false }
}

function sectionOf(kind: StatementKind, line: Pick<ConsolLine, 'key' | 'nature' | 'gp'>): LineSection {
  if (kind !== 'pnl') return line.nature
  if (line.key === SPECIAL_LINES.minorityProfit.key) return 'appropriation'
  if (line.key === 'computed:opening_stock') return 'opening_stock'
  if (line.key === 'computed:closing_stock') return 'closing_stock'
  if (line.nature === 'expense' || line.nature === 'asset') return line.gp ? 'trading_expense' : 'indirect_expense'
  return line.gp ? 'trading_income' : 'indirect_income'
}

const SECTION_ORDER: LineSection[] = [
  'asset', 'liability', 'income', 'expense',
  'opening_stock', 'trading_expense', 'trading_income', 'closing_stock', 'indirect_expense', 'indirect_income', 'appropriation'
]

// ---------------------------------------------------------------- the run

export function consolidateStatement(input: StatementInput): StatementResult {
  const { kind } = input
  const warnings: string[] = []
  const lineMembers = input.members.filter((m) => m.role !== 'associate')
  const colOf = new Map(lineMembers.map((m, i) => [m.slug, i]))
  const memberOf = new Map(input.members.map((m) => [m.slug, m]))
  const lines = new Map<string, ConsolLine & { auto?: 'bs' | 'pnl' }>()
  const eliminations: Elimination[] = []
  const pairs: PairResult[] = []

  const lineOf = (def: LineDef): ConsolLine & { auto?: 'bs' | 'pnl' } => {
    let l = lines.get(def.key)
    if (!l) {
      l = {
        key: def.key, name: def.name, nature: def.nature, gp: def.gp, section: 'asset',
        perMember: lineMembers.map(() => 0), elimination: 0, consolidated: 0, sources: [], eliminationIds: [], special: def.special,
        ...(def.auto ? { auto: def.auto } : {})
      }
      lines.set(def.key, l)
    }
    return l
  }
  const defForRow = (m: MemberInput, row: Pick<MemberRow, 'ledgerId' | 'nature' | 'gp' | 'computed' | 'groupName'>): LineDef => {
    if (row.computed) return computedLine(row.computed, row.nature, row.gp)
    const led = m.ledgers.find((l) => l.id === row.ledgerId)
    return lineForLedger(m.slug, led ?? { id: row.ledgerId, groupName: row.groupName, groupPath: [row.groupName], nature: row.nature, gp: row.gp }, input.mappings)
  }

  // 1. line-by-line combination (AS 21 para 13)
  for (const m of lineMembers) {
    if (!m.included) continue
    const col = colOf.get(m.slug)!
    for (const row of m.rows) {
      if (row.amount === 0) continue
      const line = lineOf(defForRow(m, row))
      line.perMember[col]! += row.amount
      line.sources.push({ slug: m.slug, ledgerId: row.ledgerId, name: row.name, groupName: row.groupName, amount: row.amount })
    }
  }

  // ---- posting helpers
  const rowAmount = (m: MemberInput, ledgerId: number): number =>
    m.rows.filter((r) => r.ledgerId === ledgerId).reduce((s, r) => s + r.amount, 0)
  const ledgerName = (m: MemberInput, ledgerId: number): string =>
    m.ledgers.find((l) => l.id === ledgerId)?.name ?? m.rows.find((r) => r.ledgerId === ledgerId)?.name ?? `#${ledgerId}`
  const memberPosting = (m: MemberInput, ledgerId: number, amount: number): Draft => {
    const row = m.rows.find((r) => r.ledgerId === ledgerId)
    const led = m.ledgers.find((l) => l.id === ledgerId)
    const def = row ? defForRow(m, row) : led ? lineForLedger(m.slug, led, input.mappings) : null
    if (!def) throw new Error(`ledger ${ledgerId} not found in ${m.name}`)
    return { def, slug: m.slug, ledgerId, ledgerName: ledgerName(m, ledgerId), amount }
  }
  const computedPosting = (m: MemberInput, code: ComputedCode, ledgerId: number, nature: Nature, gp: boolean, amount: number): Draft => {
    const def = computedLine(code, nature, gp)
    return { def, slug: m.slug, ledgerId, ledgerName: COMPUTED_NAMES[code], amount }
  }
  const specialPosting = (def: LineDef, amount: number, m: MemberInput | null = null): Draft =>
    ({ def, slug: m?.slug ?? null, ledgerId: null, ledgerName: null, amount })

  let seq = 0
  const addEntry = (e: Omit<Elimination, 'id' | 'postings'> & { postings: Draft[] }): void => {
    const drafts = e.postings.filter((p) => p.amount !== 0)
    if (!drafts.length) return
    const id = `${kind}-${++seq}`
    const postings: EliminationPosting[] = drafts.map(({ def, ...p }) => {
      const line = lineOf(def)
      line.elimination += p.amount
      if (!line.eliminationIds.includes(id)) line.eliminationIds.push(id)
      return { lineKey: def.key, lineName: def.name, ...p }
    })
    if (kind !== 'pnl') {
      const net = postings.reduce((s, p) => s + p.amount, 0)
      if (net !== 0) warnings.push(`Elimination “${e.title}” does not balance by ${net} paise`)
    }
    eliminations.push({ ...e, id, postings })
  }

  // 2. inter-company pairs (AS 21 para 16)
  const usedBalance = new Set<string>()
  const usedFlow = new Set<string>()
  const pairFlowTotals = new Map<number, { seller: MemberInput; buyer: MemberInput; purchases: number; marginBp: number | null }>()
  const tol = Math.max(0, input.icTolerance)

  for (const pair of input.pairs) {
    const ma = memberOf.get(pair.a.slug)
    const mb = memberOf.get(pair.b.slug)
    const la = ma?.ledgers.find((l) => l.id === pair.a.ledgerId)
    const lb = mb?.ledgers.find((l) => l.id === pair.b.ledgerId)
    const skip = (note: string): void => {
      pairs.push({
        pairId: pair.id, kind: pair.kind, basis: 'balance',
        a: { slug: pair.a.slug, ledgerId: pair.a.ledgerId, ledgerName: la?.name ?? `#${pair.a.ledgerId}`, amount: 0 },
        b: { slug: pair.b.slug, ledgerId: pair.b.ledgerId, ledgerName: lb?.name ?? `#${pair.b.ledgerId}`, amount: 0 },
        difference: 0, status: 'skipped', note
      })
    }
    if (!ma || !mb) { skip('a side is not a member of the group'); continue }
    if (ma.role === 'associate' || mb.role === 'associate') { skip('pairs with associates are not eliminated (equity method)'); continue }
    if (!ma.included || !mb.included) { skip('a side is not consolidated in this period'); continue }
    if (!la || !lb) { skip('a ledger of this pair no longer exists'); continue }
    const bs = isBsNature(la.nature)
    if (bs !== isBsNature(lb.nature)) { skip('one side is a balance-sheet ledger, the other a P&L ledger'); continue }

    // -- balances: receivable / payable, loans
    if (bs && pair.kind !== 'sales_purchase' && kind !== 'pnl') {
      const ka = `${ma.slug}:${la.id}`, kb = `${mb.slug}:${lb.id}`
      if (usedBalance.has(ka) || usedBalance.has(kb)) {
        skip('a ledger of this pair is already eliminated by another pair')
        continue
      } else {
        usedBalance.add(ka); usedBalance.add(kb)
        const a = rowAmount(ma, la.id), b = rowAmount(mb, lb.id)
        const diff = a + b
        const status = Math.abs(diff) <= tol ? 'reconciled' : 'unreconciled'
        pairs.push({
          pairId: pair.id, kind: pair.kind, basis: 'balance',
          a: { slug: ma.slug, ledgerId: la.id, ledgerName: la.name, amount: a },
          b: { slug: mb.slug, ledgerId: lb.id, ledgerName: lb.name, amount: b },
          difference: diff, status
        })
        addEntry({
          rule: 'ic_balance', pairId: pair.id, status, source: 'as21-16',
          title: `Inter-company balance ${ma.name} ↔ ${mb.name}`,
          detail: `${la.name} (${ma.name}) against ${lb.name} (${mb.name})` +
            (diff === 0 ? ' — agree' : status === 'reconciled' ? ' — differ within tolerance' : ' — differ; the difference stays as unreconciled'),
          postings: [
            memberPosting(ma, la.id, -a), memberPosting(mb, lb.id, -b),
            specialPosting(status === 'reconciled' ? SPECIAL_LINES.roundingBal : SPECIAL_LINES.unreconciledBal, diff)
          ]
        })
      }
    }

    // -- flows: sales / purchases, interest
    const wantsFlow = bs ? pair.kind === 'sales_purchase' || pair.kind === 'loan' : true
    if (!wantsFlow) continue
    const flowsA = bs ? pair.flowsA ?? [] : [{ ledgerId: la.id, amount: rowAmount(ma, la.id) }]
    const flowsB = bs ? pair.flowsB ?? [] : [{ ledgerId: lb.id, amount: rowAmount(mb, lb.id) }]
    const fa = flowsA.reduce((s, f) => s + f.amount, 0)
    const fb = flowsB.reduce((s, f) => s + f.amount, 0)
    if (pair.kind === 'sales_purchase') {
      const [seller, buyer, bought] = fa < 0 && fb > 0 ? [ma, mb, fb] : fb < 0 && fa > 0 ? [mb, ma, fa] : [null, null, 0]
      if (seller && buyer) pairFlowTotals.set(pair.id, { seller, buyer, purchases: bought, marginBp: pair.unrealisedMarginBp ?? input.unrealisedMarginBp })
    }
    if (kind === 'bs' || (bs && fa === 0 && fb === 0 && !flowsA.length && !flowsB.length)) continue
    const flowKeys = [...flowsA.map((f) => `${ma.slug}:${f.ledgerId}:${pair.a.ledgerId}`), ...flowsB.map((f) => `${mb.slug}:${f.ledgerId}:${pair.b.ledgerId}`)]
    if (flowKeys.some((k) => usedFlow.has(k))) {
      skip('these transactions are already eliminated by another pair')
      continue
    }
    flowKeys.forEach((k) => usedFlow.add(k))
    const diff = fa + fb
    const status = Math.abs(diff) <= tol ? 'reconciled' : 'unreconciled'
    pairs.push({
      pairId: pair.id, kind: pair.kind, basis: 'flow',
      a: { slug: ma.slug, ledgerId: la.id, ledgerName: la.name, amount: fa },
      b: { slug: mb.slug, ledgerId: lb.id, ledgerName: lb.name, amount: fb },
      difference: diff, status
    })
    addEntry({
      rule: 'ic_flow', pairId: pair.id, status, source: 'as21-16',
      title: `Inter-company ${pair.kind === 'loan' ? 'interest' : pair.kind === 'sales_purchase' ? 'sales / purchases' : 'transactions'} ${ma.name} ↔ ${mb.name}`,
      detail: (bs ? `P&L lines of vouchers with ${la.name} (${ma.name}) and ${lb.name} (${mb.name})` : `${la.name} (${ma.name}) against ${lb.name} (${mb.name})`) +
        (diff === 0 ? ' — agree' : status === 'reconciled' ? ' — differ within tolerance' : ' — differ; the difference stays as unreconciled'),
      postings: [
        ...flowsA.map((f) => memberPosting(ma, f.ledgerId, -f.amount)),
        ...flowsB.map((f) => memberPosting(mb, f.ledgerId, -f.amount)),
        specialPosting(status === 'reconciled' ? SPECIAL_LINES.roundingFlow : SPECIAL_LINES.unreconciledFlow, diff)
      ]
    })
  }

  // 3. unrealised profit in the buyer's closing stock (optional)
  for (const [pairId, t] of pairFlowTotals) {
    if (!t.marginBp || t.marginBp <= 0) continue
    if (t.buyer.purchases <= 0 || t.buyer.closingStock <= 0) continue
    const held = Math.min(t.buyer.closingStock, mulDiv(t.buyer.closingStock, t.purchases, t.buyer.purchases))
    const ups = shareOf(held, t.marginBp)
    if (ups === 0) continue
    const postings: Draft[] =
      kind === 'pnl'
        ? [computedPosting(t.buyer, 'closing_stock', -2, 'income', true, ups)]
        : kind === 'bs'
          ? [specialPosting(SPECIAL_LINES.upsStock, -ups, t.buyer), computedPosting(t.seller, 'pnl_current', -3, 'liability', false, ups)]
          : [specialPosting(SPECIAL_LINES.upsStock, -ups, t.buyer), specialPosting(SPECIAL_LINES.upsExpense, ups, t.seller)]
    addEntry({
      rule: 'unrealised_profit', pairId, source: 'ups-estimate',
      title: `Unrealised profit in ${t.buyer.name}'s closing stock`,
      detail: `Closing stock ${t.buyer.closingStock} × inter-company purchases ${t.purchases} ÷ purchases ${t.buyer.purchases} = ${held} held; × margin ${(t.marginBp / 100).toFixed(2)} %`,
      postings
    })
  }

  // 4. investment vs equity, minority interest (AS 21 para 13), associates (AS 23)
  const parent = input.members.find((m) => m.role === 'parent')
  for (const m of input.members) {
    if (m.role === 'parent' || !m.included) continue
    const p = m.ownershipBp
    const invId = m.investmentLedgerId
    const invOk = invId != null && parent?.included && parent.ledgers.some((l) => l.id === invId)
    if (invId != null && !invOk) warnings.push(`${m.name}: the investment ledger was not found in the parent's books — goodwill not computed`)

    if (m.role === 'associate') {
      const current = shareOf(m.periodProfit, p)
      if (kind === 'pnl') {
        addEntry({
          rule: 'associate', memberSlug: m.slug, source: 'as23-equity', title: `Share of profit of ${m.name} (associate)`,
          detail: `${(p / 100).toFixed(2)} % of its profit for the period`,
          postings: [specialPosting(SPECIAL_LINES.associatesProfit, -current, m)]
        })
      } else if (invOk && m.acquisitionEquity != null) {
        const total = shareOf(m.equityNow - m.acquisitionEquity, p)
        addEntry({
          rule: 'associate', memberSlug: m.slug, source: 'as23-equity', title: `Equity-method carrying amount of ${m.name} (associate)`,
          detail: `${(p / 100).toFixed(2)} % of its equity movement since acquisition added to the investment`,
          postings: [
            memberPosting(parent!, invId!, total),
            ...(kind === 'tb'
              ? [specialPosting(SPECIAL_LINES.associatesProfit, -current, m), specialPosting(SPECIAL_LINES.postAcq, -(total - current), m)]
              : [specialPosting(SPECIAL_LINES.postAcq, -total, m)])
          ]
        })
      } else {
        warnings.push(`${m.name} (associate): set its investment ledger and equity at acquisition to carry it at equity in the ${kind === 'tb' ? 'trial balance' : 'balance sheet'}`)
      }
      continue
    }

    // subsidiary
    const minorityBp = 10000 - p
    if (kind === 'pnl' || kind === 'tb') {
      const mp = m.periodProfit - shareOf(m.periodProfit, p)
      if (mp !== 0) {
        addEntry({
          rule: 'minority_profit', memberSlug: m.slug, source: 'as21-13d', title: `Minority share of ${m.name}'s profit`,
          detail: `${(minorityBp / 100).toFixed(2)} % of its profit for the period`,
          postings: kind === 'pnl'
            ? [specialPosting(SPECIAL_LINES.minorityProfit, mp, m)]
            : [specialPosting(SPECIAL_LINES.minorityProfit, mp, m), specialPosting(SPECIAL_LINES.minorityInterest, -mp, m)]
        })
      }
    }
    if (kind === 'pnl') continue

    const eqRows = m.rows.filter((r) => r.equity && r.amount !== 0)
    const eqTotal = -eqRows.reduce((s, r) => s + r.amount, 0)
    const mi = eqTotal - shareOf(eqTotal, p)
    const eqPostings = (fraction: 'all' | number): Draft[] => {
      if (fraction === 'all') return eqRows.map((r) => (r.computed ? computedPosting(m, r.computed, r.ledgerId, r.nature, r.gp, -r.amount) : memberPosting(m, r.ledgerId, -r.amount)))
      const parts = allocate(fraction, eqRows.map((r) => r.amount))
      return eqRows.map((r, i) => (r.computed ? computedPosting(m, r.computed, r.ledgerId, r.nature, r.gp, parts[i]!) : memberPosting(m, r.ledgerId, parts[i]!)))
    }

    if (invOk && m.acquisitionEquity != null) {
      const cost = rowAmount(parent!, invId!)
      const parentShareE = shareOf(m.acquisitionEquity, p)
      const gw = cost - parentShareE
      const postAcq = eqTotal - mi - parentShareE
      if (cost === 0) warnings.push(`${m.name}: the investment ledger has no balance on this date`)
      const src: ConsolidationSourceId = gw >= 0 ? 'as21-13ab' : 'as21-13c'
      addEntry({
        rule: 'investment', memberSlug: m.slug, source: src,
        title: `Investment in ${m.name} against its equity`,
        detail: `Cost ${cost}; ${(p / 100).toFixed(2)} % of equity at acquisition ${m.acquisitionEquity} = ${parentShareE}; ` +
          (gw >= 0 ? `goodwill ${gw}` : `capital reserve ${-gw}`) + (minorityBp ? `; minority ${(minorityBp / 100).toFixed(2)} % of equity ${eqTotal} = ${mi}` : ''),
        postings: [
          ...eqPostings('all'),
          memberPosting(parent!, invId!, -cost),
          specialPosting(gw >= 0 ? SPECIAL_LINES.goodwill : SPECIAL_LINES.capitalReserve, gw, m),
          specialPosting(SPECIAL_LINES.postAcq, -postAcq, m),
          specialPosting(SPECIAL_LINES.minorityInterest, -mi, m)
        ]
      })
    } else {
      if (invId == null) warnings.push(`${m.name}: no investment ledger set — investment vs equity (goodwill / capital reserve) not eliminated`)
      else if (invOk && m.acquisitionEquity == null) warnings.push(`${m.name}: equity at acquisition unknown — goodwill not computed`)
      if (mi !== 0) {
        addEntry({
          rule: 'minority_interest', memberSlug: m.slug, source: 'as21-13e', title: `Minority interest in ${m.name}`,
          detail: `${(minorityBp / 100).toFixed(2)} % of its equity ${eqTotal}`,
          postings: [...eqPostings(mi), specialPosting(SPECIAL_LINES.minorityInterest, -mi, m)]
        })
      }
    }
  }

  // 5. finish lines
  const out: ConsolLine[] = []
  for (const l of lines.values()) {
    l.consolidated = l.perMember.reduce((s, v) => s + v, 0) + l.elimination
    if (l.auto === 'bs') l.nature = l.consolidated >= 0 ? 'asset' : 'liability'
    if (l.auto === 'pnl') {
      if (kind === 'pnl') l.nature = l.consolidated >= 0 ? 'expense' : 'income'
    }
    if (kind === 'pnl' && isBsNature(l.nature) && !l.key.startsWith('computed:')) continue
    if (kind === 'bs' && !isBsNature(l.nature)) continue
    const { auto: _auto, ...line } = l
    if (line.consolidated === 0 && line.elimination === 0 && line.perMember.every((v) => v === 0)) continue
    out.push({ ...line, section: sectionOf(kind, line) })
  }
  out.sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section) || Number(a.special) - Number(b.special) || a.name.localeCompare(b.name))

  const sumBy = (pick: (l: ConsolLine) => number, ls = out): number => ls.reduce((s, l) => s + pick(l), 0)
  const result: StatementResult = {
    kind,
    members: lineMembers.map((m) => ({ slug: m.slug, name: m.name, role: m.role, ownershipBp: m.ownershipBp, included: m.included })),
    lines: out,
    eliminations,
    pairs,
    totals: {
      perMember: lineMembers.map((_, i) => sumBy((l) => l.perMember[i]!)),
      elimination: sumBy((l) => l.elimination),
      consolidated: sumBy((l) => l.consolidated)
    },
    warnings
  }
  if (kind === 'pnl') {
    const pl = out.filter((l) => l.section !== 'appropriation')
    const netProfit = -sumBy((l) => l.consolidated, pl)
    const minorityInterest = sumBy((l) => l.consolidated, out.filter((l) => l.section === 'appropriation'))
    result.profit = { perMember: lineMembers.map((_, i) => -sumBy((l) => l.perMember[i]!, pl)), netProfit, minorityInterest, ownersProfit: netProfit - minorityInterest }
  }
  if (kind === 'bs') {
    result.balance = {
      assets: sumBy((l) => l.consolidated, out.filter((l) => l.nature === 'asset')),
      liabilities: -sumBy((l) => l.consolidated, out.filter((l) => l.nature === 'liability'))
    }
  }
  if (input.members.filter((m) => m.role === 'parent').length !== 1) warnings.push('A group needs exactly one parent')
  return result
}
