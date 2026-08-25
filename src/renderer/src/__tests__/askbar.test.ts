// The two places a shared AI value becomes renderer navigation: a deterministic ask match
// becoming a screen (roadmap #212), and a proposed draft becoming a pre-filled voucher entry
// (#206). Both are one-line mappings, and both are exactly where a unit or a name would silently
// change on the way through.
import { describe, expect, it } from 'vitest'
import { screenForAsk } from '../components/CommandPalette'
import { screenForDraft } from '../components/AskDrawer'
import { resolveAsk } from '@shared/ai/askbar'
import type { AiDraft } from '../lib/useAiStream'

const TODAY = '2026-08-24'

describe('an ask match becomes a screen', () => {
  it('opens the report a deterministic question resolved to', () => {
    expect(screenForAsk(resolveAsk('trial balance', TODAY)!)).toEqual({ name: 'trial-balance' })
    expect(screenForAsk(resolveAsk('who owes me', TODAY)!)).toEqual({ name: 'outstandings' })
  })

  it('carries a named window through to the Day Book', () => {
    const screen = screenForAsk(resolveAsk('day book last month', TODAY)!)
    expect(screen).toMatchObject({ name: 'daybook', span: { from: '2026-07-01', to: '2026-07-31' } })
  })

  it('drops a window the target screen cannot take, rather than inventing a param for it', () => {
    // Trial balance is an as-on report; a "last month" span means nothing to it.
    expect(screenForAsk(resolveAsk('trial balance last month', TODAY)!)).toEqual({ name: 'trial-balance' })
  })
})

describe('a draft becomes a voucher entry', () => {
  const draft: AiDraft = {
    runId: 'run-1',
    summary: 'payment on 2026-08-20: 12,500.00, Rent to Cash',
    openable: true,
    issues: [],
    draft: {
      kind: 'payment',
      date: '2026-08-20',
      narration: 'March rent',
      partyLedgerId: 7,
      lines: [
        { ledgerId: 3, ledgerName: 'Rent', drCr: 'dr', amountPaise: 1_250_000 },
        { ledgerId: 1, ledgerName: 'Cash', drCr: 'cr', amountPaise: 1_250_000 }
      ]
    }
  }

  it('keeps paise as paise', () => {
    const screen = screenForDraft(draft)
    expect(screen).toMatchObject({
      name: 'voucher-entry',
      kindHint: 'payment',
      draft: {
        date: '2026-08-20',
        narration: 'March rent',
        partyLedgerId: 7,
        lines: [
          { ledgerId: 3, drCr: 'dr', amount: 1_250_000 },
          { ledgerId: 1, drCr: 'cr', amount: 1_250_000 }
        ]
      }
    })
  })

  it('carries the run id, so a save can be joined back to the question', () => {
    expect(screenForDraft(draft)).toMatchObject({ draft: { aiRunId: 'run-1' } })
  })

  it('gives each draft a fresh id, so two in a row both remount the entry screen', () => {
    const first = screenForDraft(draft)
    const second = screenForDraft(draft)
    expect(first.name).toBe('voucher-entry')
    if (first.name !== 'voucher-entry' || second.name !== 'voucher-entry') throw new Error('wrong screen')
    expect(second.draftId).toBeGreaterThan(first.draftId!)
  })
})
