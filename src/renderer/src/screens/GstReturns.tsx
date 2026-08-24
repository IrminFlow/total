import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type GstRegistration } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { AmountInput, Button, EmptyState, Field, Money, Panel, SectionTitle, Select, SkeletonRows, Spinner, TextInput, inputCls } from '../components/ui'
import { todayISO } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { posLabel } from '@shared/gst/states'
import type { GstIssue } from '@shared/gst/validate'
import type { Gst3bManualInput } from '@shared/schemas'

export interface MonthChoice {
  key: string // YYYY-MM
  label: string
  from: string
  to: string
  period: string // MMYYYY
}

export function useMonths(): MonthChoice[] {
  const { from, to } = useSession()
  return useMemo(() => {
    const months: MonthChoice[] = []
    const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    let [y, m] = from.split('-').map(Number) as [number, number]
    const [ey, em] = to.split('-').map(Number) as [number, number]
    if (!y || !m || !ey || !em) return months
    while ((y < ey || (y === ey && m <= em)) && months.length < 120) {
      const mm = m.toString().padStart(2, '0')
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
      months.push({
        key: `${y}-${mm}`,
        label: `${names[m - 1]} ${y}`,
        from: `${y}-${mm}-01`,
        to: `${y}-${mm}-${lastDay}`,
        period: `${mm}${y}`
      })
      m++
      if (m > 12) {
        m = 1
        y++
      }
    }
    return months
  }, [from, to])
}

export function MonthBar({
  months,
  value,
  onChange,
  testId = 'input-month'
}: {
  months: MonthChoice[]
  value: string
  onChange: (key: string) => void
  /** data-testid (lib/testids.ts — `input-<screen>-month`). */
  testId?: string
}): React.JSX.Element {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-48" data-testid={testId}>
      {months.map((m) => (
        <option key={m.key} value={m.key}>
          {m.label}
        </option>
      ))}
    </Select>
  )
}

export function useDefaultMonth(months: MonthChoice[]): [string, (k: string) => void] {
  const current = todayISO().slice(0, 7)
  const fallback = months.find((m) => m.key === current)?.key ?? months[months.length - 1]?.key ?? current
  const [key, setKey] = useState(fallback)
  return [months.some((m) => m.key === key) ? key : fallback, setKey]
}

function RegistrationSelect({ registrations, value, onChange }: { registrations: GstRegistration[]; value: number | null; onChange: (id: number | null) => void }): React.JSX.Element | null {
  const active = registrations.filter((row) => row.active)
  if (!active.length) return null
  return <Select data-testid="input-gst-registration" value={value ?? ''} onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)} className="max-w-64">
    <option value="">Company / legacy GSTIN</option>
    {active.map((row) => <option key={row.id} value={row.id}>{row.gstin} · {row.stateCode}</option>)}
  </Select>
}

/** Selected month resolved against the list — null when the period yields no months at all
 *  (item 77 pattern: never `months.find(...)!`). */
export function useMonth(): {
  months: MonthChoice[]
  month: MonthChoice | null
  monthKey: string
  setMonthKey: (k: string) => void
} {
  const months = useMonths()
  const [monthKey, setMonthKey] = useDefaultMonth(months)
  const month = months.find((m) => m.key === monthKey) ?? months[0] ?? null
  return { months, month, monthKey, setMonthKey }
}

export function NoMonths(): React.JSX.Element {
  return (
    <Panel>
      <EmptyState
        title="No months in the current period"
        hint="Check the period (From/To) in the sidebar — it looks empty or reversed."
      />
    </Panel>
  )
}

// ---------- GSTR-1 ----------

const SEVERITY_CLASS: Record<GstIssue['severity'], string> = {
  blocking: 'border-cr/50 bg-cr/10 text-cr',
  warning: 'border-amber/50 bg-amber/10 text-amber'
}

function IssueRow({
  severity,
  message,
  voucherIds,
  onOpen
}: {
  severity: GstIssue['severity']
  message: string
  voucherIds: number[]
  onOpen: (voucherId: number) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? voucherIds : voucherIds.slice(0, 8)
  return (
    <div className="flex flex-col gap-1 border-b border-line px-3 py-2 last:border-b-0" data-row-id={voucherIds[0]}>
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-[10.5px] font-medium uppercase ${SEVERITY_CLASS[severity]}`}>
          {severity}
        </span>
        <span className="text-[12.5px] text-ink">{message}</span>
      </div>
      {voucherIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pl-1">
          {shown.map((id) => (
            <button
              key={id}
              data-testid="btn-gstr1-drill"
              data-row-id={id}
              className="rounded border border-line px-1.5 py-0.5 text-[11px] text-blue hover:bg-panel2"
              onClick={() => onOpen(id)}
            >
              Open #{id}
            </button>
          ))}
          {voucherIds.length > 8 && !expanded && (
            <button className="text-[11px] text-muted hover:text-ink" onClick={() => setExpanded(true)}>
              +{voucherIds.length - 8} more
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ReturnStatusPanel({ type, month, canFreeze, registrationId }: { type: 'gstr1' | 'gstr3b'; month: MonthChoice; canFreeze: boolean; registrationId: number | null }): React.JSX.Element {
  const queryClient = useQueryClient()
  const toast = useToasts()
  const [arn, setArn] = useState('')
  const [filedAt, setFiledAt] = useState(todayISO())
  const [submittedJson, setSubmittedJson] = useState('')
  const [busy, setBusy] = useState(false)
  const { data: status, isLoading } = useQuery({
    queryKey: ['gstReturnStatus', type, month.period, month.from, month.to, registrationId],
    queryFn: () => api.gst.returnStatus(type, month.from, month.to, month.period, registrationId)
  })
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['gstReturnStatus', type, month.period] })
  }
  const freeze = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.gst.freezeReturn(type, month.from, month.to, month.period, registrationId)
      await refresh()
      toast.push('success', 'Return snapshot prepared')
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const acknowledge = async (): Promise<void> => {
    if (arn.trim().length < 8) return void toast.push('error', 'Enter the portal acknowledgement reference')
    setBusy(true)
    try {
      await api.gst.acknowledgeReturn(type, month.from, month.to, month.period, {
        arn: arn.trim(), filedAt, submittedJson: submittedJson.trim() || null
      }, registrationId)
      await refresh()
      toast.push('success', 'Filing acknowledgement saved')
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return <Panel className="mb-4 p-4">
    <div className="flex items-start justify-between gap-5">
      <div>
        <p className="text-[13px] font-semibold">Return lifecycle</p>
        {isLoading || !status ? <p className="mt-1 text-[11.5px] text-muted">Checking prepared return…</p> : status.status === 'not_prepared' ?
          <p className="mt-1 text-[11.5px] text-muted">Not prepared yet. Freeze the current figures before review or export.</p> : status.status === 'filed' ?
            <p className="mt-1 text-[11.5px] text-dr">Filed on {status.filedAt} with ARN <span className="num">{status.arn}</span>{status.hasSubmittedJson ? ' · submitted JSON retained' : ''}</p> :
            <p className="mt-1 text-[11.5px] text-muted">Prepared at <span className="num">{status.frozenAt}</span>. The frozen JSON is retained for comparison.</p>}
        {status?.changedSinceFreeze && <p className="mt-1 text-[11.5px] font-medium text-cr">Books changed after this snapshot. Review the differences and prepare it again.</p>}
      </div>
      {status?.status !== 'filed' && <Button data-testid={`btn-${type}-return-freeze`} disabled={!canFreeze || busy} onClick={() => void freeze()}>{status?.status === 'prepared' ? 'Prepare again' : 'Prepare snapshot'}</Button>}
    </div>
    {status?.status === 'prepared' && !status.changedSinceFreeze && <div className="mt-4 grid grid-cols-[1fr_10rem] gap-3 border-t border-line pt-3">
      <Field label="Portal acknowledgement reference">
        <TextInput data-testid={`input-${type}-return-arn`} value={arn} onChange={(event) => setArn(event.target.value.toUpperCase())} placeholder="ARN or filing reference" className="num" />
      </Field>
      <Field label="Filed on">
        <TextInput data-testid={`input-${type}-return-filed-at`} type="date" value={filedAt} onChange={(event) => setFiledAt(event.target.value)} className="num" />
      </Field>
      <Field label="Submitted JSON (optional)">
        <textarea data-testid={`input-${type}-return-json`} className={`${inputCls} min-h-20 resize-y font-mono text-[11px]`} value={submittedJson} onChange={(event) => setSubmittedJson(event.target.value)} placeholder="Paste the exact JSON submitted to the portal" />
      </Field>
      <div className="flex items-end justify-end"><Button data-testid={`btn-${type}-return-filed`} variant="primary" disabled={busy || arn.trim().length < 8} onClick={() => void acknowledge()}>Mark filed</Button></div>
    </div>}
  </Panel>
}

export function Gstr1Screen(): React.JSX.Element {
  const { months, month, monthKey, setMonthKey } = useMonth()
  const { info } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [registrationId, setRegistrationId] = useState<number | null>(null)
  const registrations = useQuery({ queryKey: ['gstRegistrations'], queryFn: api.gst.registrations })
  const selectedRegistration = registrations.data?.find((row) => row.id === registrationId)
  const { data, isLoading } = useQuery({
    queryKey: ['gstr1', month?.key, registrationId],
    queryFn: () => api.gst.gstr1(month!.from, month!.to, month!.period, registrationId),
    enabled: !!month
  })
  const { data: validation, isLoading: validating } = useQuery({
    queryKey: ['gstValidate', month?.key, registrationId],
    queryFn: () => api.gst.validate(month!.from, month!.to, registrationId),
    enabled: !!month
  })

  const issues = validation?.issues ?? []
  const blocking = issues.filter((i) => i.severity === 'blocking')
  const warnings = issues.filter((i) => i.severity === 'warning')
  const roundOff = validation?.roundOff ?? []
  const effectiveGstin = selectedRegistration?.gstin ?? info?.gstin
  const exportBlockedReason = !effectiveGstin
    ? 'Add the company GSTIN under Company details to enable portal export.'
    : blocking.length
      ? `Export blocked — ${blocking.length} blocking issue${blocking.length === 1 ? '' : 's'} below must be fixed first.`
      : null

  const doExport = async (): Promise<void> => {
    if (!month) return
    try {
      const r = await api.gst.exportGstr1(month.from, month.to, month.period, registrationId)
      await queryClient.invalidateQueries({ queryKey: ['gstReturnStatus', 'gstr1', month.period] })
      toast.push('success', `GSTR-1 JSON ready to upload — ${r.jsonPath.split('/').pop()}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const openVoucher = (voucherId: number): void => nav.go({ name: 'voucher-entry', voucherId })

  if (!month) {
    return (
      <div className="mx-auto max-w-4xl">
        <SectionTitle>GSTR-1 · Outward supplies</SectionTitle>
        <NoMonths />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <RegistrationSelect registrations={registrations.data ?? []} value={registrationId} onChange={setRegistrationId} />
            <MonthBar months={months} value={monthKey} onChange={setMonthKey} testId="input-gstr1-month" />
            <Button
              variant="primary"
              data-testid="btn-gstr1-export"
              onClick={() => void doExport()}
              disabled={!!exportBlockedReason || validating}
              title={exportBlockedReason ?? undefined}
            >
              Export portal JSON
            </Button>
          </div>
        }
      >
        GSTR-1 · Outward supplies
      </SectionTitle>

      {exportBlockedReason && (
        <p className={`mb-3 text-[12.5px] ${blocking.length ? 'text-cr' : 'text-amber'}`}>{exportBlockedReason}</p>
      )}

      <ReturnStatusPanel type="gstr1" month={month} registrationId={registrationId} canFreeze={!exportBlockedReason && !validating} />

      {validating ? (
        <Panel className="mb-4">
          <div className="flex items-center gap-2 px-3 py-3 text-[12.5px] text-muted">
            <Spinner /> Validating period documents…
          </div>
        </Panel>
      ) : issues.length > 0 || roundOff.length > 0 ? (
        <Panel className="mb-4" scroll={{ maxH: '18rem' }}>
          <div data-testid="rows-gstr1-issues">
            {[...blocking, ...warnings].map((issue, i) => (
              <IssueRow key={`${issue.code}-${i}`} severity={issue.severity} message={issue.message} voucherIds={issue.voucherIds} onOpen={openVoucher} />
            ))}
            {roundOff.map((r) => (
              <IssueRow
                key={`roundoff-${r.voucherId}`}
                severity="warning"
                message={`${r.number}: e-invoice round-off of ₹${formatPaise(r.roundOff)} across ${r.lines.join(', ')} — the NIC schema tolerates ±₹1 per line.`}
                voucherIds={[r.voucherId]}
                onOpen={openVoucher}
              />
            ))}
          </div>
        </Panel>
      ) : (
        <p className="mb-3 text-[12px] text-muted">Validation clean — no issues found in this period. ✓</p>
      )}

      <Panel>
        {isLoading ? (
          <SkeletonRows />
        ) : (
        <table className="ledger-table">
          <thead>
            <tr>
              <th>Section</th>
              <th className="r w-16">Docs</th>
              <th className="r w-32">Taxable</th>
              <th className="r w-28">IGST</th>
              <th className="r w-28">CGST</th>
              <th className="r w-28">SGST</th>
              <th className="r w-24">Cess</th>
            </tr>
          </thead>
          <tbody data-testid="rows-gstr1">
            {(data?.summary ?? []).map((s) => (
              <tr
                key={s.section}
                data-row-id={s.section}
                className={`${s.docs === 0 && s.taxable === 0 ? 'opacity-40' : ''} ${s.voucherIds.length ? 'kbar-row cursor-pointer' : ''}`}
                title={s.voucherIds.length ? `Open ${s.voucherIds.length} contributing voucher${s.voucherIds.length === 1 ? '' : 's'}` : undefined}
                onClick={() => s.voucherIds.length && nav.go({ name: 'daybook', from: month.from, to: month.to, periodLabel: `GSTR-1 ${s.label}`, voucherIds: s.voucherIds })}
              >
                <td>{s.label}</td>
                <td className="r num">{s.docs}</td>
                <td className="r"><Money paise={s.taxable} /></td>
                <td className="r"><Money paise={s.igst} /></td>
                <td className="r"><Money paise={s.cgst} /></td>
                <td className="r"><Money paise={s.sgst} /></td>
                <td className="r"><Money paise={s.cess} /></td>
              </tr>
            ))}
            {data && (
              <tr className="total-row">
                {/* HSN rows re-state the invoice tables — keep them out of the grand total. */}
                <td>Total (invoice tables)</td>
                {(() => {
                  const inv = data.summary.filter((x) => !['hsn_b2b', 'hsn_b2c', 'doc_issue'].includes(x.section))
                  return (
                    <>
                      <td className="r num">{inv.reduce((s, x) => s + x.docs, 0)}</td>
                      <td className="r"><Money paise={inv.reduce((s, x) => s + x.taxable, 0)} /></td>
                      <td className="r"><Money paise={inv.reduce((s, x) => s + x.igst, 0)} /></td>
                      <td className="r"><Money paise={inv.reduce((s, x) => s + x.cgst, 0)} /></td>
                      <td className="r"><Money paise={inv.reduce((s, x) => s + x.sgst, 0)} /></td>
                      <td className="r"><Money paise={inv.reduce((s, x) => s + x.cess, 0)} /></td>
                    </>
                  )
                })()}
              </tr>
            )}
          </tbody>
        </table>
        )}
      </Panel>
      <p className="mt-3 text-[12px] text-muted">
        The exported JSON matches the GST offline-tool schema — upload it on the portal under Returns → GSTR-1 → Prepare offline. A CSV summary lands beside it in exports/. HSN rows (Table 12) restate the invoice tables and Documents issued (Table 13) counts net series — neither adds to the total.
      </p>
    </div>
  )
}

// ---------- GSTR-3B ----------

const EMPTY_MANUAL: Gst3bManualInput = {
  itcRevRul: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
  itcRevOth: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
  interest: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
  lateFee: { camt: 0, samt: 0 }
}

type ManualHead = 'itcRevRul' | 'itcRevOth' | 'interest'
const MANUAL_HEADS: { key: ManualHead; label: string }[] = [
  { key: 'itcRevRul', label: '4(B)(1) ITC reversed — rules 38/42/43' },
  { key: 'itcRevOth', label: '4(B)(2) ITC reversed — others' },
  { key: 'interest', label: '5.1 Interest payable' }
]

function ManualAdjustments({ period, registrationId }: { period: string; registrationId: number | null }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: saved, isLoading } = useQuery({
    queryKey: ['gst3bManual', period, registrationId],
    queryFn: () => api.gst.get3bManual(period, registrationId)
  })
  const [draft, setDraft] = useState<Gst3bManualInput | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => setDraft(null), [period, registrationId])
  const value = draft ?? saved ?? EMPTY_MANUAL
  const dirty = draft != null && JSON.stringify(draft) !== JSON.stringify(saved ?? EMPTY_MANUAL)

  const setPart = (head: ManualHead, field: 'igst' | 'cgst' | 'sgst' | 'cess', paise: number | null): void => {
    setDraft({ ...value, [head]: { ...value[head], [field]: paise ?? 0 } })
  }

  const doSave = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    try {
      await api.gst.set3bManual(period, draft, registrationId)
      setDraft(null)
      await queryClient.invalidateQueries({ queryKey: ['gst3bManual'] })
      await queryClient.invalidateQueries({ queryKey: ['gstr3b'] })
      toast.push('success', 'Manual adjustments saved — 3B figures recomputed')
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (isLoading) return <SkeletonRows rows={4} />

  return (
    <div className="px-3 py-2">
      <table className="ledger-table">
        <thead>
          <tr>
            <th>Adjustment (entered by you, applied to this period)</th>
            <th className="r w-32">IGST</th>
            <th className="r w-32">CGST</th>
            <th className="r w-32">SGST</th>
            <th className="r w-32">Cess</th>
          </tr>
        </thead>
        <tbody data-testid="rows-gstr3b-manual">
          {MANUAL_HEADS.map((h) => (
            <tr key={h.key}>
              <td>{h.label}</td>
              {(['igst', 'cgst', 'sgst', 'cess'] as const).map((f) => (
                <td key={f} className="r">
                  <AmountInput
                    paise={value[h.key][f]}
                    onPaise={(p) => setPart(h.key, f, p)}
                    testId={`input-3b-${h.key.toLowerCase()}-${f}`}
                  />
                </td>
              ))}
            </tr>
          ))}
          <tr>
            <td>5.1 Late fee (CGST/SGST heads only on the portal)</td>
            <td className="r text-muted">–</td>
            <td className="r">
              <AmountInput
                paise={value.lateFee.camt}
                onPaise={(p) => setDraft({ ...value, lateFee: { ...value.lateFee, camt: p ?? 0 } })}
                testId="input-3b-latefee-camt"
              />
            </td>
            <td className="r">
              <AmountInput
                paise={value.lateFee.samt}
                onPaise={(p) => setDraft({ ...value, lateFee: { ...value.lateFee, samt: p ?? 0 } })}
                testId="input-3b-latefee-samt"
              />
            </td>
            <td className="r text-muted">–</td>
          </tr>
        </tbody>
      </table>
      <div className="mt-2 flex items-center justify-end gap-2">
        {dirty && <span className="text-[11.5px] text-amber">Unsaved changes</span>}
        <Button variant="primary" data-testid="btn-gstr3b-save-manual" disabled={!dirty || saving} onClick={() => void doSave()}>
          {saving ? 'Saving…' : 'Save adjustments'}
        </Button>
      </div>
    </div>
  )
}

export function Gstr3bScreen(): React.JSX.Element {
  const { months, month, monthKey, setMonthKey } = useMonth()
  const { info } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const nav = useNav()
  const [registrationId, setRegistrationId] = useState<number | null>(null)
  const registrations = useQuery({ queryKey: ['gstRegistrations'], queryFn: api.gst.registrations })
  const selectedRegistration = registrations.data?.find((row) => row.id === registrationId)
  const effectiveGstin = selectedRegistration?.gstin ?? info?.gstin
  const { data, isLoading } = useQuery({
    queryKey: ['gstr3b', month?.key, registrationId],
    queryFn: () => api.gst.gstr3b(month!.from, month!.to, month!.period, registrationId),
    enabled: !!month
  })
  const { data: validation, isLoading: validating } = useQuery({
    queryKey: ['gstValidate', month?.key, registrationId],
    queryFn: () => api.gst.validate(month!.from, month!.to, registrationId),
    enabled: !!month
  })
  const blocking = validation?.issues.filter((issue) => issue.severity === 'blocking') ?? []

  const doExport = async (): Promise<void> => {
    if (!month) return
    try {
      const r = await api.gst.exportGstr3b(month.from, month.to, month.period, registrationId)
      await queryClient.invalidateQueries({ queryKey: ['gstReturnStatus', 'gstr3b', month.period] })
      toast.push('success', `GSTR-3B JSON saved — ${r.jsonPath.split('/').pop()}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const row = (
    label: string,
    v: { taxable?: number; igst: number; cgst?: number; sgst?: number; cess: number } | undefined,
    opts: { negative?: boolean; className?: string; source?: keyof NonNullable<typeof data>['voucherIds'] } = {}
  ): React.JSX.Element => {
    const sign = opts.negative ? -1 : 1
    const cell = (n: number | undefined): React.JSX.Element =>
      n == null ? <span className="text-muted">–</span> : <Money paise={sign * n} signed={opts.negative} />
    return (
      <tr
        data-source={opts.source}
        className={`${opts.className ?? ''} ${opts.source && data?.voucherIds[opts.source].length ? 'kbar-row cursor-pointer' : ''}`}
        onClick={() => {
          const ids = opts.source ? data?.voucherIds[opts.source] : undefined
          if (ids?.length) nav.go({ name: 'daybook', from: month?.from, to: month?.to, periodLabel: `GSTR-3B · ${label}`, voucherIds: ids })
        }}
        title={opts.source && data?.voucherIds[opts.source].length ? 'Open exact contributing vouchers' : undefined}
      >
        <td>{label}</td>
        <td className="r">{v?.taxable != null ? <Money paise={v.taxable} /> : <span className="text-muted">–</span>}</td>
        <td className="r">{cell(v?.igst ?? 0)}</td>
        <td className="r">{cell(v?.cgst)}</td>
        <td className="r">{cell(v?.sgst)}</td>
        <td className="r">{cell(v?.cess ?? 0)}</td>
      </tr>
    )
  }

  if (!month) {
    return (
      <div className="mx-auto max-w-4xl">
        <SectionTitle>GSTR-3B · Summary return</SectionTitle>
        <NoMonths />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <RegistrationSelect registrations={registrations.data ?? []} value={registrationId} onChange={setRegistrationId} />
            <MonthBar months={months} value={monthKey} onChange={setMonthKey} testId="input-gstr3b-month" />
            <Button variant="primary" data-testid="btn-gstr3b-export" onClick={() => void doExport()} disabled={!effectiveGstin || blocking.length > 0 || validating}>
              Export JSON
            </Button>
          </div>
        }
      >
        GSTR-3B · Summary return
      </SectionTitle>

      {!effectiveGstin && (
        <p className="mb-3 text-[12.5px] text-amber">Add the company GSTIN under Company details to enable export.</p>
      )}
      {blocking.length > 0 && <p className="mb-3 text-[12.5px] text-cr">Export blocked. Fix {blocking.length} GST readiness issue{blocking.length === 1 ? '' : 's'} in GSTR-1 validation.</p>}

      <ReturnStatusPanel type="gstr3b" month={month} registrationId={registrationId} canFreeze={!!effectiveGstin && blocking.length === 0 && !validating} />

      <Panel>
        {isLoading || !data ? (
          <SkeletonRows />
        ) : (
        <table className="ledger-table">
          <thead>
            <tr>
              <th>Table</th>
              <th className="r w-32">Taxable</th>
              <th className="r w-28">IGST</th>
              <th className="r w-28">CGST</th>
              <th className="r w-28">SGST</th>
              <th className="r w-24">Cess</th>
            </tr>
          </thead>
          <tbody data-testid="rows-gstr3b">
            {row('3.1(a) Outward taxable supplies', data.outward, { source: 'outward' })}
            {row('3.1(b) Zero-rated (exports + SEZ)', { taxable: data.zeroRated.taxable, igst: data.zeroRated.igst, cess: data.zeroRated.cess }, { source: 'zeroRated' })}
            {row('3.1(c) Nil-rated / exempt', { taxable: data.nilExempt.taxable, igst: 0, cgst: 0, sgst: 0, cess: 0 }, { source: 'nilExempt' })}
            {row('3.1(d) Inward supplies under RCM', data.rcm, { source: 'rcm' })}
            {row('4(A)(1) ITC — import of goods', data.itcParts.impg, { source: 'impg' })}
            {row('4(A)(3) ITC — inward RCM supplies', data.itcParts.isrc, { source: 'isrc' })}
            {row('4(A)(5) ITC — all other', data.itcParts.oth, { source: 'oth' })}
            {row('4(B) ITC reversed (manual, below)', {
              igst: data.manual.itcRevRul.igst + data.manual.itcRevOth.igst,
              cgst: data.manual.itcRevRul.cgst + data.manual.itcRevOth.cgst,
              sgst: data.manual.itcRevRul.sgst + data.manual.itcRevOth.sgst,
              cess: data.manual.itcRevRul.cess + data.manual.itcRevOth.cess
            }, { negative: true })}
            {row('4(C) Net eligible ITC', data.itc, { className: 'total-row', source: 'netItc' })}
            {row('4(D)(1) Ineligible / blocked ITC (reported only)', data.itcParts.blocked, { source: 'blocked' })}
            {row('5.1 Interest payable (manual, below)', data.manual.interest)}
            {row('5.1 Late fee (manual, below)', { igst: 0, cgst: data.manual.lateFee.camt, sgst: data.manual.lateFee.samt, cess: 0 })}
          </tbody>
        </table>
        )}
      </Panel>

      {data && data.interState.length > 0 && (
        <Panel className="mt-4">
          <table className="ledger-table">
            <thead>
              <tr>
                <th>3.2 Inter-state supplies to unregistered persons — place of supply</th>
                <th className="r w-32">Taxable</th>
                <th className="r w-28">IGST</th>
              </tr>
            </thead>
            <tbody data-testid="rows-gstr3b-interstate">
              {data.interState.map((r) => (
                <tr key={r.pos}>
                  <td>{posLabel(r.pos)}</td>
                  <td className="r"><Money paise={r.taxable} /></td>
                  <td className="r"><Money paise={r.igst} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {data && (
        <Panel className="mt-4">
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Set-off (sec 49/49A order: IGST credit first, cess only against cess)</th>
                <th className="r w-28">IGST</th>
                <th className="r w-28">CGST</th>
                <th className="r w-28">SGST</th>
                <th className="r w-24">Cess</th>
              </tr>
            </thead>
            <tbody data-testid="rows-gstr3b-setoff">
              <tr>
                <td>Output tax liability (3.1(a) + 3.1(b))</td>
                <td className="r"><Money paise={data.outward.igst + data.zeroRated.igst} /></td>
                <td className="r"><Money paise={data.outward.cgst} /></td>
                <td className="r"><Money paise={data.outward.sgst} /></td>
                <td className="r"><Money paise={data.outward.cess + data.zeroRated.cess} /></td>
              </tr>
              <tr>
                <td>Less: ITC set off (4(C))</td>
                <td className="r"><Money paise={-(data.outward.igst + data.zeroRated.igst - data.netPayable.igst)} signed /></td>
                <td className="r"><Money paise={-(data.outward.cgst - data.netPayable.cgst)} signed /></td>
                <td className="r"><Money paise={-(data.outward.sgst - data.netPayable.sgst)} signed /></td>
                <td className="r"><Money paise={-(data.outward.cess + data.zeroRated.cess - data.netPayable.cess)} signed /></td>
              </tr>
              <tr className="total-row">
                <td>Net payable in cash</td>
                <td className="r"><Money paise={data.netPayable.igst} /></td>
                <td className="r"><Money paise={data.netPayable.cgst} /></td>
                <td className="r"><Money paise={data.netPayable.sgst} /></td>
                <td className="r"><Money paise={data.netPayable.cess} /></td>
              </tr>
              <tr>
                <td>RCM payable — cash only, never set off against ITC (3.1(d))</td>
                <td className="r"><Money paise={data.rcmPayable.igst} /></td>
                <td className="r"><Money paise={data.rcmPayable.cgst} /></td>
                <td className="r"><Money paise={data.rcmPayable.sgst} /></td>
                <td className="r"><Money paise={data.rcmPayable.cess} /></td>
              </tr>
            </tbody>
          </table>
        </Panel>
      )}

      <Panel className="mt-4">
        <ManualAdjustments period={month.period} registrationId={registrationId} />
      </Panel>

      <p className="mt-3 text-[12px] text-muted">
        4(B) reversals and 5.1 interest/late fee are the manual adjustments above, persisted per period and folded into the exported JSON. RCM tax (3.1(d)) is payable in cash and simultaneously claimable as ITC under 4(A)(3).
      </p>
    </div>
  )
}
