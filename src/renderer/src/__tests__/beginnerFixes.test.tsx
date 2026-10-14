// WP 10.8 — the beginner study's fixes that live in shared renderer pieces.
//   - A viewer sees a plain note where the simple Save bar's buttons would be (never a Save that
//     main then refuses); an owner / accountant / a company without sign-ins sees the buttons.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SaveBar } from '../simple/SaveBar'
import { SimpleBackups } from '../simple/SimpleBackups'
import { periodChip } from '../simple/SimpleHeader'
import { translator } from '@shared/i18n'
import { toMonthLabel, toPlainDate } from '@shared/dates'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import { useNav, useSession } from '../state/stores'

describe('WP 10.8: the plain Backups screen', () => {
  it('the last backup in a sentence, Back up now says where the file went, the full list behind a button', async () => {
    const day = new Date(2026, 9, 12, 10, 0).getTime()
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'backup:list') return { ok: true, data: [{ file: 'a.db', sizeBytes: 10, mtime: day, tag: 'manual' }] }
      if (channel === 'backup:run') return { ok: true, data: { path: '/Users/x/Documents/total/shop/backups/manual.db' } }
      return { ok: true, data: null }
    })
    window.total = { platform: 'test', invoke } as never
    useNav.setState({ stack: [{ name: 'simple-backups' }] })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <SimpleBackups />
      </QueryClientProvider>
    )
    expect(await screen.findByText('Your last backup was made on 12 Oct 2026.')).toBeTruthy()
    fireEvent.click(screen.getByTestId('btn-simple-backup-now'))
    expect((await screen.findByTestId('simple-backups-saved')).textContent).toContain('/Users/x/Documents/total/shop/backups/manual.db')
    expect(bannedWordsIn(document.body.textContent ?? '')).toEqual([])
    expect(document.body.textContent).not.toMatch(/SHA-256|voucher|ledger/i)
    fireEvent.click(screen.getByTestId('btn-simple-backups-all'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'settings', tab: 'backups' }))
  })
})

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
