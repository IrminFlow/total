import { useNav } from '../../state/stores'
import { useT } from '../../lib/i18n'
import { Button } from '../../components/ui'

/**
 * Money in / out opened from a bank statement line ("Pick the bills yourself" — MoneyLinkParams
 * with `bankId`) goes back to the Bank screen for that bank: after the save card, or when the
 * entry is given up (Esc → discard). The Bank screen below it in the stack is re-opened on that
 * bank (its own pick is not kept across screens); with none below, it opens.
 */
export function goBackToBank(bankId: number): void {
  const { stack } = useNav.getState()
  const prev = stack[stack.length - 2]
  if (prev?.name === 'simple-bank') {
    useNav.setState({ stack: [...stack.slice(0, -2), { ...prev, bankId }, stack[stack.length - 1]!] })
    useNav.getState().back()
  } else {
    useNav.getState().go({ name: 'simple-bank', bankId }) // i18n-technical: screen name
  }
}

/** The "Back to Bank" button shown with the save card of an entry made from a bank line. */
export function BackToBankButton({ bankId }: { bankId: number }): React.JSX.Element {
  const t = useT()
  return (
    <div className="mt-4 flex justify-end">
      <Button variant="primary" data-testid="btn-money-back-to-bank" onClick={() => goBackToBank(bankId)}>
        {t('simple.money.backToBank')}
      </Button>
    </div>
  )
}
