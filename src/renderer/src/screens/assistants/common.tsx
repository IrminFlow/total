// Shared bits of the Assistants tabs: "Run with AI" (the assistant panel, with the tab's tool
// pre-run by main so the conversation starts from its result), status badges and row links.
import type { AiPreCall } from '@shared/ai'
import type { CheckEffective } from '@shared/closeChecklist'
import { useAssistantPanel } from '../../components/ai/AssistantPanel'
import { useAiAffordances } from '../../lib/explain'
import { useSession } from '../../state/stores'
import { Badge, Button } from '../../components/ui'
import type { BadgeTone } from '../../components/kit'
import { ItemLink, LedgerLink, VoucherLink } from '../../components/links'

/** Ask the assistant `question` in a new conversation, with `preCall` run first. */
export function runWithAi(question: string, preCall: AiPreCall, tab: string, params: Record<string, string | number> = {}): void {
  const { from, to } = useSession.getState()
  useAssistantPanel.getState().ask(question, { screen: 'assistants', label: 'Assistants', from, to, params: { tab, ...params } }, preCall)
}

/** The "Run with AI" button — rendered only while the assistant is on for this company. */
export function RunWithAi({ onRun, testId, label = 'Run with AI' }: { onRun: () => void; testId: string; label?: string }): React.JSX.Element | null {
  const ready = useAiAffordances()
  if (!ready) return null
  return (
    <Button variant="ghost" data-testid={testId} onClick={onRun} title="Open the assistant with this result as its starting point">
      ✦ {label}
    </Button>
  )
}

const STATUS: Record<CheckEffective, { tone: BadgeTone; label: string }> = {
  ok: { tone: 'success', label: 'OK' },
  done: { tone: 'success', label: 'Done' },
  na: { tone: 'neutral', label: 'N/A' },
  warn: { tone: 'warning', label: 'Review' },
  fail: { tone: 'danger', label: 'Action' }
}

export function StatusBadge({ status, testId }: { status: CheckEffective; testId?: string }): React.JSX.Element {
  const s = STATUS[status]
  return (
    <Badge tone={s.tone} testId={testId}>
      {s.label}
    </Badge>
  )
}

export const STATUS_OPTIONS = (Object.keys(STATUS) as CheckEffective[]).map((v) => ({ value: v, label: STATUS[v].label }))

export function SeverityBadge({ severity }: { severity: 'high' | 'medium' | 'low' }): React.JSX.Element {
  return <Badge tone={severity === 'high' ? 'danger' : severity === 'medium' ? 'warning' : 'neutral'}>{severity === 'high' ? 'High' : severity === 'medium' ? 'Medium' : 'Low'}</Badge>
}

/** A row's own record: its voucher, else its ledger, else its item, else plain text. */
export function RowLink({ label, voucherId, ledgerId, itemId }: { label: string; voucherId?: number | null; ledgerId?: number | null; itemId?: number | null }): React.JSX.Element {
  if (voucherId) return <VoucherLink voucherId={voucherId} label={label} />
  if (ledgerId) return <LedgerLink ledgerId={ledgerId} name={label} />
  if (itemId) return <ItemLink itemId={itemId} name={label} />
  return <>{label}</>
}

/** Viewers read; accountants and owners mark, dismiss and draft (main enforces it too). */
export function useCanAct(): boolean {
  return useSession((s) => s.user == null || s.user.role !== 'viewer')
}
