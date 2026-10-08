/**
 * SWIFT MT940 "Customer Statement Message" reader (WP 4.1).
 *
 * Field layout per the SWIFT Standards MT Category 9 message reference for MT940, as republished
 * in banks' public format descriptions (e.g. mBank "Description of the MT940 daily statement
 * file format", UBB "SWIFT messages MT940 technical specifications", ČSOB "SWIFT format
 * description MT940"):
 *   :20:  transaction reference          :25:  account identification
 *   :28C: statement / sequence number    :60F: / :60M: opening balance  D|C YYMMDD CCY amount
 *   :61:  statement line                 :86:  information to account owner (narrative, ≤ 6×65)
 *   :62F: / :62M: closing balance        :64:  closing available balance
 * :61: subfields — 6!n value date YYMMDD · [4!n] entry date MMDD · 2a D/C mark (D, C, RD
 *   reversal of debit, RC reversal of credit) · [1!a] funds code (3rd letter of the currency) ·
 *   15d amount with ',' as the decimal mark · 1!a3!c transaction type (N/F/S + 3-char code) ·
 *   16x reference for the account owner ('NONREF' when none) · [//16x] account servicing
 *   institution's reference · [34x] supplementary details on the next line.
 * Amounts always use ',' as the decimal separator. An :86: after a :61: describes that line;
 * structured :86: sub-field markers (`?20`, `?21` … used by some banks) are flattened to spaces.
 * The SWIFT block wrapper ({1:…}{2:…}{4: … -}) is tolerated.
 */
import { parseBankAmount } from './quirks'
import type { ParsedStatement, StatementLine } from './types'

const yymmdd = (s: string): string => {
  const y = Number(s.slice(0, 2))
  // SWIFT years are 2-digit; 70–99 are 19xx, the rest 20xx.
  return `${y >= 70 ? 1900 + y : 2000 + y}-${s.slice(2, 4)}-${s.slice(4, 6)}`
}

/** True when the text looks like MT940 (has :20:/:25: and at least one :61: or :60F:). */
export function looksLikeMt940(text: string): boolean {
  return /(^|\n)\s*:20:/.test(text) && /(^|\n)\s*:(61|60F|60M):/.test(text)
}

function tags(text: string): { tag: string; value: string }[] {
  const body = text
    .replace(/\r\n?/g, '\n')
    .replace(/\{[1-3]:[^}]*\}/g, '')
    .replace(/\{4:\s*\n?/g, '')
    .replace(/\n-\}?\s*(?=\n|$)/g, '\n')
  const out: { tag: string; value: string }[] = []
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const m = line.match(/^:(\d{2}[A-Z]?):(.*)$/)
    if (m) out.push({ tag: m[1]!, value: m[2]! })
    else if (out.length > 0 && line.trim() && line.trim() !== '-' && line.trim() !== '-}') out[out.length - 1]!.value += `\n${line}`
  }
  return out
}

function balance(value: string): { paise: number; currency: string } | null {
  const m = value.trim().match(/^([DC])(\d{6})([A-Z]{3})([\d,]+)/)
  if (!m) return null
  const amt = parseBankAmount(m[4]!, true)
  if (!amt) return null
  return { paise: m[1] === 'D' ? -amt.paise : amt.paise, currency: m[3]! }
}

const LINE61 = /^(\d{6})(\d{4})?(RD|RC|D|C)([A-Z])?(\d+,\d{0,2})([NFS][A-Z0-9]{3})([^\n]*?)(?:\/\/([^\n]*))?(?:\n([\s\S]*))?$/

export function parseMt940(text: string): ParsedStatement {
  const lines: StatementLine[] = []
  const warnings: string[] = []
  let account: string | null = null
  let currency: string | null = null
  let openingBalance: number | null = null
  let closingBalance: number | null = null
  let current: StatementLine | null = null
  let bad = 0
  for (const { tag, value } of tags(text)) {
    if (tag === '25') account = account ?? value.trim()
    else if (tag === '60F' || (tag === '60M' && openingBalance == null)) {
      const b = balance(value)
      if (b) {
        if (openingBalance == null) openingBalance = b.paise
        currency = currency ?? b.currency
      }
    } else if (tag === '62F' || tag === '62M') {
      const b = balance(value)
      if (b) closingBalance = b.paise
    } else if (tag === '61') {
      const m = value.match(LINE61)
      if (!m) {
        bad++
        current = null
        continue
      }
      const valueDate = yymmdd(m[1]!)
      let date = valueDate
      if (m[2]) {
        // Entry date MMDD takes the value date's year, nudged across a year boundary.
        let y = Number(valueDate.slice(0, 4))
        const vm = Number(valueDate.slice(5, 7))
        const em = Number(m[2].slice(0, 2))
        if (vm === 12 && em === 1) y++
        else if (vm === 1 && em === 12) y--
        date = `${y}-${m[2].slice(0, 2)}-${m[2].slice(2, 4)}`
      }
      const amt = parseBankAmount(m[5]!, true)
      const mark = m[3]!
      // RD (reversal of a debit) puts money back in; RC (reversal of a credit) takes it out.
      const isCredit = mark === 'C' || mark === 'RD'
      const ownerRef = (m[7] ?? '').trim()
      const bankRef = (m[8] ?? '').trim()
      const supplementary = (m[9] ?? '').replace(/\n/g, ' ').trim()
      current = {
        date,
        valueDate,
        description: supplementary,
        reference: ownerRef && ownerRef.toUpperCase() !== 'NONREF' ? ownerRef : bankRef,
        deposit: isCredit ? Math.abs(amt?.paise ?? 0) : 0,
        withdrawal: isCredit ? 0 : Math.abs(amt?.paise ?? 0),
        balance: null
      }
      lines.push(current)
    } else if (tag === '86' && current) {
      const narrative = value.replace(/\?\d{2}/g, ' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
      current.description = [narrative, current.description].filter(Boolean).join(' ').trim()
      current = null
    } else if (tag === '62F' || tag === '20') {
      current = null
    }
  }
  if (bad) warnings.push(`${bad} :61: statement ${bad === 1 ? 'line' : 'lines'} could not be read and ${bad === 1 ? 'was' : 'were'} skipped`)
  for (const l of lines) if (!l.description) l.description = l.reference
  return { format: 'mt940', lines, warnings, account, currency, openingBalance, closingBalance }
}
