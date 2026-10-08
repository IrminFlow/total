// Assistants → Report from a question: a plain question mapped to a report-builder model by the
// deterministic phrase mapper (works with AI off — "sales by month", "top 10 customers by sales
// this year", "expenses by ledger last quarter"), run through the report builder, and opened in
// it pre-filled to adjust and save. With the assistant on, "Ask AI" lets the model build the
// request (build_report) for questions the phrases do not cover.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DIMENSIONS, MEASURES } from '@shared/reportBuilder/model'
import { assistantsApi, type NlReportReply } from '../../lib/assistantsClient'
import { reportsApi } from '../../lib/reportsClient'
import { useAiScreenContext } from '../../lib/aiContext'
import { useAiAffordances } from '../../lib/explain'
import { useAssistantPanel } from '../../components/ai/AssistantPanel'
import { nextDraftId, useNav, useSession, useToasts } from '../../state/stores'
import { Banner, Button, EmptyState, Panel, SkeletonRows, TextInput } from '../../components/ui'
import { DataTable } from '../../components/table'
import { useResultTable } from '../reportBuilder/ResultView'
import { runWithAi } from './common'

const EXAMPLES = ['Sales by month', 'Top 10 customers by sales this year', 'Expenses by ledger last quarter', 'GST on purchases by month', 'Quantities sold by item']

function Preview({ reply }: { reply: Extract<NlReportReply, { ok: true }> }): React.JSX.Element {
  const { from, to } = useSession()
  const run = useQuery({ queryKey: ['rbRun', JSON.stringify(reply.model), from, to], queryFn: () => reportsApi.run(reply.model, { from, to }), retry: false })
  const table = useResultTable(run.data, reply.model)
  if (run.error) return <EmptyState title="The report could not run" hint={(run.error as Error).message} />
  if (!run.data) return <SkeletonRows rows={5} />
  return (
    <DataTable
      viewId="assistants-report-preview"
      testId="assistants-report"
      ariaLabel={reply.title}
      columns={table.columns}
      rows={table.rows}
      maxHeight="50vh"
      exportOptions={{ title: reply.title, periodLabel: `${run.data.from} to ${run.data.to}`, filename: 'report-from-question' }}
      empty={{ title: 'The report has no rows for this period' }}
    />
  )
}

export function ReportTab(): React.JSX.Element {
  useAiScreenContext('assistants', { tab: 'report' })
  const { from, to } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const aiReady = useAiAffordances()
  const [question, setQuestion] = useState('')
  const [reply, setReply] = useState<NlReportReply | null>(null)
  const [busy, setBusy] = useState(false)

  const build = async (q = question): Promise<void> => {
    if (!q.trim()) return
    setBusy(true)
    try {
      setReply(await assistantsApi.nlReport(q.trim(), from, to))
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const askAi = (): void => {
    const q = question.trim()
    if (!q) return
    if (reply?.ok) runWithAi(`Report: ${q}`, { tool: 'build_report', input: reply.request as unknown as Record<string, unknown> }, 'report')
    else useAssistantPanel.getState().ask(`Build a report: ${q}`, { screen: 'assistants', label: 'Assistants', from, to, params: { tab: 'report' } })
  }

  return (
    <>
      <Panel className="mb-3 p-panel">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void build()
          }}
        >
          <TextInput
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. top 10 customers by sales this year"
            className="min-w-[320px] flex-1"
            data-testid="input-assistants-report-question"
            aria-label="Describe the report"
          />
          <Button variant="primary" type="submit" loading={busy} data-testid="btn-assistants-report-build">
            Build report
          </Button>
          {aiReady && (
            <Button variant="ghost" type="button" onClick={askAi} data-testid="btn-assistants-report-ai">
              ✦ Ask AI
            </Button>
          )}
        </form>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              className="rounded-full border border-line px-2.5 py-0.5 text-small text-muted hover:bg-panel2 hover:text-ink"
              onClick={() => {
                setQuestion(ex)
                void build(ex)
              }}
            >
              {ex}
            </button>
          ))}
        </div>
      </Panel>
      {reply && !reply.ok && (
        <Banner tone="warning" className="mb-3" testId="assistants-report-problems">
          {reply.problems.join(' ')}
        </Banner>
      )}
      {reply?.ok && (
        <Panel>
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-panel py-2">
            <span className="font-medium" data-testid="assistants-report-title">
              {reply.title}
            </span>
            <span className="text-small text-muted">
              {reply.model.dimensions.length ? `by ${reply.model.dimensions.map((d) => DIMENSIONS[d.key].label.toLowerCase()).join(', ')} · ` : ''}
              {reply.model.measures.map((m) => MEASURES[m].label).join(', ')}
            </span>
            <span className="flex-1" />
            <Button
              data-testid="btn-assistants-report-open"
              onClick={() => nav.go({ name: 'report-builder', model: reply.model, modelName: reply.title, modelSeq: nextDraftId() })}
            >
              Open in report builder
            </Button>
          </div>
          <Preview reply={reply} />
        </Panel>
      )}
    </>
  )
}
