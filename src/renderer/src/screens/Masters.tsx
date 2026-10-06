import { useMemo, useState } from 'react'
import { useDeepLinkOpen } from '../lib/useDeepLinkOpen'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Currency, Godown, Ledger, StockGroup, StockItem, Unit, VoucherType } from '@shared/domain'
import { filterLedgers, type ChartGroupNode } from '@shared/chartOfAccounts'
import { api } from '../lib/client'
import { useNav, useSession, useToasts, type Screen } from '../state/stores'
import { AmountInput, Button, EmptyState, Field, Modal, Panel, Select, TextInput } from '../components/ui'
import { DataTable, defineColumns } from '../components/table'
import { formatMilli } from '../lib/table'
import { TabBar } from '../components/TabBar'
import { useGroups, useLedgers, useStockItems } from '../components/pickers'
import { LedgerFormModal } from '../components/LedgerFormModal'
import { ChartOfAccounts } from '../components/ChartOfAccounts'
import { validateHsn } from '@shared/gst/validate'
import { confirmDialog, promptDialog } from '../lib/dialogs'
import { ItemLink, LedgerLink } from '../components/links'

export type MastersTab = NonNullable<Extract<Screen, { name: 'masters' }>['tab']>

const TABS: { id: MastersTab; label: string }[] = [
  { id: 'ledgers', label: 'Ledgers' },
  { id: 'groups', label: 'Groups' },
  { id: 'items', label: 'Stock items' },
  { id: 'stock-groups', label: 'Stock groups' },
  { id: 'godowns', label: 'Godowns' },
  { id: 'units', label: 'Units' },
  { id: 'types', label: 'Voucher types' },
  { id: 'currencies', label: 'Currencies' }
]

export function Masters({ tab, itemId }: { tab?: MastersTab; itemId?: number }): React.JSX.Element {
  const nav = useNav()
  const active = tab ?? 'ledgers'
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center gap-1">
        <h2 className="mr-4 font-serif text-[19px] font-semibold tracking-tight">Masters</h2>
        {/* Tab lives in the nav stack (not local state) so Esc/back retraces tabs and
            other screens can deep-link straight to a tab — same pattern as Settings. */}
        <TabBar
          screen="masters"
          tabs={TABS}
          active={active}
          onSelect={(t) => {
            if (t !== active) nav.go({ name: 'masters', tab: t })
          }}
        />
      </div>
      {active === 'ledgers' && <LedgersTab />}
      {active === 'groups' && <GroupsTab />}
      {active === 'items' && <ItemsTab openItemId={itemId} />}
      {active === 'stock-groups' && <StockGroupsTab />}
      {active === 'godowns' && <GodownsTab />}
      {active === 'units' && <UnitsTab />}
      {active === 'types' && <TypesTab />}
      {active === 'currencies' && <CurrenciesTab />}
    </div>
  )
}

// ---------- currencies ----------

const CURRENCY_COLUMNS = defineColumns<Currency>([
  { id: 'code', header: 'Code', kind: 'text', value: (c) => c.code, className: 'num', width: 110, hideable: false, groupable: false },
  { id: 'symbol', header: 'Symbol', kind: 'text', value: (c) => c.symbol, width: 110, groupable: false },
  { id: 'name', header: 'Name', kind: 'text', value: (c) => c.name, className: 'text-muted', groupable: false }
])

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
        <DataTable
          viewId="masters-currencies"
          testId="masters-currencies"
          ariaLabel="Currencies"
          columns={CURRENCY_COLUMNS}
          rows={currencies ?? []}
          rowKey={(c) => c.id}
          rowAttrs={(c) => ({ 'data-row-id': c.id })}
          empty={{ title: 'Base books are in ₹ (INR)', hint: 'Add USD, EUR… to raise foreign-currency invoices with an exchange rate' }}
          trailing={(c) => (
            <button
              type="button"
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
          )}
          trailingWidth={84}
          exportOptions={{ title: 'Currencies', periodLabel: 'Masters', filename: 'currencies' }}
        />
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

type LedgerRow = Ledger & { groupName: string }

export const LEDGER_COLUMNS = defineColumns<LedgerRow>([
  {
    id: 'name',
    header: 'Name',
    kind: 'text',
    value: (l) => l.name,
    hideable: false,
    groupable: false,
    minWidth: 180,
    // Name → edit window; the rest of the row → statement.
    cell: (l) => <LedgerLink ledgerId={l.id} name={l.name} />
  },
  { id: 'group', header: 'Group', kind: 'text', value: (l) => l.groupName, className: 'text-muted', width: 200 },
  { id: 'gstin', header: 'GSTIN', kind: 'text', value: (l) => l.gstin ?? '', className: 'num text-muted', width: 170, groupable: false },
  { id: 'pan', header: 'PAN', kind: 'text', value: (l) => l.pan ?? '', className: 'num text-muted', width: 120, groupable: false, defaultHidden: true },
  // Signed dr-positive paise. Not totalled: a sum of mixed openings isn't a figure anyone reads here.
  { id: 'opening', header: 'Opening', kind: 'money', signed: true, value: (l) => l.openingBalance, width: 160 }
])

const LEDGER_VIEW_DEFAULTS = { sort: [{ id: 'name', dir: 'asc' as const }] }

function LedgersTab(): React.JSX.Element {
  const ledgers = useLedgers()
  const groups = useGroups()
  const nav = useNav()
  const [filter, setFilter] = useState('')
  const [groupFilter, setGroupFilter] = useState<number | null>(null)
  const [editing, setEditing] = useState<Ledger | 'new' | null>(null)
  const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups])

  // Name, group, any ancestor group, GSTIN or PAN — so "Sales" finds "Local Sale" under Sales
  // Accounts. This search and the group picker run before the table's own view (sort/filters).
  const rows = useMemo<LedgerRow[]>(
    () => filterLedgers(ledgers, groups, filter, groupFilter).map((l) => ({ ...l, groupName: groupMap.get(l.groupId) ?? '' })),
    [ledgers, groups, filter, groupFilter, groupMap]
  )

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" className="whitespace-nowrap" data-testid="btn-masters-new-ledger" onClick={() => setEditing('new')}>
          New ledger
        </Button>
      </div>
      <Panel>
        <DataTable
          viewId="masters-ledgers"
          testId="masters-ledgers"
          ariaLabel="Ledgers"
          columns={LEDGER_COLUMNS}
          viewDefaults={LEDGER_VIEW_DEFAULTS}
          rows={rows}
          rowKey={(l) => l.id}
          rowAttrs={(l) => ({ 'data-row-id': l.id })}
          empty={{
            title: 'No ledgers match',
            action:
              filter || groupFilter !== null ? (
                <button
                  type="button"
                  className="text-small text-blue hover:underline"
                  onClick={() => {
                    setFilter('')
                    setGroupFilter(null)
                  }}
                  data-testid="masters-ledgers-clear-search"
                >
                  Clear search
                </button>
              ) : undefined
          }}
          // The search box covers name, group (with ancestors), GSTIN and PAN, so it replaces the
          // table's own quick filter; it and the group picker run before the table's view.
          toolbarFeatures={{ quickFilter: false }}
          toolbarStart={
            <>
              {/* inputCls is w-full — the wrappers set the widths. */}
              <div className="w-64 shrink-0">
                <TextInput
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Name, group, GSTIN or PAN…"
                  aria-label="Filter ledgers"
                  className="!py-1 !text-detail"
                  data-testid="masters-ledgers-filter"
                />
              </div>
              <div className="w-56 shrink-0">
                <Select
                  value={groupFilter ?? ''}
                  onChange={(e) => setGroupFilter(e.target.value ? Number(e.target.value) : null)}
                  aria-label="Filter by group (includes sub-groups)"
                  className="!py-1 !text-detail"
                  data-testid="masters-ledgers-group"
                >
                  <option value="">All groups</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
              </div>
            </>
          }
          onRowActivate={(l) => nav.go({ name: 'ledger-statement', ledgerId: l.id })}
          trailing={(l) => (
            <button
              type="button"
              data-testid="btn-masters-edit-ledger"
              className="text-[12px] text-blue hover:underline"
              onClick={() => setEditing(l)}
            >
              Edit
            </button>
          )}
          trailingWidth={72}
          exportOptions={{ title: 'Ledgers', periodLabel: 'Masters', filename: 'ledgers' }}
        />
      </Panel>
      {editing && <LedgerFormModal ledger={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  )
}

// ---------- groups ----------

/** All group ids in the subtree rooted at `node` (inclusive) — a group can't move under itself. */
function subtreeIds(node: ChartGroupNode, acc: Set<number> = new Set()): Set<number> {
  acc.add(node.id)
  for (const c of node.children) subtreeIds(c, acc)
  return acc
}

function GroupsTab(): React.JSX.Element {
  const { to } = useSession()
  const nav = useNav()
  // Closing balances as on the working period's end — same figure the trial balance shows.
  const { data: tree } = useQuery({ queryKey: ['chartOfAccounts', to], queryFn: () => api.groups.chart(to) })
  const groups = useGroups()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [moving, setMoving] = useState<ChartGroupNode | null>(null)
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState<number | null>(null)

  // Group names surface in the ledgers tab and every grouped report.
  const invalidate = (): Promise<unknown> =>
    Promise.all(['chartOfAccounts', 'groups', 'ledgers'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })))

  const create = async (): Promise<void> => {
    try {
      if (!parentId) return void toast.push('error', 'Pick a parent group')
      await api.groups.create({ name: name.trim(), parentId })
      await invalidate()
      toast.push('success', 'Group created')
      setCreating(false)
      setName('')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const rename = async (node: ChartGroupNode): Promise<void> => {
    if (node.parentId == null) return
    const next = await promptDialog({ title: 'Rename group', initial: node.name, confirmLabel: 'Rename' })
    if (next === null || !next.trim() || next.trim() === node.name) return
    try {
      await api.groups.update(node.id, { name: next.trim(), parentId: node.parentId })
      await invalidate()
      toast.push('success', 'Group renamed')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const remove = async (node: ChartGroupNode): Promise<void> => {
    const proceed = await confirmDialog({
      title: 'Delete group',
      message: `Delete group “${node.name}”? Groups with sub-groups or ledgers under them cannot be deleted.`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!proceed) return
    try {
      await api.groups.remove(node.id)
      await invalidate()
      toast.push('success', 'Group deleted')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" data-testid="btn-masters-new-group" onClick={() => setCreating(true)}>
          New sub-group
        </Button>
      </div>
      <Panel>
        <ChartOfAccounts
          tree={tree ?? []}
          onOpenLedger={(ledgerId) => nav.go({ name: 'ledger-statement', ledgerId })}
          groupActions={(node) =>
            node.isSystem ? null : (
              <>
                <button data-testid="btn-masters-group-rename" className="text-[11.5px] text-blue hover:underline" onClick={() => void rename(node)}>
                  Rename
                </button>
                <button data-testid="btn-masters-group-move" className="text-[11.5px] text-blue hover:underline" onClick={() => setMoving(node)}>
                  Move
                </button>
                <button data-testid="btn-masters-group-delete" className="text-[11.5px] text-cr hover:underline" onClick={() => void remove(node)}>
                  Delete
                </button>
              </>
            )
          }
        />
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
              <Button variant="primary" data-testid="btn-masters-create-group" onClick={() => void create()}>
                Create group
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {moving && (
        <MoveGroupModal
          node={moving}
          onClose={() => setMoving(null)}
          onMoved={async () => {
            setMoving(null)
            await invalidate()
          }}
        />
      )}
    </>
  )
}

function MoveGroupModal({
  node,
  onClose,
  onMoved
}: {
  node: ChartGroupNode
  onClose: () => void
  onMoved: () => Promise<void>
}): React.JSX.Element {
  const groups = useGroups()
  const toast = useToasts()
  const [parentId, setParentId] = useState<number | null>(node.parentId)
  const excluded = useMemo(() => subtreeIds(node), [node])
  const candidates = groups.filter((g) => !excluded.has(g.id))

  const save = async (): Promise<void> => {
    try {
      if (!parentId) return void toast.push('error', 'Pick a parent group')
      await api.groups.update(node.id, { name: node.name, parentId })
      toast.push('success', 'Group moved')
      await onMoved()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={`Move ${node.name}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Under" hint="The group (and its sub-groups) takes the new parent's nature">
          <Select autoFocus value={parentId ?? ''} onChange={(e) => setParentId(Number(e.target.value))}>
            <option value="" disabled>
              Choose…
            </option>
            {candidates.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="btn-masters-move-group" onClick={() => void save()}>
            Move group
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ---------- stock items ----------

type ItemRow = StockItem & { unitSymbol: string; unitDecimals: number }

export const ITEM_COLUMNS = defineColumns<ItemRow>([
  {
    id: 'name',
    header: 'Name',
    kind: 'text',
    value: (i) => i.name,
    hideable: false,
    groupable: false,
    minWidth: 180,
    cell: (i) => <ItemLink itemId={i.id} name={i.name} />
  },
  { id: 'unit', header: 'Unit', kind: 'text', value: (i) => i.unitSymbol, className: 'text-muted', width: 90 },
  { id: 'hsn', header: 'HSN', kind: 'text', value: (i) => i.hsn ?? '', className: 'num text-muted', width: 110 },
  { id: 'gstRate', header: 'GST %', kind: 'number', value: (i) => i.gstRate, text: (i) => (i.gstRate == null ? '–' : String(i.gstRate)), width: 110, groupable: true },
  // Integer thousandths, shown to the item's unit decimals. Mixed units never total.
  { id: 'openingQty', header: 'Opening qty', kind: 'quantity', value: (i) => i.openingQtyMilli, text: (i) => formatMilli(i.openingQtyMilli, i.unitDecimals), width: 150 },
  { id: 'openingValue', header: 'Opening value', kind: 'money', value: (i) => i.openingValue, aggregate: 'sum', width: 150, defaultHidden: true },
  { id: 'barcode', header: 'Barcode', kind: 'text', value: (i) => i.barcode ?? '', className: 'num text-muted', width: 140, groupable: false, defaultHidden: true }
])

function ItemsTab({ openItemId }: { openItemId?: number }): React.JSX.Element {
  const items = useStockItems()
  const { data: units } = useQuery({ queryKey: ['units'], queryFn: api.units.list })
  const [editing, setEditing] = useState<StockItem | 'new' | null>(null)
  useDeepLinkOpen(items, openItemId, setEditing) // search results → this item's editor
  const rows = useMemo<ItemRow[]>(() => {
    const unitMap = new Map((units ?? []).map((u) => [u.id, u]))
    return items.map((i) => ({ ...i, unitSymbol: unitMap.get(i.unitId)?.symbol ?? '', unitDecimals: unitMap.get(i.unitId)?.decimals ?? 3 }))
  }, [items, units])

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" data-testid="btn-masters-new-item" onClick={() => setEditing('new')}>
          New item
        </Button>
      </div>
      <Panel>
        <DataTable
          viewId="masters-items"
          testId="masters-items"
          ariaLabel="Stock items"
          columns={ITEM_COLUMNS}
          rows={rows}
          rowKey={(i) => i.id}
          rowAttrs={(i) => ({ 'data-row-id': i.id })}
          empty={{ title: 'No stock items yet', hint: 'Items carry HSN and GST rate so invoices compute tax on their own' }}
          // Enter (or a double-click) opens the item, like its Edit button.
          activateOn="dblclick"
          onRowActivate={(i) => setEditing(i)}
          trailing={(i) => (
            <button type="button" className="text-[12px] text-blue hover:underline" data-testid="btn-masters-edit-item" onClick={() => setEditing(i)}>
              Edit
            </button>
          )}
          trailingWidth={72}
          exportOptions={{ title: 'Stock items', periodLabel: 'Masters', filename: 'stock-items' }}
        />
      </Panel>
      {editing && <ItemFormModal item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  )
}

export function ItemFormModal({ item, onClose }: { item: StockItem | null; onClose: () => void }): React.JSX.Element {
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
    const proceed = await confirmDialog({
      title: 'Delete item',
      message: `Delete item “${item.name}”?`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!proceed) return
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

const UNIT_COLUMNS = defineColumns<Unit>([
  { id: 'name', header: 'Name', kind: 'text', value: (u) => u.name, hideable: false, groupable: false },
  { id: 'symbol', header: 'Symbol', kind: 'text', value: (u) => u.symbol, className: 'text-muted', width: 110, groupable: false },
  { id: 'decimals', header: 'Decimals', kind: 'number', value: (u) => u.decimals, width: 130 },
  { id: 'uqc', header: 'UQC', kind: 'text', value: (u) => u.uqc, className: 'num text-muted', width: 110 }
])

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
        <DataTable
          viewId="masters-units"
          testId="masters-units"
          ariaLabel="Units"
          columns={UNIT_COLUMNS}
          rows={units ?? []}
          rowKey={(u) => u.id}
          rowAttrs={(u) => ({ 'data-row-id': u.id })}
          loading={!units}
          empty={{ title: 'No units yet' }}
          exportOptions={{ title: 'Units', periodLabel: 'Masters', filename: 'units' }}
        />
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

const typeFormat = (t: VoucherType): string => `${t.prefix}${'#'.repeat(Math.max(1, t.padWidth))}${t.suffix}`

const TYPE_COLUMNS = defineColumns<VoucherType>([
  { id: 'name', header: 'Name', kind: 'text', value: (t) => t.name, hideable: false, groupable: false },
  { id: 'kind', header: 'Kind', kind: 'text', value: (t) => t.kind.replace('_', ' '), className: 'text-muted', width: 150 },
  {
    id: 'numbering',
    header: 'Numbering',
    kind: 'enum',
    value: (t) => t.numbering,
    options: [
      { value: 'auto', label: 'Automatic per FY' },
      { value: 'manual', label: 'Manual' }
    ],
    className: 'text-muted',
    width: 170
  },
  {
    id: 'format',
    header: 'Format',
    kind: 'text',
    value: typeFormat,
    text: (t) => `${typeFormat(t)}${t.restartFy ? '' : ' (no FY restart)'}`,
    className: 'num text-muted',
    width: 200,
    groupable: false,
    cell: (t) => (
      <>
        {typeFormat(t)}
        {!t.restartFy && <span className="ml-1 normal-case text-[10px]">(no FY restart)</span>}
      </>
    )
  }
])

function TypesTab(): React.JSX.Element {
  const { data: types } = useQuery({ queryKey: ['voucherTypes'], queryFn: api.voucherTypes.list })
  const [editing, setEditing] = useState<VoucherType | 'new' | null>(null)

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" data-testid="btn-masters-new-type" onClick={() => setEditing('new')}>
          New voucher type
        </Button>
      </div>
      <Panel>
        <DataTable
          viewId="masters-types"
          testId="masters-types"
          ariaLabel="Voucher types"
          columns={TYPE_COLUMNS}
          rows={types ?? []}
          rowKey={(t) => t.id}
          rowAttrs={(t) => ({ 'data-row-id': t.id })}
          loading={!types}
          empty={{ title: 'No voucher types' }}
          // Enter (or a double-click) opens the type's settings, like its Edit button.
          activateOn="dblclick"
          onRowActivate={(t) => setEditing(t)}
          trailing={(t) => (
            <button type="button" className="text-[12px] text-blue hover:underline" data-testid="btn-masters-edit-type" onClick={() => setEditing(t)}>
              Edit
            </button>
          )}
          trailingWidth={72}
          exportOptions={{ title: 'Voucher types', periodLabel: 'Masters', filename: 'voucher-types' }}
        />
      </Panel>
      {editing && <TypeFormModal vt={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  )
}

/** Kinds a custom voucher type can post as — mirrors voucherTypeInputSchema's enum. */
const VOUCHER_KINDS = [
  'contra', 'payment', 'receipt', 'journal', 'sales',
  'purchase', 'credit_note', 'debit_note', 'stock_journal', 'physical_stock'
] as const

function TypeFormModal({ vt, onClose }: { vt: VoucherType | null; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [name, setName] = useState(vt?.name ?? '')
  const [kind, setKind] = useState<VoucherType['kind']>(vt?.kind ?? 'journal')
  const [numbering, setNumbering] = useState(vt?.numbering ?? 'auto')
  const [prefix, setPrefix] = useState(vt?.prefix ?? '')
  const [suffix, setSuffix] = useState(vt?.suffix ?? '')
  const [padWidth, setPadWidth] = useState((vt?.padWidth ?? 0).toString())
  const [restartFy, setRestartFy] = useState(vt?.restartFy ?? true)

  const pad = Math.min(8, Math.max(0, Number(padWidth) || 0))
  const previewNumber = (seq: number): string => `${prefix}${String(seq).padStart(pad, '0')}${suffix}`
  // The service keeps a system type's name/kind regardless of input — reflect that in the UI.
  const identityLocked = !!vt?.isSystem

  const save = async (): Promise<void> => {
    try {
      if (!name.trim()) return void toast.push('error', 'Name the voucher type')
      const data = { name: name.trim(), kind, numbering, prefix, suffix, padWidth: pad, restartFy }
      if (vt) await api.voucherTypes.update(vt.id, data)
      else await api.voucherTypes.create(data)
      await queryClient.invalidateQueries({ queryKey: ['voucherTypes'] })
      toast.push('success', vt ? `${vt.name} updated` : `${data.name} created`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={vt ? `${vt.name} settings` : 'New voucher type'} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" hint={identityLocked ? 'Default types keep their name' : undefined}>
          <TextInput autoFocus={!vt} value={name} disabled={identityLocked} onChange={(e) => setName(e.target.value)} placeholder="Export Sales" />
        </Field>
        <Field label="Behaves like" hint={identityLocked ? undefined : 'Sets the entry screen and posting rules'}>
          <Select value={kind} disabled={identityLocked} onChange={(e) => setKind(e.target.value as VoucherType['kind'])}>
            {VOUCHER_KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace('_', ' ')}
              </option>
            ))}
          </Select>
        </Field>
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
        <Button variant="primary" data-testid="btn-masters-save-type" onClick={() => void save()}>
          {vt ? 'Save settings' : 'Create type'}
        </Button>
      </div>
    </Modal>
  )
}

// ---------- godowns ----------

const GODOWN_COLUMNS = defineColumns<Godown>([
  { id: 'name', header: 'Name', kind: 'text', value: (g) => g.name, hideable: false, groupable: false, width: 260 },
  { id: 'address', header: 'Address', kind: 'text', value: (g) => g.address ?? '', className: 'text-muted', groupable: false }
])

function GodownsTab(): React.JSX.Element {
  const { data: godowns } = useQuery({ queryKey: ['godowns'], queryFn: api.godowns.list })
  const [editing, setEditing] = useState<Godown | 'new' | null>(null)

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" data-testid="btn-masters-new-godown" onClick={() => setEditing('new')}>
          New godown
        </Button>
      </div>
      <Panel>
        <DataTable
          viewId="masters-godowns"
          testId="masters-godowns"
          ariaLabel="Godowns"
          columns={GODOWN_COLUMNS}
          rows={godowns ?? []}
          rowKey={(g) => g.id}
          rowAttrs={(g) => ({ 'data-row-id': g.id })}
          empty={{ title: 'No godowns yet', hint: 'Track stock per location — voucher lines can then pick a godown' }}
          // Enter (or a double-click) opens the godown, like its Edit button.
          activateOn="dblclick"
          onRowActivate={(g) => setEditing(g)}
          trailing={(g) => (
            <button data-testid="btn-masters-edit-godown" type="button" className="text-[12px] text-blue hover:underline" onClick={() => setEditing(g)}>
              Edit
            </button>
          )}
          trailingWidth={72}
          exportOptions={{ title: 'Godowns', periodLabel: 'Masters', filename: 'godowns' }}
        />
      </Panel>
      {editing && <GodownFormModal godown={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  )
}

function GodownFormModal({ godown, onClose }: { godown: Godown | null; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [name, setName] = useState(godown?.name ?? '')
  const [address, setAddress] = useState(godown?.address ?? '')

  const save = async (): Promise<void> => {
    try {
      if (!name.trim()) return void toast.push('error', 'Name the godown')
      const data = { name: name.trim(), address: address.trim() || null }
      if (godown) await api.godowns.update(godown.id, data)
      else await api.godowns.create(data)
      await queryClient.invalidateQueries({ queryKey: ['godowns'] })
      toast.push('success', `Godown ${godown ? 'updated' : 'created'}`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const remove = async (): Promise<void> => {
    if (!godown) return
    const proceed = await confirmDialog({
      title: 'Delete godown',
      message: `Delete godown “${godown.name}”? Godowns referenced by voucher lines cannot be deleted.`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!proceed) return
    try {
      await api.godowns.remove(godown.id)
      await queryClient.invalidateQueries({ queryKey: ['godowns'] })
      toast.push('success', 'Godown deleted')
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={godown ? `Edit ${godown.name}` : 'New godown'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Main warehouse" />
        </Field>
        <Field label="Address">
          <TextInput value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Optional" />
        </Field>
        <div className="flex justify-between">
          <div>
            {godown && (
              <Button variant="danger" data-testid="btn-masters-delete-godown" onClick={() => void remove()}>
                Delete
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" data-testid="btn-masters-save-godown" onClick={() => void save()}>
              Save godown
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ---------- stock groups ----------

function StockGroupsTab(): React.JSX.Element {
  const { data: stockGroups } = useQuery({ queryKey: ['stockGroups'], queryFn: api.stockGroups.list })
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState<number | null>(null)

  // Nest by parentId for display (listStockGroups returns a flat, name-ordered list).
  const roots = useMemo(() => {
    const groups = stockGroups ?? []
    const children = new Map<number | null, StockGroup[]>()
    for (const g of groups) {
      const list = children.get(g.parentId) ?? []
      list.push(g)
      children.set(g.parentId, list)
    }
    const flatten = (parent: number | null, depth: number): { group: StockGroup; depth: number }[] =>
      (children.get(parent) ?? []).flatMap((g) => [{ group: g, depth }, ...flatten(g.id, depth + 1)])
    return flatten(null, 0)
  }, [stockGroups])

  const create = async (): Promise<void> => {
    try {
      await api.stockGroups.create({ name: name.trim(), parentId })
      await queryClient.invalidateQueries({ queryKey: ['stockGroups'] })
      toast.push('success', 'Stock group created')
      setCreating(false)
      setName('')
      setParentId(null)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" data-testid="btn-masters-new-stock-group" onClick={() => setCreating(true)}>
          New stock group
        </Button>
      </div>
      <Panel className="p-4">
        {roots.length === 0 ? (
          <EmptyState title="No stock groups yet" hint="Group items (e.g. Raw materials / Finished goods) to organise the stock summary" />
        ) : (
          <div data-testid="rows-masters-stock-groups">
            {roots.map(({ group, depth }) => (
              <div
                key={group.id}
                data-row-id={group.id}
                className="flex items-center rounded px-2 py-1 hover:bg-panel2"
                style={{ paddingLeft: `${8 + depth * 18}px` }}
              >
                <span className={`text-[13px] ${depth === 0 ? '' : 'text-muted'}`}>{group.name}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
      {creating && (
        <Modal title="New stock group" onClose={() => setCreating(false)}>
          <div className="flex flex-col gap-3">
            <Field label="Name">
              <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Finished goods" />
            </Field>
            <Field label="Under">
              <Select value={parentId ?? ''} onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">— top level —</option>
                {(stockGroups ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setCreating(false)}>Cancel</Button>
              <Button variant="primary" data-testid="btn-masters-create-stock-group" onClick={() => void create()}>
                Create stock group
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
