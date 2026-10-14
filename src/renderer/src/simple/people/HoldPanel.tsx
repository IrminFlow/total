import { useState } from 'react'
import type { PersonView } from '@shared/simple/people'
import { receivablesApi } from '../../lib/receivablesClient'
import { useT } from '../../lib/i18n'
import { useToasts } from '../../state/stores'
import { Button, Field, TextInput, useFormErrors } from '../../components/ui'

const REASON = 'reason' as const // i18n-technical: form field path

/**
 * WP 9.8 — Put a customer on hold / take them off it (the owner only — the button shows only for
 * them; main refuses anyone else): the WP 4.2 credit hold (receivables:setHold, audited), so new
 * bills on credit to them are refused until the owner lifts it. Putting on hold asks why.
 */
export function HoldPanel({ person, onDone }: { person: PersonView; onDone: () => void }): React.JSX.Element {
  const t = useT()
  const toast = useToasts()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const errors = useFormErrors<'reason'>({ reason }, { simple: true, t })
  const submit = async (): Promise<void> => {
    if (!person.onHold && !reason.trim()) {
      errors.set(REASON, t('simple.people.hold.reasonNeeded'))
      return
    }
    setBusy(true)
    try {
      await receivablesApi.setHold(person.ledgerId, !person.onHold, person.onHold ? '' : reason.trim())
      onDone()
    } catch (e) {
      const mapped = errors.apply(e)
      if (mapped.general) toast.push('error', mapped.general)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="mt-4 rounded-lg border border-line bg-panel p-panel shadow-elev-1" data-testid="person-hold-panel">
      {!person.onHold && (
        <>
          <h2 className="text-subtitle font-semibold text-ink">{t('simple.people.hold.title', { name: person.name })}</h2>
          <p className="mt-1 text-detail text-muted">{t('simple.people.hold.explain')}</p>
          <Field className="mt-3 max-w-md" label={t('simple.people.hold.reason')} name={REASON} error={errors.get(REASON)}>
            <TextInput value={reason} data-testid="input-hold-reason" onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
          </Field>
        </>
      )}
      <div className="mt-3">
        <Button variant={person.onHold ? 'primary' : 'danger'} data-testid="btn-hold-confirm" disabled={busy} onClick={() => void submit()}>
          {person.onHold ? t('simple.people.unhold') : t('simple.people.hold')}
        </Button>
      </div>
    </section>
  )
}
