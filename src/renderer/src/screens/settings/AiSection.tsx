import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AiProviderInput } from '@shared/ai'
import type { AiOperatorConfig } from '@shared/aiOperator'
import { api } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import { Button, Field, Panel, SectionTitle, SkeletonRows, TextInput } from '../../components/ui'

export function AiSection(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { user } = useSession()
  const canEdit = user == null || user.role === 'owner'
  const { data: config } = useQuery({ queryKey: ['aiConfig'], queryFn: api.ai.getConfig })
  const { data: operator } = useQuery({ queryKey: ['aiOperatorConfig'], queryFn: api.ai.operatorConfig })
  const codex = useQuery({ queryKey: ['codexStatus'], queryFn: api.ai.codexStatus })
  const [codexSessionId, setCodexSessionId] = useState<string | null>(null)
  const [codexLoginOutput, setCodexLoginOutput] = useState('')
  const [draft, setDraft] = useState<AiProviderInput | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  useEffect(() => {
    if (!codexSessionId) return
    const timer = window.setInterval(() => {
      void api.ai.codexLoginSession(codexSessionId).then(async (session) => {
        setCodexLoginOutput(session.output)
        if (session.status !== 'running') {
          window.clearInterval(timer)
          setCodexSessionId(null)
          await queryClient.invalidateQueries({ queryKey: ['codexStatus'] })
        }
      }).catch(() => window.clearInterval(timer))
    }, 750)
    return () => window.clearInterval(timer)
  }, [codexSessionId, queryClient])
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

  const saveOperator = async (next: AiOperatorConfig): Promise<void> => {
    try {
      await api.ai.operatorSetConfig(next)
      await queryClient.invalidateQueries({ queryKey: ['aiOperatorConfig'] })
      toast.push('success', 'AI Operator permissions saved')
    } catch (err) {
      toast.push('error', (err as Error).message)
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
      {operator && (
        <Panel className="mt-5 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[13px] font-semibold">AI Operator</p>
              <p className="mt-1 max-w-2xl text-[11.5px] leading-5 text-muted">
                Let Assist navigate Total, search books, prepare voucher proposals and work with files in folders you explicitly grant. It has no shell, credential or unrestricted filesystem access.
              </p>
            </div>
            <label className="flex shrink-0 items-center gap-2 text-[12px] font-medium">
              <input type="checkbox" checked={operator.enabled} disabled={!canEdit}
                onChange={(event) => void saveOperator({ ...operator, enabled: event.target.checked })} />
              Enabled
            </label>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <Field label="File-change approval" hint="Accounting always remains draft-then-approve.">
              <select className="w-full rounded-md border border-line bg-panel2 px-2.5 py-1.5" value={operator.approvalMode} disabled={!canEdit}
                onChange={(event) => void saveOperator({ ...operator, approvalMode: event.target.value as AiOperatorConfig['approvalMode'] })}>
                <option value="every_change">Approve every file change</option>
                <option value="accounting_only">Allow files; approve accounting</option>
              </select>
            </Field>
            <div className="flex items-end">
              <Button disabled={!canEdit} onClick={async () => {
                try {
                  await api.ai.operatorAddWorkspace()
                  await queryClient.invalidateQueries({ queryKey: ['aiOperatorConfig'] })
                } catch (err) { toast.push('error', (err as Error).message) }
              }}>Add workspace folder…</Button>
            </div>
          </div>
          <div className="mt-3 rounded-md border border-line bg-panel2 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Approved folders</p>
            {operator.workspaceRoots.length ? operator.workspaceRoots.map((root) => (
              <div key={root} className="mt-2 flex items-center justify-between gap-3 text-[11px]">
                <code className="min-w-0 truncate">{root}</code>
                <button className="text-cr hover:underline" disabled={!canEdit}
                  onClick={() => void saveOperator({ ...operator, workspaceRoots: operator.workspaceRoots.filter((item) => item !== root) })}>Remove</button>
              </div>
            )) : <p className="mt-2 text-[11px] text-muted">No file access. Total accounting tools still work through controlled proposals.</p>}
          </div>
        </Panel>
      )}
      <Panel className="mt-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[13px] font-semibold">ChatGPT account through Codex</p>
            <p className="mt-1 max-w-2xl text-[11.5px] leading-5 text-muted">
              Optional bridge for people who have the official Codex CLI installed. Sign-in is handled by Codex; Total never reads or stores ChatGPT tokens. Once signed in, connect Codex to Total through the bundled local MCP server.
            </p>
            <p className={`mt-2 text-[10.5px] ${codex.data?.authenticated ? 'text-dr' : 'text-muted'}`}>{codex.data?.detail ?? 'Checking Codex…'}</p>
          </div>
          <Button disabled={!canEdit || !codex.data?.available || codexSessionId !== null} onClick={async () => {
            try {
              const session = await api.ai.codexStartLogin()
              setCodexLoginOutput('Starting secure device sign-in…')
              setCodexSessionId(session.sessionId)
            } catch (err) { toast.push('error', (err as Error).message) }
          }}>{codex.data?.authenticated ? 'Sign in again' : 'Sign in with ChatGPT'}</Button>
        </div>
        {codexLoginOutput && <pre className="mt-3 max-h-44 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-panel2 p-3 text-[10px] leading-4">{codexLoginOutput}</pre>}
      </Panel>
    </div>
  )
}
