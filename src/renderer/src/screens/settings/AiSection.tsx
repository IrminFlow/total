// Settings → AI (WP 5.1): the data notice (accepted once per company), the per-company switch,
// the API key (stored by main in the OS-encrypted secret store; only a hint comes back), test
// connection + model ids, privacy options, the price table, usage/cost by day and conversation,
// the outbound log, and "Delete all AI data". Everything but viewing is owner-only (main enforces).
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  aggregateUsage, aiModelIdSchema, formatMicroUsd, microToUsdText, parseUsdToMicro, type AiConnectionResult, type AiModelPrice, type AiOutboundRow,
  type AiSettingsView, type AiUsageAggregate, type AiUsageRow
} from '@shared/ai'
import { aiApi } from '../../lib/aiClient'
import { toDisplayDateTime } from '@shared/dates'
import { useSession, useToasts } from '../../state/stores'
import { confirmDialog } from '../../lib/dialogs'
import { Badge, Banner, Button, Checkbox, Field, Panel, SectionTitle, Segmented, SkeletonRows, TextInput } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'

const fmtInt = (n: number): string => n.toLocaleString('en-IN')
/** Stored UTC ISO → local display date-time. */
const fmtAt = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : toDisplayDateTime(d)
}

const AGG_COLUMNS = defineColumns<AiUsageAggregate>([
  { id: 'label', header: 'Day / conversation', kind: 'text', value: (r) => r.label, hideable: false, groupable: false, minWidth: 180 },
  { id: 'calls', header: 'Calls', kind: 'number', value: (r) => r.calls, aggregate: 'sum', width: 80 },
  { id: 'in', header: 'Input tokens', kind: 'number', value: (r) => r.inputTokens, aggregate: 'sum', width: 120 },
  { id: 'cached', header: 'Cached', kind: 'number', value: (r) => r.cachedTokens, aggregate: 'sum', width: 100 },
  { id: 'out', header: 'Output tokens', kind: 'number', value: (r) => r.outputTokens, aggregate: 'sum', width: 120 },
  {
    id: 'cost', header: 'Est. cost (USD)', kind: 'number', value: (r) => r.costMicroUsd,
    text: (r) => `${formatMicroUsd(r.costMicroUsd)}${r.unpriced ? ` (${r.unpriced} unpriced)` : ''}`, width: 170
  }
])

const CALL_COLUMNS = defineColumns<AiUsageRow>([
  { id: 'at', header: 'When', kind: 'text', value: (r) => r.at, text: (r) => fmtAt(r.at), className: 'num text-muted', width: 200 },
  { id: 'thread', header: 'Conversation', kind: 'text', value: (r) => r.threadTitle ?? '', minWidth: 160 },
  { id: 'model', header: 'Model', kind: 'text', value: (r) => r.model, className: 'num', width: 140 },
  { id: 'in', header: 'In', kind: 'number', value: (r) => r.inputTokens, aggregate: 'sum', width: 90 },
  { id: 'out', header: 'Out', kind: 'number', value: (r) => r.outputTokens, aggregate: 'sum', width: 90 },
  { id: 'cost', header: 'Cost', kind: 'number', value: (r) => r.costMicroUsd, text: (r) => formatMicroUsd(r.costMicroUsd), width: 100 },
  { id: 'ok', header: 'Result', kind: 'enum', value: (r) => (r.ok ? 'ok' : 'failed'), options: [{ value: 'ok', label: 'OK' }, { value: 'failed', label: 'Failed' }], width: 90 }
])

const OUTBOUND_COLUMNS = defineColumns<AiOutboundRow>([
  { id: 'at', header: 'When', kind: 'text', value: (r) => r.at, text: (r) => fmtAt(r.at), className: 'num text-muted', width: 200, hideable: false },
  { id: 'model', header: 'Model', kind: 'text', value: (r) => `${r.provider}/${r.model}`, className: 'num', width: 170 },
  { id: 'bytes', header: 'Size (bytes)', kind: 'number', value: (r) => r.requestBytes, text: (r) => fmtInt(r.requestBytes), width: 110 },
  { id: 'items', header: 'Items', kind: 'number', value: (r) => r.messageCount, width: 70 },
  { id: 'results', header: 'Tool results sent', kind: 'text', value: (r) => r.toolResultsSent.join(', '), minWidth: 160 },
  {
    id: 'privacy', header: 'Privacy', kind: 'text',
    value: (r) => [r.masked ? 'IDs masked' : 'IDs in clear', r.pseudonymised ? 'parties aliased' : 'party names in clear'].join(' · '), minWidth: 200
  },
  { id: 'hash', header: 'Payload SHA-256', kind: 'text', value: (r) => r.payloadSha256, text: (r) => `${r.payloadSha256.slice(0, 16)}…`, className: 'num text-muted', defaultHidden: true, width: 160 },
  { id: 'status', header: 'Status', kind: 'text', value: (r) => r.status, width: 90 }
])

export function AiSection(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { user } = useSession()
  const isOwner = !user || user.role === 'owner'
  const { data: view } = useQuery({ queryKey: ['aiSettings'], queryFn: aiApi.settings })
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<AiSettingsView | unknown>, ok?: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      await queryClient.invalidateQueries({ queryKey: ['aiSettings'] })
      if (ok) toast.push('success', ok)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!view) {
    return (
      <div>
        <SectionTitle>AI assistant</SectionTitle>
        <Panel>
          <SkeletonRows rows={6} />
        </Panel>
      </div>
    )
  }
  const s = view.settings

  return (
    <div className="flex flex-col gap-section" data-testid="settings-ai">
      <div>
        <SectionTitle right={<Badge tone={view.ready ? 'success' : 'neutral'} testId="ai-status">{view.ready ? 'On' : 'Off'}</Badge>}>AI assistant</SectionTitle>
        {!isOwner && (
          <Banner tone="info" className="mb-3">
            Read-only — only owners can change the assistant’s settings.
          </Banner>
        )}
        {view.mock && (
          <Banner tone="warning" className="mb-3" testId="ai-mock-banner">
            Test mode (TOTAL_AI_MOCK): answers come from a scripted offline assistant; nothing is sent anywhere.
          </Banner>
        )}

        <Panel className="p-5" testId="ai-notice">
          <h3 className="mb-2 font-serif text-subtitle font-semibold">What the assistant sends, and to whom</h3>
          <ul className="mb-3 list-disc pl-5 text-body-sm text-ink">
            <li>The assistant is optional and off by default. Total stays fully offline until you turn it on here.</li>
            <li>
              When you ask a question, this computer sends your question, the conversation so far, and the results of the reports the assistant
              looks up (for example a ledger statement or the profit and loss) to <strong>OpenAI</strong>, using <strong>your own API key</strong>.
              OpenAI’s terms for API use apply. Requests ask OpenAI not to store the conversation (<span className="num">store: false</span>).
            </li>
            <li>Nothing else leaves this computer: no files, no backups, no other companies. Your books stay in this folder.</li>
            <li>GSTINs, PANs and bank numbers are masked by default; you can also replace party names with aliases.</li>
            <li>The assistant can only read reports and prepare drafts. It cannot save, change or delete anything — you review and save drafts yourself.</li>
            <li>Every request is listed below in the outbound log (sizes, which reports, a fingerprint of exactly what was sent), with its cost.</li>
          </ul>
          {s.noticeAcceptedAt ? (
            <p className="text-hint text-muted" data-testid="ai-notice-accepted">
              Accepted {fmtAt(s.noticeAcceptedAt)}
              {s.noticeAcceptedBy ? ` by ${s.noticeAcceptedBy}` : ''}.
            </p>
          ) : (
            <Button variant="primary" disabled={!isOwner || busy} onClick={() => void run(aiApi.acceptNotice, 'Data notice accepted')} data-testid="btn-ai-accept-notice">
              I understand — accept
            </Button>
          )}
        </Panel>
      </div>

      <Panel className="p-5">
        <div className="flex flex-col gap-3">
          <Checkbox
            label="Turn the assistant on for this company"
            hint={s.noticeAcceptedAt ? 'Off stops every request at once. Your conversations stay on this computer.' : 'Accept the data notice first.'}
            checked={s.enabled}
            disabled={!isOwner || busy || !s.noticeAcceptedAt}
            onChange={(v) => void run(() => aiApi.setSettings({ enabled: v }), v ? 'Assistant on' : 'Assistant off')}
            testId="input-ai-enabled"
          />
          {view.blocker && s.noticeAcceptedAt && <p className="text-hint text-muted" data-testid="ai-blocker">{view.blocker}</p>}
        </div>
      </Panel>

      <KeyPanel view={view} isOwner={isOwner} />
      <ModelsPanel view={view} isOwner={isOwner} />

      <Panel className="p-5">
        <h3 className="mb-2 text-detail font-semibold">Privacy</h3>
        <div className="flex flex-col gap-3">
          <Checkbox
            label="Mask GSTIN, PAN, IFSC and bank account numbers"
            hint="Sent as e.g. [GSTIN …1Z5]. The assistant can still tell parties apart, but never sees the full number."
            checked={s.privacy.maskIds}
            disabled={!isOwner || busy}
            onChange={(v) => void run(() => aiApi.setSettings({ privacy: { maskIds: v } }))}
            testId="input-ai-mask"
          />
          <Checkbox
            label="Replace party names with aliases"
            hint="Debtors and creditors are sent as Party-0001, Party-0002… (a fixed list kept on this computer) and shown to you with their real names."
            checked={s.privacy.pseudonymiseParties}
            disabled={!isOwner || busy}
            onChange={(v) => void run(() => aiApi.setSettings({ privacy: { pseudonymiseParties: v } }))}
            testId="input-ai-pseudonymise"
          />
        </div>
      </Panel>

      <UsagePanel />
      <OutboundPanel />

      <Panel className="p-5">
        <h3 className="mb-1 text-detail font-semibold">Delete all AI data</h3>
        <p className="mb-3 text-body-sm text-muted">
          Removes every conversation, draft, memory and the party alias list from this company. Vouchers you saved from drafts are not touched. The
          usage and outbound logs are kept as the record of what was spent and sent.
        </p>
        <Button
          variant="danger"
          disabled={!isOwner || busy}
          data-testid="btn-ai-delete-all"
          onClick={async () => {
            const ok = await confirmDialog({
              title: 'Delete all AI data',
              message: 'Delete every conversation, draft and memory of the assistant for this company? This cannot be undone.',
              confirmLabel: 'Delete',
              danger: true
            })
            if (!ok) return
            await run(async () => {
              await aiApi.deleteAll(false)
              await queryClient.invalidateQueries({ queryKey: ['aiThreads'] })
            }, 'AI data deleted')
          }}
        >
          Delete all AI data…
        </Button>
      </Panel>
    </div>
  )
}

function KeyPanel({ view, isOwner }: { view: AiSettingsView; isOwner: boolean }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<AiConnectionResult | null>(null)

  const act = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      await queryClient.invalidateQueries({ queryKey: ['aiSettings'] })
      toast.push('success', ok)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel className="p-5">
      <h3 className="mb-1 text-detail font-semibold">OpenAI API key</h3>
      <p className="mb-3 text-body-sm text-muted">
        Stored encrypted by your operating system’s keychain, outside every company file and backup, and used for all companies on this
        computer. It never leaves the app except to OpenAI.
      </p>
      {!view.secureStorageAvailable && (
        <Banner tone="warning" className="mb-3">
          Secure storage is not available on this computer, so a key cannot be saved.
        </Banner>
      )}
      <div className="flex items-end gap-2">
        <Field label="API key" hint={view.keyPresent ? `A key is saved (${view.keyHint}). Type a new one to replace it.` : 'Starts with sk-'}>
          <TextInput
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="num"
            value={key}
            placeholder={view.keyPresent ? '••••••••••••' : 'sk-…'}
            disabled={!isOwner || busy}
            onChange={(e) => setKey(e.target.value)}
            data-testid="input-ai-key"
          />
        </Field>
        <Button
          variant="primary"
          disabled={!isOwner || busy || key.trim().length < 8}
          onClick={() => void act(async () => {
            await aiApi.setKey(key.trim())
            setKey('')
          }, 'API key saved')}
          data-testid="btn-ai-save-key"
        >
          Save key
        </Button>
        {view.keyPresent && (
          <Button disabled={!isOwner || busy} onClick={() => void act(aiApi.clearKey, 'API key removed')} data-testid="btn-ai-clear-key">
            Remove
          </Button>
        )}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button
          disabled={!isOwner || busy || (!view.keyPresent && !view.mock)}
          loading={busy && test === null}
          onClick={async () => {
            setBusy(true)
            try {
              setTest(await aiApi.testConnection())
            } catch (err) {
              toast.push('error', (err as Error).message)
            } finally {
              setBusy(false)
            }
          }}
          data-testid="btn-ai-test"
        >
          Test connection
        </Button>
        {test && (
          <span className="text-body-sm" data-testid="ai-test-result" data-ok={test.ok ? 'true' : 'false'}>
            {test.ok ? (
              <>
                Connected — {test.models.length} models. Default model {test.defaultModelFound ? <Badge tone="success">found</Badge> : <Badge tone="danger">not offered</Badge>}{' '}
                · fast model {test.fastModelFound ? <Badge tone="success">found</Badge> : <Badge tone="danger">not offered</Badge>}
              </>
            ) : (
              <span className="text-danger">{test.error}</span>
            )}
          </span>
        )}
      </div>
      {test?.ok && test.models.length > 0 && (
        <details className="mt-2 text-caption text-muted">
          <summary className="cursor-pointer">Models this key can use</summary>
          <p className="num mt-1 leading-relaxed">{test.models.join(', ')}</p>
        </details>
      )}
      {test?.ok && <datalist id="ai-models">{test.models.map((m) => <option key={m} value={m} />)}</datalist>}
    </Panel>
  )
}

function ModelsPanel({ view, isOwner }: { view: AiSettingsView; isOwner: boolean }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const s = view.settings
  const [def, setDef] = useState(s.defaultModel)
  const [fast, setFast] = useState(s.fastModel)
  const [prices, setPrices] = useState<Record<string, Record<keyof AiModelPrice, string>>>(() => priceText(s.prices, [s.defaultModel, s.fastModel]))
  const [busy, setBusy] = useState(false)
  const defErr = aiModelIdSchema.safeParse(def).success ? undefined : 'Letters, digits and . _ : - / only'
  const fastErr = aiModelIdSchema.safeParse(fast).success ? undefined : 'Letters, digits and . _ : - / only'
  const models = [...new Set([def.trim(), fast.trim()].filter(Boolean))]
  const priceErrors = models.flatMap((m) =>
    (['inputPerM', 'cachedInputPerM', 'outputPerM'] as const).filter((k) => parseUsdToMicro(prices[m]?.[k] ?? '') === undefined).map((k) => `${m} ${k}`)
  )

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const table: Record<string, AiModelPrice> = { ...s.prices }
      for (const m of models) {
        const p = prices[m]
        table[m] = {
          inputPerM: parseUsdToMicro(p?.inputPerM ?? '') ?? null,
          cachedInputPerM: parseUsdToMicro(p?.cachedInputPerM ?? '') ?? null,
          outputPerM: parseUsdToMicro(p?.outputPerM ?? '') ?? null
        }
      }
      await aiApi.setSettings({ defaultModel: def.trim(), fastModel: fast.trim(), prices: table })
      await queryClient.invalidateQueries({ queryKey: ['aiSettings'] })
      toast.push('success', 'Models and prices saved')
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const priceCell = (m: string, k: keyof AiModelPrice): React.JSX.Element => (
    <TextInput
      aria-label={`${m} ${k === 'inputPerM' ? 'input' : k === 'cachedInputPerM' ? 'cached input' : 'output'} price per million tokens`}
      className="num"
      value={prices[m]?.[k] ?? ''}
      placeholder="not set"
      disabled={!isOwner || busy}
      invalid={parseUsdToMicro(prices[m]?.[k] ?? '') === undefined}
      onChange={(e) => setPrices((p) => ({ ...p, [m]: { ...(p[m] ?? { inputPerM: '', cachedInputPerM: '', outputPerM: '' }), [k]: e.target.value } }))}
    />
  )

  return (
    <Panel className="p-5">
      <h3 className="mb-1 text-detail font-semibold">Models and prices</h3>
      <p className="mb-3 text-body-sm text-muted">
        The defaults (<span className="num">gpt-6.1-sol</span>, fast <span className="num">gpt-6-luna</span>) come from the plan and are not checked
        until you press Test connection, which lists the models your key can use. Prices are yours to fill in (US dollars per million tokens, from
        OpenAI’s pricing page); without them the cost column shows “—”.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Default model" error={defErr}>
          <TextInput className="num" list="ai-models" value={def} disabled={!isOwner || busy} onChange={(e) => setDef(e.target.value)} data-testid="input-ai-model" />
        </Field>
        <Field label="Fast model" error={fastErr}>
          <TextInput className="num" list="ai-models" value={fast} disabled={!isOwner || busy} onChange={(e) => setFast(e.target.value)} data-testid="input-ai-fast-model" />
        </Field>
      </div>
      <table className="mt-4 w-full text-body-sm">
        <thead>
          <tr className="text-left text-caption text-muted">
            <th className="pb-1 font-medium">Model</th>
            <th className="pb-1 font-medium">Input $/1M</th>
            <th className="pb-1 font-medium">Cached input $/1M</th>
            <th className="pb-1 font-medium">Output $/1M</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m}>
              <td className="num pr-2">{m}</td>
              <td className="pr-2 py-1">{priceCell(m, 'inputPerM')}</td>
              <td className="pr-2 py-1">{priceCell(m, 'cachedInputPerM')}</td>
              <td className="py-1">{priceCell(m, 'outputPerM')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex justify-end">
        <Button variant="primary" disabled={!isOwner || busy || !!defErr || !!fastErr || priceErrors.length > 0} onClick={() => void save()} data-testid="btn-ai-save-models">
          Save models and prices
        </Button>
      </div>
    </Panel>
  )
}

function priceText(prices: Record<string, AiModelPrice>, extra: string[]): Record<string, Record<keyof AiModelPrice, string>> {
  const out: Record<string, Record<keyof AiModelPrice, string>> = {}
  for (const m of new Set([...Object.keys(prices), ...extra])) {
    const p = prices[m]
    out[m] = { inputPerM: microToUsdText(p?.inputPerM), cachedInputPerM: microToUsdText(p?.cachedInputPerM), outputPerM: microToUsdText(p?.outputPerM) }
  }
  return out
}

function UsagePanel(): React.JSX.Element {
  const { data: rows = [], isLoading } = useQuery({ queryKey: ['aiUsage'], queryFn: aiApi.usage })
  const [by, setBy] = useState<'day' | 'thread' | 'call'>('day')
  const agg = useMemo(() => (by === 'call' ? [] : aggregateUsage(rows, by)), [rows, by])
  const total = useMemo(() => aggregateUsage(rows, 'day').reduce((s, g) => (g.costMicroUsd == null ? s : (s ?? 0) + g.costMicroUsd), null as number | null), [rows])
  return (
    <div>
      <SectionTitle right={<span className="text-body-sm text-muted" data-testid="ai-usage-total">Total {formatMicroUsd(total)} · {rows.length} calls</span>}>
        Usage and cost
      </SectionTitle>
      <Panel>
        {by === 'call' ? (
          <DataTable
            viewId="settings-ai-calls"
            testId="ai-usage-calls"
            ariaLabel="AI calls"
            columns={CALL_COLUMNS}
            rows={rows}
            rowKey={(r) => r.id}
            loading={isLoading}
            maxHeight="50vh"
            empty={{ title: 'No AI calls yet' }}
            toolbarStart={<UsageBy by={by} setBy={setBy} />}
            toolbarFeatures={{ groupBy: false, density: false }}
          />
        ) : (
          <DataTable
            viewId={`settings-ai-usage-${by}`}
            testId="ai-usage"
            ariaLabel="AI usage"
            columns={AGG_COLUMNS}
            rows={agg}
            rowKey={(r) => r.key}
            loading={isLoading}
            maxHeight="50vh"
            empty={{ title: 'No AI calls yet', hint: 'Every question’s model calls are counted here with their tokens and estimated cost.' }}
            toolbarStart={<UsageBy by={by} setBy={setBy} />}
            toolbarFeatures={{ groupBy: false, density: false }}
          />
        )}
      </Panel>
    </div>
  )
}

function UsageBy({ by, setBy }: { by: 'day' | 'thread' | 'call'; setBy: (b: 'day' | 'thread' | 'call') => void }): React.JSX.Element {
  return (
    <Segmented
      label="Group usage by"
      size="sm"
      value={by}
      onChange={setBy}
      testId="ai-usage-by"
      options={[
        { value: 'day', label: 'By day' },
        { value: 'thread', label: 'By conversation' },
        { value: 'call', label: 'Each call' }
      ]}
    />
  )
}

function OutboundPanel(): React.JSX.Element {
  const { data: rows = [], isLoading } = useQuery({ queryKey: ['aiOutbound'], queryFn: aiApi.outbound })
  return (
    <div>
      <SectionTitle>Outbound log</SectionTitle>
      <p className="mb-2 text-body-sm text-muted">
        One row per request that left this computer: its size, which report results it carried, the privacy options in force and a SHA-256
        fingerprint of exactly what was sent. The content itself is not kept here.
      </p>
      <Panel>
        <DataTable
          viewId="settings-ai-outbound"
          testId="ai-outbound"
          ariaLabel="AI outbound log"
          columns={OUTBOUND_COLUMNS}
          rows={rows}
          rowKey={(r) => r.id}
          loading={isLoading}
          maxHeight="50vh"
          empty={{ title: 'Nothing has been sent' }}
          toolbarFeatures={{ groupBy: false, density: false }}
        />
      </Panel>
    </div>
  )
}
