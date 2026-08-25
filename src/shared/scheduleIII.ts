/**
 * Schedule III presentation of the Balance Sheet and the Statement of Profit and Loss
 * (roadmap #363).
 *
 * A company does not get to present its accounts in whatever shape its ledger groups happen to
 * be. Schedule III to the Companies Act 2013 fixes the face of the balance sheet and of the
 * statement of profit and loss, and an auditor will not sign anything else. What the books hold
 * is a Tally-style group tree; what has to be presented is fifteen prescribed lines. This is the
 * mapping between them.
 *
 * It is a VIEW, not a second set of numbers. Every rupee comes from the same `voucher_lines` the
 * ordinary balance sheet is built from, and the two totals are asserted to agree — a Schedule III
 * face that quietly differs from the trial balance would be worse than no Schedule III at all.
 *
 * ---------------------------------------------------------------------------------------------
 * CHECKED AGAINST (August 2026):
 *   - Schedule III to the Companies Act 2013, DIVISION I (companies whose financial statements
 *     are drawn up in accordance with the Companies (Accounting Standards) Rules — i.e. not
 *     Ind AS). Division II (Ind AS) and Division III (NBFCs) are NOT modelled: they have a
 *     different face, and a small business on this app is a Division I filer.
 *   - The trade-payables split between micro and small enterprises and others, required on the
 *     face since the MCA amendment of 24 March 2021. This is the same MSME classification section
 *     43B(h) uses (roadmap #351), which is why it can be produced at all.
 *   - The ageing schedules for trade receivables and trade payables introduced by the same 2021
 *     amendment are NOT produced here. They are notes rather than the face, the app already has
 *     an ageing report, and stapling one to the other without checking the prescribed buckets
 *     would produce a schedule that looks official and is not.
 *
 * ---------------------------------------------------------------------------------------------
 * WHERE THIS IS A JUDGEMENT AND NOT A FACT.
 *
 * Three mappings the books genuinely cannot make on their own, all stated on the output rather
 * than hidden:
 *
 *   1. CURRENT VERSUS NON-CURRENT. Schedule III splits borrowings, provisions, loans and advances
 *      by whether they fall due within twelve months. A ledger balance does not carry that fact.
 *      Secured and unsecured loans are presented as non-current and the current maturities are
 *      left for the preparer to reclassify — which is the conventional starting point and is
 *      said out loud on the line.
 *   2. THE EXPENSE HEADS. Schedule III wants employee benefits expense, finance costs and
 *      depreciation named separately, with everything else in "Other expenses". Nothing in the
 *      group tree distinguishes them, so they are detected by ledger name and every line lists
 *      the ledgers it drew from. A wrong one is visible rather than silent.
 *   3. CAPITAL. "Capital Account" is share capital in a company and partners' capital in a firm.
 *      Schedule III is written for the first; the line says which it assumed.
 */

import type { BalanceSheet, ProfitAndLoss, StatementNode } from './reports'

export interface ScheduleIIILine {
  /** Stable key — used by tests and by the UI, never shown. */
  key: string
  label: string
  /** 0 = the numbered head, 1 = the lettered line, 2 = the roman sub-line. */
  level: number
  amount: number
  /** Group or ledger names folded into this line, so any figure can be traced back. */
  sources: string[]
  /** Said on the line when the mapping was a judgement. See the header. */
  note?: string
}

export interface ScheduleIIIBalanceSheet {
  asOn: string
  equityAndLiabilities: ScheduleIIILine[]
  assets: ScheduleIIILine[]
  totalEquityAndLiabilities: number
  totalAssets: number
  /**
   * Balances no Schedule III line claims.
   *
   * Kept as a line of its own rather than dropped. A suspense balance or a home-made root group
   * has to appear somewhere or the face will not tie, and a face that does not tie is the one
   * failure this report must never have.
   */
  unmapped: ScheduleIIILine[]
  /** totalEquityAndLiabilities === totalAssets. False means something needs a person. */
  balanced: boolean
  /** Judgements made — shown above the statement. */
  caveats: string[]
}

export interface ScheduleIIIProfitAndLoss {
  from: string
  to: string
  lines: ScheduleIIILine[]
  revenue: number
  totalIncome: number
  totalExpenses: number
  profitBeforeTax: number
  caveats: string[]
}

// ---------- the mapping ----------

/**
 * Group name → Schedule III line, most specific first.
 *
 * Keyed on the seeded group names (see src/shared/seed.ts). A user-created group inherits its
 * parent's mapping by walking up the tree; one with no mapped ancestor lands in `unmapped`, which
 * is the honest answer and shows up on the face.
 */
const LIABILITY_MAP: { group: string; key: string; note?: string }[] = [
  { group: 'Reserves & Surplus', key: 'reserves' },
  {
    group: 'Capital Account',
    key: 'shareCapital',
    note: 'Presented as share capital. In a firm or a proprietorship this is partners’ or proprietor’s capital, which Schedule III does not contemplate.'
  },
  { group: 'Bank OD A/c', key: 'shortBorrowings', note: 'An overdraft is repayable on demand, so it is presented as a short-term borrowing.' },
  {
    group: 'Secured Loans',
    key: 'longBorrowings',
    note: 'Presented as non-current in full. Instalments falling due within twelve months have to be reclassified to "Other current liabilities" by the preparer — the books do not hold the repayment schedule.'
  },
  {
    group: 'Unsecured Loans',
    key: 'longBorrowings',
    note: 'Presented as non-current in full — see the note on secured loans.'
  },
  { group: 'Sundry Creditors', key: 'tradePayables' },
  { group: 'Duties & Taxes', key: 'otherCurrentLiabilities' },
  { group: 'Provisions', key: 'shortProvisions', note: 'Presented as short-term. A gratuity or leave provision that is not payable within twelve months is long-term.' },
  { group: 'Current Liabilities', key: 'otherCurrentLiabilities' },
  { group: 'Loans (Liability)', key: 'longBorrowings' },
  { group: 'Branch / Divisions', key: 'otherCurrentLiabilities', note: 'A branch or division balance is an internal account; it should be eliminated on consolidation rather than presented.' },
  { group: 'Suspense A/c', key: 'otherCurrentLiabilities', note: 'A suspense balance is not a Schedule III line. It has to be cleared before the accounts are signed.' }
]

const ASSET_MAP: { group: string; key: string; note?: string }[] = [
  { group: 'Fixed Assets', key: 'ppe', note: 'Net block. The gross block, additions, disposals and accumulated depreciation belong in the fixed asset note — see the asset register.' },
  { group: 'Investments', key: 'nonCurrentInvestments', note: 'Presented as non-current. Investments intended to be realised within twelve months are current.' },
  { group: 'Stock-in-Hand', key: 'inventories' },
  { group: 'Sundry Debtors', key: 'tradeReceivables' },
  { group: 'Cash-in-Hand', key: 'cash' },
  { group: 'Bank Accounts', key: 'cash' },
  { group: 'Deposits (Asset)', key: 'longLoansAdvances', note: 'Security and other deposits presented as long-term loans and advances.' },
  { group: 'Loans & Advances (Asset)', key: 'shortLoansAdvances' },
  { group: 'Current Assets', key: 'otherCurrentAssets' },
  { group: 'Misc. Expenses (ASSET)', key: 'otherNonCurrentAssets', note: 'Unamortised expenditure. Schedule III no longer contemplates a separate "Miscellaneous expenditure" head.' }
]

interface Bucket {
  amount: number
  sources: string[]
  notes: Set<string>
}

const emptyBucket = (): Bucket => ({ amount: 0, sources: [], notes: new Set() })

/**
 * Walk a statement tree to its LEAVES, assigning each to the nearest mapped group above it.
 *
 * Leaves rather than mapped subtrees, and nearest rather than highest, for the same reason: the
 * seeded tree nests mapped groups inside mapped groups. "Current Assets" maps to other current
 * assets, but "Bank Accounts" sits under it and maps to cash — taking the whole subtree at the
 * first match would put every bank balance under "other". Descending to leaves also guarantees
 * the arithmetic: the leaves of a tree sum to the tree, so the Schedule III face cannot silently
 * differ from the balance sheet it was built from.
 *
 * A user's own sub-group inherits: "Trade Creditors — Local" under Sundry Creditors is trade
 * payables, because the nearest mapping above its ledgers is the one on Sundry Creditors.
 */
function collect(
  nodes: StatementNode[],
  map: { group: string; key: string; note?: string }[],
  buckets: Map<string, Bucket>,
  unmapped: Bucket,
  inherited: { group: string; key: string; note?: string } | null
): void {
  for (const node of nodes) {
    const rule = map.find((m) => m.group.toLowerCase() === node.name.toLowerCase()) ?? inherited
    if (node.children.length > 0) {
      collect(node.children, map, buckets, unmapped, rule)
      continue
    }
    if (!rule) {
      unmapped.amount += node.amount
      unmapped.sources.push(node.name)
      continue
    }
    const bucket = buckets.get(rule.key) ?? emptyBucket()
    bucket.amount += node.amount
    if (!bucket.sources.includes(rule.group)) bucket.sources.push(rule.group)
    if (rule.note) bucket.notes.add(rule.note)
    buckets.set(rule.key, bucket)
  }
}

function lineFrom(key: string, label: string, level: number, buckets: Map<string, Bucket>): ScheduleIIILine {
  const b = buckets.get(key) ?? emptyBucket()
  const line: ScheduleIIILine = { key, label, level, amount: b.amount, sources: b.sources }
  if (b.notes.size > 0) line.note = [...b.notes].join(' ')
  return line
}

export interface ScheduleIIIExtras {
  /**
   * Trade payables owed to micro and small enterprises, from the MSME classification on the party
   * ledgers (roadmap #351). The 2021 amendment requires this split ON THE FACE. Null when nothing
   * has been classified, which is a different statement from zero and is presented as such.
   */
  msmeTradePayables: number | null
  /** Profit for the period, from the P&L. Sits under Reserves and surplus. */
  profitForPeriod: number
}

/**
 * The Schedule III face of the balance sheet.
 *
 * Sign convention: `BalanceSheet` already presents liabilities credit-positive and assets
 * debit-positive, so both sides read positive here and no flipping is needed.
 */
export function scheduleIIIBalanceSheet(bs: BalanceSheet, extras: ScheduleIIIExtras): ScheduleIIIBalanceSheet {
  const liabilityBuckets = new Map<string, Bucket>()
  const assetBuckets = new Map<string, Bucket>()
  const unmappedLiab = emptyBucket()
  const unmappedAsset = emptyBucket()

  collect(bs.liabilities, LIABILITY_MAP, liabilityBuckets, unmappedLiab, null)
  collect(bs.assets, ASSET_MAP, assetBuckets, unmappedAsset, null)

  // The period's profit rides into reserves, exactly as the ordinary balance sheet does it. The
  // computed 'Profit & Loss A/c' node has no group name and therefore lands in `unmapped`, so it
  // is moved rather than added — otherwise it would count twice.
  const plIndex = unmappedLiab.sources.indexOf('Profit & Loss A/c')
  if (plIndex >= 0) {
    unmappedLiab.sources.splice(plIndex, 1)
    unmappedLiab.amount -= extras.profitForPeriod
    const reserves = liabilityBuckets.get('reserves') ?? emptyBucket()
    reserves.amount += extras.profitForPeriod
    reserves.sources.push('Profit & Loss A/c')
    liabilityBuckets.set('reserves', reserves)
  }

  const caveats: string[] = []
  const eql: ScheduleIIILine[] = [
    { key: 'shareholdersFunds', label: 'Shareholders’ funds', level: 0, amount: 0, sources: [] },
    lineFrom('shareCapital', 'Share capital', 1, liabilityBuckets),
    lineFrom('reserves', 'Reserves and surplus', 1, liabilityBuckets),
    { key: 'nonCurrentLiabilities', label: 'Non-current liabilities', level: 0, amount: 0, sources: [] },
    lineFrom('longBorrowings', 'Long-term borrowings', 1, liabilityBuckets),
    { key: 'currentLiabilities', label: 'Current liabilities', level: 0, amount: 0, sources: [] },
    lineFrom('shortBorrowings', 'Short-term borrowings', 1, liabilityBuckets),
    lineFrom('tradePayables', 'Trade payables', 1, liabilityBuckets),
    lineFrom('otherCurrentLiabilities', 'Other current liabilities', 1, liabilityBuckets),
    lineFrom('shortProvisions', 'Short-term provisions', 1, liabilityBuckets)
  ]

  // The face split required since March 2021. Presented only when somebody has actually
  // classified suppliers: "we have not classified our suppliers" and "we owe nothing to a micro
  // or small enterprise" are different statements and must not be printed as the same one.
  const payables = eql.find((l) => l.key === 'tradePayables')!
  if (extras.msmeTradePayables !== null) {
    const micro = extras.msmeTradePayables
    const others = payables.amount - micro
    eql.splice(eql.indexOf(payables) + 1, 0,
      { key: 'tradePayablesMsme', label: '(i) total outstanding dues of micro and small enterprises', level: 2, amount: micro, sources: [] },
      { key: 'tradePayablesOthers', label: '(ii) total outstanding dues of creditors other than micro and small enterprises', level: 2, amount: others, sources: [] }
    )
  } else if (payables.amount !== 0) {
    caveats.push(
      'Trade payables are not split between micro and small enterprises and others. That split has been required on ' +
        'the face since 24 March 2021 — classify the supplier ledgers under Udyam to produce it.'
    )
  }

  const assets: ScheduleIIILine[] = [
    { key: 'nonCurrentAssets', label: 'Non-current assets', level: 0, amount: 0, sources: [] },
    lineFrom('ppe', 'Property, plant and equipment and intangible assets', 1, assetBuckets),
    lineFrom('nonCurrentInvestments', 'Non-current investments', 1, assetBuckets),
    lineFrom('longLoansAdvances', 'Long-term loans and advances', 1, assetBuckets),
    lineFrom('otherNonCurrentAssets', 'Other non-current assets', 1, assetBuckets),
    { key: 'currentAssets', label: 'Current assets', level: 0, amount: 0, sources: [] },
    lineFrom('inventories', 'Inventories', 1, assetBuckets),
    lineFrom('tradeReceivables', 'Trade receivables', 1, assetBuckets),
    lineFrom('cash', 'Cash and cash equivalents', 1, assetBuckets),
    lineFrom('shortLoansAdvances', 'Short-term loans and advances', 1, assetBuckets),
    lineFrom('otherCurrentAssets', 'Other current assets', 1, assetBuckets)
  ]

  const sumUnder = (lines: ScheduleIIILine[], headKey: string): number => {
    const start = lines.findIndex((l) => l.key === headKey)
    let total = 0
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i] as ScheduleIIILine
      if (l.level === 0) break
      if (l.level === 1) total += l.amount
    }
    return total
  }
  for (const head of ['shareholdersFunds', 'nonCurrentLiabilities', 'currentLiabilities']) {
    const line = eql.find((l) => l.key === head)!
    line.amount = sumUnder(eql, head)
  }
  for (const head of ['nonCurrentAssets', 'currentAssets']) {
    const line = assets.find((l) => l.key === head)!
    line.amount = sumUnder(assets, head)
  }

  const unmapped: ScheduleIIILine[] = []
  if (unmappedLiab.amount !== 0 || unmappedLiab.sources.length > 0) {
    unmapped.push({
      key: 'unmappedLiabilities',
      label: 'Liabilities with no Schedule III line',
      level: 1,
      amount: unmappedLiab.amount,
      sources: unmappedLiab.sources,
      note: 'These have to be classified before the accounts can be presented.'
    })
  }
  if (unmappedAsset.amount !== 0 || unmappedAsset.sources.length > 0) {
    unmapped.push({
      key: 'unmappedAssets',
      label: 'Assets with no Schedule III line',
      level: 1,
      amount: unmappedAsset.amount,
      sources: unmappedAsset.sources,
      note: 'These have to be classified before the accounts can be presented.'
    })
  }

  const totalEquityAndLiabilities =
    eql.filter((l) => l.level === 0).reduce((s, l) => s + l.amount, 0) + unmappedLiab.amount
  const totalAssets = assets.filter((l) => l.level === 0).reduce((s, l) => s + l.amount, 0) + unmappedAsset.amount

  if (eql.some((l) => l.note)) caveats.push('Current/non-current splits marked on the lines below are the conventional starting point, not a fact from the books.')

  return {
    asOn: bs.asOn,
    equityAndLiabilities: eql,
    assets,
    totalEquityAndLiabilities,
    totalAssets,
    unmapped,
    balanced: totalEquityAndLiabilities === totalAssets,
    caveats
  }
}

// ---------- the statement of profit and loss ----------

/**
 * Ledger-name patterns for the three expense heads Schedule III names separately.
 *
 * A heuristic, and labelled as one wherever its output appears. The alternative — asking every
 * user to map every expense ledger before they can see the statement — is how a feature ends up
 * unused. Every line carries the ledgers it matched, so a misfile is visible on the face.
 */
const EXPENSE_PATTERNS: { key: string; label: string; patterns: RegExp[] }[] = [
  {
    key: 'employeeBenefits',
    label: 'Employee benefits expense',
    patterns: [/salar/i, /\bwage/i, /bonus/i, /gratuity/i, /provident/i, /\bpf\b/i, /\besi\b/i, /staff welfare/i, /leave encash/i]
  },
  {
    key: 'financeCosts',
    label: 'Finance costs',
    patterns: [/interest/i, /bank charge/i, /finance (cost|charge)/i, /processing fee/i]
  },
  {
    key: 'depreciation',
    label: 'Depreciation and amortisation expense',
    patterns: [/deprecia/i, /amorti[sz]/i]
  }
]

function classifyExpense(name: string): string {
  for (const head of EXPENSE_PATTERNS) {
    if (head.patterns.some((p) => p.test(name))) return head.key
  }
  return 'otherExpenses'
}

/** Every leaf under a tree, with its own name — the granularity the expense heuristic needs. */
function leaves(nodes: StatementNode[]): { name: string; amount: number }[] {
  const out: { name: string; amount: number }[] = []
  for (const n of nodes) {
    if (n.children.length === 0) out.push({ name: n.name, amount: n.amount })
    else out.push(...leaves(n.children))
  }
  return out
}

/**
 * The Schedule III face of the statement of profit and loss.
 *
 * "Changes in inventories" is opening stock less closing stock, which is the same figure the
 * trading account arrives at from the other direction — presenting it as a change rather than as
 * two lines is the whole difference between the Tally face and the Schedule III one.
 */
export function scheduleIIIProfitAndLoss(pnl: ProfitAndLoss): ScheduleIIIProfitAndLoss {
  const revenue = sumNodes(pnl.tradingIncomes)
  const otherIncome = sumNodes(pnl.indirectIncomes)
  const purchases = sumNodes(pnl.tradingExpenses)
  const changeInInventories = pnl.openingStock - pnl.closingStock

  const buckets = new Map<string, { amount: number; sources: string[] }>()
  for (const leaf of leaves(pnl.indirectExpenses)) {
    const key = classifyExpense(leaf.name)
    const b = buckets.get(key) ?? { amount: 0, sources: [] }
    b.amount += leaf.amount
    b.sources.push(leaf.name)
    buckets.set(key, b)
  }

  const lines: ScheduleIIILine[] = [
    { key: 'revenue', label: 'I. Revenue from operations', level: 0, amount: revenue, sources: pnl.tradingIncomes.map((n) => n.name) },
    { key: 'otherIncome', label: 'II. Other income', level: 0, amount: otherIncome, sources: pnl.indirectIncomes.map((n) => n.name) },
    { key: 'totalIncome', label: 'III. Total income', level: 0, amount: revenue + otherIncome, sources: [] },
    { key: 'expenses', label: 'IV. Expenses', level: 0, amount: 0, sources: [] },
    {
      key: 'purchases',
      label: 'Purchases of stock-in-trade',
      level: 1,
      amount: purchases,
      sources: pnl.tradingExpenses.map((n) => n.name),
      note: 'A manufacturer presents this as "Cost of materials consumed" instead. The books do not distinguish the two.'
    },
    { key: 'changeInInventories', label: 'Changes in inventories of finished goods, work-in-progress and stock-in-trade', level: 1, amount: changeInInventories, sources: [] }
  ]

  for (const head of EXPENSE_PATTERNS) {
    const b = buckets.get(head.key)
    if (!b || b.amount === 0) continue
    lines.push({
      key: head.key,
      label: head.label,
      level: 1,
      amount: b.amount,
      sources: b.sources,
      note: 'Classified from the ledger name. Check the ledgers listed against this head.'
    })
  }
  const other = buckets.get('otherExpenses') ?? { amount: 0, sources: [] }
  lines.push({ key: 'otherExpenses', label: 'Other expenses', level: 1, amount: other.amount, sources: other.sources })

  const totalExpenses = lines.filter((l) => l.level === 1).reduce((s, l) => s + l.amount, 0)
  lines.find((l) => l.key === 'expenses')!.amount = totalExpenses
  const profitBeforeTax = revenue + otherIncome - totalExpenses
  lines.push({ key: 'profitBeforeTax', label: 'V. Profit before tax', level: 0, amount: profitBeforeTax, sources: [] })

  const caveats = [
    'Employee benefits, finance costs and depreciation are picked out of indirect expenses by ledger name. Every line lists what it matched.',
    'Tax expense, exceptional items and earnings per share are not derived from the books and have to be added by the preparer.'
  ]

  return { from: pnl.period.from, to: pnl.period.to, lines, revenue, totalIncome: revenue + otherIncome, totalExpenses, profitBeforeTax, caveats }
}

function sumNodes(nodes: StatementNode[]): number {
  return nodes.reduce((s, n) => s + n.amount, 0)
}
