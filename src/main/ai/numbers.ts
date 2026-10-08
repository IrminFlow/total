// The numbers rule, checked (WP 5.1): the model must never compute money — every amount in an
// answer has to be quoted from a tool result. After each answer the agent extracts the
// money-looking figures and looks each one up in the tool results THE MODEL ACTUALLY SAW in this
// conversation (the post-truncation, post-privacy text sent to it, across the whole thread); the
// panel warns about any figure it cannot find. Pure; tested in core.test.ts.
//
// Recognised: ₹ / Rs / INR prefixed amounts; "<n> rupees|Rs|INR"; Indian and Western grouping;
// two-decimal numbers; Indian shorthand (₹1.2L, 1.2 lakh, 3.4Cr, 2 crore, 5k, 12 thousand);
// Dr / Cr suffixed or prefixed figures; and bare integers ≥ 1,000 next to a money word ("balance
// 25000", "paid 5000"). Bare integers elsewhere (years, counts, ids, days) are not money.
import { parseRupees } from '@shared/money'
import type { AiFigure, AiSource } from '@shared/ai'

export interface ExtractedFigure {
  text: string
  paise: number
  /** Shorthand (1.2L) — matches a source within half a unit of its last digit. */
  tolerancePaise: number
}

const CURRENCY = String.raw`(?:₹|\bRs\.?|\bINR\b)`
const NUM = String.raw`\d[\d,]*(?:\.\d+)?`
// A spaced "Cr" is the credit side ("25,000 Cr"); crore needs "3.4Cr", "3.4 cr" or "crore".
const SCALE = String.raw`(?:\s?(?:[Ll]akhs?|[Ll]acs?|[Cc]rores?|cr|[Tt]housand)|(?:Cr|L|k|K))`
const MONEY_WORDS = /\b(?:dr|cr|rs\.?|inr|rupees?|amount|amounts|balance|balances|total|totals|paid|pay|payment|payments|received|receipt|receipts|sales?|purchases?|outstanding|due|owes?|owed|profit|loss|income|expenses?|cost|value|worth|tax|gst|tds|debit|credit|of)\s*[:=]?\s*$/i
const AFTER_MONEY = /^\s*(?:dr\b|cr\b|rupees?\b|rs\b|inr\b|\/-)/i

const FIGURE_RE = new RegExp(
  [
    // ₹ 1.2 lakh / Rs. 5k / ₹1,23,456.00 / INR 500000 / -₹2,000
    String.raw`-?${CURRENCY}\s?-?${NUM}(?:${SCALE}\b)?`,
    // 1.2 lakh / 3.4Cr / 5k (no currency; the scale word makes it money)
    String.raw`-?\d+(?:\.\d+)?${SCALE}\b`,
    // 1,23,456.00 / 1,000
    String.raw`-?\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?`,
    // 1234.50
    String.raw`-?\d+\.\d{2}(?!\d)`,
    // bare integers (kept only when next to a money word, see below)
    String.raw`-?\d{4,}`
  ].join('|'),
  'g'
)

function scaleOf(word: string): number {
  const w = word.toLowerCase()
  if (w.startsWith('cr')) return 10_000_000
  if (w.startsWith('l')) return 100_000 // lakh, lac, L
  if (w === 'k' || w.startsWith('thousand')) return 1_000
  return 1
}

export function extractFigures(text: string): ExtractedFigure[] {
  const out: ExtractedFigure[] = []
  for (const m of text.matchAll(FIGURE_RE)) {
    const raw = m[0]
    const at = m.index ?? 0
    const before = text.slice(Math.max(0, at - 1), at)
    const after = text.slice(at + raw.length, at + raw.length + 2)
    // Percentages, dates (01.07.2025, 2025-07-31), versions, ids glued to letters are not money.
    if (/^%|^\.\d|^-\d|^[A-Za-z0-9]/.test(after)) continue
    if (/[\dA-Za-z.\-/_]/.test(before) && !/^-?(₹|Rs|INR)/.test(raw)) continue
    const hasCurrency = /₹|\bRs\.?|\bINR\b/.test(raw)
    const scaleMatch = /(lakhs?|lacs?|crores?|cr|thousand|L|k|K)$/i.exec(raw.replace(/\s+$/, ''))
    const scale = scaleMatch ? scaleOf(scaleMatch[1]!) : 1
    const numText = raw.replace(/₹|\bRs\.?|\bINR\b/g, '').replace(/(lakhs?|lacs?|crores?|cr|thousand|L|k|K)$/i, '').replace(/\s/g, '').replace(/^--/, '-')
    const isBareInt = /^-?\d{4,}$/.test(numText) && !hasCurrency && scale === 1
    if (isBareInt) {
      const ctxBefore = text.slice(Math.max(0, at - 24), at)
      const ctxAfter = text.slice(at + raw.length, at + raw.length + 12)
      if (!MONEY_WORDS.test(ctxBefore) && !AFTER_MONEY.test(ctxAfter)) continue
      if (/^(19|20)\d{2}$/.test(numText) && !AFTER_MONEY.test(ctxAfter) && !/₹|rs|inr|rupee/i.test(ctxBefore)) continue // a year
    }
    // Decimals beyond paise only make sense with a scale (1.25 lakh).
    const [whole = '0', frac = ''] = numText.replace(/,/g, '').replace('-', '').split('.')
    let paise: number | null
    let tolerance = 0
    if (scale > 1) {
      // value = whole.frac × scale rupees, in exact integer maths
      const digits = frac.length
      const unitsTimes10 = BigInt(whole + frac) // whole.frac × 10^digits
      const paiseBig = (unitsTimes10 * BigInt(scale) * 100n) / 10n ** BigInt(digits)
      paise = Number(paiseBig) * (numText.startsWith('-') ? -1 : 1)
      // ±half of the last stated digit (1.2L → ±₹5,000)
      tolerance = Number((BigInt(scale) * 100n) / 10n ** BigInt(digits) / 2n)
    } else {
      if (frac.length > 2) continue
      paise = parseRupees(numText)
    }
    if (paise === null || !Number.isSafeInteger(paise)) continue
    out.push({ text: raw.trim(), paise, tolerancePaise: tolerance })
  }
  return out
}

/** A figure the model saw: text it was sent, under the tool that produced it. */
export interface SeenResult {
  name: string
  text: string
}

/** Each figure in `answer`, sourced when the same absolute amount (or, for shorthand, one within
 *  its rounding) appears in a result the model saw. */
export function checkFigures(answer: string, seen: readonly SeenResult[], origins: readonly FigureOrigin[] = []): AiFigure[] {
  const known: { paise: number; tool: string }[] = []
  for (const r of seen) for (const f of extractFigures(r.text)) known.push({ paise: Math.abs(f.paise), tool: r.name })
  return extractFigures(answer).map((f) => {
    const target = Math.abs(f.paise)
    const exact = known.find((k) => k.paise === target)
    const near = exact ?? (f.tolerancePaise > 0 ? known.find((k) => Math.abs(k.paise - target) <= f.tolerancePaise) : undefined)
    // Same tool first (newest result first), then any result holding the amount.
    const source = near ? locateFigureSource(near.paise, [...origins.filter((o) => o.tool === near.tool), ...origins.filter((o) => o.tool !== near.tool)]) : undefined
    return {
      text: f.text,
      paise: f.paise,
      sourced: !!near,
      tool: near?.tool ?? null,
      ...(near && !exact ? { approximate: true } : {}),
      ...(source ? { source } : {})
    }
  })
}

// ---------- where a sourced figure came from (WP 5.2: figures render as chips linking there) ----------

/** A tool result as stored locally: real (unmasked) output and the sources the tool returned. */
export interface FigureOrigin {
  tool: string
  output: unknown
  sources: readonly AiSource[]
}

/** `weak`: the amount is only a running balance there (a statement's last row repeats the
 *  closing balance — the ledger is the better source than that voucher). */
type Hit = { depth: number; obj: Record<string, unknown>; weak: boolean }
const RUNNING_KEYS = new Set(['balance', 'running', 'runningBalance'])

function figuresIn(value: unknown): number[] {
  return typeof value === 'string' ? extractFigures(value).map((f) => Math.abs(f.paise)) : []
}

/** Objects that hold a string containing the amount directly, with their depth. */
function objectsWith(value: unknown, paise: number, depth = 0, out: Hit[] = []): Hit[] {
  if (depth > 12 || value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const v of value) objectsWith(v, paise, depth + 1, out)
    return out
  }
  const obj = value as Record<string, unknown>
  const keys = Object.entries(obj).filter(([, v]) => figuresIn(v).includes(paise)).map(([k]) => k)
  if (keys.length) out.push({ depth, obj, weak: keys.every((k) => RUNNING_KEYS.has(k)) })
  for (const v of Object.values(obj)) if (v !== null && typeof v === 'object') objectsWith(v, paise, depth + 1, out)
  return out
}

const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null)
const firstText = (...vs: unknown[]): string | null => {
  for (const v of vs) if (typeof v === 'string' && v.trim()) return v.trim()
  return null
}

/** The source of the deepest row holding the amount — its voucher, ledger or item, labelled from
 *  the tool's own sources when listed there — else the tool's screen. Pure; tested. */
export function locateFigureSource(paise: number, origins: readonly FigureOrigin[]): AiSource | undefined {
  const target = Math.abs(paise)
  for (const o of origins) {
    const hits = objectsWith(o.output, target).sort((a, b) => Number(a.weak) - Number(b.weak) || b.depth - a.depth)
    for (const { obj } of hits) {
      const voucherId = posInt(obj.voucherId)
      if (voucherId) {
        const known = o.sources.find((s) => s.kind === 'voucher' && s.voucherId === voucherId)
        const type = firstText(obj.type, obj.voucherType)
        const number = firstText(obj.number)
        return { kind: 'voucher', voucherId, label: known?.label ?? (type && number ? `${type} ${number}` : `Voucher ${voucherId}`) }
      }
      const ledgerId = posInt(obj.ledgerId)
      if (ledgerId) {
        const known = o.sources.find((s) => s.kind === 'ledger' && s.ledgerId === ledgerId)
        return { kind: 'ledger', ledgerId, label: known?.label ?? firstText(obj.ledger, obj.party, obj.name) ?? `Ledger ${ledgerId}` }
      }
      const itemId = posInt(obj.itemId)
      if (itemId) {
        const known = o.sources.find((s) => s.kind === 'item' && s.itemId === itemId)
        return { kind: 'item', itemId, label: known?.label ?? firstText(obj.item, obj.name) ?? `Item ${itemId}` }
      }
    }
    if (hits.length) return o.sources.find((s) => s.kind === 'screen') ?? o.sources[0]
  }
  return undefined
}
