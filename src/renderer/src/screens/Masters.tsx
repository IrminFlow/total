import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Ledger, StockItem, VoucherType } from '@shared/domain'
import type { GroupTreeNode } from '@shared/reports'
import { api } from '../lib/client'
import { useNav, useToasts } from '../state/stores'
import { AmountInput, Button, EmptyState, Field, Modal, Money, Panel, SectionTitle, Select, TextInput } from '../components/ui'
import { useGroups, useLedgers, useStockItems } from '../components/pickers'
import { LedgerFormModal } from '../components/LedgerFormModal'
import { validateHsn } from '@shared/gst/validate'

type Tab = 'ledgers' | 'groups' | 'items' | 'units' | 'types' | 'currencies'
const TABS: { id: Tab; label: string }[] = [
  { id: 'ledgers', label: 'Ledgers' },
  { id: 'groups', label: 'Groups' },
  { id: 'items', label: 'Stock items' },
  { id: 'units', label: 'Units' },
  { id: 'types', label: 'Voucher types' },
  { id: 'currencies', label: 'Currencies' }
]

export function Masters({ tab: initialTab }: { tab?: Tab }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'ledgers')
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center gap-1">
        <h2 className="mr-4 font-serif text-[19px] font-semibold tracking-tight">Masters</h2>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-md px-3 py-1.5 text-[13px] ${tab === t.id ? 'bg-amber/15 text-amber' : 'text-muted hover:bg-panel2 hover:text-ink'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'ledgers' && <LedgersTab />}
      {tab === 'groups' && <GroupsTab />}
      {tab === 'items' && <ItemsTab />}
      {tab === 'units' && <UnitsTab />}
      {tab === 'types' && <TypesTab />}
      {tab === 'currencies' && <CurrenciesTab />}
    </div>
  )
}

// ---------- currencies ----------

function CurrenciesTab(): React.JSX.Element {
  const { data: currencies } = useQuery({ queryKey: ['currencies'], queryFn: api.currencies.list })
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [code, setCode] = useState('')
  const [symbol, setSymbol] = useState('')
  const [name, setName] = useState('')

  const create = async (): Promise<void> => {
    try {
      await api.currencies.create({ code: code.trim().toUpperCase(), symbol: symbol.trim(), name: name.trim(), decimals: 2 })
      await queryClient.invalidateQueries({ queryKey: ['currencies'] })
      toast.push('success', `${code.toUpperCase()} added`)
      setCreating(false)
      setCode(''); setSymbol(''); setName('')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" onClick={() => setCreating(true)}>
          Add currency
        </Button>
      </div>
      <Panel>
        {!currencies?.length ? (
          <EmptyState title="Base books are in ₹ (INR)" hint="Add USD, EUR… to raise foreign-currency invoices with an exchange rate" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th className="w-24">Code</th>
                <th className="w-24">Symbol</th>
                <th>Name</th>
                <th className="w-20"></th>
              </tr>
            </thead>
            <tbody>
              {currencies.map((c) => (
                <tr key={c.id}>
                  <td className="num">{c.code}</td>
                  <td>{c.symbol}</td>
                  <td className="text-muted">{c.name}</td>
                  <td className="r">
                    <button
                      className="text-[12px] text-cr hover:underline"
                      onClick={async () => {
                        try {
                          await api.currencies.remove(c.id)
                          await queryClient.invalidateQueries({ queryKey: ['currencies'] })
                        } catch (err) {
                          toast.push('error', (err as Error).message)
                        }
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {creating && (
        <Modal title="Add currency" onClose={() => setCreating(false)}>
          <div className="grid grid-cols-3 gap-3">
            <Field label="ISO code">
              <TextInput autoFocus value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="USD" className="num" />
            </Field>
            <Field label="Symbol">
              <TextInput value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="$" />
            </Field>
            <Field label="Name">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="US Dollar" />
            </Field>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void create()}>
              Add currency
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}

// ---------- ledgers ----------

function LedgersTab(): React.JSX.Element {
  const ledgers = useLedgers()
  const groups = useGroups()
  const nav = useNav()
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<Ledger | 'new' | null>(null)
  const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups])

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? ledgers.filter((l) => l.name.toLowerCase().includes(q)) : ledgers
  }, [ledgers, filter])

  return (
    <>
      <div className="mb-3 flex justify-between">
        <TextInput value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Type to filter…" className="w-64" />
        <Button variant="primary" onClick={() => setEditing('new')}>
          New ledger
        </Button>
      </div>
      <Panel>
        {rows.length === 0 ? (
          <EmptyState title="No ledgers match" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Group</th>
                <th>GSTIN</th>
                <th className="r w-40">Opening</th>
                <th className="w-24"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id} className="hover:bg-panel2">
                  <td className="cursor-pointer" onClick={() => nav.go({ name: 'ledger-statement', ledgerId: l.id })}>
                    {l.name}
                  </td>
                  <td className="text-muted">{groupMap.get(l.groupId)}</td>
                  <td className="num text-muted">{l.gstin ?? ''}</td>
                  <td className="r">
                    <Money paise={l.openingBalance} signed />
                  </td>
                  <td className="r">
                    <button className="text-[12px] text-blue hover:underline" onClick={() => setEditing(l)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {editing && <LedgerFormModal ledger={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  )
}

// ---------- groups ----------

function GroupsTab(): React.JSX.Element {
  const { data: tree } = useQuery({ queryKey: ['groupTree'], queryFn: api.groups.tree })
  const groups = useGroups()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState<number | null>(null)

  const create = async (): Promise<void> => {
    try {
      if (!parentId) return void toast.push('error', 'Pick a parent group')
      await api.groups.create({ name: name.trim(), parentId })
      await queryClient.invalidateQueries()
      toast.push('success', 'Group created')
      setCreating(false)
      setName('')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" onClick={() => setCreating(true)}>
          New sub-group
        </Button>
      </div>
      <Panel className="p-4">
        {(tree ?? []).map((node) => (
          <GroupNode key={node.id} node={node} depth={0} />
        ))}
      </Panel>
      {creating && (
        <Modal title="New sub-group" onClose={() => setCreating(false)}>
          <div className="flex flex-col gap-3">
            <Field label="Name">
              <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Under" hint="The new group inherits its parent's nature">
              <Select value={parentId ?? ''} onChange={(e) => setParentId(Number(e.target.value))}>
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
            <div className="flex justify-end gap-2">
              <Button onClick={() => setCreating(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => void create()}>
                Create group
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

function GroupNode({ node, depth }: { node: GroupTreeNode; depth: number }): React.JSX.Element {
  const natureTone = { asset: 'text-dr', liability: 'text-cr', income: 'text-blue', expense: 'text-amber' }[node.nature]
  return (
    <>
      <div className="flex items-center justify-between rounded px-2 py-1 hover:bg-panel2" style={{ paddingLeft: `${8 + depth * 18}px` }}>
        <span className={`text-[13px] ${depth === 0 ? 'font-medium' : 'text-muted'}`}>{node.name}</span>
        {depth === 0 && <span className={`text-[10.5px] uppercase tracking-wider ${natureTone}`}>{node.nature}</span>}
      </div>
      {node.children.map((c) => (
        <GroupNode key={c.id} node={c} depth={depth + 1} />
      ))}
    </>
  )
}

// ---------- stock items ----------

function ItemsTab(): React.JSX.Element {
  const items = useStockItems()
  const { data: units } = useQuery({ queryKey: ['units'], queryFn: api.units.list })
  const [editing, setEditing] = useState<StockItem | 'new' | null>(null)
  const unitMap = new Map((units ?? []).map((u) => [u.id, u.symbol]))

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" onClick={() => setEditing('new')}>
          New item
        </Button>
      </div>
      <Panel>
        {items.length === 0 ? (
          <EmptyState title="No stock items yet" hint="Items carry HSN and GST rate so invoices compute tax on their own" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="w-16">Unit</th>
                <th className="w-24">HSN</th>
                <th className="r w-20">GST %</th>
                <th className="r w-28">Opening qty</th>
                <th className="w-20"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="hover:bg-panel2">
                  <td>{i.name}</td>
                  <td className="text-muted">{unitMap.get(i.unitId)}</td>
                  <td className="num text-muted">{i.hsn ?? ''}</td>
                  <td className="r num">{i.gstRate ?? '–'}</td>
                  <td className="r num">{(i.openingQtyMilli / 1000).toString()}</td>
                  <td className="r">
                    <button className="text-[12px] text-blue hover:underline" onClick={() => setEditing(i)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {editing && <ItemFormModal item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  )
}

function ItemFormModal({ item, onClose }: { item: StockItem | null; onClose: () => void }): React.JSX.Element {
  const { data: units } = useQuery({ queryKey: ['units'], queryFn: api.units.list })
  const allItems = useStockItems()
  const { data: bom } = useQuery({
    queryKey: ['bom', item?.id],
    queryFn: () => api.bom.get(item!.id),
    enabled: !!item
  })
  const [bomRows, setBomRows] = useState<{ componentId: number | ''; qtyText: string }[] | null>(null)
  const effectiveBomRows =
    bomRows ?? (bom ? bom.map((b) => ({ componentId: b.componentId as number | '', qtyText: String(b.qtyMilliPerUnit / 1000) })) : [])
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [name, setName] = useState(item?.name ?? '')
  const [unitId, setUnitId] = useState<number | null>(item?.unitId ?? null)
  const [hsn, setHsn] = useState(item?.hsn ?? '')
  const [gstRate, setGstRate] = useState(item?.gstRate?.toString() ?? '')
  const [cessRate, setCessRate] = useState(item?.cessRate?.toString() ?? '')
  const [openQty, setOpenQty] = useState(item ? (item.openingQtyMilli / 1000).toString() : '')
  const [openValue, setOpenValue] = useState<number | null>(item?.openingValue ?? null)
  const [barcode, setBarcode] = useState(item?.barcode ?? '')

  const hsnCheck = hsn.trim() ? validateHsn(hsn) : null
  const hsnError = hsnCheck && !hsnCheck.valid ? hsnCheck.error : null

  if (units && unitId == null && units.length > 0) setUnitId(units[0]!.id)

  const save = async (): Promise<void> => {
    try {
      if (!unitId) return void toast.push('error', 'Pick a unit')
      if (hsnError) return void toast.push('error', hsnError)
      const data = {
        name: name.trim(),
        groupId: item?.groupId ?? null,
        unitId,
        hsn: hsn.trim() || null,
        gstRate: gstRate.trim() ? Number(gstRate) : null,
        cessRate: cessRate.trim() ? Number(cessRate) : null,
        openingQtyMilli: Math.round(parseFloat(openQty || '0') * 1000),
        openingValue: openValue ?? 0,
        barcode: barcode.trim() || null,
        // Reorder level has no field in this modal yet (Wave 3); preserve what the item has.
        reorderLevelMilli: item?.reorderLevelMilli ?? null
      }
      if (item) await api.stockItems.update(item.id, data)
      else await api.stockItems.create(data)
      if (item && bomRows) {
        await api.bom.set({
          itemId: item.id,
          lines: bomRows
            .filter((r) => r.componentId !== '' && Number(r.qtyText) > 0)
            .map((r) => ({ componentId: r.componentId as number, qtyMilliPerUnit: Math.round(Number(r.qtyText) * 1000) }))
        })
      }
      await queryClient.invalidateQueries()
      toast.push('success', `Item ${item ? 'updated' : 'created'}`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const remove = async (): Promise<void> => {
    if (!item) return
    if (!window.confirm(`Delete item “${item.name}”?`)) return
    try {
      await api.stockItems.remove(item.id)
      await queryClient.invalidateQueries()
      toast.push('success', 'Item deleted')
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={item ? `Edit ${item.name}` : 'New stock item'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Unit">
            <Select value={unitId ?? ''} onChange={(e) => setUnitId(Number(e.target.value))}>
              {(units ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.symbol})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="HSN" error={hsnError}>
            <TextInput value={hsn} onChange={(e) => setHsn(e.target.value)} className="num" />
          </Field>
          <Field label="GST %">
            <TextInput value={gstRate} onChange={(e) => setGstRate(e.target.value)} className="num" placeholder="18" />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Cess %">
            <TextInput value={cessRate} onChange={(e) => setCessRate(e.target.value)} className="num" placeholder="0" />
          </Field>
          <Field label="Opening qty">
            <TextInput value={openQty} onChange={(e) => setOpenQty(e.target.value)} className="num text-right" placeholder="0" />
          </Field>
          <Field label="Opening value">
            <AmountInput paise={openValue} onPaise={setOpenValue} />
          </Field>
        </div>
        <Field label="Barcode" hint="Scan into this field, or type an SKU">
          <TextInput value={barcode} onChange={(e) => setBarcode(e.target.value)} className="num" placeholder="Optional" />
        </Field>
        {item && (
          <div>
            <span className="mb-1 block text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
              Bill of materials — components per 1 unit
            </span>
            {[...effectiveBomRows, { componentId: '' as const, qtyText: '' }].map((row, i) => (
              <div key={i} className="mb-1.5 flex gap-2">
                <Select
                  value={row.componentId}
                  onChange={(e) => {
                    const next = [...effectiveBomRows]
                    const value = e.target.value ? Number(e.target.value) : ('' as const)
                    if (i < next.length) next[i] = { ...next[i]!, componentId: value }
                    else next.push({ componentId: value, qtyText: '1' })
                    setBomRows(next.filter((r) => r.componentId !== ''))
                  }}
                  className="flex-1"
                >
                  <option value="">— add component —</option>
                  {allItems
                    .filter((si) => si.id !== item.id)
                    .map((si) => (
                      <option key={si.id} value={si.id}>
                        {si.name}
                      </option>
                    ))}
                </Select>
                {i < effectiveBomRows.length && (
                  <TextInput
                    value={row.qtyText}
                    onChange={(e) => {
                      const next = [...effectiveBomRows]
                      next[i] = { ...next[i]!, qtyText: e.target.value }
                      setBomRows(next)
                    }}
                    className="num w-24 text-right"
                    placeholder="Qty"
                  />
                )}
              </div>
            ))}
            <span className="text-[11px] text-muted">Used by the Manufacture voucher to consume inputs automatically.</span>
          </div>
        )}
        <div className="flex justify-between">
          <div>{item && <Button variant="danger" onClick={() => void remove()}>Delete</Button>}</div>
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => void save()}>
              Save item
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ---------- units ----------

function UnitsTab(): React.JSX.Element {
  const { data: units } = useQuery({ queryKey: ['units'], queryFn: api.units.list })
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [decimals, setDecimals] = useState('0')
  const [uqc, setUqc] = useState('NOS')

  const create = async (): Promise<void> => {
    try {
      await api.units.create({ name: name.trim(), symbol: symbol.trim(), decimals: Number(decimals), uqc: uqc.trim().toUpperCase() })
      await queryClient.invalidateQueries({ queryKey: ['units'] })
      toast.push('success', 'Unit created')
      setCreating(false)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" onClick={() => setCreating(true)}>
          New unit
        </Button>
      </div>
      <Panel>
        <table className="ledger-table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="w-20">Symbol</th>
              <th className="r w-24">Decimals</th>
              <th className="w-24">UQC</th>
            </tr>
          </thead>
          <tbody>
            {(units ?? []).map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td className="text-muted">{u.symbol}</td>
                <td className="r num">{u.decimals}</td>
                <td className="num text-muted">{u.uqc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      {creating && (
        <Modal title="New unit" onClose={() => setCreating(false)}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Dozens" />
            </Field>
            <Field label="Symbol">
              <TextInput value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="Doz" />
            </Field>
            <Field label="Decimal places">
              <Select value={decimals} onChange={(e) => setDecimals(e.target.value)}>
                {['0', '1', '2', '3'].map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="UQC (GST portal code)">
              <TextInput value={uqc} onChange={(e) => setUqc(e.target.value.toUpperCase())} className="num" placeholder="DOZ" />
            </Field>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void create()}>
              Create unit
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}

// ---------- voucher types ----------

function TypesTab(): React.JSX.Element {
  const { data: types } = useQuery({ queryKey: ['voucherTypes'], queryFn: api.voucherTypes.list })
  const [editing, setEditing] = useState<VoucherType | null>(null)

  return (
    <>
      <Panel>
        <table className="ledger-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Numbering</th>
              <th className="w-32">Format</th>
              <th className="w-20"></th>
            </tr>
          </thead>
          <tbody>
            {(types ?? []).map((t) => (
              <tr key={t.id} className="hover:bg-panel2">
                <td>{t.name}</td>
                <td className="text-muted">{t.kind.replace('_', ' ')}</td>
                <td className="text-muted">{t.numbering === 'auto' ? 'Automatic per FY' : 'Manual'}</td>
                <td className="num text-muted">
                  {t.prefix}
                  {'#'.repeat(Math.max(1, t.padWidth))}
                  {t.suffix}
                  {!t.restartFy && <span className="ml-1 normal-case text-[10px]">(no FY restart)</span>}
                </td>
                <td className="r">
                  <button className="text-[12px] text-blue hover:underline" onClick={() => setEditing(t)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      {editing && <TypeFormModal vt={editing} onClose={() => setEditing(null)} />}
    </>
  )
}

function TypeFormModal({ vt, onClose }: { vt: VoucherType; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [numbering, setNumbering] = useState(vt.numbering)
  const [prefix, setPrefix] = useState(vt.prefix)
  const [suffix, setSuffix] = useState(vt.suffix)
  const [padWidth, setPadWidth] = useState(vt.padWidth.toString())
  const [restartFy, setRestartFy] = useState(vt.restartFy)

  const pad = Math.min(8, Math.max(0, Number(padWidth) || 0))
  const previewNumber = (seq: number): string => `${prefix}${String(seq).padStart(pad, '0')}${suffix}`

  const save = async (): Promise<void> => {
    try {
      await api.voucherTypes.update(vt.id, {
        name: vt.name, kind: vt.kind, numbering, prefix, suffix, padWidth: pad, restartFy
      })
      await queryClient.invalidateQueries()
      toast.push('success', `${vt.name} updated`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={`${vt.name} settings`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Numbering">
          <Select value={numbering} onChange={(e) => setNumbering(e.target.value as 'auto' | 'manual')}>
            <option value="auto">Automatic per FY</option>
            <option value="manual">Manual</option>
          </Select>
        </Field>
        <Field label="Prefix" hint="e.g. INV- gives INV-1, INV-2…">
          <TextInput value={prefix} onChange={(e) => setPrefix(e.target.value)} />
        </Field>
        <Field label="Suffix" hint="e.g. /24-25 gives INV-1/24-25">
          <TextInput value={suffix} onChange={(e) => setSuffix(e.target.value)} />
        </Field>
        <Field label="Zero-pad width" hint="3 gives 001, 002… — 0 for no padding">
          <TextInput value={padWidth} onChange={(e) => setPadWidth(e.target.value)} className="num" />
        </Field>
      </div>
      <label className="mt-3 flex items-center gap-2 text-[12.5px]">
        <input type="checkbox" checked={restartFy} onChange={(e) => setRestartFy(e.target.checked)} />
        Restart numbering at 1 each financial year
      </label>
      {numbering === 'auto' && (
        <p className="mt-3 rounded-md border border-line bg-panel2 px-3 py-2 text-[12px] text-muted">
          Preview: <span className="num text-ink">{previewNumber(1)}</span>, <span className="num text-ink">{previewNumber(2)}</span>
          {!restartFy && <span> … continuing across financial years</span>}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()}>
          Save settings
        </Button>
      </div>
    </Modal>
  )
}
