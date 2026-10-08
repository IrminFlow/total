// Privacy transforms for everything the agent sends to the provider (WP 5.1). Pure; unit-tested
// in privacy.test.ts.
//
// - Masking (Settings → AI → "Mask GSTIN, PAN and bank numbers"): GSTINs, PANs, IFSC codes and
//   bank-account-like digit runs (9–18 digits) are replaced by a masked token that keeps only
//   the last characters. Masking is one-way — the model never sees the full identifier.
// - Pseudonymisation ("Replace party names"): every debtor / creditor ledger gets a stable alias
//   ("Party-0007", kept per company in ai_pseudonyms). Names are replaced on the way out and the
//   aliases replaced back on the way in — in streamed text, in tool-call arguments, in the final
//   answer — so the user only ever sees real names and the stored conversation holds them too.

// Case-insensitive: identifiers typed in lower case are masked too.
export const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/gi
export const PAN_RE = /\b[A-Z]{5}\d{4}[A-Z]\b/gi
export const IFSC_RE = /\b[A-Z]{4}0[A-Z0-9]{6}\b/gi
/** 8–18 bare digits not inside a formatted number (amounts are always grouped/decimal), also
 *  written in groups separated by single spaces ("5010 0123 4567 89"). */
export const BANK_ACCOUNT_RE = /(?<![\d.,])(?:\d{8,18}|\d{2,6}(?: \d{2,6}){1,5})(?![\d,]|\.\d)/g

const digitsIn = (s: string): number => s.replace(/\D/g, '').length

const tail = (s: string, n: number): string => s.slice(-n)

/** Mask GSTIN / PAN / IFSC / account numbers in a string. */
export function maskIdentifiers(text: string): string {
  return text
    .replace(GSTIN_RE, (m) => `[GSTIN …${tail(m, 3)}]`)
    .replace(PAN_RE, (m) => `[PAN …${tail(m, 2)}]`)
    .replace(IFSC_RE, (m) => `[IFSC ${m.slice(0, 4)}…]`)
    .replace(BANK_ACCOUNT_RE, (m) => {
      const n = digitsIn(m)
      // A grouped run must still look like an account number (8–18 digits); "2025 07" is not.
      if (n < 8 || n > 18 || (m.includes(' ') && !/^\d{4} /.test(m))) return m
      return `[A/c …${tail(m.replace(/\D/g, ''), 4)}]`
    })
}

/** Apply `fn` to every string inside a JSON-like value (object keys are left alone). */
export function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as T
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = mapStrings(v, fn)
    return out as T
  }
  return value
}

// ---------- pseudonyms ----------

export const ALIAS_PREFIX = 'Party-'
export const ALIAS_RE = /Party-(\d{4})/g

export function aliasFor(seq: number): string {
  return `${ALIAS_PREFIX}${String(seq).padStart(4, '0')}`
}

/** Aliases for parties that have none yet, numbered after the highest one in use. Stable: an
 *  existing alias is never changed, and new ones go in id order. */
export function assignAliases(existing: ReadonlyMap<number, string>, partyIds: readonly number[]): { ledgerId: number; alias: string }[] {
  let next = 0
  for (const a of existing.values()) {
    const m = /^Party-(\d+)$/.exec(a)
    if (m) next = Math.max(next, Number(m[1]))
  }
  return [...partyIds]
    .filter((id) => !existing.has(id))
    .sort((a, b) => a - b)
    .map((ledgerId) => ({ ledgerId, alias: aliasFor(++next) }))
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export interface Pseudonymiser {
  /** Real names → aliases. */
  outbound(text: string): string
  /** Aliases → real names. */
  inbound(text: string): string
  /** A streaming inbound mapper: holds back a possibly-partial alias at the end of a chunk. */
  stream(): { push(delta: string): string; flush(): string }
  readonly size: number
}

/** Names shorter than this are never replaced (too likely to hit ordinary words). */
export const MIN_PSEUDONYM_NAME = 3

/** Word prefixes of a name ("Acme Traders (Pune)" → "Acme Traders", "Acme"), longest first. */
function namePrefixes(name: string): string[] {
  const words = name.trim().split(/\s+/)
  const out: string[] = []
  for (let n = words.length - 1; n >= 1; n--) out.push(words.slice(0, n).join(' ').replace(/[\s,.(&-]+$/, ''))
  return out.filter((p) => p.length >= MIN_PREFIX)
}

/** A partial name ("Acme" for "Acme Traders") is replaced too, when it is unambiguous: at least
 *  this long and the prefix of exactly one party (and not itself another party's full name). */
export const MIN_PREFIX = 4

export function createPseudonymiser(
  entries: readonly { name: string; alias: string }[],
  /** Names of every NON-party ledger and group. They are never touched: a party prefix that is a
   *  substring of one is not aliased ("Cash" of "Cash Traders" vs the Cash ledger), and a whole
   *  reserved name is matched first, so a party name inside it ("Rent" in "Shop Rent") stays. */
  reserved: readonly string[] = []
): Pseudonymiser {
  const usable = entries.filter((e) => e.name.trim().length >= MIN_PSEUDONYM_NAME)
  const byName = new Map(usable.map((e) => [e.name.toLowerCase(), e.alias]))
  const reservedLower = [...new Set(reserved.map((r) => r.trim().toLowerCase()).filter((r) => r.length > 0 && !byName.has(r)))]
  const prefixOwners = new Map<string, Set<string>>()
  for (const e of usable) {
    for (const p of namePrefixes(e.name)) {
      const k = p.toLowerCase()
      prefixOwners.set(k, (prefixOwners.get(k) ?? new Set()).add(e.alias))
    }
  }
  for (const [k, owners] of prefixOwners) {
    if (owners.size !== 1 || byName.has(k)) continue
    if (reservedLower.some((r) => r.includes(k))) continue
    byName.set(k, [...owners][0]!)
  }
  // Only reserved names that contain something we would replace need protecting.
  const keys = [...byName.keys()]
  const shield = new Set(reservedLower.filter((r) => keys.some((k) => r.includes(k))))
  const byAlias = new Map(usable.map((e) => [e.alias, e.name]))
  const names = [...byName.keys(), ...shield].sort((a, b) => b.length - a.length)
  const outRe = names.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null
  const inbound = (text: string): string => text.replace(ALIAS_RE, (m) => byAlias.get(m) ?? m)
  return {
    size: usable.length,
    outbound: (text) => (outRe ? text.replace(outRe, (m) => (shield.has(m.toLowerCase()) ? m : (byName.get(m.toLowerCase()) ?? m))) : text),
    inbound,
    stream() {
      let buf = ''
      // A tail that could still grow into "Party-dddd".
      const partial = /P(?:a(?:r(?:t(?:y(?:-\d{0,3})?)?)?)?)?$/
      return {
        push(delta) {
          buf += delta
          const m = partial.exec(buf)
          const keep = m ? m[0].length : 0
          const ready = buf.slice(0, buf.length - keep)
          buf = buf.slice(buf.length - keep)
          return inbound(ready)
        },
        flush() {
          const rest = inbound(buf)
          buf = ''
          return rest
        }
      }
    }
  }
}

export interface PrivacyOptions {
  maskIds: boolean
  pseudonymiser: Pseudonymiser | null
}

/** The outbound transform for one string: pseudonymise first (a party name may contain digits
 *  a mask would otherwise split), then mask. */
export function outboundText(text: string, opts: PrivacyOptions): string {
  let t = opts.pseudonymiser ? opts.pseudonymiser.outbound(text) : text
  if (opts.maskIds) t = maskIdentifiers(t)
  return t
}

export function inboundText(text: string, opts: PrivacyOptions): string {
  return opts.pseudonymiser ? opts.pseudonymiser.inbound(text) : text
}
