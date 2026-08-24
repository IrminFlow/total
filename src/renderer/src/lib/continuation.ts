import type { Screen } from '../state/stores'
import { isValidISODate } from '@shared/dates'
import { screenDef } from './screens'

export interface ContinuationState {
  screen: Screen
  from: string
  to: string
  scrollByScreen: Partial<Record<Screen['name'], number>>
}

function key(slug: string): string { return `total-continuation-${slug}` }

export function readContinuation(slug: string): ContinuationState | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(key(slug)) ?? 'null') as Partial<ContinuationState> | null
    if (!parsed || !isValidISODate(parsed.from ?? '') || !isValidISODate(parsed.to ?? '') || parsed.from! > parsed.to!) return null
    const name = parsed.screen && typeof parsed.screen === 'object' ? parsed.screen.name : null
    const canonical = typeof name === 'string' ? screenDef(name as Screen['name'])?.screen : null
    if (!canonical || canonical.name === 'voucher-entry') return null
    const scrollByScreen = Object.fromEntries(Object.entries(parsed.scrollByScreen ?? {}).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0))
    return { screen: canonical, from: parsed.from!, to: parsed.to!, scrollByScreen }
  } catch {
    return null
  }
}

export function rememberContinuation(slug: string, input: Omit<ContinuationState, 'scrollByScreen'> & { scrollTop?: number }): ContinuationState {
  const prior = readContinuation(slug)
  const scrollByScreen = { ...(prior?.scrollByScreen ?? {}) }
  if (input.scrollTop !== undefined) scrollByScreen[input.screen.name] = Math.max(0, Math.round(input.scrollTop))
  const next: ContinuationState = { screen: input.screen, from: input.from, to: input.to, scrollByScreen }
  localStorage.setItem(key(slug), JSON.stringify(next))
  return next
}
