/**
 * Input Service Distributor (roadmap #355).
 *
 * A business with registrations in several states pays some bills once, centrally: the statutory
 * audit fee, the accounting software subscription, the head-office rent. The invoice names one
 * GSTIN. The credit belongs to all of them. An ISD registration is the mechanism that moves it —
 * the office receives the invoices, and distributes the credit to the registrations that used the
 * service, in a ratio the rules fix rather than the business chooses.
 *
 * It used to be optional; a business could cross-charge instead. Since 1 April 2025 it is not.
 *
 * ---------------------------------------------------------------------------------------------
 * CHECKED AGAINST (August 2026), against CBIC's own consolidated Act and Rules repository at
 * taxinformation.cbic.gov.in, which carries the amendment footnotes:
 *   - Section 2(61), CGST Act 2017 — definition of Input Service Distributor, substituted by s.11
 *     of the Finance (No. 2) Act 2024. The substituted definition covers invoices for input
 *     services "including invoices in respect of services liable to tax under sub-section (3) or
 *     sub-section (4) of section 9", and the office is "liable to distribute the input tax credit
 *     in respect of such invoices in the manner provided in section 20" — the words that made it
 *     mandatory.
 *   - Section 20, CGST Act 2017, substituted by s.12 of the same Act. CBIC's repository footnotes
 *     it "Substituted (w.e.f. 01.04.2025)". Section 20(1) requires registration as an ISD under
 *     section 24(viii); 20(3): "The credit of central tax shall be distributed as central tax or
 *     integrated tax and integrated tax as integrated tax or central tax".
 *   - COMMENCEMENT, 1 April 2025, appointed by Notification No. 16/2024-Central Tax dated 6 August
 *     2024. Confirmed independently by rule 39's own footnote (below), which gives the same date.
 *     ONE INCONSISTENCY, unresolved and recorded rather than smoothed over: CBIC's repository
 *     footnotes s.2(61) as "w.e.f. 01.04.2024" and s.20 as "w.e.f. 01.04.2025", which cannot both
 *     be right — one notification brought ss.11 and 12 of the same Act into force, and the
 *     substituted 2(61) points at the substituted s.20, which did not exist in April 2024. The
 *     2025 date is taken, on the strength of s.20's footnote and rule 39's. The gazette text of
 *     Notn. 16/2024-CT would settle it; the copy on gstcouncil.gov.in is a scan with no text layer.
 *   - Rule 39, CGST Rules 2017, sub-rule (1) substituted by Notification No. 12/2024-Central Tax
 *     dated 10 July 2024, "(w.e.f. 1st day of April, 2025, appointed vide Notification No.
 *     09/2025-CT, dated 11.02.2025)". THE CLAUSE LETTERING IS NOW READ, NOT GUESSED, and it moved:
 *       (a)  distribute in the same month, details in FORM GSTR-6
 *       (b)  distributed credit shall not exceed credit available
 *       (c)  credit attributable to ONE recipient goes to that recipient only
 *       (d)  credit attributable to MORE THAN ONE recipient — pro rata on turnover in the State
 *       (e)  credit attributable to ALL recipients — pro rata on turnover in the State
 *       (f)  the C1 = (t1/T) x C formula for clauses (d) and (e)
 *       (g)  ineligible credit (s.17(5) "or otherwise") distributed separately from eligible
 *       (h)  central / State / UT / integrated tax distributed separately
 *       (i)  integrated tax distributed as integrated tax to every recipient
 *       (j)  central + State/UT tax: (i) same State — as central and State/UT tax; (ii) other
 *            State — as integrated tax, equal to the aggregate of the two
 *       (k)  ISD invoice under rule 54(1); (l) ISD credit note under rule 54(1)
 *       (m)  debit notes; (n) credit notes
 *     The pre-substitution numbering this file used to cite — 39(1)(d)/(f)/(g) — is now (d)/(e) for
 *     the ratio, (g) for the eligibility split and (h)-(j) for the heads. Every citation below has
 *     been moved to the substituted lettering.
 *   - Rule 39(1) Explanation (i): the "relevant period" is the preceding financial year, or the
 *     last quarter for which turnover of all recipients is available where some or all had no
 *     turnover in that year. Explanation (ii): "recipient of credit" means a supplier with the same
 *     PAN as the ISD.
 *   - Rule 39(1A), substituted by the same notification: a registered person with the same PAN and
 *     State code as the ISD may pass a section 9(3)/9(4) credit to the ISD on a rule 54(1A)
 *     document, and the ISD then distributes it under sub-rule (1).
 *   - Rule 54(1), CGST Rules 2017 — particulars of an ISD invoice.
 *   - Section 24(viii), CGST Act 2017 — an ISD registers as one, separately, whatever its turnover.
 *   - Section 39(4), CGST Act 2017 — the ISD return, within thirteen days after the end of the
 *     month. That is GSTR-6.
 *   - COMPENSATION CESS on distribution, modelled cess-to-cess, is now CHECKED and holds: FORM
 *     GSTR-6 (rule 65, CGST Rules Part B) carries a CESS column in Table 3, Table 5 (5A eligible /
 *     5B ineligible), Table 8 and Table 9 — the form contemplates cess arriving and being
 *     distributed as cess — and section 11(1)-(2) of the GST (Compensation to States) Act 2017
 *     applies the CGST and IGST provisions "relating to ... input tax credit" mutatis mutandis to
 *     the cess. Cess is also the one head that needs no conversion: it is cess whether the
 *     recipient is in the ISD's State or not.
 *   - THE GSTR-6 TABLE NUMBERS are now checked against FORM GSTR-6 as prescribed under rule 65 in
 *     Part B of the CGST Rules. See `Gstr6Working`.
 *
 * **WHAT IS STILL NOT ESTABLISHED:**
 *   1. The gazette text of Notification 16/2024-Central Tax (see the inconsistency noted above).
 *   2. Nothing here writes a portal file. See `Gstr6Working` for exactly why.
 *
 * Nothing in this file posts to the books. Distribution moves a credit between two of one
 * business's own electronic credit ledgers on the portal; it creates no revenue and no expense,
 * and the trial balance does not move.
 */

// ---------------------------------------------------------------------------------------------
// The rules, as dated data
// ---------------------------------------------------------------------------------------------

/** What the ISD provisions said, from a date. Never constants — see `src/shared/statutory.ts`. */
export interface IsdRules {
  effectiveFrom: string
  /** True once ISD is compulsory for a business receiving common input-service invoices. */
  mandatory: boolean
  /** True once credit of tax paid under section 9(3)/9(4) is distributable through the ISD. */
  distributesRcmCredit: boolean
  /** True once eligible and ineligible credit must be distributed as separate amounts. */
  splitsEligibility: boolean
  /** Day of the following month GSTR-6 is due on. Section 39(4) — thirteen days after month end. */
  dueDayOfMonth: number
  /**
   * True once the cess treatment on distribution has been checked. See the header: FORM GSTR-6
   * carries a CESS column in its distribution tables and s.11 of the Compensation Act applies the
   * ITC provisions mutatis mutandis, so cess-to-cess holds.
   */
  cessVerified: boolean
  note: string
  /** The notification or Act section this entry was read in. Shown wherever the rules are cited. */
  authority: string
  /** True when the entry has not been checked against the notification that made it. */
  unverified?: boolean
}

export const ISD_RULES_HISTORY: IsdRules[] = [
  {
    effectiveFrom: '2017-07-01',
    mandatory: false,
    distributesRcmCredit: false,
    splitsEligibility: true,
    dueDayOfMonth: 13,
    cessVerified: true,
    note:
      'ISD as originally enacted: available, not compulsory. A business could instead cross-charge the ' +
      'common service to its other registrations on a tax invoice. Credit of tax paid under reverse ' +
      'charge could not be distributed through the ISD — the ISD is not a supplier and cannot discharge ' +
      'that liability.',
    authority: 'Sections 2(61), 20 and 24(viii), CGST Act 2017 and rule 39, CGST Rules 2017, as originally enacted.'
  },
  {
    effectiveFrom: '2025-04-01',
    mandatory: true,
    distributesRcmCredit: true,
    splitsEligibility: true,
    dueDayOfMonth: 13,
    cessVerified: true,
    note:
      'ISD becomes compulsory where a business receives invoices for input services used by more than one ' +
      'of its registrations, and credit of tax paid under section 9(3)/9(4) is distributable through it.',
    authority:
      'Sections 2(61) and 20, CGST Act 2017, substituted by ss.11 and 12 of the Finance (No. 2) Act 2024, ' +
      'in force 1 Apr 2025 (Notn. 16/2024-Central Tax, 6 Aug 2024); rule 39(1) and (1A) substituted by ' +
      'Notn. 12/2024-Central Tax, 10 Jul 2024, in force 1 Apr 2025 (Notn. 9/2025-Central Tax, 11 Feb 2025).',
    unverified: false
  }
]

/** The ISD rules in force on `date`. Dates before the first entry get the first entry. */
export function isdRulesOn(date: string, history: IsdRules[] = ISD_RULES_HISTORY): IsdRules {
  let current = history[0] as IsdRules
  for (const r of history) {
    if (r.effectiveFrom <= date) current = r
    else break
  }
  return current
}

/** The rules for a 'YYYY-MM' distribution month, read on the last day of it. */
export function isdRulesForMonth(month: string, history: IsdRules[] = ISD_RULES_HISTORY): IsdRules {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return isdRulesOn(`${month}-${String(lastDay).padStart(2, '0')}`, history)
}

/**
 * When GSTR-6 for a distribution month is due.
 *
 * Section 39(4) — within thirteen days after the end of the month. No extension logic and no
 * weekend shift: the portal has moved a due date by notification more than once, and a hard-coded
 * shift would be a confident guess about a date the user is penalised on.
 */
export function gstr6DueDate(month: string, history: IsdRules[] = ISD_RULES_HISTORY): string {
  const rules = isdRulesForMonth(month, history)
  const [y, m] = month.split('-').map(Number) as [number, number]
  const due = new Date(Date.UTC(y, m, rules.dueDayOfMonth))
  return due.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------------------------
// Credit received centrally
// ---------------------------------------------------------------------------------------------

/** The four heads a credit can sit in. Integer paise, always. */
export interface CreditHeads {
  igst: number
  cgst: number
  sgst: number
  cess: number
}

export const ZERO_HEADS = (): CreditHeads => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 })

export function addHeads(...parts: CreditHeads[]): CreditHeads {
  return parts.reduce(
    (t, p) => ({ igst: t.igst + p.igst, cgst: t.cgst + p.cgst, sgst: t.sgst + p.sgst, cess: t.cess + p.cess }),
    ZERO_HEADS()
  )
}

export function headsTotal(h: CreditHeads): number {
  return h.igst + h.cgst + h.sgst + h.cess
}

/**
 * Who a common invoice's credit belongs to.
 *
 * Rule 39(1) distinguishes three cases in three clauses and they are not interchangeable: under
 * (c) credit attributable to ONE recipient "shall be distributed only to that recipient" and is not
 * apportioned; under (d) credit attributable to more than one goes pro rata among "such recipients
 * to whom the input service is attributable"; under (e) credit attributable to all goes pro rata
 * among all. Recording which case an invoice is in is the user's judgement about the service, and
 * the app must not infer it.
 */
export type IsdAttribution = 'all' | 'some' | 'one'

/** Whether the credit on an invoice is available at all. Rule 39(1)(g) requires the ISD to
 *  "separately distribute the amount of ineligible input tax credit (ineligible under the
 *  provisions of sub-section (5) of section 17 or otherwise) and the amount of eligible input tax
 *  credit" — both go out, as two amounts. */
export type IsdEligibility = 'eligible' | 'ineligible'

/** An invoice received by the ISD registration. */
export interface IsdCredit {
  id: number
  /** Date of the supplier's invoice. */
  date: string
  supplierName: string
  supplierGstin: string | null
  invoiceNumber: string
  description: string | null
  taxable: number
  heads: CreditHeads
  eligibility: IsdEligibility
  attribution: IsdAttribution
  /** Registration ids the credit is attributable to. Empty means 'all'. */
  recipientRegistrationIds: number[]
  /** True when the tax was paid by the ISD under section 9(3)/9(4) rather than charged by the supplier. */
  reverseCharge: boolean
}

/** A registration credit can be distributed to, with the turnover that fixes its share. */
export interface IsdRecipient {
  registrationId: number
  gstin: string | null
  stateCode: string
  tradeName: string
  /**
   * Turnover in the State during the relevant period, paise.
   *
   * The "t1" of rule 39(1)(f)'s C1 = (t1/T) x C, and the only number in the whole feature that
   * decides who gets what.
   */
  turnoverPaise: number
  /** True when `turnoverPaise` was typed by the user rather than computed from these books. */
  turnoverDeclared: boolean
}

/**
 * The relevant period whose turnover fixes the ratio.
 *
 * Rule 39(1) Explanation (i): the financial year preceding the year during which credit is distributed,
 * where the recipients have turnover in that year; where any of them does not, the last quarter
 * for which the turnover of all of them is available, preceding the month of distribution.
 *
 * The second limb is the one that bites for a registration granted this year, and it is the
 * reason this is a computed answer rather than "last year" everywhere.
 */
export interface RelevantPeriod {
  kind: 'preceding-fy' | 'last-quarter'
  from: string
  to: string
  label: string
  reason: string
}

/** The financial year (April–March) preceding the one `month` falls in. */
export function precedingFinancialYear(month: string): { from: string; to: string; label: string } {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const fyStart = m >= 4 ? y : y - 1
  const prev = fyStart - 1
  return { from: `${prev}-04-01`, to: `${fyStart}-03-31`, label: `${prev}-${String((prev + 1) % 100).padStart(2, '0')}` }
}

/** The last complete calendar quarter before `month`. */
export function lastQuarterBefore(month: string): { from: string; to: string; label: string } {
  const [y, m] = month.split('-').map(Number) as [number, number]
  // Quarter containing the month before this one, unless that quarter is the current one.
  const qIndex = Math.floor((m - 1) / 3) // 0..3 for the month's own quarter
  let qy = y
  let q = qIndex - 1
  if (q < 0) {
    q = 3
    qy -= 1
  }
  const startMonth = q * 3 + 1
  const endMonth = startMonth + 2
  const lastDay = new Date(Date.UTC(qy, endMonth, 0)).getUTCDate()
  return {
    from: `${qy}-${String(startMonth).padStart(2, '0')}-01`,
    to: `${qy}-${String(endMonth).padStart(2, '0')}-${lastDay}`,
    label: `Q${q + 1} ${qy}`
  }
}

/**
 * Which period's turnover to use for a distribution in `month`.
 *
 * `everyRecipientHadPrecedingFyTurnover` is the caller's answer, because the books cannot
 * distinguish "no turnover" from "registration did not exist" from "these books start in April".
 */
export function relevantPeriodFor(month: string, everyRecipientHadPrecedingFyTurnover: boolean): RelevantPeriod {
  if (everyRecipientHadPrecedingFyTurnover) {
    const fy = precedingFinancialYear(month)
    return {
      kind: 'preceding-fy',
      ...fy,
      label: `FY ${fy.label}`,
      reason: 'Every recipient had turnover in the preceding financial year, so rule 39(1) Explanation (i)(a) uses that year.'
    }
  }
  const q = lastQuarterBefore(month)
  return {
    kind: 'last-quarter',
    ...q,
    reason:
      'At least one recipient had no turnover in the preceding financial year, so rule 39(1) Explanation (i)(b) falls back to the ' +
      'last quarter preceding the month of distribution for which turnover is available.'
  }
}

// ---------------------------------------------------------------------------------------------
// The apportionment
// ---------------------------------------------------------------------------------------------

/** One recipient's share of one head. */
export interface IsdShare {
  registrationId: number
  /** Numerator of the statutory ratio — this recipient's turnover, paise. */
  turnoverPaise: number
  /** What arrives in this recipient's credit ledger, after the head conversion. */
  heads: CreditHeads
}

/**
 * Split an integer paise amount pro rata on turnover, exactly.
 *
 * Largest-remainder: floor every share, then hand the leftover paise out one at a time to the
 * recipients with the largest fractional parts. The parts sum to the whole to the paise, which is
 * not a nicety — a distribution that loses a paisa is a credit ledger that will never reconcile,
 * and one that gains a paisa is a credit distributed that was never received.
 *
 * Every recipient having nil turnover is a real case (a registration that has not started
 * trading): the amount is then split equally, which is a stated choice rather than a statutory
 * one, and `distributionWarnings` says so.
 */
export function apportion(amount: number, weights: number[]): number[] {
  const n = weights.length
  if (n === 0) return []
  const sign = amount < 0 ? -1 : 1
  const abs = Math.abs(amount)
  const total = weights.reduce((t, w) => t + w, 0)
  const effective = total > 0 ? weights : weights.map(() => 1)
  const effTotal = total > 0 ? total : n

  const base: number[] = []
  const rema: { i: number; r: number }[] = []
  let assigned = 0
  for (let i = 0; i < n; i++) {
    const exact = abs * (effective[i] as number)
    const q = Math.floor(exact / effTotal)
    base.push(q)
    assigned += q
    rema.push({ i, r: exact - q * effTotal })
  }
  let left = abs - assigned
  rema.sort((a, b) => b.r - a.r || a.i - b.i)
  for (let k = 0; k < rema.length && left > 0; k++, left--) {
    base[(rema[k] as { i: number }).i] = (base[(rema[k] as { i: number }).i] as number) + 1
  }
  return base.map((v) => sign * v)
}

/**
 * Convert a head of credit to the head it arrives in, for one recipient.
 *
 * Rule 39(1)(i): integrated tax "shall be distributed as input tax credit of integrated tax to
 * every recipient". Rule 39(1)(j): central tax and State/UT tax go (i) to a recipient in the ISD's
 * own State "as input tax credit of central tax and State tax or Union territory tax respectively",
 * and (ii) to a recipient elsewhere "as integrated tax and the amount to be so distributed shall be
 * equal to the aggregate of the amount of input tax credit of central tax and State tax or Union
 * territory tax that qualifies for distribution to such recipient". This is the part of ISD that is
 * invisible until a return is filed: a Maharashtra ISD distributing a Mumbai audit fee to its
 * Gujarat registration hands over IGST equal to CGST + SGST, and a ledger that expected CGST and
 * SGST to arrive will not match.
 *
 * Cess is carried as cess, and needs no conversion — cess is cess in either direction. See the
 * header: FORM GSTR-6's distribution tables carry a CESS column, and section 11 of the Compensation
 * Act applies the ITC provisions to it mutatis mutandis.
 */
export function convertHeads(heads: CreditHeads, sameStateAsIsd: boolean): CreditHeads {
  if (sameStateAsIsd) return { ...heads }
  return { igst: heads.igst + heads.cgst + heads.sgst, cgst: 0, sgst: 0, cess: heads.cess }
}

export interface DistributeInput {
  credit: IsdCredit
  /** Every registration credit could go to. Filtered by the credit's own attribution. */
  recipients: IsdRecipient[]
  /** The ISD registration's state — decides CGST+SGST versus IGST on the way out. */
  isdStateCode: string
}

/**
 * Distribute one invoice's credit.
 *
 * The apportionment runs on the credit AS RECEIVED, head by head, and the head conversion is
 * applied to each recipient's share afterwards. That order matters: converting first and
 * apportioning second would apportion an IGST amount that only some recipients were ever going to
 * receive as IGST, and the shares would stop summing to the credit.
 */
export function distributeCredit(input: DistributeInput): IsdShare[] {
  const targets =
    input.credit.attribution === 'all'
      ? input.recipients
      : input.recipients.filter((r) => input.credit.recipientRegistrationIds.includes(r.registrationId))
  if (targets.length === 0) return []

  const weights = targets.map((r) => r.turnoverPaise)
  const igst = apportion(input.credit.heads.igst, weights)
  const cgst = apportion(input.credit.heads.cgst, weights)
  const sgst = apportion(input.credit.heads.sgst, weights)
  const cess = apportion(input.credit.heads.cess, weights)

  return targets.map((r, i) => ({
    registrationId: r.registrationId,
    turnoverPaise: r.turnoverPaise,
    heads: convertHeads(
      { igst: igst[i] as number, cgst: cgst[i] as number, sgst: sgst[i] as number, cess: cess[i] as number },
      r.stateCode === input.isdStateCode
    )
  }))
}

// ---------------------------------------------------------------------------------------------
// The document — rule 54(1)
// ---------------------------------------------------------------------------------------------

/** One line of an ISD invoice: the credit from one received invoice, as distributed. */
export interface IsdInvoiceLine {
  creditId: number
  supplierName: string
  supplierGstin: string | null
  supplierInvoiceNumber: string
  supplierInvoiceDate: string
  description: string | null
  eligibility: IsdEligibility
  /** Credit as received on the supplier's invoice, before apportionment. */
  received: CreditHeads
  /** This recipient's share, in the heads it arrives in. */
  distributed: CreditHeads
}

/**
 * The ISD invoice — rule 54(1).
 *
 * Rule 54(1) asks for the ISD's name, address and GSTIN; a consecutive serial number for the
 * financial year; the date of issue; the recipient's name, address and GSTIN; the amount of credit
 * distributed; and a signature. It is NOT a tax invoice: no taxable value, no supply, nothing to
 * pay. That is why the document has heads and no rate.
 */
export interface IsdInvoice {
  number: string
  date: string
  /** 'YYYY-MM' the distribution belongs to. */
  month: string
  isd: { registrationId: number; gstin: string | null; stateCode: string; tradeName: string; address: string | null }
  recipient: { registrationId: number; gstin: string | null; stateCode: string; tradeName: string; address: string | null }
  lines: IsdInvoiceLine[]
  eligible: CreditHeads
  ineligible: CreditHeads
  total: CreditHeads
  /** The ratio this recipient's share was computed on, printed so it can be checked. */
  ratio: { turnoverPaise: number; totalTurnoverPaise: number; period: RelevantPeriod }
  warnings: string[]
}

/**
 * The serial for an ISD invoice.
 *
 * Its own series per financial year, under rule 54(1) read with rule 46(b)'s "consecutive serial
 * number ... for a financial year". `ISD/2026-27/0004`.
 */
export function isdInvoiceNumber(fyLabel: string, sequence: number, prefix = 'ISD'): string {
  return `${prefix}/${fyLabel}/${String(sequence).padStart(4, '0')}`
}

/** What a distribution cannot say for itself. Stated, never guessed. */
export function distributionWarnings(input: {
  month: string
  recipients: IsdRecipient[]
  credits: IsdCredit[]
  period: RelevantPeriod
  rules?: IsdRules
}): string[] {
  const out: string[] = []
  const rules = input.rules ?? isdRulesForMonth(input.month)

  if (!rules.mandatory) {
    out.push(
      `On ${input.month} the ISD mechanism was optional — a business could cross-charge the common service instead. ` +
        'It became compulsory for this pattern from 1 April 2025.'
    )
  }
  if (rules.unverified) {
    out.push(
      `The rules applied to ${input.month} have not been checked against the notification that made them. ` +
        'Check the apportionment against the current rule before filing.'
    )
  }
  const totalTurnover = input.recipients.reduce((t, r) => t + r.turnoverPaise, 0)
  if (totalTurnover === 0) {
    out.push(
      'No recipient has any turnover in the relevant period, so the credit has been split equally. Rule 39 fixes ' +
        'the ratio on turnover in clauses (d) and (e) and says nothing about this case — set a turnover on each recipient, or check the ' +
        'relevant period.'
    )
  }
  const nil = input.recipients.filter((r) => r.turnoverPaise === 0)
  if (totalTurnover > 0 && nil.length > 0) {
    out.push(
      `${nil.length} recipient${nil.length === 1 ? '' : 's'} had nil turnover in ${input.period.label} and therefore ` +
        'receive nothing. Rule 39(1)(f) apportions on turnover, so that is the arithmetic — but confirm it is not simply a ' +
        'period with no data.'
    )
  }
  const declared = input.recipients.filter((r) => r.turnoverDeclared)
  if (declared.length > 0) {
    out.push(
      `${declared.length} recipient turnover figure${declared.length === 1 ? ' was' : 's were'} entered by hand rather ` +
        'than computed from these books. Rule 39(1)(d)/(e) want turnover in the State, which includes exempt supplies and any ' +
        'part of the period before these books begin.'
    )
  }
  if (!rules.cessVerified && input.credits.some((c) => c.heads.cess !== 0)) {
    out.push(
      'A credit carries compensation cess. Cess has been distributed as cess; that treatment is not verified for this ' +
        'period and should be checked before filing.'
    )
  }
  const rcm = input.credits.filter((c) => c.reverseCharge)
  if (rcm.length > 0 && !rules.distributesRcmCredit) {
    out.push(
      `${rcm.length} credit${rcm.length === 1 ? ' is' : 's are'} marked as tax paid under reverse charge, which was not ` +
        'distributable through an ISD before 1 April 2025.'
    )
  }
  if (rcm.length > 0 && rules.distributesRcmCredit) {
    out.push(
      `${rcm.length} credit${rcm.length === 1 ? ' was' : 's were'} paid under reverse charge. The ISD pays that tax under ` +
        'its own ordinary registration and takes the credit there first; only then is it distributed. This app records ' +
        'the distribution, NOT that payment.'
    )
  }
  return out
}

export interface BuildDistributionInput {
  month: string
  /** Date the ISD invoices are dated — the last day of the month by convention. */
  date: string
  fyLabel: string
  isd: IsdInvoice['isd']
  recipients: (IsdRecipient & { address: string | null })[]
  credits: IsdCredit[]
  period: RelevantPeriod
  /** Handed the running sequence; the caller owns the counter so a batch does not reuse a serial. */
  numberFor: (index: number) => string
  rules?: IsdRules
}

export interface DistributionResult {
  month: string
  period: RelevantPeriod
  invoices: IsdInvoice[]
  /** Credit received in the month, by eligibility. GSTR-6 Table 4. */
  received: { eligible: CreditHeads; ineligible: CreditHeads }
  /** Credit distributed, by eligibility. Ties to `received` when every credit was distributed. */
  distributed: { eligible: CreditHeads; ineligible: CreditHeads }
  warnings: string[]
}

/**
 * The month's distribution: one ISD invoice per recipient that receives anything.
 *
 * A recipient whose every share rounds to nil gets no document rather than an invoice for zero —
 * rule 54(1) contemplates a document for credit distributed, and a nil one is a serial spent on
 * nothing.
 */
export function buildDistribution(input: BuildDistributionInput): DistributionResult {
  const rules = input.rules ?? isdRulesForMonth(input.month)
  const totalTurnover = input.recipients.reduce((t, r) => t + r.turnoverPaise, 0)

  // registrationId -> lines
  const byRecipient = new Map<number, IsdInvoiceLine[]>()
  for (const credit of input.credits) {
    const shares = distributeCredit({ credit, recipients: input.recipients, isdStateCode: input.isd.stateCode })
    for (const share of shares) {
      if (headsTotal(share.heads) === 0) continue
      const line: IsdInvoiceLine = {
        creditId: credit.id,
        supplierName: credit.supplierName,
        supplierGstin: credit.supplierGstin,
        supplierInvoiceNumber: credit.invoiceNumber,
        supplierInvoiceDate: credit.date,
        description: credit.description,
        eligibility: credit.eligibility,
        received: { ...credit.heads },
        distributed: share.heads
      }
      const list = byRecipient.get(share.registrationId)
      if (list) list.push(line)
      else byRecipient.set(share.registrationId, [line])
    }
  }

  const warnings = distributionWarnings({
    month: input.month,
    recipients: input.recipients,
    credits: input.credits,
    period: input.period,
    rules
  })

  let seq = 0
  const invoices: IsdInvoice[] = []
  for (const recipient of input.recipients) {
    const lines = byRecipient.get(recipient.registrationId)
    if (!lines || lines.length === 0) continue
    const eligible = addHeads(...lines.filter((l) => l.eligibility === 'eligible').map((l) => l.distributed))
    const ineligible = addHeads(...lines.filter((l) => l.eligibility === 'ineligible').map((l) => l.distributed))
    invoices.push({
      number: input.numberFor(seq++),
      date: input.date,
      month: input.month,
      isd: input.isd,
      recipient: {
        registrationId: recipient.registrationId,
        gstin: recipient.gstin,
        stateCode: recipient.stateCode,
        tradeName: recipient.tradeName,
        address: recipient.address
      },
      lines,
      eligible,
      ineligible,
      total: addHeads(eligible, ineligible),
      ratio: { turnoverPaise: recipient.turnoverPaise, totalTurnoverPaise: totalTurnover, period: input.period },
      warnings
    })
  }

  const receivedEligible = addHeads(...input.credits.filter((c) => c.eligibility === 'eligible').map((c) => c.heads))
  const receivedIneligible = addHeads(...input.credits.filter((c) => c.eligibility === 'ineligible').map((c) => c.heads))

  return {
    month: input.month,
    period: input.period,
    invoices,
    received: { eligible: receivedEligible, ineligible: receivedIneligible },
    distributed: {
      eligible: addHeads(...invoices.map((i) => i.eligible)),
      ineligible: addHeads(...invoices.map((i) => i.ineligible))
    },
    warnings
  }
}

// ---------------------------------------------------------------------------------------------
// GSTR-6
// ---------------------------------------------------------------------------------------------

/**
 * The data GSTR-6 asks for, in the tables it asks for it in.
 *
 * THE TABLE NUMBERING IS NOW CHECKED against FORM GSTR-6 "[See rule 65] Return for input service
 * distributor", as prescribed in Part B of the CGST Rules 2017. It was not a claim before; it is
 * one now, and it maps cleanly:
 *
 *   Table 3  Input tax credit received for distribution — GSTIN of supplier | Invoice details
 *            (No, Date, Value) | Rate | Taxable value | Amount of tax (Integrated / Central /
 *            State-UT / CESS).                                              -> `inward`
 *   Table 4  Total ITC / Eligible ITC / Ineligible ITC to be distributed for tax period (From
 *            Table No. 3), as three rows: (a) Total ITC available for distribution, (b) Amount of
 *            eligible ITC, (c) Amount of ineligible ITC, each across the four heads. -> `available`
 *   Table 5  Distribution of input tax credit reported in Table 4 — GSTIN of recipient/State, if
 *            recipient is unregistered | ISD invoice (No, Date) | Distribution of ITC by ISD
 *            (Integrated / Central / State-UT / CESS), split 5A eligible and 5B ineligible.
 *                                                                           -> `distribution`
 *
 * Tables 6 to 9 (amendments to Table 3, mismatch and reclaim, distribution of 6 and 7, and
 * redistribution to a wrong recipient) have no equivalent here because this build never amends a
 * filed GSTR-6 — a distribution is withdrawn and re-run before filing, not amended after it. Tables
 * 10 and 11 are late fee and refund from the cash ledger, which are portal events, not book events.
 * Notification 12/2024-Central Tax, which substituted rule 39, left FORM GSTR-6 itself untouched
 * (it amended only FORM GSTR-6A's heading), so the 2024 ISD changes did not move these numbers.
 *
 * STILL NOT A PORTAL JSON, and now for a precise reason rather than a vague one: the form layout in
 * the Rules is not the offline utility's JSON SCHEMA. That schema is published by GSTN with its
 * offline tool, not in the Rules, it has its own key names and section codes, and it has not been
 * read. GSTR-6 is in any case an online-only return — GSTN's own position is that it is filed on
 * the portal — so a user takes these figures to the portal and types them, which is what they do
 * for GSTR-6 anyway.
 */
export interface Gstr6Working {
  month: string
  dueDate: string
  isdGstin: string | null
  /** FORM GSTR-6 Table 3 — input tax credit received for distribution, invoice by invoice. */
  inward: {
    supplierGstin: string | null
    supplierName: string
    invoiceNumber: string
    invoiceDate: string
    taxable: number
    heads: CreditHeads
    eligibility: IsdEligibility
  }[]
  /** FORM GSTR-6 Table 4 rows (b) and (c); row (a) is their sum. */
  available: { eligible: CreditHeads; ineligible: CreditHeads }
  /** FORM GSTR-6 Table 5, one row per ISD invoice; `eligible` is 5A and `ineligible` is 5B. */
  distribution: {
    recipientGstin: string | null
    recipientStateCode: string
    isdInvoiceNumber: string
    isdInvoiceDate: string
    eligible: CreditHeads
    ineligible: CreditHeads
  }[]
  /**
   * Credit received minus credit distributed, as a TOTAL in paise.
   *
   * Deliberately not per head, and this is not laziness: CGST and State tax leave the distributor
   * as INTEGRATED tax for any recipient outside its own State, so a head-by-head comparison of
   * what came in against what went out reports a shortfall in CGST and a surplus in IGST on a
   * distribution that was perfectly complete. The total is the only figure that means anything
   * here, and non-zero really does mean something was not distributed.
   */
  undistributedPaise: number
  warnings: string[]
  /**
   * The form these table numbers were read in. Shown on the screen next to the working, because a
   * user typing figures into a portal needs to know which form's numbering they are reading.
   */
  formCitation: string
  /**
   * Nothing here is a portal file. False now means only what it says — the TABLE NUMBERING is
   * checked (see the doc comment) — and the export stays data rather than JSON for the separate
   * reason given there: the offline utility's JSON schema is GSTN's, not the Rules', and is unread.
   */
  layoutUnverified: false
}

export function buildGstr6(
  result: DistributionResult,
  opts: { isdGstin: string | null; credits: IsdCredit[]; history?: IsdRules[] }
): Gstr6Working {
  const available = { eligible: result.received.eligible, ineligible: result.received.ineligible }
  const distributedTotal = addHeads(result.distributed.eligible, result.distributed.ineligible)
  const availableTotal = addHeads(available.eligible, available.ineligible)

  return {
    month: result.month,
    dueDate: gstr6DueDate(result.month, opts.history),
    isdGstin: opts.isdGstin,
    inward: opts.credits.map((c) => ({
      supplierGstin: c.supplierGstin,
      supplierName: c.supplierName,
      invoiceNumber: c.invoiceNumber,
      invoiceDate: c.date,
      taxable: c.taxable,
      heads: c.heads,
      eligibility: c.eligibility
    })),
    available,
    distribution: result.invoices.map((i) => ({
      recipientGstin: i.recipient.gstin,
      recipientStateCode: i.recipient.stateCode,
      isdInvoiceNumber: i.number,
      isdInvoiceDate: i.date,
      eligible: i.eligible,
      ineligible: i.ineligible
    })),
    undistributedPaise: headsTotal(availableTotal) - headsTotal(distributedTotal),
    warnings: result.warnings,
    formCitation: 'FORM GSTR-6 [See rule 65], CGST Rules 2017 Part B — Tables 3, 4 and 5.',
    layoutUnverified: false
  }
}
