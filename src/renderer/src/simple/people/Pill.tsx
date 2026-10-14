import type { ReactNode } from 'react'

const TONE_CLS = {
  danger: 'border-danger/50 bg-danger-soft text-danger',
  success: 'border-success/50 bg-success-soft text-ink',
  amber: 'border-amber/60 bg-amberbar/10 text-ink',
  neutral: 'border-line bg-panel2 text-ink'
} as const

/** WP 9.8 — a small status chip on the People screens (late, paid ahead, on hold). */
export function Pill({ tone, testId, data, children }: { tone: keyof typeof TONE_CLS; testId: string; data?: string; children: ReactNode }): React.JSX.Element {
  return (
    <span className={`mr-1 inline-block rounded-full border px-2 py-0.5 text-caption whitespace-nowrap ${TONE_CLS[tone]}`} data-testid={testId} data-value={data}>
      {children}
    </span>
  )
}
