// ICU-lite message formatting for the i18n catalogues (WP 8.2). Pure — no DOM, no Electron.
//
// Supported syntax (a deliberate subset of ICU MessageFormat):
//   {name}                                      value of `name` (string, or a number printed as-is)
//   {count, plural, =0 {none} one {# bill} other {# bills}}
//                                               `=N` exact matches first, then the CLDR category of
//                                               the language (Intl.PluralRules); `#` is the number
//   {kind, select, cash {Cash} other {Bank}}    string match, else `other`
// Branches nest (a `#` inside a select inside a plural is the plural's number). There is no
// apostrophe escaping: a catalogue value never needs a literal brace.
//
// Numbers are inserted with String(n) — money and Indian digit grouping stay in money.ts, so a
// caller passes an amount already formatted (formatPaise / formatPaiseCompact) as a string.

export type MessageVars = Record<string, string | number>

type Part =
  | { kind: 'text'; text: string }
  | { kind: 'var'; name: string }
  | { kind: 'pound' }
  | { kind: 'plural'; name: string; branches: Map<string, Part[]> }
  | { kind: 'select'; name: string; branches: Map<string, Part[]> }

export class MessageSyntaxError extends Error {}

/** Parses a message into parts. Throws MessageSyntaxError on unbalanced braces, an unknown
 *  argument type, or a plural / select without an `other` branch (the catalogue test parses
 *  every value, so a broken message never ships). */
export function parseMessage(message: string): Part[] {
  let pos = 0

  const skipSpace = (): void => {
    while (pos < message.length && /\s/.test(message[pos]!)) pos++
  }

  const readToken = (): string => {
    skipSpace()
    const start = pos
    while (pos < message.length && !/[\s,{}]/.test(message[pos]!)) pos++
    return message.slice(start, pos)
  }

  const expect = (ch: string): void => {
    skipSpace()
    if (message[pos] !== ch) throw new MessageSyntaxError(`Expected "${ch}" at ${pos} in "${message}"`)
    pos++
  }

  const parseParts = (inPlural: boolean, nested: boolean): Part[] => {
    const parts: Part[] = []
    let text = ''
    const flush = (): void => {
      if (text) parts.push({ kind: 'text', text })
      text = ''
    }
    while (pos < message.length) {
      const ch = message[pos]!
      if (ch === '}') {
        if (!nested) throw new MessageSyntaxError(`Unexpected "}" at ${pos} in "${message}"`)
        break
      }
      if (ch === '{') {
        flush()
        pos++
        parts.push(parseArgument(inPlural))
        continue
      }
      if (ch === '#' && inPlural) {
        flush()
        parts.push({ kind: 'pound' })
        pos++
        continue
      }
      text += ch
      pos++
    }
    if (nested && pos >= message.length) throw new MessageSyntaxError(`Unclosed "{" in "${message}"`)
    flush()
    return parts
  }

  const parseArgument = (inPlural: boolean): Part => {
    const name = readToken()
    if (!name) throw new MessageSyntaxError(`Empty argument at ${pos} in "${message}"`)
    skipSpace()
    if (message[pos] === '}') {
      pos++
      return { kind: 'var', name }
    }
    expect(',')
    const type = readToken()
    if (type !== 'plural' && type !== 'select') throw new MessageSyntaxError(`Unknown argument type "${type}" in "${message}"`)
    expect(',')
    const branches = new Map<string, Part[]>()
    for (;;) {
      skipSpace()
      if (pos >= message.length) throw new MessageSyntaxError(`Unclosed ${type} in "${message}"`)
      if (message[pos] === '}') {
        pos++
        break
      }
      const key = readToken()
      if (!key) throw new MessageSyntaxError(`Expected a branch key at ${pos} in "${message}"`)
      expect('{')
      branches.set(key, parseParts(type === 'plural' || inPlural, true))
      expect('}')
    }
    if (!branches.has('other')) throw new MessageSyntaxError(`"${name}" ${type} has no "other" branch in "${message}"`)
    return { kind: type, name, branches }
  }

  return parseParts(false, false)
}

// Plural categories per catalogue language. Hinglish follows English plural forms.
const PLURAL_LOCALE: Record<string, string> = { en: 'en-IN', hi: 'hi-IN', hinglish: 'en-IN' }
const pluralRules = new Map<string, Intl.PluralRules>()
function pluralCategory(lang: string, n: number): string {
  const locale = PLURAL_LOCALE[lang] ?? 'en-IN'
  let rules = pluralRules.get(locale)
  if (!rules) {
    rules = new Intl.PluralRules(locale)
    pluralRules.set(locale, rules)
  }
  return rules.select(n)
}

export interface FormatResult {
  text: string
  /** Variables the message referenced that the caller did not pass (rendered as ''). */
  missingVars: string[]
}

const parsedCache = new Map<string, Part[]>()

export function formatMessage(message: string, vars: MessageVars | undefined, lang: string): FormatResult {
  let parts = parsedCache.get(message)
  if (!parts) {
    parts = parseMessage(message)
    parsedCache.set(message, parts)
  }
  const missingVars: string[] = []
  const render = (list: Part[], pound: number | null): string => {
    let out = ''
    for (const p of list) {
      if (p.kind === 'text') out += p.text
      else if (p.kind === 'pound') out += pound == null ? '#' : String(pound)
      else if (p.kind === 'var') {
        const v = vars?.[p.name]
        if (v == null) missingVars.push(p.name)
        else out += String(v)
      } else {
        const v = vars?.[p.name]
        if (v == null) missingVars.push(p.name)
        if (p.kind === 'plural') {
          const n = typeof v === 'number' ? v : Number(v ?? 0)
          const branch = p.branches.get(`=${n}`) ?? p.branches.get(pluralCategory(lang, n)) ?? p.branches.get('other')!
          out += render(branch, n)
        } else {
          const branch = p.branches.get(String(v ?? 'other')) ?? p.branches.get('other')!
          out += render(branch, pound)
        }
      }
    }
    return out
  }
  return { text: render(parts, null), missingVars }
}

/** Every variable name a message uses, sorted (the catalogue test checks a translation uses
 *  exactly the variables of its `en` original). */
export function messageVariables(message: string): string[] {
  const names = new Set<string>()
  const walk = (list: Part[]): void => {
    for (const p of list) {
      if (p.kind === 'var') names.add(p.name)
      else if (p.kind === 'plural' || p.kind === 'select') {
        names.add(p.name)
        for (const b of p.branches.values()) walk(b)
      }
    }
  }
  walk(parseMessage(message))
  return [...names].sort()
}
