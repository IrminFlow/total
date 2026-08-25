'use client'

import { useEffect } from 'react'

/**
 * The only motion on the site: sections lift a few pixels as they come into view.
 *
 * Three rules it follows, which is why it is JavaScript rather than a CSS class in the markup.
 * Nothing is hidden in the HTML, so a reader with JavaScript off or a crawler sees the whole page
 * — the hidden state is added by this effect and only ever to elements that are still below the
 * fold. Anything already on screen at mount is left alone, so nothing flickers on load. And
 * `prefers-reduced-motion: reduce` returns before touching the document at all, which is a
 * stronger promise than an animation that plays and is then overridden.
 *
 * Mark a section with `data-reveal` to opt it in. Mounted once, in the root layout.
 */
export default function Reveal(): null {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    if (!('IntersectionObserver' in window)) return

    const pending: Element[] = []
    for (const node of Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'))) {
      // Already visible, or nearly: leave it exactly as the server rendered it.
      if (node.getBoundingClientRect().top < window.innerHeight * 0.92) continue
      node.classList.add('reveal')
      pending.push(node)
    }
    if (pending.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          entry.target.classList.add('revealed')
          observer.unobserve(entry.target)
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    )
    for (const node of pending) observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return null
}
