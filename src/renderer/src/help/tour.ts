// WP 10.3: the first-run tour of the simple Home — 4 steps (make a bill, money in, who owes you,
// back up), each a spotlight on a Home element with one sentence and Next / Skip.
//
// When it shows: once per company + user, after the setup wizard made the company in simple mode
// (`markTourPending`, CompanySelect) — a display preference in localStorage, like the per-screen
// view choice (lib/mode.ts), never in the books and no migration:
//   total-tour-pending:<slug>          '1' — the wizard just made this company
//   total-tour:<slug>:<userId|->        'done' — this user has seen (or skipped) it
// Re-run from Help (the panel's "Show the tour" / Settings → Help & tour) with `useTour.start()`.
// Never in accountant mode: the tour lives on the simple Home only.
import { create } from 'zustand'
import type { MessageKey } from '@shared/i18n'

export interface TourStep {
  id: 'sale' | 'money-in' | 'owed' | 'backup'
  /** Where the spotlight goes: the first selector found on screen, with its sentence. */
  anchors: { selector: string; text: MessageKey }[]
}

export const TOUR_STEPS: readonly TourStep[] = [
  { id: 'sale', anchors: [{ selector: '[data-testid="simple-task-sale"]', text: 'simple.tour.sale' }] },
  { id: 'money-in', anchors: [{ selector: '[data-testid="simple-task-money-in"]', text: 'simple.tour.moneyIn' }] },
  {
    id: 'owed',
    anchors: [
      { selector: '[data-testid="simple-tile-receivables"]', text: 'simple.tour.owedTile' },
      { selector: '[data-testid="simple-nav-people"]', text: 'simple.tour.owedPeople' }
    ]
  },
  { id: 'backup', anchors: [{ selector: '[data-testid="btn-backup-now"]', text: 'simple.tour.backup' }] }
]

const pendingKey = (slug: string): string => `total-tour-pending:${slug}`
export const tourDoneKey = (slug: string, userId: number | null | undefined): string => `total-tour:${slug}:${userId ?? '-'}`

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable: the tour may show once more — harmless */
  }
}

/** The setup wizard made `slug` in simple mode: its users get the tour once. */
export function markTourPending(slug: string): void {
  write(pendingKey(slug), '1')
}

/** Show the tour by itself on this Home? (made by the wizard, not yet seen by this user). */
export function tourDue(slug: string | null, userId: number | null | undefined): boolean {
  if (!slug) return false
  return read(pendingKey(slug)) === '1' && read(tourDoneKey(slug, userId)) !== 'done'
}

export function markTourDone(slug: string | null, userId: number | null | undefined): void {
  if (slug) write(tourDoneKey(slug, userId), 'done')
}

interface TourStore {
  /** The step showing, or null. */
  step: number | null
  start: () => void
  next: () => void
  stop: () => void
}

export const useTour = create<TourStore>((set, get) => ({
  step: null,
  start: () => set({ step: 0 }),
  next: () => {
    const s = get().step
    set({ step: s == null || s + 1 >= TOUR_STEPS.length ? null : s + 1 })
  },
  stop: () => set({ step: null })
}))

export interface TourBox {
  top: number
  left: number
  width: number
  height: number
}
export type TourSide = 'below' | 'above' | 'right' | 'left' | 'centre'

/** Where the tour card goes for a spotlight `around` (the anchor's box already padded): below it
 *  when there is room, else above, else beside it (right, then left) — never over the anchor
 *  while any side has room — and always inside the viewport (`margin` from every edge, the card
 *  shrunk to the viewport when it is wider). With no side free (a window smaller than anchor +
 *  card) it takes the side with the most room, clamped. No anchor = the centre of the screen. */
export function placeTourCard(
  around: TourBox | null,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 12,
  margin = 12
): { top: number; left: number; width: number; side: TourSide } {
  const w = Math.min(card.width, Math.max(0, viewport.width - margin * 2))
  const h = card.height
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi))
  const clampTop = (v: number): number => clamp(v, margin, viewport.height - h - margin)
  const clampLeft = (v: number): number => clamp(v, margin, viewport.width - w - margin)
  if (!around) return { top: clampTop(viewport.height / 2 - h / 2), left: clampLeft(viewport.width / 2 - w / 2), width: w, side: 'centre' }
  const bottom = around.top + around.height
  const right = around.left + around.width
  const centredLeft = clampLeft(around.left + around.width / 2 - w / 2)
  const centredTop = clampTop(around.top + around.height / 2 - h / 2)
  const room = {
    below: viewport.height - margin - (bottom + gap),
    above: around.top - gap - margin,
    right: viewport.width - margin - (right + gap),
    left: around.left - gap - margin
  }
  if (room.below >= h) return { top: bottom + gap, left: centredLeft, width: w, side: 'below' }
  if (room.above >= h) return { top: around.top - gap - h, left: centredLeft, width: w, side: 'above' }
  if (room.right >= w) return { top: centredTop, left: right + gap, width: w, side: 'right' }
  if (room.left >= w) return { top: centredTop, left: around.left - gap - w, width: w, side: 'left' }
  // Nothing fits: the vertical side with the most room, clamped inside the window.
  return room.below >= room.above
    ? { top: clampTop(bottom + gap), left: centredLeft, width: w, side: 'below' }
    : { top: clampTop(around.top - gap - h), left: centredLeft, width: w, side: 'above' }
}
