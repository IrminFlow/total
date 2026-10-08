// Privacy for what the MCP server returns (WP 5.7 review): masking by FIELD, never "every string".
// The in-app agent's maskIdentifiers treats any 8–18 digit run as a bank account, which is right
// for prose sent to a model but mangles structured books data: HSN "99831100", voucher numbers
// "INV-20250415" / "2025-26/00012345", line uids "3f0912345678…". Here:
//   - identifier fields (gstin, pan, tan, ifsc, udyam, bank account …) are always masked;
//   - code / number / id / date fields are never touched (not masked, not pseudonymised);
//   - everything else is free text (names, narrations, addresses): party names pseudonymised when
//     asked, GSTIN / PAN / IFSC patterns masked, and a digit run counts as an account number only
//     when it stands alone — 9–18 digits with no letter, digit, '/' or '-' next to it.
// Pure; tested in mask.test.ts.
import { GSTIN_RE, IFSC_RE, PAN_RE, type PrivacyOptions } from '../ai/privacy'

/** Keys whose value IS an identifier: masked whenever masking is on. */
// "account" alone is a ledger name (day book's main account), never an identifier: an account
// NUMBER needs a bank prefix or a number suffix.
const ID_KEY = /^(gstin|pan|tan|ifsc|ifsccode|udyam(no|number)?|aadhaar|bank(account|acct|ac)\w*|(account|acct|ac)(no|number|num)\w*)$/i
/** Keys whose value is a code, number, id, date or enum — returned verbatim. */
const KEEP_KEY =
  /^(hsn|sac|hsnsac|number|vouchernumber|billno|billname|lineuid|uid|id|\w*id|\w*ids|date|\w*date|\w*at|statecode|state_code|state|pos|posoverride|currencycode|unit|symbol|kind|\w*kind|status|drcr|sha256|\w*sha256|storedpath|schemaversion|from|to|ason|fy|period|type|mime)$/i

const tail = (s: string, n: number): string => s.slice(-n)

/** A stand-alone account-like digit run in free text: 9–18 digits (or 4-digit-led groups), with
 *  no letter / digit / '/' / '-' / '.' / ',' on either side. */
const FREE_ACCOUNT_RE = /(?<![\p{L}\p{N}/\-.,])(?:\d{9,18}|\d{4}(?: \d{2,6}){1,4})(?![\p{L}\p{N}/\-,]|\.\d)/gu

export function maskFreeText(text: string): string {
  return text
    .replace(GSTIN_RE, (m) => `[GSTIN …${tail(m, 3)}]`)
    .replace(PAN_RE, (m) => `[PAN …${tail(m, 2)}]`)
    .replace(IFSC_RE, (m) => `[IFSC ${m.slice(0, 4)}…]`)
    .replace(FREE_ACCOUNT_RE, (m) => {
      const digits = m.replace(/\D/g, '')
      if (digits.length < 9 || digits.length > 18) return m
      return `[A/c …${tail(digits, 4)}]`
    })
}

/** An identifier field's value, masked whatever its shape. */
export function maskIdentifierValue(key: string, text: string): string {
  if (!text.trim()) return text
  const k = key.toLowerCase()
  if (k === 'gstin') return `[GSTIN …${tail(text.trim(), 3)}]`
  if (k === 'pan' || k === 'tan') return `[${k.toUpperCase()} …${tail(text.trim(), 2)}]`
  if (k.startsWith('ifsc')) return `[IFSC ${text.trim().slice(0, 4)}…]`
  return `[${k.startsWith('udyam') ? 'Udyam' : k === 'aadhaar' ? 'Aadhaar' : 'A/c'} …${tail(text.replace(/\W/g, ''), 4)}]`
}

export type FieldKind = 'id' | 'keep' | 'text'

export function fieldKind(key: string | null): FieldKind {
  if (key === null) return 'text'
  const k = key.replace(/[\s-]/g, '_').replace(/_/g, '')
  if (ID_KEY.test(k)) return 'id'
  if (KEEP_KEY.test(k)) return 'keep'
  return 'text'
}

/** One string value under `key` (null = no key, e.g. a top-level string). */
export function mcpMaskString(text: string, key: string | null, p: PrivacyOptions): string {
  const kind = fieldKind(key)
  if (kind === 'keep') return text
  if (kind === 'id') return p.maskIds ? maskIdentifierValue(key!, text) : text
  const named = p.pseudonymiser ? p.pseudonymiser.outbound(text) : text
  return p.maskIds ? maskFreeText(named) : named
}

/** Every string inside a JSON-like value, by the key it sits under (array items inherit it). */
export function mcpMaskValue<T>(value: T, p: PrivacyOptions, key: string | null = null): T {
  if (typeof value === 'string') return mcpMaskString(value, key, p) as T
  if (Array.isArray(value)) return value.map((v) => mcpMaskValue(v, p, key)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = mcpMaskValue(v, p, k)
    return out as T
  }
  return value
}

/** Printable, length-capped client name for the log, the draft origin and the editor banner (a
 *  client names itself). */
export function cleanClientName(name: string | null | undefined): string | null {
  if (!name) return null
  const clean = name.replace(/[^\p{L}\p{N} ._@()+:-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60)
  return clean || null
}
