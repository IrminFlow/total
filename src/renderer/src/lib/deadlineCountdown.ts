import type { Deadline } from '@shared/compliance'

/** "GSTR-3B in 5 days" / "GSTR-1 tomorrow" / "GSTR-3B due today". */
export function deadlineCountdown(d: Deadline, today: string): string {
  const days = Math.round(
    (new Date(d.date + 'T00:00:00Z').getTime() - new Date(today + 'T00:00:00Z').getTime()) / 86400000
  )
  if (days <= 0) return `${d.form} due today`
  if (days === 1) return `${d.form} tomorrow`
  return `${d.form} in ${days} days`
}
