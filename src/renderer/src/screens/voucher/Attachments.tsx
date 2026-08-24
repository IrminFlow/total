import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Attachment } from '../../lib/client'
import { useToasts } from '../../state/stores'
import { Button, Panel } from '../../components/ui'
import { ATTACHMENT_LIMIT_HINT, formatBytes } from '@shared/attachments'

/**
 * The bill, kept with the entry.
 *
 * "Where is the physical bill" is asked every day, and until now the app had no answer at all —
 * the paper was in a folder in a cupboard, and the entry said nothing about which one.
 *
 * The file is COPIED into the company folder rather than pointed at (see src/shared/
 * attachments.ts for the reasoning), which costs disk. The limit is therefore stated up front,
 * under the button, rather than discovered as a failure after a slow copy of a 40 MB photograph.
 */
export function Attachments({ voucherId }: { voucherId: number }): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const { data: rows } = useQuery({
    queryKey: ['attachments', voucherId],
    queryFn: () => api.attachments.list(voucherId)
  })

  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['attachments', voucherId] })

  const attach = async (): Promise<void> => {
    setBusy(true)
    try {
      const added = await api.attachments.add(voucherId)
      if (!added) return // the picker was cancelled
      refresh()
      toast.push('success', `${added.fileName} attached`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (row: Attachment): Promise<void> => {
    try {
      await api.attachments.remove(row.id)
      refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const open = async (row: Attachment): Promise<void> => {
    try {
      await api.attachments.open(row.id)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const list = rows ?? []

  return (
    <Panel className="mt-4 p-4" data-testid="voucher-attachments">
      <div className="flex items-center justify-between gap-4">
        <p className="text-detail font-medium">
          The bill{' '}
          {list.length > 0 && (
            <span data-testid="badge-attachment-count" className="ml-1 rounded-md bg-panel2 px-1.5 py-0.5 num text-caption text-muted">
              {list.length}
            </span>
          )}
        </p>
        <Button variant="ghost" data-testid="btn-attach-file" disabled={busy} onClick={() => void attach()}>
          {busy ? 'Copying…' : 'Attach a file…'}
        </Button>
      </div>

      {list.length === 0 ? (
        <p className="mt-2 text-body-sm text-muted">
          Nothing attached. A scan or photograph of the bill is kept inside this company&rsquo;s folder, so a
          copy of the folder carries it. {ATTACHMENT_LIMIT_HINT}.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5">
          {list.map((row) => (
            <li key={row.id} className="flex items-center gap-3 text-body-sm" data-testid={`attachment-${row.id}`}>
              <button
                className={`min-w-0 flex-1 truncate text-left ${row.missing ? 'text-cr line-through' : 'text-blue hover:underline'}`}
                onClick={() => void open(row)}
                disabled={row.missing}
                title={row.missing ? 'This file is no longer in the company folder' : 'Open'}
              >
                {row.fileName}
              </button>
              <span className="num shrink-0 text-caption text-muted">{formatBytes(row.byteSize)}</span>
              <span className="shrink-0 text-caption text-muted">
                {row.addedBy ? `by ${row.addedBy}` : ''} {row.addedAt.slice(0, 10)}
              </span>
              {row.missing && (
                // Never quietly dropped from the list: the app losing evidence has to be visible,
                // and the row is the only record that the bill was ever here.
                <span data-testid="attachment-missing" className="shrink-0 rounded-md bg-cr/15 px-1.5 py-0.5 text-caption text-cr">
                  file missing
                </span>
              )}
              <button
                data-testid={`btn-attachment-remove-${row.id}`}
                className="shrink-0 text-caption text-muted hover:text-cr"
                onClick={() => void remove(row)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
