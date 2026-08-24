import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AiProviderInput } from '@shared/ai'
import { api } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import { Button, Field, Panel, SectionTitle, SkeletonRows, TextInput } from '../../components/ui'

export function AiSection(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { user } = useSession()
  const canEdit = user == null || user.role === 'owner'
  const { data: config } = useQuery({ queryKey: ['aiConfig'], queryFn: api.ai.getConfig })
  const [draft, setDraft] = useState<AiProviderInput | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const value = draft ?? (config ? {
    enabled: config.enabled,
    provider: config.provider,
    apiMode: config.apiMode,
    model: config.model,
    baseUrl: config.baseUrl
  } : null)

  const patch = (next: Partial<AiProviderInput>): void => {
    if (value) setDraft({ ...value, ...next })
  }

  const save = async (): Promise<void> => {
    if (!value) return
    setBusy('save')
    try {
      await api.ai.setConfig({ ...value, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) })
      setApiKey('')
      setDraft(null)
      await queryClient.invalidateQueries({ queryKey: ['aiConfig'] })
      toast.push('success', 'AI provider saved securely')
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const test = async (): Promise<void> => {
    setBusy('test')
    try {
      const result = await api.ai.testConnection()
      toast.push('success', `Connected to ${result.model}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <SectionTitle>AI copilot</SectionTitle>
      <div className="mb-4 rounded-md border border-blue/35 bg-blue/10 px-3.5 py-2.5 text-[12.5px] text-blue">
        AI is optional. You choose when book context is shared, and it can only propose changes for your review.
      </div>
      {!value ? <Panel><SkeletonRows rows={6} /></Panel> : (
        <Panel className="p-5">
          <label className="mb-4 flex items-center gap-2 text-[13px] font-medium">
            <input type="checkbox" checked={value.enabled} disabled={!canEdit} onChange={(e) => patch({ enabled: e.target.checked })} />
            Enable AI copilot on this device
          </label>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Provider">
              <select className="w-full rounded-md border border-line bg-panel2 px-2.5 py-1.5" value={value.provider} disabled={!canEdit}
                onChange={(e) => patch({ provider: e.target.value as AiProviderInput['provider'], baseUrl: null })}>
                <option value="openai">OpenAI</option>
                <option value="compatible">OpenAI-compatible</option>
              </select>
            </Field>
            <Field label="Model">
              <TextInput className="num" value={value.model} disabled={!canEdit} onChange={(e) => patch({ model: e.target.value })} />
            </Field>
            <Field label="API mode">
              <select className="w-full rounded-md border border-line bg-panel2 px-2.5 py-1.5" value={value.apiMode} disabled={!canEdit}
                onChange={(e) => patch({ apiMode: e.target.value as AiProviderInput['apiMode'] })}>
                <option value="responses">Responses API</option>
                <option value="chat_completions">Chat Completions compatibility</option>
              </select>
            </Field>
            <Field label="API key" hint={config?.hasApiKey ? 'A key is stored securely. Leave blank to keep it.' : 'Stored with the operating system credential store.'}>
              <TextInput type="password" className="num" value={apiKey} disabled={!canEdit} placeholder={config?.hasApiKey ? '••••••••••••' : 'sk-…'} onChange={(e) => setApiKey(e.target.value)} />
            </Field>
            {value.provider === 'compatible' && (
              <div className="col-span-2">
                <Field label="Compatible base URL" hint="HTTPS is required except for localhost providers.">
                  <TextInput className="num" value={value.baseUrl ?? ''} disabled={!canEdit} placeholder="https://provider.example/v1"
                    onChange={(e) => patch({ baseUrl: e.target.value })} />
                </Field>
              </div>
            )}
          </div>
          <div className="mt-5 flex justify-between gap-2">
            <button className="text-[12px] text-blue hover:underline" onClick={() => window.open('https://platform.openai.com/api-keys')}>
              Get an OpenAI API key
            </button>
            <div className="flex gap-2">
              <Button disabled={busy !== null || !config?.hasApiKey} onClick={() => void test()}>{busy === 'test' ? 'Testing…' : 'Test connection'}</Button>
              <Button variant="primary" disabled={busy !== null || !canEdit} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save provider'}</Button>
            </div>
          </div>
        </Panel>
      )}
      <p className="mt-2 text-[11.5px] text-muted">API keys are device-only and are excluded from company databases, mirrors, backups, logs, and support diagnostics.</p>
    </div>
  )
}
