/**
 * Redaction applied to every tool result before it can leave the machine.
 *
 * Two layers:
 *
 *  1. Always, with no toggle: identifiers and contact details. A GST question never needs a
 *     party's PAN or bank account, so those simply never go. GSTINs keep their state code and
 *     check character because those are the only parts a GST question can turn on.
 *  2. Optionally, `names-redacted` mode: ledger and party names become stable codes for a user
 *     sending a client's books to a third-party endpoint. This is a real quality trade, which is
 *     why it is not the default — see config.ts.
 *
 * Applied centrally in tool dispatch rather than per tool, so a new tool cannot forget it.
 */

/** Field names whose values never leave the machine, at any nesting depth. */
export const REDACTED_KEYS = new Set([
  'pan',
  'aadhaar',
  'accountno',
  'accountnumber',
  'bankaccount',
  'ifsc',
  'pin',
  'pinhash',
  'password',
  'clientsecret',
  'publickeypem',
  'apikey',
  'email',
  'phone',
  'mobile'
])

/** Keys holding a GSTIN, which is partially preserved rather than dropped. */
const GSTIN_KEYS = new Set(['gstin', 'ctin', 'buyergstin', 'sellergstin'])

/**
 * 27AAPFU0939F1ZV -> 27••••••••••1ZV
 *
 * A GSTIN is 2 state code + 10 PAN + 1 entity number + 'Z' + 1 check character. The embedded PAN
 * is the identifying part, so that is what goes; the state code stays because place of supply is
 * a real GST question, and the trailing three stay because they are not identifying.
 */
export function maskGstin(value: string): string {
  if (value.length !== 15) return '•'.repeat(Math.min(value.length, 15))
  return `${value.slice(0, 2)}${'•'.repeat(10)}${value.slice(12)}`
}

function redactValue(key: string, value: unknown): unknown {
  const lower = key.toLowerCase()
  if (GSTIN_KEYS.has(lower)) return typeof value === 'string' && value ? maskGstin(value) : value
  if (REDACTED_KEYS.has(lower)) return value == null || value === '' ? value : '[redacted]'
  return undefined
}

/** Deep-redact a tool result. Arrays and nested objects are walked; other values pass through. */
export function redact<T>(input: T): T {
  if (Array.isArray(input)) return input.map((v) => redact(v)) as unknown as T
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const replaced = redactValue(key, value)
      out[key] = replaced !== undefined ? replaced : redact(value)
    }
    return out as T
  }
  return input
}

/**
 * Reversible name substitution for `names-redacted` mode.
 *
 * The map is per-run and lives only in main, so codes mean nothing to the endpoint and the real
 * names are restored before anything reaches the user — including inside the answer text and any
 * proposed voucher draft, which is why `restore` works on arbitrary strings rather than fields.
 */
export class Pseudonymiser {
  private toCode = new Map<string, string>()
  private toName = new Map<string, string>()

  code(name: string): string {
    const existing = this.toCode.get(name)
    if (existing) return existing
    const code = `Party ${this.toCode.size + 1}`
    this.toCode.set(name, code)
    this.toName.set(code, name)
    return code
  }

  /** Replace every known name in a string with its code. Longest first, so "Acme Ltd" is not
   *  half-replaced by a shorter "Acme". */
  apply(text: string): string {
    let out = text
    for (const name of [...this.toCode.keys()].sort((a, b) => b.length - a.length)) {
      out = out.split(name).join(this.toCode.get(name)!)
    }
    return out
  }

  restore(text: string): string {
    let out = text
    for (const code of [...this.toName.keys()].sort((a, b) => b.length - a.length)) {
      out = out.split(code).join(this.toName.get(code)!)
    }
    return out
  }

  get size(): number {
    return this.toCode.size
  }
}
