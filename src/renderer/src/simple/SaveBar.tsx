import type { ReactNode } from 'react'

/**
 * WP 10.5 — the sticky Save bar of the simple entry screens (Make a bill, Record a purchase,
 * Money in / out / move, Returns). It carries the plain preview line ("Bill ₹1,180.00 to Ramesh.
 * ₹500.00 by UPI now …") next to the total, so what will be saved is in view with the Save button
 * at every window height — before, the line sat just above the bar and was hidden under it until
 * the screen was scrolled to the end (the 9.2 / 9.3 deferred item at 900 px). The preview is a
 * polite live region; the key hints hide on short windows (≤ 760 px).
 */
export function SaveBar({
  total,
  totalTestId,
  preview,
  previewTestId,
  shortcuts,
  children
}: {
  /** The formatted total (omit for flows without one). */
  total?: string
  totalTestId?: string
  preview: ReactNode
  previewTestId: string
  shortcuts: string
  /** The buttons (Start again, Save). */
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      data-testid="save-bar"
      className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line bg-canvas/95 px-1 py-3 backdrop-blur"
    >
      <div className="min-w-0 flex-1 basis-72">
        <div className="flex items-baseline gap-3">
          {total != null && (
            <span className="num shrink-0 text-body font-semibold text-ink" data-testid={totalTestId}>
              {total}
            </span>
          )}
          <div aria-live="polite" className="min-h-5 min-w-0 text-body text-ink" data-testid={previewTestId}>
            {preview}
          </div>
        </div>
        <p className="text-small text-muted [@media(max-height:760px)]:hidden">{shortcuts}</p>
      </div>
      <div className="flex shrink-0 gap-2">{children}</div>
    </div>
  )
}
