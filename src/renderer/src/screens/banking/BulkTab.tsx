// Banking → Bulk payments (WP 4.1): pick payment vouchers of the period, export a NEFT/RTGS
// upload file in your bank's layout (a template — bank corporate layouts are mostly not public,
// so you build yours from the bank's sample), keep the beneficiaries' bank details, and see the
// files already exported.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PAYMENT_FIELDS, PAYMENT_FIELD_LABELS, paymentTypeFor, type PaymentField, type PaymentTemplate } from '@shared/bulkPayments'
import { toDisplayDate, todayISO } from '@shared/dates'
import { bankingApi, type BeneficiaryRow, type PaymentCandidate, type PaymentTemplateRecord } from '../../lib/bankingClient'
import { DataTable, defineColumns } from '../../components/table'
import { Badge, Banner, Button, Checkbox, DateInput, Field, Modal, Panel, Segmented, Select, StatGrid, StatTile, TextInput } from '../../components/ui'
import { useSession, useToasts } from '../../state/stores'
import { confirmDialog } from '../../lib/dialogs'
import { MODAL_TABLE_FEATURES, rupees } from './shared'

type Section = 'payments' | 'beneficiaries' | 'templates'

function candidateColumns(threshold: number, onFix: (c: PaymentCandidate) => void): ReturnType<typeof defineColumns<PaymentCandidate>> {
  return defineColumns<PaymentCandidate>([
    { id: 'date', header: 'Date', kind: 'date', value: (c) => c.date, width: 104, className: 'text-muted' },
    { id: 'number', header: 'Voucher', kind: 'text', value: (c) => c.number, width: 110, className: 'num' },
    { id: 'payee', header: 'Payee', kind: 'text', value: (c) => c.payeeName, hideable: false, minWidth: 160 },
    { id: 'account', header: 'Account no.', kind: 'text', value: (c) => c.accountNo, width: 140, className: 'num text-muted' },
    { id: 'ifsc', header: 'IFSC', kind: 'text', value: (c) => c.ifsc, width: 120, className: 'num text-muted' },
    { id: 'amount', header: 'Amount', kind: 'money', value: (c) => c.amount, aggregate: 'sum', width: 130 },
    {
      id: 'mode',
      header: 'Mode',
      kind: 'enum',
      value: (c) => paymentTypeFor(c.amount, threshold),
      options: [
        { value: 'NEFT', label: 'NEFT' },
        { value: 'RTGS', label: 'RTGS' }
      ],
      width: 76
    },
    {
      id: 'state',
      header: 'Check',
      kind: 'text',
      minWidth: 170,
      value: (c) => (c.problems.length ? c.problems.join(', ') : c.exportedIn.length ? 'exported' : 'ready'),
      cell: (c) => (
        <span className="flex flex-wrap gap-1">
          {c.problems.length > 0 ? (
            <button type="button" className="text-left" data-testid="btn-bulk-fix" title={c.problems.join(', ')} onClick={(e) => { e.stopPropagation(); onFix(c) }}>
              <Badge tone="danger">{c.problems[0]}</Badge> <span className="text-small text-blue hover:underline">Bank details…</span>
            </button>
          ) : (
            <Badge tone="success">Ready</Badge>
          )}
          {c.exportedIn.length > 0 && <Badge tone="warning">In {c.exportedIn.length === 1 ? 'a file' : `${c.exportedIn.length} files`} already</Badge>}
          {c.chequeNo && <Badge tone="warning">Cheque {c.chequeNo}</Badge>}
          {c.postDated && <Badge tone="info">PDC</Badge>}
        </span>
      )
    }
  ])
}

const BENEFICIARY_COLUMNS = defineColumns<BeneficiaryRow>([
  { id: 'name', header: 'Ledger', kind: 'text', value: (b) => b.name, hideable: false, minWidth: 170 },
  { id: 'group', header: 'Group', kind: 'text', value: (b) => (b.isBank ? 'Our bank account' : b.groupName), width: 150, className: 'text-muted' },
  { id: 'accountName', header: 'Account name', kind: 'text', value: (b) => b.accountName, minWidth: 150 },
  { id: 'account', header: 'Account no.', kind: 'text', value: (b) => b.accountNo, width: 160, className: 'num' },
  { id: 'ifsc', header: 'IFSC', kind: 'text', value: (b) => b.ifsc, width: 120, className: 'num' },
  { id: 'email', header: 'E-mail', kind: 'text', value: (b) => b.email, width: 170, defaultHidden: true },
  {
    id: 'state',
    header: 'Check',
    kind: 'enum',
    value: (b) => (b.problems.length ? 'incomplete' : 'ok'),
    options: [
      { value: 'ok', label: 'Complete' },
      { value: 'incomplete', label: 'Incomplete' }
    ],
    width: 120,
    cell: (b) => (b.problems.length ? <span title={b.problems.join(', ')}><Badge tone="warning">Incomplete</Badge></span> : <Badge tone="success">Complete</Badge>)
  }
])

export function BulkTab({ bankLedgerId, bankName }: { bankLedgerId: number; bankName: string }): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [section, setSection] = useState<Section>('payments')
  const { data: templates } = useQuery({ queryKey: ['bulkTemplates'], queryFn: bankingApi.bulk.templates })
  const { data: candidates, isLoading } = useQuery({ queryKey: ['bulkCandidates', bankLedgerId, from, to], queryFn: () => bankingApi.bulk.candidates(bankLedgerId, from, to) })
  const { data: beneficiaries } = useQuery({ queryKey: ['bulkBeneficiaries'], queryFn: bankingApi.bulk.beneficiaries })
  const { data: batches } = useQuery({ queryKey: ['bulkBatches', bankLedgerId], queryFn: () => bankingApi.bulk.batches(bankLedgerId) })
  const [templateKey, setTemplateKey] = useState<string>('')
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [corporateId, setCorporateId] = useState('')
  const [remarks, setRemarks] = useState('')
  const [date, setDate] = useState(todayISO())
  const [editBen, setEditBen] = useState<BeneficiaryRow | null>(null)
  const [editTpl, setEditTpl] = useState<{ record: PaymentTemplateRecord | null; spec: PaymentTemplate } | null>(null)

  useEffect(() => {
    if (!templateKey && templates?.length) setTemplateKey(templates.find((t) => !t.builtin)?.key ?? templates[0]!.key)
  }, [templates, templateKey])
  const template = templates?.find((t) => t.key === templateKey)
  useEffect(() => setCorporateId(template?.spec.corporateId ?? ''), [template])
  const fixRef = useRef<(c: PaymentCandidate) => void>(() => {})
  fixRef.current = (c) => {
    if (c.payeeLedgerId == null) return
    const b = beneficiaries?.find((x) => x.ledgerId === c.payeeLedgerId)
    setEditBen(b ?? { ledgerId: c.payeeLedgerId, name: c.payeeName ?? '', groupName: '', isBank: false, accountNo: c.accountNo, ifsc: c.ifsc, accountName: c.accountName, email: c.email, problems: c.problems })
  }
  const columns = useMemo(() => candidateColumns(template?.spec.rtgsThreshold ?? 2_00_000_00, (c) => fixRef.current(c)), [template])
  const rows = candidates ?? []
  const selected = rows.filter((c) => picked.has(c.voucherId))
  const own = beneficiaries?.find((b) => b.ledgerId === bankLedgerId)

  const invalidate = (): Promise<unknown> =>
    Promise.all(['bulkTemplates', 'bulkCandidates', 'bulkBeneficiaries', 'bulkBatches'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })))

  const exportFile = async (): Promise<void> => {
    if (!template) return
    if (selected.some((c) => c.exportedIn.length > 0 || c.chequeNo)) {
      const ok = await confirmDialog({
        title: 'Some payments may go out twice',
        message: 'Some selected vouchers are already in an exported file or have a cheque issued. Export them again?',
        confirmLabel: 'Export anyway'
      })
      if (!ok) return
    }
    try {
      const r = await bankingApi.bulk.export({ bankLedgerId, voucherIds: selected.map((c) => c.voucherId), templateKey: template.key, date, corporateId, remarks })
      toast.push('success', `${r.count} payments · ${rupees(r.total)} → ${r.path}`)
      setPicked(new Set())
      await invalidate()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <div className="mb-3 flex items-center gap-3">
        <Segmented
          label="Bulk payments section"
          testId="bulk-section"
          value={section}
          options={[
            { value: 'payments', label: 'Payments' },
            { value: 'beneficiaries', label: 'Beneficiaries' },
            { value: 'templates', label: 'File templates' }
          ]}
          onChange={setSection}
        />
        <span className="text-hint text-muted">NEFT / RTGS upload file for {bankName}’s corporate banking.</span>
      </div>

      {section === 'payments' && (
        <>
          {own && own.problems.length > 0 && (
            <Banner tone="warning" className="mb-3" action={<Button size="sm" onClick={() => setEditBen(own)}>Set account details</Button>}>
              {bankName}’s own account number / IFSC are not set — most upload files need them as the debit account.
            </Banner>
          )}
          <div className="mb-3 grid grid-cols-6 items-end gap-3">
            <div className="col-span-2">
              <Field label="File template">
                <Select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)} data-testid="input-bulk-template">
                  {(templates ?? []).map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.spec.name}
                      {t.builtin ? ' (starter)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Payment date">
              <DateInput value={date} context={to} onChange={setDate} className="w-40" />
            </Field>
            <Field label="Corporate / client id">
              <TextInput value={corporateId} onChange={(e) => setCorporateId(e.target.value)} data-testid="input-bulk-corporate" />
            </Field>
            <Field label="File remarks">
              <TextInput value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </Field>
            <Button variant="primary" disabled={selected.length === 0 || !template} data-testid="btn-bulk-export" onClick={() => void exportFile()}>
              Export {selected.length || ''} · {rupees(selected.reduce((s, c) => s + c.amount, 0))}
            </Button>
          </div>
          {template?.builtin && template.source && <p className="mb-2 text-hint text-muted">Starter layout — {template.source}. Check it against your bank’s current sample before the first upload.</p>}
          <Panel>
            <DataTable
              viewId="banking-bulk"
              testId="banking-bulk"
              ariaLabel="Payment vouchers"
              columns={columns}
              rows={rows}
              rowKey={(c) => c.voucherId}
              rowAttrs={(c) => ({ 'data-row-id': c.voucherId, 'data-ready': c.problems.length ? '0' : '1' })}
              loading={isLoading}
              maxHeight="50vh"
              empty={{ title: 'No payments from this bank account in the period', hint: 'Payment vouchers crediting the bank appear here' }}
              leadingWidth={40}
              leading={(c) => (
                <input
                  type="checkbox"
                  aria-label={`Select ${c.number}`}
                  data-testid="input-bulk-pick"
                  checked={picked.has(c.voucherId)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    setPicked((s) => {
                      const next = new Set(s)
                      if (e.target.checked) next.add(c.voucherId)
                      else next.delete(c.voucherId)
                      return next
                    })
                  }
                />
              )}
              exportOptions={{ title: `Payments — ${bankName}`, periodLabel: `${toDisplayDate(from)} to ${toDisplayDate(to)}`, filename: 'bank-payments' }}
            />
          </Panel>
          {(batches ?? []).length > 0 && (
            <Panel className="mt-3">
              <div className="border-b border-line px-4 py-2.5">
                <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">Files exported · {batches!.length}</p>
              </div>
              <ul className="divide-y divide-line/60" data-testid="banking-bulk-batches">
                {batches!.slice(0, 8).map((b) => (
                  <li key={b.id} className="flex items-center gap-3 px-4 py-1.5 text-small">
                    <span className="num w-36 text-muted">{b.createdAt.slice(0, 16)}</span>
                    <span className="flex-1 truncate text-ink">{b.fileName}</span>
                    <span className="text-muted">{b.templateName}</span>
                    <span className="num w-28 text-right">{b.voucherCount} · {rupees(b.total)}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}

      {section === 'beneficiaries' && (
        <Panel>
          <DataTable
            viewId="banking-beneficiaries"
            testId="banking-beneficiaries"
            ariaLabel="Beneficiaries"
            columns={BENEFICIARY_COLUMNS}
            rows={beneficiaries ?? []}
            rowKey={(b) => b.ledgerId}
            rowAttrs={(b) => ({ 'data-row-id': b.ledgerId })}
            onRowActivate={setEditBen}
            maxHeight="60vh"
            empty={{ title: 'No parties yet', hint: 'Sundry creditors and debtors appear here' }}
            trailingWidth={70}
            trailing={(b) => (
              <button className="text-small text-blue hover:underline" data-testid="btn-bulk-edit-beneficiary" onClick={() => setEditBen(b)}>
                Edit
              </button>
            )}
          />
        </Panel>
      )}

      {section === 'templates' && (
        <Panel>
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <p className="text-hint text-muted">
              HDFC, ICICI and SBI corporate upload layouts are only published inside their portals — download your bank’s sample file and copy its columns here.
            </p>
            <Button
              size="sm"
              data-testid="btn-bulk-new-template"
              onClick={() => template && setEditTpl({ record: null, spec: { ...template.spec, name: `${template.spec.name} (copy)` } })}
            >
              New from selected…
            </Button>
          </div>
          <ul className="divide-y divide-line/60" data-testid="banking-bulk-templates">
            {(templates ?? []).map((t) => (
              <li key={t.key} className="flex items-center gap-3 px-4 py-2">
                <span className="flex-1">
                  <span className="block text-detail text-ink">{t.spec.name}</span>
                  <span className="block text-hint text-muted">
                    {t.spec.columns.length} columns · {t.spec.delimiter === '\t' ? 'tab' : `“${t.spec.delimiter}”`} separated .{t.spec.extension}
                    {t.builtin && t.source ? ` · ${t.source}` : ''}
                  </span>
                </span>
                {t.builtin ? <Badge tone="neutral">Starter</Badge> : <Badge tone="info">Yours</Badge>}
                <Button size="sm" variant="ghost" onClick={() => setEditTpl({ record: t.builtin ? null : t, spec: t.builtin ? { ...t.spec, name: `${t.spec.name} (copy)` } : t.spec })}>
                  {t.builtin ? 'Duplicate…' : 'Edit…'}
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {editBen && (
        <BeneficiaryModal
          row={editBen}
          onClose={() => setEditBen(null)}
          onSaved={() => {
            setEditBen(null)
            void invalidate()
          }}
        />
      )}
      {editTpl && (
        <TemplateModal
          record={editTpl.record}
          initial={editTpl.spec}
          onClose={() => setEditTpl(null)}
          onSaved={(rec) => {
            setEditTpl(null)
            if (rec) setTemplateKey(rec.key)
            void invalidate()
          }}
        />
      )}
    </>
  )
}

function BeneficiaryModal({ row, onClose, onSaved }: { row: BeneficiaryRow; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const toast = useToasts()
  const [accountName, setAccountName] = useState(row.accountName ?? (row.isBank ? '' : row.name))
  const [accountNo, setAccountNo] = useState(row.accountNo ?? '')
  const [ifsc, setIfsc] = useState(row.ifsc ?? '')
  const [email, setEmail] = useState(row.email ?? '')
  const save = async (): Promise<void> => {
    try {
      await bankingApi.bulk.setBankDetails(row.ledgerId, { accountName: accountName || null, accountNo: accountNo || null, ifsc: ifsc || null, email: email || null })
      toast.push('success', 'Bank details saved')
      onSaved()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <Modal title={`Bank details — ${row.name}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label={row.isBank ? 'Account holder (optional)' : 'Beneficiary name (as in the bank)'}>
            <TextInput value={accountName} onChange={(e) => setAccountName(e.target.value)} data-testid="input-bulk-ben-name" />
          </Field>
          <Field label="E-mail (optional)">
            <TextInput value={email} onChange={(e) => setEmail(e.target.value)} data-testid="input-bulk-ben-email" />
          </Field>
          <Field label="Account number">
            <TextInput value={accountNo} onChange={(e) => setAccountNo(e.target.value)} className="num" data-testid="input-bulk-ben-account" />
          </Field>
          <Field label="IFSC" hint="11 characters: 4 letters, 0, then 6 letters/digits">
            <TextInput value={ifsc} onChange={(e) => setIfsc(e.target.value.toUpperCase())} className="num" data-testid="input-bulk-ben-ifsc" />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="btn-bulk-ben-save" onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function TemplateModal({
  record,
  initial,
  onClose,
  onSaved
}: {
  record: PaymentTemplateRecord | null
  initial: PaymentTemplate
  onClose: () => void
  onSaved: (rec: PaymentTemplateRecord | null) => void
}): React.JSX.Element {
  const toast = useToasts()
  const [spec, setSpec] = useState<PaymentTemplate>(initial)
  const set = <K extends keyof PaymentTemplate>(k: K, v: PaymentTemplate[K]): void => setSpec((s) => ({ ...s, [k]: v }))
  const setCol = (i: number, patch: Partial<PaymentTemplate['columns'][number]>): void =>
    setSpec((s) => ({ ...s, columns: s.columns.map((c, j) => (j === i ? { ...c, ...patch } : c)) }))
  const move = (i: number, d: -1 | 1): void =>
    setSpec((s) => {
      const cols = [...s.columns]
      const j = i + d
      if (j < 0 || j >= cols.length) return s
      ;[cols[i], cols[j]] = [cols[j]!, cols[i]!]
      return { ...s, columns: cols }
    })
  const save = async (): Promise<void> => {
    try {
      const rec = await bankingApi.bulk.saveTemplate(spec, record?.id ?? undefined)
      toast.push('success', 'Template saved')
      onSaved(rec)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const remove = async (): Promise<void> => {
    if (!record?.id) return
    const ok = await confirmDialog({ title: 'Delete template', message: `Delete “${record.spec.name}”?`, confirmLabel: 'Delete', danger: true })
    if (!ok) return
    try {
      await bankingApi.bulk.deleteTemplate(record.id)
      onSaved(null)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  type ColRow = PaymentTemplate['columns'][number] & { i: number }
  const COLS = defineColumns<ColRow>([
    { id: 'i', header: '#', kind: 'number', value: (c) => c.i + 1, width: 44 },
    {
      id: 'header',
      header: 'Column header (as in the bank’s file)',
      kind: 'text',
      value: (c) => c.header,
      minWidth: 200,
      cell: (c) => <TextInput value={c.header} onChange={(e) => setCol(c.i, { header: e.target.value })} className="text-small" />
    },
    {
      id: 'field',
      header: 'Filled with',
      kind: 'text',
      value: (c) => c.field,
      width: 220,
      cell: (c) => (
        <Select value={c.field} onChange={(e) => setCol(c.i, { field: e.target.value as PaymentField })} className="text-small">
          {PAYMENT_FIELDS.map((f) => (
            <option key={f} value={f}>
              {PAYMENT_FIELD_LABELS[f]}
            </option>
          ))}
        </Select>
      )
    },
    {
      id: 'value',
      header: 'Fixed text / max length',
      kind: 'text',
      value: (c) => c.value,
      width: 200,
      cell: (c) =>
        c.field === 'constant' ? (
          <TextInput value={c.value ?? ''} onChange={(e) => setCol(c.i, { value: e.target.value })} className="text-small" />
        ) : (
          <TextInput
            type="number"
            value={c.maxLength ?? ''}
            placeholder="no limit"
            onChange={(e) => setCol(c.i, { maxLength: e.target.value ? Number(e.target.value) : null })}
            className="num text-small"
          />
        )
    }
  ])
  return (
    <Modal title={record ? 'Edit file template' : 'New file template'} onClose={onClose} wide dirty={JSON.stringify(spec) !== JSON.stringify(initial)}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-6 gap-3">
          <div className="col-span-2">
            <Field label="Name">
              <TextInput value={spec.name} onChange={(e) => set('name', e.target.value)} data-testid="input-bulk-template-name" />
            </Field>
          </div>
          <Field label="Separator">
            <Select value={spec.delimiter} onChange={(e) => set('delimiter', e.target.value as PaymentTemplate['delimiter'])}>
              <option value=",">Comma</option>
              <option value="|">Pipe |</option>
              <option value={'\t'}>Tab</option>
              <option value=";">Semicolon</option>
            </Select>
          </Field>
          <Field label="File type">
            <Select value={spec.extension} onChange={(e) => set('extension', e.target.value as PaymentTemplate['extension'])}>
              <option value="csv">.csv</option>
              <option value="txt">.txt</option>
            </Select>
          </Field>
          <Field label="Date format">
            <Select value={spec.dateFormat} onChange={(e) => set('dateFormat', e.target.value as PaymentTemplate['dateFormat'])}>
              {(['DD/MM/YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD', 'DDMMYYYY', 'DD-MMM-YYYY'] as const).map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount">
            <Select value={spec.amountFormat} onChange={(e) => set('amountFormat', e.target.value as PaymentTemplate['amountFormat'])}>
              <option value="rupees">1234.50</option>
              <option value="rupees_int">Whole rupees</option>
              <option value="paise">Paise</option>
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-6 items-end gap-3">
          <div className="col-span-3">
            <Field label="First line (optional)" hint="Placeholders: {corporateId} {batchNo} {date} {count} {total} {remarks}">
              <TextInput value={spec.headerLine ?? ''} onChange={(e) => set('headerLine', e.target.value || null)} className="num" />
            </Field>
          </div>
          <Field label="Corporate id">
            <TextInput value={spec.corporateId} onChange={(e) => set('corporateId', e.target.value)} />
          </Field>
          <Checkbox label="Column headers row" checked={spec.includeHeader} onChange={(v) => set('includeHeader', v)} />
          <Checkbox label="Quote every value" checked={spec.quoteAll} onChange={(v) => set('quoteAll', v)} />
        </div>
        <div className="overflow-hidden rounded-md border border-line">
          <DataTable
            testId="bulk-template-columns"
            ariaLabel="Template columns"
            columns={COLS}
            rows={spec.columns.map((c, i) => ({ ...c, i }))}
            rowKey={(c) => c.i}
            toolbarFeatures={MODAL_TABLE_FEATURES}
            maxHeight="36vh"
            keyboard={false}
            trailingWidth={110}
            trailing={(c) => (
              <span className="flex gap-2">
                <button className="text-small text-muted hover:text-ink" aria-label="Move up" onClick={() => move(c.i, -1)}>↑</button>
                <button className="text-small text-muted hover:text-ink" aria-label="Move down" onClick={() => move(c.i, 1)}>↓</button>
                <button className="text-small text-cr hover:underline" onClick={() => setSpec((s) => ({ ...s, columns: s.columns.filter((_, j) => j !== c.i) }))}>
                  Remove
                </button>
              </span>
            )}
          />
        </div>
        <div className="flex justify-between gap-2">
          <span className="flex gap-2">
            <Button size="sm" onClick={() => setSpec((s) => ({ ...s, columns: [...s.columns, { header: 'Column', field: 'blank' }] }))}>
              Add column
            </Button>
            {record?.id && (
              <Button size="sm" variant="danger" onClick={() => void remove()}>
                Delete template
              </Button>
            )}
          </span>
          <span className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" data-testid="btn-bulk-template-save" onClick={() => void save()}>
              Save template
            </Button>
          </span>
        </div>
        <StatGrid>
          <StatTile label="Columns" value={String(spec.columns.length)} />
          <StatTile label="RTGS from" value={rupees(spec.rtgsThreshold)} hint="RBI: RTGS minimum ₹2,00,000" />
        </StatGrid>
      </div>
    </Modal>
  )
}
