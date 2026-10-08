// WP 6.4 — Settings › Backups: the attachments policy (size cap, allowed file types). Owners edit;
// attachments themselves are added from the record (voucher header, Day book, ledger / item).
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ATTACHMENT_MAX_BYTES_RANGE, DEFAULT_ALLOWED_EXTENSIONS, formatBytes } from '@shared/attachments'
import { attachmentsApi } from '../../lib/workspaceClient'
import { useSession, useToasts } from '../../state/stores'
import { Button, Checkbox, Field, Panel, SectionTitle, TextInput } from '../../components/ui'

const MB = 1024 * 1024

export function AttachmentsSettings(): React.JSX.Element {
  const { user } = useSession()
  const canEdit = user == null || user.role === 'owner'
  const toast = useToasts()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['attachmentsConfig'], queryFn: attachmentsApi.config })
  const [mb, setMb] = useState('')
  const [exts, setExts] = useState<string[]>([])
  useEffect(() => {
    if (!data) return
    setMb(String(Math.round(data.maxBytes / MB)))
    setExts(data.allowedExtensions)
  }, [data])
  const save = async (): Promise<void> => {
    const n = Number(mb)
    if (!Number.isInteger(n) || n * MB < ATTACHMENT_MAX_BYTES_RANGE.min || n * MB > ATTACHMENT_MAX_BYTES_RANGE.max) {
      return void toast.push('error', `Size limit: ${ATTACHMENT_MAX_BYTES_RANGE.min / MB}–${ATTACHMENT_MAX_BYTES_RANGE.max / MB} MB`)
    }
    if (exts.length === 0) return void toast.push('error', 'Allow at least one file type')
    try {
      await attachmentsApi.setConfig({ maxBytes: n * MB, allowedExtensions: exts })
      await qc.invalidateQueries({ queryKey: ['attachmentsConfig'] })
      toast.push('success', 'Attachment settings saved')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <div className="mt-section" data-testid="settings-attachments">
      <SectionTitle>Attachments</SectionTitle>
      <Panel className="p-panel">
        <div className="flex flex-col gap-3">
          <p className="text-hint text-muted">
            Files on vouchers, ledgers, items and orders are kept in this company&apos;s folder (one copy per distinct file) and go into every
            backup and encrypted export; a restore brings them back, each checked against its SHA-256.
          </p>
          <div className="w-48">
            <Field label="Largest file (MB)" hint={data ? `now ${formatBytes(data.maxBytes)}` : undefined}>
              <TextInput className="num text-right" value={mb} onChange={(e) => setMb(e.target.value)} disabled={!canEdit} data-testid="input-attachment-max-mb" />
            </Field>
          </div>
          <fieldset className="flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Allowed file types">
            {DEFAULT_ALLOWED_EXTENSIONS.map((x) => (
              <Checkbox
                key={x}
                label={`.${x}`}
                checked={exts.includes(x)}
                disabled={!canEdit}
                onChange={(v) => setExts((cur) => (v ? [...cur, x] : cur.filter((y) => y !== x)))}
                testId={`input-attachment-ext-${x}`}
              />
            ))}
          </fieldset>
          {canEdit && (
            <div>
              <Button onClick={() => void save()} data-testid="btn-attachment-settings-save">
                Save attachment settings
              </Button>
            </div>
          )}
        </div>
      </Panel>
    </div>
  )
}
