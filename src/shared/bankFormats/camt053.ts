/**
 * ISO 20022 camt.053 "BankToCustomerStatement" reader (WP 4.1).
 *
 * Element paths per the ISO 20022 message definition camt.053.001.xx (iso20022.org message
 * catalogue, Cash Management; the same paths hold from .001.02 through .001.13):
 *   Document/BkToCstmrStmt/Stmt                       one statement per account
 *     Acct/Id/IBAN | Acct/Id/Othr/Id, Acct/Ccy
 *     Bal[Tp/CdOrPrtry/Cd = OPBD | CLBD]/Amt, CdtDbtInd
 *     Ntry                                            one booked entry = one statement line
 *       Amt (@Ccy), CdtDbtInd CRDT | DBIT, RvslInd
 *       Sts (or Sts/Cd from .001.08) BOOK | PDNG | INFO — only BOOK entries are imported
 *       BookgDt/Dt | DtTm, ValDt/Dt | DtTm, AcctSvcrRef
 *       NtryDtls/TxDtls/Refs/EndToEndId | ChqNb | TxId
 *       NtryDtls/TxDtls/RltdPties/Dbtr|Cdtr/Nm (or …/Pty/Nm from .001.08)
 *       NtryDtls/TxDtls/RmtInf/Ustrd, AddtlTxInf, AddtlNtryInf
 * CdtDbtInd always states the direction of the entry as booked (a reversal carries the opposite
 * indicator of the original plus RvslInd=true), so it is taken as-is.
 */
import { child, childrenOf, descendants, parseXml, path, textOf, type XmlNode } from './xml'
import { parseBankAmount } from './quirks'
import type { ParsedStatement, StatementLine } from './types'

export function looksLikeCamt053(text: string): boolean {
  return /<([\w]+:)?BkToCstmrStmt[\s>]/.test(text)
}

/** ISODate as is; ISODateTime with a zone (Z / ±hh:mm) converted to this machine's local date (a
 *  late-evening UTC booking is the next day in India); without a zone it is the bank's local time. */
export function camtDate(s: string): string | null {
  const t = s.trim()
  if (!/^\d{4}-\d{2}-\d{2}/.test(t)) return null
  if (/T.*(Z|[+-]\d{2}:?\d{2})$/.test(t)) {
    const d = new Date(t)
    if (!Number.isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  return t.slice(0, 10)
}

const dateOf = (n: XmlNode | undefined): string | null => camtDate(textOf(child(n, 'Dt') ?? child(n, 'DtTm')))

function balanceOf(stmt: XmlNode, code: string): number | null {
  for (const bal of childrenOf(stmt, 'Bal')) {
    if (textOf(path(bal, 'Tp', 'CdOrPrtry', 'Cd')).trim() !== code) continue
    const amt = parseBankAmount(textOf(child(bal, 'Amt')))
    if (!amt) continue
    return textOf(child(bal, 'CdtDbtInd')).trim() === 'DBIT' ? -amt.paise : amt.paise
  }
  return null
}

export function parseCamt053(text: string): ParsedStatement {
  const doc = parseXml(text)
  const root = doc.local === 'BkToCstmrStmt' ? doc : descendants(doc, 'BkToCstmrStmt')[0]
  if (!root) throw new Error('Not a camt.053 statement (no BkToCstmrStmt element)')
  const lines: StatementLine[] = []
  const warnings: string[] = []
  let account: string | null = null
  let currency: string | null = null
  let openingBalance: number | null = null
  let closingBalance: number | null = null
  let skippedPending = 0
  for (const stmt of childrenOf(root, 'Stmt')) {
    const id = path(stmt, 'Acct', 'Id')
    account = account ?? (textOf(child(id, 'IBAN')).trim() || textOf(path(id, 'Othr', 'Id')).trim() || null)
    currency = currency ?? (textOf(path(stmt, 'Acct', 'Ccy')).trim() || null)
    openingBalance = openingBalance ?? balanceOf(stmt, 'OPBD')
    closingBalance = balanceOf(stmt, 'CLBD') ?? closingBalance
    for (const ntry of childrenOf(stmt, 'Ntry')) {
      const sts = (textOf(child(child(ntry, 'Sts'), 'Cd')) || textOf(child(ntry, 'Sts'))).trim()
      if (sts && sts !== 'BOOK') {
        skippedPending++
        continue
      }
      const amtNode = child(ntry, 'Amt')
      currency = currency ?? (amtNode?.attrs['Ccy'] || null)
      const amt = parseBankAmount(textOf(amtNode))
      if (!amt) continue
      const credit = textOf(child(ntry, 'CdtDbtInd')).trim() === 'CRDT'
      const date = dateOf(child(ntry, 'BookgDt')) ?? dateOf(child(ntry, 'ValDt'))
      if (!date) continue
      const tx = path(ntry, 'NtryDtls', 'TxDtls')
      const party = credit ? path(tx, 'RltdPties', 'Dbtr') : path(tx, 'RltdPties', 'Cdtr')
      const partyName = textOf(child(party, 'Nm') ?? path(party, 'Pty', 'Nm')).trim()
      const ustrd = descendants(ntry, 'Ustrd').map((u) => textOf(u).trim()).filter(Boolean)
      const extra = [textOf(child(tx, 'AddtlTxInf')), textOf(child(ntry, 'AddtlNtryInf'))].map((s) => s.trim()).filter(Boolean)
      const refs = child(tx, 'Refs')
      const chq = textOf(child(refs, 'ChqNb')).trim()
      const e2e = textOf(child(refs, 'EndToEndId')).trim()
      const reference =
        chq || (e2e && e2e !== 'NOTPROVIDED' ? e2e : '') || textOf(child(ntry, 'AcctSvcrRef')).trim() || textOf(child(refs, 'TxId')).trim()
      lines.push({
        date,
        valueDate: dateOf(child(ntry, 'ValDt')),
        description: [partyName, ...ustrd, ...extra].filter((s, i, all) => all.indexOf(s) === i).join(' ').replace(/\s+/g, ' ').trim(),
        reference,
        deposit: credit ? Math.abs(amt.paise) : 0,
        withdrawal: credit ? 0 : Math.abs(amt.paise),
        balance: null
      })
    }
  }
  if (skippedPending) warnings.push(`${skippedPending} pending / information-only ${skippedPending === 1 ? 'entry' : 'entries'} (status not BOOK) skipped`)
  return { format: 'camt053', lines, warnings, account, currency, openingBalance, closingBalance }
}
