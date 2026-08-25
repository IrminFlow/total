import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import { Button, Field, Modal, Panel, SectionTitle, Select, SkeletonRows, Spinner, TextInput, inputCls } from '../../components/ui'
import { useFeatures } from '../../lib/useFeatures'
import { EGRESS_MODES, KEY_MASK, endpointHost, isLocalEndpoint, type AiSettings } from '@shared/ai/config'
import { ENDPOINT_PRESETS, applyPreset, matchPreset } from '@shared/ai/presets'
import { redactionPreview } from '@shared/ai/preview'
import { formatPaise, parseRupees } from '@shared/money'

/**
 * Settings → AI.
 *
 * Always visible even when the assistant is off, because this is where it gets turned on. The
 * panel leads with what leaves the machine rather than burying it, since Total's entire pitch is
 * that nothing does — the assistant is the single exception, and the user should meet that fact
 * before the API-key box, not after.
 */
export function AiSection(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { user } = useSession()
  const features = useFeatures()
  const canEdit = user?.role === 'owner'
  const { data: existing } = useQuery({ queryKey: ['aiConfig'], queryFn: api.ai.getConfig })
  const { data: spend } = useQuery({ queryKey: ['aiSpend'], queryFn: api.ai.spend })
  const [draft, setDraft] = useState<AiSettings | null>(null)
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [models, setModels] = useState<string[] | null>(null)
  const [consentFor, setConsentFor] = useState<AiSettings | null>(null)

  const value = draft ?? (existing ? { ...existing, apiKey: existing.apiKey } : null)
  const set = (patch: Partial<AiSettings>): void => {
    if (value) setDraft({ ...value, ...patch })
  }

  const persist = async (settings: AiSettings): Promise<void> => {
    setBusy('save')
    try {
      await api.ai.setConfig(settings)
      await queryClient.invalidateQueries({ queryKey: ['aiConfig'] })
      await queryClient.invalidateQueries({ queryKey: ['aiSpend'] })
      setDraft(null)
      toast.push('success', 'AI settings saved')
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const save = async (): Promise<void> => {
    if (!value) return
    // Consent is per endpoint: pointing at a different host is a different disclosure, so the
    // prompt re-arms rather than treating one agreement as permanent.
    const host = endpointHost(value.baseUrl)
    if (value.apiKey && value.consentedHost !== host && !isLocalEndpoint(value.baseUrl)) {
      setConsentFor(value)
      return
    }
    await persist(value)
  }

  const test = async (): Promise<void> => {
    setBusy('test')
    try {
      const r = await api.ai.testConnection()
      setModels(r.models)
      toast.push(
        r.warnings.length ? 'warning' : 'success',
        r.warnings.length ? r.warnings.join(' ') : `Connected in ${r.latencyMs} ms — ${r.models.length} models available`
      )
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (!value) {
    return (
      <div>
        <SectionTitle>AI assistant</SectionTitle>
        <Panel>
          <SkeletonRows rows={6} />
        </Panel>
      </div>
    )
  }

  // Reported by main and never edited here, so it comes from the query rather than the draft.
  const keyStorage = existing?.keyStorage ?? 'keychain'
  const local = isLocalEndpoint(value.baseUrl)
  const host = endpointHost(value.baseUrl)

  return (
    <div>
      <SectionTitle>AI assistant</SectionTitle>

      {!features.ai && (
        <div className="mb-4 rounded-md border border-line bg-panel2 px-3.5 py-2.5 text-body-sm text-muted">
          The assistant is <b className="text-ink">off</b> for this company. Turn it on in Settings → Features. Total
          works entirely offline until you do — nothing here contacts anything.
        </div>
      )}

      {!canEdit && (
        <div className="mb-4 rounded-md border border-blue/40 bg-blue/10 px-3.5 py-2.5 text-body-sm text-blue">
          Read-only — only owners can change AI settings.
        </div>
      )}

      {/* The disclosure comes before the key box on purpose. */}
      <Panel className="mb-4 p-5">
        <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">What leaves this machine</p>
        {local ? (
          <p className="mt-2 text-body-sm">
            <span className="num">{host}</span> runs on this computer. Nothing leaves it.
          </p>
        ) : (
          <>
            <p className="mt-2 text-body-sm">
              Endpoint <span className="num text-ink">{host}</span> · model{' '}
              <span className="num text-ink">{value.model}</span>
            </p>
            <p className="mt-2 text-body-sm text-muted">
              <b className="text-ink">Sent:</b> your question, the screen you are on, this company&rsquo;s name and
              state, and the rows the assistant&rsquo;s tools return — ledger and party names, dates, narrations,
              voucher numbers and amounts.
            </p>
            <p className="mt-1.5 text-body-sm text-muted">
              <b className="text-ink">Never sent:</b> any GSTIN or PAN, bank account numbers, employee or payroll data,
              your NIC filing credentials, or your data files.
            </p>
            <p className="mt-1.5 text-body-sm text-muted">
              Nothing is sent unless you ask a question.
            </p>
          </>
        )}
      </Panel>

      <Panel className="p-5">
        {/* Presets first, and the local ones first among them. A model on this machine is the
            configuration that keeps Total's promise intact, and the only thing standing between a
            user and it is knowing which port Ollama listens on. */}
        <div className="mb-5">
          <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">Start from</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {ENDPOINT_PRESETS.map((preset) => {
              const active = matchPreset(value.baseUrl)?.id === preset.id
              return (
                <button
                  key={preset.id}
                  data-testid={`btn-ai-preset-${preset.id}`}
                  disabled={!canEdit}
                  title={preset.hint}
                  className={`rounded-md border px-3 py-1.5 text-body-sm disabled:opacity-50 ${
                    active ? 'border-blue bg-blue/10 text-blue' : 'border-line hover:bg-panel2'
                  }`}
                  onClick={() => set(applyPreset(preset))}
                >
                  {preset.label}
                </button>
              )
            })}
          </div>
          <p className="mt-2 text-hint text-muted">
            {matchPreset(value.baseUrl)?.hint ??
              'Or type any OpenAI-compatible endpoint below. A local one needs no key and sends nothing anywhere.'}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Endpoint" hint="Any OpenAI-compatible API, including a local one">
            <TextInput
              value={value.baseUrl}
              disabled={!canEdit}
              onChange={(e) => set({ baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
              className="num"
            />
          </Field>
          <Field label="API key" hint={keyStorage === 'session' ? 'Held for this session only' : 'Stored in your OS keychain'}>
            <TextInput
              type="password"
              value={value.apiKey}
              disabled={!canEdit}
              onChange={(e) => set({ apiKey: e.target.value })}
              placeholder={existing?.apiKey === KEY_MASK ? KEY_MASK : 'sk-…'}
              className="num"
            />
          </Field>
          <Field label="Model">
            {models && models.length > 0 ? (
              <Select value={value.model} disabled={!canEdit} onChange={(e) => set({ model: e.target.value })}>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            ) : (
              <TextInput
                value={value.model}
                disabled={!canEdit}
                onChange={(e) => set({ model: e.target.value })}
                className="num"
              />
            )}
          </Field>
          <Field label="Vision model" hint="Optional — needed to read a bill from a photo">
            <TextInput
              value={value.visionModel}
              disabled={!canEdit}
              onChange={(e) => set({ visionModel: e.target.value })}
              className="num"
            />
          </Field>
          <Field label="Names sent" hint="Redacting costs answer quality on name questions">
            <Select
              value={value.egress}
              disabled={!canEdit}
              onChange={(e) => set({ egress: e.target.value as (typeof EGRESS_MODES)[number] })}
            >
              <option value="full">Send ledger and party names</option>
              <option value="names-redacted">Replace names with codes</option>
            </Select>
          </Field>
          <Field label="Spend cap per session" hint="0 turns the assistant off as surely as the flag">
            <input
              className={inputCls}
              data-testid="input-ai-session-cap"
              value={formatPaise(value.sessionCapPaise)}
              disabled={!canEdit}
              onChange={(e) => {
                const paise = parseRupees(e.target.value)
                if (paise != null && paise >= 0) set({ sessionCapPaise: paise })
              }}
            />
          </Field>
          <Field label="Spend cap per day" hint="Enforced in the app, not by your provider">
            <input
              className={inputCls}
              data-testid="input-ai-daily-cap"
              value={formatPaise(value.dailyCapPaise)}
              disabled={!canEdit}
              onChange={(e) => {
                const paise = parseRupees(e.target.value)
                if (paise != null && paise >= 0) set({ dailyCapPaise: paise })
              }}
            />
          </Field>
        </div>

        {/* Spend is an estimate from published list prices at a fixed exchange rate, and says so.
            Its job is to stop a runaway loop, not to reconcile to an invoice. */}
        {spend && !local && (
          <p className="mt-4 text-body-sm text-muted" data-testid="ai-spend-summary">
            Estimated spend: <span className="num text-ink">{formatPaise(spend.sessionPaise)}</span> this session,{' '}
            <span className="num text-ink">{formatPaise(spend.todayPaise)}</span> today against a cap of{' '}
            <span className="num">{formatPaise(spend.dailyCapPaise)}</span>.
            {spend.unpricedRuns > 0 && ' Some runs used a model with no published price, so this is a floor.'}
          </p>
        )}

        {keyStorage === 'session' && (
          <div className="mt-4 rounded-md border border-amber/50 bg-amber/10 px-3.5 py-2.5 text-body-sm text-amber">
            Your OS keychain isn&rsquo;t available on this machine, so the key is held for this session only and will be
            gone when you quit. Total will not write it to disk in plain text.
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button disabled={!canEdit || busy !== null} onClick={() => void test()}>
            {busy === 'test' ? <Spinner /> : 'Test connection'}
          </Button>
          <Button variant="primary" disabled={!canEdit || busy !== null || !draft} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </Panel>

      {/* The redaction preview (roadmap #222). Pure shared code, so it renders with no key, no
          endpoint and no network — the state someone is in when deciding whether to turn this on. */}
      <Panel className="mt-4 p-5">
        <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">
          What is stripped from every row
        </p>
        <p className="mt-2 text-body-sm text-muted">
          A worked example, produced by running a sample party row through the same function every
          tool result passes through. There is no toggle for this.
        </p>
        <table className="mt-3 w-full text-body-sm" data-testid="ai-redaction-preview">
          <thead>
            <tr className="text-caption text-muted">
              <th className="py-1 text-left font-medium">Field</th>
              <th className="py-1 text-left font-medium">In your books</th>
              <th className="py-1 text-left font-medium">What leaves</th>
              <th className="py-1 text-left font-medium">Why</th>
            </tr>
          </thead>
          <tbody>
            {redactionPreview().withheld.map((field) => (
              <tr key={field.field} className="border-t border-line align-top">
                <td className="num py-1.5">{field.field}</td>
                <td className="num py-1.5 text-muted line-through">{field.before}</td>
                <td className="num py-1.5">{field.after}</td>
                <td className="py-1.5 text-muted">{field.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-hint text-muted">
          Sent: {redactionPreview().sent.join(', ')} — the parts a question about the books is
          actually computed from.
        </p>
      </Panel>

      {consentFor && (
        <Modal title={`Sending your books to ${endpointHost(consentFor.baseUrl)}`} onClose={() => setConsentFor(null)}>
          <p className="text-detail">
            The assistant will send ledger names, party names, dates, amounts and narrations from this company&rsquo;s
            books to <b className="num">{endpointHost(consentFor.baseUrl)}</b> — a service run by someone other than
            Total.
          </p>
          <p className="mt-3 text-detail text-muted">
            GSTINs, PAN, bank account numbers and payroll data are never sent. Total itself stays fully offline; only
            the assistant talks to the internet, and only when you ask it something.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={() => setConsentFor(null)}>Cancel</Button>
            <Button
              variant="primary"
              data-testid="btn-ai-consent"
              onClick={() => {
                const agreed = { ...consentFor, consentedHost: endpointHost(consentFor.baseUrl) }
                setConsentFor(null)
                void persist(agreed)
              }}
            >
              I understand — turn on AI
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}
