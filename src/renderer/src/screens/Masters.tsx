import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Godown, Ledger, StockGroup, StockItem, VoucherType } from '@shared/domain'
import type { GroupTreeNode } from '@shared/reports'
import { api } from '../lib/client'
import { useGstRegistrations } from '../components/GstinPicker'
import { registrationLabel } from '@shared/gst/registrations'
import { useNav, useToasts, type Screen } from '../state/stores'
import { AmountInput, Button, DateInput, EmptyState, Field, Modal, Money, Panel, Select, TextInput, useKeyNav } from '../components/ui'
import { TabBar } from '../components/TabBar'
import { useGroups, useLedgers, useStockItems } from '../components/pickers'
import { LedgerFormModal } from '../components/LedgerFormModal'
import { validateHsn } from '@shared/gst/validate'
import { expandSeriesPattern, seriesHasFyToken, SERIES_TOKENS } from '@shared/numberSeries'
import { fyOf, todayISO, toDisplayDate } from '@shared/dates'
import { confirmDialog, promptDialog } from '../lib/dialogs'
import { PriceListsTab } from './masters/PriceListsTab'
import { ITEM_IMAGE_HINT } from '@shared/itemImages'

export type MastersTab = NonNullable<Extract<Screen, { name: 'masters' }>['tab']>

const TABS: { id: MastersTab; label: string }[] = [
  { id: 'ledgers', label: 'Ledgers' },
  { id: 'groups', label: 'Groups' },
  { id: 'items', label: 'Stock items' },
  { id: 'stock-groups', label: 'Stock groups' },
  { id: 'godowns', label: 'Godowns' },
  { id: 'units', label: 'Units' },
  { id: 'types', label: 'Voucher types' },
  { id: 'currencies', label: 'Currencies' },
  { id: 'price-lists', label: 'Price lists' }
]

export function Masters({ tab }: { tab?: MastersTab }): React.JSX.Element {
  const nav = useNav()
  const active = tab ?? 'ledgers'
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center gap-1">
        <h2 className="mr-4 font-serif text-heading font-semibold tracking-tight">Masters</h2>
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
      {active === 'items' && <ItemsTab />}
      {active === 'stock-groups' && <StockGroupsTab />}
      {active === 'godowns' && <GodownsTab />}
      {active === 'units' && <UnitsTab />}
      {active === 'types' && <TypesTab />}
      {active === 'currencies' && <CurrenciesTab />}
      {active === 'price-lists' && <PriceListsTab />}
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
                <th scope="col" className="w-24">Code</th>
                <th scope="col" className="w-24">Symbol</th>
                <th scope="col">Name</th>
                <th scope="col" className="w-20"></th>
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
                      className="text-small text-cr hover:underline"
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

type LedgerSortKey = 'name' | 'group' | 'gstin' | 'opening'

function SortTh({
  label,
  k,
  sort,
  onSort,
  className = ''
}: {
  label: string
  k: LedgerSortKey
  sort: { key: LedgerSortKey; dir: 1 | -1 }
  onSort: (k: LedgerSortKey) => void
  className?: string
}): React.JSX.Element {
  const active = sort.key === k
  // `uppercase` explicitly: the UA stylesheet resets text-transform inside a <button>, so
  // `.ledger-table th`'s micro-caps never reach a sortable label without it.
  return (
    <th scope="col" className={className} aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
      <button
        type="button"
        data-testid={`sort-masters-ledgers-${k}`}
        className={`inline-flex items-center gap-1 uppercase hover:text-ink ${active ? 'text-ink' : ''}`}
        onClick={() => onSort(k)}
      >
        {label}
        <span aria-hidden="true" className={active ? 'text-accent' : 'invisible'}>
          {active && sort.dir === -1 ? '↓' : '↑'}
        </span>
      </button>
    </th>
  )
}

function LedgersTab(): React.JSX.Element {
  const ledgers = useLedgers()
  const groups = useGroups()
  const nav = useNav()
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<Ledger | 'new' | null>(null)
  const [sort, setSort] = useState<{ key: LedgerSortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups])

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const filtered = q ? ledgers.filter((l) => l.name.toLowerCase().includes(q)) : ledgers
    // openingBalance stays integer paise — compared, never arithmetically transformed.
    const keyOf = (l: Ledger): string | number =>
      sort.key === 'name' ? l.name : sort.key === 'group' ? (groupMap.get(l.groupId) ?? '') : sort.key === 'gstin' ? (l.gstin ?? '') : l.openingBalance
    return [...filtered].sort((a, b) => {
      const ka = keyOf(a)
      const kb = keyOf(b)
      const cmp = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb), undefined, { sensitivity: 'base' })
      return sort.dir * (cmp !== 0 ? cmp : a.name.localeCompare(b.name))
    })
  }, [ledgers, filter, sort, groupMap])

  const anyOpening = useMemo(() => ledgers.some((l) => l.openingBalance !== 0), [ledgers])

  const onSort = (k: LedgerSortKey): void => setSort((s) => (s.key === k ? { key: k, dir: s.dir === 1 ? -1 : 1 } : { key: k, dir: 1 }))

  const open = (l: Ledger | undefined): void => {
    if (l) nav.go({ name: 'ledger-statement', ledgerId: l.id })
  }
  const { active, setActive } = useKeyNav(rows.length, (i) => open(rows[i]))

  return (
    <>
      <div className="mb-3 flex justify-between">
        <TextInput value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Type to filter…" data-filter-box className="w-64" />
        <Button variant="primary" data-testid="btn-masters-new-ledger" onClick={() => setEditing('new')}>
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
                <SortTh label="Name" k="name" sort={sort} onSort={onSort} />
                <SortTh label="Group" k="group" sort={sort} onSort={onSort} />
                <SortTh label="GSTIN" k="gstin" sort={sort} onSort={onSort} />
                {/* Only when some ledger actually carries one. A column of nothing but dashes
                    costs width on every row to say nothing on any of them. */}
                {anyOpening && <SortTh label="Opening" k="opening" sort={sort} onSort={onSort} className="r w-40" />}
                <th scope="col" className="w-16" aria-label="Edit" />
              </tr>
            </thead>
            <tbody data-testid="rows-masters-ledgers">
              {rows.map((l, i) => (
                <tr
                  key={l.id}
                  data-row-id={l.id}
                  data-active={i === active}
                  className="kbar-row group cursor-pointer"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => open(l)}
                >
                  <td>{l.name}</td>
                  <td className="text-muted">{groupMap.get(l.groupId)}</td>
                  <td className="num text-muted">{l.gstin ?? ''}</td>
                  {anyOpening && (
                    <td className="r">
                      <Money paise={l.openingBalance} signed />
                    </td>
                  )}
                  <td className="r" onClick={(e) => e.stopPropagation()}>
                    {/* One quiet action per row instead of fifteen identical blue links stacked
                        down the page — it surfaces on the row the pointer or keyboard is on. */}
                    <button
                      data-testid="btn-masters-edit-ledger"
                      className="row-action text-small text-blue hover:underline"
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditing(l)
                      }}
                    >
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

/** All group ids in the subtree rooted at `node` (inclusive) — a group can't move under itself. */
function subtreeIds(node: GroupTreeNode, acc: Set<number> = new Set()): Set<number> {
  acc.add(node.id)
  for (const c of node.children) subtreeIds(c, acc)
  return acc
}

function GroupsTab(): React.JSX.Element {
  const { data: tree } = useQuery({ queryKey: ['groupTree'], queryFn: api.groups.tree })
  const groups = useGroups()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [moving, setMoving] = useState<GroupTreeNode | null>(null)
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState<number | null>(null)

  // Group names surface in the ledgers tab and every grouped report.
  const invalidate = (): Promise<unknown> =>
    Promise.all(['groupTree', 'groups', 'ledgers'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })))

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

  const rename = async (node: GroupTreeNode): Promise<void> => {
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

  const remove = async (node: GroupTreeNode): Promise<void> => {
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
      <Panel className="p-4">
        {(tree ?? []).map((node) => (
          <GroupNode key={node.id} node={node} depth={0} onRename={rename} onMove={setMoving} onDelete={remove} />
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
  node: GroupTreeNode
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

function GroupNode({
  node,
  depth,
  onRename,
  onMove,
  onDelete
}: {
  node: GroupTreeNode
  depth: number
  onRename: (node: GroupTreeNode) => Promise<void>
  onMove: (node: GroupTreeNode) => void
  onDelete: (node: GroupTreeNode) => Promise<void>
}): React.JSX.Element {
  const natureTone = { asset: 'text-dr', liability: 'text-cr', income: 'text-blue', expense: 'text-accent' }[node.nature]
  return (
    <>
      <div
        data-row-id={node.id}
        className="group flex items-center justify-between rounded-md px-2 py-1 hover:bg-panel2"
        style={{ paddingLeft: `${8 + depth * 18}px` }}
      >
        <span className={`text-detail ${depth === 0 ? 'font-medium' : 'text-muted'}`}>{node.name}</span>
        {depth === 0 && <span className={`text-label uppercase tracking-wider ${natureTone}`}>{node.nature}</span>}
        {!node.isSystem && (
          /* Three actions on one node, revealed together: `.row-action` also lights up on
             :focus-within, so tabbing to Rename shows Move and Delete beside it rather than
             leaving the user pressing invisible buttons. */
          <span className="row-action flex gap-2">
            <button data-testid="btn-masters-group-rename" className="text-hint text-blue hover:underline" onClick={() => void onRename(node)}>
              Rename
            </button>
            <button data-testid="btn-masters-group-move" className="text-hint text-blue hover:underline" onClick={() => onMove(node)}>
              Move
            </button>
            <button data-testid="btn-masters-group-delete" className="text-hint text-cr hover:underline" onClick={() => void onDelete(node)}>
              Delete
            </button>
          </span>
        )}
      </div>
      {node.children.map((c) => (
        <GroupNode key={c.id} node={c} depth={depth + 1} onRename={onRename} onMove={onMove} onDelete={onDelete} />
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
        <Button variant="primary" data-testid="btn-masters-new-item" onClick={() => setEditing('new')}>
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
                <th scope="col">Name</th>
                <th scope="col" className="w-16">Unit</th>
                <th scope="col" className="w-24">HSN</th>
                <th scope="col" className="r w-20">GST %</th>
                <th scope="col" className="r w-28">Opening qty</th>
                <th scope="col" className="w-20"></th>
              </tr>
            </thead>
            <tbody data-testid="rows-masters-items">
              {items.map((i) => (
                <tr key={i.id} className="hover:bg-panel2">
                  <td>{i.name}</td>
                  <td className="text-muted">{unitMap.get(i.unitId)}</td>
                  <td className="num text-muted">{i.hsn ?? ''}</td>
                  <td className="r num">{i.gstRate ?? '–'}</td>
                  <td className="r num">{(i.openingQtyMilli / 1000).toString()}</td>
                  <td className="r">
                    <button className="text-small text-blue hover:underline" onClick={() => setEditing(i)}>
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
  const { data: bomDetail } = useQuery({
    queryKey: ['bom', item?.id, 'detail'],
    queryFn: () => api.bom.detail(item!.id),
    enabled: !!item
  })
  const { data: bomItems } = useQuery({ queryKey: ['bom', 'items'], queryFn: api.bom.items })
  const madeItems = new Set((bomItems ?? []).map((b) => b.itemId))
  const bom = bomDetail?.lines
  const [bomRows, setBomRows] = useState<{ componentId: number | ''; qtyText: string; scrapText: string }[] | null>(null)
  const effectiveBomRows =
    bomRows ??
    (bom
      ? bom.map((b) => ({
          componentId: b.componentId as number | '',
          qtyText: String(b.qtyMilliPerUnit / 1000),
          // Shown as a percent because that is how a shop floor talks about wastage; stored as
          // hundredths of a percent so 2.5 survives the round trip without a float.
          scrapText: b.scrapBp ? String(b.scrapBp / 100) : ''
        }))
      : [])
  // null until touched, so an item whose yield was never set saves the value it already has.
  const [yieldText, setYieldText] = useState<string | null>(null)
  const effectiveYieldText = yieldText ?? (bomDetail ? String(bomDetail.bomYieldBp / 100) : '100')
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
  const [code, setCode] = useState(item?.code ?? '')
  const [altUnitId, setAltUnitId] = useState<number | ''>(item?.altUnitId ?? '')
  const [altConversion, setAltConversion] = useState(
    item?.altConversionMilli != null ? String(item.altConversionMilli / 1000) : ''
  )
  const [reorderLevel, setReorderLevel] = useState(
    item?.reorderLevelMilli != null ? String(item.reorderLevelMilli / 1000) : ''
  )
  // Three states, not a checkbox: '' follows the company setting, which is what every item
  // starts as and what most of them should stay as.
  const [blockNegative, setBlockNegative] = useState<'' | 'block' | 'allow'>(
    item?.blockNegative == null ? '' : item.blockNegative ? 'block' : 'allow'
  )
  const [trackSerials, setTrackSerials] = useState(item?.trackSerials ?? false)

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
        code: code.trim() || null,
        barcode: barcode.trim() || null,
        // Both or neither: half the pair stored makes the conversion a silent no-op.
        altUnitId: altUnitId === '' || !altConversion.trim() ? null : altUnitId,
        altConversionMilli:
          altUnitId === '' || !altConversion.trim() ? null : Math.round(parseFloat(altConversion) * 1000),
        reorderLevelMilli: reorderLevel.trim() ? Math.round(parseFloat(reorderLevel) * 1000) : null,
        blockNegative: blockNegative === '' ? null : blockNegative === 'block',
        trackSerials
      }
      if (item) await api.stockItems.update(item.id, data)
      else await api.stockItems.create(data)
      if (item && (bomRows || yieldText != null)) {
        const yieldBp = Math.round(Number(effectiveYieldText || '100') * 100)
        if (!(yieldBp > 0 && yieldBp <= 10000)) {
          return void toast.push('error', 'Yield is a percentage above 0 and at most 100')
        }
        await api.bom.set({
          itemId: item.id,
          bomYieldBp: yieldBp,
          lines: effectiveBomRows
            .filter((r) => r.componentId !== '' && Number(r.qtyText) > 0)
            .map((r) => ({
              componentId: r.componentId as number,
              qtyMilliPerUnit: Math.round(Number(r.qtyText) * 1000),
              scrapBp: Math.min(9999, Math.max(0, Math.round(Number(r.scrapText || '0') * 100)))
            }))
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
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code" hint="What is printed on the shelf label — the fastest way to find this at a counter">
            <TextInput
              data-testid="input-item-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="num"
              placeholder="Optional"
            />
          </Field>
          <Field label="Barcode" hint="Scan into this field, or type an SKU">
            <TextInput value={barcode} onChange={(e) => setBarcode(e.target.value)} className="num" placeholder="Optional" />
          </Field>
        </div>
        {/* Stock is always kept in the base unit — the small one, or a part box cannot be
            represented. The alternate is a named multiple that entry accepts and converts. */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Also sold in" hint="A box, a case, a dozen — entry accepts either unit">
            <Select
              data-testid="select-item-alt-unit"
              value={altUnitId}
              onChange={(e) => setAltUnitId(e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">No alternate unit</option>
              {(units ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.symbol})
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Base units in one"
            hint={
              altUnitId === ''
                ? 'Pick an alternate unit first'
                : `1 ${units?.find((u) => u.id === altUnitId)?.symbol ?? ''} = this many ${
                    units?.find((u) => u.id === unitId)?.symbol ?? 'base units'
                  }`
            }
          >
            <TextInput
              data-testid="input-item-alt-conversion"
              value={altConversion}
              onChange={(e) => setAltConversion(e.target.value)}
              className="num text-right"
              inputMode="decimal"
              placeholder="12"
              disabled={altUnitId === ''}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Reorder level" hint="Below this, the item appears in the buy list">
            <TextInput
              data-testid="input-item-reorder"
              value={reorderLevel}
              onChange={(e) => setReorderLevel(e.target.value)}
              className="num"
              inputMode="decimal"
              placeholder="None"
            />
          </Field>
          <Field
            label="Going negative"
            hint="The company setting is all-or-nothing; this overrides it for this item."
          >
            <Select
              data-testid="select-item-block-negative"
              value={blockNegative}
              onChange={(e) => setBlockNegative(e.target.value as '' | 'block' | 'allow')}
            >
              <option value="">Follow the company setting</option>
              <option value="block">Never allow it</option>
              <option value="allow">Always allow it</option>
            </Select>
          </Field>
          <Field
            label="Serial numbers"
            hint="Every movement then names the serials that moved, and the unit can be traced to the invoice that sold it."
          >
            <label className="flex items-center gap-2 py-1.5 text-body">
              <input
                type="checkbox"
                data-testid="check-item-track-serials"
                checked={trackSerials}
                onChange={(e) => setTrackSerials(e.target.checked)}
              />
              Track serial numbers
            </label>
          </Field>
        </div>
        {item && <ItemRateHistory itemId={item.id} />}
        {item && <ItemImageField itemId={item.id} />}
        {item && (
          <div>
            <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">
              Bill of materials — components per 1 unit
            </span>
            {[...effectiveBomRows, { componentId: '' as const, qtyText: '', scrapText: '' }].map((row, i) => (
              <div key={i} className="mb-1.5 flex gap-2">
                <Select
                  value={row.componentId}
                  onChange={(e) => {
                    const next = [...effectiveBomRows]
                    const value = e.target.value ? Number(e.target.value) : ('' as const)
                    if (i < next.length) next[i] = { ...next[i]!, componentId: value }
                    else next.push({ componentId: value, qtyText: '1', scrapText: '' })
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
                        {/* Naming it here is what stops someone adding a sub-assembly's raw
                            materials a second time, alongside the sub-assembly itself. */}
                        {madeItems.has(si.id) ? ' — sub-assembly' : ''}
                      </option>
                    ))}
                </Select>
                {i < effectiveBomRows.length && (
                  <>
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
                    <TextInput
                      data-testid={`input-bom-scrap-${i}`}
                      value={row.scrapText}
                      onChange={(e) => {
                        const next = [...effectiveBomRows]
                        next[i] = { ...next[i]!, scrapText: e.target.value }
                        setBomRows(next)
                      }}
                      className="num w-24 text-right"
                      inputMode="decimal"
                      placeholder="Scrap %"
                      title="Wastage on this component alone — cutting cloth wastes cloth, not buttons"
                    />
                  </>
                )}
              </div>
            ))}
            <div className="mt-2 grid grid-cols-2 gap-3">
              <Field
                label="Yield %"
                hint="Good units per 100 started. It inflates every component — scrap inflates only its own."
              >
                <TextInput
                  data-testid="input-bom-yield"
                  value={effectiveYieldText}
                  onChange={(e) => setYieldText(e.target.value)}
                  className="num text-right"
                  inputMode="decimal"
                  placeholder="100"
                />
              </Field>
            </div>
            <span className="text-caption text-muted">
              Used by the Manufacture voucher, which explodes sub-assemblies down to raw materials.
            </span>
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

/**
 * The GST rate history of a stock item (roadmap D-92).
 *
 * A rate is dated data, not a field. A document is priced with the rate in force on ITS OWN date,
 * so recording this year's change here — rather than by editing the GST % above — is what stops it
 * reaching back and repricing an invoice that was already raised or a return that was already
 * filed. An item with no rows here bills at its own GST %, exactly as it always did.
 *
 * Every change carries the notification that made it, because a rate with no citation is a rate
 * nobody can audit.
 */
function ItemRateHistory({ itemId }: { itemId: number }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const today = todayISO()
  const { data } = useQuery({
    queryKey: ['itemRates', itemId, today],
    queryFn: () => api.stock.rates(itemId, today)
  })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [effectiveFrom, setEffectiveFrom] = useState(today)
  const [ratePercent, setRatePercent] = useState('')
  const [cessPercent, setCessPercent] = useState('')
  const [note, setNote] = useState('')

  const reset = (): void => {
    setEditingId(null)
    setEffectiveFrom(today)
    setRatePercent('')
    setCessPercent('')
    setNote('')
  }

  const refresh = async (): Promise<void> => {
    // The rate feeds pricing everywhere, not just this modal — a stale copy anywhere else would
    // quote a rate that is no longer what the item charges.
    await queryClient.invalidateQueries()
  }

  const save = async (): Promise<void> => {
    const rate = Number(ratePercent)
    if (!ratePercent.trim() || !Number.isFinite(rate)) return void toast.push('error', 'Enter the rate, in percent')
    const cess = cessPercent.trim() ? Number(cessPercent) : 0
    if (!Number.isFinite(cess)) return void toast.push('error', 'Cess must be a percentage')
    try {
      const saved = await api.stock.saveRate(
        {
          stockItemId: itemId,
          effectiveFrom,
          ratePercent: rate,
          cessPercent: cess,
          note: note.trim() || null
        },
        editingId ?? undefined
      )
      // Warnings are advisory and never block: the Council has notified odd rates before, and an
      // app that refuses to record reality is worse than one that queries it.
      for (const w of saved.warnings) toast.push('warning', w)
      toast.push('success', editingId ? 'Rate change updated' : 'Rate change recorded')
      reset()
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const remove = async (row: { id: number; effectiveFrom: string }): Promise<void> => {
    const proceed = await confirmDialog({
      title: 'Forget this rate change',
      message: `Forget the change dated ${toDisplayDate(row.effectiveFrom)}? Documents on or after that date will be priced at whatever rate then applies.`,
      confirmLabel: 'Forget',
      danger: true
    })
    if (!proceed) return
    try {
      await api.stock.deleteRate(row.id)
      if (editingId === row.id) reset()
      toast.push('success', 'Rate change forgotten')
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const rows = data?.rows ?? []
  const inForce = data?.inForce ?? null
  const own = data?.itemRate.gstRate ?? null

  return (
    <div data-testid="section-item-rate-history">
      <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">
        GST rate history — the rate each date bills at
      </span>

      {/* What is in force today, and since when. The one line somebody reads before invoicing. */}
      <p className="mb-2 text-small text-muted" data-testid="text-item-rate-in-force">
        {inForce ? (
          <>
            <span className="rounded-full border border-line bg-panel2 px-2 py-0.5 num text-ink">
              {inForce.ratePercent}%{inForce.cessPercent > 0 ? ` + ${inForce.cessPercent}% cess` : ''}
            </span>{' '}
            in force today, from {toDisplayDate(inForce.effectiveFrom)}
            {inForce.note ? ` (${inForce.note})` : ''}.
          </>
        ) : rows.length > 0 ? (
          <>
            No change has taken effect yet — until {toDisplayDate(rows[0]!.effectiveFrom)} this item bills at its own{' '}
            {own === null ? 'rate' : `${own}%`}.
          </>
        ) : (
          <>
            No dated change recorded — this item bills at its own {own === null ? 'rate' : `${own}%`} on every date, as
            it always has.
          </>
        )}
      </p>

      {data?.latestSentence && (
        <p className="mb-2 text-caption text-muted">{data.latestSentence}</p>
      )}
      {(data?.warnings ?? []).map((w) => (
        <p key={w} className="mb-1 text-caption text-warn">
          {w}
        </p>
      ))}

      {rows.length > 0 && (
        <div className="mb-2 overflow-hidden rounded-md border border-line">
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-24">From</th>
                <th scope="col" className="r w-14">GST %</th>
                <th scope="col" className="r w-14">Cess %</th>
                <th scope="col">Notification</th>
                <th scope="col" className="r w-20"></th>
              </tr>
            </thead>
            <tbody data-testid="rows-item-rate-history">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-panel2">
                  <td className="num">{toDisplayDate(r.effectiveFrom)}</td>
                  <td className="r num">{r.ratePercent}</td>
                  <td className="r num">{r.cessPercent}</td>
                  <td className={r.note ? 'text-muted' : 'text-warn'}>{r.note ?? 'No citation'}</td>
                  <td className="r">
                    <button
                      className="text-small text-blue hover:underline"
                      onClick={() => {
                        setEditingId(r.id)
                        setEffectiveFrom(r.effectiveFrom)
                        setRatePercent(String(r.ratePercent))
                        setCessPercent(r.cessPercent ? String(r.cessPercent) : '')
                        setNote(r.note ?? '')
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="ml-2 text-small text-cr hover:underline"
                      data-testid="btn-item-rate-delete"
                      onClick={() => void remove(r)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-md border border-line bg-panel2 p-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="With effect from" hint="Inclusive — a notification “from the 22nd” applies on the 22nd">
            <DateInput
              value={effectiveFrom}
              context={effectiveFrom}
              onChange={setEffectiveFrom}
              testId="input-item-rate-from"
            />
          </Field>
          <Field label="GST %">
            <TextInput
              data-testid="input-item-rate-percent"
              value={ratePercent}
              onChange={(e) => setRatePercent(e.target.value)}
              className="num text-right"
              inputMode="decimal"
              placeholder="18"
            />
          </Field>
          <Field label="Cess %">
            <TextInput
              data-testid="input-item-rate-cess"
              value={cessPercent}
              onChange={(e) => setCessPercent(e.target.value)}
              className="num text-right"
              inputMode="decimal"
              placeholder="0"
            />
          </Field>
          <Field label="Notification" hint="A rate with no citation is a rate nobody can audit">
            <TextInput
              data-testid="input-item-rate-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="9/2025-CTR"
            />
          </Field>
        </div>
        <div className="mt-2 flex justify-end gap-2">
          {editingId !== null && <Button onClick={reset}>Cancel</Button>}
          <Button variant="primary" data-testid="btn-item-rate-save" onClick={() => void save()}>
            {editingId !== null ? 'Update change' : 'Record change'}
          </Button>
        </div>
      </div>
    </div>
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
              <th scope="col">Name</th>
              <th scope="col" className="w-20">Symbol</th>
              <th scope="col" className="r w-24">Decimals</th>
              <th scope="col" className="w-24">UQC</th>
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
  const [editing, setEditing] = useState<VoucherType | 'new' | null>(null)

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" data-testid="btn-masters-new-type" onClick={() => setEditing('new')}>
          New voucher type
        </Button>
      </div>
      <Panel>
        <table className="ledger-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">Numbering</th>
              <th scope="col" className="w-32">Format</th>
              <th scope="col" className="w-20"></th>
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
                  {!t.restartFy && <span className="ml-1 normal-case text-label">(no FY restart)</span>}
                </td>
                <td className="r">
                  <button className="text-small text-blue hover:underline" onClick={() => setEditing(t)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
  // Previewed against TODAY, because that is the series the next voucher will actually get. The
  // number itself is expanded against each voucher's own date (see nextVoucherNumber).
  const previewNumber = (seq: number, date = todayISO()): string =>
    `${expandSeriesPattern(prefix, date)}${String(seq).padStart(pad, '0')}${expandSeriesPattern(suffix, date)}`
  const perFy = seriesHasFyToken(prefix) || seriesHasFyToken(suffix)
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
        <Field label="Prefix" hint="e.g. INV- gives INV-1 · {FY} becomes the financial year">
          <TextInput data-testid="input-type-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
        </Field>
        <Field label="Suffix" hint="e.g. /{YY} gives INV-1/24">
          <TextInput value={suffix} onChange={(e) => setSuffix(e.target.value)} />
        </Field>
        <Field label="Zero-pad width" hint="3 gives 001, 002… — 0 for no padding">
          <TextInput value={padWidth} onChange={(e) => setPadWidth(e.target.value)} className="num" />
        </Field>
      </div>
      <label className="mt-3 flex items-center gap-2 text-body-sm">
        <input type="checkbox" checked={restartFy} onChange={(e) => setRestartFy(e.target.checked)} />
        Restart numbering at 1 each financial year
      </label>
      {numbering === 'auto' && (
        <div className="mt-3 rounded-md border border-line bg-panel2 px-3 py-2 text-small text-muted">
          <p data-testid="type-number-preview">
            Preview: <span className="num text-ink">{previewNumber(1)}</span>,{' '}
            <span className="num text-ink">{previewNumber(2)}</span>
            {!restartFy && !perFy && <span> … continuing across financial years</span>}
          </p>
          {/* Rule 46(b) requires an invoice number to be unique for the financial year. Restarting
              the count alone does not achieve that — it produces INV-0007 twice, a year apart. */}
          <p className="mt-1.5">
            {SERIES_TOKENS.map((t) => t.token).join(' · ')} put the year in the number itself:{' '}
            <span className="num">{`{FY}`}</span> is {fyOf(todayISO()).label}.
            {perFy && (
              <span className="text-ink">
                {' '}
                This series restarts every April by construction — last year&rsquo;s numbers no longer
                share the prefix.
              </span>
            )}
          </p>
        </div>
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
        {!godowns?.length ? (
          <EmptyState title="No godowns yet" hint="Track stock per location — voucher lines can then pick a godown" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Address</th>
                <th scope="col" className="w-20"></th>
              </tr>
            </thead>
            <tbody data-testid="rows-masters-godowns">
              {godowns.map((g) => (
                <tr key={g.id} data-row-id={g.id} className="hover:bg-panel2">
                  <td>{g.name}</td>
                  <td className="max-w-72 truncate text-muted">{g.address ?? ''}</td>
                  <td className="r">
                    <button data-testid="btn-masters-edit-godown" className="text-small text-blue hover:underline" onClick={() => setEditing(g)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
  // Which GST registration this location sits under (roadmap #108) — what a supply from it
  // defaults to, and what makes a transfer out of it a supply between two registrations.
  const registrations = useGstRegistrations()
  const [gstRegistrationId, setGstRegistrationId] = useState<number | null>(
    godown?.gstRegistrationId ?? null
  )

  const save = async (): Promise<void> => {
    try {
      if (!name.trim()) return void toast.push('error', 'Name the godown')
      const data = { name: name.trim(), address: address.trim() || null, gstRegistrationId }
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
        {registrations.length > 1 && (
          <Field
            label="GST registration"
            hint="Moving stock to a godown under another registration is a taxable supply"
          >
            <Select
              data-testid="select-godown-registration"
              value={String(gstRegistrationId ?? '')}
              onChange={(e) => setGstRegistrationId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Not set</option>
              {registrations.map((r) => (
                <option key={r.id} value={r.id}>
                  {registrationLabel(r)}
                </option>
              ))}
            </Select>
          </Field>
        )}
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
                className="flex items-center rounded-md px-2 py-1 hover:bg-panel2"
                style={{ paddingLeft: `${8 + depth * 18}px` }}
              >
                <span className={`text-detail ${depth === 0 ? '' : 'text-muted'}`}>{group.name}</span>
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

/**
 * The item's picture (roadmap E #119).
 *
 * Only offered on an item that already exists, because the file is stored under the item's id —
 * there is nowhere to put a picture for something that has not been saved yet, and inventing a
 * temporary name would leave orphan files behind every time somebody cancelled a new-item form.
 *
 * The image itself lives in `<company>/item-images/`, never in the database: a company.db carrying
 * two hundred product photographs is a database backed up and integrity-checked at forty times its
 * real size. It comes back over IPC as a data URL because the renderer has no filesystem access at
 * all, and punching a hole in that to draw a thumbnail would be a poor trade.
 */
function ItemImageField({ itemId }: { itemId: number }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['itemImage', itemId], queryFn: () => api.itemImages.get(itemId) })

  const pick = async (): Promise<void> => {
    try {
      const result = await api.itemImages.set(itemId)
      // Null is the user cancelling the native picker, not a failure.
      if (result) {
        await queryClient.invalidateQueries({ queryKey: ['itemImage', itemId] })
        await queryClient.invalidateQueries({ queryKey: ['stockItems'] })
        toast.push('success', 'Picture set')
      }
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const clear = async (): Promise<void> => {
    try {
      await api.itemImages.clear(itemId)
      await queryClient.invalidateQueries({ queryKey: ['itemImage', itemId] })
      await queryClient.invalidateQueries({ queryKey: ['stockItems'] })
      toast.push('success', 'Picture removed')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Field label="Picture" hint={ITEM_IMAGE_HINT}>
      <div className="flex items-center gap-3">
        {data?.dataUrl ? (
          <img
            src={data.dataUrl}
            alt=""
            data-testid="img-item-image"
            className="h-16 w-16 rounded-md border border-line object-cover"
          />
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-line text-caption text-muted">
            none
          </div>
        )}
        <Button data-testid="btn-item-image-set" onClick={() => void pick()}>
          {data?.dataUrl ? 'Replace' : 'Choose a picture'}
        </Button>
        {data?.image && (
          <Button variant="ghost" data-testid="btn-item-image-clear" onClick={() => void clear()}>
            Remove
          </Button>
        )}
        {/* Shown, never hidden: a picture that quietly disappears is the app losing a file
            without saying so. */}
        {data?.image?.missing && (
          <span className="text-hint text-cr">The file is no longer in the company folder.</span>
        )}
      </div>
    </Field>
  )
}
