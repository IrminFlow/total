import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import { Button, Field, Panel, SectionTitle, SkeletonRows, TextInput } from '../../components/ui'
import type { NicCredentials } from '@shared/schemas'

export function NicSection(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { user } = useSession()
  const { data: existing } = useQuery({ queryKey: ['nicCreds'], queryFn: api.nic.get })
  const [creds, setCreds] = useState<NicCredentials | null>(null)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const value = creds ?? existing ?? null
  // No users set up (single-user books) = the owner, as the IPC role gate treats it (cf. Users / Bin).
  const canEdit = user == null || user.role === 'owner'

  const set = (patch: Partial<NicCredentials>): void => {
    if (value) setCreds({ ...value, ...patch })
  }

  const save = async (): Promise<void> => {
    if (!value) return
    setBusy(true)
    try {
      const r = await api.nic.save(value)
      await queryClient.invalidateQueries({ queryKey: ['nicStatus'] })
      await queryClient.invalidateQueries({ queryKey: ['nicCreds'] })
      setCreds(null)
      setTestResult(null)
      toast.push(r.configured ? 'success' : 'warning', r.configured ? 'Live filing is ready' : 'Saved — some fields are still missing')
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Connection test (WP 3.5): the NIC auth handshake only, with the SAVED credentials — files
  // nothing. Unsaved edits must be saved first so the test checks what filing will use.
  const testConnection = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await api.nic.testConnection()
      setTestResult({
        ok: true,
        text: `Connected to ${r.endpoint}${r.sandbox ? ' (sandbox)' : ''} — login accepted${r.tokenExpiry ? `, session valid until ${r.tokenExpiry} IST` : ''}. Nothing was filed.`
      })
    } catch (err) {
      setTestResult({ ok: false, text: (err as Error).message })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div>
      <SectionTitle>NIC live filing</SectionTitle>
      <div className="mb-4 rounded-md border border-amber/50 bg-amberbar/10 px-3.5 py-2.5 text-body-sm text-amber">
        Experimental — never tested against the live NIC portal. Verify every document on the portal.
        <div className="mt-1 text-hint" data-testid="nic-spec-note">
          Tested against the published API spec only (7 Oct 2026) — not yet verified on the NIC sandbox.
        </div>
      </div>

      {!canEdit && (
        <div className="mb-4 rounded-md border border-blue/40 bg-blue/10 px-3.5 py-2.5 text-body-sm text-blue">
          Read-only — only owners can edit NIC credentials. Ask an owner to sign in to change them.
        </div>
      )}

      {!value ? (
        <Panel>
          <SkeletonRows rows={6} />
        </Panel>
      ) : (
        <Panel className="p-5">
          <p className="mb-4 text-body-sm text-muted">
            Credentials from your e-invoice API registration (direct access) or your GSP. Sandbox first is a good idea:
            base URL <span className="num">https://einv-apisandbox.nic.in</span>. URLs, username, client ID and key stay in this company's local
            database; the password and client secret are kept encrypted in this computer's secure storage.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="e-Invoice base URL">
              <TextInput
                value={value.baseUrlEinvoice}
                onChange={(e) => set({ baseUrlEinvoice: e.target.value.trim() })}
                placeholder="https://einv-apisandbox.nic.in"
                className="num"
                disabled={!canEdit}
              />
            </Field>
            <Field label="e-Way bill base URL" hint="Optional — EWBs are generated via the e-invoice suite">
              <TextInput
                value={value.baseUrlEwb}
                onChange={(e) => set({ baseUrlEwb: e.target.value.trim() })}
                className="num"
                disabled={!canEdit}
              />
            </Field>
            <Field label="API username">
              <TextInput value={value.username} onChange={(e) => set({ username: e.target.value })} className="num" disabled={!canEdit} />
            </Field>
            <Field label="API password">
              <TextInput
                type="password"
                value={value.password}
                onChange={(e) => set({ password: e.target.value })}
                className="num"
                disabled={!canEdit}
              />
            </Field>
            <Field label="Client ID">
              <TextInput value={value.clientId} onChange={(e) => set({ clientId: e.target.value })} className="num" disabled={!canEdit} />
            </Field>
            <Field label="Client secret">
              <TextInput
                type="password"
                value={value.clientSecret}
                onChange={(e) => set({ clientSecret: e.target.value })}
                className="num"
                disabled={!canEdit}
              />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="NIC public key (PEM)" hint="From the portal's API documentation — used to encrypt your password during login">
              <textarea
                value={value.publicKeyPem}
                onChange={(e) => set({ publicKeyPem: e.target.value })}
                rows={5}
                disabled={!canEdit}
                className="num w-full rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-caption disabled:opacity-60"
                placeholder="-----BEGIN PUBLIC KEY-----"
              />
            </Field>
          </div>
          {testResult && (
            <div
              role="status"
              data-testid="nic-connection-result"
              data-ok={testResult.ok ? 'true' : 'false'}
              className={`mt-4 rounded-md border px-3.5 py-2.5 text-body-sm ${
                testResult.ok ? 'border-success/50 bg-success-soft text-success' : 'border-danger/50 bg-danger/10 text-danger'
              }`}
            >
              {testResult.text}
            </div>
          )}
          <div className="mt-4 flex items-center justify-end gap-3">
            {!canEdit && <span className="text-hint text-muted">Only owners can edit NIC credentials</span>}
            {canEdit && creds && <span className="text-hint text-muted">Save to test the new credentials</span>}
            {canEdit && (
              <Button
                variant="secondary"
                data-testid="nic-test-connection"
                disabled={testing || busy || !!creds}
                onClick={() => void testConnection()}
                title="Logs in to NIC with the saved credentials (no filing)"
              >
                {testing ? 'Testing…' : 'Connection test'}
              </Button>
            )}
            {canEdit && (
              <Button variant="primary" disabled={busy} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save credentials'}
              </Button>
            )}
          </div>
        </Panel>
      )}
    </div>
  )
}
