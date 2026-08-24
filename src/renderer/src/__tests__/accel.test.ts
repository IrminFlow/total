import { describe, it, expect } from 'vitest'
import { SCREENS, NAV_SECTIONS } from '../lib/screens'
import { splitAccel, NAV_ACCEL } from '../lib/accel'

/**
 * Screens whose accelerator is deliberately NOT a letter of their label, because every letter
 * they contain is already taken. These render as a trailing key badge instead of a highlight.
 * Adding to this set should be a conscious, reviewed decision — that is the whole point of it
 * being an explicit allowlist rather than a lenient rule.
 */
const BADGE_ACCELS = new Set([
  'tds',
  // Filing register: every letter of the label is claimed (F cash flow, I import, L consolidated,
  // N reconciliation, R registers, S stock summary, T trial balance, E settings, G gateway).
  // Q is the only unclaimed letter that reads as anything at all next to a returns screen.
  'filings',
  // Collections: C cost centres, O outstandings, L consolidated, E settings, T trial balance,
  // I import, N reconciliation, S stock summary — the whole word is spoken for. Z was free.
  'collections',
  // Fixed assets: F cash flow, I import, X exceptions, E settings, D day book, A year-end,
  // S stock summary, T trial balance. Nothing in the label is free, so 5 rides as a badge.
  'assets'
])

/**
 * Screens that intentionally have no bare-letter accelerator. Empty on purpose: every sidebar
 * item is reachable by one letter, which is the promise the Gateway makes. Settings only fits
 * because e-Invoice & e-Way took W (e-Way) and freed E for S-e-ttings.
 */
const NO_ACCEL = new Set<string>()

const label = (s: (typeof SCREENS)[number]): string => s.navLabel ?? s.title

describe('screen accelerators', () => {
  it('are unique across the whole registry', () => {
    const seen = new Map<string, string>()
    for (const s of SCREENS) {
      if (!s.accel) continue
      const key = s.accel.toUpperCase()
      expect(seen.has(key), `${key} claimed by both ${seen.get(key)} and ${s.name}`).toBe(false)
      seen.set(key, s.name)
    }
  })

  it('are a single uppercase letter or digit', () => {
    for (const s of SCREENS) {
      if (!s.accel) continue
      expect(s.accel, s.name).toMatch(/^[A-Z0-9]$/)
    }
  })

  it('occur in the label they are rendered against', () => {
    for (const s of SCREENS) {
      if (!s.accel || BADGE_ACCELS.has(s.name)) continue
      const { hit } = splitAccel(label(s), s.accel)
      expect(hit, `${s.name}: '${s.accel}' is not in "${label(s)}"`).not.toBeNull()
      expect(hit!.toUpperCase()).toBe(s.accel)
    }
  })

  it('every allowlisted badge screen really has no letter to highlight', () => {
    for (const name of BADGE_ACCELS) {
      const s = SCREENS.find((x) => x.name === name)
      expect(s, `${name} is allowlisted but not in the registry`).toBeDefined()
      expect(splitAccel(label(s!), s!.accel).hit).toBeNull()
    }
  })

  it('every navigable sidebar screen has one', () => {
    for (const s of SCREENS) {
      if (s.navSection == null || s.screen == null) continue
      if (NO_ACCEL.has(s.name)) continue
      expect(s.accel, `${s.name} is in the sidebar but has no accelerator`).toBeTruthy()
    }
  })

  it('accelAt, when given, points at the accelerator', () => {
    for (const s of SCREENS) {
      const at = (s as { accelAt?: number }).accelAt
      if (at == null || !s.accel) continue
      expect(label(s).charAt(at).toUpperCase(), s.name).toBe(s.accel)
    }
  })

  it('NAV_ACCEL maps every accelerator to a navigable screen', () => {
    const withAccel = SCREENS.filter((s) => s.accel && s.screen)
    expect(NAV_ACCEL.size).toBe(withAccel.length)
    for (const s of withAccel) {
      expect(NAV_ACCEL.get(s.accel!.toUpperCase())?.name, s.accel).toBe(s.name)
    }
  })

  it('every accelerator belongs to a real nav section', () => {
    const sections = new Set(NAV_SECTIONS.map((s) => s.id))
    for (const s of SCREENS) {
      if (!s.accel || s.navSection == null) continue
      expect(sections.has(s.navSection), s.name).toBe(true)
    }
  })
})

describe('splitAccel', () => {
  it('splits around the first case-insensitive match, keeping the original character', () => {
    expect(splitAccel('Payroll', 'Y')).toEqual({ before: 'Pa', hit: 'y', after: 'roll' })
    expect(splitAccel('Balance sheet', 'B')).toEqual({ before: '', hit: 'B', after: 'alance sheet' })
    expect(splitAccel('Cash flow', 'F')).toEqual({ before: 'Cash ', hit: 'f', after: 'low' })
  })

  it('reports no hit when the accelerator is absent', () => {
    expect(splitAccel('TDS', 'K')).toEqual({ before: 'TDS', hit: null, after: '' })
  })

  it('is a no-op without an accelerator', () => {
    expect(splitAccel('Gateway')).toEqual({ before: 'Gateway', hit: null, after: '' })
  })

  it('honours an explicit index over the first match', () => {
    expect(splitAccel('Reconciliation', 'C', 4)).toEqual({
      before: 'Reco',
      hit: 'n',
      after: 'ciliation'
    })
  })
})
