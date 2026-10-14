// Ask Total — answers (WP 10.1, plan 2026-10-13 §5). Deterministic: the classifier
// (classify.ts) picks the intent, and every figure comes from the EXISTING read service the
// matching screen uses — never a second computation:
//   who owes / what I owe     analysis.outstandingsWithAdvances + home.ts owedSummary (= Home's tile)
//   one person                the same Outstandings allocation, that party's row
//   GST due                   simpleHome → dashboard.dashGst (= Home's GST tile), Why? sentences
//   profit / sales / …        reports.profitAndLoss (→ pnlLedgerAmounts) for the period
//   cash / bank               simpleHome's cash (= reports.closingBalances for those ledgers)
//   stock                     simpleStock.stockList (= stockAnalysis.stockSummary rows)
// Sentences are templates (t(), assist.* keys, the Home's "Why?" sentences where they say it);
// money only through money.ts. Names go through the search service (names.ts). Nothing here
// talks to a model or the network.
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { AiSource } from '@shared/ai'
import type { AssistAnswer, AssistChoice, AssistFigure, AssistHowTo, AssistIntent, AssistLink, AssistPeriod, AssistTarget } from '@shared/assist'
import type { StatementNode } from '@shared/reports'
import { translator, type Language, type MessageKey, type Translate } from '@shared/i18n'
import { formatPaise, formatQtyMilli } from '@shared/money'
import { toMonthLabel, toPlainDate } from '@shared/dates'
import { owedSummary } from '@shared/simple/home'
import { cashWhy, collectedWhy, money, onPurchasesWhy, payablesWhy, receivablesWhy, taxesPeriodLabel, toPayWhy } from '@shared/simple/explain'
import { doingLines } from '@shared/simple/reports'
import { GLOSSARY, explain, glossaryEntry, plain, type GlossaryEntry } from '@shared/simple/glossary'
import { needsReorder } from '@shared/simple/stock'
import { outstandingsWithAdvances } from '../services/analysis'
import { profitAndLoss } from '../services/reports'
import { simpleHome } from '../services/simpleHome'
import { simpleTaxes } from '../services/simpleTaxes'
import { stockList } from '../services/simpleStock'
import { getFeatures } from '../services/config'
import { companyLanguage } from '../i18n'
import { classify, questionLanguage } from './classify'
import { findItem, findLedger } from './names'
import { entryAnswer } from './entry'

export interface AskInput {
  text: string
  today: string
  picks?: { party?: number; item?: number }
  lang?: Language
}

export interface AskEnv {
  /** The signed-in role may record entries (accountant / owner; anyone in a company without users). */
  canDraft: boolean
}

/** The tool name figures carry (AiFigure.tool) — the panel says "Total answered this itself". */
export const ASK_TOTAL_TOOL = 'ask-total'

export const fig = (paise: number, source: AiSource, target?: AssistTarget): AssistFigure => ({
  text: money(paise), paise, sourced: true, tool: ASK_TOTAL_TOOL, source, ...(target ? { target } : {})
})

const screenSource = (screen: string, label: string, params?: Record<string, string | number>): AiSource => ({ kind: 'screen', screen, label, ...(params ? { params } : {}) })
const target = (screen: string, params?: AssistTarget['params']): AssistTarget => ({ screen, ...(params ? { params } : {}) })

export function answer(intent: AssistIntent, sentences: string[], extra: Partial<AssistAnswer> = {}): AssistAnswer {
  return { intent: intent.kind, answeredBy: 'total', sentences, figures: [], links: [], understood: true, ...extra }
}

/** The biggest ledgers of a statement side, largest first (the WP 9.9 Reports "where the money went"). */
function leaves(nodes: readonly StatementNode[], limit: number): StatementNode[] {
  const out: StatementNode[] = []
  const walk = (n: StatementNode): void => {
    if (n.children.length === 0) {
      if (n.amount > 0) out.push(n)
      return
    }
    n.children.forEach(walk)
  }
  nodes.forEach(walk)
  return out.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name)).slice(0, limit)
}

export function periodText(p: AssistPeriod, today: string, t: Translate): string {
  switch (p.rule) {
    case 'today':
      return t('assist.period.today')
    case 'yesterday':
      return p.from === today ? t('assist.period.today') : t('assist.period.on', { date: toPlainDate(p.from, t.lang) })
    case 'thisMonth':
      return t('assist.period.thisMonth', { from: toPlainDate(p.from, t.lang), to: toPlainDate(p.to, t.lang) })
    case 'lastMonth':
    case 'month':
      return t('assist.period.month', { month: toMonthLabel(p.from.slice(0, 7), 'long', t.lang) })
    case 'thisQuarter':
    case 'fyToDate':
      return t('assist.period.soFar', { from: toPlainDate(p.from, t.lang), to: toPlainDate(p.to, t.lang) })
    case 'lastQuarter':
    case 'lastFy':
      return t('assist.period.range', { from: toPlainDate(p.from, t.lang), to: toPlainDate(p.to, t.lang) })
  }
}

// ---------------------------------------------------------------- the intents

function owedAnswer(db: DB, intent: Extract<AssistIntent, { kind: 'owed' }>, input: AskInput, t: Translate): AssistAnswer {
  const today = input.today
  if (intent.party || input.picks?.party) {
    const found = input.picks?.party
      ? pickedLedger(db, input.picks.party)
      : findLedger(db, intent.party!, ['debtor', 'creditor'], today)
    if (found.status === 'choose') return answer(intent, [t('assist.which', { name: intent.party ?? '' })], { choice: { slot: 'party', question: t('assist.which', { name: intent.party ?? '' }), options: found.options } })
    if (found.status === 'none') {
      return answer(intent, [t('assist.notFound.person', { name: intent.party ?? '' })], { links: [{ label: t('assist.link.people'), target: target('simple-people') }] })
    }
    const side = partySide(db, found.id) ?? intent.side
    const o = outstandingsWithAdvances(db, side, today)
    const row = o.parties.find((p) => p.ledgerId === found.id)
    const pending = row?.pending ?? 0
    const bills = (row?.bills ?? []).filter((b) => b.pending > 0)
    const advance = o.advanceByParty.get(found.id) ?? 0
    const who = { kind: 'ledger' as const, ledgerId: found.id, label: found.name }
    const to = target('simple-person', { id: found.id })
    const sentences: string[] = []
    const figures: AssistFigure[] = []
    if (pending > 0) {
      sentences.push(t(side === 'receivable' ? 'assist.owed.partyOwes' : 'assist.owed.youOwe', { name: found.name, amount: money(pending), count: bills.length }))
      figures.push(fig(pending, who, to))
      const oldest = bills.reduce((d, b) => Math.max(d, b.ageDays), 0)
      if (bills.length > 0) sentences.push(t('assist.owed.oldest', { days: oldest }))
    } else {
      sentences.push(t(side === 'receivable' ? 'assist.owed.partyNothing' : 'assist.owed.youOweNothing', { name: found.name }))
    }
    if (advance > 0) {
      sentences.push(t(side === 'receivable' ? 'assist.owed.partyAdvance' : 'assist.owed.youAdvance', { name: found.name, amount: money(advance) }))
      figures.push(fig(advance, who, to))
    }
    return answer(intent, sentences, { figures, links: [{ label: t('assist.link.person', { name: found.name }), target: to }] })
  }
  const side = intent.side
  const o = outstandingsWithAdvances(db, side, today)
  const owed = owedSummary(o.parties, today, { amount: o.advances, parties: o.advanceParties })
  const sentences = [side === 'receivable' ? receivablesWhy(owed, t) : payablesWhy(owed, today, t)]
  const list = side === 'receivable' ? target('simple-people', { filter: 'owesYou' }) : target('simple-people', { tab: 'bills' })
  const figures: AssistFigure[] = []
  if (owed.total > 0) figures.push(fig(owed.total, screenSource('outstandings', t('assist.source.outstandings'), { side }), list))
  if (owed.advances > 0) figures.push(fig(owed.advances, screenSource('outstandings', t('assist.source.outstandings'), { side }), list))
  const top = o.parties.filter((p) => p.pending > 0).slice(0, 3)
  if (top.length > 1) {
    sentences.push(t('assist.owed.top', { list: top.map((p) => `${p.name} ${money(p.pending)}`).join(', ') }))
    for (const p of top) figures.push(fig(p.pending, { kind: 'ledger', ledgerId: p.ledgerId, label: p.name }, target('simple-person', { id: p.ledgerId })))
  }
  return answer(intent, sentences, { figures, links: [{ label: t(side === 'receivable' ? 'assist.link.whoOwes' : 'assist.link.billsToPay'), target: list }] })
}

function partySide(db: DB, ledgerId: number): 'receivable' | 'payable' | null {
  const groupOf = db.prepare('SELECT group_id AS g FROM ledgers WHERE id = ?').get(ledgerId) as { g: number } | undefined
  if (!groupOf) return null
  const parent = db.prepare('SELECT id, name, parent_id AS p FROM groups WHERE id = ?')
  for (let id: number | null = groupOf.g, i = 0; id != null && i < 20; i++) {
    const g = parent.get(id) as { id: number; name: string; p: number | null } | undefined
    if (!g) return null
    if (g.name === 'Sundry Debtors') return 'receivable'
    if (g.name === 'Sundry Creditors') return 'payable'
    id = g.p
  }
  return null
}

function pickedLedger(db: DB, id: number): { status: 'match'; id: number; name: string } | { status: 'none' } {
  const r = db.prepare('SELECT id, name FROM ledgers WHERE id = ?').get(id) as { id: number; name: string } | undefined
  return r ? { status: 'match', id: r.id, name: r.name } : { status: 'none' }
}

function gstAnswer(db: DB, company: CompanyInfo, intent: AssistIntent, input: AskInput, t: Translate): AssistAnswer {
  // WP 9.9's Taxes service: the three figures (= GSTR-3B) of the return the next GSTR-3B files and
  // its due date (shared/gst/filing.ts) — the Taxes screen's own answer.
  const x = simpleTaxes(db, company, {}, input.today)
  const taxes = target('simple-taxes')
  if (x.kind === 'unregistered') return answer(intent, [t('assist.gst.unregistered')])
  if (x.kind === 'composition') {
    const c = x.composition
    return answer(intent, [
      t('simple.taxes.composition.cmp08', { from: toPlainDate(c.cmp08.from, t.lang), to: toPlainDate(c.cmp08.to, t.lang), date: toPlainDate(c.cmp08.due, t.lang) }),
      t('simple.taxes.composition.note')
    ], { links: [{ label: t('assist.link.gst'), target: taxes }] })
  }
  const to = target('simple-taxes', { period: x.period.period })
  const src = screenSource('simple-taxes', t('assist.source.taxes'), { period: x.period.period })
  const f = x.figures
  const figures = [fig(Math.max(0, f.toPay), src, to), fig(f.collected, src, to), fig(f.onPurchases, src, to)]
  if (f.awaiting > 0) figures.push(fig(f.awaiting, src, to))
  if (f.reverseCharge > 0) figures.push(fig(f.reverseCharge, src, to))
  const sentences = [t('assist.gst.period', { period: taxesPeriodLabel(x.period, t) }), collectedWhy(x, t), onPurchasesWhy(x, t), toPayWhy(x, t)]
  const links: AssistLink[] = [{ label: t('assist.link.gst'), target: to }]
  // Gate polish: while the answer is the return due next, the running month (or quarter) so far
  // too — the Taxes screen's own line (WP 10.8 `running`), so this month's bills are not missing.
  if (x.running) {
    const r = x.running
    const runTo = target('simple-taxes', { period: r.period.period })
    const runSrc = screenSource('simple-taxes', t('assist.source.taxes'), { period: r.period.period })
    sentences.push(t('simple.taxes.runningSoFar', { period: taxesPeriodLabel(r.period, t), collected: money(r.collected), purchases: money(r.onPurchases) }))
    figures.push(fig(r.collected, runSrc, runTo), fig(r.onPurchases, runSrc, runTo))
    links.push({ label: t('assist.link.gstRunning', { period: taxesPeriodLabel(r.period, t) }), target: runTo })
  }
  return answer(intent, sentences, { figures, links })
}

function figureAnswer(db: DB, company: CompanyInfo, intent: Extract<AssistIntent, { kind: 'figure' }>, input: AskInput, t: Translate): AssistAnswer {
  const p = intent.period
  const pnl = profitAndLoss(db, p.from, p.to)
  // WP 9.9's column ("How is my business doing"): the P&L's own totals, re-arranged — one definition.
  const d = doingLines(pnl)
  const when = periodText(p, input.today, t)
  const src = screenSource('profit-loss', t('assist.source.pnl'), { from: p.from, to: p.to })
  const pnlScreen = target('simple-reports', { report: 'doing' })
  const sentences: string[] = []
  const figures: AssistFigure[] = []
  const links: AssistLink[] = []
  if (intent.measure === 'profit') {
    const v = d.profit
    sentences.push(t(v >= 0 ? 'assist.figure.profit' : 'assist.figure.loss', { amount: money(Math.abs(v)), period: when }))
    figures.push(fig(Math.abs(v), src, pnlScreen))
    if (d.sales !== 0 || d.expenses !== 0 || d.costOfGoods !== 0) {
      sentences.push(t('assist.figure.profitParts', { sales: money(d.sales), cost: money(d.costOfGoods), expenses: money(d.expenses) }))
      figures.push(fig(d.sales, src, pnlScreen), fig(d.costOfGoods, src, pnlScreen), fig(d.expenses, src, pnlScreen))
    }
    if (pnl.closingStock > 0) {
      sentences.push(t('simple.explain.profitStock', { stock: money(pnl.closingStock) }))
      figures.push(fig(pnl.closingStock, src, pnlScreen))
    }
    links.push({ label: t('assist.link.pnl'), target: pnlScreen })
  } else if (intent.measure === 'sales') {
    const v = d.sales
    sentences.push(t('assist.figure.sales', { amount: money(v), period: when }))
    figures.push(fig(v, src, target('simple-sales')))
    if (company.gstRegistrationType === 'regular') sentences.push(t('assist.figure.beforeGst'))
    links.push({ label: t('assist.link.sales'), target: target('simple-sales') })
  } else if (intent.measure === 'purchases') {
    const v = d.purchases
    sentences.push(t('assist.figure.purchases', { amount: money(v), period: when }))
    figures.push(fig(v, src, target('simple-purchases')))
    if (company.gstRegistrationType === 'regular') sentences.push(t('assist.figure.beforeGst'))
    links.push({ label: t('assist.link.purchases'), target: target('simple-purchases') })
  } else {
    const v = d.expenses
    sentences.push(t('assist.figure.expenses', { amount: money(v), period: when }))
    figures.push(fig(v, src, pnlScreen))
    const top = leaves(pnl.indirectExpenses, 3)
    if (top.length > 0) {
      sentences.push(t('assist.figure.expensesTop', { list: top.map((n) => `${n.name} ${money(n.amount)}`).join(', ') }))
      for (const n of top) figures.push(fig(n.amount, n.kind === 'ledger' ? { kind: 'ledger', ledgerId: n.id, label: n.name } : src, n.kind === 'ledger' ? target('ledger-statement', { ledgerId: n.id }) : pnlScreen))
    }
    links.push({ label: t('assist.link.pnl'), target: pnlScreen })
  }
  if (!intent.periodSaid) sentences.push(t('assist.figure.periodAssumed'))
  return answer(intent, sentences, { figures, links })
}

function moneyAnswer(db: DB, company: CompanyInfo, intent: Extract<AssistIntent, { kind: 'money' }>, input: AskInput, t: Translate): AssistAnswer {
  const cash = simpleHome(db, company, { today: input.today, backups: [] }).cash
  const chip = (a: (typeof cash.accounts)[number]): AssistFigure =>
    fig(a.balance, { kind: 'ledger', ledgerId: a.ledgerId, label: a.name }, a.kind === 'bank' ? target('simple-bank', { bankId: a.ledgerId }) : target('ledger-statement', { ledgerId: a.ledgerId }))
  const tb = screenSource('trial-balance', t('assist.source.tb'), { asOn: input.today })
  const banks = cash.accounts.filter((a) => a.kind === 'bank')
  const cashes = cash.accounts.filter((a) => a.kind === 'cash')
  const each = (list: typeof cash.accounts): string => list.map((a) => t('assist.money.account', { name: a.name, amount: money(a.balance) })).join(', ')
  if (intent.which === 'cash') {
    const s = [t(cash.cash < 0 ? 'simple.explain.cashBelowZero' : 'assist.money.cash', { amount: money(cash.cash), cash: money(-cash.cash) })]
    if (cashes.length > 1) s.push(each(cashes))
    return answer(intent, s, { figures: [fig(cash.cash < 0 ? -cash.cash : cash.cash, tb), ...cashes.map(chip)], links: cashes[0] ? [{ label: t('assist.link.cashAccount'), target: target('ledger-statement', { ledgerId: cashes[0].ledgerId }) }] : [] })
  }
  if (intent.which === 'bank') {
    if (banks.length === 0) return answer(intent, [t('assist.money.noBank')], { links: [{ label: t('assist.link.bank'), target: target('simple-bank') }] })
    const s = [t('assist.money.bank', { amount: money(cash.bank), count: banks.length })]
    if (banks.length > 1) s.push(each(banks))
    return answer(intent, s, { figures: [fig(cash.bank, tb), ...banks.map(chip)], links: [{ label: t('assist.link.bank'), target: target('simple-bank') }] })
  }
  return answer(intent, [cashWhy(cash, t)], { figures: [fig(cash.total, tb), fig(cash.cash, tb), fig(cash.bank, tb), ...cash.accounts.map(chip)], links: [{ label: t('assist.link.money'), target: target('simple-money') }] })
}

function stockAnswer(db: DB, intent: Extract<AssistIntent, { kind: 'stock' }>, input: AskInput, t: Translate, notUnderstood: () => AssistAnswer): AssistAnswer {
  // "<name> kitna hai" was read as a product only loosely: no such product = not understood.
  if (intent.loose && !getFeatures(db).inventory) return notUnderstood()
  if (!getFeatures(db).inventory) return answer(intent, [t('assist.stock.off')], { links: [{ label: t('assist.link.features'), target: target('simple-features') }] })
  const list = stockList(db, input.today)
  const src = screenSource('stock-summary', t('assist.source.stock'))
  if (intent.low) {
    const low = list.rows.filter((r) => needsReorder(r.level))
    if (low.length === 0) return answer(intent, [t('assist.stock.noneLow')], { links: [{ label: t('assist.link.stock'), target: target('simple-stock') }] })
    const names = low.slice(0, 5).map((r) => t('assist.stock.left', { name: r.name, qty: formatQtyMilli(r.qtyMilli), unit: r.unit })).join(', ')
    return answer(intent, [t('assist.stock.low', { count: low.length, list: names })], { links: [{ label: t('assist.link.lowStock'), target: target('simple-stock', { filter: 'low' }) }] })
  }
  if (intent.item || input.picks?.item) {
    const found = input.picks?.item ? { status: 'match' as const, id: input.picks.item, name: '' } : findItem(db, intent.item!, input.today)
    if (found.status === 'choose') return answer(intent, [t('assist.whichItem', { name: intent.item ?? '' })], { choice: { slot: 'item', question: t('assist.whichItem', { name: intent.item ?? '' }), options: found.options } })
    if (intent.loose && found.status === 'none') return notUnderstood()
    const row = found.status === 'match' ? list.rows.find((r) => r.itemId === found.id) : undefined
    if (!row) return answer(intent, [t('assist.notFound.item', { name: intent.item ?? '' })], { links: [{ label: t('assist.link.stock'), target: target('simple-stock') }] })
    const to = target('simple-stock', { itemId: row.itemId })
    return answer(intent, [t('assist.stock.item', { name: row.name, qty: formatQtyMilli(row.qtyMilli), unit: row.unit, value: money(row.value) })], {
      figures: [fig(row.value, { kind: 'item', itemId: row.itemId, label: row.name }, to)],
      links: [{ label: t('assist.link.product', { name: row.name }), target: to }]
    })
  }
  const value = list.rows.reduce((s, r) => s + r.value, 0)
  return answer(intent, [t('assist.stock.total', { count: list.rows.length, value: money(value) })], {
    figures: [fig(value, src, target('simple-stock'))],
    links: [{ label: t('assist.link.stock'), target: target('simple-stock') }]
  })
}

// ---------------------------------------------------------------- open / how do I / meaning

/** Places a person can ask to open, by the words they use → the simple screen (or the full one). */
const PLACES: [RegExp, AssistTarget, MessageKey][] = [
  [/^(?:low stock|running low)$/, target('simple-stock', { filter: 'low' }), 'assist.place.lowStock'],
  [/^(?:who owes|dues|udhaar|udhar|receivables?|outstandings?)$/, target('simple-people', { filter: 'owesYou' }), 'assist.place.whoOwes'],
  [/^(?:bills to pay|payables?)$/, target('simple-people', { tab: 'bills' }), 'assist.place.billsToPay'],
  [/^(?:banks?|bank statements?|bank accounts?)$/, target('simple-bank'), 'assist.place.bank'],
  [/^(?:money|cash|money list|entries|paise)$/, target('simple-money'), 'assist.place.money'],
  [/^(?:money in|receive money)$/, target('simple-money-in'), 'assist.place.moneyIn'],
  [/^(?:money out|pay money)$/, target('simple-money-out'), 'assist.place.moneyOut'],
  [/^(?:move money|transfer)$/, target('simple-move-money'), 'assist.place.moveMoney'],
  [/^(?:customers?|suppliers?|people|parties|contacts|log)$/, target('simple-people'), 'assist.place.people'],
  [/^(?:sales|bills|invoices|sales list|sale)$/, target('simple-sales'), 'assist.place.sales'],
  [/^(?:make a bill|new bill|sell|bill banao)$/, target('simple-sell'), 'assist.place.makeBill'],
  [/^(?:purchases?|purchase list|kharidi)$/, target('simple-purchases'), 'assist.place.purchases'],
  [/^(?:record a purchase|new purchase|buy)$/, target('simple-buy'), 'assist.place.recordPurchase'],
  [/^(?:returns?|sale returns?)$/, target('simple-return-sale'), 'assist.place.returns'],
  [/^(?:stock|products?|items?|inventory|maal)$/, target('simple-stock'), 'assist.place.stock'],
  [/^(?:stock count|count stock|count)$/, target('simple-stock-count'), 'assist.place.stockCount'],
  [/^(?:reports?|how am i doing|business)$/, target('simple-reports', { report: 'doing' }), 'assist.place.reports'],
  [/^(?:profit|profit and loss|p&l|p and l)$/, target('simple-reports', { report: 'doing' }), 'assist.place.profit'],
  [/^(?:cash next 30 days|cash forecast)$/, target('simple-reports', { report: 'cash' }), 'assist.place.cashNext'],
  [/^(?:gst|taxes|tax|gstr|gstr-?3b|gst return)$/, target('simple-taxes'), 'assist.place.taxes'],
  [/^(?:settings|setting)$/, target('simple-section', { section: 'settings' }), 'assist.place.settings'],
  [/^(?:home|dashboard)$/, target('gateway'), 'assist.place.home'],
  [/^(?:backups?|back up)$/, target('settings', { tab: 'backups' }), 'assist.place.backups'],
  [/^(?:language|looks|theme|dark mode)$/, target('simple-looks'), 'assist.place.looks'],
  [/^(?:features)$/, target('simple-features'), 'assist.place.features'],
  [/^(?:openings?|day one|opening balances?)$/, target('simple-openings'), 'assist.place.openings']
]

function openAnswer(db: DB, intent: Extract<AssistIntent, { kind: 'open' }>, input: AskInput, t: Translate, lang: Language, gstRegular: boolean): AssistAnswer {
  const said = intent.target
    .replace(/^(?:the\s+)?(?:ledger|statement|account|page|screen)\s+(?:for|of)\s+/, '')
    .replace(/\s+(?:ledger|statement|account|page|screen|list)$/, '')
    .replace(/'s$/, '')
    .trim()
  const place = PLACES.find(([re]) => re.test(said))
  if (place) {
    const label = t(place[2])
    return answer(intent, [t('assist.open.opening', { name: label })], { open: place[1], links: [{ label, target: place[1] }] })
  }
  if (input.picks?.party) return openLedger(db, input.picks.party, intent, t)
  if (input.picks?.item) return openItem(db, input.picks.item, intent, t)
  const ledger = findLedger(db, said, ['debtor', 'creditor', 'bank', 'cash', 'income', 'expense', 'other', 'tax'], input.today)
  if (ledger.status === 'match') return openLedger(db, ledger.id, intent, t)
  const item = getFeatures(db).inventory ? findItem(db, said, input.today) : ({ status: 'none' } as const)
  if (item.status === 'match' && ledger.status === 'none') return openItem(db, item.id, intent, t)
  if (ledger.status === 'choose') return answer(intent, [t('assist.whichOpen', { name: said })], { choice: { slot: 'party', question: t('assist.whichOpen', { name: said }), options: ledger.options } })
  if (item.status === 'choose') return answer(intent, [t('assist.whichOpen', { name: said })], { choice: { slot: 'item', question: t('assist.whichOpen', { name: said }), options: item.options } })
  return unknownAnswer(intent, input.text, t, [t('assist.open.none', { name: said })], lang, gstRegular)
}

function openLedger(db: DB, id: number, intent: AssistIntent, t: Translate): AssistAnswer {
  const row = db.prepare('SELECT id, name FROM ledgers WHERE id = ?').get(id) as { id: number; name: string } | undefined
  if (!row) return answer(intent, [t('assist.notFound.person', { name: '' })])
  const side = partySide(db, id)
  const bank = !side && (db.prepare("SELECT 1 FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.id = ? AND g.name IN ('Bank Accounts', 'Bank OD A/c')").get(id) != null)
  const to = side ? target('simple-person', { id }) : bank ? target('simple-bank', { bankId: id }) : target('ledger-statement', { ledgerId: id })
  return answer(intent, [t('assist.open.opening', { name: row.name })], { open: to, links: [{ label: row.name, target: to }] })
}

function openItem(db: DB, id: number, intent: AssistIntent, t: Translate): AssistAnswer {
  const row = db.prepare('SELECT id, name FROM stock_items WHERE id = ?').get(id) as { id: number; name: string } | undefined
  if (!row) return answer(intent, [t('assist.notFound.item', { name: '' })])
  const to = target('simple-stock', { itemId: id })
  return answer(intent, [t('assist.open.opening', { name: row.name })], { open: to, links: [{ label: row.name, target: to }] })
}

const HOWTO_TARGET: Record<AssistHowTo, AssistTarget> = {
  bill: target('simple-sell'),
  purchase: target('simple-buy'),
  moneyIn: target('simple-money-in'),
  moneyOut: target('simple-money-out'),
  moveMoney: target('simple-move-money'),
  returnSale: target('simple-return-sale'),
  returnPurchase: target('simple-return-purchase'),
  bank: target('simple-bank'),
  customer: target('simple-people'),
  product: target('simple-stock'),
  stockCount: target('simple-stock-count'),
  gst: target('simple-taxes'),
  backup: target('settings', { tab: 'backups' }),
  language: target('simple-looks'),
  openings: target('simple-openings'),
  undo: target('simple-sales'),
  features: target('simple-features'),
  reminder: target('simple-people', { filter: 'late' })
}

const HOWTO_TEXT: Record<AssistHowTo, MessageKey> = {
  bill: 'assist.howto.bill',
  purchase: 'assist.howto.purchase',
  moneyIn: 'assist.howto.moneyIn',
  moneyOut: 'assist.howto.moneyOut',
  moveMoney: 'assist.howto.moveMoney',
  returnSale: 'assist.howto.returnSale',
  returnPurchase: 'assist.howto.returnPurchase',
  bank: 'assist.howto.bank',
  customer: 'assist.howto.customer',
  product: 'assist.howto.product',
  stockCount: 'assist.howto.stockCount',
  gst: 'assist.howto.gst',
  backup: 'assist.howto.backup',
  language: 'assist.howto.language',
  openings: 'assist.howto.openings',
  undo: 'assist.howto.undo',
  features: 'assist.howto.features',
  reminder: 'assist.howto.reminder'
}

const HOWTO_LINK: Record<AssistHowTo, MessageKey> = {
  bill: 'assist.place.makeBill',
  purchase: 'assist.place.recordPurchase',
  moneyIn: 'assist.place.moneyIn',
  moneyOut: 'assist.place.moneyOut',
  moveMoney: 'assist.place.moveMoney',
  returnSale: 'assist.place.returns',
  returnPurchase: 'assist.place.purchaseReturns',
  bank: 'assist.place.bank',
  customer: 'assist.place.people',
  product: 'assist.place.stock',
  stockCount: 'assist.place.stockCount',
  gst: 'assist.place.taxes',
  backup: 'assist.place.backups',
  language: 'assist.place.looks',
  openings: 'assist.place.openings',
  undo: 'assist.place.sales',
  features: 'assist.place.features',
  reminder: 'assist.place.reminders'
}

function howtoAnswer(intent: Extract<AssistIntent, { kind: 'howto' }>, t: Translate): AssistAnswer {
  return answer(intent, [t(HOWTO_TEXT[intent.task])], { links: [{ label: t(HOWTO_LINK[intent.task]), target: HOWTO_TARGET[intent.task] }] })
}

const ENTRIES = Object.values(GLOSSARY) as GlossaryEntry[]

function glossaryFind(term: string): GlossaryEntry | null {
  const t = term.toLowerCase().replace(/[^\p{L}\p{N}\s/&-]/gu, '').trim()
  return glossaryEntry(t) ?? glossaryEntry(t.replace(/s$/, '')) ?? ENTRIES.find((e) => e.plain.toLowerCase() === t) ?? null
}

/** Glossary search by the words asked — the second source next to WP 10.3's help articles, which the panel searches itself (renderer, bundled). */
export function helpSearch(text: string, lang: Language, limit = 3): { term: string; plain: string; explain: string }[] {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3)
  if (!words.length) return []
  const scored = ENTRIES.map((e) => {
    const names = [e.term, ...(e.aliases ?? []), e.plain].map((s) => s.toLowerCase())
    const score = words.reduce((s, w) => s + (names.some((n) => n === w || n.split(/\s+/).includes(w)) ? 3 : names.some((n) => n.includes(w)) ? 1 : 0), 0)
    return { e, score }
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(({ e }) => ({ term: e.term, plain: plain(e.term, lang), explain: explain(e.term, lang) ?? e.explain }))
}

function meaningAnswer(intent: Extract<AssistIntent, { kind: 'meaning' }>, input: AskInput, readerLang: Language, readerT: Translate, gstRegular: boolean): AssistAnswer {
  // Gate polish: "GSTR-3B kya hai" is answered in Hinglish, "जीएसटी क्या है" in Hindi — the
  // question's own language; an English question keeps the reader's. The explanation falls back
  // to English only where the glossary has no translation.
  const lang = questionLanguage(input.text) ?? readerLang
  const t = lang === readerLang ? readerT : translator(lang)
  const e = glossaryFind(intent.term)
  if (!e) return unknownAnswer(intent, input.text, t, undefined, lang, gstRegular)
  const why = explain(e.term, lang) ?? e.explain
  return answer(intent, [t('assist.meaning', { term: e.term, explain: why, plain: plain(e.term, lang) })], { help: [{ term: e.term, plain: plain(e.term, lang), explain: why }] })
}

const SUGGESTIONS: MessageKey[] = ['assist.suggest.owed', 'assist.suggest.profit', 'assist.suggest.cash', 'assist.suggest.gst', 'assist.suggest.entry']

export function unknownAnswer(intent: AssistIntent, text: string, t: Translate, lead?: string[], lang: Language = 'en', gstRegular = true): AssistAnswer {
  const keys = SUGGESTIONS.filter((k) => gstRegular || k !== 'assist.suggest.gst').slice(0, 3)
  return {
    intent: intent.kind, answeredBy: 'total',
    sentences: [...(lead ?? []), t('assist.unknown')],
    figures: [], links: [],
    suggestions: keys.map((k) => t(k)),
    help: helpSearch(text, lang),
    understood: false
  }
}

/** WP 10.8: "5000 Ramesh" — which way did the money go? Two answers the user can press (each is
 *  a full entry request the classifier reads as money in / money out). */
function directionAnswer(intent: Extract<AssistIntent, { kind: 'direction' }>, t: Translate): AssistAnswer {
  const vars = { name: intent.party, amount: formatPaise(intent.amount, { symbol: true }) }
  return {
    intent: intent.kind, answeredBy: 'total',
    sentences: [t('assist.direction.ask', vars)],
    figures: [], links: [],
    suggestions: [t('assist.direction.in', { name: intent.party, amount: formatPaise(intent.amount) }), t('assist.direction.out', { name: intent.party, amount: formatPaise(intent.amount) })],
    help: [],
    understood: true
  }
}

// ---------------------------------------------------------------- entry point

export function askTotal(db: DB, company: CompanyInfo, input: AskInput, env: AskEnv): AssistAnswer {
  const lang = input.lang ?? companyLanguage(db)
  const t = translator(lang)
  const intent = classify(input.text, input.today)
  const gstRegular = company.gstRegistrationType === 'regular'
  // One read transaction: every figure in the answer sees the same books. (An entry's rehearsal
  // inside it is rolled back — nothing persists.)
  return db.transaction((): AssistAnswer => {
    switch (intent.kind) {
      case 'owed':
        return owedAnswer(db, intent, input, t)
      case 'gst':
        return gstAnswer(db, company, intent, input, t)
      case 'figure':
        return figureAnswer(db, company, intent, input, t)
      case 'money':
        return moneyAnswer(db, company, intent, input, t)
      case 'stock':
        return stockAnswer(db, intent, input, t, () => unknownAnswer({ kind: 'unknown' }, input.text, t, undefined, lang, gstRegular))
      case 'open':
        return openAnswer(db, intent, input, t, lang, gstRegular)
      case 'howto':
        return howtoAnswer(intent, t)
      case 'meaning':
        return meaningAnswer(intent, input, lang, t, gstRegular)
      case 'entry':
        return entryAnswer(db, company, intent, input, env, t)
      case 'direction':
        return directionAnswer(intent, t)
      case 'unknown':
        return unknownAnswer(intent, input.text, t, undefined, lang, gstRegular)
    }
  })()
}

export type { AssistChoice }
