import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useToasts } from '../state/stores'
import { Button, EmptyState, Panel, SectionTitle, SkeletonRows } from '../components/ui'
import { confirmDialog } from '../lib/dialogs'

export function VoucherDraftsScreen(): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['voucher-drafts'], queryFn: api.voucherDrafts.list })

  const remove = async (id: number, title: string): Promise<void> => {
    const proceed = await confirmDialog({ title: 'Discard voucher draft', message: `Discard “${title}”? This unfinished entry has never affected the books.`, confirmLabel: 'Discard draft', danger: true })
    if (!proceed) return
    try {
      await api.voucherDrafts.remove(id)
      await queryClient.invalidateQueries({ queryKey: ['voucher-drafts'] })
      toast.push('success', 'Draft discarded')
    } catch (error) { toast.push('error', (error as Error).message) }
  }

  return <div className="mx-auto max-w-5xl">
    <SectionTitle right={<Button variant="primary" onClick={() => nav.go({ name: 'voucher-entry' })}>New voucher</Button>}>Voucher drafts</SectionTitle>
    <p className="mb-4 text-[12px] text-muted">Unfinished entries stay outside every ledger, report, GST return and stock balance until they pass normal posting checks.</p>
    <Panel className="overflow-hidden p-0">
      {isLoading ? <SkeletonRows rows={5} /> : !data?.length ? <EmptyState title="No unfinished vouchers" hint="Use Save draft in voucher entry when you need to pause incomplete work" /> : <div data-testid="rows-voucher-drafts">
        {data.map((draft) => <div key={draft.id} data-row-id={draft.id} className="grid grid-cols-[1fr_150px_150px_auto] items-center gap-4 border-b border-line px-4 py-3 last:border-0">
          <div className="min-w-0"><p className="truncate text-[13px] font-medium">{draft.title}</p><p className="mt-0.5 truncate text-[10.5px] text-muted">{draft.voucherTypeName} · saved by {draft.createdBy}</p></div>
          <span className="text-[11px] capitalize text-muted">{draft.mode.replace('_', ' ')}</span>
          <span className="num text-[10.5px] text-muted">{new Date(`${draft.updatedAt}Z`).toLocaleString()}</span>
          <div className="flex gap-2"><Button onClick={() => void remove(draft.id, draft.title)}>Discard</Button><Button data-testid={`resume-draft-${draft.id}`} variant="primary" onClick={() => nav.go({ name: 'voucher-entry', workDraftId: draft.id })}>Resume</Button></div>
        </div>)}
      </div>}
    </Panel>
  </div>
}
