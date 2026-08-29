import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import { Button, Field, Panel, SectionTitle, SkeletonRows, TextInput } from '../../components/ui'
import { SITE_URL } from '@shared/product'

/**
 * Settings → Licence.
 *
 * The tone matters more than usual here. A lapsed licence is the one screen where a product can
 * make someone feel locked out of their own work, so it leads with what still works and never
 * scolds. Nothing on this screen can stop a user reading, printing, exporting or backing up.
 */
export function LicenseSection(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { user } = useSession()
  const canEdit = user?.role === 'owner'
  const { data: state } = useQuery({ queryKey: ['license'], queryFn: api.license.get })
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)

  const apply = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await api.license.apply(token)
      await queryClient.invalidateQueries({ queryKey: ['license'] })
      setToken('')
      toast.push(next.kind === 'licensed' ? 'success' : 'warning', next.message)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!state) {
    return (
      <div>
        <SectionTitle>Licence</SectionTitle>
        <Panel>
          <SkeletonRows rows={4} />
        </Panel>
      </div>
    )
  }

  const tone =
    state.kind === 'licensed'
      ? 'border-dr/50 bg-dr/10 text-dr'
      : state.readOnly
        ? 'border-cr/50 bg-cr/10 text-cr'
        : 'border-accent/50 bg-accent/10 text-accent'

  return (
    <div>
      <SectionTitle>Licence</SectionTitle>

      <div className={`mb-4 rounded-md border px-3.5 py-2.5 text-body-sm ${tone}`} data-testid="license-status">
        {state.message}
      </div>

      {state.readOnly && (
        <Panel className="mb-4 p-5">
          <p className="text-detail font-medium">What still works</p>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-body-sm text-muted">
            <li>Opening every company, and reading every report.</li>
            <li>Printing and exporting to PDF, CSV, Tally XML and the CA pack.</li>
            <li>Backups, including the encrypted export.</li>
          </ul>
          <p className="mt-3 text-body-sm text-muted">
            Only posting new entries pauses. Your books are files on your disk and stay yours either way.
          </p>
        </Panel>
      )}

      <Panel className="p-5">
        <Field label="Licence key" hint="Paste the whole key, including the dot in the middle">
          <TextInput
            data-testid="input-license"
            value={token}
            disabled={!canEdit}
            onChange={(e) => setToken(e.target.value)}
            placeholder="eyJ2Ijox….signature"
            className="num"
          />
        </Field>
        <div className="mt-4 flex items-center justify-between">
          <a className="text-body-sm text-blue hover:underline" href={`${SITE_URL}/pricing`} target="_blank" rel="noreferrer">
            Pricing and licences
          </a>
          <Button variant="primary" data-testid="btn-license-apply" disabled={!canEdit || busy || !token.trim()} onClick={() => void apply()}>
            Apply key
          </Button>
        </div>
      </Panel>

      {state.payload && (
        <Panel className="mt-4 p-5">
          <div className="grid grid-cols-2 gap-4 text-body-sm">
            <div>
              <p className="text-caption tracking-[0.08em] text-muted uppercase">Licensed to</p>
              <p className="mt-0.5">{state.payload.name}</p>
            </div>
            <div>
              <p className="text-caption tracking-[0.08em] text-muted uppercase">Plan</p>
              <p className="mt-0.5 capitalize">{state.payload.plan}</p>
            </div>
            <div>
              <p className="text-caption tracking-[0.08em] text-muted uppercase">
                {state.payload.plan === 'perpetual' ? 'Updates until' : 'Valid until'}
              </p>
              <p className="num mt-0.5">{state.payload.expires}</p>
            </div>
            <div>
              <p className="text-caption tracking-[0.08em] text-muted uppercase">Companies</p>
              <p className="num mt-0.5">{state.payload.companies === 0 ? 'Unlimited' : state.payload.companies}</p>
            </div>
          </div>
        </Panel>
      )}
    </div>
  )
}
