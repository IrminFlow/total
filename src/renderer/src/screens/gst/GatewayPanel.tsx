// Phase 4: "Send to the portal (test mode)" on the GSTR-1 / GSTR-3B screens — the gateway's
// returns flow (src/main/gstGateway/returnsFlow.ts): sign in with the OTP → send the return (the
// export's JSON) → check its status → (3B) set off the liability → filing OTP (EVC) → file → ARN.
// In 1.0 the built-in Test GSP answers: everything here is simulated and nothing reaches the portal.
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useToasts } from '../../state/stores'
import { Badge, Banner, Button, Panel, TextInput } from '../../components/ui'
import { TEST_MODE_NOTE, type GatewayForm, type GatewayReturnRecord } from '@shared/gstGateway'
import { toDisplayDate } from '@shared/dates'

const STATE_LABEL: Record<GatewayReturnRecord['state'], string> = {
  saved: 'Sent — waiting for the portal',
  processing: 'Portal is checking it',
  processed: 'Checked — ready to file',
  error: 'Portal found errors',
  offset: 'Liability set off — ready to file',
  filed: 'Filed'
}

/** A 6-digit OTP box with its button. */
function OtpEntry({ testId, label, hint, onSubmit, onResend, busy }: { testId: string; label: string; hint: string | null; onSubmit: (otp: string) => void; onResend: () => void; busy: boolean }): React.JSX.Element {
  const [otp, setOtp] = useState('')
  return (
    <div className="flex flex-wrap items-center gap-2">
      <TextInput
        className="!w-28"
        inputMode="numeric"
        maxLength={6}
        aria-label={label}
        data-testid={`${testId}-otp`}
        value={otp}
        onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
      />
      <Button size="sm" variant="primary" data-testid={`${testId}-submit`} disabled={busy || otp.length !== 6} onClick={() => onSubmit(otp)}>
        {label}
      </Button>
      <Button size="sm" variant="ghost" data-testid={`${testId}-resend`} disabled={busy} onClick={() => { setOtp(''); onResend() }}>
        New OTP
      </Button>
      {hint && <span className="text-hint text-muted">{hint}</span>}
    </div>
  )
}

export function GatewayReturnPanel({ form, period, blocked }: { form: GatewayForm; period: string; blocked: string | null }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: status } = useQuery({ queryKey: ['gatewayStatus'], queryFn: api.gateway.status })
  const { data: rec } = useQuery({ queryKey: ['gatewayReturn', form, period], queryFn: () => api.gateway.returnGet(form, period) })
  const [busy, setBusy] = useState(false)
  const [otpFor, setOtpFor] = useState<'signin' | 'evc' | null>(null)
  const name = form === 'gstr1' ? 'GSTR-1' : 'GSTR-3B'
  const tid = `gw-${form}`
  const otpHint = status?.testHints ? `Test OTP: ${status.testHints.otp}` : null

  const run = async (f: () => Promise<unknown>, done?: string): Promise<void> => {
    setBusy(true)
    try {
      await f()
      if (done) toast.push('success', done)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
      await queryClient.invalidateQueries({ queryKey: ['gatewayReturn', form, period] })
      await queryClient.invalidateQueries({ queryKey: ['gatewayStatus'] })
    }
  }
  const signedIn = status?.signedIn ?? false
  const state = rec?.state ?? null
  const readyToFile = form === 'gstr1' ? state === 'processed' : state === 'offset'

  return (
    <Panel className="mb-section" testId={`${tid}-panel`}>
      <div className="flex flex-col gap-2 px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body-sm font-semibold">Send to the portal{status?.testMode ? ' (test mode)' : ''}</span>
          {status?.testMode && <Badge tone="warning" testId={`${tid}-test-badge`}>Test GSP</Badge>}
          {rec && <Badge tone={state === 'filed' ? 'success' : state === 'error' ? 'danger' : 'neutral'} testId={`${tid}-state`}>{STATE_LABEL[rec.state]}</Badge>}
        </div>
        {status?.testMode && <p className="text-hint text-muted" data-testid={`${tid}-test-note`}>{TEST_MODE_NOTE} The answers are simulated by the built-in Test GSP.</p>}
        {rec?.state === 'filed' && (
          <Banner tone={rec.test ? 'warning' : 'success'} testId={`${tid}-filed`}>
            {name} filed{rec.test ? ' in test mode' : ''} — ARN <span className="num" data-testid={`${tid}-arn`}>{rec.arn}</span>
            {rec.filedOn ? ` on ${toDisplayDate(rec.filedOn)}` : ''}.{rec.test ? ' Nothing reached the GST portal; this does not count as filed.' : ''}
          </Banner>
        )}
        {rec?.errors.length ? (
          <ul className="text-hint text-danger" data-testid={`${tid}-errors`}>
            {rec.errors.map((e, i) => <li key={i}>{e.code}: {e.message}</li>)}
          </ul>
        ) : null}

        {!signedIn && state !== 'filed' && (
          otpFor === 'signin' ? (
            <OtpEntry testId={`${tid}-signin`} label="Sign in" hint={otpHint} busy={busy} onResend={() => void run(() => api.gateway.requestOtp('signin'))} onSubmit={(otp) => void run(async () => { await api.gateway.signIn(otp); setOtpFor(null) }, 'Signed in to the portal')} />
          ) : (
            <div>
              <Button size="sm" data-testid={`${tid}-signin`} disabled={busy} onClick={() => void run(async () => { await api.gateway.requestOtp('signin'); setOtpFor('signin') })}>
                Sign in to the portal (OTP)
              </Button>
            </div>
          )
        )}

        {signedIn && state !== 'filed' && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant={state ? 'secondary' : 'primary'} data-testid={`${tid}-send`} disabled={busy || !!blocked} title={blocked ?? undefined}
              onClick={() => void run(() => api.gateway.returnSave(form, period), `${name} sent${status?.testMode ? ' (test mode)' : ''}`)}>
              {state ? `Send ${name} again` : `Send ${name}`}
            </Button>
            {(state === 'saved' || state === 'processing') && (
              <Button size="sm" data-testid={`${tid}-check`} disabled={busy} onClick={() => void run(() => api.gateway.returnStatus(form, period))}>
                Check status
              </Button>
            )}
            {form === 'gstr3b' && state === 'processed' && (
              <Button size="sm" data-testid={`${tid}-offset`} disabled={busy} onClick={() => void run(() => api.gateway.returnOffset(period), 'Liability set off')}>
                Set off the liability
              </Button>
            )}
            {readyToFile && otpFor !== 'evc' && (
              <Button size="sm" variant="primary" data-testid={`${tid}-evc`} disabled={busy} onClick={() => void run(async () => { await api.gateway.requestOtp('evc', form, period); setOtpFor('evc') })}>
                File with EVC (OTP)
              </Button>
            )}
          </div>
        )}
        {signedIn && readyToFile && otpFor === 'evc' && (
          <OtpEntry testId={`${tid}-file`} label={`File ${name}`} hint={otpHint} busy={busy} onResend={() => void run(() => api.gateway.requestOtp('evc', form, period))}
            onSubmit={(otp) => void run(async () => { await api.gateway.returnFile(form, period, otp); setOtpFor(null) }, `${name} filed${status?.testMode ? ' (test mode)' : ''}`)} />
        )}
      </div>
    </Panel>
  )
}

/** GSTR-2B: fetch the month's statement through the gateway (sign in first). The statement is
 *  stored where the matcher reads it; `onFetched` shows it on the screen. A test fetch never
 *  replaces a statement imported from a file (the kept one is shown instead). */
export function Gateway2bFetch({ period, onFetched }: { period: string; onFetched: (jsonText: string, fileName: string | null, simulated: boolean) => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: status } = useQuery({ queryKey: ['gatewayStatus'], queryFn: api.gateway.status })
  const [busy, setBusy] = useState(false)
  const [otpOpen, setOtpOpen] = useState(false)
  const run = async (f: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await f()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
      await queryClient.invalidateQueries({ queryKey: ['gatewayStatus'] })
    }
  }
  const label = `Fetch from the portal${status?.testMode ? ' (test mode)' : ''}`
  if (!status?.signedIn) {
    return otpOpen ? (
      <OtpEntry testId="gw-2b-signin" label="Sign in" hint={status?.testHints ? `Test OTP: ${status.testHints.otp}` : null} busy={busy} onResend={() => void run(async () => { await api.gateway.requestOtp('signin') })}
        onSubmit={(otp) => void run(async () => { await api.gateway.signIn(otp); setOtpOpen(false) })} />
    ) : (
      <Button data-testid="gw-2b-signin" disabled={busy} title={status?.testMode ? TEST_MODE_NOTE : undefined}
        onClick={() => void run(async () => { await api.gateway.requestOtp('signin'); setOtpOpen(true) })}>
        {label}…
      </Button>
    )
  }
  return (
    <Button data-testid="gw-2b-fetch" disabled={busy} title={status.testMode ? TEST_MODE_NOTE : undefined}
      onClick={() => void run(async () => {
        const r = await api.gateway.fetch2b(period)
        onFetched(r.jsonText, r.fileName, r.test && !r.keptImported)
        toast.push(r.keptImported ? 'warning' : 'success', r.keptImported
          ? 'You already imported this month’s GSTR-2B from a file — kept it; a test fetch never replaces it'
          : `GSTR-2B fetched${r.test ? ' (test mode — simulated from your own purchase bills)' : ''}: ${r.documents} document${r.documents === 1 ? '' : 's'}`)
      })}>
      {label}
    </Button>
  )
}
