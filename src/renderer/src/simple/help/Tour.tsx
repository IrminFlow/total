// WP 10.3 — the first-run tour of the simple Home (help/tour.ts holds when it shows and the
// steps): a spotlight on one Home element, one sentence, Next / Skip. Enter advances, Esc skips
// (when no box has the focus). It never blocks the screen: a click anywhere outside the card ends
// it and the click goes through (the user has started — Home stays usable). Leaving Home ends it.
// Once ended (skipped, finished or left) it does not come back by itself for this company + user;
// Help → "Show the tour" runs it again.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../lib/i18n'
import { useMode } from '../../lib/mode'
import { useSession } from '../../state/stores'
import { Button } from '../../components/kit'
import { TOUR_STEPS, markTourDone, tourDue, useTour } from '../../help/tour'

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

/** HomeTours on screen (0 = Home was left). */
let mounted = 0

const PAD = 6
const SCRIM = '0 0 0 9999px rgb(0 0 0 / 0.45)' // i18n-technical: the dimmed screen around the spotlight
const CARD_W = 340

function findAnchor(i: number): { el: Element; text: (typeof TOUR_STEPS)[number]['anchors'][number]['text'] } | null {
  for (const a of TOUR_STEPS[i]?.anchors ?? []) {
    const el = document.querySelector(a.selector)
    if (el) return { el, text: a.text }
  }
  return null
}

const typing = (el: Element | null): boolean =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable)

/** Mounted by the simple Home. Starts by itself once (tourDue); Help starts it with useTour.start(). */
export function HomeTour(): React.JSX.Element | null {
  const mode = useMode()
  const slug = useSession((s) => s.slug)
  const userId = useSession((s) => s.user?.id ?? null)
  const step = useTour((s) => s.step)

  useEffect(() => {
    if (mode === 'simple' && tourDue(slug, userId)) useTour.getState().start()
  }, [mode, slug, userId])
  // Leaving Home (or the company) ends the tour — it is about Home. Checked a tick later, so a
  // remount in place (React's development double effects) is not taken for leaving.
  useEffect(() => {
    mounted++
    const who = { slug: useSession.getState().slug, userId: useSession.getState().user?.id ?? null }
    return () => {
      mounted--
      window.setTimeout(() => {
        if (mounted > 0 || useTour.getState().step == null) return
        useTour.getState().stop()
        markTourDone(who.slug, who.userId)
      }, 0)
    }
  }, [])
  if (mode !== 'simple' || step == null) return null
  return <TourStepView step={step} onEnd={() => {
    useTour.getState().stop()
    markTourDone(slug, userId)
  }} />
}

function TourStepView({ step, onEnd }: { step: number; onEnd: () => void }): React.JSX.Element | null {
  const t = useT()
  const cardRef = useRef<HTMLDivElement>(null)
  const nextRef = useRef<HTMLButtonElement>(null)
  const [rect, setRect] = useState<Rect | null>(null)
  const [text, setText] = useState<(typeof TOUR_STEPS)[number]['anchors'][number]['text'] | null>(null)
  const last = step === TOUR_STEPS.length - 1
  // The card's real height (a long sentence, a larger text size) decides above / below.
  const [cardH, setCardH] = useState(170)
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight
    if (h && h !== cardH) setCardH(h)
  })

  const next = useCallback((): void => {
    if (last) onEnd()
    else useTour.getState().next()
  }, [last, onEnd])

  // Measure the anchor now and whenever the layout moves (data arriving, resize, scroll).
  useLayoutEffect(() => {
    const measure = (): void => {
      const found = findAnchor(step)
      setText(found?.text ?? TOUR_STEPS[step]!.anchors[0]!.text)
      if (!found) return setRect(null)
      const r = found.el.getBoundingClientRect()
      setRect((old) => (old && old.top === r.top && old.left === r.left && old.width === r.width && old.height === r.height ? old : { top: r.top, left: r.left, width: r.width, height: r.height }))
    }
    findAnchor(step)?.el.scrollIntoView?.({ block: 'nearest' }) // i18n-technical
    measure()
    const id = window.setInterval(measure, 200)
    window.addEventListener('resize', measure) // i18n-technical
    return () => {
      window.clearInterval(id)
      window.removeEventListener('resize', measure) // i18n-technical
    }
  }, [step])

  useEffect(() => {
    nextRef.current?.focus({ preventScroll: true })
  }, [step])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const active = document.activeElement
      if (typing(active)) return
      const inCard = !!active && !!cardRef.current?.contains(active)
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onEnd()
      } else if (e.key === 'Enter' && (!active || active === document.body || (inCard && active === cardRef.current))) {
        // On a focused button Enter presses that button (Next or Skip) by itself.
        e.preventDefault()
        e.stopPropagation()
        next()
      }
    }
    // A click outside the card: the user has started — end the tour, let the click through.
    const onDown = (e: PointerEvent): void => {
      if (cardRef.current && e.target instanceof Node && cardRef.current.contains(e.target)) return
      onEnd()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true) // i18n-technical
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true) // i18n-technical
    }
  }, [next, onEnd])

  const vw = typeof window === 'undefined' ? 1024 : window.innerWidth
  const vh = typeof window === 'undefined' ? 768 : window.innerHeight
  const below = !rect || rect.top + rect.height + PAD + 12 + cardH + 12 <= vh
  const cardTop = rect
    ? Math.min(Math.max(12, below ? rect.top + rect.height + PAD + 12 : rect.top - PAD - 12 - cardH), Math.max(12, vh - cardH - 12))
    : vh / 2 - cardH / 2
  const cardLeft = rect ? Math.min(Math.max(12, rect.left + rect.width / 2 - CARD_W / 2), vw - CARD_W - 12) : vw / 2 - CARD_W / 2

  // In a portal on <body>: an animated (transformed) screen would otherwise move the fixed layer.
  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-40" data-testid="tour" data-step={TOUR_STEPS[step]!.id}>
      {rect ? (
        <div
          aria-hidden="true"
          data-testid="tour-spotlight"
          className="absolute rounded-lg ring-2 ring-amber"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: SCRIM
          }}
        />
      ) : (
        <div aria-hidden="true" className="absolute inset-0 bg-black/45" />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="false"
        aria-label={t('simple.tour.label')}
        aria-describedby="tour-progress tour-text" // i18n-technical: element ids
        tabIndex={-1}
        data-testid="tour-card"
        className="pointer-events-auto absolute rounded-xl border border-line bg-raised p-4 shadow-elev-3 outline-none"
        style={{ top: cardTop, left: cardLeft, width: CARD_W }}
      >
        <p id="tour-progress" className="text-caption font-semibold tracking-[0.08em] text-muted uppercase" data-testid="tour-progress">
          {t('simple.tour.step', { step: step + 1, total: TOUR_STEPS.length })}
        </p>
        <p id="tour-text" aria-live="polite" className="mt-1.5 text-body text-ink" data-testid="tour-text">
          {text ? t(text) /* i18n-technical: keyed in help/tour.ts */ : null}
        </p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <Button size="sm" variant="ghost" data-testid="tour-skip" onClick={onEnd}>
            {t('simple.tour.skip')}
          </Button>
          <Button size="sm" variant="primary" ref={nextRef} data-testid="tour-next" onClick={next}>
            {last ? t('simple.tour.done') : t('simple.tour.next')}
          </Button>
        </div>
        <p className="mt-2 text-hint text-muted">{t('simple.tour.keys')}</p>
      </div>
    </div>,
    document.body
  )
}
