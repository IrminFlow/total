import { useQuery } from '@tanstack/react-query'
import type { Voucher } from '@shared/domain'
import { api } from '../../lib/client'
import { pendingExplanation } from '@shared/approvals'
import { formatPaise } from '@shared/money'


/**
 * What happened to this entry, when it was above the owner's threshold (roadmap V #386).
 *
 * The important word on this banner is "yet". A held voucher is saved, numbered, and sitting
 * right here — it simply is not in the books until somebody decides. Somebody who types a large
 * entry and then cannot find it in the trial balance will assume the app lost it, and stop
 * trusting the app long before they work out what actually happened.
 */
export function ApprovalBanner({ voucher }: { voucher: Voucher }): React.JSX.Element | null {
  const state = voucher.approvalState
  // Only asked for when there is something to explain — a threshold is a setting most companies
  // never turn on, and this must not cost a round trip on every voucher they open.
  const { data } = useQuery({
    queryKey: ['approvalThreshold'],
    queryFn: () => api.approvals.thresholdGet(),
    enabled: state === 'pending'
  })
  if (!state) return null

  if (state === 'pending') {
    return (
      <div
        data-testid="voucher-approval-pending"
        className="mt-4 rounded-md border border-accent/50 bg-accent/10 px-4 py-3"
      >
        <p className="text-detail font-medium text-ink">Waiting for the owner to approve it.</p>
        <p className="mt-1 text-body-sm text-muted">
          {pendingExplanation(data?.threshold ?? null, formatPaise)} Nothing is lost — it is here, numbered{' '}
          <span className="num">{voucher.number}</span>, and it joins the books the moment it is approved.
        </p>
      </div>
    )
  }

  if (state === 'rejected') {
    return (
      <div data-testid="voucher-approval-rejected" className="mt-4 rounded-md border border-cr/50 bg-cr/10 px-4 py-3">
        <p className="text-detail font-medium text-cr">
          Not approved{voucher.approvalBy ? ` by ${voucher.approvalBy}` : ''}
          {voucher.approvalAt ? ` on ${voucher.approvalAt.slice(0, 16)}` : ''}.
        </p>
        {voucher.approvalNote && <p className="mt-1 text-body-sm text-ink">&ldquo;{voucher.approvalNote}&rdquo;</p>}
        <p className="mt-1 text-body-sm text-muted">
          It is out of the books. Correct it and save, and it goes back for approval.
        </p>
      </div>
    )
  }

  return (
    <div data-testid="voucher-approval-approved" className="mt-4 rounded-md border border-dr/40 bg-dr/10 px-4 py-2.5">
      <p className="text-body-sm text-dr">
        Approved{voucher.approvalBy ? ` by ${voucher.approvalBy}` : ''}
        {voucher.approvalAt ? ` on ${voucher.approvalAt.slice(0, 16)}` : ''}.
      </p>
    </div>
  )
}
