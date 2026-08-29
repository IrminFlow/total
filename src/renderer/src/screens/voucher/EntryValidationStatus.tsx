import { ValidationSummary } from '../../components/ui'

export function EntryValidationStatus({
  issues,
  revealIssues,
  guidance
}: {
  issues: string[]
  revealIssues: boolean
  guidance: string[]
}): React.JSX.Element {
  if (issues.length === 0) {
    return (
      <div className="rounded-md border border-dr/25 bg-dr/5 px-3 py-2" role="status" aria-live="polite">
        <p className="text-[11.5px] font-semibold text-dr">Ready to post</p>
        <p className="mt-0.5 text-[11.5px] text-muted">The entry is complete and its totals have been checked.</p>
      </div>
    )
  }

  if (revealIssues) return <ValidationSummary issues={issues} />

  return (
    <div className="rounded-md border border-line bg-panel2 px-3 py-2" role="status">
      <p className="text-[11.5px] font-semibold text-ink">Complete the entry</p>
      <ul className="mt-1 grid gap-0.5 text-[11.5px] text-muted">
        {guidance.map((item) => (
          <li key={item} className="flex gap-2">
            <span aria-hidden="true">○</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[10.5px] text-muted">Specific corrections appear after you start, or when you try to save.</p>
    </div>
  )
}
