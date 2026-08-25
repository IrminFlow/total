import { useEffect, useRef, useState } from 'react'
import { useKeyLayer } from '../lib/keyboard'
import { useNav, useRecentScreens, type Screen } from '../state/stores'
import { screenDef } from '../lib/screens'
import { Kbd } from './ui'

/**
 * ⌘` — the alt-tab ring across screens.
 *
 * ⌘[ and ⌘] already walk history, one step per press, through everything visited in between.
 * That is the wrong shape for the thing people actually do all day, which is work between two
 * screens: enter a voucher, check the Day Book, enter the next one. Going "back" from the Day
 * Book after three drills is three presses; ⌘` is one, and it is the same gesture the operating
 * system uses for the same job.
 *
 * Held rather than tapped, again like ⌘-Tab: each press of ` walks one further back through the
 * ring, and letting ⌘ go commits. So a tap is "the other screen" and a hold is "pick from the
 * last eight", with no second shortcut to learn. ⇧ walks the other way.
 *
 * The ring is FROZEN when the cycle starts. Committing a jump reorders the MRU list, and reading
 * it live mid-cycle would shuffle the entries under the highlight while the user is looking at
 * them.
 */
export function RecentRing(): React.JSX.Element | null {
  const nav = useNav()
  const [cycle, setCycle] = useState<{ items: Screen[]; index: number } | null>(null)
  const cycleRef = useRef(cycle)
  cycleRef.current = cycle

  useKeyLayer('nav', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key !== '`') return false
    e.preventDefault()
    const current = cycleRef.current
    const items = current?.items ?? useRecentScreens.getState().ring
    // One screen visited so far: there is nowhere to switch to, but the key is still ours —
    // letting it fall through would type a backtick into whatever has focus.
    if (items.length < 2) return true
    const step = e.shiftKey ? -1 : 1
    const index = current ? (current.index + step + items.length) % items.length : 1
    setCycle({ items, index })
    return true
  })

  useEffect(() => {
    if (!cycle) return
    const commit = (e: KeyboardEvent): void => {
      // Only the modifier's release ends the cycle. Releasing ` between presses is how holding
      // works at all, so it must not commit.
      if (e.key !== 'Meta' && e.key !== 'Control') return
      const chosen = cycleRef.current
      setCycle(null)
      const target = chosen?.items[chosen.index]
      if (target) nav.go(target)
    }
    const cancel = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCycle(null)
    }
    window.addEventListener('keyup', commit)
    window.addEventListener('keydown', cancel, true)
    return () => {
      window.removeEventListener('keyup', commit)
      window.removeEventListener('keydown', cancel, true)
    }
  }, [cycle, nav])

  if (!cycle) return null

  return (
    <div
      data-testid="recent-ring"
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center"
    >
      <div className="min-w-64 rounded-lg border border-line bg-panel px-2 py-2 shadow-lg">
        <p className="px-2 pb-1.5 text-micro font-semibold tracking-[0.08em] text-muted uppercase">
          Recent screens
        </p>
        <ul>
          {cycle.items.map((s, i) => (
            <li
              key={`${s.name}-${i}`}
              data-testid={`ring-${s.name}`}
              data-active={i === cycle.index}
              className={`rounded-md px-2 py-1 text-body ${
                i === cycle.index ? 'bg-accent/20 text-accent' : 'text-muted'
              }`}
            >
              {screenDef(s.name)?.navLabel ?? screenDef(s.name)?.title ?? s.name}
            </li>
          ))}
        </ul>
        <p className="px-2 pt-1.5 text-micro text-muted">
          Hold <Kbd>⌘</Kbd> and press <Kbd>`</Kbd> · <Kbd>⇧</Kbd> to go the other way
        </p>
      </div>
    </div>
  )
}
