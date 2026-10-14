import { useT } from '../lib/i18n'
import { Button } from '../components/ui'
import { MenuButton } from '../components/kit/Menu'
import { PlainIcon } from './icons'

/**
 * WP 9.10: every simple screen's "Accountant view" — a one-off (this time only), with a small menu
 * next to it holding "Always open the full app for this", which remembers the choice for this
 * screen and user until "Back to simple" (lib/mode.ts, lib/handoff.ts). `chip` = the header style.
 */
export function AccountantViewButton({
  testId,
  title,
  onOpen,
  chipClassName
}: {
  testId: string
  title: string
  /** `always` = the remembered choice was picked. */
  onOpen: (always: boolean) => void
  /** Draw as a header chip (with these classes) instead of a ghost button. */
  chipClassName?: string
}): React.JSX.Element {
  const t = useT()
  const more = (
    <MenuButton
      label={t('simple.handoff.more')}
      testId={`${testId}-more`}
      align="right"
      width={280}
      items={[{ label: t('simple.handoff.always'), testId: `${testId}-always`, onSelect: () => onOpen(true) }]} // i18n-technical: test id
    >
      <PlainIcon id="more" className="h-4 w-4" />
    </MenuButton>
  )
  return (
    <span className="inline-flex items-center gap-1">
      {chipClassName ? (
        <button type="button" data-testid={testId} className={chipClassName} title={title} onClick={() => onOpen(false)}>
          {t('common.accountantView')}
        </button>
      ) : (
        <Button variant="ghost" data-testid={testId} title={title} onClick={() => onOpen(false)}>
          {t('common.accountantView')}
        </Button>
      )}
      {more}
    </span>
  )
}
