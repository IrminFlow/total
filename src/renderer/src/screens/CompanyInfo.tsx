import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, Field, Panel, RowAction, SectionTitle, Select, TextInput } from '../components/ui'
import { GST_STATES } from '@shared/gst/states'
import { qrmpEligible, TURNOVER_BANDS, turnoverObligations, type TurnoverBand } from '@shared/gst/turnover'
import { gstinErrorMessage } from '../lib/gstinError'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/
const TAN_RE = /^[A-Z]{4}\d{5}[A-Z]$/

export function CompanyInfoScreen(): React.JSX.Element {
  const { info, slug, setCompany } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const [name, setName] = useState(info?.name ?? '')
  const [stateCode, setStateCode] = useState(info?.stateCode ?? '27')
  const [gstin, setGstin] = useState(info?.gstin ?? '')
  const [regType, setRegType] = useState(info?.gstRegistrationType ?? 'unregistered')
  const [filing, setFiling] = useState(info?.gstFilingFrequency ?? 'monthly')
  const [turnoverBand, setTurnoverBand] = useState<TurnoverBand | ''>(info?.turnoverBand ?? '')
  const [address, setAddress] = useState(info?.address ?? '')
  const [email, setEmail] = useState(info?.email ?? '')
  const [phone, setPhone] = useState(info?.phone ?? '')
  const [pan, setPan] = useState(info?.pan ?? '')
  const [tan, setTan] = useState(info?.tan ?? '')

  // Re-seed the form whenever the saved info changes (company switch, save round-trip,
  // Tally import updating details) so the fields never show a stale company's values.
  useEffect(() => {
    setName(info?.name ?? '')
    setStateCode(info?.stateCode ?? '27')
    setGstin(info?.gstin ?? '')
    setRegType(info?.gstRegistrationType ?? 'unregistered')
    setFiling(info?.gstFilingFrequency ?? 'monthly')
    setTurnoverBand(info?.turnoverBand ?? '')
    setAddress(info?.address ?? '')
    setEmail(info?.email ?? '')
    setPhone(info?.phone ?? '')
    setPan(info?.pan ?? '')
    setTan(info?.tan ?? '')
  }, [info])

  // Guard in-app navigation while the form differs from what's saved.
  const dirty =
    name !== (info?.name ?? '') ||
    stateCode !== (info?.stateCode ?? '27') ||
    gstin !== (info?.gstin ?? '') ||
    regType !== (info?.gstRegistrationType ?? 'unregistered') ||
    filing !== (info?.gstFilingFrequency ?? 'monthly') ||
    turnoverBand !== (info?.turnoverBand ?? '') ||
    address !== (info?.address ?? '') ||
    email !== (info?.email ?? '') ||
    phone !== (info?.phone ?? '') ||
    pan !== (info?.pan ?? '') ||
    tan !== (info?.tan ?? '')
  useUnsavedGuard(dirty)

  // QRMP is capped at Rs 5 crore. Picking it above that produces a calendar of dates the filer
  // does not actually file on, which is worse than not offering it.
  const qrmpAvailable = qrmpEligible(turnoverBand === '' ? null : turnoverBand)

  const gstinError = gstinErrorMessage(gstin, stateCode)
  const panError = pan.trim() && !PAN_RE.test(pan.trim()) ? 'Invalid PAN (e.g. ABCDE1234F)' : null
  const tanError = tan.trim() && !TAN_RE.test(tan.trim()) ? 'Invalid TAN (e.g. ABCD12345E)' : null

  const save = async (): Promise<void> => {
    try {
      if (gstinError) return void toast.push('error', gstinError)
      if (panError) return void toast.push('error', panError)
      if (tanError) return void toast.push('error', tanError)
      const updated = await api.company.updateInfo({
        name: name.trim(),
        stateCode,
        gstin: gstin.trim() ? gstin.trim().toUpperCase() : null,
        gstRegistrationType: gstin.trim() ? (regType === 'unregistered' ? 'regular' : regType) : 'unregistered',
        gstFilingFrequency: filing,
        turnoverBand: turnoverBand === '' ? null : turnoverBand,
        address,
        booksFrom: info?.booksFrom ?? 2025,
        email: email.trim() || null,
        phone: phone.trim() || null,
        pan: pan.trim() ? pan.trim().toUpperCase() : null,
        tan: tan.trim() ? tan.trim().toUpperCase() : null
      })
      if (slug) setCompany(slug, updated)
      toast.push('success', 'Company details saved')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col max-w-[760px]">
      <SectionTitle>Company details</SectionTitle>
      <button
        data-testid="btn-company-info-invoice-layout"
        onClick={() => nav.go({ name: 'settings', tab: 'invoice' })}
        className="mb-4 flex w-full items-center justify-between rounded-lg border-2 border-accent/50 bg-accent/10 px-4 py-3.5 text-left transition-colors hover:border-accent hover:bg-accent/15"
      >
        <span>
          <span className="block text-lead font-semibold">Invoice layout &amp; contents…</span>
          <span className="block text-hint text-muted">Logo, declaration, bank details, QR, barcode column, copies to print</span>
        </span>
        <span className="text-lead text-accent">→</span>
      </button>
      <Panel className="flex flex-col gap-4 p-5">
        <Field label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} />
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
          <Field label="Registration">
            <Select
              data-testid="select-registration-type"
              value={regType}
              onChange={(e) => setRegType(e.target.value as typeof regType)}
              disabled={!gstin.trim()}
            >
              <option value="regular">Regular</option>
              <option value="composition">Composition</option>
              <option value="unregistered">Unregistered</option>
            </Select>
          </Field>
          <Field label="Filing frequency" hint="QRMP: quarterly returns, monthly tax">
            <Select
              data-testid="select-filing-frequency"
              value={filing}
              onChange={(e) => setFiling(e.target.value as typeof filing)}
              disabled={!gstin.trim() || regType !== 'regular'}
            >
              <option value="monthly">Monthly</option>
              {/* Kept selectable when already chosen, so a mis-declared band does not trap the
                  form in an unsaveable state — the obligations panel says it in red instead. */}
              <option value="quarterly" disabled={!qrmpAvailable && filing !== 'quarterly'}>
                Quarterly (QRMP)
              </option>
            </Select>
          </Field>
        </div>
        <Field
          label="Aggregate annual turnover"
          hint="Across every GSTIN on this PAN, including exempt supplies. Sets the thresholds below."
        >
          <Select
            data-testid="select-turnover-band"
            value={turnoverBand}
            onChange={(e) => setTurnoverBand(e.target.value as TurnoverBand | '')}
          >
            <option value="">Not declared</option>
            {TURNOVER_BANDS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </Select>
        </Field>
        {turnoverBand !== '' && <Obligations band={turnoverBand} filing={filing} regType={regType} />}
        <Field label="GSTIN" error={gstinError} hint="Needed for GSTR exports">
          <TextInput value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} className="num" />
        </Field>
        <Field label="Address">
          <TextInput value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Email">
            <TextInput value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Phone">
            <TextInput value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="PAN" error={panError} hint="Company's Income Tax PAN">
            <TextInput value={pan} onChange={(e) => setPan(e.target.value.toUpperCase())} className="num" maxLength={10} />
          </Field>
          <Field label="TAN" error={tanError} hint="Needed for TDS filings">
            <TextInput value={tan} onChange={(e) => setTan(e.target.value.toUpperCase())} className="num" maxLength={10} />
          </Field>
        </div>
        <div className="flex justify-between">
          <Button onClick={() => nav.go({ name: 'import-tally' })}>Import from Tally (XML)</Button>
          <Button data-testid="btn-company-info-save" variant="primary" onClick={() => void save()}>
            Save details
          </Button>
        </div>
      </Panel>
      <p className="mt-3 text-small text-muted">
        Books from FY {info?.booksFrom}-{((info?.booksFrom ?? 0) + 1) % 100}. Data lives in ~/Documents/total/companies/{slug} — back it up like any folder.
      </p>
      <RegistrationsCard />
      <CsvImportCard />
    </div>
  )
}

/**
 * The company's other GST registrations (roadmap #108).
 *
 * One PAN, premises in several states, one registration per state — one set of books, but a
 * return per GSTIN. The first row is the company's own registration and is not editable here:
 * it mirrors the GSTIN and state above, so that there is exactly one place to change them.
 *
 * A company with one registration sees this card explaining that, and nothing else changes
 * anywhere in the app.
 */
function RegistrationsCard(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: regs } = useQuery({ queryKey: ['gstRegistrations'], queryFn: api.gstReg.list })
  const [adding, setAdding] = useState(false)
  const [gstin, setGstin] = useState('')
  const [stateCode, setStateCode] = useState('27')
  const [tradeName, setTradeName] = useState('')
  const [registeredOn, setRegisteredOn] = useState('')
  const [busy, setBusy] = useState(false)

  // The state code IS the first two digits of the GSTIN. Following it as the user types removes
  // the only way to save a registration that taxes its supplies against the wrong state.
  useEffect(() => {
    const prefix = gstin.trim().slice(0, 2)
    if (prefix.length === 2 && prefix in GST_STATES) setStateCode(prefix)
  }, [gstin])

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['gstRegistrations'] })
  }

  const add = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.gstReg.save({
        gstin: gstin.trim().toUpperCase() || null,
        stateCode,
        tradeName: tradeName.trim() || 'Branch',
        address: null,
        registeredOn: registeredOn || null,
        surrenderedOn: null
      })
      toast.push('success', 'Registration added')
      setAdding(false)
      setGstin('')
      setTradeName('')
      setRegisteredOn('')
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: number): Promise<void> => {
    try {
      await api.gstReg.delete(id)
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Panel className="mt-4 flex flex-col gap-3 p-5">
      <SectionTitle
        right={
          <Button variant="ghost" data-testid="btn-add-registration" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'Add a registration'}
          </Button>
        }
      >
        GST registrations
      </SectionTitle>
      <p className="text-small text-muted">
        One PAN with premises in several states holds a registration per state. The books stay
        whole — one trial balance, one P&amp;L — but GSTR-1, GSTR-3B and the filing register are
        per GSTIN, and CGST+SGST against IGST is decided by the state of the registration that
        made the supply.
      </p>
      <table className="w-full text-body-sm" data-testid="rows-gst-registrations">
        <thead>
          <tr className="border-b border-line text-micro font-semibold tracking-[0.08em] text-muted uppercase">
            <th className="py-1 text-left">State</th>
            <th className="py-1 text-left">GSTIN</th>
            <th className="py-1 text-left">Trade name</th>
            <th className="py-1 text-left">From</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {(regs ?? []).map((r) => (
            <tr key={r.id} className="border-b border-line/60">
              <td className="py-1.5">
                {r.stateCode} — {GST_STATES[r.stateCode] ?? ''}
              </td>
              <td className="py-1.5 font-mono text-small">{r.gstin ?? '—'}</td>
              <td className="py-1.5">
                {r.tradeName}
                {r.isPrimary && <span className="ml-2 text-micro text-accent uppercase">primary</span>}
                {r.surrenderedOn && <span className="ml-2 text-micro text-muted">surrendered {r.surrenderedOn}</span>}
              </td>
              <td className="py-1.5 text-muted">{r.registeredOn ?? '—'}</td>
              <td className="py-1.5 text-right">
                {r.isPrimary ? (
                  <span className="text-micro text-muted">edited above</span>
                ) : (
                  <div className="flex justify-end gap-2">
                    <RowAction onClick={() => void api.gstReg.setPrimary(r.id).then(refresh)}>
                      Make primary
                    </RowAction>
                    <RowAction onClick={() => void remove(r.id)}>
                      Remove
                    </RowAction>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {adding && (
        <div className="grid grid-cols-4 items-end gap-3">
          <Field label="GSTIN">
            <TextInput
              data-testid="input-registration-gstin"
              value={gstin}
              onChange={(e) => setGstin(e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="State" hint="Taken from the GSTIN's first two digits">
            <Select
              data-testid="select-registration-state"
              value={stateCode}
              onChange={(e) => setStateCode(e.target.value)}
            >
              {Object.entries(GST_STATES).map(([code, label]) => (
                <option key={code} value={code}>
                  {code} — {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Trade name">
            <TextInput
              data-testid="input-registration-trade-name"
              value={tradeName}
              onChange={(e) => setTradeName(e.target.value)}
            />
          </Field>
          <Field label="Registered on">
            <TextInput type="date" value={registeredOn} onChange={(e) => setRegisteredOn(e.target.value)} />
          </Field>
          <div className="col-span-4 flex justify-end">
            <Button variant="primary" data-testid="btn-save-registration" disabled={busy} onClick={() => void add()}>
              Add registration
            </Button>
          </div>
        </div>
      )}
    </Panel>
  )
}

type ImportKind = 'ledgers' | 'items' | 'openings'
const IMPORT_KINDS: { id: ImportKind; label: string }[] = [
  { id: 'ledgers', label: 'Ledgers' },
  { id: 'items', label: 'Stock items' },
  { id: 'openings', label: 'Opening balances' }
]

interface CsvPreview {
  rows: Record<string, unknown>[]
  total: number
  willCreate: number
  willUpdate: number
  errors: { line: number; message: string }[]
}

function CsvImportCard(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<ImportKind>('ledgers')
  const [fileName, setFileName] = useState<string | null>(null)
  const [csvText, setCsvText] = useState<string | null>(null)
  const [preview, setPreview] = useState<CsvPreview | null>(null)
  const [busy, setBusy] = useState(false)

  const reset = (): void => {
    setFileName(null)
    setCsvText(null)
    setPreview(null)
  }

  const pickAndPreview = async (): Promise<void> => {
    try {
      const picked = await api.importer.pickCsv()
      if (!picked) return
      setBusy(true)
      const p = await api.importer.preview(kind, picked.csvText)
      setFileName(picked.fileName)
      setCsvText(picked.csvText)
      setPreview(p)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const apply = async (): Promise<void> => {
    if (!csvText) return
    setBusy(true)
    try {
      const r = await api.importer.apply(kind, csvText)
      toast.push('success', `Imported: ${r.created} created, ${r.updated} updated${r.errors.length ? `, ${r.errors.length} row${r.errors.length > 1 ? 's' : ''} skipped` : ''}`)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['ledgers'] }),
        queryClient.invalidateQueries({ queryKey: ['stockItems'] }),
        queryClient.invalidateQueries({ queryKey: ['groups'] }),
        queryClient.invalidateQueries({ queryKey: ['groupTree'] })
      ])
      reset()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const downloadTemplate = async (): Promise<void> => {
    try {
      const r = await api.importer.template(kind)
      toast.push('success', `Template saved to ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const errorsByLine = new Map(preview?.errors.map((e) => [e.line, e.message]) ?? [])
  const previewRows = preview?.rows.slice(0, 50) ?? []
  const columns = previewRows.length
    ? Object.keys(previewRows[0]!).filter((k) => k !== 'line')
    : []

  return (
    <Panel className="mt-4 flex flex-col gap-3 p-5">
      <SectionTitle
        right={
          <Button variant="ghost" onClick={() => void downloadTemplate()}>
            Download {IMPORT_KINDS.find((k) => k.id === kind)?.label} template
          </Button>
        }
      >
        Import from CSV
      </SectionTitle>
      <p className="text-small text-muted">
        Bring ledgers, stock items, or opening balances in from a spreadsheet — save your Excel sheet as CSV first, then pick it below.
      </p>
      <div className="flex items-end gap-3">
        <Field label="What to import">
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as ImportKind)
              reset()
            }}
          >
            {IMPORT_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button onClick={() => void pickAndPreview()} disabled={busy}>
          Pick file…
        </Button>
        {fileName && <span className="text-small text-muted">{fileName}</span>}
      </div>

      {preview && (
        <>
          <div className="flex items-center gap-4 text-small">
            <span className="text-muted">{preview.total} row{preview.total === 1 ? '' : 's'} parsed</span>
            <span className="text-dr">{preview.willCreate} to create</span>
            <span className="text-muted">{preview.willUpdate} to update</span>
            {preview.errors.length > 0 && (
              <span className="rounded-full bg-cr/15 px-2 py-0.5 text-cr">{preview.errors.length} error{preview.errors.length > 1 ? 's' : ''}</span>
            )}
          </div>
          <div className="max-h-80 overflow-auto rounded-md border border-line">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th scope="col" className="w-14">Line</th>
                  {columns.map((c) => (
                    <th scope="col" key={c}>{c}</th>
                  ))}
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row) => {
                  const line = row.line as number
                  const error = errorsByLine.get(line)
                  return (
                    <tr key={line}>
                      <td className="num text-muted">{line}</td>
                      {columns.map((c) => (
                        <td key={c}>{row[c] == null ? '' : String(row[c])}</td>
                      ))}
                      <td>
                        {error ? (
                          <span className="rounded-full bg-cr/15 px-2 py-0.5 text-caption text-cr">{error}</span>
                        ) : (
                          <span className="rounded-full bg-dr/15 px-2 py-0.5 text-caption text-dr">OK</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {(() => {
            const shownLines = new Set(previewRows.map((r) => r.line as number))
            const hiddenErrorCount = preview.errors.filter((e) => !shownLines.has(e.line)).length
            return hiddenErrorCount > 0 ? (
              <p className="text-small text-muted">
                {hiddenErrorCount} more error(s) beyond the rows shown above will still be skipped on apply.
              </p>
            ) : null
          })()}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={reset} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void apply()} disabled={busy || preview.total === 0}>
              Apply import
            </Button>
          </div>
        </>
      )}
    </Panel>
  )
}

/**
 * What the declared band obliges, stated where it is declared.
 *
 * A threshold nobody told you about is a threshold you cross by accident. e-invoicing above
 * ₹5 crore is the expensive one: a business over the line can issue B2B invoices for a year
 * without an IRN and only find out when its buyers' input credit is denied.
 */
function Obligations({
  band,
  filing,
  regType
}: {
  band: TurnoverBand
  filing: 'monthly' | 'quarterly'
  regType: 'regular' | 'composition' | 'unregistered'
}): React.JSX.Element {
  const o = turnoverObligations(band)
  const conflict = filing === 'quarterly' && !o.qrmp
  return (
    <div className="rounded-md border border-line bg-panel2 px-3.5 py-2.5 text-body-sm" data-testid="turnover-obligations">
      <ul className="flex flex-col gap-1">
        <li>
          {o.eInvoice ? (
            <span>
              <b className="text-accent">e-Invoicing is mandatory</b> at this turnover — every B2B invoice needs an
              IRN before it is issued.
            </span>
          ) : (
            <span className="text-muted">e-Invoicing is optional below ₹5 crore.</span>
          )}
        </li>
        <li className={o.minHsnDigits === 6 ? '' : 'text-muted'}>
          Invoice lines need at least <b>{o.minHsnDigits} HSN digits</b> under rule 46.
        </li>
        <li className={conflict ? 'text-cr' : 'text-muted'}>
          {conflict
            ? 'QRMP is capped at ₹5 crore — quarterly filing above that is not available. Set filing frequency back to monthly.'
            : o.qrmp
              ? 'QRMP (quarterly filing) is available at this turnover.'
              : 'QRMP is not available above ₹5 crore.'}
        </li>
        {regType === 'composition' && (
          <li className="text-muted">
            Composition ceilings are ₹1.5 crore for goods and restaurants, ₹50 lakh for services.
          </li>
        )}
      </ul>
    </div>
  )
}
