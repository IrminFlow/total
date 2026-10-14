// "Why?" sentences — the helpers every screen's module shares (WP 8.6 / 9.9 / 10.2). Pure:
// amounts only through money.ts, dates only through dates.ts.

import { formatPaise } from '../money'
import { toPlainDate } from '../dates'

export const money = (paise: number): string => formatPaise(paise, { symbol: true })

/** '2026-11-20' → '20 Nov' (the year only when it is not `today`'s); `lang` as toPlainDate (WP 10.4). */
export function shortDate(date: string, today?: string, lang?: string): string {
  const plain = toPlainDate(date, lang)
  return today && date.slice(0, 4) === today.slice(0, 4) ? plain.slice(0, plain.lastIndexOf(' ')) : plain
}

/** The sentences that apply, one space apart. */
export const join = (parts: (string | null)[]): string => parts.filter((p): p is string => !!p).join(' ')

/** A span's dates in words. */
export const span = (s: { from: string; to: string }, lang?: string): { from: string; to: string } => ({ from: toPlainDate(s.from, lang), to: toPlainDate(s.to, lang) })

export const resultOf = (paise: number): 'profit' | 'loss' | 'none' => (paise > 0 ? 'profit' : paise < 0 ? 'loss' : 'none')

/** 'up' / 'down' / 'same' for a signed change. */
export const dirOf = (diff: number): 'up' | 'down' | 'same' => (diff > 0 ? 'up' : diff < 0 ? 'down' : 'same')
