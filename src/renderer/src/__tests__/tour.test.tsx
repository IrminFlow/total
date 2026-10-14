// WP 10.3 — the first-run tour of the simple Home: shown once per company + user after the setup
// wizard (a localStorage flag, no migration), 4 steps anchored to Home's elements, Next / Skip,
// Enter advances and Esc skips, a click outside ends it, never in accountant mode, and Help runs
// it again.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import { useSession } from '../state/stores'
import { HomeTour } from '../simple/help/Tour'
import { TOUR_STEPS, markTourPending, tourDoneKey, tourDue, useTour } from '../help/tour'

/** The four Home elements the tour points at (the tile only once there are figures). */
function Home({ tile = true }: { tile?: boolean }): React.JSX.Element {
  return (
    <div>
      <button type="button" data-testid="simple-task-sale">+ Sale</button>
      <button type="button" data-testid="simple-task-money-in">Money in</button>
      {tile && <div data-testid="simple-tile-receivables">₹0</div>}
      <button type="button" data-testid="simple-nav-people">People</button>
      <button type="button" data-testid="btn-backup-now">Back up now</button>
      <button type="button" data-testid="outside">elsewhere</button>
      <HomeTour />
    </div>
  )
}

const session = (slug: string, mode: 'simple' | 'accountant' = 'simple', userId: number | null = null): void => {
  act(() => {
    useSession.setState({ slug, ui: { mode }, user: userId == null ? null : { id: userId, name: 'U', role: 'owner' } } as never)
  })
}
const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5))
  })
}

beforeEach(() => {
  localStorage.clear()
  useTour.setState({ step: null })
  session('ramesh')
})
afterEach(() => {
  cleanup()
})

describe('first-run tour (WP 10.3)', () => {
  it('shows after setup, walks 4 steps over Home with Next, and then never again for that user', async () => {
    markTourPending('ramesh')
    render(<Home />)
    expect(screen.getByTestId('tour').getAttribute('data-step')).toBe('sale')
    expect(screen.getByTestId('tour-progress').textContent).toBe('Step 1 of 4')
    expect(screen.getByTestId('tour-text').textContent).toContain('make a bill')
    expect(screen.getByTestId('tour-spotlight')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByTestId('tour-next'))
    const seen: string[] = []
    for (let i = 0; i < 4; i++) {
      seen.push(screen.getByTestId('tour').getAttribute('data-step')!)
      fireEvent.click(screen.getByTestId('tour-next'))
    }
    expect(seen).toEqual(['sale', 'money-in', 'owed', 'backup'])
    expect(screen.queryByTestId('tour')).toBeNull()
    expect(localStorage.getItem(tourDoneKey('ramesh', null))).toBe('done')
    cleanup()
    render(<Home />)
    expect(screen.queryByTestId('tour')).toBeNull()
  })

  it('the last step says Done; every sentence is plain (no banned word)', () => {
    markTourPending('ramesh')
    render(<Home />)
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByTestId('tour-next'))
    expect(screen.getByTestId('tour-next').textContent).toBe('Done')
    for (const step of TOUR_STEPS) for (const a of step.anchors) expect(bannedWordsIn(a.text)).toEqual([])
    expect(bannedWordsIn(document.body.textContent ?? '')).toEqual([])
  })

  it('Skip ends it and remembers it', () => {
    markTourPending('ramesh')
    render(<Home />)
    fireEvent.click(screen.getByTestId('tour-skip'))
    expect(screen.queryByTestId('tour')).toBeNull()
    expect(tourDue('ramesh', null)).toBe(false)
  })

  it('keyboard: Enter advances (focus on nothing), Esc skips', () => {
    markTourPending('ramesh')
    render(<Home />)
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(screen.getByTestId('tour').getAttribute('data-step')).toBe('money-in')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('tour')).toBeNull()
    expect(tourDue('ramesh', null)).toBe(false)
  })

  it('a click outside the card ends it (and the click goes through)', () => {
    markTourPending('ramesh')
    render(<Home />)
    fireEvent.pointerDown(screen.getByTestId('outside'))
    expect(screen.queryByTestId('tour')).toBeNull()
    expect(tourDue('ramesh', null)).toBe(false)
  })

  it('the "who owes you" step points at People while Home has no figures yet', () => {
    markTourPending('ramesh')
    render(<Home tile={false} />)
    fireEvent.click(screen.getByTestId('tour-next'))
    fireEvent.click(screen.getByTestId('tour-next'))
    expect(screen.getByTestId('tour').getAttribute('data-step')).toBe('owed')
    expect(screen.getByTestId('tour-text').textContent).toContain('People shows every customer')
  })

  it('once per company AND user: another user gets it, a company the wizard did not make does not', async () => {
    markTourPending('ramesh')
    session('ramesh', 'simple', 1)
    render(<Home />)
    fireEvent.click(screen.getByTestId('tour-skip'))
    cleanup()
    session('ramesh', 'simple', 2)
    render(<Home />)
    expect(screen.getByTestId('tour')).toBeTruthy()
    fireEvent.click(screen.getByTestId('tour-skip'))
    cleanup()
    session('ramesh', 'simple', 1)
    render(<Home />)
    expect(screen.queryByTestId('tour')).toBeNull()
    cleanup()
    session('other', 'simple', 1)
    render(<Home />)
    expect(screen.queryByTestId('tour')).toBeNull()
  })

  it('never in accountant mode — not by itself, not when started', () => {
    markTourPending('ramesh')
    session('ramesh', 'accountant')
    render(<Home />)
    expect(screen.queryByTestId('tour')).toBeNull()
    act(() => useTour.getState().start())
    expect(screen.queryByTestId('tour')).toBeNull()
  })

  it('Help runs it again (useTour.start), even after it was skipped; leaving Home ends it', async () => {
    render(<Home />)
    expect(screen.queryByTestId('tour')).toBeNull()
    act(() => useTour.getState().start())
    expect(screen.getByTestId('tour').getAttribute('data-step')).toBe('sale')
    cleanup() // Home unmounts — the tour ends and counts as seen
    await flush()
    expect(useTour.getState().step).toBeNull()
  })
})
