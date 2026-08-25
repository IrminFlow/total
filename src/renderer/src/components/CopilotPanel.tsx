import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, Modal, Skeleton } from './ui'
import type { AiCitation, AiContextFieldId, AiUsage } from '@shared/ai'
import { CaretDown, CaretRight, LinkSimple, ShieldCheck, Trash } from '@phosphor-icons/react'
import { useDeviceSafetyControls } from '../lib/useDeviceSafety'

interface Message { role: 'user' | 'assistant'; text: string; citations?: AiCitation[]; usage?: AiUsage | null; status?: 'completed' | 'cancelled' | 'failed' }

const DEFAULT_CONTEXT_FIELDS: AiContextFieldId[] = ['company', 'period']

export function CopilotPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { from, to, user } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const deviceSafety = useDeviceSafetyControls()
  const { data: config } = useQuery({ queryKey: ['aiConfig'], queryFn: api.ai.getConfig })
  const [contextFields, setContextFields] = useState<AiContextFieldId[]>(DEFAULT_CONTEXT_FIELDS)
  const [showInspector, setShowInspector] = useState(true)
  const { data: preview } = useQuery({
    queryKey: ['aiContextPreview', from, to, contextFields],
    queryFn: () => api.ai.contextPreview(from, to, contextFields),
    enabled: deviceSafety.aiCopilot && config?.enabled === true
  })
  const [prompt, setPrompt] = useState('')
  const [includeContext, setIncludeContext] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)
  const { data: conversations = [] } = useQuery({
    queryKey: ['aiConversations'],
    queryFn: api.ai.conversations,
    enabled: deviceSafety.aiCopilot && config?.enabled === true
  })

  useEffect(() => {
    if (conversationId || conversations.length === 0) return
    setConversationId(conversations[0]?.id ?? null)
  }, [conversationId, conversations])

  useEffect(() => {
    if (!conversationId) {
      setMessages([])
      return
    }
    let active = true
    void api.ai.conversationMessages(conversationId).then((rows) => {
      if (!active) return
      setMessages(rows.map((row) => ({
        role: row.role,
        text: row.content,
        citations: row.citations,
        usage: row.usage,
        status: row.status
      })))
    }).catch((err: Error) => {
      if (active) setError(err.message)
    })
    return () => { active = false }
  }, [conversationId])

  const ensureConversation = async (title: string): Promise<string> => {
    if (conversationId) return conversationId
    const created = await api.ai.createConversation(title.slice(0, 120))
    setConversationId(created.id)
    await queryClient.invalidateQueries({ queryKey: ['aiConversations'] })
    return created.id
  }

  const send = async (): Promise<void> => {
    const text = prompt.trim()
    if (!text || busy) return
    setPrompt('')
    setError(null)
    setBusy(true)
    const nextRequestId = crypto.randomUUID()
    setRequestId(nextRequestId)
    let activeConversation: string | null = null
    try {
      activeConversation = await ensureConversation(text)
      setMessages((rows) => [...rows, { role: 'user', text }])
      const answer = await api.ai.ask(text, from, to, includeContext, contextFields, nextRequestId, activeConversation)
      setMessages((rows) => [...rows, { role: 'assistant', text: answer.text, citations: answer.citations, usage: answer.usage }])
      await queryClient.invalidateQueries({ queryKey: ['aiConversations'] })
    } catch (err) {
      const message = (err as Error).message
      if (/cancel/i.test(message)) {
        setMessages((rows) => [...rows, { role: 'assistant', text: 'Request cancelled before an answer was completed.', status: 'cancelled' }])
      } else {
        setError(message)
      }
    } finally {
      if (activeConversation) {
        const saved = await api.ai.conversationMessages(activeConversation).catch(() => null)
        if (saved) setMessages(saved.map((row) => ({ role: row.role, text: row.content, citations: row.citations, usage: row.usage, status: row.status })))
      }
      setRequestId(null)
      setBusy(false)
    }
  }

  const cancel = async (): Promise<void> => {
    if (!requestId) return
    try {
      await api.ai.cancel(requestId)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const removeConversation = async (): Promise<void> => {
    if (!conversationId || !window.confirm('Delete this local Copilot conversation?')) return
    try {
      await api.ai.deleteConversation(conversationId)
      setConversationId(null)
      setMessages([])
      await queryClient.invalidateQueries({ queryKey: ['aiConversations'] })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const clearHistory = async (): Promise<void> => {
    if (!window.confirm('Delete all local Copilot conversations for this company?')) return
    try {
      const result = await api.ai.deleteAllConversations()
      setConversationId(null)
      setMessages([])
      await queryClient.invalidateQueries({ queryKey: ['aiConversations'] })
      toast.push('success', `${result.deleted} local conversation${result.deleted === 1 ? '' : 's'} deleted`)
    } catch (err) {
      setError((err as Error).message)
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
      const activeConversation = await ensureConversation(text)
      await api.ai.draftVoucher(text, includeContext, activeConversation)
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
      {!deviceSafety.aiCopilot ? (
        <div className="py-8 text-center">
          <p className="text-[14px] font-medium">AI copilot is disabled on this device</p>
          <p className="mt-1 text-[12.5px] text-muted">An owner can enable the local kill switch in Settings &gt; Features.</p>
        </div>
      ) : !config ? <Skeleton className="h-32 w-full" /> : !config.enabled ? (
        <div className="py-8 text-center">
          <p className="text-[14px] font-medium">AI copilot is off</p>
          <p className="mt-1 text-[12.5px] text-muted">An owner can configure it in Settings &gt; AI copilot.</p>
        </div>
      ) : (
        <div className="flex h-[34rem] flex-col">
          <div className="mb-3 flex items-center gap-2">
            <select aria-label="Copilot conversation" value={conversationId ?? ''} onChange={(event) => setConversationId(event.target.value || null)} className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2.5 py-1.5 text-[12px]">
              <option value="">New conversation</option>
              {conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}
            </select>
            <Button disabled={!conversationId || busy} onClick={() => { setConversationId(null); setMessages([]); setError(null) }}>New</Button>
            <button aria-label="Delete conversation" title="Delete this local conversation" disabled={!conversationId || busy} className="rounded-md border border-line p-2 text-muted hover:text-cr disabled:opacity-40" onClick={() => void removeConversation()}><Trash size={15} /></button>
            {user?.role === 'owner' && conversations.length > 1 && <button disabled={busy} className="text-[10.5px] text-muted hover:text-cr disabled:opacity-40" onClick={() => void clearHistory()}>Clear all</button>}
          </div>
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
            {includeContext && (
              <p className="border-t border-line px-3 py-2 text-[10.5px] leading-4 text-muted">
                Voucher drafting also shares ledger and voucher-type names so the provider can use valid account IDs.
              </p>
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
                {message.status && message.status !== 'completed' && <p className="mt-1 text-[10.5px] uppercase tracking-wide text-muted">{message.status}</p>}
                {message.citations && message.citations.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5 border-t border-line pt-2">
                    {message.citations.map((citation) => (
                      <button key={citation.uri} className="flex items-center gap-1 rounded border border-line bg-panel2 px-2 py-1 text-[10.5px] text-blue hover:border-blue/40" onClick={() => openCitation(citation)}>
                        <LinkSimple size={12} /> {citation.label}
                      </button>
                    ))}
                  </div>
                )}
                {message.usage && (
                  <p className="mt-1.5 text-[10px] text-muted">{message.usage.inputTokens.toLocaleString()} in · {message.usage.outputTokens.toLocaleString()} out · {message.usage.totalTokens.toLocaleString()} total tokens</p>
                )}
              </div>
            ))}
            {busy && <p className="text-[12px] text-muted">Thinking… You can cancel without losing this conversation.</p>}
          </div>
          {error && <p className="mt-2 text-[12px] text-cr">{error}</p>}
          <div className="mt-3 flex items-end gap-2">
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} disabled={busy}
              placeholder="Ask about your books…" className="min-h-16 flex-1 resize-none rounded-md border border-line bg-panel2 px-3 py-2 text-[13px]"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send() } }} />
            <div className="flex flex-col gap-2">
              {busy ? <Button onClick={() => void cancel()}>Cancel</Button> : <Button variant="primary" disabled={!prompt.trim() || (includeContext && contextFields.length === 0)} onClick={() => void send()}>Ask</Button>}
              <Button disabled={busy || prompt.trim().length < 8 || !includeContext} onClick={() => void draft()}>Draft voucher</Button>
            </div>
          </div>
          <p className="mt-1.5 text-[11px] text-muted">Copilot can analyze and propose. It cannot post changes without your review.</p>
        </div>
      )}
    </Modal>
  )
}
