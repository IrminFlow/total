import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Ledger, VoucherKind } from '@shared/domain'
import type { VoucherInputParsed } from '@shared/schemas'
import { computeGst, supplyTypeFor, addBreakups, type GstBreakup } from '@shared/gst/calc'
import { roundToRupee, formatPaise, amountInWords } from '@shared/money'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { AmountInput, Button, DateInput, Field, Kbd, Modal, Money, Panel, Select, TextInput, inputCls } from '../components/ui'
import { ItemPicker, LedgerPicker, useGroups, useLedgers, useStockItems, useTaxLedgers } from '../components/pickers'

const TRADING_KINDS: VoucherKind[] = ['sales', 'purchase', 'credit_note', 'debit_note']
const FKEYS: Record<string, VoucherKind> = {
  F4: 'contra', F5: 'payment', F6: 'receipt', F7: 'journal', F8: 'sales', F9: 'purchase'
}

export function VoucherEntry({ voucherId, kindHint }: { voucherId?: number; kindHint?: string }): React.JSX.Element {
  const { data: types } = useQuery({ queryKey: ['voucherTypes'], queryFn: api.voucherTypes.list })
  const { data: existing } = useQuery({
    queryKey: ['voucher', voucherId],
    queryFn: () => api.vouchers.get(voucherId!),
    enabled: !!voucherId
  })
  const [typeId, setTypeId] = useState<number | null>(null)

  useEffect(() => {
    if (!types || typeId != null) return
    if (voucherId) return
    const wanted = kindHint ?? 'journal'
    const t = types.find((t) => t.kind === wanted) ?? types[0]
    if (t) setTypeId(t.id)
  }, [types, typeId, kindHint, voucherId])

  useEffect(() => {
    if (existing) setTypeId(existing.voucherTypeId)
  }, [existing])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const kind = FKEYS[e.key]
      if (!kind || voucherId || !types) return
      const withCtrl = e.ctrlKey || e.altKey
      const target = withCtrl && kind === 'sales' ? 'credit_note' : withCtrl && kind === 'purchase' ? 'debit_note' : kind
      const t = types.find((t) => t.kind === target)
      if (t) {
        e.preventDefault()
        setTypeId(t.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [types, voucherId])

  if (!types || (voucherId && !existing)) return <p className="text-muted">Loading…</p>
  const currentType = types.find((t) => t.id === typeId) ?? types[0]!
  const invoiceMode = !voucherId && TRADING_KINDS.includes(currentType.kind)
  const manufactureMode = !voucherId && currentType.kind === 'stock_journal'

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center gap-2">
        <h2 className="mr-3 font-serif text-[19px] font-semibold tracking-tight">
          {voucherId ? `Alter voucher ${existing?.number}` : 'Voucher entry'}
        </h2>
        {!voucherId &&
          types.filter((t) => t.kind !== 'physical_stock').map((t) => (
            <button
              key={t.id}
              onClick={() => setTypeId(t.id)}
              className={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${
                t.id === currentType.id ? 'bg-amber/20 text-amber' : 'text-muted hover:bg-panel2 hover:text-ink'
              }`}
            >
              {t.name}
            </button>
          ))}
      </div>
      {invoiceMode ? (
        <InvoiceEntry key={currentType.id} typeId={currentType.id} kind={currentType.kind} />
      ) : manufactureMode ? (
        <ManufactureEntry key={currentType.id} typeId={currentType.id} />
      ) : (
        <AccountingEntry key={voucherId ?? currentType.id} typeId={currentType.id} kind={currentType.kind} voucherId={voucherId} />
      )}
      <p className="mt-3 text-[11.5px] text-muted">
        <Kbd>F4</Kbd>–<Kbd>F9</Kbd> switch type · <Kbd>⌘↵</Kbd> save · <Kbd>Esc</Kbd> back · dates accept <span className="num">7</span>, <span className="num">7/4</span>, <span className="num">y</span>
      </p>
    </div>
  )
}

// ---------- shared header fields ----------

function useVoucherNumber(typeId: number, date: string, excludeId?: number): string {
  const { data } = useQuery({
    queryKey: ['nextNumber', typeId, date, excludeId],
    queryFn: () => api.vouchers.nextNumber(typeId, date, excludeId)
  })
  return data?.number ?? '…'
}

// ---------- invoice mode (sales / purchase / notes) ----------

interface ItemRow {
  itemId: number | null
  qtyText: string
  rate: number | null
}

function InvoiceEntry({ typeId, kind }: { typeId: number; kind: VoucherKind }): React.JSX.Element {
  const { info, workingDate, setWorkingDate } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const ledgers = useLedgers()
  const items = useStockItems()
  const { data: units } = useQuery({ queryKey: ['units'], queryFn: api.units.list })
  const { ensure: ensureTax, ensureRoundOff } = useTaxLedgers()

  const [date, setDate] = useState(workingDate)
  const [partyId, setPartyId] = useState<number | null>(null)
  const [accountId, setAccountId] = useState<number | null>(null)
  const [rows, setRows] = useState<ItemRow[]>([{ itemId: null, qtyText: '', rate: null }])
  const [narration, setNarration] = useState('')
  const [vehicleNo, setVehicleNo] = useState('')
  const [transporterId, setTransporterId] = useState('')
  const [distanceKm, setDistanceKm] = useState('')
  const [currencyCode, setCurrencyCode] = useState('')
  const [fxRateText, setFxRateText] = useState('')
  const { data: currencies } = useQuery({ queryKey: ['currencies'], queryFn: api.currencies.list })
  const [quickLedger, setQuickLedger] = useState<{ name: string; forParty: boolean } | null>(null)
  const [quickItem, setQuickItem] = useState<{ name: string; row: number } | null>(null)
  const [saving, setSaving] = useState(false)

  const number = useVoucherNumber(typeId, date)
  const isSalesSide = kind === 'sales' || kind === 'credit_note'
  const party = ledgers.find((l) => l.id === partyId) ?? null
  const account = ledgers.find((l) => l.id === accountId) ?? null

  const supply = supplyTypeFor(info!.stateCode, party?.stateCode ?? info!.stateCode)

  const fxRate = currencyCode && fxRateText.trim() ? Number(fxRateText) : null
  const fxActive = !!currencyCode && !!fxRate && Number.isFinite(fxRate) && fxRate > 0

  const computed = useMemo(() => {
    const itemMap = new Map(items.map((i) => [i.id, i]))
    const detail = rows
      .map((r) => {
        const item = r.itemId ? itemMap.get(r.itemId) : null
        const qtyMilli = Math.round(parseFloat(r.qtyText || '0') * 1000)
        if (!item || !Number.isFinite(qtyMilli) || qtyMilli <= 0 || r.rate == null) return null
        // Rates are typed in the invoice currency; books stay in ₹.
        const baseRate = fxActive ? Math.round(r.rate * fxRate!) : r.rate
        const amount = Math.round((qtyMilli * baseRate) / 1000)
        const rate = item.gstRate ?? account?.gstRate ?? 0
        const cessRate = item.cessRate ?? 0
        return { item, qtyMilli, ratePaise: baseRate, amount, rate, cessRate }
      })
      .filter((d): d is NonNullable<typeof d> => d !== null)

    const buckets = new Map<string, { rate: number; cessRate: number; taxable: number }>()
    for (const d of detail) {
      const key = `${d.rate}|${d.cessRate}`
      const b = buckets.get(key) ?? { rate: d.rate, cessRate: d.cessRate, taxable: 0 }
      b.taxable += d.amount
      buckets.set(key, b)
    }
    const breakups: GstBreakup[] = [...buckets.values()].map((b) => computeGst(b.taxable, b.rate, supply, b.cessRate))
    const gst = addBreakups(breakups)
    const rounded = roundToRupee(gst.total)
    return { detail, gst, rounded, roundDiff: rounded - gst.total }
  }, [rows, items, account, supply, fxActive, fxRate])

  const save = useCallback(async (andPdf = false): Promise<void> => {
    if (saving) return
    if (!partyId) return void toast.push('error', 'Pick the party account first')
    if (!accountId) return void toast.push('error', `Pick the ${isSalesSide ? 'sales' : 'purchase'} ledger`)
    if (computed.detail.length === 0) return void toast.push('error', 'Add at least one item line')
    setSaving(true)
    try {
      const { gst, rounded, roundDiff } = computed
      const lines: VoucherInputParsed['lines'] = []
      // Which way the party faces, per voucher kind.
      const partyDr = kind === 'sales' || kind === 'debit_note'
      lines.push({ ledgerId: partyId, drCr: partyDr ? 'dr' : 'cr', amount: rounded })
      const counter = partyDr ? 'cr' : 'dr'
      lines.push({ ledgerId: accountId, drCr: counter, amount: gst.taxable })
      if (gst.cgst > 0) lines.push({ ledgerId: await ensureTax('cgst'), drCr: counter, amount: gst.cgst })
      if (gst.sgst > 0) lines.push({ ledgerId: await ensureTax('sgst'), drCr: counter, amount: gst.sgst })
      if (gst.igst > 0) lines.push({ ledgerId: await ensureTax('igst'), drCr: counter, amount: gst.igst })
      if (gst.cess > 0) lines.push({ ledgerId: await ensureTax('cess'), drCr: counter, amount: gst.cess })
      if (roundDiff !== 0) {
        lines.push({
          ledgerId: await ensureRoundOff(),
          drCr: roundDiff > 0 ? counter : partyDr ? 'dr' : 'cr',
          amount: Math.abs(roundDiff)
        })
      }
      // A round-down leaves the counter side heavier — the Round Off line balances the party side.
      if (roundDiff < 0) {
        const idx = lines.length - 1
        lines[idx] = { ...lines[idx]!, drCr: partyDr ? 'dr' : 'cr' }
      }
      const goodsIn = kind === 'purchase' || kind === 'credit_note'
      const input: VoucherInputParsed = {
        voucherTypeId: typeId,
        date,
        partyLedgerId: partyId,
        narration: narration.trim() || null,
        reference: null,
        instrumentNo: null,
        instrumentDate: null,
        transporterId: transporterId.trim() || null,
        vehicleNo: vehicleNo.trim().toUpperCase() || null,
        transportDistanceKm: distanceKm.trim() ? Number(distanceKm) : null,
        currencyCode: fxActive ? currencyCode : null,
        exchangeRate: fxActive ? fxRate : null,
        lines,
        inventory: computed.detail.map((d) => ({
          stockItemId: d.item.id,
          godownId: null,
          qtyMilli: d.qtyMilli,
          ratePaise: d.ratePaise,
          amount: d.amount,
          direction: goodsIn ? ('in' as const) : ('out' as const)
        }))
      }
      const dupes = await api.vouchers.duplicates(input)
      if (dupes.length > 0) {
        const first = dupes[0]!
        const proceed = window.confirm(
          `Possible duplicate: voucher ${first.number} on ${first.date} has the same party and amount. Save anyway?`
        )
        if (!proceed) return
      }
      const saved = await api.vouchers.save(input)
      toast.push('success', `${saved.number} saved — ${formatPaise(rounded, { symbol: true })}`)
      if (andPdf && kind === 'sales') {
        await api.invoice.pdf(saved.id)
      }
      setWorkingDate(date)
      setPartyId(null)
      setRows([{ itemId: null, qtyText: '', rate: null }])
      setNarration('')
      setVehicleNo('')
      setDistanceKm('')
      await queryClient.invalidateQueries()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [saving, partyId, accountId, computed, kind, typeId, date, narration, vehicleNo, transporterId, distanceKm, fxActive, fxRate, currencyCode, isSalesSide, ensureTax, ensureRoundOff, toast, setWorkingDate, queryClient, nav])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  const setRow = (i: number, patch: Partial<ItemRow>): void => {
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r))
      const last = next[next.length - 1]!
      if (last.itemId != null) next.push({ itemId: null, qtyText: '', rate: null })
      return next
    })
  }

  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const unitOf = (itemId: number | null): string => {
    if (!itemId || !units) return ''
    const item = itemMap.get(itemId)
    return units.find((u) => u.id === item?.unitId)?.symbol ?? ''
  }

  return (
    <Panel className="p-5">
      <div className="grid grid-cols-4 gap-3">
        <Field label="No.">
          <div className={`${inputCls} num bg-panel text-muted`}>{number}</div>
        </Field>
        <Field label="Date">
          <DateInput value={date} context={workingDate} onChange={setDate} />
        </Field>
        <Field label={isSalesSide ? 'Party (buyer)' : 'Party (supplier)'}>
          <LedgerPicker
            autoFocus
            value={partyId}
            onPick={setPartyId}
            placeholder="Party ledger"
            onCreateRequest={(name) => setQuickLedger({ name, forParty: true })}
          />
        </Field>
        <Field label={isSalesSide ? 'Sales ledger' : 'Purchase ledger'}>
          <LedgerPicker
            value={accountId}
            onPick={setAccountId}
            placeholder={isSalesSide ? 'e.g. Sales' : 'e.g. Purchases'}
            filter={(l, groups) => {
              const rootName = isSalesSide ? 'Sales Accounts' : 'Purchase Accounts'
              let g = groups.get(l.groupId)
              while (g) {
                if (g.name === rootName) return true
                g = g.parentId ? groups.get(g.parentId) : undefined
              }
              return false
            }}
            onCreateRequest={(name) => setQuickLedger({ name, forParty: false })}
          />
        </Field>
      </div>

      <div className="mt-2 flex items-center justify-between">
        {party ? (
          <p className="text-[11.5px] text-muted">
            {party.gstin ? <>GSTIN <span className="num">{party.gstin}</span> · </> : 'Unregistered · '}
            {supply === 'intra' ? 'Intra-state — CGST + SGST' : 'Inter-state — IGST'}
          </p>
        ) : (
          <span />
        )}
        {(currencies?.length ?? 0) > 0 && (
          <div className="flex items-center gap-2">
            <Select value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} className="w-28">
              <option value="">₹ INR</option>
              {(currencies ?? []).map((c) => (
                <option key={c.id} value={c.code}>
                  {c.symbol} {c.code}
                </option>
              ))}
            </Select>
            {currencyCode && (
              <>
                <TextInput
                  value={fxRateText}
                  onChange={(e) => setFxRateText(e.target.value)}
                  placeholder={`₹ per ${currencyCode}`}
                  className="num w-28 text-right"
                />
                {fxActive && <span className="text-[11px] text-muted">rates in {currencyCode} · books in ₹</span>}
              </>
            )}
          </div>
        )}
      </div>

      <table className="ledger-table mt-4">
        <thead>
          <tr>
            <th>Item</th>
            <th className="r w-28">Qty</th>
            <th className="r w-32">Rate</th>
            <th className="r w-24">GST %</th>
            <th className="r w-36">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const item = r.itemId ? itemMap.get(r.itemId) : null
            const qty = parseFloat(r.qtyText || '0')
            const amount = item && qty > 0 && r.rate != null ? Math.round(qty * r.rate) : 0
            return (
              <tr key={i}>
                <td>
                  <ItemPicker
                    value={r.itemId}
                    onPick={(id) => {
                      const picked = id ? itemMap.get(id) : null
                      setRow(i, { itemId: id, rate: r.rate ?? (picked ? undefined : null) })
                    }}
                    onCreateRequest={(name) => setQuickItem({ name, row: i })}
                  />
                </td>
                <td className="r">
                  <div className="flex items-center gap-1.5">
                    <input
                      className={`${inputCls} num text-right`}
                      value={r.qtyText}
                      inputMode="decimal"
                      placeholder="0"
                      onChange={(e) => setRow(i, { qtyText: e.target.value })}
                    />
                    <span className="w-8 text-[11px] text-muted">{unitOf(r.itemId)}</span>
                  </div>
                </td>
                <td className="r">
                  <AmountInput paise={r.rate} onPaise={(p) => setRow(i, { rate: p })} />
                </td>
                <td className="r">
                  <span className="num text-[12.5px] text-muted">{item ? `${item.gstRate ?? account?.gstRate ?? 0}%` : ''}</span>
                </td>
                <td className="r">
                  <Money paise={amount} className="text-[13.5px]" />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div className="mt-4 flex items-start justify-between gap-6">
        <div className="flex-1">
          <Field label="Narration">
            <TextInput value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="Being goods sold…" />
          </Field>
          {isSalesSide && kind === 'sales' && (
            <div className="mt-3 grid grid-cols-3 gap-3">
              <Field label="Vehicle no.">
                <TextInput value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value.toUpperCase())} placeholder="MH01AB1234" className="num" />
              </Field>
              <Field label="Transporter ID">
                <TextInput value={transporterId} onChange={(e) => setTransporterId(e.target.value.toUpperCase())} placeholder="For e-way bill" className="num" />
              </Field>
              <Field label="Distance km">
                <TextInput value={distanceKm} onChange={(e) => setDistanceKm(e.target.value)} placeholder="0" className="num text-right" />
              </Field>
            </div>
          )}
          {computed.rounded > 0 && (
            <p className="mt-2 text-[11.5px] text-muted italic">{amountInWords(computed.rounded)}</p>
          )}
        </div>
        <div className="num w-72 text-[13px]">
          <SummaryRow label="Taxable value" paise={computed.gst.taxable} />
          {computed.gst.cgst > 0 && <SummaryRow label="CGST" paise={computed.gst.cgst} />}
          {computed.gst.sgst > 0 && <SummaryRow label="SGST" paise={computed.gst.sgst} />}
          {computed.gst.igst > 0 && <SummaryRow label="IGST" paise={computed.gst.igst} />}
          {computed.gst.cess > 0 && <SummaryRow label="Cess" paise={computed.gst.cess} />}
          {computed.roundDiff !== 0 && <SummaryRow label="Round off" paise={computed.roundDiff} />}
          <div className="mt-1 flex justify-between border-t border-ink pt-1.5 pb-0.5 text-[15px] font-semibold" style={{ borderBottom: '3px double var(--color-ink)' }}>
            <span>Total</span>
            <Money paise={computed.rounded} />
          </div>
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={() => nav.back()}>Cancel</Button>
        {kind === 'sales' && (
          <Button disabled={saving} onClick={() => void save(true)}>
            Save + invoice PDF
          </Button>
        )}
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          Save voucher ⌘↵
        </Button>
      </div>

      {quickLedger && (
        <QuickLedgerModal
          name={quickLedger.name}
          suggestParty={quickLedger.forParty ? isSalesSide : null}
          suggestAccount={!quickLedger.forParty ? isSalesSide : null}
          onClose={() => setQuickLedger(null)}
          onCreated={(l) => {
            if (quickLedger.forParty) setPartyId(l.id)
            else setAccountId(l.id)
            setQuickLedger(null)
          }}
        />
      )}
      {quickItem && (
        <QuickItemModal
          name={quickItem.name}
          onClose={() => setQuickItem(null)}
          onCreated={(id) => {
            setRow(quickItem.row, { itemId: id })
            setQuickItem(null)
          }}
        />
      )}
    </Panel>
  )
}

function SummaryRow({ label, paise }: { label: string; paise: number }): React.JSX.Element {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-muted">{label}</span>
      <Money paise={paise} />
    </div>
  )
}

// ---------- manufacture mode (stock journal via BOM) ----------

function ManufactureEntry({ typeId }: { typeId: number }): React.JSX.Element {
  const { workingDate, setWorkingDate, to } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const items = useStockItems()
  const [date, setDate] = useState(workingDate)
  const [producedId, setProducedId] = useState<number | null>(null)
  const [qtyText, setQtyText] = useState('1')
  const [extraPctText, setExtraPctText] = useState('0')
  const [saving, setSaving] = useState(false)
  const number = useVoucherNumber(typeId, date)

  const { data: bom } = useQuery({
    queryKey: ['bom', producedId],
    queryFn: () => api.bom.get(producedId!),
    enabled: !!producedId
  })
  const { data: stock } = useQuery({
    queryKey: ['stockSummary', to],
    queryFn: () => api.reports.stockSummary(to)
  })

  const qty = Number(qtyText) || 0
  const extraPct = Number(extraPctText) || 0
  const avgCost = (itemId: number): number => {
    const row = stock?.find((s) => s.stockItemId === itemId)
    if (!row || row.closingQtyMilli <= 0) return 0
    return Math.round((row.closingValue * 1000) / row.closingQtyMilli) // paise per whole unit
  }

  const consumption = (bom ?? []).map((line) => {
    const useMilli = Math.round(line.qtyMilliPerUnit * qty)
    const rate = avgCost(line.componentId)
    return { ...line, useMilli, rate, amount: Math.round((useMilli * rate) / 1000) }
  })
  const consumedTotal = consumption.reduce((s, c) => s + c.amount, 0)
  const producedValue = Math.round(consumedTotal * (1 + extraPct / 100))

  const save = async (): Promise<void> => {
    if (saving) return
    if (!producedId) return void toast.push('error', 'Pick the item to produce')
    if (!bom?.length) return void toast.push('error', 'This item has no bill of materials — set it in Masters → Stock items')
    if (qty <= 0) return void toast.push('error', 'Quantity must be positive')
    setSaving(true)
    try {
      const qtyMilli = Math.round(qty * 1000)
      const saved = await api.vouchers.save({
        voucherTypeId: typeId,
        date,
        partyLedgerId: null,
        narration: `Manufactured ${qty} × ${items.find((i) => i.id === producedId)?.name ?? ''}`.trim(),
        reference: null,
        instrumentNo: null,
        instrumentDate: null,
        transporterId: null,
        vehicleNo: null,
        transportDistanceKm: null,
        currencyCode: null,
        exchangeRate: null,
        lines: [],
        inventory: [
          ...consumption.map((c) => ({
            stockItemId: c.componentId,
            godownId: null,
            qtyMilli: c.useMilli,
            ratePaise: c.rate,
            amount: c.amount,
            direction: 'out' as const
          })),
          {
            stockItemId: producedId,
            godownId: null,
            qtyMilli,
            ratePaise: Math.round((producedValue * 1000) / qtyMilli),
            amount: producedValue,
            direction: 'in' as const
          }
        ]
      })
      toast.push('success', `Manufacture ${saved.number} saved — ${formatPaise(producedValue, { symbol: true })} into stock`)
      setWorkingDate(date)
      setProducedId(null)
      setQtyText('1')
      await queryClient.invalidateQueries()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel className="p-5">
      <div className="grid grid-cols-4 gap-3">
        <Field label="No.">
          <div className={`${inputCls} num bg-panel text-muted`}>{number}</div>
        </Field>
        <Field label="Date">
          <DateInput value={date} context={workingDate} onChange={setDate} />
        </Field>
        <Field label="Produce (needs a BOM)">
          <ItemPicker value={producedId} onPick={setProducedId} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Qty">
            <TextInput value={qtyText} onChange={(e) => setQtyText(e.target.value)} className="num text-right" />
          </Field>
          <Field label="Overhead %">
            <TextInput value={extraPctText} onChange={(e) => setExtraPctText(e.target.value)} className="num text-right" />
          </Field>
        </div>
      </div>

      {producedId && !bom?.length && (
        <p className="mt-3 text-[12.5px] text-amber">
          No bill of materials on this item yet — add components in Masters → Stock items → Edit.
        </p>
      )}

      {consumption.length > 0 && (
        <table className="ledger-table mt-4">
          <thead>
            <tr>
              <th>Consumes</th>
              <th className="r w-32">Qty</th>
              <th className="r w-32">Avg cost</th>
              <th className="r w-36">Amount</th>
            </tr>
          </thead>
          <tbody>
            {consumption.map((c) => (
              <tr key={c.componentId} className={c.rate === 0 ? 'text-cr' : ''}>
                <td>
                  {c.componentName}
                  {c.rate === 0 && <span className="ml-2 text-[11px]">no stock cost — purchase it first</span>}
                </td>
                <td className="r num">{c.useMilli / 1000} {c.unitSymbol}</td>
                <td className="r"><Money paise={c.rate} /></td>
                <td className="r"><Money paise={c.amount} /></td>
              </tr>
            ))}
            <tr className="total-row">
              <td colSpan={3}>Into stock (incl. {extraPct}% overhead)</td>
              <td className="r"><Money paise={producedValue} /></td>
            </tr>
          </tbody>
        </table>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={() => nav.back()}>Cancel</Button>
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          Save manufacture
        </Button>
      </div>
    </Panel>
  )
}

// ---------- accounting mode (payment / receipt / contra / journal + alteration) ----------

interface AcctRow {
  drCr: 'dr' | 'cr'
  ledgerId: number | null
  amount: number | null
}

function AccountingEntry({ typeId, kind, voucherId }: { typeId: number; kind: VoucherKind; voucherId?: number }): React.JSX.Element {
  const { workingDate, setWorkingDate } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const [date, setDate] = useState(workingDate)
  const [rows, setRows] = useState<AcctRow[]>([
    { drCr: 'dr', ledgerId: null, amount: null },
    { drCr: 'cr', ledgerId: null, amount: null }
  ])
  const [narration, setNarration] = useState('')
  const [instrumentNo, setInstrumentNo] = useState('')
  const [quickLedger, setQuickLedger] = useState<{ name: string; row: number } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const number = useVoucherNumber(typeId, date, voucherId)

  const { data: existing } = useQuery({
    queryKey: ['voucher', voucherId],
    queryFn: () => api.vouchers.get(voucherId!),
    enabled: !!voucherId
  })

  useEffect(() => {
    if (existing && !loaded) {
      setDate(existing.date)
      setNarration(existing.narration ?? '')
      setInstrumentNo(existing.instrumentNo ?? '')
      setRows(existing.lines.map((l) => ({ drCr: l.drCr, ledgerId: l.ledgerId, amount: l.amount })))
      setLoaded(true)
    }
  }, [existing, loaded])

  const totalDr = rows.reduce((s, r) => s + (r.drCr === 'dr' ? (r.amount ?? 0) : 0), 0)
  const totalCr = rows.reduce((s, r) => s + (r.drCr === 'cr' ? (r.amount ?? 0) : 0), 0)
  const balanced = totalDr === totalCr && totalDr > 0

  const setRow = (i: number, patch: Partial<AcctRow>): void => {
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r))
      const last = next[next.length - 1]!
      if (last.ledgerId != null) next.push({ drCr: 'cr', ledgerId: null, amount: null })
      return next
    })
  }

  const save = useCallback(async (): Promise<void> => {
    if (saving) return
    const lines = rows
      .filter((r) => r.ledgerId != null && r.amount != null && r.amount > 0)
      .map((r) => ({ ledgerId: r.ledgerId!, drCr: r.drCr, amount: r.amount! }))
    if (lines.length < 2) return void toast.push('error', 'Enter at least one debit and one credit')
    setSaving(true)
    try {
      const input: VoucherInputParsed = {
        voucherTypeId: typeId,
        date,
        partyLedgerId: null,
        narration: narration.trim() || null,
        reference: null,
        instrumentNo: instrumentNo.trim() || null,
        instrumentDate: instrumentNo.trim() ? date : null,
        transporterId: existing?.transporterId ?? null,
        vehicleNo: existing?.vehicleNo ?? null,
        transportDistanceKm: existing?.transportDistanceKm ?? null,
        currencyCode: existing?.currencyCode ?? null,
        exchangeRate: existing?.exchangeRate ?? null,
        lines,
        inventory: existing?.inventory.map((l) => ({
          stockItemId: l.stockItemId, godownId: l.godownId, qtyMilli: l.qtyMilli,
          ratePaise: l.ratePaise, amount: l.amount, direction: l.direction
        })) ?? []
      }
      // Anomaly nudge on the largest line — a quiet second look, never a block.
      const largest = [...lines].sort((a, b) => b.amount - a.amount)[0]!
      const anomaly = await api.intel.anomaly(largest.ledgerId, largest.amount)
      if (anomaly.unusual && anomaly.typicalAmount != null) {
        const proceed = window.confirm(
          `${formatPaise(largest.amount, { symbol: true })} is far above this ledger's usual ${formatPaise(anomaly.typicalAmount, { symbol: true })}. Save anyway?`
        )
        if (!proceed) return
      }
      const saved = await api.vouchers.save(input, voucherId)
      toast.push('success', `${saved.number} ${voucherId ? 'altered' : 'saved'}`)
      setWorkingDate(date)
      await queryClient.invalidateQueries()
      if (voucherId) nav.back()
      else {
        setRows([
          { drCr: 'dr', ledgerId: null, amount: null },
          { drCr: 'cr', ledgerId: null, amount: null }
        ])
        setNarration('')
      }
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [saving, rows, typeId, date, narration, instrumentNo, existing, voucherId, toast, setWorkingDate, queryClient, nav])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  const remove = async (): Promise<void> => {
    if (!voucherId) return
    if (!window.confirm('Delete this voucher? The audit log keeps a copy.')) return
    await api.vouchers.remove(voucherId)
    toast.push('success', 'Voucher deleted')
    await queryClient.invalidateQueries()
    nav.back()
  }

  return (
    <Panel className="p-5">
      <div className="grid grid-cols-4 gap-3">
        <Field label="No.">
          <div className={`${inputCls} num bg-panel text-muted`}>{voucherId ? (existing?.number ?? '…') : number}</div>
        </Field>
        <Field label="Date">
          <DateInput value={date} context={workingDate} onChange={setDate} />
        </Field>
        <div className="col-span-2 flex items-end justify-end">
          <p className={`num text-[12.5px] ${balanced ? 'text-dr' : 'text-muted'}`}>
            Dr {formatPaise(totalDr)} · Cr {formatPaise(totalCr)}
            {!balanced && totalDr + totalCr > 0 && (
              <span className="text-cr"> · off by {formatPaise(Math.abs(totalDr - totalCr))}</span>
            )}
          </p>
        </div>
      </div>

      <table className="ledger-table mt-4">
        <thead>
          <tr>
            <th className="w-20">Dr / Cr</th>
            <th>Particulars</th>
            <th className="r w-44">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <button
                  className={`num w-12 rounded-md border border-line px-2 py-1 text-[12.5px] font-medium ${
                    r.drCr === 'dr' ? 'text-dr' : 'text-cr'
                  }`}
                  onClick={() => setRow(i, { drCr: r.drCr === 'dr' ? 'cr' : 'dr' })}
                  title="Toggle Dr/Cr"
                >
                  {r.drCr === 'dr' ? 'Dr' : 'Cr'}
                </button>
              </td>
              <td>
                <LedgerPicker
                  value={r.ledgerId}
                  onPick={(id) => setRow(i, { ledgerId: id })}
                  autoFocus={i === 0 && !voucherId}
                  filter={
                    kind === 'contra'
                      ? (l, groups) => {
                          let g = groups.get(l.groupId)
                          while (g) {
                            if (['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c'].includes(g.name)) return true
                            g = g.parentId ? groups.get(g.parentId) : undefined
                          }
                          return false
                        }
                      : undefined
                  }
                  onCreateRequest={(name) => setQuickLedger({ name, row: i })}
                />
              </td>
              <td className="r">
                <AmountInput
                  paise={r.amount}
                  onPaise={(p) => setRow(i, { amount: p })}
                />
              </td>
            </tr>
          ))}
          <tr className="total-row">
            <td></td>
            <td>Total</td>
            <td className="r">
              <span className="num">{formatPaise(Math.max(totalDr, totalCr))}</span>
            </td>
          </tr>
        </tbody>
      </table>

      {existing && existing.inventory.length > 0 && (
        <p className="mt-3 text-[12px] text-muted">
          This voucher carries {existing.inventory.length} stock line{existing.inventory.length > 1 ? 's' : ''}; they are kept as-is when you save.
        </p>
      )}

      <div className={`mt-4 ${kind === 'payment' || kind === 'receipt' ? 'grid grid-cols-3 gap-3' : ''}`}>
        <div className={kind === 'payment' || kind === 'receipt' ? 'col-span-2' : ''}>
          <Field label="Narration">
            <TextInput value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="Being amount paid…" />
          </Field>
        </div>
        {(kind === 'payment' || kind === 'receipt') && (
          <Field label="Cheque / UTR no." hint="Shows up in bank reconciliation">
            <TextInput value={instrumentNo} onChange={(e) => setInstrumentNo(e.target.value)} className="num" />
          </Field>
        )}
      </div>

      <div className="mt-5 flex justify-between">
        <div>{voucherId && <Button variant="danger" onClick={() => void remove()}>Delete voucher</Button>}</div>
        <div className="flex gap-2">
          <Button onClick={() => nav.back()}>Cancel</Button>
          <Button variant="primary" disabled={!balanced || saving} onClick={() => void save()}>
            {voucherId ? 'Save changes' : 'Save voucher'} ⌘↵
          </Button>
        </div>
      </div>

      {quickLedger && (
        <QuickLedgerModal
          name={quickLedger.name}
          suggestParty={null}
          suggestAccount={null}
          onClose={() => setQuickLedger(null)}
          onCreated={(l) => {
            setRow(quickLedger.row, { ledgerId: l.id })
            setQuickLedger(null)
          }}
        />
      )}
    </Panel>
  )
}

// ---------- quick-create modals ----------

export function QuickLedgerModal({
  name,
  suggestParty,
  suggestAccount,
  onClose,
  onCreated
}: {
  name: string
  /** true → Sundry Debtors, false → Sundry Creditors, null → no preselect */
  suggestParty: boolean | null
  suggestAccount: boolean | null
  onClose: () => void
  onCreated: (ledger: Ledger) => void
}): React.JSX.Element {
  const groups = useGroups()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const defaultGroup =
    suggestParty != null
      ? groups.find((g) => g.name === (suggestParty ? 'Sundry Debtors' : 'Sundry Creditors'))
      : suggestAccount != null
        ? groups.find((g) => g.name === (suggestAccount ? 'Sales Accounts' : 'Purchase Accounts'))
        : null
  const [ledgerName, setLedgerName] = useState(name)
  const [groupId, setGroupId] = useState<number | null>(defaultGroup?.id ?? null)
  useEffect(() => {
    if (groupId == null && defaultGroup) setGroupId(defaultGroup.id)
  }, [defaultGroup, groupId])
  const [gstin, setGstin] = useState('')
  const [gstRate, setGstRate] = useState('')

  const create = async (): Promise<void> => {
    try {
      if (!groupId) return void toast.push('error', 'Pick a group')
      const l = await api.ledgers.create({
        name: ledgerName.trim(),
        groupId,
        openingBalance: 0,
        gstin: gstin.trim() ? gstin.trim().toUpperCase() : null,
        stateCode: gstin.trim().length >= 2 ? gstin.trim().slice(0, 2) : null,
        address: null,
        taxType: null,
        gstRate: gstRate.trim() ? Number(gstRate) : null,
        hsn: null
      })
      await queryClient.invalidateQueries({ queryKey: ['ledgers'] })
      toast.push('success', `Ledger “${l.name}” created`)
      onCreated(l)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="New ledger" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput autoFocus value={ledgerName} onChange={(e) => setLedgerName(e.target.value)} />
        </Field>
        <Field label="Under group">
          <Select value={groupId ?? ''} onChange={(e) => setGroupId(Number(e.target.value))}>
            <option value="" disabled>
              Choose…
            </option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="GSTIN (parties)">
            <TextInput value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} className="num" placeholder="Optional" />
          </Field>
          <Field label="GST rate % (sales/purchase)">
            <TextInput value={gstRate} onChange={(e) => setGstRate(e.target.value)} className="num" placeholder="Optional" />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()}>
            Create ledger
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function QuickItemModal({
  name,
  onClose,
  onCreated
}: {
  name: string
  onClose: () => void
  onCreated: (id: number) => void
}): React.JSX.Element {
  const { data: units } = useQuery({ queryKey: ['units'], queryFn: api.units.list })
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [itemName, setItemName] = useState(name)
  const [unitId, setUnitId] = useState<number | null>(null)
  const [hsn, setHsn] = useState('')
  const [rate, setRate] = useState('18')

  useEffect(() => {
    if (unitId == null && units?.length) setUnitId(units[0]!.id)
  }, [units, unitId])

  const create = async (): Promise<void> => {
    try {
      if (!unitId) return void toast.push('error', 'Pick a unit')
      const item = await api.stockItems.create({
        name: itemName.trim(),
        groupId: null,
        unitId,
        hsn: hsn.trim() || null,
        gstRate: rate.trim() ? Number(rate) : null,
        cessRate: null,
        openingQtyMilli: 0,
        openingValue: 0
      })
      await queryClient.invalidateQueries({ queryKey: ['stockItems'] })
      toast.push('success', `Item “${item.name}” created`)
      onCreated(item.id)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="New stock item" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput autoFocus value={itemName} onChange={(e) => setItemName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Unit">
            <Select value={unitId ?? ''} onChange={(e) => setUnitId(Number(e.target.value))}>
              {(units ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.symbol}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="HSN">
            <TextInput value={hsn} onChange={(e) => setHsn(e.target.value)} className="num" placeholder="8471" />
          </Field>
          <Field label="GST %">
            <TextInput value={rate} onChange={(e) => setRate(e.target.value)} className="num" />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()}>
            Create item
          </Button>
        </div>
      </div>
    </Modal>
  )
}
