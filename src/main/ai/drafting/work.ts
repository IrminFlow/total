// WP 5.3 drafting — the resolution half. A draft tool opens one DraftWork, resolves every name
// the model passed (party, ledger, item, bill, invoice, date, amount, quantity) through it, and
// at the end either has every id it needs or a list of clarifications to hand back.
//
// Rules (also in the tool descriptions the model reads):
//   - A numeric id the model passes must exist and be the right kind of thing.
//   - A name goes through @shared/aiResolve (exact identifier → normalised name → clearly-best
//     fuzzy match); several close candidates are NEVER picked between — they become a
//     `needs_clarification` result listing them, and no draft is made.
//   - Amounts are read only by money.ts parseAmountText (lakh / crore shorthand), dates only by
//     dates.ts resolveDateText against the working date (relative dates included).
//   - Everything resolved is recorded as a source (what was said → what was picked, and why);
//     every default the tool chose is recorded as an assumption.
import type { DB } from '../../db/connection'
import type { CompanyInfo, Group, Ledger, StockItem, Unit } from '@shared/domain'
import { AI_MEMORY_PURPOSE_LABELS, type AiDraftSourceRef, type AiMemoryPurpose } from '@shared/ai'
import { EMPTY_MEMORY_CONTEXT, type MemoryContext } from '../memoryRules'
import { ledgerClassifier, partyLedgerFits, purposeFits, type LedgerClassifier } from '../ledgerClass'
import { formatPaise, parseAmountText } from '@shared/money'
import { resolveDateText, toDisplayDate } from '@shared/dates'
import { resolveName, type ResolveCandidate, type ResolveChoice } from '@shared/aiResolve'
import { stateName } from '@shared/gst/states'
import { listGroups, listLedgers, listStockItems, listUnits } from '../../services/masters'

export interface Clarification {
  field: string
  /** What the user / model said. */
  said: string
  question: string
  candidates: { id: number; name: string; detail?: string }[]
}

/** The masters a draft resolves against, loaded once per tool call. */
export interface DraftMasters {
  db: DB
  company: CompanyInfo
  /** The working date — relative dates resolve against it. */
  today: string
  ledgers: Ledger[]
  groups: Map<number, Group>
  items: StockItem[]
  units: Map<number, Unit>
}

export function loadMasters(db: DB, company: CompanyInfo, today: string): DraftMasters {
  return {
    db,
    company,
    today,
    ledgers: listLedgers(db),
    groups: new Map(listGroups(db).map((g) => [g.id, g])),
    items: listStockItems(db),
    units: new Map(listUnits(db).map((u) => [u.id, u]))
  }
}

/** Group names from the ledger's group up to the root. */
export function groupChain(m: DraftMasters, groupId: number | null): string[] {
  const out: string[] = []
  for (let g = groupId != null ? m.groups.get(groupId) : undefined, guard = 0; g && guard < 50; guard++) {
    out.push(g.name)
    g = g.parentId != null ? m.groups.get(g.parentId) : undefined
  }
  return out
}

export const underGroup = (m: DraftMasters, l: Ledger, names: readonly string[]): boolean => groupChain(m, l.groupId).some((g) => names.includes(g))
export const isDebtor = (m: DraftMasters, l: Ledger): boolean => underGroup(m, l, ['Sundry Debtors'])
export const isCreditor = (m: DraftMasters, l: Ledger): boolean => underGroup(m, l, ['Sundry Creditors'])
export const isParty = (m: DraftMasters, l: Ledger): boolean => isDebtor(m, l) || isCreditor(m, l)
export const isCashOrBank = (m: DraftMasters, l: Ledger): boolean => underGroup(m, l, ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c'])

export type PartySide = 'debtor' | 'creditor' | 'any'

/** Thrown by a resolver that cannot continue without an answer (the tool turns the collected
 *  clarifications into its result). */
export class NeedsClarification extends Error {
  constructor() {
    super('needs clarification')
  }
}

export class DraftWork {
  readonly sources: AiDraftSourceRef[] = []
  readonly assumptions: string[] = []
  readonly fields = new Set<string>()
  readonly clarifications: Clarification[] = []

  /** WP 5.6: memories this draft used as defaults (cited on the answer, counted). */
  readonly memoryUsed: number[] = []

  constructor(
    readonly m: DraftMasters,
    /** WP 5.6: the question's active memories — consulted only for what the user did NOT say. */
    readonly memory: MemoryContext = EMPTY_MEMORY_CONTEXT
  ) {}

  private classifier: LedgerClassifier | null = null
  private classes(): LedgerClassifier {
    return (this.classifier ??= ledgerClassifier(this.m.db))
  }

  /** Recorded on the draft; counted as used (memory.markUsed) only once the draft is stored. */
  private useMemory(memoryId: number): void {
    if (!this.memoryUsed.includes(memoryId)) this.memoryUsed.push(memoryId)
  }

  /** A default taken from memory: recorded as a source and an assumption ("From memory: …").
   *  Callers only reach this when the user left the field unsaid. */
  fromMemory(field: string, kind: AiDraftSourceRef['kind'], label: string, id: number, memoryId: number, text: string): void {
    this.source({ field, kind, label, id, why: `from memory [M${memoryId}]` })
    this.assume(`From memory [M${memoryId}]: ${text}`)
    this.useMemory(memoryId)
  }

  /** The remembered ledger for a purpose, when it passes `filter` (e.g. cash / bank only). */
  memoryLedger(field: string, purpose: AiMemoryPurpose, filter: (l: Ledger) => boolean = () => true): Ledger | null {
    const p = this.memory.preferredLedger(purpose)
    const l = p ? this.m.ledgers.find((x) => x.id === p.ledgerId) : undefined
    // The same class rule as writing the memory: never a party / bank ledger for 'expense', etc.
    if (!p || !l || !purposeFits(this.classes().cls(l.id), purpose) || !filter(l)) return null
    this.fromMemory(field, 'ledger', l.name, l.id, p.memoryId, `${AI_MEMORY_PURPOSE_LABELS[purpose]} ${l.name}`)
    return l
  }

  /** The party's remembered usual ledger, when it passes `filter`. */
  memoryPartyLedger(field: string, party: Ledger | null, filter: (l: Ledger) => boolean): Ledger | null {
    const pm = party ? this.memory.forParty(party.id) : null
    const l = pm?.data?.ledgerId ? this.m.ledgers.find((x) => x.id === pm.data!.ledgerId) : undefined
    if (!pm || !l || !partyLedgerFits(this.classes(), party!.id, l.id) || !filter(l)) return null
    this.fromMemory(field, 'ledger', l.name, l.id, pm.id, `${party!.name} is usually booked to ${l.name}`)
    return l
  }

  /** The party's remembered usual item (for a line that names none) — only on its own side: a
   *  debtor's item on a sales document, a creditor's on a purchase one. */
  memoryPartyItem(field: string, party: Ledger | null, side: 'sales' | 'purchase'): StockItem | null {
    if (!party || this.classes().cls(party.id) !== (side === 'sales' ? 'debtor' : 'creditor')) return null
    const pm = this.memory.forParty(party.id)
    const it = pm?.data?.itemId ? this.m.items.find((x) => x.id === pm.data!.itemId) : undefined
    if (!pm || !it) return null
    this.fromMemory(field, 'item', it.name, it.id, pm.id, `${party!.name} usually takes ${it.name}`)
    return it
  }

  /** No date was said: note the party's remembered bill day (it never changes the date). */
  memoryBillDay(party: Ledger | null, dateSaid: string | undefined, date: string): void {
    if (dateSaid != null && dateSaid.trim() !== '') return
    const pm = party ? this.memory.forParty(party.id) : null
    const day = pm?.data?.billDay
    if (!pm || !day) return
    if (Math.abs(Number(date.slice(8, 10)) - day) <= 3) return
    this.assume(`From memory [M${pm.id}]: ${party!.name} usually bills around day ${day} of the month — check the date`)
    this.useMemory(pm.id)
  }

  assume(text: string): void {
    if (!this.assumptions.includes(text)) this.assumptions.push(text)
  }

  source(s: AiDraftSourceRef): void {
    this.sources.push(s)
    this.fields.add(s.field)
  }

  ask(c: Clarification): void {
    this.clarifications.push(c)
  }

  /** Throw if anything is still unanswered (call before building). */
  settle(): void {
    if (this.clarifications.length) throw new NeedsClarification()
  }

  // ---------- generic name resolution ----------

  private pick(
    field: string,
    said: string,
    what: string,
    candidates: ResolveCandidate[],
    kind: AiDraftSourceRef['kind']
  ): { id: number; name: string } | null {
    const r = resolveName(said, candidates)
    if (r.status === 'match') {
      this.source({ field, kind, label: r.name, id: r.id, said, why: r.why })
      return { id: r.id, name: r.name }
    }
    const list = (cs: ResolveChoice[]): Clarification['candidates'] => cs.map((c) => ({ id: c.id, name: c.name, ...(c.detail ? { detail: c.detail } : {}) }))
    if (r.status === 'ambiguous') {
      this.ask({ field, said, question: `Which ${what} do you mean by “${said}”?`, candidates: list(r.candidates) })
    } else {
      this.ask({
        field,
        said,
        question: `There is no ${what} called “${said}”.${r.closest.length ? ' Did you mean one of these?' : ' Create it first, or give another name.'}`,
        candidates: list(r.closest)
      })
    }
    return null
  }

  private ledgerCandidate(l: Ledger): ResolveCandidate {
    const group = this.m.groups.get(l.groupId)?.name ?? ''
    const st = l.stateCode ? stateName(l.stateCode) : null
    return {
      id: l.id,
      name: l.name,
      keys: [l.gstin, l.pan],
      detail: [group, l.gstin ? `GSTIN ${l.gstin}` : null, st].filter(Boolean).join(' · ')
    }
  }

  /** A ledger by id or name, among `filter` (default all). */
  ledger(
    field: string,
    said: string | number | null | undefined,
    opts: { what: string; filter?: (l: Ledger) => boolean; kind?: AiDraftSourceRef['kind'] }
  ): Ledger | null {
    if (said == null || said === '') return null
    const pool = this.m.ledgers.filter(opts.filter ?? (() => true))
    if (typeof said === 'number') {
      const l = this.m.ledgers.find((x) => x.id === said)
      if (!l) throw new Error(`There is no ledger with id ${said}`)
      if (!pool.includes(l)) throw new Error(`${l.name} is not a ${opts.what}`)
      this.source({ field, kind: opts.kind ?? 'ledger', label: l.name, id: l.id, said: String(said), why: 'the id from an earlier tool result' })
      return l
    }
    const hit = this.pick(field, said, opts.what, pool.map((l) => this.ledgerCandidate(l)), opts.kind ?? 'ledger')
    return hit ? this.m.ledgers.find((l) => l.id === hit.id)! : null
  }

  /** A party (Sundry Debtor / Creditor) by id, name, GSTIN or PAN. `side` narrows it first; when
   *  nothing matches on that side the other side is searched too (a customer who also supplies). */
  party(field: string, said: string | number | null | undefined, side: PartySide): Ledger | null {
    if (said == null || said === '') return null
    const onSide = (l: Ledger): boolean => (side === 'debtor' ? isDebtor(this.m, l) : side === 'creditor' ? isCreditor(this.m, l) : isParty(this.m, l))
    if (typeof said === 'number') return this.ledger(field, said, { what: 'party (debtor or creditor)', filter: (l) => isParty(this.m, l) })
    if (side !== 'any') {
      const first = resolveName(said, this.m.ledgers.filter(onSide).map((l) => this.ledgerCandidate(l)))
      if (first.status !== 'match') {
        const any = resolveName(said, this.m.ledgers.filter((l) => isParty(this.m, l)).map((l) => this.ledgerCandidate(l)))
        if (any.status === 'match') {
          const l = this.m.ledgers.find((x) => x.id === any.id)!
          this.source({ field, kind: 'ledger', label: l.name, id: l.id, said, why: any.why })
          this.assume(`${l.name} is a ${isDebtor(this.m, l) ? 'debtor' : 'creditor'}, not a ${side} — check the party`)
          return l
        }
      }
    }
    return this.ledger(field, said, { what: side === 'debtor' ? 'customer (Sundry Debtors)' : side === 'creditor' ? 'supplier (Sundry Creditors)' : 'party', filter: onSide })
  }

  item(field: string, said: string | number | null | undefined): StockItem | null {
    if (said == null || said === '') return null
    if (typeof said === 'number') {
      const it = this.m.items.find((i) => i.id === said)
      if (!it) throw new Error(`There is no stock item with id ${said}`)
      this.source({ field, kind: 'item', label: it.name, id: it.id, said: String(said), why: 'the id from an earlier tool result' })
      return it
    }
    const hit = this.pick(
      field,
      said,
      'stock item',
      this.m.items.map((i) => ({
        id: i.id,
        name: i.name,
        keys: [i.barcode],
        secondary: [i.hsn],
        detail: [i.hsn ? `HSN ${i.hsn}` : null, i.gstRate != null ? `${i.gstRate}% GST` : null].filter(Boolean).join(' · ')
      })),
      'item'
    )
    return hit ? this.m.items.find((i) => i.id === hit.id)! : null
  }

  unitOf(item: StockItem): string {
    return this.m.units.get(item.unitId)?.symbol ?? ''
  }

  // ---------- dates, amounts, quantities ----------

  /** The voucher date: `said` resolved against the working date; omitted = the working date. */
  date(field: string, said: string | null | undefined, fallbackLabel = 'the working date'): string {
    if (said == null || said.trim() === '') {
      this.assume(`Dated ${toDisplayDate(this.m.today)} (${fallbackLabel}) — no date was given`)
      return this.m.today
    }
    const r = resolveDateText(said, this.m.today)
    if (!r) throw new Error(`Could not read the date “${said}” — give it as YYYY-MM-DD or e.g. “yesterday”, “15 Aug”`)
    this.fields.add(field)
    if (r.how !== 'as given') this.source({ field, kind: 'date', label: toDisplayDate(r.date), said, why: r.how })
    if (r.date > this.m.today) this.assume(`“${said}” is ${toDisplayDate(r.date)} — after the working date ${toDisplayDate(this.m.today)}; check the date`)
    return r.date
  }

  /** An optional second date (due date, valid until). */
  optionalDate(field: string, said: string | null | undefined): string | null {
    if (said == null || said.trim() === '') return null
    return this.date(field, said)
  }

  amount(field: string, said: string, label: string): number {
    const p = parseAmountText(said)
    if (p === null || p <= 0) throw new Error(`${label}: “${said}” is not a rupee amount (e.g. 45000, 45,000.50, 1.5 lakh)`)
    this.fields.add(field)
    if (!/^₹?\s?\d[\d,]*(\.\d{1,2})?$/.test(said.trim())) {
      this.source({ field, kind: 'amount', label: formatPaise(p, { symbol: true }), said, why: 'read from the shorthand' })
    }
    return p
  }

  /** "2", "2.5", "1,000", or the number followed by the ITEM'S OWN unit ("2 Nos", "3 numbers")
   *  → thousandths. Anything else — a multiplier ("1 lakh", "10k", "2 dozen") or another unit
   *  ("1.5 kg" on an item kept in grams) — is refused: the app never converts quantities. */
  qty(field: string, said: string | number, label: string, item?: StockItem | null): number {
    const text = String(said).trim()
    const m = /^(\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.(\d{1,3}))?(?:\s*(\p{L}.*))?$/u.exec(text)
    if (!m) throw new Error(`${label}: “${said}” is not a quantity — give a number`)
    if (m[3]) {
      const unit = item ? this.m.units.get(item.unitId) : undefined
      const ok = !!unit && [unit.symbol, unit.name].some((u) => u && u.trim().toLowerCase().replace(/\.$/, '') === m[3]!.trim().toLowerCase().replace(/\.$/, ''))
      if (!ok) {
        throw new Error(
          `${label}: “${said}” — give the quantity as a plain number${unit ? ` in ${unit.symbol}` : ''}; the app does not convert “${m[3]}”`
        )
      }
    }
    const milli = Number(m[1]!.replace(/,/g, '')) * 1000 + Number((m[2] ?? '').padEnd(3, '0'))
    if (milli <= 0) throw new Error(`${label}: the quantity must be more than zero`)
    this.fields.add(field)
    return milli
  }

  /** "10", "10%", "12.5 %" → basis points. */
  percentBp(said: string, label: string): number {
    const m = /^(\d{1,3})(?:\.(\d{1,2}))?\s*%?$/.exec(said.trim())
    if (!m) throw new Error(`${label}: “${said}” is not a percentage`)
    const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
    if (bp > 10_000) throw new Error(`${label}: more than 100%`)
    return bp
  }

  /** A state by two-digit code or name ("29", "Karnataka"). */
  stateCode(field: string, said: string): string {
    const t = said.trim()
    if (/^\d{1,2}$/.test(t)) {
      const code = t.padStart(2, '0')
      if (!stateName(code)) throw new Error(`“${said}” is not a GST state code`)
      this.fields.add(field)
      return code
    }
    for (let c = 1; c <= 99; c++) {
      const code = String(c).padStart(2, '0')
      const name = stateName(code)
      if (name && name.toLowerCase() === t.toLowerCase()) {
        this.fields.add(field)
        this.source({ field, kind: 'tax', label: `${code} ${name}`, said, why: 'the state named' })
        return code
      }
    }
    throw new Error(`“${said}” is not a state — give the two-digit GST state code`)
  }
}

/** The tool result when names need the user's answer: no draft was made. */
export function clarificationResult(work: DraftWork): { status: 'needs_clarification'; questions: Clarification[]; note: string } {
  return {
    status: 'needs_clarification',
    questions: work.clarifications,
    note:
      'No draft was made. Ask the user each question (list the candidates by name) and call the tool again with their answer — never pick one yourself.'
  }
}
