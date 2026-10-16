// WP 10.3 — the first-run tour of the simple Home: shown once per company + user after the setup
// wizard (a localStorage flag, no migration), 4 steps anchored to Home's elements, Next / Skip,
// Enter advances and Esc skips, a click outside ends it, never in accountant mode, and Help runs
// it again.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import { useSession } from '../state/stores'
import { HomeTour } from '../simple/help/Tour'
import { TOUR_STEPS, markTourPending, placeTourCard, tourDoneKey, tourDue, useTour, type TourBox } from '../help/tour'

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
    // Review: a screen reader hears the step and its sentence with the focused Next button's card
    // (the card is described by them, and the sentence is announced as it changes).
    const card = screen.getByRole('dialog', { name: 'A quick tour of Home' })
    const described = card.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent)
    expect(described).toEqual(['Step 1 of 4', screen.getByTestId('tour-text').textContent])
    expect(screen.getByTestId('tour-text').getAttribute('aria-live')).toBe('polite')
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

/** Two boxes overlap (strictly — touching edges is fine). */
const overlaps = (a: TourBox, b: TourBox): boolean =>
  a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height

describe('tour card placement (never over its anchor)', () => {
  const card = { width: 340, height: 170 }
  const vp = { width: 1024, height: 700 }
  const inside = (p: { top: number; left: number; width: number }, h = card.height): boolean =>
    p.top >= 12 && p.left >= 12 && p.left + p.width <= vp.width - 12 && p.top + h <= vp.height - 12

  it('below when there is room, above near the bottom, beside a tall anchor, clamped to the window', () => {
    const cases: [TourBox, string][] = [
      [{ top: 80, left: 300, width: 120, height: 40 }, 'below'],
      [{ top: 600, left: 300, width: 120, height: 40 }, 'above'],
      [{ top: 150, left: 40, width: 300, height: 400 }, 'right'], // a tall tile on the left
      [{ top: 150, left: 640, width: 330, height: 400 }, 'left'], // a tall tile on the right
      [{ top: 80, left: 0, width: 60, height: 40 }, 'below'], // against the left edge: clamped in
      [{ top: 80, left: 980, width: 40, height: 40 }, 'below'] // against the right edge
    ]
    for (const [anchor, side] of cases) {
      const p = placeTourCard(anchor, card, vp)
      expect(p.side, JSON.stringify(anchor)).toBe(side)
      expect(overlaps({ top: p.top, left: p.left, width: p.width, height: card.height }, anchor), JSON.stringify(anchor)).toBe(false)
      expect(inside(p), JSON.stringify({ anchor, p })).toBe(true)
    }
  })

  it('no anchor = the centre; a narrow window shrinks the card to fit', () => {
    expect(placeTourCard(null, card, vp)).toMatchObject({ side: 'centre', top: 265, left: 342 })
    const narrow = placeTourCard({ top: 50, left: 10, width: 100, height: 30 }, card, { width: 300, height: 600 })
    expect(narrow.width).toBe(276)
    expect(narrow.left).toBe(12)
  })

  it('the rendered card sits clear of the spotlight on a tall Home tile (mocked layout at 1024×700)', async () => {
    const realRect = Element.prototype.getBoundingClientRect
    const realW = window.innerWidth
    const realH = window.innerHeight
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 })
    // The receivables tile: tall, from near the top to near the bottom, on the left.
    const tile = { top: 140, left: 60, width: 300, height: 480 }
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const id = this.getAttribute('data-testid')
      const r = id === 'simple-tile-receivables' ? tile : { top: 80, left: 300, width: 120, height: 40 }
      return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect
    }
    try {
      markTourPending('ramesh')
      render(<Home />)
      act(() => useTour.setState({ step: 2 }))
      await flush()
      const cardEl = screen.getByTestId('tour-card')
      expect(screen.getByTestId('tour').getAttribute('data-step')).toBe('owed')
      expect(cardEl.getAttribute('data-side')).toBe('right')
      const box = { top: parseFloat(cardEl.style.top), left: parseFloat(cardEl.style.left), width: parseFloat(cardEl.style.width), height: 170 }
      const spot = screen.getByTestId('tour-spotlight')
      const spotBox = { top: parseFloat(spot.style.top), left: parseFloat(spot.style.left), width: parseFloat(spot.style.width), height: parseFloat(spot.style.height) }
      expect(overlaps(box, spotBox)).toBe(false)
      expect(box.left + box.width).toBeLessThanOrEqual(1024 - 12)
    } finally {
      Element.prototype.getBoundingClientRect = realRect
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: realW })
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: realH })
    }
  })
})
