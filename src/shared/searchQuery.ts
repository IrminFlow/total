/**
 * Books-search query language — a pure parser (no DB) shared by the ⌘K palette, the Search
 * results screen and the main-process search service (src/main/services/search.ts).
 *
 * A query is free text plus optional typed tokens, all combined with AND:
 *
 *   amt:5000  amt:>50000  amt:>=50000  amt:<500  amt:<=500  amt:1000..5000  amt:1.5L  amt:2cr
 *   date:2026-04-12  date:12-04-2026  date:12-Apr-26  date:apr  date:apr-2026  date:2026-04
 *   date:2026-04-01..2026-04-30  date:>=2026-04-01  date:today  fy:2026  fy:2026-27
 *   type:sales  no:INV-12  gstin:27AAP…  pan:AAPFU…  hsn:8471  group:sundry  party:acme
 *   in:ledgers|items|vouchers (comma list allowed)   "exact phrase"   key:"quoted value"
 *
 * A bare free-text word that parses as money (5000, 1,40,50,613, ₹2,500.50, 5k) also matches
 * voucher amounts, in addition to text. Amounts are parsed ONLY through money.ts into integer
 * paise. Anything the parser cannot understand (`amt:abc`, `colour:red`) is kept as free text and
 * reported in `unknown` — the parser never throws.
 *
 * Repeated `type:` / `in:` tokens widen (OR) — AND-ing two voucher types could never match;
 * every other repeated token narrows (AND).
 */
import { formatPaise, parseRupees } from './money'
import { fyFromStartYear, fyOf, isValidISODate, todayISO } from './dates'
import type { VoucherKind } from './domain'

export type SearchKind = 'ledger' | 'item' | 'voucher'

/** Inclusive paise bounds; null = open on that side. */
export interface AmountRange {
  min: number | null
  max: number | null
}

/** Inclusive ISO date bounds; null = open on that side. */
export interface DateRange {
  from: string | null
  to: string | null
}

export interface SearchTerm {
  /** Text to substring-match (lower-cased; quotes stripped for phrases). */
  text: string
  phrase: boolean
  /** When the bare word parses as money: its value in paise (also matched against amounts). */
  amount: number | null
}

export type ChipKey = 'amount' | 'date' | 'type' | 'no' | 'gstin' | 'pan' | 'hsn' | 'group' | 'party' | 'in' | 'bare-amount'

export interface SearchChip {
  key: ChipKey
  /** Human label: "Amount ≥ ₹50,000", "April 2026", "Type: Sales". */
  label: string
  /** The raw token in the query that produced the chip (lets the UI remove it). */
  raw: string
}

export interface ParsedQuery {
  terms: SearchTerm[]
  amounts: AmountRange[]
  dates: DateRange[]
  /** `type:` values, lower-cased (resolved against voucher type kinds + names by the service). */
  types: string[]
  /** Voucher kinds the `type:` values name via known aliases (sales, cn, jv, …). */
  typeKinds: VoucherKind[]
  numbers: string[]
  gstins: string[]
  pans: string[]
  hsns: string[]
  groups: string[]
  parties: string[]
  /** `in:` restriction, or null for every kind. */
  kinds: SearchKind[] | null
  chips: SearchChip[]
  /** Raw tokens that looked like `key:value` but could not be understood. */
  unknown: string[]
}

export interface ParseOptions {
  /** Today's date (ISO) for `date:today` and the default financial year. */
  today?: string
  /** FY (start year) that bare months (`date:apr`) resolve into. Defaults to today's FY. */
  fyStartYear?: number
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** 'apr' | 'april' | 'sept' → 1-12, else null. */
function monthIndex(s: string): number | null {
  const v = s.toLowerCase()
  if (v === 'sept') return 9
  for (let i = 0; i < 12; i++) {
    if (v === MONTHS[i] || v === MONTH_FULL[i]!.toLowerCase()) return i + 1
  }
  return null
}

const pad2 = (n: number): string => n.toString().padStart(2, '0')

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

function fullYear(y: number, raw: string): number {
  return raw.length <= 2 ? 2000 + y : y
}

function monthRange(y: number, m: number): DateRange | null {
  if (m < 1 || m > 12 || y < 1900 || y > 9999) return null
  return { from: `${y}-${pad2(m)}-01`, to: `${y}-${pad2(m)}-${pad2(lastDayOfMonth(y, m))}` }
}

function dayRange(y: number, m: number, d: number): DateRange | null {
  const iso = `${y.toString().padStart(4, '0')}-${pad2(m)}-${pad2(d)}`
  return isValidISODate(iso) ? { from: iso, to: iso } : null
}

/** One date spec (no range / comparator) → the period it names. */
function parseDateAtom(raw: string, opts: Required<ParseOptions>): { range: DateRange; label: string } | null {
  const s = raw.trim().toLowerCase()
  if (s === '') return null
  if (s === 'today' || s === 't') return { range: { from: opts.today, to: opts.today }, label: humanDay(opts.today) }
  if (s === 'yesterday' || s === 'y') {
    const d = addDays(opts.today, -1)
    return { range: { from: d, to: d }, label: humanDay(d) }
  }
  let m: RegExpMatchArray | null
  // 2026-04-12
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    const r = dayRange(+m[1]!, +m[2]!, +m[3]!)
    return r && { range: r, label: humanDay(r.from!) }
  }
  // 2026-04
  if ((m = s.match(/^(\d{4})-(\d{1,2})$/))) {
    const r = monthRange(+m[1]!, +m[2]!)
    return r && { range: r, label: humanMonth(r.from!) }
  }
  // 2026 (calendar year)
  if ((m = s.match(/^(\d{4})$/))) {
    const y = +m[1]!
    if (y < 1900) return null
    return { range: { from: `${y}-01-01`, to: `${y}-12-31` }, label: `Year ${y}` }
  }
  // 12-04-2026, 12/04/26, 12.04.2026 (DD-MM-YYYY, the portal/entry order)
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) {
    const r = dayRange(fullYear(+m[3]!, m[3]!), +m[2]!, +m[1]!)
    return r && { range: r, label: humanDay(r.from!) }
  }
  // 12-apr-26, 12-apr-2026, 12apr2026 (the on-screen display format, DD-MMM-YY)
  if ((m = s.match(/^(\d{1,2})[-/.\s]?([a-z]{3,9})[-/.\s]?(\d{2}|\d{4})$/))) {
    const mi = monthIndex(m[2]!)
    if (mi == null) return null
    const r = dayRange(fullYear(+m[3]!, m[3]!), mi, +m[1]!)
    return r && { range: r, label: humanDay(r.from!) }
  }
  // 04-2026, 4/26 (MM-YYYY)
  if ((m = s.match(/^(\d{1,2})[-/.](\d{4})$/))) {
    const r = monthRange(+m[2]!, +m[1]!)
    return r && { range: r, label: humanMonth(r.from!) }
  }
  // apr-2026, apr2026, april-26
  if ((m = s.match(/^([a-z]{3,9})[-/.\s]?(\d{2}|\d{4})$/))) {
    const mi = monthIndex(m[1]!)
    if (mi == null) return null
    const r = monthRange(fullYear(+m[2]!, m[2]!), mi)
    return r && { range: r, label: humanMonth(r.from!) }
  }
  // apr / april — the month within the working financial year (Apr–Dec → start year, Jan–Mar → next)
  if (/^[a-z]{3,9}$/.test(s)) {
    const mi = monthIndex(s)
    if (mi == null) return null
    const y = mi >= 4 ? opts.fyStartYear : opts.fyStartYear + 1
    const r = monthRange(y, mi)
    return r && { range: r, label: humanMonth(r.from!) }
  }
  return null
}

function humanDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return `${d} ${MONTH_FULL[m - 1]!.slice(0, 3)} ${y}`
}

function humanMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number) as [number, number]
  return `${MONTH_FULL[m - 1]} ${y}`
}

/** A `date:` value: atom, `a..b` range (open ends allowed) or a comparator (`>`, `>=`, `<`, `<=`). */
export function parseDateSpec(raw: string, options: ParseOptions = {}): { range: DateRange; label: string } | null {
  const opts = resolveOptions(options)
  const s = raw.trim()
  if (s.includes('..')) {
    const parts = s.split('..')
    if (parts.length !== 2) return null
    const [a, b] = parts as [string, string]
    const left = a.trim() === '' ? null : parseDateAtom(a, opts)
    const right = b.trim() === '' ? null : parseDateAtom(b, opts)
    if ((a.trim() !== '' && !left) || (b.trim() !== '' && !right) || (!left && !right)) return null
    let from = left?.range.from ?? null
    let to = right?.range.to ?? null
    if (from && to && from > to) {
      // Typed back-to-front — swap whole periods rather than failing.
      from = right!.range.from
      to = left!.range.to
    }
    const label =
      left && right ? `${humanDay(from!)} – ${humanDay(to!)}` : left ? `From ${humanDay(from!)}` : `Up to ${humanDay(to!)}`
    return { range: { from, to }, label }
  }
  const cmp = s.match(/^(>=|<=|>|<)(.+)$/)
  if (cmp) {
    const atom = parseDateAtom(cmp[2]!, opts)
    if (!atom) return null
    switch (cmp[1]) {
      case '>': {
        const from = addDays(atom.range.to!, 1)
        return { range: { from, to: null }, label: `After ${atom.label}` }
      }
      case '>=':
        return { range: { from: atom.range.from, to: null }, label: `From ${atom.label}` }
      case '<': {
        const to = addDays(atom.range.from!, -1)
        return { range: { from: null, to }, label: `Before ${atom.label}` }
      }
      default:
        return { range: { from: null, to: atom.range.to }, label: `Up to ${atom.label}` }
    }
  }
  return parseDateAtom(s, opts)
}

/** `fy:` value — 2026, 26, 2026-27, 2026-2027 — the Indian FY starting that year. */
export function parseFySpec(raw: string): { range: DateRange; label: string } | null {
  const s = raw.trim()
  const m = s.match(/^(\d{2}|\d{4})(?:[-/](\d{2}|\d{4}))?$/)
  if (!m) return null
  const start = fullYear(+m[1]!, m[1]!)
  if (m[2] != null) {
    const end = m[2].length === 2 ? +m[2] : +m[2] % 100
    if (end !== (start + 1) % 100) return null
  }
  if (start < 1900 || start > 9998) return null
  const fy = fyFromStartYear(start)
  return { range: { from: fy.from, to: fy.to }, label: `FY ${fy.label}` }
}

const MONEY_RE = /^₹?(?:\d[\d,]*(?:\.\d{1,2})?|\.\d{1,2})(k|l|lac|lakh|lakhs|cr|crore|crores)?$/i

const SUFFIX_FACTOR: Record<string, number> = {
  k: 1_000,
  l: 100_000,
  lac: 100_000,
  lakh: 100_000,
  lakhs: 100_000,
  cr: 10_000_000,
  crore: 10_000_000,
  crores: 10_000_000
}

/** A non-negative rupee amount ("5000", "1,40,50,613", "₹2,500.50", "1.5L", "2cr") → paise via
 *  money.ts's parseRupees; null when it isn't money-shaped. */
export function parseMoneyValue(raw: string): number | null {
  const s = raw.trim()
  const m = s.match(MONEY_RE)
  if (!m) return null
  // Commas must sit between digits ("1,40,50,613"), never lead/trail/double up.
  const numeric = s.replace(/^₹/, '').slice(0, s.replace(/^₹/, '').length - (m[1]?.length ?? 0))
  if (/,,|,$|,\./.test(numeric)) return null
  const paise = parseRupees(numeric)
  if (paise == null || paise < 0) return null
  const factor = m[1] ? SUFFIX_FACTOR[m[1].toLowerCase()]! : 1
  const scaled = paise * factor
  return Number.isSafeInteger(scaled) ? scaled : null
}

/** "₹50,000" / "₹2,500.50" — whole rupees drop the ".00". */
export function rupeeLabel(paise: number): string {
  return formatPaise(paise, { symbol: true }).replace(/\.00$/, '')
}

/** An `amt:` value → inclusive paise range + chip label. */
export function parseAmountSpec(raw: string): { range: AmountRange; label: string } | null {
  const s = raw.trim()
  if (s.includes('..')) {
    const parts = s.split('..')
    if (parts.length !== 2) return null
    const [a, b] = parts.map((p) => p.trim()) as [string, string]
    const lo = a === '' ? null : parseMoneyValue(a)
    const hi = b === '' ? null : parseMoneyValue(b)
    if ((a !== '' && lo == null) || (b !== '' && hi == null) || (lo == null && hi == null)) return null
    let min = lo
    let max = hi
    if (min != null && max != null && min > max) [min, max] = [max, min]
    const label =
      min != null && max != null
        ? `Amount ${rupeeLabel(min)} – ${rupeeLabel(max)}`
        : min != null
          ? `Amount ≥ ${rupeeLabel(min)}`
          : `Amount ≤ ${rupeeLabel(max!)}`
    return { range: { min, max }, label }
  }
  const m = s.match(/^(>=|<=|>|<|=)?(.+)$/)
  if (!m) return null
  const v = parseMoneyValue(m[2]!)
  if (v == null) return null
  switch (m[1]) {
    case '>':
      return { range: { min: v + 1, max: null }, label: `Amount > ${rupeeLabel(v)}` }
    case '>=':
      return { range: { min: v, max: null }, label: `Amount ≥ ${rupeeLabel(v)}` }
    case '<':
      return v === 0 ? null : { range: { min: null, max: v - 1 }, label: `Amount < ${rupeeLabel(v)}` }
    case '<=':
      return { range: { min: null, max: v }, label: `Amount ≤ ${rupeeLabel(v)}` }
    default:
      return { range: { min: v, max: v }, label: `Amount ${rupeeLabel(v)}` }
  }
}

/** Voucher-type aliases → kind. Values not listed here still match voucher type NAMES. */
const TYPE_ALIASES: Record<string, VoucherKind> = {
  sales: 'sales', sale: 'sales', invoice: 'sales', invoices: 'sales',
  purchase: 'purchase', purchases: 'purchase', bill: 'purchase', bills: 'purchase',
  payment: 'payment', payments: 'payment', pay: 'payment',
  receipt: 'receipt', receipts: 'receipt', rcpt: 'receipt',
  journal: 'journal', journals: 'journal', jv: 'journal', jnl: 'journal',
  contra: 'contra',
  credit_note: 'credit_note', 'credit-note': 'credit_note', creditnote: 'credit_note', credit: 'credit_note', cn: 'credit_note',
  debit_note: 'debit_note', 'debit-note': 'debit_note', debitnote: 'debit_note', debit: 'debit_note', dn: 'debit_note',
  stock_journal: 'stock_journal', 'stock-journal': 'stock_journal', stockjournal: 'stock_journal', manufacture: 'stock_journal',
  physical_stock: 'physical_stock', 'physical-stock': 'physical_stock', physical: 'physical_stock'
}

export const KIND_LABELS: Record<VoucherKind, string> = {
  contra: 'Contra',
  payment: 'Payment',
  receipt: 'Receipt',
  journal: 'Journal',
  sales: 'Sales',
  purchase: 'Purchase',
  credit_note: 'Credit note',
  debit_note: 'Debit note',
  stock_journal: 'Stock journal',
  physical_stock: 'Physical stock'
}

const IN_ALIASES: Record<string, SearchKind> = {
  ledger: 'ledger', ledgers: 'ledger', l: 'ledger', account: 'ledger', accounts: 'ledger',
  item: 'item', items: 'item', i: 'item', stock: 'item',
  voucher: 'voucher', vouchers: 'voucher', v: 'voucher', entries: 'voucher', entry: 'voucher', transactions: 'voucher'
}

const KIND_PLURAL: Record<SearchKind, string> = { ledger: 'ledgers', item: 'items', voucher: 'vouchers' }

/** Token keys (and aliases) the parser understands. */
const KEYS: Record<string, string> = {
  amt: 'amt', amount: 'amt',
  date: 'date', on: 'date',
  fy: 'fy',
  type: 'type', vt: 'type',
  no: 'no', num: 'no', number: 'no',
  gstin: 'gstin', gst: 'gstin',
  pan: 'pan',
  hsn: 'hsn', sac: 'hsn',
  group: 'group', under: 'group',
  party: 'party',
  in: 'in'
}

/** Split into raw tokens: whitespace-separated words, "quoted phrases" and key:"quoted values".
 *  An unterminated quote runs to the end of the input. */
export function tokenize(input: string): { raw: string; key: string | null; value: string; quoted: boolean }[] {
  const out: { raw: string; key: string | null; value: string; quoted: boolean }[] = []
  let i = 0
  const n = input.length
  while (i < n) {
    while (i < n && /\s/.test(input[i]!)) i++
    if (i >= n) break
    const start = i
    if (input[i] === '"') {
      const close = input.indexOf('"', i + 1)
      const end = close < 0 ? n : close
      const value = input.slice(i + 1, end)
      i = close < 0 ? n : close + 1
      if (value.trim() !== '') out.push({ raw: input.slice(start, i), key: null, value: value.trim(), quoted: true })
      continue
    }
    // key:"quoted value"
    const km = input.slice(i).match(/^([A-Za-z]+):"/)
    if (km) {
      const valStart = i + km[0].length
      const close = input.indexOf('"', valStart)
      const end = close < 0 ? n : close
      i = close < 0 ? n : close + 1
      out.push({ raw: input.slice(start, i), key: km[1]!, value: input.slice(valStart, end).trim(), quoted: true })
      continue
    }
    while (i < n && !/\s/.test(input[i]!)) i++
    const word = input.slice(start, i)
    const wm = word.match(/^([A-Za-z]+):(.*)$/)
    if (wm) out.push({ raw: word, key: wm[1]!, value: wm[2]!, quoted: false })
    else out.push({ raw: word, key: null, value: word, quoted: false })
  }
  return out
}

function resolveOptions(o: ParseOptions): Required<ParseOptions> {
  const today = o.today && isValidISODate(o.today) ? o.today : todayISO()
  return { today, fyStartYear: o.fyStartYear ?? fyOf(today).startYear }
}

export function emptyQuery(): ParsedQuery {
  return {
    terms: [], amounts: [], dates: [], types: [], typeKinds: [], numbers: [], gstins: [], pans: [],
    hsns: [], groups: [], parties: [], kinds: null, chips: [], unknown: []
  }
}

/** Parse a search string. Never throws; unparseable `key:value` tokens become free text and are
 *  listed in `unknown`. */
export function parseSearchQuery(input: string, options: ParseOptions = {}): ParsedQuery {
  const opts = resolveOptions(options)
  const q = emptyQuery()
  const tokens = tokenize(input.slice(0, 500))

  const addText = (text: string, phrase: boolean): void => {
    const t = text.trim().toLowerCase()
    if (t === '') return
    const amount = phrase ? null : parseMoneyValue(t)
    q.terms.push({ text: t, phrase, amount })
  }

  for (const tok of tokens) {
    if (tok.key == null) {
      addText(tok.value, tok.quoted)
      const last = q.terms[q.terms.length - 1]
      if (last && last.amount != null && !tok.quoted) {
        q.chips.push({ key: 'bare-amount', label: `or amount ${rupeeLabel(last.amount)}`, raw: tok.raw })
      }
      continue
    }
    const key = KEYS[tok.key.toLowerCase()]
    const value = tok.value.trim()
    const unknown = (): void => {
      // Keys we know but values we don't, and keys we don't know at all, read as plain text.
      q.unknown.push(tok.raw)
      addText(tok.quoted ? `${tok.key}:${tok.value}` : tok.raw, false)
    }
    if (!key || value === '') {
      unknown()
      continue
    }
    switch (key) {
      case 'amt': {
        const a = parseAmountSpec(value)
        if (!a) { unknown(); break }
        q.amounts.push(a.range)
        q.chips.push({ key: 'amount', label: a.label, raw: tok.raw })
        break
      }
      case 'date': {
        const d = parseDateSpec(value, opts)
        if (!d) { unknown(); break }
        q.dates.push(d.range)
        q.chips.push({ key: 'date', label: d.label, raw: tok.raw })
        break
      }
      case 'fy': {
        const d = parseFySpec(value)
        if (!d) { unknown(); break }
        q.dates.push(d.range)
        q.chips.push({ key: 'date', label: d.label, raw: tok.raw })
        break
      }
      case 'type': {
        const values = value.toLowerCase().split(',').map((v) => v.trim()).filter(Boolean)
        if (values.length === 0) { unknown(); break }
        const labels: string[] = []
        for (const v of values) {
          q.types.push(v)
          const kind = TYPE_ALIASES[v]
          if (kind && !q.typeKinds.includes(kind)) q.typeKinds.push(kind)
          labels.push(kind ? KIND_LABELS[kind] : v)
        }
        q.chips.push({ key: 'type', label: `Type: ${labels.join(' or ')}`, raw: tok.raw })
        break
      }
      case 'in': {
        const values = value.toLowerCase().split(/[,|]/).map((v) => v.trim()).filter(Boolean)
        const kinds = values.map((v) => IN_ALIASES[v])
        if (kinds.length === 0 || kinds.some((k) => k == null)) { unknown(); break }
        const set = new Set<SearchKind>([...(q.kinds ?? []), ...(kinds as SearchKind[])])
        q.kinds = (['ledger', 'item', 'voucher'] as SearchKind[]).filter((k) => set.has(k))
        q.chips.push({ key: 'in', label: `Only ${(kinds as SearchKind[]).map((k) => KIND_PLURAL[k]).join(', ')}`, raw: tok.raw })
        break
      }
      case 'no':
        q.numbers.push(value.toLowerCase())
        q.chips.push({ key: 'no', label: `No. ${value}`, raw: tok.raw })
        break
      case 'gstin':
        q.gstins.push(value.toUpperCase())
        q.chips.push({ key: 'gstin', label: `GSTIN ${value.toUpperCase()}`, raw: tok.raw })
        break
      case 'pan':
        q.pans.push(value.toUpperCase())
        q.chips.push({ key: 'pan', label: `PAN ${value.toUpperCase()}`, raw: tok.raw })
        break
      case 'hsn':
        q.hsns.push(value.toLowerCase())
        q.chips.push({ key: 'hsn', label: `HSN ${value}`, raw: tok.raw })
        break
      case 'group':
        q.groups.push(value.toLowerCase())
        q.chips.push({ key: 'group', label: `Group: ${value}`, raw: tok.raw })
        break
      case 'party':
        q.parties.push(value.toLowerCase())
        q.chips.push({ key: 'party', label: `Party: ${value}`, raw: tok.raw })
        break
    }
  }
  return q
}

/** True when the query has nothing to search on (empty, or only an `in:` restriction). */
export function isEmptyQuery(q: ParsedQuery): boolean {
  return (
    q.terms.length === 0 && q.amounts.length === 0 && q.dates.length === 0 && q.types.length === 0 &&
    q.numbers.length === 0 && q.gstins.length === 0 && q.pans.length === 0 && q.hsns.length === 0 &&
    q.groups.length === 0 && q.parties.length === 0
  )
}

/** Which result kinds the query can possibly match. A kind is excluded by `in:` or by a filter on
 *  a field it doesn't have (an amount filter rules out ledgers and items; `gstin:` rules out items). */
export function applicableKinds(q: ParsedQuery): SearchKind[] {
  const voucherOnly = q.amounts.length > 0 || q.dates.length > 0 || q.types.length > 0 || q.numbers.length > 0 || q.parties.length > 0
  const out: SearchKind[] = []
  if (!voucherOnly) out.push('ledger')
  if (!voucherOnly && q.gstins.length === 0 && q.pans.length === 0) out.push('item')
  out.push('voucher')
  return q.kinds ? out.filter((k) => q.kinds!.includes(k)) : out
}

/** Remove one raw token from a query string (chip ✕) — whitespace-normalised. */
export function removeToken(input: string, raw: string): string {
  const tokens = tokenize(input)
  const idx = tokens.findIndex((t) => t.raw === raw)
  if (idx < 0) return input
  return tokens.filter((_, i) => i !== idx).map((t) => t.raw).join(' ')
}

/** A window of `text` around the first occurrence of `needle` (case-insensitive), at most `max`
 *  chars, with ellipses where cut. Falls back to the head of the text. */
export function snippet(text: string, needle: string | null, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const at = needle ? t.toLowerCase().indexOf(needle.toLowerCase()) : -1
  if (at < 0) return t.slice(0, max - 1).trimEnd() + '…'
  const start = Math.max(0, Math.min(at - Math.floor((max - needle!.length) / 3), t.length - max))
  const end = Math.min(t.length, start + max)
  return (start > 0 ? '…' : '') + t.slice(start, end).trim() + (end < t.length ? '…' : '')
}

/** Split `text` into alternating plain / matched segments for highlighting the query's free-text
 *  terms (case-insensitive, longest term first, non-overlapping). */
export function highlightSegments(text: string, needles: string[]): { text: string; match: boolean }[] {
  const ns = [...new Set(needles.map((n) => n.toLowerCase()).filter((n) => n.length > 0))].sort((a, b) => b.length - a.length)
  if (ns.length === 0 || text === '') return [{ text, match: false }]
  const lower = text.toLowerCase()
  const out: { text: string; match: boolean }[] = []
  let i = 0
  let plainStart = 0
  while (i < text.length) {
    const hit = ns.find((n) => lower.startsWith(n, i))
    if (hit) {
      if (i > plainStart) out.push({ text: text.slice(plainStart, i), match: false })
      out.push({ text: text.slice(i, i + hit.length), match: true })
      i += hit.length
      plainStart = i
    } else {
      i++
    }
  }
  if (plainStart < text.length) out.push({ text: text.slice(plainStart), match: false })
  return out
}
