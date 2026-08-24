/**
 * What a restore would change, before it changes it (roadmap #246).
 *
 * The count of vouchers that would be lost answers "how bad"; it does not answer "what". A
 * restore is a one-way door for everything entered since, and the two questions people ask on the
 * way through it are which entries disappear and which deletions come back. Both are read out of
 * the backup and the live books side by side — a backup file is the only authority on what is in
 * it.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { formatPaise } from '@shared/money'

export function RestoreChanges({ file }: { file: string }): React.JSX.Element {
  const { data } = useQuery({ queryKey: ['restorePreview', file], queryFn: () => api.backups.preview(file) })

  if (!data) return <p className="mt-3 text-hint text-muted">Comparing the backup with these books…</p>
  if (data.problem) {
    return (
      <div className="mt-3 rounded-md border border-cr/40 bg-cr/5 px-3.5 py-2.5 text-body-sm text-cr">
        {data.problem}
      </div>
    )
  }

  return (
    <div className="mt-3" data-testid="restore-preview">
      <table className="ledger-table">
        <thead>
          <tr>
            <th scope="col">What</th>
            <th scope="col" className="r w-28">Now</th>
            <th scope="col" className="r w-28">After</th>
          </tr>
        </thead>
        <tbody>
          {data.changes.map((change) => (
            <tr key={change.what}>
              <td>{change.what}</td>
              <td className="num r">{change.now}</td>
              <td className={`num r ${change.loses ? 'text-cr' : 'text-muted'}`}>{change.after}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.vouchersReturned > 0 && (
        <p className="mt-2 text-hint text-muted" data-testid="restore-returned">
          {data.vouchersReturned.toLocaleString('en-IN')} voucher
          {data.vouchersReturned === 1 ? '' : 's'} deleted since this backup would come back.
        </p>
      )}

      {data.sample.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-hint text-muted">
            Entries that would have to be typed again{data.vouchersLost > data.sample.length ? ` (first ${data.sample.length} of ${data.vouchersLost})` : ''}:
          </p>
          <ul className="flex flex-col gap-0.5" data-testid="restore-sample">
            {data.sample.map((v) => (
              <li key={`${v.date}-${v.type}-${v.number}`} className="num text-hint text-ink">
                {v.date} · {v.type} {v.number} · {formatPaise(v.amount)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
