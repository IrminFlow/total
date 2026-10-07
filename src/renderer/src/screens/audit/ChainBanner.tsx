import { useQuery } from '@tanstack/react-query'
import { api, type ChainVerification } from '../../lib/client'
import { Banner, Button } from '../../components/ui'

/** Query family for the chain verification (the 'audit' family — every invalidation of the log re-verifies). */
export const AUDIT_VERIFY_KEY = ['audit', 'verify'] as const

export function useAuditVerification(): { data: ChainVerification | undefined; isFetching: boolean; refetch: () => void } {
  const q = useQuery({ queryKey: AUDIT_VERIFY_KEY, queryFn: api.audit.verify })
  return { data: q.data, isFetching: q.isFetching, refetch: () => void q.refetch() }
}

const shortHash = (h: string | null): string => (h ? `${h.slice(0, 12)}…` : '—')

/**
 * "Chain verified ✓ / Chain broken at row N" — the result of walking the audit log's SHA-256
 * hash chain (src/shared/auditChain.ts), with the head an auditor can compare against later.
 */
export function ChainBanner({ verification, busy, onVerify }: {
  verification: ChainVerification | undefined
  busy?: boolean
  onVerify?: () => void
}): React.JSX.Element | null {
  if (!verification) return null
  const action = onVerify ? (
    <Button size="sm" data-testid="btn-audit-verify" onClick={onVerify} disabled={busy}>
      {busy ? 'Verifying…' : 'Verify again'}
    </Button>
  ) : undefined
  if (verification.ok) {
    return (
      <Banner tone="success" testId="audit-chain-banner" title="Chain verified ✓" action={action}>
        <span data-testid="audit-chain-status" data-ok="true">
          {verification.rows === 0
            ? 'No audit entries yet.'
            : `${verification.rows} entries, #${verification.firstId}–#${verification.headId}, unbroken. Head hash ${shortHash(verification.headHash)}`}
          {verification.prunedRows > 0 && ` · ${verification.prunedRows} entries removed by recorded retention`}
        </span>
      </Banner>
    )
  }
  const first = verification.firstBreak
  return (
    <Banner tone="danger" testId="audit-chain-banner" title={`Chain broken at row ${first?.rowId ?? '?'}`} action={action}>
      <div data-testid="audit-chain-status" data-ok="false">
        <p>{first?.message ?? 'The audit log could not be verified.'}</p>
        {verification.issues.length > 1 && (
          <ul className="mt-1 list-disc pl-5 text-detail">
            {verification.issues.slice(1, 6).map((i) => (
              <li key={`${i.rowId}-${i.kind}`}>{i.message}</li>
            ))}
            {verification.issues.length > 6 && <li>… and {verification.issues.length - 6} more</li>}
          </ul>
        )}
        <p className="mt-1 text-detail text-muted">
          Someone changed the company file outside Total, or restored an older copy over a newer one. Keep this file and an older
          backup for your auditor.
        </p>
      </div>
    </Banner>
  )
}
