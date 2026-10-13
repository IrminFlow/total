import { useState, type ReactNode } from 'react'
import { PopoverButton } from '../table/Popover'

/**
 * "Why?" (plan 2026-10-13 §5, WP 8.6): a small button that opens a popover with the one-sentence
 * explanation of a figure. The sentence is computed (shared/simple/explain.ts), never typed by
 * hand or written by a model; `link` opens the full report behind it. The kit takes every word
 * as a prop so callers pass them through t().
 */
export function Why({
  label,
  ariaLabel,
  sentence,
  children,
  link,
  testId
}: {
  /** Trigger text ("Why?"). */
  label: string
  /** Accessible name of the trigger, e.g. "Why this number: Customers owe you". */
  ariaLabel: string
  sentence: string
  /** Extra content under the sentence (a short list of figures). */
  children?: ReactNode
  link?: { label: string; onOpen: () => void }
  testId?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <PopoverButton
      label={ariaLabel}
      popoverLabel={ariaLabel}
      open={open}
      setOpen={setOpen}
      align="left"
      width={320}
      testId={testId}
      className="!border-transparent !bg-transparent !px-0 !py-0 text-hint !text-blue hover:underline"
      render={(close) => (
        <div className="flex flex-col gap-2" data-testid={testId && `${testId}-body`}>
          <p className="text-detail text-ink" data-testid={testId && `${testId}-sentence`}>
            {sentence}
          </p>
          {children}
          {link && (
            <button
              type="button"
              data-testid={testId && `${testId}-link`}
              className="self-start text-hint text-blue hover:underline"
              onClick={() => {
                close()
                link.onOpen()
              }}
            >
              {link.label} →
            </button>
          )}
        </div>
      )}
    >
      {label}
    </PopoverButton>
  )
}
