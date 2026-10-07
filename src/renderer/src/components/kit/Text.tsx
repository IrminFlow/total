import type { ReactNode } from 'react'
import { formatPaise } from '@shared/money'

/** A key cap: <Kbd>⌘K</Kbd>. */
export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded border border-line bg-panel2 px-1.5 py-0.5 font-mono text-label text-muted">
      {children}
    </kbd>
  )
}

/** A section heading inside a page (the page title itself is PageHeader's h1). */
export function SectionTitle({
  children,
  right,
  as: Tag = 'h2'
}: {
  children: ReactNode
  right?: ReactNode
  as?: 'h2' | 'h3'
}): React.JSX.Element {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <Tag className={`font-serif font-semibold tracking-tight whitespace-nowrap ${Tag === 'h2' ? 'text-heading' : 'text-title'}`}>
        {children}
      </Tag>
      {right}
    </div>
  )
}

/** Signed paise rendered ledger-style: Dr green / Cr red, mono, dash for zero. */
export function Money({ paise, signed = false, className = '' }: { paise: number; signed?: boolean; className?: string }): React.JSX.Element {
  const tone = signed ? (paise > 0 ? 'text-dr' : paise < 0 ? 'text-cr' : 'text-muted') : ''
  return (
    <span className={`num ${tone} ${className}`}>
      {formatPaise(signed ? Math.abs(paise) : paise, { zeroDash: true })}
      {signed && paise !== 0 ? (paise > 0 ? ' Dr' : ' Cr') : ''}
    </span>
  )
}
