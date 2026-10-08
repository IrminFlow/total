// Analysis → Assistants (WP 5.5): the month-end close checklist, GSTR-2B mismatch resolution,
// anomaly and duplicate detection, and a report from a plain question. Every tab is computed by
// main (services/assistants.ts) and works with AI off; when the assistant is on, "Run with AI"
// opens the chat panel with the same assistant tool already run, so the answer starts from it.
import { Page, PageHeader, TabBar } from '../../components/ui'
import { useNav } from '../../state/stores'
import { CloseTab } from './CloseTab'
import { Gst2bTab } from './Gst2bTab'
import { AnomaliesTab } from './AnomaliesTab'
import { ReportTab } from './ReportTab'

export type AssistantTab = 'close' | 'gst2b' | 'anomalies' | 'report'

const TABS: { id: AssistantTab; label: string }[] = [
  { id: 'close', label: 'Month-end close' },
  { id: 'gst2b', label: 'GST 2B mismatches' },
  { id: 'anomalies', label: 'Anomalies' },
  { id: 'report', label: 'Report from a question' }
]

const SUBTITLE: Record<AssistantTab, string> = {
  close: 'Everything to clear before the month is closed — computed from the books, with the screen that fixes each item.',
  gst2b: 'GSTR-2B against the purchase register: what is missing, what differs, and what to do — drafts only, nothing is posted.',
  anomalies: 'Possible duplicates and unusual entries, with the reason each was flagged.',
  report: 'Describe a report in words; it opens in the report builder, ready to save.'
}

export function AssistantsScreen({ tab = 'close', period }: { tab?: AssistantTab; period?: string }): React.JSX.Element {
  const nav = useNav()
  return (
    <Page width="wide">
      <PageHeader
        title="Assistants"
        subtitle={SUBTITLE[tab]}
        tabs={<TabBar screen="assistants" label="Assistants" tabs={TABS} active={tab} onSelect={(t) => nav.replace({ name: 'assistants', tab: t, ...(period ? { period } : {}) })} />}
      />
      {tab === 'close' && <CloseTab initialPeriod={period} />}
      {tab === 'gst2b' && <Gst2bTab initialPeriod={period} />}
      {tab === 'anomalies' && <AnomaliesTab />}
      {tab === 'report' && <ReportTab />}
    </Page>
  )
}
