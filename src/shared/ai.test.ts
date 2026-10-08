import { describe, expect, it } from 'vitest'
import { aggregateUsage, aiSettingsPatchSchema, formatMicroUsd, microToUsdText, parseUsdToMicro, type AiUsageRow } from './ai'

describe('micro-USD helpers (integer maths, no floats)', () => {
  it('formats to 4 decimals', () => {
    expect(formatMicroUsd(22_000)).toBe('$0.0220')
    expect(formatMicroUsd(1_234_567)).toBe('$1.2346')
    expect(formatMicroUsd(0)).toBe('$0.0000')
    expect(formatMicroUsd(null)).toBe('—')
  })
  it('parses and prints price text', () => {
    expect(parseUsdToMicro('1.25')).toBe(1_250_000)
    expect(parseUsdToMicro('$0.075')).toBe(75_000)
    expect(parseUsdToMicro('10')).toBe(10_000_000)
    expect(parseUsdToMicro('')).toBeNull()
    expect(parseUsdToMicro('1.2.3')).toBeUndefined()
    expect(parseUsdToMicro('-1')).toBeUndefined()
    expect(microToUsdText(1_250_000)).toBe('1.25')
    expect(microToUsdText(10_000_000)).toBe('10')
    expect(microToUsdText(75_000)).toBe('0.075')
    expect(microToUsdText(null)).toBe('')
  })
})

describe('aggregateUsage', () => {
  const row = (o: Partial<AiUsageRow>): AiUsageRow => ({
    id: 1, at: '2025-07-01T10:00:00Z', day: '2025-07-01', threadId: 1, threadTitle: 'Sales', model: 'm', inputTokens: 100, cachedTokens: 10,
    outputTokens: 20, costMicroUsd: 1000, durationMs: 5, ok: true, ...o
  })
  const rows = [row({ id: 1 }), row({ id: 2, costMicroUsd: null }), row({ id: 3, day: '2025-07-02', threadId: 2, threadTitle: 'GST', costMicroUsd: 500 })]
  it('totals by day, newest first, counting unpriced calls', () => {
    expect(aggregateUsage(rows, 'day')).toEqual([
      { key: '2025-07-02', label: '2025-07-02', calls: 1, inputTokens: 100, cachedTokens: 10, outputTokens: 20, costMicroUsd: 500, unpriced: 0 },
      { key: '2025-07-01', label: '2025-07-01', calls: 2, inputTokens: 200, cachedTokens: 20, outputTokens: 40, costMicroUsd: 1000, unpriced: 1 }
    ])
  })
  it('totals by conversation', () => {
    const by = aggregateUsage(rows, 'thread')
    expect(by.map((g) => [g.label, g.calls, g.costMicroUsd])).toEqual([
      ['Sales', 2, 1000],
      ['GST', 1, 500]
    ])
    expect(aggregateUsage([row({ threadId: null, threadTitle: null, costMicroUsd: null })], 'thread')[0]).toMatchObject({ label: 'Deleted conversation', costMicroUsd: null })
  })
})

describe('aiSettingsPatchSchema', () => {
  it('validates model ids and refuses unknown keys', () => {
    expect(aiSettingsPatchSchema.safeParse({ defaultModel: 'gpt-6.1-sol' }).success).toBe(true)
    expect(aiSettingsPatchSchema.safeParse({ defaultModel: 'bad model!' }).success).toBe(false)
    expect(aiSettingsPatchSchema.safeParse({ apiKey: 'sk-x' }).success).toBe(false)
    expect(aiSettingsPatchSchema.safeParse({ noticeAcceptedAt: '2025-01-01' }).success).toBe(false)
  })
})
