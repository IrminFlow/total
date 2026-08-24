/**
 * The 30-day reporting window for e-invoices.
 *
 * Registrations above the turnover threshold must report an invoice to the Invoice Registration
 * Portal within 30 days of its date. After that the portal simply refuses it — there is no late
 * fee and no appeal, the IRN cannot be generated at all, and a supply without an IRN is not a
 * valid tax invoice for the buyer's input credit.
 *
 * That makes this a countdown rather than a report: by the time it shows up in a monthly review
 * it is already too late. Nothing here talks to the portal; it only counts days.
 */

import { CRORE } from './turnover'

/** Days from the invoice date within which it must reach the IRP. */
export const REPORTING_WINDOW_DAYS = 30

/** Turnover at or above which the window applies. Shares the crore constant with turnover.ts so
 *  the two thresholds cannot drift by an order of magnitude — which is exactly what happened the
 *  first time this was written by hand. */
export const REPORTING_WINDOW_THRESHOLD_PAISE = 10 * CRORE

export type ReportingUrgency = 'reported' | 'expired' | 'critical' | 'due' | 'fine'

export interface WindowStatus {
  urgency: ReportingUrgency
  /** Days left to report. Negative once the window has closed. */
  daysLeft: number
  deadline: string
  label: string
}

function addDays(date: string, days: number): string {
  const dt = new Date(`${date}T00:00:00Z`)
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/**
 * Where an invoice stands against its window.
 *
 * An already-reported invoice is answered first and without arithmetic: it has an IRN, the window
 * is irrelevant, and showing it a countdown would be noise on a screen whose whole job is to be
 * short.
 */
export function reportingWindow(invoiceDate: string, today: string, hasIrn: boolean): WindowStatus {
  const deadline = addDays(invoiceDate, REPORTING_WINDOW_DAYS)
  const daysLeft = daysBetween(today, deadline)

  if (hasIrn) return { urgency: 'reported', daysLeft, deadline, label: 'Reported' }
  if (daysLeft < 0) {
    return { urgency: 'expired', daysLeft, deadline, label: `Window closed ${-daysLeft} days ago` }
  }
  if (daysLeft <= 3) return { urgency: 'critical', daysLeft, deadline, label: `${daysLeft} days left` }
  if (daysLeft <= 10) return { urgency: 'due', daysLeft, deadline, label: `${daysLeft} days left` }
  return { urgency: 'fine', daysLeft, deadline, label: `${daysLeft} days left` }
}

/** Does this registration have to report at all? */
export function windowApplies(turnoverPaise: number | null): boolean {
  return turnoverPaise !== null && turnoverPaise >= REPORTING_WINDOW_THRESHOLD_PAISE
}

export interface WindowRow {
  voucherId: number
  number: string
  date: string
  party: string
  value: number
  irn: string | null
}

export interface WindowReport {
  today: string
  applies: boolean
  rows: (WindowRow & WindowStatus)[]
  /** Unreported invoices whose window has already closed — no IRN is now possible. */
  expired: number
  expiredValue: number
  /** Unreported and inside three days. */
  critical: number
}

/**
 * Rank unreported invoices by how little time is left.
 *
 * Already-reported invoices are dropped rather than listed as safe: this is a to-do list, and a
 * to-do list that includes the done things stops being read.
 */
export function reportingBacklog(rows: WindowRow[], today: string, turnoverPaise: number | null): WindowReport {
  const applies = windowApplies(turnoverPaise)
  const ranked = rows
    .map((r) => ({ ...r, ...reportingWindow(r.date, today, r.irn !== null) }))
    .filter((r) => r.urgency !== 'reported')
    .sort((a, b) => a.daysLeft - b.daysLeft || b.value - a.value)

  return {
    today,
    applies,
    rows: ranked,
    expired: ranked.filter((r) => r.urgency === 'expired').length,
    expiredValue: ranked.filter((r) => r.urgency === 'expired').reduce((s, r) => s + r.value, 0),
    critical: ranked.filter((r) => r.urgency === 'critical').length
  }
}
