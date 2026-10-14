// WP 10.8 — the beginner study's fixes that live in shared renderer pieces.
//   - A viewer sees a plain note where the simple Save bar's buttons would be (never a Save that
//     main then refuses); an owner / accountant / a company without sign-ins sees the buttons.
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SaveBar } from '../simple/SaveBar'
import { periodChip } from '../simple/SimpleHeader'
import { translator } from '@shared/i18n'
import { toMonthLabel, toPlainDate } from '@shared/dates'
import { useSession } from '../state/stores'

afterEach(() => {
  cleanup()
  useSession.setState({ user: null })
})

const bar = (): void => {
  render(
    <main id="main">
      <SaveBar preview="Bill ₹100.00" previewTestId="p" shortcuts="⌘↵ saves">
        <button type="button">Save</button>
      </SaveBar>
    </main>
  )
}

describe('WP 10.8: the period chip in plain words', () => {
  const chip = (from: string, to: string, lang: 'en' | 'hi' | 'hinglish' = 'en'): string => {
    const t = translator(lang)
    return periodChip(from, to, '2026-10-14', (d) => `${toMonthLabel(d.slice(0, 7), 'short', lang)} ${d.slice(0, 4)}`, (d) => toPlainDate(d, lang), t)
  }
  it('the year holding today, another whole year, any other dates', () => {
    expect(chip('2026-04-01', '2027-03-31')).toBe('This year: Apr 2026 – Mar 2027')
    expect(chip('2025-04-01', '2026-03-31')).toBe('Apr 2025 – Mar 2026')
    expect(chip('2026-04-01', '2026-10-14')).toBe('1 Apr 2026 – 14 Oct 2026')
    expect(chip('2026-04-01', '2027-03-31', 'hinglish')).toBe('Is saal: Apr 2026 – Mar 2027')
    expect(chip('2026-04-01', '2027-03-31', 'hi')).toMatch(/^यह साल: /)
  })
})

describe('WP 10.8: the Save bar and a viewer', () => {
  it('no sign-ins / an accountant: the buttons', () => {
    bar()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    cleanup()
    useSession.setState({ user: { id: 1, name: 'Asha', role: 'accountant' } as never })
    bar()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.queryByTestId('viewer-note')).toBeNull()
  })

  it('a viewer: the note instead of Save, the preview still shown', () => {
    useSession.setState({ user: { id: 2, name: 'Vee', role: 'viewer' } as never })
    bar()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.getByTestId('viewer-note').textContent).toContain('can’t save entries')
    expect(screen.getByTestId('p').textContent).toBe('Bill ₹100.00')
  })
})
