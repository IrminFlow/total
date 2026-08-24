/**
 * Full and final settlement.
 *
 * The last thing a business does for an employee, and the thing it most often does badly: a
 * spreadsheet, a number nobody can reconstruct, and an argument six months later. Everything here
 * is itemised with its own working, adds up in one direction, and produces a statement the leaver
 * can be handed.
 *
 * Deliberately a computation, not a posting. It returns lines; a human reads them, changes what
 * the company decided differently, and saves the journal.
 */
import { gratuity, statutoryBonus, type BonusResult, type GratuityResult } from './gratuity'

export interface FnfInput {
  employeeName: string
  joined: string
  /** Last working day. */
  lastDay: string
  /** Monthly basic + DA at the time of leaving, paise. */
  monthlyBasic: number
  /** Full monthly gross, paise — the base for the final month's prorated pay. */
  monthlyGross: number
  /** Days actually payable in the final month. */
  finalMonthDays: number
  /** Calendar days in the final month. */
  finalMonthTotalDays: number
  /** Unused leave to encash, in days. */
  leaveBalanceDays: number
  /** Notice days the employee owes but is not serving; recovered at the daily gross. */
  noticeShortfallDays?: number
  /** Loans and advances still outstanding, paise. */
  loanOutstanding?: number
  /** Deductions already computed for the final month (PF, ESI, PT), paise. */
  statutoryDeductions?: number
  /** Bonus payable for the part-year, if the company pays one. */
  bonus?: { daysWorked: number; monthsPayable: number; percent?: number }
  /** Death or permanent disablement waives gratuity's five-year rule. */
  waiveGratuityMinimum?: boolean
}

export interface FnfLine {
  label: string
  /** The arithmetic, in words, so the leaver can check it. */
  working: string
  amount: number
  kind: 'payable' | 'recovery'
}

export interface FnfResult {
  employeeName: string
  joined: string
  lastDay: string
  lines: FnfLine[]
  totalPayable: number
  totalRecovery: number
  /** Payable minus recovery. Negative means the employee owes the company. */
  net: number
  gratuity: GratuityResult
  bonus: BonusResult | null
  /** Things a person must decide, not a formula — surfaced rather than assumed away. */
  notes: string[]
}

const rupees = (p: number): string => (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })

/**
 * Leave encashment is paid on the daily *basic*, not the daily gross.
 *
 * A 30-day divisor rather than the month's actual length: leave is earned per month of service,
 * not per calendar day, and using 28 in February would pay more for the same leave.
 */
export const ENCASHMENT_MONTH_DAYS = 30

export function fullAndFinal(input: FnfInput): FnfResult {
  const lines: FnfLine[] = []
  const notes: string[] = []

  // --- final month's pay ---
  if (input.finalMonthTotalDays <= 0) throw new Error('The final month must have days in it')
  const finalPay = Math.floor((input.monthlyGross * Math.max(0, input.finalMonthDays)) / input.finalMonthTotalDays)
  lines.push({
    label: 'Salary for the final month',
    working: `₹${rupees(input.monthlyGross)} × ${input.finalMonthDays}/${input.finalMonthTotalDays} days`,
    amount: finalPay,
    kind: 'payable'
  })

  // --- leave encashment ---
  if (input.leaveBalanceDays > 0) {
    const perDay = Math.floor(input.monthlyBasic / ENCASHMENT_MONTH_DAYS)
    lines.push({
      label: 'Leave encashment',
      working: `${input.leaveBalanceDays} days × ₹${rupees(perDay)} (basic ÷ ${ENCASHMENT_MONTH_DAYS})`,
      amount: perDay * input.leaveBalanceDays,
      kind: 'payable'
    })
  }

  // --- gratuity ---
  const grat = gratuity({
    lastDrawnMonthly: input.monthlyBasic,
    joined: input.joined,
    left: input.lastDay,
    waiveMinimum: input.waiveGratuityMinimum
  })
  if (grat.eligible && grat.amount > 0) {
    lines.push({
      label: 'Gratuity',
      working: `15/26 × ₹${rupees(input.monthlyBasic)} × ${grat.countedYears} year${grat.countedYears === 1 ? '' : 's'}`,
      amount: grat.amount,
      kind: 'payable'
    })
    if (grat.cappedByCeiling) notes.push('Gratuity is capped at the ₹20,00,000 lifetime ceiling.')
  } else if (grat.reason) {
    notes.push(`No gratuity: ${grat.reason}.`)
  }

  // --- bonus ---
  let bonus: BonusResult | null = null
  if (input.bonus) {
    bonus = statutoryBonus({
      monthlySalary: input.monthlyBasic,
      daysWorked: input.bonus.daysWorked,
      monthsPayable: input.bonus.monthsPayable,
      percent: input.bonus.percent
    })
    if (bonus.eligible && bonus.amount > 0) {
      lines.push({
        label: 'Statutory bonus',
        working: `₹${rupees(bonus.calculationBase)} × ${bonus.monthsPayable} months × ${bonus.percent}%`,
        amount: bonus.amount,
        kind: 'payable'
      })
    } else if (bonus.reason) {
      notes.push(`No bonus: ${bonus.reason}.`)
    }
  }

  // --- recoveries ---
  if (input.statutoryDeductions && input.statutoryDeductions > 0) {
    lines.push({
      label: 'Statutory deductions for the final month',
      working: 'PF, ESI and professional tax on the final month',
      amount: input.statutoryDeductions,
      kind: 'recovery'
    })
  }
  if (input.noticeShortfallDays && input.noticeShortfallDays > 0) {
    const perDay = Math.floor(input.monthlyGross / ENCASHMENT_MONTH_DAYS)
    lines.push({
      label: 'Notice period shortfall',
      working: `${input.noticeShortfallDays} days × ₹${rupees(perDay)} (gross ÷ ${ENCASHMENT_MONTH_DAYS})`,
      amount: perDay * input.noticeShortfallDays,
      kind: 'recovery'
    })
  }
  if (input.loanOutstanding && input.loanOutstanding > 0) {
    lines.push({
      label: 'Loans and advances outstanding',
      working: 'Balance recovered in full on settlement',
      amount: input.loanOutstanding,
      kind: 'recovery'
    })
  }

  const totalPayable = lines.filter((l) => l.kind === 'payable').reduce((s, l) => s + l.amount, 0)
  const totalRecovery = lines.filter((l) => l.kind === 'recovery').reduce((s, l) => s + l.amount, 0)
  const net = totalPayable - totalRecovery
  if (net < 0) {
    notes.push('Recoveries exceed what is payable — the employee owes the company this amount.')
  }

  return {
    employeeName: input.employeeName,
    joined: input.joined,
    lastDay: input.lastDay,
    lines,
    totalPayable,
    totalRecovery,
    net,
    gratuity: grat,
    bonus,
    notes
  }
}
