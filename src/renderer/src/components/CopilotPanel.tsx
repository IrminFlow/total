import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, Modal, Skeleton } from './ui'
import type { AiCitation, AiContextFieldId } from '@shared/ai'
import { CaretDown, CaretRight, LinkSimple, ShieldCheck } from '@phosphor-icons/react'

interface Message { role: 'user' | 'assistant'; text: string; citations?: AiCitation[] }

const DEFAULT_CONTEXT_FIELDS: AiContextFieldId[] = ['company', 'period', 'dashboard', 'trial_balance', 'receivables', 'payables', 'units']

export function CopilotPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const { data: config } = useQuery({ queryKey: ['aiConfig'], queryFn: api.ai.getConfig })
  const [contextFields, setContextFields] = useState<AiContextFieldId[]>(DEFAULT_CONTEXT_FIELDS)
  const [showInspector, setShowInspector] = useState(false)
  const { data: preview } = useQuery({
    queryKey: ['aiContextPreview', from, to, contextFields],
    queryFn: () => api.ai.contextPreview(from, to, contextFields),
    enabled: config?.enabled === true
  })
  const [prompt, setPrompt] = useState('')
  const [includeContext, setIncludeContext] = useState(true)
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async (): Promise<void> => {
    const text = prompt.trim()
    if (!text || busy) return
    setPrompt('')
    setError(null)
    setMessages((rows) => [...rows, { role: 'user', text }])
    setBusy(true)
    try {
      const answer = await api.ai.ask(text, from, to, includeContext, contextFields)
      setMessages((rows) => [...rows, { role: 'assistant', text: answer.text, citations: answer.citations }])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const openCitation = (citation: AiCitation): void => {
    const ledger = citation.uri.match(/\/ledger\/(\d+)/)
    onClose()
    if (ledger) nav.go({ name: 'ledger-statement', ledgerId: Number(ledger[1]) })
    else if (citation.uri.startsWith('total://gateway')) nav.go({ name: 'gateway' })
    else if (citation.uri.startsWith('total://outstandings')) nav.go({ name: 'outstandings' })
    else nav.go({ name: 'trial-balance' })
  }

  const draft = async (): Promise<void> => {
    const text = prompt.trim()
    if (!text || busy) return
    setError(null)
    setBusy(true)
    try {
      await api.ai.draftVoucher(text)
      setPrompt('')
      toast.push('success', 'Voucher draft saved — review it in Settings > Agent access')
      setMessages((rows) => [...rows, { role: 'user', text }, { role: 'assistant', text: 'Draft created. Nothing has been posted; review the exact entry in the Agent access queue.' }])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Total copilot" onClose={onClose} wide>
      {!config ? <Skeleton className="h-32 w-full" /> : !config.enabled ? (
        <div className="py-8 text-center">
          <p className="text-[14px] font-medium">AI copilot is off</p>
          <p className="mt-1 text-[12.5px] text-muted">An owner can configure it in Settings &gt; AI copilot.</p>
        </div>
      ) : (
        <div className="flex h-[34rem] flex-col">
          <div className="mb-3 rounded-md border border-line bg-panel2">
            <div className="flex items-center justify-between px-3 py-2">
            <label className="flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={includeContext} onChange={(e) => setIncludeContext(e.target.checked)} />
              Share selected company context for this request
            </label>
            <button data-testid="btn-ai-context-inspector" className="flex items-center gap-1.5 text-[11px] text-muted hover:text-ink" disabled={!includeContext} onClick={() => setShowInspector((open) => !open)}>
              {showInspector ? <CaretDown size={13} /> : <CaretRight size={13} />}
              {includeContext ? (preview ? `${contextFields.length} fields · ${(preview.bytes / 1024).toFixed(1)} KB` : 'Preparing…') : 'No book data'}
            </button>
            </div>
            {includeContext && showInspector && preview && (
              <div data-testid="ai-context-inspector" className="max-h-52 overflow-auto border-t border-line bg-panel px-3 py-2">
                <div className="mb-2 flex items-center gap-1.5 text-[10.5px] text-dr"><ShieldCheck size={14} weight="fill" /> Only checked fields are sent. Expand any row to inspect its exact JSON.</div>
                {preview.fields.map((field) => {
                  const checked = contextFields.includes(field.id)
                  return (
                    <details key={field.id} className="border-t border-line first:border-0">
                      <summary className="flex cursor-pointer list-none items-center gap-2 py-2 text-[11.5px]">
                        <input type="checkbox" checked={checked} onClick={(event) => event.stopPropagation()} onChange={() => setContextFields((current) => checked ? current.filter((id) => id !== field.id) : [...current, field.id])} />
                        <span className="min-w-0 flex-1"><b className="font-medium text-ink">{field.label}</b><span className="ml-1.5 text-muted">{field.description}</span></span>
                        <span className="num shrink-0 text-[10px] text-muted">{field.records} records · {(field.bytes / 1024).toFixed(1)} KB</span>
                      </summary>
                      <pre className="num mb-2 max-h-40 overflow-auto rounded border border-line bg-bg p-2 text-[9.5px] leading-4 text-muted">{field.json}</pre>
                    </details>
                  )
                })}
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-line bg-bg p-3">
            {messages.length === 0 && (
              <div className="grid grid-cols-2 gap-2">
                {['Explain my cash position', 'What needs attention before GST filing?', 'Summarize receivables', 'Find unusual balances'].map((suggestion) => (
                  <button key={suggestion} className="rounded-md border border-line bg-panel px-3 py-2 text-left text-[12.5px] hover:border-amber/50"
                    onClick={() => setPrompt(suggestion)}>{suggestion}</button>
                ))}
              </div>
            )}
            {messages.map((message, index) => (
              <div key={index} className={`mb-3 max-w-[85%] rounded-md px-3 py-2 text-[13px] whitespace-pre-wrap ${message.role === 'user' ? 'ml-auto bg-amber/15' : 'bg-panel'}`}>
                {message.text}
                {message.citations && message.citations.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5 border-t border-line pt-2">
                    {message.citations.map((citation) => (
                      <button key={citation.uri} className="flex items-center gap-1 rounded border border-line bg-panel2 px-2 py-1 text-[10.5px] text-blue hover:border-blue/40" onClick={() => openCitation(citation)}>
                        <LinkSimple size={12} /> {citation.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {busy && <p className="text-[12px] text-muted">Thinking…</p>}
          </div>
          {error && <p className="mt-2 text-[12px] text-cr">{error}</p>}
          <div className="mt-3 flex items-end gap-2">
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} disabled={busy}
              placeholder="Ask about your books…" className="min-h-16 flex-1 resize-none rounded-md border border-line bg-panel2 px-3 py-2 text-[13px]"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send() } }} />
            <div className="flex flex-col gap-2">
              <Button variant="primary" disabled={busy || !prompt.trim() || (includeContext && contextFields.length === 0)} onClick={() => void send()}>Ask</Button>
              <Button disabled={busy || prompt.trim().length < 8} onClick={() => void draft()}>Draft voucher</Button>
            </div>
          </div>
          <p className="mt-1.5 text-[11px] text-muted">Copilot can analyze and propose. It cannot post changes without your review.</p>
        </div>
      )}
    </Modal>
  )
}
