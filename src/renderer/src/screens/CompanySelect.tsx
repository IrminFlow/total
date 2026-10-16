import { useState } from 'react'
import type { UiSettings } from '@shared/simple/uiMode'
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, IpcError, type IntegrityResult } from '../lib/client'
import { PassphrasePrompt } from '../simple/PassphrasePrompt'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, Field, Modal, ScrollList, Select, TextInput, useKeyNav } from '../components/ui'
import { SupportLink } from '../components/SupportLink'
import { TotalLogo } from '../components/TotalLogo'
import { GST_STATES, GST_STATE_LIST } from '@shared/gst/states'
import { gstinErrorMessage } from '../lib/gstinError'
import { fyOf, todayISO } from '@shared/dates'
import type { CompanyCreateInput } from '@shared/schemas'
import type { CompanyInfo, CompanySummary } from '@shared/domain'
import type { SimpleSetupInput } from '@shared/simple/setup'
import { SetupWizard } from '../simple/SetupWizard'
import { markTourPending } from '../help/tour'
import { useT } from '../lib/i18n'
import { dataFolder } from '../lib/platform'
import { errorEntry } from '@shared/errors'

export function CompanySelect(): React.JSX.Element {
  const queryClient = useQueryClient()
  const { data: registry } = useQuery({ queryKey: ['registry'], queryFn: api.company.list })
  const { setCompany } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [demoLoading, setDemoLoading] = useState(false)
  // WP 8.3: the setup wizard — opened from "Set up a new business", and on first run (no
  // companies yet) it IS the company-select screen. The accountant ways in stay reachable here.
  const [wizard, setWizard] = useState(false)
  const t = useT()
  const [deleting, setDeleting] = useState<CompanySummary | null>(null)
  const [integrityIssue, setIntegrityIssue] = useState<{
    pending: { slug: string; info: CompanyInfo; locked: boolean; ui: UiSettings }
    integrity: IntegrityResult
  } | null>(null)

  const companies = registry?.companies ?? []
  const showWizard = wizard || (registry != null && companies.length === 0 && !creating && !importing)

  // WP 7.2: a business locked with a passphrase asks for it before it opens.
  const [askPassphrase, setAskPassphrase] = useState<{ slug: string; name: string; notice?: string } | null>(null)
  // "Remember on this computer": the businesses that open here without their passphrase.
  const { data: remembered } = useQuery({ queryKey: ['company-remembered'], queryFn: api.company.remembered })
  const forgetRemembered = async (slug: string): Promise<void> => {
    try {
      await api.company.forgetRemembered(slug)
      toast.push('success', t('simple.passphrase.forgotten'))
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['company-remembered'] })
    }
  }

  const finishOpen = (r: Awaited<ReturnType<typeof api.company.open>>): void => {
    if (!r.integrity.ok) {
      setIntegrityIssue({ pending: { slug: r.slug, info: r.info, locked: r.locked, ui: r.ui }, integrity: r.integrity })
      return
    }
    setCompany(r.slug, r.info, r.locked, r.ui)
  }

  const open = async (slug: string): Promise<void> => {
    try {
      finishOpen(await api.company.open(slug))
    } catch (err) {
      if (err instanceof IpcError && (err.code === 'passphrase_required' || err.code === 'remembered_key_stale')) {
        const notice = err.code === 'remembered_key_stale' ? t('errors.security.rememberedStale') : undefined
        setAskPassphrase({ slug, name: companies.find((c) => c.slug === slug)?.name ?? slug, notice })
        void queryClient.invalidateQueries({ queryKey: ['company-remembered'] })
        return
      }
      // Upgrade guard: a file from a newer Total, or no safe copy before an upgrade — plain words
      // in the reader's language (both modes; the service's English is the same sentence).
      const plain = err instanceof IpcError && (err.code === 'db_newer_version' || err.code === 'db_upgrade_copy_failed') ? errorEntry(err.code) : null
      toast.push('error', plain ? t(plain.key) : (err as Error).message)
    }
  }

  const createDemo = async (mode?: 'simple'): Promise<void> => {
    setDemoLoading(true)
    try {
      const r = await api.company.createDemo(mode)
      await queryClient.invalidateQueries({ queryKey: ['registry'] })
      setWizard(false)
      await open(r.slug)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setDemoLoading(false)
    }
  }

  const finishSetup = async (input: SimpleSetupInput, opts: { tally: boolean }): Promise<void> => {
    const r = await api.setup.create(input)
    await queryClient.invalidateQueries({ queryKey: ['registry'] })
    setWizard(false)
    // WP 10.3: a company the wizard made in simple mode gets the tour of Home once per user.
    if ((input.mode ?? 'simple') === 'simple') markTourPending(r.slug)
    toast.push('success', t('simple.setup.created', { name: input.name }))
    await open(r.slug)
    if (opts.tally) nav.go({ name: 'import-tally' })
  }

  const { active, setActive } = useKeyNav(companies.length, (i) => {
    const c = companies[i]
    if (c) void open(c.slug)
  })
  const fetching = useIsFetching()

  return (
    <div
      data-screen="company-select"
      data-loading={fetching > 0 ? 'true' : 'false'}
      className="drag-region flex h-full flex-col items-center justify-center"
    >
      {showWizard ? (
        <div className="flex max-h-full w-full justify-center overflow-y-auto px-6 py-10 [-webkit-app-region:no-drag]">
          <SetupWizard
            onFinish={finishSetup}
            onSample={() => void createDemo('simple')}
            onSampleFull={() => void createDemo()}
            onFullForm={() => {
              setWizard(false)
              setCreating(true)
            }}
            onImportBackup={() => {
              setWizard(false)
              setImporting(true)
            }}
            onCancel={companies.length > 0 ? () => setWizard(false) : undefined}
            sampleLoading={demoLoading}
          />
        </div>
      ) : (
      <div className="w-full max-w-lg">
        <TotalLogo size={88} className="mx-auto mb-3" />
        <h1 className="text-center font-serif text-hero font-semibold tracking-tight">Total</h1>
        <p className="mt-1 mb-8 text-center text-detail text-muted">
          Your books, on this computer, nowhere else · {dataFolder}
        </p>

        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          <ScrollList maxH="50vh">
          {companies.length === 0 && (
            <p className="px-6 py-10 text-center text-body text-muted">
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
                <p className="text-lead font-medium">{c.name}</p>
                <p className="num mt-0.5 text-caption text-muted">
                  {GST_STATES[c.stateCode] ?? c.stateCode}
                  {c.gstin ? ` · ${c.gstin}` : ' · Unregistered'}
                </p>
                {remembered?.includes(c.slug) && (
                  <p className="mt-0.5 text-caption text-muted" data-testid={`company-remembered-${c.slug}`}>
                    {t('simple.passphrase.rememberedBadge')} ·{' '}
                    <button
                      type="button"
                      className="underline hover:text-ink focus-visible:outline-2 focus-visible:outline-amber/70"
                      data-testid={`btn-company-forget-${c.slug}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        void forgetRemembered(c.slug)
                      }}
                    >
                      {t('simple.passphrase.forget')}
                    </button>
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-hint text-muted">Enter ↵</span>
                <button
                  type="button"
                  data-testid={`btn-company-delete-${c.slug}`}
                  title={`Delete ${c.name}`}
                  className="rounded px-1.5 py-0.5 text-detail text-muted opacity-0 transition-opacity hover:border hover:border-cr/50 hover:text-cr group-hover:opacity-100 focus-visible:opacity-100 focus-visible:text-cr focus-visible:outline-2 focus-visible:outline-cr/60"
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
          </ScrollList>
        </div>

        <div className="mt-4 flex justify-center gap-2">
          <Button variant="primary" data-testid="btn-company-setup" onClick={() => setWizard(true)}>
            {t('simple.setup.title')}
          </Button>
          <Button variant="ghost" data-testid="btn-company-demo" disabled={demoLoading} onClick={() => void createDemo('simple')}>
            {demoLoading ? t('simple.setup.sampleLoading') : t('simple.setup.sample')}
          </Button>
          <Button variant="ghost" onClick={() => setImporting(true)}>
            Import encrypted backup…
          </Button>
        </div>
        <p className="mt-3 flex justify-center gap-3 text-small text-muted">
          <span>{t('simple.setup.forAccountants')}</span>
          <button type="button" className="underline-offset-2 hover:text-ink hover:underline" data-testid="btn-company-create" onClick={() => setCreating(true)}>
            {t('simple.setup.fullForm')}
          </button>
          <button type="button" className="underline-offset-2 hover:text-ink hover:underline" data-testid="btn-company-demo-full" disabled={demoLoading} onClick={() => void createDemo()}>
            {t('simple.setup.sampleFull')}
          </button>
        </p>

        <div className="mt-8 text-center">
          <SupportLink />
        </div>
      </div>
      )}

      {askPassphrase && (
        <PassphrasePrompt
          name={askPassphrase.name}
          notice={askPassphrase.notice}
          onCancel={() => setAskPassphrase(null)}
          onSubmit={async (passphrase, remember) => {
            const r = await api.company.open(askPassphrase.slug, passphrase, { remember })
            setAskPassphrase(null)
            if (r.remember === 'saved') toast.push('success', t('simple.passphrase.remembered'))
            else if (r.remember === 'pending') toast.push('info', t('simple.passphrase.rememberPending'))
            else if (r.remember === 'unavailable') toast.push('warning', t('errors.security.rememberUnavailable'))
            void queryClient.invalidateQueries({ queryKey: ['company-remembered'] })
            finishOpen(r)
          }}
        />
      )}

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
            setCompany(pending.slug, pending.info, pending.locked, pending.ui)
          }}
          onGoBackups={() => {
            // Restoring a backup needs the company open — open it and land on Settings → Backups.
            const { pending } = integrityIssue
            setIntegrityIssue(null)
            setCompany(pending.slug, pending.info, pending.locked, pending.ui)
            nav.go({ name: 'settings', tab: 'backups' })
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
  onGoBackups,
  onCancel
}: {
  integrity: IntegrityResult
  onOpenAnyway: () => void
  /** Opens the company anyway and lands straight on Settings → Backups to restore from. */
  onGoBackups: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <Modal title="Database check found problems" onClose={onCancel}>
      <div className="flex flex-col gap-4">
        <p className="text-detail text-muted">
          This company's database failed an integrity check. You can open it anyway, or cancel and restore an
          earlier backup.
        </p>
        <ul className="flex flex-col gap-1 text-detail">
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
          <Button onClick={onCancel}>Cancel</Button>
          <Button data-testid="btn-integrity-go-backups" onClick={onGoBackups}>
            Go to Backups
          </Button>
          <Button variant="danger" data-testid="btn-integrity-open-anyway" onClick={onOpenAnyway}>
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
        <p className="text-detail text-muted">
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
  const [pin, setPin] = useState('')
  // Set once the main process refuses the delete because this company has users and no (or the
  // wrong) PIN was supplied — see company:delete / assertDeleteAuthorized. The typed-name confirm
  // above stays visible; this just adds the PIN field the protected path additionally requires.
  const [needsPin, setNeedsPin] = useState(false)
  // WP 7.2 review: a business locked with a passphrase asks for it before its PIN can be checked.
  const [passphrase, setPassphrase] = useState('')
  const [needsPassphrase, setNeedsPassphrase] = useState(false)
  const [busy, setBusy] = useState(false)
  const matches = confirmName.trim() === company.name

  const doDelete = async (): Promise<void> => {
    if (!matches) return
    setBusy(true)
    try {
      await api.company.remove(company.slug, confirmName.trim(), needsPin ? pin : undefined, needsPassphrase ? passphrase : undefined)
      onDeleted()
    } catch (err) {
      const message = (err as Error).message
      const code = err instanceof IpcError ? err.code : undefined
      if (code === 'passphrase_required' || code === 'wrong_passphrase' || code === 'passphrase_throttled') {
        if (needsPassphrase) toast.push('error', message)
        setNeedsPassphrase(true)
        setPassphrase('')
      } else if (message.includes('protected') && message.includes('PIN')) {
        setNeedsPin(true)
        if (pin) toast.push('error', 'Wrong PIN')
      } else {
        toast.push('error', message)
      }
      setBusy(false)
    }
  }

  return (
    <Modal title={`Delete ${company.name}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-detail text-muted">
          This permanently deletes <span className="font-medium text-ink">{company.name}</span> and every voucher,
          ledger and backup stored for it. This cannot be undone.
        </p>
        <Field label={`Type "${company.name}" to confirm`}>
          <TextInput
            autoFocus
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !needsPin && !needsPassphrase) void doDelete()
            }}
            placeholder={company.name}
          />
        </Field>
        {needsPassphrase && (
          <Field label="Passphrase" hint="This business is locked with a passphrase — type it to delete the business">
            <TextInput
              autoFocus
              type="password"
              autoComplete="current-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doDelete()
              }}
              data-testid="input-delete-passphrase"
            />
          </Field>
        )}
        {needsPin && (
          <Field label="Owner PIN" hint="This company has signed-in users — an owner PIN is required to delete it">
            <TextInput
              autoFocus
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doDelete()
              }}
              placeholder="PIN"
            />
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => void doDelete()}
            disabled={!matches || busy || (needsPin && !pin) || (needsPassphrase && !passphrase)}
          >
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

  const gstinError = gstinErrorMessage(gstin, stateCode)

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
          <TextInput autoFocus data-testid="input-company-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sharma Traders" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="State">
            <Select value={stateCode} onChange={(e) => setStateCode(e.target.value)}>
              {GST_STATE_LIST.map(([code, label]) => (
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
          <TextInput value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} placeholder="GSTIN (15 characters)" className="num" data-testid="input-company-gstin" />
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
          <Button variant="primary" data-testid="btn-company-save" onClick={() => void save()}>
            Create &amp; open
          </Button>
        </div>
      </div>
    </Modal>
  )
}
