/**
 * Citations: turning "[tb:17]" in an answer into somewhere the user can go.
 *
 * Every row a tool returns carries a `ref`, and the system prompt requires the model to put that
 * ref in brackets after any figure it quotes. That was already the verification story — the
 * sources block underneath an answer is rendered from the tool results, so an uncited number has
 * visibly nothing behind it.
 *
 * A ref that is only ever read is half the value. The point of citing a trial-balance row is to
 * be able to open that ledger and see the figure for yourself, in the screen that owns it, computed
 * by the same code that computed the answer. So refs parse to navigation targets here, in shared,
 * with no renderer types involved — the mapping is a rule about the ref grammar, and it is worth
 * testing exhaustively.
 *
 * A ref the parser does not recognise is left as literal text. A model that invents "[q4:99]"
 * should produce a dead string the reader can see, never a plausible-looking link to nowhere.
 */

export type CitationTarget =
  | { kind: 'ledger'; ledgerId: number }
  | { kind: 'voucher'; voucherId: number }
  | { kind: 'stock-item' }
  | { kind: 'registers' }
  | { kind: 'exceptions' }

export interface Citation {
  /** The ref exactly as it appeared, without brackets: `tb:17`. */
  ref: string
  target: CitationTarget
  /** What the link says it will open, e.g. "ledger". */
  label: string
}

export type AnswerSegment = { type: 'text'; text: string } | ({ type: 'citation' } & Citation)

/**
 * Bracketed refs. The prefix set is closed on purpose — see the header: an unknown prefix must
 * fall through to plain text rather than being guessed at.
 */
const REF_RE = /\[([a-z]{1,4}):([A-Za-z0-9_:-]{1,40})\]/g

export function resolveRef(prefix: string, rest: string): Citation | null {
  const ref = `${prefix}:${rest}`
  const num = (s: string): number | null => (/^\d+$/.test(s) ? Number(s) : null)

  switch (prefix) {
    // A trial-balance row and a find_ledger hit both point at one ledger's statement.
    case 'tb':
    case 'l': {
      const id = num(rest)
      return id == null ? null : { ref, target: { kind: 'ledger', ledgerId: id }, label: 'ledger' }
    }
    case 'v': {
      const id = num(rest)
      return id == null ? null : { ref, target: { kind: 'voucher', voucherId: id }, label: 'voucher' }
    }
    // p:<ledgerId>:<period> — a bucketed ledger statement. The period is a filter the statement
    // screen does not take, so the link opens the ledger and lets the user pick the month.
    case 'p': {
      const id = num(rest.split(':')[0] ?? '')
      return id == null ? null : { ref, target: { kind: 'ledger', ledgerId: id }, label: 'ledger' }
    }
    case 'i':
      return { ref, target: { kind: 'stock-item' }, label: 'stock' }
    case 'reg':
      return { ref, target: { kind: 'registers' }, label: 'register' }
    case 'ex':
      return { ref, target: { kind: 'exceptions' }, label: 'exceptions' }
    default:
      return null
  }
}

/**
 * Split an answer into text and citation segments, in order.
 *
 * Streaming-safe: the drawer re-parses the whole answer on every delta, so a ref split across
 * two chunks simply becomes a link once its closing bracket arrives. That is why this takes the
 * full text rather than being incremental.
 */
export function parseAnswer(text: string): AnswerSegment[] {
  const segments: AnswerSegment[] = []
  let last = 0
  REF_RE.lastIndex = 0

  for (let m = REF_RE.exec(text); m !== null; m = REF_RE.exec(text)) {
    const citation = resolveRef(m[1]!, m[2]!)
    if (!citation) continue
    if (m.index > last) segments.push({ type: 'text', text: text.slice(last, m.index) })
    segments.push({ type: 'citation', ...citation })
    last = m.index + m[0].length
  }
  if (last < text.length) segments.push({ type: 'text', text: text.slice(last) })
  return segments
}

/** Every resolvable ref in an answer, de-duplicated, in order of first appearance. */
export function citationsIn(text: string): Citation[] {
  const seen = new Set<string>()
  const out: Citation[] = []
  for (const seg of parseAnswer(text)) {
    if (seg.type !== 'citation' || seen.has(seg.ref)) continue
    seen.add(seg.ref)
    out.push({ ref: seg.ref, target: seg.target, label: seg.label })
  }
  return out
}
