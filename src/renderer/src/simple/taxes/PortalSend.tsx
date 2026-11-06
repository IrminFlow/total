import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { gstPeriodOf } from '@shared/dates'
import { mapError, type CaughtError } from '@shared/errors'
import type { GatewayForm, GatewayReturnRecord } from '@shared/gstGateway'
import type { SimpleTaxes } from '@shared/simple/taxes'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useToasts } from '../../state/stores'
import { Button, TextInput } from '../../components/ui'

type Regular = Extract<SimpleTaxes, { kind: 'regular' }>
const FORMS: readonly GatewayForm[] = ['gstr1', 'gstr3b']
const FORM_NAME: Record<GatewayForm, string> = { gstr1: 'GSTR-1', gstr3b: 'GSTR-3B' } // i18n-technical
/** A return's state on the portal in plain words. */
function stateText(state: GatewayReturnRecord['state'], form: string, t: ReturnType<typeof useT>): string {
  switch (state) {
    case 'saved': return t('simple.taxes.portal.state.saved', { form })
    case 'processing': return t('simple.taxes.portal.state.processing', { form })
    case 'processed': return t('simple.taxes.portal.state.processed', { form })
    case 'error': return t('simple.taxes.portal.state.error', { form })
    case 'offset': return t('simple.taxes.portal.state.offset', { form })
    case 'filed': return t('simple.taxes.portal.state.filed', { form })
  }
}

/** A refusal in the reader's words: the mapped message, else the field's, else the portal's own. */
function plainError(err: unknown, t: ReturnType<typeof useT>): string {
  const m = mapError(err as CaughtError, { simple: true, t })
  return m.general ?? Object.values(m.fields)[0] ?? (err as Error).message
}

/** The 6-digit code box and its button. */
function CodeEntry({ testId, button, hint, busy, onSubmit }: { testId: string; button: string; hint: string | null; busy: boolean; onSubmit: (otp: string) => void }): React.JSX.Element {
  const t = useT()
  const [otp, setOtp] = useState('')
  return (
    <div className="flex flex-wrap items-center gap-2">
      <TextInput className="!w-28" inputMode="numeric" maxLength={6} aria-label={t('simple.taxes.portal.code')} data-testid={`${testId}-otp`} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} />
      <Button size="sm" variant="primary" data-testid={`${testId}-submit`} disabled={busy || otp.length !== 6} onClick={() => onSubmit(otp)}>
        {button}
      </Button>
      {hint && <span className="text-small text-muted">{hint}</span>}
    </div>
  )
}

/** One return: send → check → (3B) pay from credit and cash → code → file. */
function PortalReturn({ form, period, onFiled }: { form: GatewayForm; period: string; onFiled: () => void }): React.JSX.Element {
  const t = useT()
  const push = useToasts((s) => s.push)
  const queryClient = useQueryClient()
  const { data: status } = useQuery({ queryKey: ['gatewayStatus'], queryFn: api.gateway.status }) // i18n-technical
  const { data: rec } = useQuery({ queryKey: ['gatewayReturn', form, period], queryFn: () => api.gateway.returnGet(form, period) }) // i18n-technical
  const [busy, setBusy] = useState(false)
  const [codeOpen, setCodeOpen] = useState(false)
  const name = FORM_NAME[form]
  const tid = `taxes-portal-${form}`
  const hint = status?.testHints ? t('simple.taxes.portal.codeHint', { otp: status.testHints.otp }) : null
  const run = async (f: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await f()
    } catch (err) {
      push('error', plainError(err, t))
    } finally {
      setBusy(false)
      await queryClient.invalidateQueries({ queryKey: ['gatewayReturn', form, period] }) // i18n-technical
    }
  }
  const state: GatewayReturnRecord['state'] | null = rec?.state ?? null
  const ready = form === 'gstr1' ? state === 'processed' : state === 'offset'
  if (state === 'filed' && rec) {
    return (
      <p className="text-detail" data-testid={`${tid}-filed`} data-test={rec.test}>
        {rec.test ? t('simple.taxes.portal.filedTest', { form: name, arn: rec.arn ?? '' }) : stateText('filed', name, t) /* i18n-technical */}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1" data-testid={tid}>
      {state && <p className="text-small text-muted" data-testid={`${tid}-state`} data-state={state}>{stateText(state, name, t)}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" data-testid={`${tid}-send`} disabled={busy} onClick={() => void run(() => api.gateway.returnSave(form, period))}>
          {state ? t('simple.taxes.portal.sendAgain', { form: name }) : t('simple.taxes.portal.send', { form: name })}
        </Button>
        {(state === 'saved' || state === 'processing') && (
          <Button size="sm" data-testid={`${tid}-check`} disabled={busy} onClick={() => void run(() => api.gateway.returnStatus(form, period))}>
            {t('simple.taxes.portal.check')}
          </Button>
        )}
        {form === 'gstr3b' && state === 'processed' && (
          <Button size="sm" data-testid={`${tid}-offset`} disabled={busy} onClick={() => void run(() => api.gateway.returnOffset(period))}>
            {t('simple.taxes.portal.offset')}
          </Button>
        )}
        {ready && !codeOpen && (
          <Button size="sm" variant="primary" data-testid={`${tid}-code`} disabled={busy} onClick={() => void run(async () => { await api.gateway.requestOtp('evc', form, period); setCodeOpen(true) })}> // i18n-technical
            {t('simple.taxes.portal.fileCode', { form: name })}
          </Button>
        )}
      </div>
      {ready && codeOpen && (
        <CodeEntry testId={`${tid}-file`} button={t('simple.taxes.portal.file', { form: name })} hint={hint} busy={busy}
          onSubmit={(otp) => void run(async () => { await api.gateway.returnFile(form, period, otp); setCodeOpen(false); onFiled() })} />
      )}
    </div>
  )
}

/**
 * Phase 4 — step 3's second way: send GSTR-1 / GSTR-3B through the GST gateway. In 1.0 the
 * built-in Test GSP answers (test mode, nothing reaches the portal). Monthly filers only for now.
 */
export function PortalSend({ x }: { x: Regular }): React.JSX.Element | null {
  const t = useT()
  const push = useToasts((s) => s.push)
  const queryClient = useQueryClient()
  const { data: status } = useQuery({ queryKey: ['gatewayStatus'], queryFn: api.gateway.status }) // i18n-technical
  const [busy, setBusy] = useState(false)
  const [codeOpen, setCodeOpen] = useState(false)
  if (x.period.soFar) return null
  const period = gstPeriodOf(`${x.period.period}-01`)
  const signIn = async (f: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await f()
    } catch (err) {
      push('error', plainError(err, t))
    } finally {
      setBusy(false)
      await queryClient.invalidateQueries({ queryKey: ['gatewayStatus'] }) // i18n-technical
    }
  }
  return (
    <div className="mt-3 rounded-md border border-line px-3 py-2" data-testid="taxes-portal">
      <p className="font-medium">{t('simple.taxes.portal.title')}</p>
      {status?.testMode && <p className="text-small text-muted" data-testid="taxes-portal-test-note">{t('simple.taxes.portal.testNote')}</p>}
      {x.period.quarterly ? (
        <p className="mt-1 text-small text-muted" data-testid="taxes-portal-quarterly">{t('simple.taxes.portal.quarterly')}</p>
      ) : !status?.signedIn ? (
        <div className="mt-2">
          {codeOpen ? (
            <CodeEntry testId="taxes-portal-signin" button={t('simple.taxes.portal.useCode')} hint={status?.testHints ? t('simple.taxes.portal.codeHint', { otp: status.testHints.otp }) : null} busy={busy}
              onSubmit={(otp) => void signIn(async () => { await api.gateway.signIn(otp); setCodeOpen(false) })} />
          ) : (
            <Button size="sm" data-testid="taxes-portal-signin" disabled={busy} onClick={() => void signIn(async () => { await api.gateway.requestOtp('signin'); setCodeOpen(true) })}> // i18n-technical
              {t('simple.taxes.portal.signIn')}
            </Button>
          )}
        </div>
      ) : (
        <div className="mt-2 flex flex-col gap-3">
          {FORMS.map((form) => (
            <PortalReturn key={form} form={form} period={period} onFiled={() => void queryClient.invalidateQueries({ queryKey: ['simpleTaxes'] })} /> // i18n-technical
          ))}
        </div>
      )}
    </div>
  )
}
