import { describe, it, expect } from 'vitest'
import { capVerdict, estimateCostPaise, priceFor, FALLBACK_PRICE } from './cost'

describe('model pricing', () => {
  it('prefers the longest match, so a mini model is not billed as its bigger sibling', () => {
    expect(priceFor('gpt-4o-mini').price.prefix).toBe('gpt-4o-mini')
    expect(priceFor('gpt-4o').price.prefix).toBe('gpt-4o')
    expect(priceFor('gpt-4.1-mini-2026-01').price.prefix).toBe('gpt-4.1-mini')
  })

  it('charges an unknown model at the fallback rather than at zero', () => {
    const unknown = priceFor('some-new-model-v9')
    expect(unknown.known).toBe(false)
    expect(unknown.price).toBe(FALLBACK_PRICE)
    // A cap that stops counting on an unrecognised model is not a cap.
    expect(estimateCostPaise('some-new-model-v9', 100_000, 10_000).paise).toBeGreaterThan(0)
  })

  it('a local endpoint costs nothing', () => {
    expect(estimateCostPaise('llama3', 1_000_000, 1_000_000, { local: true })).toEqual({ paise: 0, known: true })
  })

  it('rounds up, so a long session never drifts in the user’s disfavour', () => {
    // One token of a cheap model is a fraction of a paisa; it must still cost one.
    expect(estimateCostPaise('gpt-4o-mini', 1, 0).paise).toBe(1)
  })

  it('is integer paise, always', () => {
    const { paise } = estimateCostPaise('gpt-4o', 123_456, 7_890)
    expect(Number.isInteger(paise)).toBe(true)
  })
})

describe('spend caps', () => {
  const base = { sessionPaise: 0, todayPaise: 0, sessionCapPaise: 10_000, dailyCapPaise: 50_000 }

  it('lets an ordinary run through', () => {
    expect(capVerdict(base)).toEqual({ blocked: false })
  })

  it('blocks at the session cap and says how to proceed', () => {
    const v = capVerdict({ ...base, sessionPaise: 10_000 })
    expect(v.blocked).toBe(true)
    expect(v).toMatchObject({ scope: 'session' })
    if (v.blocked) expect(v.message).toMatch(/Settings/)
  })

  it('blocks at the daily cap even in a fresh session', () => {
    expect(capVerdict({ ...base, todayPaise: 50_000 })).toMatchObject({ blocked: true, scope: 'day' })
  })

  it('treats a zero cap as a second off-switch', () => {
    expect(capVerdict({ ...base, sessionCapPaise: 0 })).toMatchObject({ blocked: true })
    expect(capVerdict({ ...base, dailyCapPaise: 0 })).toMatchObject({ blocked: true })
  })

  it('never blocks a local endpoint — there is nothing to spend', () => {
    expect(capVerdict({ ...base, sessionPaise: 999_999, todayPaise: 999_999, local: true })).toEqual({ blocked: false })
  })
})
