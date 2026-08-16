import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type IntegrityResult } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, Field, Modal, Select, TextInput, useKeyNav } from '../components/ui'
import { GST_STATES } from '@shared/gst/states'
import { validateGstin } from '@shared/gst/validate'
import { fyOf, todayISO } from '@shared/dates'
import type { CompanyCreateInput } from '@shared/schemas'
import type { CompanyInfo, CompanySummary } from '@shared/domain'

export function CompanySelect(): React.JSX.Element {
  const queryClient = useQueryClient()
  const { data: registry } = useQuery({ queryKey: ['registry'], queryFn: api.company.list })
  const { setCompany } = useSession()
  const toast = useToasts()
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [demoLoading, setDemoLoading] = useState(false)
  const [deleting, setDeleting] = useState<CompanySummary | null>(null)
  const [integrityIssue, setIntegrityIssue] = useState<{
    pending: { slug: string; info: CompanyInfo; locked: boolean }
    integrity: IntegrityResult
  } | null>(null)

  const companies = registry?.companies ?? []

  const open = async (slug: string): Promise<void> => {
    try {
      const r = await api.company.open(slug)
      if (!r.integrity.ok) {
        setIntegrityIssue({ pending: { slug: r.slug, info: r.info, locked: r.locked }, integrity: r.integrity })
        return
      }
      setCompany(r.slug, r.info, r.locked)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const { active, setActive } = useKeyNav(companies.length, (i) => {
    const c = companies[i]
    if (c) void open(c.slug)
  })

  return (
    <div className="drag-region flex h-full flex-col items-center justify-center">
      <div className="w-full max-w-lg">
        <h1 className="text-center font-serif text-[34px] font-semibold tracking-tight">Total</h1>
        <p className="mt-1 mb-8 text-center text-[13px] text-muted">
          Your books, on this Mac, nowhere else · ~/Documents/total
        </p>

        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          {companies.length === 0 && (
            <p className="px-6 py-10 text-center text-[13.5px] text-muted">
              No companies yet. Create your first — books open in seconds.
            </p>
          )}
          {companies.map((c, i) => (
            <div
              key={c.slug}
              data-active={i === active}
              className="kbar-row group flex cursor-pointer items-center justify-between border-b border-line/50 px-5 py-3.5 last:border-b-0"
              onMouseEnter={() => setActive(i)}
              onClick={() => void open(c.slug)}
            >
              <div>
                <p className="text-[14.5px] font-medium">{c.name}</p>
                <p className="num mt-0.5 text-[11px] text-muted">
                  {GST_STATES[c.stateCode] ?? c.stateCode}
                  {c.gstin ? ` · ${c.gstin}` : ' · Unregistered'}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[11.5px] text-muted">Enter ↵</span>
                <button
                  type="button"
                  title={`Delete ${c.name}`}
                  className="rounded px-1.5 py-0.5 text-[13px] text-muted opacity-0 transition-opacity hover:border hover:border-cr/50 hover:text-cr group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation()
                    setDeleting(c)
                  }}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex justify-center gap-2">
          <Button variant="primary" onClick={() => setCreating(true)}>
            Create company
          </Button>
          <Button variant="ghost" onClick={() => setImporting(true)}>
            Import encrypted backup…
          </Button>
          <Button
            variant="ghost"
            disabled={demoLoading}
            onClick={async () => {
              setDemoLoading(true)
              try {
                const r = await api.company.createDemo()
                await queryClient.invalidateQueries({ queryKey: ['registry'] })
                await open(r.slug)
              } catch (err) {
                toast.push('error', (err as Error).message)
              } finally {
                setDemoLoading(false)
              }
            }}
          >
            {demoLoading ? 'Setting up sample data…' : 'Explore with sample data'}
          </Button>
        </div>
      </div>

      {deleting && (
        <DeleteCompanyModal
          company={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={async () => {
            setDeleting(null)
            await queryClient.invalidateQueries({ queryKey: ['registry'] })
            toast.push('success', 'Company deleted')
          }}
        />
      )}

      {creating && (
        <CreateCompanyModal
          onClose={() => setCreating(false)}
          onCreated={async (slug) => {
            setCreating(false)
            await queryClient.invalidateQueries({ queryKey: ['registry'] })
            await open(slug)
          }}
        />
      )}

      {importing && (
        <ImportBackupModal
          onClose={() => setImporting(false)}
          onImported={async (slug) => {
            setImporting(false)
            await queryClient.invalidateQueries({ queryKey: ['registry'] })
            await open(slug)
          }}
        />
      )}

      {integrityIssue && (
        <IntegrityIssueModal
          integrity={integrityIssue.integrity}
          onOpenAnyway={() => {
            const { pending } = integrityIssue
            setIntegrityIssue(null)
            setCompany(pending.slug, pending.info, pending.locked)
          }}
          onCancel={async () => {
            setIntegrityIssue(null)
            try {
              await api.company.close()
            } catch (err) {
              toast.push('error', (err as Error).message)
            }
          }}
        />
      )}
    </div>
  )
}

function IntegrityIssueModal({
  integrity,
  onOpenAnyway,
  onCancel
}: {
  integrity: IntegrityResult
  onOpenAnyway: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <Modal title="Database check found problems" onClose={onCancel}>
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-muted">
          This company's database failed an integrity check. You can open it anyway, or cancel and restore an
          earlier backup.
        </p>
        <ul className="flex flex-col gap-1 text-[13px]">
          {integrity.quickCheck !== 'ok' && (
            <li className="rounded-md border border-line bg-canvas px-3 py-2">
              <span className="text-muted">quick_check:</span> <span className="num">{integrity.quickCheck}</span>
            </li>
          )}
          {integrity.unbalancedVoucherIds.length > 0 && (
            <li className="rounded-md border border-line bg-canvas px-3 py-2">
              <span className="text-muted">Unbalanced vouchers:</span>{' '}
              <span className="num">{integrity.unbalancedVoucherIds.join(', ')}</span>
            </li>
          )}
        </ul>
        <div className="flex justify-end gap-2">
          {/* TODO(task-1.10): navigate to Settings → Backups */}
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="danger" onClick={onOpenAnyway}>
            Open anyway
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function ImportBackupModal({
  onClose,
  onImported
}: {
  onClose: () => void
  onImported: (slug: string) => void
}): React.JSX.Element {
  const toast = useToasts()
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)

  const doImport = async (): Promise<void> => {
    if (passphrase.length < 8) {
      toast.push('error', 'Passphrase must be at least 8 characters')
      return
    }
    setBusy(true)
    try {
      const result = await api.backups.importEncrypted(passphrase)
      if (!result) {
        setBusy(false)
        return // dialog cancelled
      }
      toast.push('success', `${result.name} imported`)
      onImported(result.slug)
    } catch (err) {
      toast.push('error', (err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title="Import encrypted backup" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-muted">
          Choose a <span className="num">.totalbak</span> file and enter the passphrase it was exported with.
        </p>
        <Field label="Passphrase">
          <TextInput
            autoFocus
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doImport()
            }}
            placeholder="At least 8 characters"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void doImport()} disabled={busy}>
            {busy ? 'Importing…' : 'Choose file & import'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function DeleteCompanyModal({
  company,
  onClose,
  onDeleted
}: {
  company: CompanySummary
  onClose: () => void
  onDeleted: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const [confirmName, setConfirmName] = useState('')
  const [busy, setBusy] = useState(false)
  const matches = confirmName.trim() === company.name

  const doDelete = async (): Promise<void> => {
    if (!matches) return
    setBusy(true)
    try {
      await api.company.remove(company.slug, confirmName.trim())
      onDeleted()
    } catch (err) {
      toast.push('error', (err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title={`Delete ${company.name}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-muted">
          This permanently deletes <span className="font-medium text-ink">{company.name}</span> and every voucher,
          ledger and backup stored for it. This cannot be undone.
        </p>
        <Field label={`Type "${company.name}" to confirm`}>
          <TextInput
            autoFocus
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doDelete()
            }}
            placeholder={company.name}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void doDelete()} disabled={!matches || busy}>
            {busy ? 'Deleting…' : 'Delete company'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function CreateCompanyModal({ onClose, onCreated }: { onClose: () => void; onCreated: (slug: string) => void }): React.JSX.Element {
  const toast = useToasts()
  const [name, setName] = useState('')
  const [stateCode, setStateCode] = useState('27')
  const [gstin, setGstin] = useState('')
  const [regType, setRegType] = useState<CompanyCreateInput['gstRegistrationType']>('regular')
  const [address, setAddress] = useState('')
  const [booksFrom, setBooksFrom] = useState(fyOf(todayISO()).startYear)

  const gstinCheck = gstin.trim() ? validateGstin(gstin) : null
  const gstinError =
    gstinCheck && !gstinCheck.valid
      ? { length: 'A GSTIN has 15 characters', format: 'That doesn’t look like a GSTIN', state_code: 'Unknown state code', checksum: 'Check digit doesn’t match — one character is off' }[gstinCheck.error!]
      : gstinCheck?.valid && gstinCheck.stateCode !== stateCode
        ? `GSTIN says ${GST_STATES[gstinCheck.stateCode!] ?? gstinCheck.stateCode} but the state above differs`
        : null

  const save = async (): Promise<void> => {
    try {
      const input: CompanyCreateInput = {
        name: name.trim(),
        stateCode,
        gstin: gstin.trim() ? gstin.trim().toUpperCase() : null,
        gstRegistrationType: gstin.trim() ? regType : 'unregistered',
        address,
        booksFrom,
        email: null,
        phone: null,
        pan: null,
        tan: null
      }
      if (!input.name) {
        toast.push('error', 'Company name is required')
        return
      }
      if (gstinError) {
        toast.push('error', gstinError)
        return
      }
      const r = await api.company.create(input)
      toast.push('success', `${input.name} created`)
      onCreated(r.slug)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="Create company" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Field label="Company name">
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Sharma Traders" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="State">
            <Select value={stateCode} onChange={(e) => setStateCode(e.target.value)}>
              {Object.entries(GST_STATES).map(([code, label]) => (
                <option key={code} value={code}>
                  {code} — {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Books begin (FY)">
            <Select value={booksFrom} onChange={(e) => setBooksFrom(Number(e.target.value))}>
              {Array.from({ length: 6 }, (_, i) => fyOf(todayISO()).startYear - i).map((y) => (
                <option key={y} value={y}>
                  1 Apr {y}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="GSTIN" hint="Leave empty if not GST-registered" error={gstinError}>
          <TextInput value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} placeholder="27AAPFU0939F1ZV" className="num" />
        </Field>
        {gstin.trim() && (
          <Field label="Registration type">
            <Select value={regType} onChange={(e) => setRegType(e.target.value as CompanyCreateInput['gstRegistrationType'])}>
              <option value="regular">Regular</option>
              <option value="composition">Composition</option>
            </Select>
          </Field>
        )}
        <Field label="Address">
          <TextInput value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, city, PIN" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Create &amp; open
          </Button>
        </div>
      </div>
    </Modal>
  )
}
