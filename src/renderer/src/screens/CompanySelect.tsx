import { useState } from 'react'
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type IntegrityResult } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, Field, Modal, ScrollList, Select, TextInput, useKeyNav } from '../components/ui'
import { SupportLink } from '../components/SupportLink'
import { GST_STATES } from '@shared/gst/states'
import { gstinErrorMessage } from '../lib/gstinError'
import { fyOf, todayISO } from '@shared/dates'
import { DEMO_TRADE_PROFILES, type DemoTrade } from '@shared/demo'
import type { CompanyCreateInput } from '@shared/schemas'
import type { CompanyInfo, CompanySummary } from '@shared/domain'

export function CompanySelect(): React.JSX.Element {
  const queryClient = useQueryClient()
  const { data: registry } = useQuery({ queryKey: ['registry'], queryFn: api.company.list })
  const { setCompany } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [demoLoading, setDemoLoading] = useState(false)
  const [picking, setPicking] = useState(false)
  const [deleting, setDeleting] = useState<CompanySummary | null>(null)
  const [integrityIssue, setIntegrityIssue] = useState<{
    pending: { slug: string; info: CompanyInfo; locked: boolean }
    integrity: IntegrityResult
  } | null>(null)

  const companies = registry?.companies ?? []

  const open = async (slug: string): Promise<void> => {
    try {
      const r = await api.company.open(slug)
      // Every cached answer belongs to the company that is being left. Query keys are not
      // company-scoped (['features'], ['ledgers'], …), so without this the next company is
      // shown the last one's data until something happens to invalidate it — and 'features'
      // never was, so a company opened after the services sample kept ITS sidebar, stock
      // screens and all, hidden. Nobody saw it while every company had identical F11 defaults.
      queryClient.clear()
      // Somebody else has these books open right now, or left them open when their machine died
      // (roadmap #259). Said out loud and not enforced: the lock file is evidence about another
      // machine, and the user is the only one who can tell a live session from a stale claim.
      if (r.openElsewhere) toast.push('error', r.openElsewhere)
      if (!r.integrity.ok) {
        setIntegrityIssue({ pending: { slug: r.slug, info: r.info, locked: r.locked }, integrity: r.integrity })
        return
      }
      setCompany(r.slug, r.info, r.locked)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const createSample = (trade: DemoTrade): void => {
    void (async () => {
      setDemoLoading(true)
      try {
        const r = await api.company.createDemo(trade)
        await queryClient.invalidateQueries({ queryKey: ['registry'] })
        setPicking(false)
        await open(r.slug)
      } catch (err) {
        toast.push('error', (err as Error).message)
      } finally {
        setDemoLoading(false)
      }
    })()
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
      className="drag-region flex h-full items-center justify-center px-10 py-10"
    >
      {/* The first screen anyone sees, so it is composed rather than centred-and-hoped-for: a
          masthead on the left that says what this program is, and one panel on the right that
          holds everything you can do about it. The surround stays draggable (frameless window);
          the content does not, or the rows below would not take a click. */}
      <div
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className="grid w-full max-w-4xl grid-cols-1 items-center gap-10 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]"
      >
        <div>
          <h1 className="font-serif text-display font-semibold tracking-tight">Total</h1>
          <div className="mt-3 h-0.5 w-14 bg-accentbar" />
          <p className="mt-4 text-detail text-muted">Your books, on this Mac, nowhere else.</p>
          <p className="num mt-1 text-caption text-muted">~/Documents/total</p>
          <div className="mt-8">
            <SupportLink />
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-line bg-panel panel-shadow">
          <div className="flex items-baseline justify-between border-b border-line bg-panel2 px-5 py-2.5">
            <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">Companies</p>
            {companies.length > 0 && (
              <p className="num text-hint text-muted">
                {companies.length} on this Mac · ↑↓ then ↵
              </p>
            )}
          </div>

          {companies.length === 0 ? (
            // An empty screen is an invitation to act, not a grey sentence in a white box.
            <p className="px-5 py-6 text-body-sm text-muted">
              No books here yet. Start a set below, or open the sample company and look around first.
            </p>
          ) : (
            <ScrollList maxH="42vh">
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
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="row-action text-hint text-muted">
                      Enter ↵
                    </span>
                    <button
                      type="button"
                      data-testid={`btn-company-delete-${c.slug}`}
                      title={`Delete ${c.name}`}
                      className="row-action rounded-md px-1.5 py-0.5 text-detail text-muted hover:border hover:border-cr/50 hover:text-cr focus-visible:text-cr focus-visible:outline-2 focus-visible:outline-cr/60"
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
          )}

          {/* One idiom, three instances — the three ways in used to be a filled button, a link
              and a second link sitting in a row, which read as three unrelated things. They are
              the same kind of choice, so they get the same shape; only the accent says which one
              most people want. */}
          <StartRow
            testId="btn-company-create"
            title="Create company"
            sub="Name, state, GSTIN — books open in seconds"
            accent
            onClick={() => setCreating(true)}
          />
          <StartRow
            title="Import encrypted backup…"
            sub="Restore a .totalbak file from another Mac"
            onClick={() => setImporting(true)}
          />
          <StartRow
            testId="btn-company-demo"
            title={demoLoading ? 'Setting up sample data…' : 'Explore with sample data'}
            sub={
              picking
                ? 'Pick the one that looks most like your books'
                : 'A ready-made set of books — vouchers, returns and reports'
            }
            disabled={demoLoading}
            onClick={() => setPicking((p) => !p)}
          />
          {/* The trade is asked at the point the sample is made, not in a dialog on top of it:
              three lines is a smaller interruption than a modal, and the answer is needed
              exactly once. A distributor should not have to learn what a bill of materials is
              before seeing their own kind of invoice. */}
          {picking && (
            <div data-testid="demo-trade-picker" className="border-t border-line bg-panel2/40">
              {DEMO_TRADE_PROFILES.map((p) => (
                <button
                  key={p.trade}
                  type="button"
                  data-testid={`btn-demo-trade-${p.trade}`}
                  disabled={demoLoading}
                  onClick={() => createSample(p.trade)}
                  className="flex w-full items-center justify-between gap-4 border-t border-line/50 px-5 py-2 pl-8 text-left transition-colors first:border-t-0 hover:bg-panel2 disabled:opacity-60"
                >
                  <span>
                    <span className="block text-detail font-medium">{p.label}</span>
                    <span className="block text-caption text-muted">{p.blurb}</span>
                  </span>
                  <span className="text-accent text-detail">→</span>
                </button>
              ))}
            </div>
          )}
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
          onGoBackups={() => {
            // Restoring a backup needs the company open — open it and land on Settings → Backups.
            const { pending } = integrityIssue
            setIntegrityIssue(null)
            setCompany(pending.slug, pending.info, pending.locked)
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

/** One of the three ways into the app: a full-width ruled row, the same shape each time. */
function StartRow({
  title,
  sub,
  onClick,
  accent = false,
  disabled = false,
  testId
}: {
  title: string
  sub: string
  onClick: () => void
  accent?: boolean
  disabled?: boolean
  testId?: string
}): React.JSX.Element {
  // Deliberately not accent-filled: on this screen the accent bar means "the row you are on", and
  // a second accent block beside it would blunt the one signal the keyboard depends on. Weight
  // and the arrow carry the emphasis instead.
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center justify-between gap-4 border-t border-line bg-panel2/60 px-5 py-3 text-left transition-colors hover:bg-panel2 disabled:opacity-60"
    >
      <span>
        <span className={`block text-lead ${accent ? 'font-semibold' : 'font-medium'}`}>{title}</span>
        <span className="mt-0.5 block text-caption text-muted">{sub}</span>
      </span>
      <span className={accent ? 'text-accent' : 'text-muted'}>→</span>
    </button>
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
  /**
   * The warning shown when this machine already has these books (roadmap #251).
   *
   * Importing a second copy is sometimes exactly what someone wants — a snapshot of last year to
   * look at beside this one — so this asks rather than refuses. What it must never do is happen
   * silently: the user works in the copy for a week while their real books sit in the other one,
   * and the two can never be recombined.
   */
  const [duplicate, setDuplicate] = useState<string | null>(null)

  const doImport = async (allowDuplicate = false): Promise<void> => {
    if (passphrase.length < 8) {
      toast.push('error', 'Passphrase must be at least 8 characters')
      return
    }
    setBusy(true)
    try {
      const result = await api.backups.importEncrypted(passphrase, allowDuplicate)
      if (!result) {
        setBusy(false)
        return // dialog cancelled
      }
      if (result.needsConfirmation) {
        setDuplicate(result.warning ?? 'These books are already on this machine.')
        setBusy(false)
        return
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
        {duplicate && (
          <div
            className="rounded-md border border-cr/40 bg-cr/5 px-3.5 py-2.5 text-body-sm text-cr"
            data-testid="import-duplicate-warning"
          >
            {duplicate}
          </div>
        )}
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
          <Button
            variant={duplicate ? 'danger' : 'primary'}
            data-testid="btn-import-confirm"
            onClick={() => void doImport(duplicate !== null)}
            disabled={busy}
          >
            {busy ? 'Importing…' : duplicate ? 'Import a second copy anyway' : 'Choose file & import'}
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
  const [busy, setBusy] = useState(false)
  const matches = confirmName.trim() === company.name

  const doDelete = async (): Promise<void> => {
    if (!matches) return
    setBusy(true)
    try {
      await api.company.remove(company.slug, confirmName.trim(), needsPin ? pin : undefined)
      onDeleted()
    } catch (err) {
      const message = (err as Error).message
      if (message.includes('protected') && message.includes('PIN')) {
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
              if (e.key === 'Enter' && !needsPin) void doDelete()
            }}
            placeholder={company.name}
          />
        </Field>
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
            disabled={!matches || busy || (needsPin && !pin)}
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
  const [filing, setFiling] = useState<CompanyCreateInput['gstFilingFrequency']>('monthly')
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
        gstFilingFrequency: filing,
        // Not asked at creation: this form is deliberately the shortest path into the books.
        // Declared in Company details, where the obligations it implies are shown next to it.
        turnoverBand: null,
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
        {gstin.trim() && regType === 'regular' && (
          <Field
            label="Filing frequency"
            hint="QRMP is open to turnover up to Rs 5 crore: quarterly returns, tax still paid monthly"
          >
            <Select
              data-testid="select-filing-frequency"
              value={filing}
              onChange={(e) => setFiling(e.target.value as CompanyCreateInput['gstFilingFrequency'])}
            >
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly (QRMP)</option>
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
