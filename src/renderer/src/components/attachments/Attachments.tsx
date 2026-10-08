// WP 6.4 — attachments on a voucher, ledger, stock item or trade document. The renderer never
// sees a path: Add opens the native picker in the main process, Open asks main to hash-check the
// stored file and hand a copy to the system viewer.
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatBytes, type Attachment, type AttachmentTarget } from '@shared/attachments'
import { toDisplayDate } from '@shared/dates'
import { attachmentsApi } from '../../lib/workspaceClient'
import { confirmDialog } from '../../lib/dialogs'
import { useToasts } from '../../state/stores'
import { Button, Modal } from '../ui'
import { DataTable, defineColumns } from '../table'

export const attachmentsKey = (t: AttachmentTarget): unknown[] => ['attachments', t.entity, t.entityId]

export function useAttachments(t: AttachmentTarget | null) {
  return useQuery({
    queryKey: t ? attachmentsKey(t) : ['attachments', 'none'],
    queryFn: () => attachmentsApi.list(t!),
    enabled: !!t
  })
}

const COLUMNS = defineColumns<Attachment>([
  { id: 'name', header: 'File', kind: 'text', value: (a) => a.fileName, minWidth: 200, hideable: false },
  { id: 'size', header: 'Size', kind: 'number', value: (a) => a.size, text: (a) => formatBytes(a.size), width: 90 },
  { id: 'added', header: 'Added', kind: 'date', value: (a) => a.addedAt.slice(0, 10), text: (a) => toDisplayDate(a.addedAt.slice(0, 10)), width: 110 },
  { id: 'by', header: 'By', kind: 'text', value: (a) => (a.addedBy ?? '').replace(/^os:/, ''), width: 110, className: 'text-muted' },
  { id: 'sha', header: 'SHA-256', kind: 'text', value: (a) => a.sha256, text: (a) => `${a.sha256.slice(0, 12)}…`, width: 130, className: 'num text-muted', defaultHidden: true }
])

/** The attachment list for one record, with Add / Open / Remove. */
export function AttachmentList({ target, readOnly = false }: { target: AttachmentTarget; readOnly?: boolean }): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const { data, isLoading } = useAttachments(target)
  const [busy, setBusy] = useState(false)
  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: attachmentsKey(target) })
    await qc.invalidateQueries({ queryKey: ['attachmentCounts', target.entity] })
  }
  const add = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await attachmentsApi.add(target)
      await refresh()
      if (r.added.length) toast.push('success', r.added.length === 1 ? `Attached ${r.added[0]!.fileName}` : `Attached ${r.added.length} files`)
      for (const x of r.refused) toast.push('error', `${x.fileName}: ${x.reason}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const open = (a: Attachment): void => {
    attachmentsApi.open(a.id).catch((err: Error) => toast.push('error', err.message))
  }
  const remove = async (a: Attachment): Promise<void> => {
    if (!(await confirmDialog({ title: 'Remove attachment', message: `Remove ${a.fileName}? Backups taken before now keep a copy.`, confirmLabel: 'Remove', danger: true }))) return
    try {
      await attachmentsApi.remove(a.id)
      await refresh()
      toast.push('success', `Removed ${a.fileName}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <div className="flex flex-col gap-2" data-testid="attachment-list">
      <DataTable
        testId="attachments"
        ariaLabel="Attachments"
        columns={COLUMNS}
        rows={data ?? []}
        loading={isLoading}
        rowKey={(a) => a.id}
        rowAttrs={(a) => ({ 'data-sha': a.sha256 })}
        onRowActivate={open}
        empty={{ title: 'No files attached', hint: readOnly ? undefined : 'Bills, scans, KYC — PDF, images, spreadsheets, documents' }}
        maxHeight="40vh"
        toolbarFeatures={{ groupBy: false, density: false, views: false, export: false, quickFilter: false }}
        trailing={(a) => (
          <span className="flex items-center justify-end gap-3">
            <button type="button" className="text-hint text-blue hover:underline" onClick={() => open(a)} data-testid="btn-attachment-open">
              Open
            </button>
            {!readOnly && (
              <button type="button" className="text-hint text-cr hover:underline" onClick={() => void remove(a)} data-testid="btn-attachment-remove">
                Remove
              </button>
            )}
          </span>
        )}
        trailingWidth={readOnly ? 56 : 116}
        toolbarEnd={
          readOnly ? undefined : (
            <Button size="sm" variant="primary" onClick={() => void add()} loading={busy} data-testid="btn-attachment-add">
              Add files…
            </Button>
          )
        }
      />
    </div>
  )
}

export function AttachmentsModal({ target, title, onClose }: { target: AttachmentTarget; title: string; onClose: () => void }): React.JSX.Element {
  return (
    <Modal title={title} onClose={onClose} wide>
      <AttachmentList target={target} />
      <div className="mt-3 flex justify-end">
        <Button onClick={onClose} data-testid="btn-attachments-done">
          Done
        </Button>
      </div>
    </Modal>
  )
}

/** "Files · 2" — a header button that opens the record's attachments. */
export function AttachmentsButton({ target, title }: { target: AttachmentTarget; title: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { data } = useAttachments(target)
  const n = data?.length ?? 0
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} data-testid="btn-attachments" title="Attached files">
        Files{n > 0 ? ` · ${n}` : ''}
      </Button>
      {open && <AttachmentsModal target={target} title={title} onClose={() => setOpen(false)} />}
    </>
  )
}
