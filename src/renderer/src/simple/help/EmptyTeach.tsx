import { useT } from '../../lib/i18n'
import { Button } from '../../components/kit'
import { useHelpPanel } from '../../help/store'
import type { HelpArticleId } from '../../help/articles'

/**
 * WP 10.3 (plan §5 "Empty states that teach"): what a simple screen shows before it has anything —
 * ONE line saying what the screen is for, ONE primary button that starts the flow that fills it,
 * and "Learn how", which opens its help article. Every screen's empty state is this component
 * (emptyStates.test.tsx), so they all read and look the same.
 */
export function EmptyTeach({ testId, purpose, action, help }: {
  testId: string
  purpose: string
  /** The flow that fills the screen; omitted only when the user may not start it (a viewer). */
  action?: { label: string; onClick: () => void; testId: string }
  help: HelpArticleId
}): React.JSX.Element {
  const t = useT()
  return (
    <section
      data-testid={testId}
      data-empty-state=""
      className="flex flex-col items-center rounded-lg border border-dashed border-line bg-panel px-panel py-10 text-center"
    >
      <p className="max-w-lg text-lead text-ink" data-testid="empty-purpose">
        {purpose}
      </p>
      {action && (
        <Button className="mt-5" variant="primary" data-testid={action.testId} data-empty-action="" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
      <button
        type="button"
        className="mt-3 text-detail text-blue underline-offset-2 hover:underline"
        data-testid="empty-learn"
        data-help={help}
        onClick={() => useHelpPanel.getState().openArticle(help)}
      >
        {t('simple.help.learnHow')}
      </button>
    </section>
  )
}
